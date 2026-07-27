//! Allocation-free chess rule core for the Chessy WASM feasibility experiment.
//!
//! The board uses the same orientation as assets/engine.js: square 0 is a8,
//! square 63 is h1. Move generation deliberately follows the JavaScript
//! generator's iteration order so fixed-node search remains reproducible.

pub const BOARD_SQUARES: usize = 64;
pub const MAX_MOVES: usize = 256;
pub const NO_SQUARE: u8 = 64;

pub const Color = enum(u1) {
    white,
    black,
};

pub const PieceType = enum(u3) {
    pawn,
    knight,
    bishop,
    rook,
    queen,
    king,
};

pub const Piece = enum(u8) {
    empty = 0,
    white_pawn = 1,
    white_knight = 2,
    white_bishop = 3,
    white_rook = 4,
    white_queen = 5,
    white_king = 6,
    black_pawn = 7,
    black_knight = 8,
    black_bishop = 9,
    black_rook = 10,
    black_queen = 11,
    black_king = 12,
};

pub const CastleSide = enum(u1) {
    king_side,
    queen_side,
};

pub const CASTLE_WHITE_K: u8 = 1;
pub const CASTLE_WHITE_Q: u8 = 2;
pub const CASTLE_BLACK_K: u8 = 4;
pub const CASTLE_BLACK_Q: u8 = 8;

/// Sentinel-based compact position. `king_sq` is a derived cache maintained by
/// parseFen/makeMove/unmakeMove; NO_SQUARE matches the JavaScript no-king case.
pub const Position = struct {
    board: [BOARD_SQUARES]Piece,
    turn: Color,
    castling: u8,
    ep: u8,
    halfmove: u16,
    fullmove: u16,
    king_sq: [2]u8,
};

/// The state that cannot be reconstructed from a packed move.
pub const Undo = struct {
    captured: Piece,
    castling: u8,
    ep: u8,
    halfmove: u16,
    fullmove: u16,
    king_sq: [2]u8,
};

pub const Move = u32;

const MOVE_FROM_SHIFT: u5 = 0;
const MOVE_TO_SHIFT: u5 = 6;
const MOVE_PIECE_SHIFT: u5 = 12;
const MOVE_CAPTURE_SHIFT: u5 = 16;
const MOVE_PROMOTION_SHIFT: u5 = 20;
const MOVE_EP_BIT: Move = @as(Move, 1) << 23;
const MOVE_CASTLE_K_BIT: Move = @as(Move, 1) << 24;
const MOVE_CASTLE_Q_BIT: Move = @as(Move, 1) << 25;
const MOVE_DOUBLE_BIT: Move = @as(Move, 1) << 26;

pub const FenError = error{
    InvalidFen,
    InvalidBoard,
    InvalidPiece,
    InvalidTurn,
    InvalidCastling,
    InvalidEnPassant,
    InvalidNumber,
};

const Offset = struct {
    dr: i8,
    dc: i8,
};

// Keep these arrays in byte-for-byte semantic order with assets/engine.js.
const KNIGHT_STEPS = [_]Offset{
    .{ .dr = -2, .dc = -1 },
    .{ .dr = -2, .dc = 1 },
    .{ .dr = -1, .dc = -2 },
    .{ .dr = -1, .dc = 2 },
    .{ .dr = 1, .dc = -2 },
    .{ .dr = 1, .dc = 2 },
    .{ .dr = 2, .dc = -1 },
    .{ .dr = 2, .dc = 1 },
};

const KING_STEPS = [_]Offset{
    .{ .dr = -1, .dc = -1 },
    .{ .dr = -1, .dc = 0 },
    .{ .dr = -1, .dc = 1 },
    .{ .dr = 0, .dc = -1 },
    .{ .dr = 0, .dc = 1 },
    .{ .dr = 1, .dc = -1 },
    .{ .dr = 1, .dc = 0 },
    .{ .dr = 1, .dc = 1 },
};

const BISHOP_DIRS = [_]Offset{
    .{ .dr = -1, .dc = -1 },
    .{ .dr = -1, .dc = 1 },
    .{ .dr = 1, .dc = -1 },
    .{ .dr = 1, .dc = 1 },
};

