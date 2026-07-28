//! Allocation-free chess rule core.
//!
//! Square 0 is a8 and square 63 is h1. Generation order intentionally
//! matches the shipped JavaScript engine and the Zig feasibility core.

pub const BOARD_SQUARES: usize = 64;
pub const MAX_MOVES: usize = 256;
pub const NO_SQUARE: u8 = 64;

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Color {
    White = 0,
    Black = 1,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PieceType {
    Pawn = 0,
    Knight = 1,
    Bishop = 2,
    Rook = 3,
    Queen = 4,
    King = 5,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Piece {
    Empty = 0,
    WhitePawn = 1,
    WhiteKnight = 2,
    WhiteBishop = 3,
    WhiteRook = 4,
    WhiteQueen = 5,
    WhiteKing = 6,
    BlackPawn = 7,
    BlackKnight = 8,
    BlackBishop = 9,
    BlackRook = 10,
    BlackQueen = 11,
    BlackKing = 12,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CastleSide {
    KingSide,
    QueenSide,
}

pub const CASTLE_WHITE_K: u8 = 1;
pub const CASTLE_WHITE_Q: u8 = 2;
pub const CASTLE_BLACK_K: u8 = 4;
pub const CASTLE_BLACK_Q: u8 = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub board: [Piece; BOARD_SQUARES],
    pub turn: Color,
    pub castling: u8,
    pub ep: u8,
    pub halfmove: u16,
    pub fullmove: u16,
    pub king_sq: [u8; 2],
}

impl Position {
    pub const EMPTY: Self = Self {
        board: [Piece::Empty; BOARD_SQUARES],
        turn: Color::White,
        castling: 0,
        ep: NO_SQUARE,
        halfmove: 0,
        fullmove: 1,
        king_sq: [NO_SQUARE; 2],
    };
}

#[derive(Clone, Copy)]
pub struct Undo {
    captured: Piece,
    castling: u8,
    ep: u8,
    halfmove: u16,
    fullmove: u16,
    king_sq: [u8; 2],
}

pub type Move = u32;

const MOVE_TO_SHIFT: u32 = 6;
const MOVE_PIECE_SHIFT: u32 = 12;
const MOVE_CAPTURE_SHIFT: u32 = 16;
const MOVE_PROMOTION_SHIFT: u32 = 20;
const MOVE_EP_BIT: Move = 1 << 23;
const MOVE_CASTLE_K_BIT: Move = 1 << 24;
const MOVE_CASTLE_Q_BIT: Move = 1 << 25;
const MOVE_DOUBLE_BIT: Move = 1 << 26;

#[derive(Clone, Copy)]
struct Offset {
    dr: i8,
    dc: i8,
}

const KNIGHT_STEPS: [Offset; 8] = [
    Offset { dr: -2, dc: -1 },
    Offset { dr: -2, dc: 1 },
    Offset { dr: -1, dc: -2 },
    Offset { dr: -1, dc: 2 },
    Offset { dr: 1, dc: -2 },
    Offset { dr: 1, dc: 2 },
    Offset { dr: 2, dc: -1 },
    Offset { dr: 2, dc: 1 },
];

const KING_STEPS: [Offset; 8] = [
    Offset { dr: -1, dc: -1 },
    Offset { dr: -1, dc: 0 },
    Offset { dr: -1, dc: 1 },
    Offset { dr: 0, dc: -1 },
    Offset { dr: 0, dc: 1 },
    Offset { dr: 1, dc: -1 },
    Offset { dr: 1, dc: 0 },
    Offset { dr: 1, dc: 1 },
];

const BISHOP_DIRS: [Offset; 4] = [
    Offset { dr: -1, dc: -1 },
    Offset { dr: -1, dc: 1 },
    Offset { dr: 1, dc: -1 },
    Offset { dr: 1, dc: 1 },
];

const ROOK_DIRS: [Offset; 4] = [
    Offset { dr: -1, dc: 0 },
    Offset { dr: 1, dc: 0 },
    Offset { dr: 0, dc: -1 },
    Offset { dr: 0, dc: 1 },
];

const PROMOTION_ORDER: [PieceType; 4] = [
    PieceType::Queen,
    PieceType::Rook,
    PieceType::Bishop,
    PieceType::Knight,
];

#[inline]
pub fn opposite(color: Color) -> Color {
    if color == Color::White {
        Color::Black
    } else {
        Color::White
    }
}

#[inline]
pub fn color_index(color: Color) -> usize {
    color as usize
}

#[inline]
pub fn piece_color(piece: Piece) -> Option<Color> {
    let value = piece as u8;
    if value == 0 {
        None
    } else if value <= 6 {
        Some(Color::White)
    } else {
        Some(Color::Black)
    }
}

#[inline]
pub fn piece_type(piece: Piece) -> Option<PieceType> {
    let value = piece as u8;
    if value == 0 {
        return None;
    }
    Some(match (value - 1) % 6 {
        0 => PieceType::Pawn,
        1 => PieceType::Knight,
        2 => PieceType::Bishop,
        3 => PieceType::Rook,
        4 => PieceType::Queen,
        _ => PieceType::King,
    })
}

#[inline]
pub fn make_piece(color: Color, kind: PieceType) -> Piece {
    piece_from_u8((if color == Color::White { 1 } else { 7 }) + kind as u8)
}

#[inline]
fn piece_from_u8(value: u8) -> Piece {
    match value {
        0 => Piece::Empty,
        1 => Piece::WhitePawn,
        2 => Piece::WhiteKnight,
        3 => Piece::WhiteBishop,
        4 => Piece::WhiteRook,
        5 => Piece::WhiteQueen,
        6 => Piece::WhiteKing,
        7 => Piece::BlackPawn,
        8 => Piece::BlackKnight,
        9 => Piece::BlackBishop,
        10 => Piece::BlackRook,
        11 => Piece::BlackQueen,
        12 => Piece::BlackKing,
        _ => unreachable!(),
    }
}

#[inline]
pub fn row_of(square: u8) -> u8 {
    square / 8
}

#[inline]
pub fn col_of(square: u8) -> u8 {
    square % 8
}

#[inline]
#[allow(dead_code)]
pub fn square_of(row: u8, col: u8) -> u8 {
    row * 8 + col
}

#[inline]
fn on_board(row: i8, col: i8) -> bool {
    row >= 0 && row < 8 && col >= 0 && col < 8
}

#[inline]
#[allow(dead_code)]
pub fn mirror_square(square: u8) -> u8 {
    (7 - row_of(square)) * 8 + col_of(square)
}

pub fn pack_move(
    from: u8,
    to: u8,
    piece: Piece,
    captured: Piece,
    promotion: Option<PieceType>,
    en_passant: bool,
    castle: Option<CastleSide>,
    double_push: bool,
) -> Move {
    let mut mv = from as Move
        | ((to as Move) << MOVE_TO_SHIFT)
        | ((piece as Move) << MOVE_PIECE_SHIFT)
        | ((captured as Move) << MOVE_CAPTURE_SHIFT);
    if let Some(kind) = promotion {
        mv |= ((kind as Move) + 1) << MOVE_PROMOTION_SHIFT;
    }
    if en_passant {
        mv |= MOVE_EP_BIT;
    }
    if let Some(side) = castle {
        mv |= if side == CastleSide::KingSide {
            MOVE_CASTLE_K_BIT
        } else {
            MOVE_CASTLE_Q_BIT
        };
    }
    if double_push {
        mv |= MOVE_DOUBLE_BIT;
    }
    mv
}

#[inline]
pub fn move_from(mv: Move) -> u8 {
    (mv & 0x3f) as u8
}

#[inline]
pub fn move_to(mv: Move) -> u8 {
    ((mv >> MOVE_TO_SHIFT) & 0x3f) as u8
}

#[inline]
pub fn move_piece(mv: Move) -> Piece {
    piece_from_u8(((mv >> MOVE_PIECE_SHIFT) & 0xf) as u8)
}

#[inline]
pub fn move_captured(mv: Move) -> Piece {
    piece_from_u8(((mv >> MOVE_CAPTURE_SHIFT) & 0xf) as u8)
}

#[inline]
pub fn move_promotion(mv: Move) -> Option<PieceType> {
    match ((mv >> MOVE_PROMOTION_SHIFT) & 0x7) as u8 {
        0 => None,
        1 => Some(PieceType::Pawn),
        2 => Some(PieceType::Knight),
        3 => Some(PieceType::Bishop),
        4 => Some(PieceType::Rook),
        5 => Some(PieceType::Queen),
        6 => Some(PieceType::King),
        _ => unreachable!(),
    }
}

#[inline]
pub fn move_is_en_passant(mv: Move) -> bool {
    mv & MOVE_EP_BIT != 0
}

#[inline]
pub fn move_castle(mv: Move) -> Option<CastleSide> {
    if mv & MOVE_CASTLE_K_BIT != 0 {
        Some(CastleSide::KingSide)
    } else if mv & MOVE_CASTLE_Q_BIT != 0 {
        Some(CastleSide::QueenSide)
    } else {
        None
    }
}

#[inline]
pub fn move_is_double_push(mv: Move) -> bool {
    mv & MOVE_DOUBLE_BIT != 0
}

#[inline]
pub fn move_is_capture(mv: Move) -> bool {
    move_captured(mv) != Piece::Empty
}

#[inline]
#[allow(dead_code)]
pub fn move_identity(mv: Move) -> u32 {
    let promotion = match move_promotion(mv) {
        Some(PieceType::Queen) => 1,
        Some(PieceType::Rook) => 2,
        Some(PieceType::Bishop) => 3,
        Some(PieceType::Knight) => 4,
        _ => 0,
    };
    ((move_from(mv) as u32) << 9) | ((move_to(mv) as u32) << 3) | promotion
}

#[inline]
#[allow(dead_code)]
pub fn same_move(a: Move, b: Move) -> bool {
    move_identity(a) == move_identity(b)
}

fn castling_mask(color: Color, side: CastleSide) -> u8 {
    match color {
        Color::White => {
            if side == CastleSide::KingSide {
                CASTLE_WHITE_K
            } else {
                CASTLE_WHITE_Q
            }
        }
        Color::Black => {
            if side == CastleSide::KingSide {
                CASTLE_BLACK_K
            } else {
                CASTLE_BLACK_Q
            }
        }
    }
}

#[inline]
fn has_castling(position: &Position, color: Color, side: CastleSide) -> bool {
    position.castling & castling_mask(color, side) != 0
}

#[allow(clippy::too_many_arguments)]
fn append_move(
    output: &mut [Move; MAX_MOVES],
    count: &mut usize,
    from: u8,
    to: u8,
    piece: Piece,
    captured: Piece,
    promotion: Option<PieceType>,
    en_passant: bool,
    castle: Option<CastleSide>,
    double_push: bool,
) {
    assert!(*count < MAX_MOVES);
    output[*count] = pack_move(
        from,
        to,
        piece,
        captured,
        promotion,
        en_passant,
        castle,
        double_push,
    );
    *count += 1;
}

fn find_king(board: &[Piece; BOARD_SQUARES], color: Color) -> u8 {
    let target = make_piece(color, PieceType::King);
    let mut square = 0;
    while square < BOARD_SQUARES {
        if board[square] == target {
            return square as u8;
        }
        square += 1;
    }
    NO_SQUARE
}

pub fn is_attacked(board: &[Piece; BOARD_SQUARES], square: u8, by: Color) -> bool {
    if square as usize >= BOARD_SQUARES {
        return false;
    }
    let row = row_of(square) as i8;
    let col = col_of(square) as i8;

    let pawn_row = if by == Color::White { row + 1 } else { row - 1 };
    let pawn = make_piece(by, PieceType::Pawn);
    for dc in [-1_i8, 1] {
        let pc = col + dc;
        if on_board(pawn_row, pc) && board[(pawn_row * 8 + pc) as usize] == pawn {
            return true;
        }
    }

    let knight = make_piece(by, PieceType::Knight);
    for step in KNIGHT_STEPS {
        let nr = row + step.dr;
        let nc = col + step.dc;
        if on_board(nr, nc) && board[(nr * 8 + nc) as usize] == knight {
            return true;
        }
    }

    let king = make_piece(by, PieceType::King);
    for step in KING_STEPS {
        let nr = row + step.dr;
        let nc = col + step.dc;
        if on_board(nr, nc) && board[(nr * 8 + nc) as usize] == king {
            return true;
        }
    }

    for direction in BISHOP_DIRS {
        let mut nr = row + direction.dr;
        let mut nc = col + direction.dc;
        while on_board(nr, nc) {
            let piece = board[(nr * 8 + nc) as usize];
            if piece != Piece::Empty {
                if piece_color(piece) == Some(by) {
                    let kind = piece_type(piece).unwrap();
                    if kind == PieceType::Bishop || kind == PieceType::Queen {
                        return true;
                    }
                }
                break;
            }
            nr += direction.dr;
            nc += direction.dc;
        }
    }

    for direction in ROOK_DIRS {
        let mut nr = row + direction.dr;
        let mut nc = col + direction.dc;
        while on_board(nr, nc) {
            let piece = board[(nr * 8 + nc) as usize];
            if piece != Piece::Empty {
                if piece_color(piece) == Some(by) {
                    let kind = piece_type(piece).unwrap();
                    if kind == PieceType::Rook || kind == PieceType::Queen {
                        return true;
                    }
                }
                break;
            }
            nr += direction.dr;
            nc += direction.dc;
        }
    }
    false
}

pub fn in_check(position: &Position, color: Color) -> bool {
    let mut king = position.king_sq[color_index(color)];
    if king == NO_SQUARE || position.board[king as usize] != make_piece(color, PieceType::King) {
        king = find_king(&position.board, color);
    }
    king != NO_SQUARE && is_attacked(&position.board, king, opposite(color))
}

pub fn generate_pseudo(position: &Position, output: &mut [Move; MAX_MOVES]) -> usize {
    let mut count = 0;
    let turn = position.turn;
    let enemy = opposite(turn);

    let mut from_index = 0;
    while from_index < BOARD_SQUARES {
        let piece = position.board[from_index];
        if piece == Piece::Empty || piece_color(piece).unwrap() != turn {
            from_index += 1;
            continue;
        }
        let from = from_index as u8;
        let row = (from_index / 8) as i8;
        let col = (from_index % 8) as i8;
        let kind = piece_type(piece).unwrap();

        match kind {
            PieceType::Pawn => {
                let direction = if turn == Color::White { -1 } else { 1 };
                let start_row = if turn == Color::White { 6 } else { 1 };
                let promotion_row = if turn == Color::White { 0 } else { 7 };
                let next_row = row + direction;

                if on_board(next_row, col) {
                    let to = (next_row * 8 + col) as u8;
                    if position.board[to as usize] == Piece::Empty {
                        if next_row == promotion_row {
                            for promotion in PROMOTION_ORDER {
                                append_move(
                                    output,
                                    &mut count,
                                    from,
                                    to,
                                    piece,
                                    Piece::Empty,
                                    Some(promotion),
                                    false,
                                    None,
                                    false,
                                );
                            }
                        } else {
                            append_move(
                                output,
                                &mut count,
                                from,
                                to,
                                piece,
                                Piece::Empty,
                                None,
                                false,
                                None,
                                false,
                            );
                            let double_row = row + 2 * direction;
                            let double_to = (double_row * 8 + col) as u8;
                            if row == start_row
                                && position.board[double_to as usize] == Piece::Empty
                            {
                                append_move(
                                    output,
                                    &mut count,
                                    from,
                                    double_to,
                                    piece,
                                    Piece::Empty,
                                    None,
                                    false,
                                    None,
                                    true,
                                );
                            }
                        }
                    }
                }

                for dc in [-1_i8, 1] {
                    let capture_col = col + dc;
                    if !on_board(next_row, capture_col) {
                        continue;
                    }
                    let to = (next_row * 8 + capture_col) as u8;
                    let captured = position.board[to as usize];
                    if captured != Piece::Empty && piece_color(captured).unwrap() == enemy {
                        if next_row == promotion_row {
                            for promotion in PROMOTION_ORDER {
                                append_move(
                                    output,
                                    &mut count,
                                    from,
                                    to,
                                    piece,
                                    captured,
                                    Some(promotion),
                                    false,
                                    None,
                                    false,
                                );
                            }
                        } else {
                            append_move(
                                output, &mut count, from, to, piece, captured, None, false, None,
                                false,
                            );
                        }
                    } else if to == position.ep {
                        append_move(
                            output,
                            &mut count,
                            from,
                            to,
                            piece,
                            make_piece(enemy, PieceType::Pawn),
                            None,
                            true,
                            None,
                            false,
                        );
                    }
                }
            }
            PieceType::Knight | PieceType::King => {
                let steps: &[Offset] = if kind == PieceType::Knight {
                    &KNIGHT_STEPS
                } else {
                    &KING_STEPS
                };
                for step in steps {
                    let nr = row + step.dr;
                    let nc = col + step.dc;
                    if !on_board(nr, nc) {
                        continue;
                    }
                    let to = (nr * 8 + nc) as u8;
                    let captured = position.board[to as usize];
                    if captured == Piece::Empty || piece_color(captured).unwrap() == enemy {
                        append_move(
                            output, &mut count, from, to, piece, captured, None, false, None, false,
                        );
                    }
                }

                if kind == PieceType::King {
                    let home = if turn == Color::White { 56 } else { 0 };
                    if from == home + 4 && !is_attacked(&position.board, from, enemy) {
                        if has_castling(position, turn, CastleSide::KingSide)
                            && position.board[(home + 5) as usize] == Piece::Empty
                            && position.board[(home + 6) as usize] == Piece::Empty
                            && position.board[(home + 7) as usize]
                                == make_piece(turn, PieceType::Rook)
                            && !is_attacked(&position.board, home + 5, enemy)
                            && !is_attacked(&position.board, home + 6, enemy)
                        {
                            append_move(
                                output,
                                &mut count,
                                from,
                                home + 6,
                                piece,
                                Piece::Empty,
                                None,
                                false,
                                Some(CastleSide::KingSide),
                                false,
                            );
                        }
                        if has_castling(position, turn, CastleSide::QueenSide)
                            && position.board[(home + 3) as usize] == Piece::Empty
                            && position.board[(home + 2) as usize] == Piece::Empty
                            && position.board[(home + 1) as usize] == Piece::Empty
                            && position.board[home as usize] == make_piece(turn, PieceType::Rook)
                            && !is_attacked(&position.board, home + 3, enemy)
                            && !is_attacked(&position.board, home + 2, enemy)
                        {
                            append_move(
                                output,
                                &mut count,
                                from,
                                home + 2,
                                piece,
                                Piece::Empty,
                                None,
                                false,
                                Some(CastleSide::QueenSide),
                                false,
                            );
                        }
                    }
                }
            }
            PieceType::Bishop | PieceType::Rook | PieceType::Queen => {
                let directions: &[Offset] = match kind {
                    PieceType::Bishop => &BISHOP_DIRS,
                    PieceType::Rook => &ROOK_DIRS,
                    PieceType::Queen => &KING_STEPS,
                    _ => unreachable!(),
                };
                for direction in directions {
                    let mut nr = row + direction.dr;
                    let mut nc = col + direction.dc;
                    while on_board(nr, nc) {
                        let to = (nr * 8 + nc) as u8;
                        let captured = position.board[to as usize];
                        if captured == Piece::Empty {
                            append_move(
                                output,
                                &mut count,
                                from,
                                to,
                                piece,
                                Piece::Empty,
                                None,
                                false,
                                None,
                                false,
                            );
                        } else {
                            if piece_color(captured).unwrap() == enemy {
                                append_move(
                                    output, &mut count, from, to, piece, captured, None, false,
                                    None, false,
                                );
                            }
                            break;
                        }
                        nr += direction.dr;
                        nc += direction.dc;
                    }
                }
            }
        }
        from_index += 1;
    }
    count
}

pub fn make_move(position: &mut Position, mv: Move) -> Undo {
    let from = move_from(mv);
    let to = move_to(mv);
    let moving = position.board[from as usize];
    let mover = position.turn;
    let undo = Undo {
        captured: position.board[to as usize],
        castling: position.castling,
        ep: position.ep,
        halfmove: position.halfmove,
        fullmove: position.fullmove,
        king_sq: position.king_sq,
    };

    position.board[to as usize] = if let Some(promotion) = move_promotion(mv) {
        make_piece(mover, promotion)
    } else {
        moving
    };
    position.board[from as usize] = Piece::Empty;

    if move_is_en_passant(mv) {
        let capture_square = if mover == Color::White {
            to + 8
        } else {
            to - 8
        };
        position.board[capture_square as usize] = Piece::Empty;
    }

    if let Some(side) = move_castle(mv) {
        let home = if mover == Color::White { 56 } else { 0 };
        if side == CastleSide::KingSide {
            position.board[(home + 5) as usize] = position.board[(home + 7) as usize];
            position.board[(home + 7) as usize] = Piece::Empty;
        } else {
            position.board[(home + 3) as usize] = position.board[home as usize];
            position.board[home as usize] = Piece::Empty;
        }
    }

    if piece_type(moving) == Some(PieceType::King) {
        position.castling &= !(castling_mask(mover, CastleSide::KingSide)
            | castling_mask(mover, CastleSide::QueenSide));
        position.king_sq[color_index(mover)] = to;
    }

    let rook_homes = [56_u8, 63, 0, 7];
    let rook_rights = [
        CASTLE_WHITE_Q,
        CASTLE_WHITE_K,
        CASTLE_BLACK_Q,
        CASTLE_BLACK_K,
    ];
    let mut index = 0;
    while index < 4 {
        if from == rook_homes[index] || to == rook_homes[index] {
            position.castling &= !rook_rights[index];
        }
        index += 1;
    }

    position.ep = if move_is_double_push(mv) {
        (from + to) / 2
    } else {
        NO_SQUARE
    };
    if piece_type(moving) == Some(PieceType::Pawn) || move_is_capture(mv) {
        position.halfmove = 0;
    } else {
        position.halfmove = position.halfmove.saturating_add(1);
    }
    if mover == Color::Black {
        position.fullmove = position.fullmove.saturating_add(1);
    }
    position.turn = opposite(mover);
    undo
}

pub fn unmake_move(position: &mut Position, mv: Move, undo: Undo) {
    let mover = opposite(position.turn);
    let from = move_from(mv);
    let to = move_to(mv);

    position.turn = mover;
    position.castling = undo.castling;
    position.ep = undo.ep;
    position.halfmove = undo.halfmove;
    position.fullmove = undo.fullmove;
    position.king_sq = undo.king_sq;

    position.board[from as usize] = move_piece(mv);
    position.board[to as usize] = undo.captured;

    if move_is_en_passant(mv) {
        position.board[to as usize] = Piece::Empty;
        let capture_square = if mover == Color::White {
            to + 8
        } else {
            to - 8
        };
        position.board[capture_square as usize] = move_captured(mv);
    }

    if let Some(side) = move_castle(mv) {
        let home = if mover == Color::White { 56 } else { 0 };
        if side == CastleSide::KingSide {
            position.board[(home + 7) as usize] = position.board[(home + 5) as usize];
            position.board[(home + 5) as usize] = Piece::Empty;
        } else {
            position.board[home as usize] = position.board[(home + 3) as usize];
            position.board[(home + 3) as usize] = Piece::Empty;
        }
    }
}

pub fn generate_legal(position: &mut Position, output: &mut [Move; MAX_MOVES]) -> usize {
    let pseudo_count = generate_pseudo(position, output);
    let mover = position.turn;
    let mut legal_count = 0;
    let mut index = 0;
    while index < pseudo_count {
        let mv = output[index];
        let undo = make_move(position, mv);
        let illegal = in_check(position, mover);
        unmake_move(position, mv, undo);
        if !illegal {
            output[legal_count] = mv;
            legal_count += 1;
        }
        index += 1;
    }
    legal_count
}

#[inline]
pub fn generate_root_moves(position: &mut Position, output: &mut [Move; MAX_MOVES]) -> usize {
    generate_legal(position, output)
}

pub fn has_legal_en_passant(position: &mut Position) -> bool {
    if position.ep == NO_SQUARE {
        return false;
    }
    let to = position.ep;
    let target_row = row_of(to) as i8;
    let target_col = col_of(to) as i8;
    let from_row = if position.turn == Color::White {
        target_row + 1
    } else {
        target_row - 1
    };
    if !on_board(from_row, target_col) {
        return false;
    }

    for dc in [-1_i8, 1] {
        let from_col = target_col + dc;
        if !on_board(from_row, from_col) {
            continue;
        }
        let from = (from_row * 8 + from_col) as u8;
        let pawn = make_piece(position.turn, PieceType::Pawn);
        if position.board[from as usize] != pawn {
            continue;
        }
        let mv = pack_move(
            from,
            to,
            pawn,
            make_piece(opposite(position.turn), PieceType::Pawn),
            None,
            true,
            None,
            false,
        );
        let mover = position.turn;
        let undo = make_move(position, mv);
        let legal = !in_check(position, mover);
        unmake_move(position, mv, undo);
        if legal {
            return true;
        }
    }
    false
}

pub fn insufficient_material(board: &[Piece; BOARD_SQUARES]) -> bool {
    let mut minor_count = 0_u8;
    let mut first_bishop_shade = 0_u8;
    let mut all_same_shade_bishops = true;
    let mut square = 0;
    while square < BOARD_SQUARES {
        let piece = board[square];
        if piece == Piece::Empty || piece_type(piece) == Some(PieceType::King) {
            square += 1;
            continue;
        }
        match piece_type(piece).unwrap() {
            PieceType::Bishop => {
                let shade = (((square / 8) + (square % 8)) & 1) as u8;
                if minor_count == 0 {
                    first_bishop_shade = shade;
                } else if shade != first_bishop_shade {
                    all_same_shade_bishops = false;
                }
                minor_count += 1;
            }
            PieceType::Knight => {
                minor_count += 1;
                all_same_shade_bishops = false;
            }
            _ => return false,
        }
        square += 1;
    }
    minor_count <= 1 || all_same_shade_bishops
}

#[inline]
pub fn position_insufficient_material(position: &Position) -> bool {
    insufficient_material(&position.board)
}

#[allow(dead_code)]
pub fn can_mate(board: &[Piece; BOARD_SQUARES], color: Color) -> bool {
    let mut own_minors = 0_u8;
    let mut own_knight = false;
    let mut own_bishop = false;
    let mut pawn_or_knight = false;
    let mut opponent_blocker = false;
    let mut bishop_shades = 0_u8;

    let mut square = 0;
    while square < BOARD_SQUARES {
        let piece = board[square];
        if piece == Piece::Empty || piece_type(piece) == Some(PieceType::King) {
            square += 1;
            continue;
        }
        let own = piece_color(piece).unwrap() == color;
        let kind = piece_type(piece).unwrap();
        if own && (kind == PieceType::Pawn || kind == PieceType::Rook || kind == PieceType::Queen) {
            return true;
        }
        if kind == PieceType::Pawn || kind == PieceType::Knight {
            pawn_or_knight = true;
        }
        if kind == PieceType::Bishop {
            let shade = (((square / 8) + (square % 8)) & 1) as u8;
            bishop_shades |= 1 << shade;
        }
        if own {
            own_minors += 1;
            if kind == PieceType::Knight {
                own_knight = true;
            }
            if kind == PieceType::Bishop {
                own_bishop = true;
            }
        } else if kind != PieceType::Queen {
            opponent_blocker = true;
        }
        square += 1;
    }
    if own_knight {
        own_minors >= 2 || opponent_blocker
    } else if own_bishop {
        bishop_shades == 3 || pawn_or_knight
    } else {
        false
    }
}

fn piece_from_fen(character: u8) -> Option<Piece> {
    Some(match character {
        b'P' => Piece::WhitePawn,
        b'N' => Piece::WhiteKnight,
        b'B' => Piece::WhiteBishop,
        b'R' => Piece::WhiteRook,
        b'Q' => Piece::WhiteQueen,
        b'K' => Piece::WhiteKing,
        b'p' => Piece::BlackPawn,
        b'n' => Piece::BlackKnight,
        b'b' => Piece::BlackBishop,
        b'r' => Piece::BlackRook,
        b'q' => Piece::BlackQueen,
        b'k' => Piece::BlackKing,
        _ => return None,
    })
}

fn next_field<'a>(text: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    while *offset < text.len() && matches!(text[*offset], b' ' | b'\t' | b'\r' | b'\n') {
        *offset += 1;
    }
    if *offset == text.len() {
        return None;
    }
    let start = *offset;
    while *offset < text.len() && !matches!(text[*offset], b' ' | b'\t' | b'\r' | b'\n') {
        *offset += 1;
    }
    Some(&text[start..*offset])
}

