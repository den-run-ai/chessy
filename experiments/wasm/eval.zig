const std = @import("std");
const engine = @import("engine.zig");

// Exact scalar port of the shipped JavaScript evaluation in assets/ai.js.
// Board indices use the same convention: 0 = a8, 63 = h1.

const PHASE_MAX: i32 = 24;
const DOUBLED: i32 = 12;
const ISOLATED: i32 = 12;
const SHIELD: i32 = 8;

const VALUES_MG: [6]i32 = .{ 82, 337, 365, 477, 1025, 0 };
const VALUES_EG: [6]i32 = .{ 94, 281, 297, 512, 936, 0 };
const PHASE: [6]i32 = .{ 0, 1, 1, 2, 4, 0 };
const MOBILITY: [6]i32 = .{ 0, 3, 3, 2, 1, 0 };
const PASSED_MG: [7]i32 = .{ 0, 5, 10, 20, 35, 60, 80 };
const PASSED_EG: [7]i32 = .{ 0, 15, 30, 50, 80, 130, 180 };

// PeSTO midgame piece-square tables, ordered pawn through king.
const PST_MG: [6][64]i16 = .{
    .{
        0,   0,   0,   0,   0,   0,   0,  0,
        98,  134, 61,  95,  68,  126, 34, -11,
        -6,  7,   26,  31,  65,  56,  25, -20,
        -14, 13,  6,   21,  23,  12,  17, -23,
        -27, -2,  -5,  12,  17,  6,   10, -25,
        -26, -4,  -4,  -10, 3,   3,   33, -12,
        -35, -1,  -20, -23, -15, 24,  38, -22,
        0,   0,   0,   0,   0,   0,   0,  0,
    },
    .{
        -167, -89, -34, -49, 61,  -97, -15, -107,
        -73,  -41, 72,  36,  23,  62,  7,   -17,
        -47,  60,  37,  65,  84,  129, 73,  44,
        -9,   17,  19,  53,  37,  69,  18,  22,
        -13,  4,   16,  13,  28,  19,  21,  -8,
        -23,  -9,  12,  10,  19,  17,  25,  -16,
        -29,  -53, -12, -3,  -1,  18,  -14, -19,
        -105, -21, -58, -33, -17, -28, -19, -23,
    },
    .{
        -29, 4,  -82, -37, -25, -42, 7,   -8,
        -26, 16, -18, -13, 30,  59,  18,  -47,
        -16, 37, 43,  40,  35,  50,  37,  -2,
        -4,  5,  19,  50,  37,  37,  7,   -2,
        -6,  13, 13,  26,  34,  12,  10,  4,
        0,   15, 15,  15,  14,  27,  18,  10,
        4,   15, 16,  0,   7,   21,  33,  1,
        -33, -3, -14, -21, -13, -12, -39, -21,
    },
    .{
        32,  42,  32,  51,  63, 9,  31,  43,
        27,  32,  58,  62,  80, 67, 26,  44,
        -5,  19,  26,  36,  17, 45, 61,  16,
        -24, -11, 7,   26,  24, 35, -8,  -20,
        -36, -26, -12, -1,  9,  -7, 6,   -23,
        -45, -25, -16, -17, 3,  0,  -5,  -33,
        -44, -16, -20, -9,  -1, 11, -6,  -71,
        -19, -13, 1,   17,  16, 7,  -37, -26,
    },
    .{
        -28, 0,   29,  12,  59,  44,  43,  45,
        -24, -39, -5,  1,   -16, 57,  28,  54,
        -13, -17, 7,   8,   29,  56,  47,  57,
        -27, -27, -16, -16, -1,  17,  -2,  1,
        -9,  -26, -9,  -10, -2,  -4,  3,   -3,
        -14, 2,   -11, -2,  -5,  2,   14,  5,
        -35, -8,  11,  2,   8,   15,  -3,  1,
        -1,  -18, -9,  10,  -15, -25, -31, -50,
    },
    .{
        -65, 23,  16,  -15, -56, -34, 2,   13,
        29,  -1,  -20, -7,  -8,  -4,  -38, -29,
        -9,  24,  2,   -16, -20, 6,   22,  -22,
        -17, -20, -12, -27, -30, -25, -14, -36,
        -49, -1,  -27, -39, -46, -44, -33, -51,
        -14, -14, -22, -46, -44, -30, -15, -27,
        1,   7,   -8,  -64, -43, -16, 9,   8,
        -15, 36,  12,  -54, 8,   -28, 24,  14,
    },
};