const ROOK_DIRS = [_]Offset{
    .{ .dr = -1, .dc = 0 },
    .{ .dr = 1, .dc = 0 },
    .{ .dr = 0, .dc = -1 },
    .{ .dr = 0, .dc = 1 },
};

const PROMOTION_ORDER = [_]PieceType{
    .queen,
    .rook,
    .bishop,
    .knight,
};

pub inline fn opposite(color: Color) Color {
    return if (color == .white) .black else .white;
}

pub inline fn colorIndex(color: Color) usize {
    return @intFromEnum(color);
}

pub inline fn pieceColor(piece: Piece) ?Color {
    const value = @intFromEnum(piece);
    if (value == 0) return null;
    return if (value <= 6) .white else .black;
}

pub inline fn pieceType(piece: Piece) ?PieceType {
    const value = @intFromEnum(piece);
    if (value == 0) return null;
    return @enumFromInt((value - 1) % 6);
}

pub inline fn makePiece(color: Color, kind: PieceType) Piece {
    const base: u8 = if (color == .white) 1 else 7;
    return @enumFromInt(base + @intFromEnum(kind));
}

pub inline fn rowOf(square: u8) u8 {
    return square / 8;
}

pub inline fn colOf(square: u8) u8 {
    return square % 8;
}

pub inline fn squareOf(row: u8, col: u8) u8 {
    return row * 8 + col;
}

pub inline fn onBoard(row: i8, col: i8) bool {
    return row >= 0 and row < 8 and col >= 0 and col < 8;
}

pub inline fn mirrorSquare(square: u8) u8 {
    return (7 - rowOf(square)) * 8 + colOf(square);
}

pub fn packMove(
    from: u8,
    to: u8,
    piece: Piece,
    captured: Piece,
    promotion: ?PieceType,
    en_passant: bool,
    castle: ?CastleSide,
    double_push: bool,
) Move {
    var move: Move = @as(Move, from) |
        (@as(Move, to) << MOVE_TO_SHIFT) |
        (@as(Move, @intFromEnum(piece)) << MOVE_PIECE_SHIFT) |
        (@as(Move, @intFromEnum(captured)) << MOVE_CAPTURE_SHIFT);
    if (promotion) |kind| {
        move |= (@as(Move, @intFromEnum(kind)) + 1) << MOVE_PROMOTION_SHIFT;
    }
    if (en_passant) move |= MOVE_EP_BIT;
    if (castle) |side| {
        move |= if (side == .king_side) MOVE_CASTLE_K_BIT else MOVE_CASTLE_Q_BIT;
    }
    if (double_push) move |= MOVE_DOUBLE_BIT;
    return move;
}

pub inline fn moveFrom(move: Move) u8 {
    return @intCast((move >> MOVE_FROM_SHIFT) & 0x3f);
}

pub inline fn moveTo(move: Move) u8 {
    return @intCast((move >> MOVE_TO_SHIFT) & 0x3f);
}

pub inline fn movePiece(move: Move) Piece {
    return @enumFromInt((move >> MOVE_PIECE_SHIFT) & 0xf);
}

pub inline fn moveCaptured(move: Move) Piece {
    return @enumFromInt((move >> MOVE_CAPTURE_SHIFT) & 0xf);
}

pub inline fn movePromotion(move: Move) ?PieceType {
    const encoded: u3 = @intCast((move >> MOVE_PROMOTION_SHIFT) & 0x7);
    if (encoded == 0) return null;
    return @enumFromInt(encoded - 1);
}

pub inline fn moveIsEnPassant(move: Move) bool {
    return move & MOVE_EP_BIT != 0;
}

pub inline fn moveCastle(move: Move) ?CastleSide {
    if (move & MOVE_CASTLE_K_BIT != 0) return .king_side;
    if (move & MOVE_CASTLE_Q_BIT != 0) return .queen_side;
    return null;
}

pub inline fn moveIsDoublePush(move: Move) bool {
    return move & MOVE_DOUBLE_BIT != 0;
}

pub inline fn moveIsCapture(move: Move) bool {
    return moveCaptured(move) != .empty;
}