fn parse_unsigned(field: &[u8]) -> Option<u16> {
    if field.is_empty() {
        return None;
    }
    let mut value = 0_u32;
    for &character in field {
        if !character.is_ascii_digit() {
            return None;
        }
        value = value * 10 + (character - b'0') as u32;
        if value > u16::MAX as u32 {
            return None;
        }
    }
    Some(value as u16)
}

pub fn parse_fen(fen: &[u8]) -> Option<Position> {
    let mut offset = 0;
    let board_field = next_field(fen, &mut offset)?;
    let turn_field = next_field(fen, &mut offset)?;
    let castling_field = next_field(fen, &mut offset)?;
    let ep_field = next_field(fen, &mut offset)?;
    let halfmove_field = next_field(fen, &mut offset).unwrap_or(b"0");
    let fullmove_field = next_field(fen, &mut offset).unwrap_or(b"1");

    let mut position = Position {
        halfmove: parse_unsigned(halfmove_field)?,
        fullmove: parse_unsigned(fullmove_field)?,
        ..Position::EMPTY
    };

    let mut square = 0_usize;
    let mut row_squares = 0_usize;
    let mut separators = 0_u8;
    for &character in board_field {
        if character == b'/' {
            if row_squares != 8 || separators >= 7 {
                return None;
            }
            row_squares = 0;
            separators += 1;
            continue;
        }
        if (b'1'..=b'8').contains(&character) {
            let empty_count = (character - b'0') as usize;
            if row_squares + empty_count > 8 || square + empty_count > BOARD_SQUARES {
                return None;
            }
            row_squares += empty_count;
            square += empty_count;
            continue;
        }
        let piece = piece_from_fen(character)?;
        if row_squares >= 8 || square >= BOARD_SQUARES {
            return None;
        }
        position.board[square] = piece;
        if piece_type(piece) == Some(PieceType::King) {
            position.king_sq[color_index(piece_color(piece).unwrap())] = square as u8;
        }
        row_squares += 1;
        square += 1;
    }
    if square != BOARD_SQUARES || row_squares != 8 || separators != 7 {
        return None;
    }

    position.turn = match turn_field {
        b"w" => Color::White,
        b"b" => Color::Black,
        _ => return None,
    };

    if castling_field != b"-" {
        if castling_field.is_empty() {
            return None;
        }
        for &character in castling_field {
            let right = match character {
                b'K' => CASTLE_WHITE_K,
                b'Q' => CASTLE_WHITE_Q,
                b'k' => CASTLE_BLACK_K,
                b'q' => CASTLE_BLACK_Q,
                _ => return None,
            };
            if position.castling & right != 0 {
                return None;
            }
            position.castling |= right;
        }
    }

    if ep_field != b"-" {
        if ep_field.len() != 2
            || !(b'a'..=b'h').contains(&ep_field[0])
            || !(b'1'..=b'8').contains(&ep_field[1])
        {
            return None;
        }
        let file = ep_field[0] - b'a';
        let rank = ep_field[1] - b'0';
        position.ep = (8 - rank) * 8 + file;
    }
    Some(position)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initial_position() -> Position {
        parse_fen(b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap()
    }

    fn perft(position: &mut Position, depth: u8) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut moves = [0; MAX_MOVES];
        let count = generate_legal(position, &mut moves);
        let mut nodes = 0;
        for &mv in &moves[..count] {
            let undo = make_move(position, mv);
            nodes += perft(position, depth - 1);
            unmake_move(position, mv, undo);
        }
        nodes
    }

    #[test]
    fn initial_position_perft_and_pseudo_ordering() {
        let mut position = initial_position();
        let mut moves = [0; MAX_MOVES];
        let count = generate_pseudo(&position, &mut moves);
        assert_eq!(count, 20);
        assert_eq!(move_from(moves[0]), 48);
        assert_eq!(move_to(moves[0]), 40);
        assert_eq!(move_from(moves[1]), 48);
        assert_eq!(move_to(moves[1]), 32);
        assert_eq!(perft(&mut position, 1), 20);
        assert_eq!(perft(&mut position, 2), 400);
        assert_eq!(perft(&mut position, 3), 8_902);
        assert_eq!(perft(&mut position, 4), 197_281);
    }

    #[test]
    fn kiwipete_en_passant_and_promotion_perft() {
        let mut kiwipete =
            parse_fen(b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
                .unwrap();
        assert_eq!(perft(&mut kiwipete, 1), 48);
        assert_eq!(perft(&mut kiwipete, 2), 2_039);
        assert_eq!(perft(&mut kiwipete, 3), 97_862);

        let mut position3 = parse_fen(b"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1").unwrap();
        assert_eq!(perft(&mut position3, 1), 14);
        assert_eq!(perft(&mut position3, 2), 191);
        assert_eq!(perft(&mut position3, 3), 2_812);
        assert_eq!(perft(&mut position3, 4), 43_238);

        let mut promotions =
            parse_fen(b"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8").unwrap();
        assert_eq!(perft(&mut promotions, 1), 44);
        assert_eq!(perft(&mut promotions, 2), 1_486);
        assert_eq!(perft(&mut promotions, 3), 62_379);
    }

    #[test]
    fn make_and_unmake_restore_position_exactly() {
        let mut position = initial_position();
        let original = position;
        let mut moves = [0; MAX_MOVES];
        let count = generate_legal(&mut position, &mut moves);
        assert_ne!(count, 0);
        for &mv in &moves[..count] {
            let undo = make_move(&mut position, mv);
            unmake_move(&mut position, mv, undo);
            assert!(position == original);
        }
    }
}