// PeSTO endgame piece-square tables, ordered pawn through king.
const PST_EG: [6][64]i16 = .{
    .{
        0,   0,   0,   0,   0,   0,   0,   0,
        178, 173, 158, 134, 147, 132, 165, 187,
        94,  100, 85,  67,  56,  53,  82,  84,
        32,  24,  13,  5,   -2,  4,   17,  17,
        13,  9,   -3,  -7,  -7,  -8,  3,   -1,
        4,   7,   -6,  1,   0,   -5,  -1,  -8,
        13,  8,   8,   10,  13,  0,   2,   -7,
        0,   0,   0,   0,   0,   0,   0,   0,
    },
    .{
        -58, -38, -13, -28, -31, -27, -63, -99,
        -25, -8,  -25, -2,  -9,  -25, -24, -52,
        -24, -20, 10,  9,   -1,  -9,  -19, -41,
        -17, 3,   22,  22,  22,  11,  8,   -18,
        -18, -6,  16,  25,  16,  17,  4,   -18,
        -23, -3,  -1,  15,  10,  -3,  -20, -22,
        -42, -20, -10, -5,  -2,  -20, -23, -44,
        -29, -51, -23, -15, -22, -18, -50, -64,
    },
    .{
        -14, -21, -11, -8,  -7, -9,  -17, -24,
        -8,  -4,  7,   -12, -3, -13, -4,  -14,
        2,   -8,  0,   -1,  -2, 6,   0,   4,
        -3,  9,   12,  9,   14, 10,  3,   2,
        -6,  3,   13,  19,  7,  10,  -3,  -9,
        -12, -3,  8,   10,  13, 3,   -7,  -15,
        -14, -18, -7,  -1,  4,  -9,  -15, -27,
        -23, -9,  -23, -5,  -9, -16, -5,  -17,
    },
    .{
        13, 10, 18, 15, 12, 12,  8,   5,
        11, 13, 13, 11, -3, 3,   8,   3,
        7,  7,  7,  5,  4,  -3,  -5,  -3,
        4,  3,  13, 1,  2,  1,   -1,  2,
        3,  5,  8,  4,  -5, -6,  -8,  -11,
        -4, 0,  -5, -1, -7, -12, -8,  -16,
        -6, -6, 0,  2,  -9, -9,  -11, -3,
        -9, 2,  3,  -1, -5, -13, 4,   -20,
    },
    .{
        -9,  22,  22,  27,  27,  19,  10,  20,
        -17, 20,  32,  41,  58,  25,  30,  0,
        -20, 6,   9,   49,  47,  35,  19,  9,
        3,   22,  24,  45,  57,  40,  57,  36,
        -18, 28,  19,  47,  31,  34,  39,  23,
        -16, -27, 15,  6,   9,   17,  10,  5,
        -22, -23, -30, -16, -16, -23, -36, -32,
        -33, -28, -22, -43, -5,  -32, -20, -41,
    },
    .{
        -74, -35, -18, -18, -11, 15,  4,   -17,
        -12, 17,  14,  17,  17,  38,  23,  11,
        10,  17,  23,  15,  20,  45,  44,  13,
        -8,  22,  24,  27,  26,  33,  26,  3,
        -18, -4,  21,  24,  27,  23,  9,   -11,
        -19, -3,  11,  21,  23,  16,  7,   -9,
        -27, -11, 4,   13,  14,  4,   -5,  -17,
        -53, -34, -21, -11, -28, -14, -24, -43,
    },
};

const Direction = struct {
    rank: i8,
    file: i8,
};

const DIAGONALS: [4]Direction = .{
    .{ .rank = -1, .file = -1 },
    .{ .rank = -1, .file = 1 },
    .{ .rank = 1, .file = -1 },
    .{ .rank = 1, .file = 1 },
};

const ORTHOGONALS: [4]Direction = .{
    .{ .rank = -1, .file = 0 },
    .{ .rank = 1, .file = 0 },
    .{ .rank = 0, .file = -1 },
    .{ .rank = 0, .file = 1 },
};

const ALL_DIRECTIONS: [8]Direction = .{
    .{ .rank = -1, .file = -1 },
    .{ .rank = -1, .file = 1 },
    .{ .rank = 1, .file = -1 },
    .{ .rank = 1, .file = 1 },
    .{ .rank = -1, .file = 0 },
    .{ .rank = 1, .file = 0 },
    .{ .rank = 0, .file = -1 },
    .{ .rank = 0, .file = 1 },
};

const KNIGHT_JUMPS: [8]Direction = .{
    .{ .rank = -2, .file = -1 },
    .{ .rank = -2, .file = 1 },
    .{ .rank = -1, .file = -2 },
    .{ .rank = -1, .file = 2 },
    .{ .rank = 1, .file = -2 },
    .{ .rank = 1, .file = 2 },
    .{ .rank = 2, .file = -1 },
    .{ .rank = 2, .file = 1 },
};

fn colorIndex(color: engine.Color) usize {
    return @intFromEnum(color);
}

fn typeIndex(piece_type: engine.PieceType) usize {
    return @intFromEnum(piece_type);
}