/// The exact compact identity used by assets/ai.js for TT, killer, and root
/// order matching: (from << 9) | (to << 3) | {Q=1,R=2,B=3,N=4}.
pub inline fn moveIdentity(move: Move) u32 {
    const promotion_index: u32 = if (movePromotion(move)) |promotion|
        switch (promotion) {
            .queen => 1,
            .rook => 2,
            .bishop => 3,
            .knight => 4,
            else => 0,
        }
    else
        0;
    return (@as(u32, moveFrom(move)) << 9) |
        (@as(u32, moveTo(move)) << 3) |
        promotion_index;
}

pub inline fn sameMove(a: Move, b: Move) bool {
    return moveIdentity(a) == moveIdentity(b);
}

fn castlingMask(color: Color, side: CastleSide) u8 {
    return switch (color) {
        .white => if (side == .king_side) CASTLE_WHITE_K else CASTLE_WHITE_Q,
        .black => if (side == .king_side) CASTLE_BLACK_K else CASTLE_BLACK_Q,
    };
}

pub inline fn hasCastling(position: *const Position, color: Color, side: CastleSide) bool {
    return position.castling & castlingMask(color, side) != 0;
}

fn appendMove(
    output: *[MAX_MOVES]Move,
    count: *usize,
    from: u8,
    to: u8,
    piece: Piece,
    captured: Piece,
    promotion: ?PieceType,
    en_passant: bool,
    castle: ?CastleSide,
    double_push: bool,
) void {
    if (count.* >= MAX_MOVES) unreachable;
    output[count.*] = packMove(
        from,
        to,
        piece,
        captured,
        promotion,
        en_passant,
        castle,
        double_push,
    );
    count.* += 1;
}

pub fn findKing(board: *const [BOARD_SQUARES]Piece, color: Color) u8 {
    const target = makePiece(color, .king);
    for (board, 0..) |piece, square| {
        if (piece == target) return @intCast(square);
    }
    return NO_SQUARE;
}

/// Is `square` attacked by `by`? Direction and scan order match engine.js.
pub fn isAttacked(board: *const [BOARD_SQUARES]Piece, square: u8, by: Color) bool {
    if (square >= BOARD_SQUARES) return false;
    const row: i8 = @intCast(rowOf(square));
    const col: i8 = @intCast(colOf(square));

    const pawn_row = if (by == .white) row + 1 else row - 1;
    const pawn = makePiece(by, .pawn);
    const pawn_columns = [_]i8{ -1, 1 };
    for (pawn_columns) |dc| {
        const pc = col + dc;
        if (onBoard(pawn_row, pc) and
            board[@intCast(pawn_row * 8 + pc)] == pawn)
        {
            return true;
        }
    }

    const knight = makePiece(by, .knight);
    for (KNIGHT_STEPS) |step| {
        const nr = row + step.dr;
        const nc = col + step.dc;
        if (onBoard(nr, nc) and board[@intCast(nr * 8 + nc)] == knight) {
            return true;
        }
    }

    const king = makePiece(by, .king);
    for (KING_STEPS) |step| {
        const nr = row + step.dr;
        const nc = col + step.dc;
        if (onBoard(nr, nc) and board[@intCast(nr * 8 + nc)] == king) {
            return true;
        }
    }

    for (BISHOP_DIRS) |direction| {
        var nr = row + direction.dr;
        var nc = col + direction.dc;
        while (onBoard(nr, nc)) {
            const piece = board[@intCast(nr * 8 + nc)];
            if (piece != .empty) {
                if (pieceColor(piece) == by) {
                    const kind = pieceType(piece).?;
                    if (kind == .bishop or kind == .queen) return true;
                }
                break;
            }
            nr += direction.dr;
            nc += direction.dc;
        }
    }

    for (ROOK_DIRS) |direction| {
        var nr = row + direction.dr;
        var nc = col + direction.dc;
        while (onBoard(nr, nc)) {
            const piece = board[@intCast(nr * 8 + nc)];
            if (piece != .empty) {
                if (pieceColor(piece) == by) {
                    const kind = pieceType(piece).?;
                    if (kind == .rook or kind == .queen) return true;
                }
                break;
            }
            nr += direction.dr;
            nc += direction.dc;
        }
    }
    return false;
}

