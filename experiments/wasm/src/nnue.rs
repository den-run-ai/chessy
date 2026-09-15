//! Research-only 768->H->1 NNUE evaluator (Cargo feature `nnue`).
//!
//! This module is compiled only for candidate research builds. The default
//! production build does not include it, so `assets/chessy-ai-fast.wasm`
//! stays byte-identical.
//!
//! Architecture (bullet-style "simple" net):
//!   * 768 binary inputs per perspective: 12 planes x 64 squares, planes
//!     ordered own P,N,B,R,Q,K then opponent P,N,B,R,Q,K. Square 0 is a8
//!     (Chessy native). The black perspective swaps colours and maps
//!     `square ^ 56`. This is exactly `eval/training/nnue-v1-architecture.json`.
//!   * One shared first layer 768->H with bias, quantised to i16 at QA=255.
//!   * SCReLU activation: clamp(x, 0, QA)^2.
//!   * Output layer 2H->1 (side-to-move block first, then not-side-to-move),
//!     weights quantised at QB=64, bias at QA*QB, evaluated in i64.
//!   * Output is side-to-move relative in centipawn-like units (SCALE=400),
//!     negated to White POV for the search.
//!
//! The accumulator stack is indexed by search ply and updated only along
//! searched paths (never inside legality probes), so `engine::Position` and
//! `make_move`/`unmake_move` are unchanged.

use crate::engine::{self, Color, Move, Piece, PieceType, Position};

const fn parse_usize(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut value = 0_usize;
    let mut index = 0;
    while index < bytes.len() {
        let digit = bytes[index];
        assert!(
            digit >= b'0' && digit <= b'9',
            "CHESSY_NNUE_HIDDEN must be decimal"
        );
        value = value * 10 + (digit - b'0') as usize;
        index += 1;
    }
    value
}

pub const HIDDEN: usize = parse_usize(env!("CHESSY_NNUE_HIDDEN"));
const INPUTS: usize = 768;
const QA: i32 = 255;
const QB: i32 = 64;
const SCALE: i64 = 400;
const OUTPUT_CLAMP: i64 = 30_000;
/// search::MAX_PLY (128) plus one slot for `push` from the deepest ply and one
/// scratch slot for fresh evaluations.
const ACC_PLIES: usize = 130;
const SCRATCH_PLY: usize = ACC_PLIES - 1;

const HEADER_BYTES: usize = 16;
const W1_OFFSET: usize = HEADER_BYTES;
const B1_OFFSET: usize = W1_OFFSET + INPUTS * HIDDEN * 2;
const W2_OFFSET: usize = B1_OFFSET + HIDDEN * 2;
const B2_OFFSET: usize = W2_OFFSET + 2 * HIDDEN * 2;
const WEIGHT_BYTES: usize = B2_OFFSET + 4;

#[repr(C, align(64))]
struct Aligned<T>(T);

// The file length must equal WEIGHT_BYTES for the given HIDDEN, otherwise the
// array copy below fails to compile. Layout: magic "CNNU", version u32 (1),
// hidden u32, reserved u32, then W1 [768*H] i16 (feature-major), B1 [H] i16,
// W2 [2H] i16 (stm block then nstm block), B2 i32; all little-endian.
static WEIGHTS: Aligned<[u8; WEIGHT_BYTES]> = Aligned(*include_bytes!(env!("CHESSY_NNUE_BIN")));

static mut ACC: [[[i16; HIDDEN]; 2]; ACC_PLIES] = [[[0; HIDDEN]; 2]; ACC_PLIES];

#[inline]
fn w1() -> &'static [i16] {
    unsafe {
        core::slice::from_raw_parts(
            WEIGHTS.0.as_ptr().add(W1_OFFSET).cast::<i16>(),
            INPUTS * HIDDEN,
        )
    }
}

#[inline]
fn b1() -> &'static [i16] {
    unsafe { core::slice::from_raw_parts(WEIGHTS.0.as_ptr().add(B1_OFFSET).cast::<i16>(), HIDDEN) }
}

#[inline]
fn w2() -> &'static [i16] {
    unsafe {
        core::slice::from_raw_parts(WEIGHTS.0.as_ptr().add(W2_OFFSET).cast::<i16>(), 2 * HIDDEN)
    }
}