fn slidingMobility(
    board: *const [64]engine.Piece,
    square: usize,
    color: engine.Color,
    directions: []const Direction,
) i32 {
    const rank: i32 = @intCast(square / 8);
    const file: i32 = @intCast(square % 8);
    var count: i32 = 0;

    for (directions) |direction| {
        const rank_step: i32 = direction.rank;
        const file_step: i32 = direction.file;
        var next_rank = rank + rank_step;
        var next_file = file + file_step;
        while (next_rank >= 0 and next_rank < 8 and next_file >= 0 and next_file < 8) {
            const next_square: usize = @intCast(next_rank * 8 + next_file);
            const occupant = board[next_square];
            if (occupant != .empty) {
                if (engine.pieceColor(occupant).? != color) count += 1;
                break;
            }
            count += 1;
            next_rank += rank_step;
            next_file += file_step;
        }
    }
    return count;
}

// Squares a piece can move to (empty or enemy-occupied). Pawns and kings are
// excluded exactly as in assets/ai.js.
fn mobility(
    board: *const [64]engine.Piece,
    square: usize,
    piece_type: engine.PieceType,
    color: engine.Color,
) i32 {
    if (piece_type == .knight) {
        const rank: i32 = @intCast(square / 8);
        const file: i32 = @intCast(square % 8);
        var count: i32 = 0;
        for (KNIGHT_JUMPS) |jump| {
            const rank_step: i32 = jump.rank;
            const file_step: i32 = jump.file;
            const next_rank = rank + rank_step;
            const next_file = file + file_step;
            if (next_rank < 0 or next_rank >= 8 or next_file < 0 or next_file >= 8) continue;
            const next_square: usize = @intCast(next_rank * 8 + next_file);
            const occupant = board[next_square];
            if (occupant == .empty or engine.pieceColor(occupant).? != color) count += 1;
        }
        return count;
    }

    return switch (piece_type) {
        .bishop => slidingMobility(board, square, color, DIAGONALS[0..]),
        .rook => slidingMobility(board, square, color, ORTHOGONALS[0..]),
        .queen => slidingMobility(board, square, color, ALL_DIRECTIONS[0..]),
        else => 0,
    };
}

fn clampPassedRank(rank: i32) usize {
    return @intCast(@min(@max(rank, 0), 6));
}

fn absDiff(a: i32, b: i32) i32 {
    return if (a >= b) a - b else b - a;
}

// Mating gradient for a lone king hunted by the winner's king.
fn mopUp(loser: i8, winner: i8) i32 {
    const loser_square: i32 = loser;
    const winner_square: i32 = winner;
    const loser_rank = @divTrunc(loser_square, 8);
    const loser_file = @mod(loser_square, 8);
    const winner_rank = @divTrunc(winner_square, 8);
    const winner_file = @mod(winner_square, 8);
    const center_manhattan =
        @max(3 - loser_file, loser_file - 4) +
        @max(3 - loser_rank, loser_rank - 4);
    const king_distance =
        absDiff(loser_rank, winner_rank) +
        absDiff(loser_file, winner_file);
    return 8 * center_manhattan + 2 * (14 - king_distance);
}