pub fn inCheck(position: *const Position, color: Color) bool {
    var king = position.king_sq[colorIndex(color)];
    if (king == NO_SQUARE or position.board[king] != makePiece(color, .king)) {
        king = findKing(&position.board, color);
    }
    return king != NO_SQUARE and isAttacked(&position.board, king, opposite(color));
}

/// Pseudo-legal move generation in exactly the current JavaScript order.
pub fn generatePseudo(position: *const Position, output: *[MAX_MOVES]Move) usize {
    var count: usize = 0;
    const turn = position.turn;
    const enemy = opposite(turn);

    for (position.board, 0..) |piece, from_index| {
        if (piece == .empty or pieceColor(piece).? != turn) continue;
        const from: u8 = @intCast(from_index);
        const row: i8 = @intCast(from_index / 8);
        const col: i8 = @intCast(from_index % 8);
        const kind = pieceType(piece).?;

        switch (kind) {
            .pawn => {
                const direction: i8 = if (turn == .white) -1 else 1;
                const start_row: i8 = if (turn == .white) 6 else 1;
                const promotion_row: i8 = if (turn == .white) 0 else 7;
                const next_row = row + direction;

                if (onBoard(next_row, col)) {
                    const to: u8 = @intCast(next_row * 8 + col);
                    if (position.board[to] == .empty) {
                        if (next_row == promotion_row) {
                            for (PROMOTION_ORDER) |promotion| {
                                appendMove(output, &count, from, to, piece, .empty, promotion, false, null, false);
                            }
                        } else {
                            appendMove(output, &count, from, to, piece, .empty, null, false, null, false);
                            const double_row = row + 2 * direction;
                            const double_to: u8 = @intCast(double_row * 8 + col);
                            if (row == start_row and position.board[double_to] == .empty) {
                                appendMove(output, &count, from, double_to, piece, .empty, null, false, null, true);
                            }
                        }
                    }
                }

                const capture_columns = [_]i8{ -1, 1 };
                for (capture_columns) |dc| {
                    const capture_col = col + dc;
                    if (!onBoard(next_row, capture_col)) continue;
                    const to: u8 = @intCast(next_row * 8 + capture_col);
                    const captured = position.board[to];
                    if (captured != .empty and pieceColor(captured).? == enemy) {
                        if (next_row == promotion_row) {
                            for (PROMOTION_ORDER) |promotion| {
                                appendMove(output, &count, from, to, piece, captured, promotion, false, null, false);
                            }
                        } else {
                            appendMove(output, &count, from, to, piece, captured, null, false, null, false);
                        }
                    } else if (to == position.ep) {
                        appendMove(
                            output,
                            &count,
                            from,
                            to,
                            piece,
                            makePiece(enemy, .pawn),
                            null,
                            true,
                            null,
                            false,
                        );
                    }
                }
            },
            .knight, .king => {
                const steps: []const Offset = if (kind == .knight) &KNIGHT_STEPS else &KING_STEPS;
                for (steps) |step| {
                    const nr = row + step.dr;
                    const nc = col + step.dc;
                    if (!onBoard(nr, nc)) continue;
                    const to: u8 = @intCast(nr * 8 + nc);
                    const captured = position.board[to];
                    if (captured == .empty or pieceColor(captured).? == enemy) {
                        appendMove(output, &count, from, to, piece, captured, null, false, null, false);
                    }
                }

                if (kind == .king) {
                    const home: u8 = if (turn == .white) 56 else 0;
                    if (from == home + 4 and !isAttacked(&position.board, from, enemy)) {
                        if (hasCastling(position, turn, .king_side) and
                            position.board[home + 5] == .empty and
                            position.board[home + 6] == .empty and
                            position.board[home + 7] == makePiece(turn, .rook) and
                            !isAttacked(&position.board, home + 5, enemy) and
                            !isAttacked(&position.board, home + 6, enemy))
                        {
                            appendMove(output, &count, from, home + 6, piece, .empty, null, false, .king_side, false);
                        }
                        if (hasCastling(position, turn, .queen_side) and
                            position.board[home + 3] == .empty and
                            position.board[home + 2] == .empty and
                            position.board[home + 1] == .empty and
                            position.board[home] == makePiece(turn, .rook) and
                            !isAttacked(&position.board, home + 3, enemy) and
                            !isAttacked(&position.board, home + 2, enemy))
                        {
                            appendMove(output, &count, from, home + 2, piece, .empty, null, false, .queen_side, false);
                        }
                    }
                }
            },
            .bishop, .rook, .queen => {
                const directions: []const Offset = switch (kind) {
                    .bishop => &BISHOP_DIRS,
                    .rook => &ROOK_DIRS,
                    // JS uses KING_STEPS for queen slides, including this order.
                    .queen => &KING_STEPS,
                    else => unreachable,
                };
                for (directions) |direction| {
                    var nr = row + direction.dr;
                    var nc = col + direction.dc;
                    while (onBoard(nr, nc)) {
                        const to: u8 = @intCast(nr * 8 + nc);
                        const captured = position.board[to];
                        if (captured == .empty) {
                            appendMove(output, &count, from, to, piece, .empty, null, false, null, false);
                        } else {
                            if (pieceColor(captured).? == enemy) {
                                appendMove(output, &count, from, to, piece, captured, null, false, null, false);
                            }
                            break;
                        }
                        nr += direction.dr;
                        nc += direction.dc;
                    }
                }
            },
        }
    }
    return count;
}

