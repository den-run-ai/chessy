//! Allocation-free static exchange evaluation for quiescence experiments.
//!
//! The caller supplies the position *after* the initial capture. A fixed-size
//! stack board is used for the hypothetical recapture sequence, so SEE neither
//! allocates nor mutates the search position. Re-scanning the board after each
//! removal naturally reveals x-ray attackers.

use crate::engine;
use engine::{
    color_index, col_of, make_piece, opposite, piece_color, piece_type, row_of, Color, Move,
    Piece, PieceType, Position, BOARD_SQUARES, NO_SQUARE,
};

const MAX_EXCHANGES: usize = 32;

#[inline]
pub(crate) fn piece_value(kind: PieceType) -> i32 {
    match kind {
        PieceType::Pawn => 100,
        PieceType::Knight => 320,
        PieceType::Bishop => 330,
        PieceType::Rook => 500,
        PieceType::Queen => 900,
        // A legal king capture ends an exchange. Keeping the king above every
        // material piece also makes it the final least-valuable attacker.
        PieceType::King => 20_000,
    }
}

#[inline]
fn promotion_kind(kind: PieceType, side: Color, target: u8) -> PieceType {
    // Queen is weakly dominant for a material-only exchange on one target:
    // if it survives, it maximizes the promotion gain; if it is recaptured
    // next, that gain and the promoted piece's loss cancel, leaving the same
    // pawn source cost and post-recapture occupancy for every promotion. This
    // is not a claim about check-evasion choices outside the target sequence:
    // the pruning gate conservatively excludes both back ranks for that reason.
    // An explicit underpromotion on the initial real move is preserved here.
    if kind == PieceType::Pawn
        && ((side == Color::White && row_of(target) == 0)
            || (side == Color::Black && row_of(target) == 7))
    {
        PieceType::Queen
    } else {
        kind
    }
}

#[inline]
fn promotion_gain(kind: PieceType, promoted: PieceType) -> i32 {
    if kind == PieceType::Pawn && promoted != PieceType::Pawn {
        piece_value(promoted) - piece_value(PieceType::Pawn)
    } else {
        0
    }
}

fn clear_ray(board: &[Piece; BOARD_SQUARES], from: u8, target: u8) -> bool {
    let from_row = row_of(from) as i8;
    let from_col = col_of(from) as i8;
    let target_row = row_of(target) as i8;
    let target_col = col_of(target) as i8;
    let row_step = (target_row - from_row).signum();
    let col_step = (target_col - from_col).signum();
    let mut row = from_row + row_step;
    let mut col = from_col + col_step;
    while row != target_row || col != target_col {
        if board[(row * 8 + col) as usize] != Piece::Empty {
            return false;
        }
        row += row_step;
        col += col_step;
    }
    true
}

fn attacks_target(
    board: &[Piece; BOARD_SQUARES],
    from: u8,
    target: u8,
    side: Color,
    kind: PieceType,
) -> bool {
    let from_row = row_of(from) as i8;
    let from_col = col_of(from) as i8;
    let target_row = row_of(target) as i8;
    let target_col = col_of(target) as i8;
    let row_delta = target_row - from_row;
    let col_delta = target_col - from_col;
    let abs_row = row_delta.abs();
    let abs_col = col_delta.abs();

    match kind {
        PieceType::Pawn => {
            col_delta.abs() == 1
                && if side == Color::White {
                    row_delta == -1
                } else {
                    row_delta == 1
                }
        }
        PieceType::Knight => (abs_row == 2 && abs_col == 1) || (abs_row == 1 && abs_col == 2),
        PieceType::Bishop => abs_row != 0 && abs_row == abs_col && clear_ray(board, from, target),
        PieceType::Rook => {
            (row_delta == 0 || col_delta == 0) && clear_ray(board, from, target)
        }
        PieceType::Queen => {
            ((abs_row != 0 && abs_row == abs_col) || row_delta == 0 || col_delta == 0)
                && clear_ray(board, from, target)
        }
        PieceType::King => abs_row <= 1 && abs_col <= 1 && (abs_row != 0 || abs_col != 0),
    }
}