// Evaluate from White's point of view (positive = good for White).
pub fn evaluate(position: *const engine.Position) i32 {
    const board = &position.board;
    var midgame: i32 = 0;
    var endgame: i32 = 0;
    var phase: i32 = 0;

    var pawn_files: [2][8]u8 = .{ .{0} ** 8, .{0} ** 8 };
    var pawn_squares: [2][64]u8 = .{ .{0} ** 64, .{0} ** 64 };
    var pawn_counts: [2]usize = .{ 0, 0 };
    var kings: [2]i8 = .{ -1, -1 };
    var force: [2]u8 = .{ 0, 0 };
    var pieces: [2]u8 = .{ 0, 0 };

    for (board, 0..) |piece, square| {
        if (piece == .empty) continue;

        const color = engine.pieceColor(piece).?;
        const piece_type = engine.pieceType(piece).?;
        const color_index = colorIndex(color);
        const piece_index = typeIndex(piece_type);
        const table_square =
            if (color == .white)
                square
            else
                (7 - square / 8) * 8 + square % 8;

        phase += PHASE[piece_index];
        var piece_midgame = VALUES_MG[piece_index] + @as(i32, PST_MG[piece_index][table_square]);
        var piece_endgame = VALUES_EG[piece_index] + @as(i32, PST_EG[piece_index][table_square]);

        if (piece_type != .king) force[color_index] += 1;
        if (piece_type == .pawn) {
            pawn_files[color_index][square % 8] += 1;
            pawn_squares[color_index][pawn_counts[color_index]] = @intCast(square);
            pawn_counts[color_index] += 1;
        } else if (piece_type == .king) {
            kings[color_index] = @intCast(square);
        } else {
            pieces[color_index] += 1;
            const reachable = mobility(board, square, piece_type, color);
            const mobility_score = reachable * MOBILITY[piece_index];
            piece_midgame += mobility_score;
            piece_endgame += mobility_score;
        }

        if (color == .white) {
            midgame += piece_midgame;
            endgame += piece_endgame;
        } else {
            midgame -= piece_midgame;
            endgame -= piece_endgame;
        }
    }

    for ([_]engine.Color{ .white, .black }) |color| {
        const color_index = colorIndex(color);
        const enemy_index = colorIndex(if (color == .white) .black else .white);
        const sign: i32 = if (color == .white) 1 else -1;

        for (0..8) |file| {
            const count = pawn_files[color_index][file];
            if (count > 1) {
                const extra = @as(i32, count - 1) * DOUBLED;
                midgame -= sign * extra;
                endgame -= sign * extra;
            }
        }

        for (pawn_squares[color_index][0..pawn_counts[color_index]]) |square_u8| {
            const square: usize = square_u8;
            const file = square % 8;
            const rank = square / 8;

            const has_left_pawn = file > 0 and pawn_files[color_index][file - 1] != 0;
            const has_right_pawn = file < 7 and pawn_files[color_index][file + 1] != 0;
            if (!has_left_pawn and !has_right_pawn) {
                midgame -= sign * ISOLATED;
                endgame -= sign * ISOLATED;
            }

            var passed = true;
            for (pawn_squares[enemy_index][0..pawn_counts[enemy_index]]) |enemy_square_u8| {
                const enemy_square: usize = enemy_square_u8;
                const enemy_file = enemy_square % 8;
                const enemy_rank = enemy_square / 8;
                const file_distance = if (enemy_file >= file) enemy_file - file else file - enemy_file;
                const is_ahead =
                    if (color == .white)
                        enemy_rank < rank
                    else
                        enemy_rank > rank;
                if (file_distance <= 1 and is_ahead) {
                    passed = false;
                    break;
                }
            }

            if (passed) {
                const rank_i32: i32 = @intCast(rank);
                const relative_rank = clampPassedRank(
                    if (color == .white) 6 - rank_i32 else rank_i32 - 1,
                );
                midgame += sign * PASSED_MG[relative_rank];
                endgame += sign * PASSED_EG[relative_rank];
            }
        }

        // Friendly pawns directly in front of the king, midgame only.
        const king_square = kings[color_index];
        if (king_square >= 0) {
            const king_square_i32: i32 = king_square;
            const forward: i32 = if (color == .white) -1 else 1;
            const king_rank = @divTrunc(king_square_i32, 8) + forward;
            const king_file = @mod(king_square_i32, 8);
            if (king_rank >= 0 and king_rank < 8) {
                var file_delta: i32 = -1;
                while (file_delta <= 1) : (file_delta += 1) {
                    const shield_file = king_file + file_delta;
                    if (shield_file < 0 or shield_file >= 8) continue;
                    const shield_square: usize = @intCast(king_rank * 8 + shield_file);
                    const expected_pawn: engine.Piece =
                        if (color == .white) .white_pawn else .black_pawn;
                    if (board[shield_square] == expected_pawn) midgame += sign * SHIELD;
                }
            }
        }
    }

    const tapered_phase = @min(phase, PHASE_MAX);
    const numerator =
        midgame * tapered_phase +
        endgame * (PHASE_MAX - tapered_phase);
    // JavaScript Math.round(x) is floor(x + 0.5), including negative ties.
    var score = @divFloor(numerator + @divTrunc(PHASE_MAX, 2), PHASE_MAX);

    if (kings[0] >= 0 and kings[1] >= 0) {
        if (pieces[0] > 0 and force[1] == 0) {
            score += mopUp(kings[1], kings[0]);
        } else if (pieces[1] > 0 and force[0] == 0) {
            score -= mopUp(kings[0], kings[1]);
        }
    }

    return score;
}

test "evaluation matches shipped JavaScript reference positions" {
    const cases = [_]struct {
        fen: []const u8,
        score: i32,
    }{
        .{
            .fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            .score = 0,
        },
        .{
            .fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            .score = 57,
        },
        .{
            .fen = "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
            .score = 347,
        },
        .{
            .fen = "8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1",
            .score = -76,
        },
        .{
            .fen = "8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1",
            .score = 0,
        },
        .{
            .fen = "8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1",
            .score = 0,
        },
        .{
            .fen = "8/8/8/8/8/8/3k4/R3K3 w - - 0 1",
            .score = 519,
        },
        .{
            .fen = "8/8/8/8/8/8/4K3/r3k3 b - - 0 1",
            .score = -562,
        },
    };

    for (cases) |case| {
        const position = try engine.parseFen(case.fen);
        try std.testing.expectEqual(case.score, evaluate(&position));
    }
}