pub fn makeMove(position: *Position, move: Move) Undo {
    const from = moveFrom(move);
    const to = moveTo(move);
    const moving = position.board[from];
    const mover = position.turn;
    const undo = Undo{
        .captured = position.board[to],
        .castling = position.castling,
        .ep = position.ep,
        .halfmove = position.halfmove,
        .fullmove = position.fullmove,
        .king_sq = position.king_sq,
    };

    position.board[to] = if (movePromotion(move)) |promotion|
        makePiece(mover, promotion)
    else
        moving;
    position.board[from] = .empty;

    if (moveIsEnPassant(move)) {
        const capture_square: u8 = if (mover == .white) to + 8 else to - 8;
        position.board[capture_square] = .empty;
    }

    if (moveCastle(move)) |side| {
        const home: u8 = if (mover == .white) 56 else 0;
        if (side == .king_side) {
            position.board[home + 5] = position.board[home + 7];
            position.board[home + 7] = .empty;
        } else {
            position.board[home + 3] = position.board[home];
            position.board[home] = .empty;
        }
    }

    if (pieceType(moving) == .king) {
        position.castling &= ~(castlingMask(mover, .king_side) | castlingMask(mover, .queen_side));
        position.king_sq[colorIndex(mover)] = to;
    }

    const rook_homes = [_]u8{ 56, 63, 0, 7 };
    const rook_rights = [_]u8{ CASTLE_WHITE_Q, CASTLE_WHITE_K, CASTLE_BLACK_Q, CASTLE_BLACK_K };
    for (rook_homes, rook_rights) |square, right| {
        if (from == square or to == square) position.castling &= ~right;
    }

    position.ep = if (moveIsDoublePush(move)) (from + to) / 2 else NO_SQUARE;
    if (pieceType(moving) == .pawn or moveIsCapture(move)) {
        position.halfmove = 0;
    } else {
        position.halfmove +|= 1;
    }
    if (mover == .black) position.fullmove +|= 1;
    position.turn = opposite(mover);
    return undo;
}

pub fn unmakeMove(position: *Position, move: Move, undo: Undo) void {
    const mover = opposite(position.turn);
    const from = moveFrom(move);
    const to = moveTo(move);

    position.turn = mover;
    position.castling = undo.castling;
    position.ep = undo.ep;
    position.halfmove = undo.halfmove;
    position.fullmove = undo.fullmove;
    position.king_sq = undo.king_sq;

    position.board[from] = movePiece(move);
    position.board[to] = undo.captured;

    if (moveIsEnPassant(move)) {
        position.board[to] = .empty;
        const capture_square: u8 = if (mover == .white) to + 8 else to - 8;
        position.board[capture_square] = moveCaptured(move);
    }

    if (moveCastle(move)) |side| {
        const home: u8 = if (mover == .white) 56 else 0;
        if (side == .king_side) {
            position.board[home + 7] = position.board[home + 5];
            position.board[home + 5] = .empty;
        } else {
            position.board[home] = position.board[home + 3];
            position.board[home + 3] = .empty;
        }
    }
}