fn legal_attacker(
    board: &mut [Piece; BOARD_SQUARES],
    from: u8,
    target: u8,
    side: Color,
    kind: PieceType,
    king_squares: &[u8; 2],
) -> bool {
    let moving = board[from as usize];
    let captured = board[target as usize];
    let promoted = promotion_kind(kind, side, target);
    board[from as usize] = Piece::Empty;
    board[target as usize] = make_piece(side, promoted);

    let king = if kind == PieceType::King {
        target
    } else {
        king_squares[color_index(side)]
    };
    // Valid search positions always have both kings. Matching engine::in_check
    // for a malformed kingless fixture keeps this helper total and harmless.
    let legal = king == NO_SQUARE || !engine::is_attacked(board, king, opposite(side));

    board[from as usize] = moving;
    board[target as usize] = captured;
    legal
}

fn least_legal_attacker(
    board: &mut [Piece; BOARD_SQUARES],
    target: u8,
    side: Color,
    king_squares: &[u8; 2],
) -> Option<(u8, PieceType, PieceType)> {
    let mut best_square = NO_SQUARE;
    let mut best_kind = PieceType::King;
    let mut best_value = i32::MAX;
    let mut square = 0;
    while square < BOARD_SQUARES {
        let piece = board[square];
        if piece != Piece::Empty && piece_color(piece) == Some(side) {
            let kind = piece_type(piece).unwrap();
            // LVA is ranked by the material removed from `from`, not by the
            // piece left on `target`. For a promotion recapture, an immediate
            // reply loses the promoted piece but its promotion gain cancels
            // that extra value, so the exchange still risks one pawn (100).
            // promotion_gain() and `promoted` account for the 900-value queen
            // separately in the swap recurrence.
            let value = piece_value(kind);
            if value < best_value
                && attacks_target(board, square as u8, target, side, kind)
                && legal_attacker(
                    board,
                    square as u8,
                    target,
                    side,
                    kind,
                    king_squares,
                )
            {
                best_square = square as u8;
                best_kind = kind;
                best_value = value;
            }
        }
        square += 1;
    }
    if best_square == NO_SQUARE {
        None
    } else {
        Some((
            best_square,
            best_kind,
            promotion_kind(best_kind, side, target),
        ))
    }
}