#[inline]
fn b2() -> i32 {
    let bytes = &WEIGHTS.0[B2_OFFSET..B2_OFFSET + 4];
    i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// Validates the embedded header; exercised by the test suite.
#[cfg_attr(not(test), allow(dead_code))]
pub fn header_ok() -> bool {
    let bytes = &WEIGHTS.0;
    let hidden = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    &bytes[0..4] == b"CNNU"
        && u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) == 1
        && hidden == HIDDEN
}

#[inline]
fn acc(ply: usize) -> &'static mut [[i16; HIDDEN]; 2] {
    unsafe { &mut (*core::ptr::addr_of_mut!(ACC))[ply] }
}

#[inline]
fn feature(perspective: Color, piece: Piece, square: u8) -> usize {
    let kind = engine::piece_type(piece).unwrap() as usize;
    let own = engine::piece_color(piece).unwrap() == perspective;
    let channel = if own { kind } else { kind + 6 };
    let oriented = if perspective == Color::White {
        square as usize
    } else {
        (square ^ 56) as usize
    };
    channel * 64 + oriented
}

#[inline]
fn add_feature(target: &mut [[i16; HIDDEN]; 2], piece: Piece, square: u8) {
    let weights = w1();
    let white = feature(Color::White, piece, square) * HIDDEN;
    let black = feature(Color::Black, piece, square) * HIDDEN;
    let mut index = 0;
    while index < HIDDEN {
        target[0][index] = target[0][index].wrapping_add(weights[white + index]);
        target[1][index] = target[1][index].wrapping_add(weights[black + index]);
        index += 1;
    }
}

#[inline]
fn remove_feature(target: &mut [[i16; HIDDEN]; 2], piece: Piece, square: u8) {
    let weights = w1();
    let white = feature(Color::White, piece, square) * HIDDEN;
    let black = feature(Color::Black, piece, square) * HIDDEN;
    let mut index = 0;
    while index < HIDDEN {
        target[0][index] = target[0][index].wrapping_sub(weights[white + index]);
        target[1][index] = target[1][index].wrapping_sub(weights[black + index]);
        index += 1;
    }
}

/// Rebuilds both perspective accumulators for `position` into slot `ply`.
pub fn refresh(ply: usize, position: &Position) {
    let target = acc(ply);
    let bias = b1();
    let mut index = 0;
    while index < HIDDEN {
        target[0][index] = bias[index];
        target[1][index] = bias[index];
        index += 1;
    }
    let mut square = 0_u8;
    while (square as usize) < engine::BOARD_SQUARES {
        let piece = position.board[square as usize];
        if piece != Piece::Empty {
            add_feature(target, piece, square);
        }
        square += 1;
    }
}

/// Derives slot `ply + 1` from slot `ply` by applying `mv` played by `mover`.
/// Must be called exactly once per searched child, after `make_move` proved
/// the move legal and before the recursive call at `ply + 1`.
pub fn push(ply: usize, mv: Move, mover: Color) {
    let from = engine::move_from(mv);
    let to = engine::move_to(mv);
    let moving = engine::move_piece(mv);
    let placed = match engine::move_promotion(mv) {
        Some(kind) => engine::make_piece(mover, kind),
        None => moving,
    };
    let parent: [[i16; HIDDEN]; 2] = *acc(ply);
    let child = acc(ply + 1);
    *child = parent;

    remove_feature(child, moving, from);
    if engine::move_is_en_passant(mv) {
        let capture_square = if mover == Color::White {
            to + 8
        } else {
            to - 8
        };
        remove_feature(child, engine::move_captured(mv), capture_square);
    } else {
        let captured = engine::move_captured(mv);
        if captured != Piece::Empty {
            remove_feature(child, captured, to);
        }
    }
    add_feature(child, placed, to);
    if let Some(side) = engine::move_castle(mv) {
        let home = if mover == Color::White { 56_u8 } else { 0_u8 };
        let rook = engine::make_piece(mover, PieceType::Rook);
        let (rook_from, rook_to) = if side == engine::CastleSide::KingSide {
            (home + 7, home + 5)
        } else {
            (home, home + 3)
        };
        remove_feature(child, rook, rook_from);
        add_feature(child, rook, rook_to);
    }
}