/// Legal move generation filters in place and preserves pseudo-move order.
pub fn generateLegal(position: *Position, output: *[MAX_MOVES]Move) usize {
    const pseudo_count = generatePseudo(position, output);
    const mover = position.turn;
    var legal_count: usize = 0;
    var index: usize = 0;
    while (index < pseudo_count) : (index += 1) {
        const move = output[index];
        const undo = makeMove(position, move);
        const illegal = inCheck(position, mover);
        unmakeMove(position, move, undo);
        if (!illegal) {
            output[legal_count] = move;
            legal_count += 1;
        }
    }
    return legal_count;
}

pub inline fn generateRootMoves(position: *Position, output: *[MAX_MOVES]Move) usize {
    return generateLegal(position, output);
}

/// Targeted legality check used to normalize repetition identity per FIDE
/// 9.2.3. A phantom en-passant square must not affect repetition hashes.
pub fn hasLegalEnPassant(position: *Position) bool {
    if (position.ep == NO_SQUARE) return false;
    const to = position.ep;
    const target_row: i8 = @intCast(rowOf(to));
    const target_col: i8 = @intCast(colOf(to));
    const from_row = if (position.turn == .white) target_row + 1 else target_row - 1;
    if (!onBoard(from_row, target_col)) return false;

    const columns = [_]i8{ -1, 1 };
    for (columns) |dc| {
        const from_col = target_col + dc;
        if (!onBoard(from_row, from_col)) continue;
        const from: u8 = @intCast(from_row * 8 + from_col);
        const pawn = makePiece(position.turn, .pawn);
        if (position.board[from] != pawn) continue;
        const move = packMove(
            from,
            to,
            pawn,
            makePiece(opposite(position.turn), .pawn),
            null,
            true,
            null,
            false,
        );
        const mover = position.turn;
        const undo = makeMove(position, move);
        const legal = !inCheck(position, mover);
        unmakeMove(position, move, undo);
        if (legal) return true;
    }
    return false;
}

pub fn insufficientMaterial(board: *const [BOARD_SQUARES]Piece) bool {
    var minor_count: u8 = 0;
    var first_bishop_shade: u1 = 0;
    var all_same_shade_bishops = true;

    for (board, 0..) |piece, square| {
        if (piece == .empty or pieceType(piece).? == .king) continue;
        switch (pieceType(piece).?) {
            .bishop => {
                const shade: u1 = @intCast(((square / 8) + (square % 8)) & 1);
                if (minor_count == 0) {
                    first_bishop_shade = shade;
                } else if (shade != first_bishop_shade) {
                    all_same_shade_bishops = false;
                }
                minor_count += 1;
            },
            .knight => {
                minor_count += 1;
                all_same_shade_bishops = false;
            },
            else => return false,
        }
    }
    return minor_count <= 1 or all_same_shade_bishops;
}

pub inline fn positionInsufficientMaterial(position: *const Position) bool {
    return insufficientMaterial(&position.board);
}

/// Conservative FIDE 6.9 material test, matching assets/engine.js.
pub fn canMate(board: *const [BOARD_SQUARES]Piece, color: Color) bool {
    var own_minors: u8 = 0;
    var own_knight = false;
    var own_bishop = false;
    var pawn_or_knight = false;
    var opponent_blocker = false;
    var bishop_shades: u2 = 0;

    for (board, 0..) |piece, square| {
        if (piece == .empty or pieceType(piece).? == .king) continue;
        const own = pieceColor(piece).? == color;
        const kind = pieceType(piece).?;
        if (own and (kind == .pawn or kind == .rook or kind == .queen)) return true;
        if (kind == .pawn or kind == .knight) pawn_or_knight = true;
        if (kind == .bishop) {
            const shade: u1 = @intCast(((square / 8) + (square % 8)) & 1);
            bishop_shades |= @as(u2, 1) << shade;
        }
        if (own) {
            own_minors += 1;
            if (kind == .knight) own_knight = true;
            if (kind == .bishop) own_bishop = true;
        } else if (kind != .queen) {
            opponent_blocker = true;
        }
    }
    if (own_knight) return own_minors >= 2 or opponent_blocker;
    if (own_bishop) return bishop_shades == 3 or pawn_or_knight;
    return false;
}