/// Material score of `initial_move`, from its mover's point of view.
///
/// `position` must be the legal position immediately after `initial_move`.
/// Both sides then choose whether to continue the least-valuable-attacker
/// recapture sequence on the move's target square.
pub(crate) fn evaluate_after(position: &Position, initial_move: Move) -> i32 {
    let captured = engine::move_captured(initial_move);
    if captured == Piece::Empty {
        return 0;
    }

    let initial_kind = piece_type(engine::move_piece(initial_move)).unwrap();
    let initial_on_kind = engine::move_promotion(initial_move).unwrap_or(initial_kind);
    let mut gains = [0_i32; MAX_EXCHANGES];
    gains[0] = piece_value(piece_type(captured).unwrap())
        + promotion_gain(initial_kind, initial_on_kind);

    let target = engine::move_to(initial_move);
    let mut board = position.board;
    let mut king_squares = position.king_sq;
    let mut on_value = piece_value(initial_on_kind);
    let mut side = position.turn;
    let mut depth = 0_usize;

    while depth + 1 < MAX_EXCHANGES {
        let Some((from, kind, promoted)) =
            least_legal_attacker(&mut board, target, side, &king_squares)
        else {
            break;
        };
        depth += 1;
        gains[depth] = on_value + promotion_gain(kind, promoted) - gains[depth - 1];

        board[from as usize] = Piece::Empty;
        board[target as usize] = make_piece(side, promoted);
        if kind == PieceType::King {
            king_squares[color_index(side)] = target;
        }
        on_value = piece_value(promoted);

        // A legal king capture cannot itself be recaptured.
        if kind == PieceType::King {
            break;
        }
        side = opposite(side);
    }

    while depth > 0 {
        gains[depth - 1] = -core::cmp::max(-gains[depth - 1], gains[depth]);
        depth -= 1;
    }
    gains[0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::MAX_MOVES;

    fn square(name: &[u8]) -> u8 {
        (8 - (name[1] - b'0')) * 8 + (name[0] - b'a')
    }

    fn see_of(fen: &[u8], uci: &[u8]) -> i32 {
        let mut position = engine::parse_fen(fen).unwrap();
        let original = position;
        let from = square(&uci[0..2]);
        let to = square(&uci[2..4]);
        let promotion = uci.get(4).copied();
        let mut moves = [0; MAX_MOVES];
        let count = engine::generate_legal(&mut position, &mut moves);
        let mv = moves[..count]
            .iter()
            .copied()
            .find(|&candidate| {
                engine::move_from(candidate) == from
                    && engine::move_to(candidate) == to
                    && match (engine::move_promotion(candidate), promotion) {
                        (None, None) => true,
                        (Some(PieceType::Queen), Some(b'Q')) => true,
                        (Some(PieceType::Rook), Some(b'R')) => true,
                        (Some(PieceType::Bishop), Some(b'B')) => true,
                        (Some(PieceType::Knight), Some(b'N')) => true,
                        _ => false,
                    }
            })
            .unwrap();
        let undo = engine::make_move(&mut position, mv);
        let score = evaluate_after(&position, mv);
        engine::unmake_move(&mut position, mv, undo);
        assert!(position == original);
        score
    }

    #[test]
    fn defended_and_undefended_captures() {
        assert_eq!(
            see_of(
                b"4k3/8/8/4p3/8/8/8/4R1K1 w - - 0 1",
                b"e1e5"
            ),
            100
        );
        assert_eq!(
            see_of(
                b"4r1k1/8/8/4p3/8/8/8/4R1K1 w - - 0 1",
                b"e1e5"
            ),
            -400
        );
        assert_eq!(
            see_of(
                b"4k3/8/5p2/4p3/8/5N2/8/4K3 w - - 0 1",
                b"f3e5"
            ),
            -220
        );
    }

    #[test]
    fn xray_recapture_is_revealed() {
        assert_eq!(
            see_of(
                b"4r1k1/8/8/4p3/8/4R3/8/4R1K1 w - - 0 1",
                b"e3e5"
            ),
            100
        );
    }

    #[test]
    fn en_passant_removes_the_off_target_pawn_and_opens_its_ray() {
        assert_eq!(
            see_of(
                b"4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1",
                b"d5e6"
            ),
            100
        );
        assert_eq!(
            see_of(
                b"4r1k1/8/8/3Pp3/8/8/8/6K1 w - e6 0 1",
                b"d5e6"
            ),
            0
        );
    }

    #[test]
    fn initial_and_recapture_promotions_are_valued() {
        assert_eq!(
            see_of(
                b"4r2k/5P2/8/8/8/8/8/6K1 w - - 0 1",
                b"f7e8Q"
            ),
            1300
        );
        assert_eq!(
            see_of(
                b"4r2k/5P2/8/8/8/8/8/6K1 w - - 0 1",
                b"f7e8N"
            ),
            720
        );
        assert_eq!(
            see_of(
                b"6rk/5P2/8/8/8/8/8/6K1 w - - 0 1",
                b"f7g8Q"
            ),
            400
        );
        assert_eq!(
            see_of(
                b"k7/8/8/8/8/5N2/3p4/4r1K1 w - - 0 1",
                b"f3e1"
            ),
            -620
        );
    }

    #[test]
    fn promotion_recapture_uses_pawn_source_cost_with_a_mixed_attacker() {
        // After ...Rxe8, White can answer either Nxe8 (an even rook trade) or
        // fxe8=Q (the rook trade plus promotion). Ranking by the resulting
        // queen's 900 value would incorrectly select the knight; source-cost
        // LVA correctly selects the pawn and scores the line -800 for Black.
        assert_eq!(
            see_of(
                b"4R2k/2N1rP2/8/8/8/8/8/6K1 b - - 0 1",
                b"e7e8"
            ),
            -800
        );
    }

    #[test]
    fn pinned_attackers_and_illegal_king_recaptures_are_rejected() {
        assert_eq!(
            see_of(
                b"4k3/4r3/3Q4/8/8/8/8/4R1K1 w - - 0 1",
                b"d6e7"
            ),
            500
        );
        assert_eq!(
            see_of(
                b"4k3/8/4p3/3p4/8/8/8/3QR1K1 w - - 0 1",
                b"d1d5"
            ),
            100
        );
    }
}