#[inline]
fn screlu(value: i16) -> i64 {
    let clamped = (value as i32).clamp(0, QA) as i64;
    clamped * clamped
}

/// Shipped lone-king mop-up term (eval.rs `mop_up`), White POV, applied only
/// when one side has a bare king and the other still has a piece. Scans from
/// both board edges so ordinary positions exit after a few squares.
#[cfg(feature = "nnue-mopup")]
fn mop_up_term(position: &Position) -> i32 {
    let board = &position.board;
    let mut force = [0_u8; 2];
    let mut pieces = [0_u8; 2];
    let mut low = 0_usize;
    let mut high = engine::BOARD_SQUARES - 1;
    while low <= high {
        for square in [low, high] {
            let piece = board[square];
            if piece != Piece::Empty {
                let kind = engine::piece_type(piece).unwrap();
                if kind != PieceType::King {
                    let index = engine::color_index(engine::piece_color(piece).unwrap());
                    force[index] = force[index].saturating_add(1);
                    if kind != PieceType::Pawn {
                        pieces[index] = pieces[index].saturating_add(1);
                    }
                }
            }
            if low == high {
                break;
            }
        }
        if force[0] > 0 && force[1] > 0 {
            return 0;
        }
        low += 1;
        if high == 0 {
            break;
        }
        high -= 1;
    }
    let kings = position.king_sq;
    if kings[0] as usize >= engine::BOARD_SQUARES || kings[1] as usize >= engine::BOARD_SQUARES {
        return 0;
    }
    if pieces[0] > 0 && force[1] == 0 {
        crate::eval::mop_up(kings[1] as i8, kings[0] as i8)
    } else if pieces[1] > 0 && force[0] == 0 {
        -crate::eval::mop_up(kings[0] as i8, kings[1] as i8)
    } else {
        0
    }
}

/// White-POV score of `position` from the accumulators in slot `ply`.
pub fn evaluate(position: &Position, ply: usize) -> i32 {
    #[cfg(feature = "nnue-mopup")]
    {
        evaluate_net(position, ply) + mop_up_term(position)
    }
    #[cfg(not(feature = "nnue-mopup"))]
    {
        evaluate_net(position, ply)
    }
}

/// Pure network output, White POV.
pub fn evaluate_net(position: &Position, ply: usize) -> i32 {
    let slot = acc(ply);
    let stm = engine::color_index(position.turn);
    let nstm = 1 - stm;
    let output = w2();
    let mut sum: i64 = 0;
    let mut index = 0;
    while index < HIDDEN {
        sum += screlu(slot[stm][index]) * output[index] as i64;
        index += 1;
    }
    index = 0;
    while index < HIDDEN {
        sum += screlu(slot[nstm][index]) * output[HIDDEN + index] as i64;
        index += 1;
    }
    // Truncating integer division, identical to the Python/JS references.
    let scaled = (sum / QA as i64 + b2() as i64) * SCALE / (QA as i64 * QB as i64);
    let stm_score = scaled.clamp(-OUTPUT_CLAMP, OUTPUT_CLAMP) as i32;
    if position.turn == Color::White {
        stm_score
    } else {
        -stm_score
    }
}