fn pieceFromFen(character: u8) ?Piece {
    return switch (character) {
        'P' => .white_pawn,
        'N' => .white_knight,
        'B' => .white_bishop,
        'R' => .white_rook,
        'Q' => .white_queen,
        'K' => .white_king,
        'p' => .black_pawn,
        'n' => .black_knight,
        'b' => .black_bishop,
        'r' => .black_rook,
        'q' => .black_queen,
        'k' => .black_king,
        else => null,
    };
}

fn nextField(text: []const u8, offset: *usize) ?[]const u8 {
    while (offset.* < text.len and
        (text[offset.*] == ' ' or text[offset.*] == '\t' or text[offset.*] == '\r' or text[offset.*] == '\n'))
    {
        offset.* += 1;
    }
    if (offset.* == text.len) return null;
    const start = offset.*;
    while (offset.* < text.len and
        text[offset.*] != ' ' and text[offset.*] != '\t' and text[offset.*] != '\r' and text[offset.*] != '\n')
    {
        offset.* += 1;
    }
    return text[start..offset.*];
}

fn parseUnsigned(field: []const u8) FenError!u16 {
    if (field.len == 0) return error.InvalidNumber;
    var value: u32 = 0;
    for (field) |character| {
        if (character < '0' or character > '9') return error.InvalidNumber;
        value = value * 10 + character - '0';
        if (value > 65535) return error.InvalidNumber;
    }
    return @intCast(value);
}

pub fn parseFen(fen: []const u8) FenError!Position {
    var offset: usize = 0;
    const board_field = nextField(fen, &offset) orelse return error.InvalidFen;
    const turn_field = nextField(fen, &offset) orelse return error.InvalidFen;
    const castling_field = nextField(fen, &offset) orelse return error.InvalidFen;
    const ep_field = nextField(fen, &offset) orelse return error.InvalidFen;
    const halfmove_field = nextField(fen, &offset) orelse "0";
    const fullmove_field = nextField(fen, &offset) orelse "1";

    var position = Position{
        .board = [_]Piece{.empty} ** BOARD_SQUARES,
        .turn = .white,
        .castling = 0,
        .ep = NO_SQUARE,
        .halfmove = try parseUnsigned(halfmove_field),
        .fullmove = try parseUnsigned(fullmove_field),
        .king_sq = .{ NO_SQUARE, NO_SQUARE },
    };

    var square: usize = 0;
    var row_squares: usize = 0;
    var separators: u8 = 0;
    for (board_field) |character| {
        if (character == '/') {
            if (row_squares != 8 or separators >= 7) return error.InvalidBoard;
            row_squares = 0;
            separators += 1;
            continue;
        }
        if (character >= '1' and character <= '8') {
            const empty_count = character - '0';
            if (row_squares + empty_count > 8 or square + empty_count > BOARD_SQUARES) {
                return error.InvalidBoard;
            }
            row_squares += empty_count;
            square += empty_count;
            continue;
        }
        const piece = pieceFromFen(character) orelse return error.InvalidPiece;
        if (row_squares >= 8 or square >= BOARD_SQUARES) return error.InvalidBoard;
        position.board[square] = piece;
        if (pieceType(piece).? == .king) {
            const color = pieceColor(piece).?;
            position.king_sq[colorIndex(color)] = @intCast(square);
        }
        row_squares += 1;
        square += 1;
    }
    if (square != BOARD_SQUARES or row_squares != 8 or separators != 7) return error.InvalidBoard;

    if (turn_field.len != 1) return error.InvalidTurn;
    position.turn = switch (turn_field[0]) {
        'w' => .white,
        'b' => .black,
        else => return error.InvalidTurn,
    };

    if (!(castling_field.len == 1 and castling_field[0] == '-')) {
        if (castling_field.len == 0) return error.InvalidCastling;
        for (castling_field) |character| {
            const right: u8 = switch (character) {
                'K' => CASTLE_WHITE_K,
                'Q' => CASTLE_WHITE_Q,
                'k' => CASTLE_BLACK_K,
                'q' => CASTLE_BLACK_Q,
                else => return error.InvalidCastling,
            };
            if (position.castling & right != 0) return error.InvalidCastling;
            position.castling |= right;
        }
    }

    if (!(ep_field.len == 1 and ep_field[0] == '-')) {
        if (ep_field.len != 2 or ep_field[0] < 'a' or ep_field[0] > 'h' or
            ep_field[1] < '1' or ep_field[1] > '8')
        {
            return error.InvalidEnPassant;
        }
        const file = ep_field[0] - 'a';
        const rank = ep_field[1] - '0';
        position.ep = (8 - rank) * 8 + file;
    }
    return position;
}

pub fn initialPosition() Position {
    return parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1") catch unreachable;
}

fn perft(position: *Position, depth: u8) u64 {
    if (depth == 0) return 1;
    var moves: [MAX_MOVES]Move = undefined;
    const count = generateLegal(position, &moves);
    var nodes: u64 = 0;
    for (moves[0..count]) |move| {
        const undo = makeMove(position, move);
        nodes += perft(position, depth - 1);
        unmakeMove(position, move, undo);
    }
    return nodes;
}

test "initial position perft and exact pseudo ordering" {
    const testing = @import("std").testing;
    var position = initialPosition();
    var moves: [MAX_MOVES]Move = undefined;
    const count = generatePseudo(&position, &moves);
    try testing.expectEqual(@as(usize, 20), count);
    // JS scans a8..h1: a2-a3, a2-a4, b2-b3, b2-b4...
    try testing.expectEqual(@as(u8, 48), moveFrom(moves[0]));
    try testing.expectEqual(@as(u8, 40), moveTo(moves[0]));
    try testing.expectEqual(@as(u8, 48), moveFrom(moves[1]));
    try testing.expectEqual(@as(u8, 32), moveTo(moves[1]));
    try testing.expectEqual(@as(u64, 20), perft(&position, 1));
    try testing.expectEqual(@as(u64, 400), perft(&position, 2));
    try testing.expectEqual(@as(u64, 8902), perft(&position, 3));
    try testing.expectEqual(@as(u64, 197281), perft(&position, 4));
}

test "Kiwipete and en-passant perft" {
    const testing = @import("std").testing;
    var kiwipete = try parseFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
    try testing.expectEqual(@as(u64, 48), perft(&kiwipete, 1));
    try testing.expectEqual(@as(u64, 2039), perft(&kiwipete, 2));
    try testing.expectEqual(@as(u64, 97862), perft(&kiwipete, 3));

    var position3 = try parseFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
    try testing.expectEqual(@as(u64, 14), perft(&position3, 1));
    try testing.expectEqual(@as(u64, 191), perft(&position3, 2));
    try testing.expectEqual(@as(u64, 2812), perft(&position3, 3));
    try testing.expectEqual(@as(u64, 43238), perft(&position3, 4));

    var promotions = try parseFen("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8");
    try testing.expectEqual(@as(u64, 44), perft(&promotions, 1));
    try testing.expectEqual(@as(u64, 1486), perft(&promotions, 2));
    try testing.expectEqual(@as(u64, 62379), perft(&promotions, 3));
}

test "make and unmake restore position exactly" {
    const testing = @import("std").testing;
    var position = initialPosition();
    const original = position;
    var moves: [MAX_MOVES]Move = undefined;
    const count = generateLegal(&position, &moves);
    try testing.expect(count != 0);
    for (moves[0..count]) |move| {
        const undo = makeMove(&position, move);
        unmakeMove(&position, move, undo);
        try testing.expectEqualDeep(original, position);
    }
}