/// Fresh White-POV evaluation that does not disturb the search stack.
pub fn evaluate_fresh(position: &Position) -> i32 {
    refresh(SCRATCH_PLY, position);
    evaluate(position, SCRATCH_PLY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::MAX_MOVES;

    fn lcg(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *state >> 33
    }

    fn assert_slots_equal(a: usize, b: usize) {
        let left = *acc(a);
        let right = *acc(b);
        assert_eq!(left, right);
    }

    #[test]
    fn embedded_header_matches_hidden_width() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        assert!(header_ok(), "embedded NNUE file header mismatch");
    }

    #[test]
    fn incremental_matches_refresh_on_random_playouts() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        let starts: [&[u8]; 6] = [
            b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            b"r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
            b"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
            b"rnbqkb1r/pp1p1pPp/8/2p1pP2/1P1P4/3P3P/P1P1P3/RNBQKBNR w KQkq e6 0 1",
            b"r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
        ];
        let mut seed = 0x9E3779B97F4A7C15_u64;
        let mut covered_promotion = false;
        let mut covered_castle = false;
        let mut covered_ep = false;
        for start in starts.iter() {
            for _game in 0..12 {
                let mut position = engine::parse_fen(start).unwrap();
                refresh(0, &position);
                let mut ply = 0;
                while ply < 60 {
                    let mut moves = [0_u32; MAX_MOVES];
                    let count = engine::generate_legal(&mut position, &mut moves);
                    if count == 0 {
                        break;
                    }
                    let mv = moves[(lcg(&mut seed) as usize) % count];
                    covered_promotion |= engine::move_promotion(mv).is_some();
                    covered_castle |= engine::move_castle(mv).is_some();
                    covered_ep |= engine::move_is_en_passant(mv);
                    let mover = position.turn;
                    engine::make_move(&mut position, mv);
                    push(ply, mv, mover);
                    refresh(SCRATCH_PLY, &position);
                    assert_slots_equal(ply + 1, SCRATCH_PLY);
                    let incremental = evaluate(&position, ply + 1);
                    let fresh = evaluate_fresh(&position);
                    assert_eq!(incremental, fresh);
                    ply += 1;
                }
            }
        }
        assert!(covered_promotion && covered_castle && covered_ep);
    }

    #[test]
    fn evaluation_is_white_pov_and_colour_symmetric() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        // Colour-rank mirror of a position negates the White-POV score exactly.
        let cases: [(&[u8], &[u8]); 3] = [
            (
                b"r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5",
                b"rnbq1rk1/pppp1ppp/5n2/b3p3/4P3/P1N2N2/1PPP1PPP/R1BQKB1R w KQ - 3 5",
            ),
            (
                b"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
                b"2r5/R7/8/8/8/8/1p6/1k1K4 b - - 0 1",
            ),
            (
                b"8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1",
                b"8/4k1p1/2b2p2/8/4N3/4P1P1/3K1P2/8 b - - 0 1",
            ),
        ];
        for (fen, mirrored) in cases.iter() {
            let a = engine::parse_fen(fen).unwrap();
            let b = engine::parse_fen(mirrored).unwrap();
            assert_eq!(evaluate_fresh(&a), -evaluate_fresh(&b));
        }
    }

    #[test]
    fn matches_exporter_goldens_when_provided() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        let Some(path) = option_env!("CHESSY_NNUE_GOLDENS") else {
            return;
        };
        let text = std::fs::read_to_string(path).expect("goldens readable");
        let mut checked = 0;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (fen, expected) = line.rsplit_once('|').expect("fen|score");
            let expected: i32 = expected.trim().parse().expect("integer score");
            let position = engine::parse_fen(fen.trim().as_bytes()).expect("golden fen");
            refresh(SCRATCH_PLY, &position);
            assert_eq!(
                evaluate_net(&position, SCRATCH_PLY),
                expected,
                "golden mismatch for {fen}"
            );
            checked += 1;
        }
        assert!(checked > 0, "no goldens checked");
    }

    #[cfg(feature = "nnue-mopup")]
    #[test]
    fn mop_up_term_matches_hce_lone_king_cases() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        // Lone black king vs white rook: shipped HCE adds +mop_up(black king, white king).
        let rook = engine::parse_fen(b"8/8/8/8/8/8/3k4/R3K3 w - - 0 1").unwrap();
        assert_eq!(mop_up_term(&rook), crate::eval::mop_up(51, 60));
        let mirrored = engine::parse_fen(b"8/8/8/8/8/8/4K3/r3k3 b - - 0 1").unwrap();
        assert_eq!(mop_up_term(&mirrored), -crate::eval::mop_up(52, 60));
        // Both sides have force: no term.
        let opening =
            engine::parse_fen(b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
        assert_eq!(mop_up_term(&opening), 0);
        // Pawn-only force does not trigger the term (matches HCE's `pieces` rule).
        let pawn = engine::parse_fen(b"8/8/8/8/8/8/3k1P2/4K3 w - - 0 1").unwrap();
        assert_eq!(mop_up_term(&pawn), 0);
    }
}
