// Chessy play-search hot loop — Zig port for wasm32-freestanding.
//
// This is a REPRODUCTION of the 2026-07-27 Zig/WASM feasibility spike recorded
// on issues #84/#113 (the original spike's source was never pushed). It ports
// assets/engine.js + assets/ai.js exactly — same tree, same counters — so the
// JS engine and this module can be compared move-for-move and node-for-node:
//
//   - compact numeric 64-square mailbox, packed moves, in-place make/unmake
//   - identical pseudo-move GENERATION ORDER (parity depends on it: move
//     ordering uses a stable sort, so ties resolve to generation order)
//   - PeSTO tapered evaluation with JS Math.round taper semantics
//   - dual 32-bit Zobrist keys from the same mulberry32 streams
//   - transposition table with JS Map semantics: keyed by h1 alone (a probe
//     compares h2 and treats a mismatch as a miss without evicting), insert
//     capped at TT_MAX distinct keys, existing keys always overwritten
//   - PVS + aspiration + iterative deepening with the exact root protocol
//     (seeded shuffle, stable score sort, splice/unshift, abort handling)
//   - the exact node-count/abort protocol: budget checked BEFORE counting,
//     deadline polled immediately before entering every 1024th node
//
// Deliberately absent (matching the spike): SIMD, threads, WASI, allocator,
// game repetition-history input, PV output. One coarse boundary: load a FEN,
// run one search, read the result buffer.
//
// ABI (all offsets in wasm linear memory, i32 little-endian):
//   inPtr()  -> pointer to a 256-byte FEN input buffer
//   outPtr() -> pointer to the i32 result buffer (see OUT_* below)
//   reset()  -> forget all cached search state (fresh-context guarantee)
//   search(fenLen, maxDepth, timeMs, nodeLimit, quiesce, hasSeed, seed) -> 0
//   perft(fenLen, depth) -> node count (rules gate)
//   evalFen(fenLen) -> static evaluation, White POV (eval gate)
//   env imports: now_ms() -> f64 (Date.now semantics)

const OUT_STATUS = 0; // 0 = ok, 1 = bad input
const OUT_FROM = 1; // -1 when move is null
const OUT_TO = 2;
const OUT_PROMO = 3; // 0 none, else piece type code
const OUT_SCORE = 4;
const OUT_DEPTH = 5;
const OUT_ATTEMPTED = 6; // -1 when null
const OUT_NODES = 7;
const OUT_QNODES = 8;
const OUT_CUTOFFS = 9;
const OUT_RESEARCHES = 10;
const OUT_STOP = 11; // 0 max-depth 1 time-limit 2 node-limit 3 mate 4 game-over
const OUT_ROOT_N = 12;
const OUT_ROOT0 = 13; // packed root moves, initial order (from<<9|to<<3|promoIdx)

extern "env" fn now_ms() f64;

// ---- piece encoding ----
// 0 = empty; low 3 bits type (P=1 N=2 B=3 R=4 Q=5 K=6); bit 3 = black.
const EMPTY: u8 = 0;
const P: u8 = 1;
const N: u8 = 2;
const B: u8 = 3;
const R: u8 = 4;
const Q: u8 = 5;
const K: u8 = 6;
const BLACK_BIT: u8 = 8;

inline fn typeOf(p: u8) u8 {
    return p & 7;
}
inline fn colorOf(p: u8) u8 {
    return p >> 3; // 0 white, 1 black
}
inline fn mk(t: u8, color: u8) u8 {
    return t | (color << 3);
}

// Ordering material (VALUES in ai.js), indexed by type code.
const ORD_VAL = [7]i32{ 0, 100, 320, 330, 500, 900, 0 };
// Phase material (VALUES_MG / VALUES_EG), indexed by type code.
const VAL_MG = [7]i32{ 0, 82, 337, 365, 477, 1025, 0 };
const VAL_EG = [7]i32{ 0, 94, 281, 297, 512, 936, 0 };
const PHASE_OF = [7]i32{ 0, 0, 1, 1, 2, 4, 0 };
const PHASE_MAX: i32 = 24;
const MOBILITY = [7]i32{ 0, 0, 3, 3, 2, 1, 0 };
const DOUBLED: i32 = 12;
const ISOLATED: i32 = 12;
const SHIELD: i32 = 8;
const PASSED_MG = [7]i32{ 0, 5, 10, 20, 35, 60, 80 };
const PASSED_EG = [7]i32{ 0, 15, 30, 50, 80, 130, 180 };

// PeSTO piece-square tables, copied verbatim from assets/ai.js (see its
// provenance note; index 0 = a8, White perspective). PST[type-1][sq].
const PST_MG = [6][64]i32{
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
        -29, 4,   -82, -37, -25, -42, 7,   -8,
        -26, 16,  -18, -13, 30,  59,  18,  -47,
        -16, 37,  43,  40,  35,  50,  37,  -2,
        -4,  5,   19,  50,  37,  37,  7,   -2,
        -6,  13,  13,  26,  34,  12,  10,  4,
        0,   15,  15,  15,  14,  27,  18,  10,
        4,   15,  16,  0,   7,   21,  33,  1,
        -33, -3,  -14, -21, -13, -12, -39, -21,
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

const PST_EG = [6][64]i32{
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

// ---- search constants (ai.js) ----
const MATE: i32 = 1000000;
const MATE_NEAR: i32 = MATE - 1000;
const QMAX: i32 = 16;
const QCHECK_PLIES: i32 = 1;
const TT_MAX: u32 = 1 << 21;
const INF: i32 = 1 << 30; // stands in for JS Infinity in score space
const INF_PLY: i32 = 1 << 30; // stands in for JS Infinity in repPly space
const MAX_PLY: usize = 64;
const MAX_MOVES: usize = 256;

const AbortError = error{Abort};

// ---- position (module globals; single-threaded module) ----
var board: [64]u8 = @splat(EMPTY);
var turn: u8 = 0; // 0 white, 1 black
var castling: [4]bool = @splat(false); // wK wQ bK bQ
var ep: i32 = -1;
var halfmove: i32 = 0;
var fullmove: i32 = 1;

const Move = struct {
    from: u8 = 0,
    to: u8 = 0,
    piece: u8 = 0,
    captured: u8 = 0, // 0 = none
    promo: u8 = 0, // 0 = none, else type code
    flags: u8 = 0, // 1 ep, 2 castle K, 4 castle Q, 8 double
    order: i32 = 0,
};
const FLAG_EP: u8 = 1;
const FLAG_CK: u8 = 2;
const FLAG_CQ: u8 = 4;
const FLAG_DBL: u8 = 8;

const Undo = struct {
    move: Move,
    castling: [4]bool,
    ep: i32,
    halfmove: i32,
    fullmove: i32,
};

// ---- step tables (exact JS order) ----
const KNIGHT_STEPS = [8][2]i32{ .{ -2, -1 }, .{ -2, 1 }, .{ -1, -2 }, .{ -1, 2 }, .{ 1, -2 }, .{ 1, 2 }, .{ 2, -1 }, .{ 2, 1 } };
const KING_STEPS = [8][2]i32{ .{ -1, -1 }, .{ -1, 0 }, .{ -1, 1 }, .{ 0, -1 }, .{ 0, 1 }, .{ 1, -1 }, .{ 1, 0 }, .{ 1, 1 } };
const BISHOP_DIRS = [4][2]i32{ .{ -1, -1 }, .{ -1, 1 }, .{ 1, -1 }, .{ 1, 1 } };
const ROOK_DIRS = [4][2]i32{ .{ -1, 0 }, .{ 1, 0 }, .{ 0, -1 }, .{ 0, 1 } };

inline fn onBoard(r: i32, c: i32) bool {
    return r >= 0 and r < 8 and c >= 0 and c < 8;
}

fn findKing(color: u8) i32 {
    const target = mk(K, color);
    for (0..64) |i| {
        if (board[i] == target) return @intCast(i);
    }
    return -1;
}

// Is square `i` attacked by side `by`? Exact port of engine.js isAttacked.
fn isAttacked(sq: i32, by: u8) bool {
    const r = @divTrunc(sq, 8);
    const c = @mod(sq, 8);
    const pr = if (by == 0) r + 1 else r - 1;
    const byPawn = mk(P, by);
    if (onBoard(pr, c - 1) and board[@intCast(pr * 8 + c - 1)] == byPawn) return true;
    if (onBoard(pr, c + 1) and board[@intCast(pr * 8 + c + 1)] == byPawn) return true;
    const byN = mk(N, by);
    for (KNIGHT_STEPS) |d| {
        const nr = r + d[0];
        const nc = c + d[1];
        if (onBoard(nr, nc) and board[@intCast(nr * 8 + nc)] == byN) return true;
    }
    const byK = mk(K, by);
    for (KING_STEPS) |d| {
        const nr = r + d[0];
        const nc = c + d[1];
        if (onBoard(nr, nc) and board[@intCast(nr * 8 + nc)] == byK) return true;
    }
    for (BISHOP_DIRS) |d| {
        var nr = r + d[0];
        var nc = c + d[1];
        while (onBoard(nr, nc)) {
            const p = board[@intCast(nr * 8 + nc)];
            if (p != EMPTY) {
                if (colorOf(p) == by and (typeOf(p) == B or typeOf(p) == Q)) return true;
                break;
            }
            nr += d[0];
            nc += d[1];
        }
    }
    for (ROOK_DIRS) |d| {
        var nr = r + d[0];
        var nc = c + d[1];
        while (onBoard(nr, nc)) {
            const p = board[@intCast(nr * 8 + nc)];
            if (p != EMPTY) {
                if (colorOf(p) == by and (typeOf(p) == R or typeOf(p) == Q)) return true;
                break;
            }
            nr += d[0];
            nc += d[1];
        }
    }
    return false;
}

// ---- pseudo-move generation (exact JS order) ----
var moveBuf: [MAX_PLY][MAX_MOVES]Move = undefined;
var qmovesBuf: [MAX_PLY][MAX_MOVES]Move = undefined;

fn pushMove(list: []Move, count: *usize, from: i32, to: i32, promo: u8, flags: u8, capturedOverride: u8) void {
    var m = Move{
        .from = @intCast(from),
        .to = @intCast(to),
        .piece = board[@intCast(from)],
        .captured = board[@intCast(to)],
        .promo = promo,
        .flags = flags,
        .order = 0,
    };
    if (capturedOverride != 0) m.captured = capturedOverride;
    list[count.*] = m;
    count.* += 1;
}

const PROMO_ORDER = [4]u8{ Q, R, B, N }; // JS promo loop order

fn pseudoMoves(list: []Move) usize {
    var count: usize = 0;
    const enemy: u8 = 1 - turn;
    var from: i32 = 0;
    while (from < 64) : (from += 1) {
        const p = board[@intCast(from)];
        if (p == EMPTY or colorOf(p) != turn) continue;
        const r = @divTrunc(from, 8);
        const c = @mod(from, 8);
        const t = typeOf(p);
        if (t == P) {
            const dir: i32 = if (turn == 0) -1 else 1;
            const startRow: i32 = if (turn == 0) 6 else 1;
            const promoRow: i32 = if (turn == 0) 0 else 7;
            if (onBoard(r + dir, c) and board[@intCast((r + dir) * 8 + c)] == EMPTY) {
                const to = (r + dir) * 8 + c;
                if (r + dir == promoRow) {
                    for (PROMO_ORDER) |promo| pushMove(list, &count, from, to, promo, 0, 0);
                } else {
                    pushMove(list, &count, from, to, 0, 0, 0);
                    if (r == startRow and board[@intCast((r + 2 * dir) * 8 + c)] == EMPTY) {
                        pushMove(list, &count, from, (r + 2 * dir) * 8 + c, 0, FLAG_DBL, 0);
                    }
                }
            }
            var dcs = [2]i32{ -1, 1 };
            for (&dcs) |dc| {
                if (!onBoard(r + dir, c + dc)) continue;
                const to = (r + dir) * 8 + c + dc;
                const tp = board[@intCast(to)];
                if (tp != EMPTY and colorOf(tp) == enemy) {
                    if (r + dir == promoRow) {
                        for (PROMO_ORDER) |promo| pushMove(list, &count, from, to, promo, 0, 0);
                    } else {
                        pushMove(list, &count, from, to, 0, 0, 0);
                    }
                } else if (to == ep) {
                    pushMove(list, &count, from, to, 0, FLAG_EP, mk(P, enemy));
                }
            }
        } else if (t == N or t == K) {
            const steps = if (t == N) &KNIGHT_STEPS else &KING_STEPS;
            for (steps) |d| {
                if (!onBoard(r + d[0], c + d[1])) continue;
                const to = (r + d[0]) * 8 + c + d[1];
                const tp = board[@intCast(to)];
                if (tp == EMPTY or colorOf(tp) == enemy) pushMove(list, &count, from, to, 0, 0, 0);
            }
            if (t == K) {
                const home: i32 = if (turn == 0) 56 else 0;
                if (from == home + 4 and !isAttacked(from, enemy)) {
                    const rook = mk(R, turn);
                    if (castling[@intCast(turn * 2)] and
                        board[@intCast(home + 5)] == EMPTY and board[@intCast(home + 6)] == EMPTY and
                        board[@intCast(home + 7)] == rook and
                        !isAttacked(home + 5, enemy) and !isAttacked(home + 6, enemy))
                    {
                        pushMove(list, &count, from, home + 6, 0, FLAG_CK, 0);
                    }
                    if (castling[@intCast(turn * 2 + 1)] and
                        board[@intCast(home + 3)] == EMPTY and board[@intCast(home + 2)] == EMPTY and
                        board[@intCast(home + 1)] == EMPTY and
                        board[@intCast(home)] == rook and
                        !isAttacked(home + 3, enemy) and !isAttacked(home + 2, enemy))
                    {
                        pushMove(list, &count, from, home + 2, 0, FLAG_CQ, 0);
                    }
                }
            }
        } else {
            // B, R, Q sliders; queen uses KING_STEPS order like the JS engine.
            const dirs: []const [2]i32 = if (t == B) &BISHOP_DIRS else if (t == R) &ROOK_DIRS else &KING_STEPS;
            for (dirs) |d| {
                var nr = r + d[0];
                var nc = c + d[1];
                while (onBoard(nr, nc)) {
                    const to = nr * 8 + nc;
                    const tp = board[@intCast(to)];
                    if (tp == EMPTY) {
                        pushMove(list, &count, from, to, 0, 0, 0);
                    } else {
                        if (colorOf(tp) == enemy) pushMove(list, &count, from, to, 0, 0, 0);
                        break;
                    }
                    nr += d[0];
                    nc += d[1];
                }
            }
        }
    }
    return count;
}

// ---- make / unmake (semantics of engine.js applyMove) ----
fn makeMove(m: Move) Undo {
    const u = Undo{
        .move = m,
        .castling = castling,
        .ep = ep,
        .halfmove = halfmove,
        .fullmove = fullmove,
    };
    const mover = turn;
    board[m.to] = if (m.promo != 0) mk(m.promo, mover) else board[m.from];
    board[m.from] = EMPTY;
    if (m.flags & FLAG_EP != 0) {
        const toRow: i32 = @divTrunc(@as(i32, m.to), 8);
        const capRow: i32 = if (mover == 0) toRow + 1 else toRow - 1;
        board[@intCast(capRow * 8 + @mod(@as(i32, m.to), 8))] = EMPTY;
    }
    if (m.flags & (FLAG_CK | FLAG_CQ) != 0) {
        const home: i32 = if (mover == 0) 56 else 0;
        if (m.flags & FLAG_CK != 0) {
            board[@intCast(home + 5)] = board[@intCast(home + 7)];
            board[@intCast(home + 7)] = EMPTY;
        } else {
            board[@intCast(home + 3)] = board[@intCast(home)];
            board[@intCast(home)] = EMPTY;
        }
    }
    if (typeOf(m.piece) == K) {
        castling[@intCast(mover * 2)] = false;
        castling[@intCast(mover * 2 + 1)] = false;
    }
    // Rook moved or was captured on its home square: (56,wQ) (63,wK) (0,bQ) (7,bK).
    if (m.from == 56 or m.to == 56) castling[1] = false;
    if (m.from == 63 or m.to == 63) castling[0] = false;
    if (m.from == 0 or m.to == 0) castling[3] = false;
    if (m.from == 7 or m.to == 7) castling[2] = false;
    ep = if (m.flags & FLAG_DBL != 0) @divTrunc(@as(i32, m.from) + @as(i32, m.to), 2) else -1;
    halfmove = if (typeOf(m.piece) == P or m.captured != 0) 0 else halfmove + 1;
    if (mover == 1) fullmove += 1;
    turn = 1 - mover;
    return u;
}

fn unmakeMove(u: Undo) void {
    const m = u.move;
    turn = 1 - turn;
    const mover = turn;
    castling = u.castling;
    ep = u.ep;
    halfmove = u.halfmove;
    fullmove = u.fullmove;
    board[m.from] = m.piece;
    board[m.to] = EMPTY;
    if (m.flags & FLAG_EP != 0) {
        const toRow: i32 = @divTrunc(@as(i32, m.to), 8);
        const capRow: i32 = if (mover == 0) toRow + 1 else toRow - 1;
        board[@intCast(capRow * 8 + @mod(@as(i32, m.to), 8))] = m.captured;
    } else if (m.captured != 0) {
        board[m.to] = m.captured;
    }
    if (m.flags & (FLAG_CK | FLAG_CQ) != 0) {
        const home: i32 = if (mover == 0) 56 else 0;
        if (m.flags & FLAG_CK != 0) {
            board[@intCast(home + 7)] = board[@intCast(home + 5)];
            board[@intCast(home + 5)] = EMPTY;
        } else {
            board[@intCast(home)] = board[@intCast(home + 3)];
            board[@intCast(home + 3)] = EMPTY;
        }
    }
}

// ---- evaluation (exact port of ai.js evaluate) ----
fn mobilityCount(sq: i32, t: u8, color: u8) i32 {
    const r = @divTrunc(sq, 8);
    const c = @mod(sq, 8);
    var count: i32 = 0;
    if (t == N) {
        for (KNIGHT_STEPS) |d| {
            const nr = r + d[0];
            const nc = c + d[1];
            if (nr < 0 or nr > 7 or nc < 0 or nc > 7) continue;
            const p = board[@intCast(nr * 8 + nc)];
            if (p == EMPTY or colorOf(p) != color) count += 1;
        }
        return count;
    }
    const dirs: []const [2]i32 = if (t == B) &BISHOP_DIRS else if (t == R) &ROOK_DIRS else &KING_STEPS;
    for (dirs) |d| {
        var nr = r + d[0];
        var nc = c + d[1];
        while (nr >= 0 and nr < 8 and nc >= 0 and nc < 8) {
            const p = board[@intCast(nr * 8 + nc)];
            if (p != EMPTY) {
                if (colorOf(p) != color) count += 1;
                break;
            }
            count += 1;
            nr += d[0];
            nc += d[1];
        }
    }
    return count;
}

fn mopUp(loser: i32, winner: i32) i32 {
    const lr = loser >> 3;
    const lf = loser & 7;
    const wr = winner >> 3;
    const wf = winner & 7;
    const cmd = @max(3 - lf, lf - 4) + @max(3 - lr, lr - 4);
    const kd = @abs(lr - wr) + @abs(lf - wf);
    return 8 * cmd + 2 * (14 - @as(i32, @intCast(kd)));
}

fn evaluate() i32 {
    var mg: i32 = 0;
    var eg: i32 = 0;
    var phase: i32 = 0;
    var pawnFiles: [2][8]i32 = .{ @splat(0), @splat(0) };
    var pawnSquares: [2][8 + 2]i32 = undefined; // up to 8 pawns/side (promos leave the type)
    var pawnCount: [2]usize = .{ 0, 0 };
    var kings: [2]i32 = .{ -1, -1 };
    var force: [2]i32 = .{ 0, 0 };
    var pieces: [2]i32 = .{ 0, 0 };

    var i: i32 = 0;
    while (i < 64) : (i += 1) {
        const p = board[@intCast(i)];
        if (p == EMPTY) continue;
        const color = colorOf(p);
        const t = typeOf(p);
        const sq: i32 = if (color == 0) i else (7 - @divTrunc(i, 8)) * 8 + @mod(i, 8);
        phase += PHASE_OF[t];
        var m: i32 = VAL_MG[t] + PST_MG[t - 1][@intCast(sq)];
        var e: i32 = VAL_EG[t] + PST_EG[t - 1][@intCast(sq)];
        if (t != K) force[color] += 1;
        if (t == P) {
            pawnFiles[color][@intCast(@mod(i, 8))] += 1;
            if (pawnCount[color] < pawnSquares[color].len) {
                pawnSquares[color][pawnCount[color]] = i;
                pawnCount[color] += 1;
            }
        } else if (t == K) {
            kings[color] = i;
        } else {
            pieces[color] += 1;
            const mob = mobilityCount(i, t, color) * MOBILITY[t];
            m += mob;
            e += mob;
        }
        if (color == 0) {
            mg += m;
            eg += e;
        } else {
            mg -= m;
            eg -= e;
        }
    }

    for (0..2) |color| {
        const sign: i32 = if (color == 0) 1 else -1;
        const files = &pawnFiles[color];
        const enemyPawns = pawnSquares[1 - color][0..pawnCount[1 - color]];
        for (0..8) |f| {
            if (files[f] > 1) {
                const extra = (files[f] - 1) * DOUBLED;
                mg -= sign * extra;
                eg -= sign * extra;
            }
        }
        for (pawnSquares[color][0..pawnCount[color]]) |sqI| {
            const f = @mod(sqI, 8);
            const r = @divTrunc(sqI, 8);
            const leftBlocked = f > 0 and files[@intCast(f - 1)] != 0;
            const rightBlocked = f < 7 and files[@intCast(f + 1)] != 0;
            if (!leftBlocked and !rightBlocked) {
                mg -= sign * ISOLATED;
                eg -= sign * ISOLATED;
            }
            var passed = true;
            for (enemyPawns) |e2| {
                const ef = @mod(e2, 8);
                const er = @divTrunc(e2, 8);
                const closer = if (color == 0) er < r else er > r;
                if (@abs(ef - f) <= 1 and closer) {
                    passed = false;
                    break;
                }
            }
            if (passed) {
                const adv: i32 = if (color == 0) 6 - r else r - 1;
                const rr: usize = @intCast(@min(@max(adv, 0), 6));
                mg += sign * PASSED_MG[rr];
                eg += sign * PASSED_EG[rr];
            }
        }
        const k = kings[color];
        if (k >= 0) {
            const kr = @divTrunc(k, 8) + (if (color == 0) @as(i32, -1) else 1);
            const kc = @mod(k, 8);
            if (kr >= 0 and kr < 8) {
                var dc: i32 = -1;
                while (dc <= 1) : (dc += 1) {
                    const cc = kc + dc;
                    if (cc >= 0 and cc < 8 and board[@intCast(kr * 8 + cc)] == mk(P, @intCast(color))) {
                        mg += sign * SHIELD;
                    }
                }
            }
        }
    }

    const ph = @min(phase, PHASE_MAX);
    // JS: Math.round((mg*ph + eg*(24-ph)) / 24) — round half toward +infinity.
    const num = mg * ph + eg * (PHASE_MAX - ph);
    var score: i32 = @divFloor(2 * num + PHASE_MAX, 2 * PHASE_MAX);

    if (kings[0] >= 0 and kings[1] >= 0) {
        if (pieces[0] > 0 and force[1] == 0) {
            score += mopUp(kings[1], kings[0]);
        } else if (pieces[1] > 0 and force[0] == 0) {
            score -= mopUp(kings[0], kings[1]);
        }
    }
    return score;
}

// canMate / insufficientMaterial: exact ports.
fn insufficientMaterial() bool {
    var minorTypes: [10]u8 = undefined;
    var minorShades: [10]i32 = undefined;
    var minors: usize = 0;
    var i: i32 = 0;
    while (i < 64) : (i += 1) {
        const p = board[@intCast(i)];
        if (p == EMPTY or typeOf(p) == K) continue;
        const t = typeOf(p);
        if (t == B or t == N) {
            if (minors < minorTypes.len) {
                minorTypes[minors] = t;
                minorShades[minors] = @mod(@divTrunc(i, 8) + @mod(i, 8), 2);
                minors += 1;
            } else {
                return false; // more than 10 minors: certainly not insufficient
            }
            continue;
        }
        return false;
    }
    if (minors <= 1) return true;
    for (0..minors) |j| {
        if (minorTypes[j] != B or minorShades[j] != minorShades[0]) return false;
    }
    return true;
}

fn canMate(color: u8) bool {
    var ownMinors: i32 = 0;
    var ownKnight = false;
    var ownBishop = false;
    var pawnOrKnight = false;
    var oppBlocker = false;
    var bishopShades: i32 = 0;
    var i: i32 = 0;
    while (i < 64) : (i += 1) {
        const p = board[@intCast(i)];
        if (p == EMPTY or typeOf(p) == K) continue;
        const own = colorOf(p) == color;
        const t = typeOf(p);
        if (own and (t == P or t == R or t == Q)) return true;
        if (t == P or t == N) pawnOrKnight = true;
        if (t == B) bishopShades |= @as(i32, 1) << @intCast(@mod(@divTrunc(i, 8) + @mod(i, 8), 2));
        if (own) {
            ownMinors += 1;
            if (t == N) ownKnight = true;
            if (t == B) ownBishop = true;
        } else if (t != Q) {
            oppBlocker = true;
        }
    }
    if (ownKnight) return ownMinors >= 2 or oppBlocker;
    if (ownBishop) return bishopShades == 3 or pawnOrKnight;
    return false;
}

// ---- Zobrist hashing (exact ai.js port) ----
const Z_TURN: usize = 768;
const Z_CASTLE: usize = 769;
const Z_EP: usize = 773;
const Z_SIZE: usize = 781;

var Z1: [Z_SIZE]u32 = undefined;
var Z2: [Z_SIZE]u32 = undefined;
var zobristReady = false;

fn mulberry32Next(state: *u32) u32 {
    state.* = state.* +% 0x6D2B79F5;
    var t: u32 = (state.* ^ (state.* >> 15)) *% (state.* | 1);
    t = (t +% ((t ^ (t >> 7)) *% (t | 61))) ^ t;
    return t ^ (t >> 14);
}

fn initZobrist() void {
    if (zobristReady) return;
    var s1: u32 = 0x9E3779B9;
    var s2: u32 = 0x85EBCA6B;
    for (0..Z_SIZE) |i| Z1[i] = mulberry32Next(&s1);
    for (0..Z_SIZE) |i| Z2[i] = mulberry32Next(&s2);
    zobristReady = true;
}

// piece index for hashing: wP..wK = 0..5, bP..bK = 6..11.
inline fn pieceIdx(p: u8) usize {
    return @as(usize, typeOf(p) - 1) + @as(usize, colorOf(p)) * 6;
}

var H1: u32 = 0;
var H2: u32 = 0;
var R1v: u32 = 0;
var R2v: u32 = 0;

fn epLegalCapture() bool {
    const e = ep;
    const enemy: u8 = 1 - turn;
    const r = @divTrunc(e, 8);
    const c = @mod(e, 8);
    const fromRow: i32 = if (turn == 0) r + 1 else r - 1;
    if (fromRow < 0 or fromRow > 7) return false;
    const kingSq = findKing(turn);
    var dcs = [2]i32{ -1, 1 };
    for (&dcs) |dc| {
        const fc = c + dc;
        if (fc < 0 or fc > 7) continue;
        const from = fromRow * 8 + fc;
        if (board[@intCast(from)] != mk(P, turn)) continue;
        const m = Move{
            .from = @intCast(from),
            .to = @intCast(e),
            .piece = mk(P, turn),
            .captured = mk(P, enemy),
            .promo = 0,
            .flags = FLAG_EP,
        };
        const u = makeMove(m);
        const attacked = isAttacked(kingSq, enemy);
        unmakeMove(u);
        if (!attacked) return true;
    }
    return false;
}

fn hashState() void {
    var h1: u32 = 0;
    var h2: u32 = 0;
    for (0..64) |i| {
        const p = board[i];
        if (p == EMPTY) continue;
        const z = pieceIdx(p) * 64 + i;
        h1 ^= Z1[z];
        h2 ^= Z2[z];
    }
    if (turn == 0) {
        h1 ^= Z1[Z_TURN];
        h2 ^= Z2[Z_TURN];
    }
    if (castling[0]) {
        h1 ^= Z1[Z_CASTLE];
        h2 ^= Z2[Z_CASTLE];
    }
    if (castling[1]) {
        h1 ^= Z1[Z_CASTLE + 1];
        h2 ^= Z2[Z_CASTLE + 1];
    }
    if (castling[2]) {
        h1 ^= Z1[Z_CASTLE + 2];
        h2 ^= Z2[Z_CASTLE + 2];
    }
    if (castling[3]) {
        h1 ^= Z1[Z_CASTLE + 3];
        h2 ^= Z2[Z_CASTLE + 3];
    }
    if (ep >= 0) {
        const z = Z_EP + @as(usize, @intCast(@mod(ep, 8)));
        H1 = h1 ^ Z1[z];
        H2 = h2 ^ Z2[z];
        if (epLegalCapture()) {
            h1 ^= Z1[z];
            h2 ^= Z2[z];
        }
    } else {
        H1 = h1;
        H2 = h2;
    }
    R1v = h1;
    R2v = h2;
}

// ---- transposition table (JS Map semantics, fixed memory) ----
const EXACT: u32 = 0;
const LOWER: u32 = 1;
const UPPER: u32 = 2;
const TT_CAP: u32 = TT_MAX; // capacity == the JS entry cap
const TT_MASK: u32 = TT_CAP - 1;

var ttK1: [TT_CAP]u32 = undefined;
var ttK2: [TT_CAP]u32 = undefined;
var ttScoreA: [TT_CAP]i32 = undefined;
var ttMeta: [TT_CAP]u32 = undefined; // move(16) | depth(8)<<16 | flag(2)<<24
var ttUsed: [TT_CAP / 8]u8 = @splat(0);
var ttSize: u32 = 0;

inline fn ttIsUsed(idx: u32) bool {
    return (ttUsed[idx >> 3] >> @intCast(idx & 7)) & 1 != 0;
}
inline fn ttMarkUsed(idx: u32) void {
    ttUsed[idx >> 3] |= @as(u8, 1) << @intCast(idx & 7);
}

fn ttReset() void {
    @memset(&ttUsed, 0);
    ttSize = 0;
}

// Find the slot holding key h1, or null. (Linear probing; a full-table scan
// is bounded by TT_CAP but the table never saturates in these workloads.)
fn ttFind(h1: u32) ?u32 {
    var idx = h1 & TT_MASK;
    var probes: u32 = 0;
    while (probes < TT_CAP) : (probes += 1) {
        if (!ttIsUsed(idx)) return null;
        if (ttK1[idx] == h1) return idx;
        idx = (idx + 1) & TT_MASK;
    }
    return null;
}

fn ttStore(h1: u32, h2: u32, depth: i32, ply: i32, scoreIn: i32, flag: u32, movePk: u32) void {
    var score = scoreIn;
    if (score > MATE_NEAR) {
        score += ply;
    } else if (score < -MATE_NEAR) {
        score -= ply;
    }
    // JS: if (tt.size >= TT_MAX && !tt.has(h1)) return; tt.set(h1, entry)
    var idx = h1 & TT_MASK;
    var probes: u32 = 0;
    while (probes < TT_CAP) : (probes += 1) {
        if (!ttIsUsed(idx)) {
            if (ttSize >= TT_MAX) return; // cap reached, new key: drop
            ttMarkUsed(idx);
            ttSize += 1;
            ttK1[idx] = h1;
            ttK2[idx] = h2;
            ttScoreA[idx] = score;
            ttMeta[idx] = movePk | (@as(u32, @intCast(depth)) << 16) | (flag << 24);
            return;
        }
        if (ttK1[idx] == h1) {
            ttK2[idx] = h2;
            ttScoreA[idx] = score;
            ttMeta[idx] = movePk | (@as(u32, @intCast(depth)) << 16) | (flag << 24);
            return;
        }
        idx = (idx + 1) & TT_MASK;
    }
}

// ---- search context ----
var ctxQuiesce = false;
var ctxDeadline: f64 = 0;
var ctxHasDeadline = false;
var ctxNodeLimit: i64 = 0;
var ctxHasNodeLimit = false;
var ctxAbortReason: i32 = -1; // 1 time-limit, 2 node-limit (result codes)
var ctxNodes: i64 = 0;
var ctxQnodes: i64 = 0;
var ctxCutoffs: i64 = 0;
var ctxResearches: i64 = 0;
var killers: [MAX_PLY][2]u32 = undefined;
var histW: [4096]i32 = undefined;
var histB: [4096]i32 = undefined;
var path1: [MAX_PLY + 8]u32 = undefined;
var path2: [MAX_PLY + 8]u32 = undefined;
var pathLen: usize = 0;
var rootRep1: u32 = 0;
var rootRep2: u32 = 0;
var rootRepCount: i32 = 0;
var repPlyOut: i32 = INF_PLY;
var repDrawOut = false;
var repPlyFound: i32 = INF_PLY;

fn ctxReset(quiesce: bool, hasDeadline: bool, deadline: f64, hasNodeLimit: bool, nodeLimit: i64) void {
    ctxQuiesce = quiesce;
    ctxHasDeadline = hasDeadline;
    ctxDeadline = deadline;
    ctxHasNodeLimit = hasNodeLimit;
    ctxNodeLimit = nodeLimit;
    ctxAbortReason = -1;
    ctxNodes = 0;
    ctxQnodes = 0;
    ctxCutoffs = 0;
    ctxResearches = 0;
    for (0..MAX_PLY) |i| {
        killers[i][0] = 0;
        killers[i][1] = 0;
    }
    @memset(&histW, 0);
    @memset(&histB, 0);
    pathLen = 0;
    rootRepCount = 0;
    ttReset();
}

fn checkRep(r1: u32, r2: u32) void {
    var j: i32 = @as(i32, @intCast(pathLen)) - 1;
    while (j >= 0) : (j -= 1) {
        if (path1[@intCast(j)] == r1 and path2[@intCast(j)] == r2) {
            repDrawOut = true;
            repPlyFound = j;
            return;
        }
    }
    if (rootRepCount >= 2 and r1 == rootRep1 and r2 == rootRep2) {
        repDrawOut = true;
        repPlyFound = INF_PLY;
        return;
    }
    repDrawOut = false;
    repPlyFound = INF_PLY;
}

fn checkTime() AbortError!void {
    if (ctxHasNodeLimit and ctxNodes >= ctxNodeLimit) {
        ctxAbortReason = 2; // node-limit
        return error.Abort;
    }
    const nextNode = ctxNodes + 1;
    if ((nextNode & 1023) == 0 and ctxHasDeadline and now_ms() >= ctxDeadline) {
        ctxAbortReason = 1; // time-limit
        return error.Abort;
    }
    ctxNodes = nextNode;
}

inline fn packMove(m: Move) u32 {
    const promoIdx: u32 = switch (m.promo) {
        Q => 1,
        R => 2,
        B => 3,
        N => 4,
        else => 0,
    };
    return (@as(u32, m.from) << 9) | (@as(u32, m.to) << 3) | promoIdx;
}

// Stable descending sort by .order (JS Array#sort with b.order - a.order is
// stable; ties keep generation order). Binary insertion keeps it O(n log n)
// comparisons; shifts are memmoves of 16-byte structs.
fn sortByOrderDesc(list: []Move) void {
    var i: usize = 1;
    while (i < list.len) : (i += 1) {
        const x = list[i];
        // find first index in [0, i) with order < x.order (strictly), keeping
        // equal-order elements before x (stability).
        var lo: usize = 0;
        var hi: usize = i;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            if (list[mid].order < x.order) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        var j: usize = i;
        while (j > lo) : (j -= 1) list[j] = list[j - 1];
        list[lo] = x;
    }
}

fn orderMoves(list: []Move, ttPk: u32, ply: usize, moverTurn: u8) void {
    const hist = if (moverTurn == 0) &histW else &histB;
    for (list) |*m| {
        const pk = packMove(m.*);
        var s: i32 = undefined;
        if (pk == ttPk) {
            s = 2_000_000_000;
        } else if (m.promo != 0) {
            s = 1_000_000_000 + ORD_VAL[m.promo];
        } else if (m.captured != 0) {
            s = 100_000_000 + 10 * ORD_VAL[typeOf(m.captured)] - ORD_VAL[typeOf(m.piece)];
        } else if (pk == killers[ply][0]) {
            s = 10_000_000;
        } else if (pk == killers[ply][1]) {
            s = 10_000_000 - 1;
        } else {
            s = hist[@as(usize, m.from) * 64 + m.to];
        }
        m.order = s;
    }
    sortByOrderDesc(list);
}

fn recordQuietCutoff(m: Move, ply: usize, depth: i32, moverTurn: u8) void {
    const pk = packMove(m);
    if (killers[ply][0] != pk) {
        killers[ply][1] = killers[ply][0];
        killers[ply][0] = pk;
    }
    const hist = if (moverTurn == 0) &histW else &histB;
    hist[@as(usize, m.from) * 64 + m.to] += depth * depth;
}

// Does the side to move have at least one legal move? (ai.js hasLegalMove)
fn hasLegalMove(pseudo: []Move, kingSq: i32, enemy: u8) bool {
    for (pseudo) |m| {
        const u = makeMove(m);
        const ks: i32 = if (typeOf(m.piece) == K) m.to else kingSq;
        const ok = !isAttacked(ks, enemy);
        unmakeMove(u);
        if (ok) return true;
    }
    return false;
}

fn quiesceNode(alphaIn: i32, betaIn: i32, ply: usize, qply: i32) AbortError!i32 {
    var alpha = alphaIn;
    var beta = betaIn;
    try checkTime();
    ctxQnodes += 1;
    repPlyOut = INF_PLY;
    if (insufficientMaterial()) return 0;
    const moverTurn = turn;
    const enemy: u8 = 1 - moverTurn;
    const kingSq = findKing(moverTurn);
    const maximizing = moverTurn == 0;
    const inChk = isAttacked(kingSq, enemy);

    var rr1: u32 = 0;
    var rr2: u32 = 0;
    const trackRep = halfmove >= 4;
    if (trackRep) {
        hashState();
        rr1 = R1v;
        rr2 = R2v;
        checkRep(rr1, rr2);
        if (repDrawOut) {
            repPlyOut = repPlyFound;
            return 0;
        }
    }

    const pseudoAll = &moveBuf[ply];
    const pseudoN = pseudoMoves(pseudoAll);
    const pseudo = pseudoAll[0..pseudoN];
    if (!hasLegalMove(pseudo, kingSq, enemy)) {
        if (inChk) {
            return if (maximizing) -(MATE - @as(i32, @intCast(ply))) else (MATE - @as(i32, @intCast(ply)));
        }
        return 0;
    }
    if (halfmove >= 100) return 0;
    if (qply >= QMAX) return evaluate();

    var best: i32 = undefined;
    if (inChk) {
        best = if (maximizing) -INF else INF;
    } else {
        best = evaluate();
        if (maximizing) {
            if (best >= beta) return best;
            if (best > alpha) alpha = best;
        } else {
            if (best <= alpha) return best;
            if (best < beta) beta = best;
        }
    }

    if (trackRep) {
        path1[pathLen] = rr1;
        path2[pathLen] = rr2;
        pathLen += 1;
    }
    var repMin: i32 = INF_PLY;

    var movesSlice: []Move = undefined;
    if (inChk) {
        movesSlice = pseudo;
    } else {
        const qm = &qmovesBuf[ply];
        var qn: usize = 0;
        const genChecks = qply < QCHECK_PLIES;
        for (pseudo) |m| {
            if (m.captured != 0 or m.promo != 0) {
                qm[qn] = m;
                qn += 1;
                continue;
            }
            if (!genChecks) continue;
            const u = makeMove(m);
            const enemyKing = findKing(enemy);
            const gives = isAttacked(enemyKing, moverTurn);
            unmakeMove(u);
            if (gives) {
                qm[qn] = m;
                qn += 1;
            }
        }
        movesSlice = qm[0..qn];
    }

    orderMoves(movesSlice, 0, ply, moverTurn);
    var abortErr: ?AbortError = null;
    for (movesSlice) |m| {
        const u = makeMove(m);
        const ks: i32 = if (typeOf(m.piece) == K) m.to else kingSq;
        if (isAttacked(ks, enemy)) {
            unmakeMove(u);
            continue;
        }
        const scoreRes = quiesceNode(alpha, beta, ply + 1, qply + 1);
        unmakeMove(u);
        const score = scoreRes catch |e| {
            abortErr = e;
            break;
        };
        if (repPlyOut < repMin) repMin = repPlyOut;
        if (maximizing) {
            if (score > best) best = score;
            if (best > alpha) alpha = best;
        } else {
            if (score < best) best = score;
            if (best < beta) beta = best;
        }
        if (beta <= alpha) break;
    }
    if (abortErr) |e| return e; // path stays un-popped, matching the JS throw
    if (trackRep) pathLen -= 1;
    repPlyOut = repMin;
    return best;
}

fn searchNode(depth: i32, alphaIn: i32, betaIn: i32, ply: usize) AbortError!i32 {
    var alpha = alphaIn;
    var beta = betaIn;
    try checkTime();
    repPlyOut = INF_PLY;
    const moverTurn = turn;
    const enemy: u8 = 1 - moverTurn;
    const kingSq = findKing(moverTurn);
    const maximizing = moverTurn == 0;
    const inChk = isAttacked(kingSq, enemy);
    const fifty = halfmove >= 100;
    if (fifty and !inChk) return 0;
    if (insufficientMaterial()) return 0;

    hashState();
    const h1 = H1;
    const h2 = H2;
    const r1 = R1v;
    const r2 = R2v;

    checkRep(r1, r2);
    if (repDrawOut) {
        repPlyOut = repPlyFound;
        return 0;
    }

    if (depth <= 0) {
        if (ctxQuiesce) return quiesceNode(alpha, beta, ply, 0);
        const pseudoAll = &moveBuf[ply];
        const pn = pseudoMoves(pseudoAll);
        if (!hasLegalMove(pseudoAll[0..pn], kingSq, enemy)) {
            return if (inChk)
                (if (maximizing) -(MATE - @as(i32, @intCast(ply))) else (MATE - @as(i32, @intCast(ply))))
            else
                0;
        }
        if (fifty) return 0;
        return evaluate();
    }

    const useTT = halfmove + depth + (if (ctxQuiesce) QMAX else 0) < 100;
    var ttPk: u32 = 0;
    if (useTT) {
        if (ttFind(h1)) |idx| {
            if (ttK2[idx] == h2) {
                const meta = ttMeta[idx];
                ttPk = meta & 0xFFFF;
                const entryDepth: i32 = @intCast((meta >> 16) & 0xFF);
                if (entryDepth == depth) {
                    var s = ttScoreA[idx];
                    if (s > MATE_NEAR) {
                        s -= @intCast(ply);
                    } else if (s < -MATE_NEAR) {
                        s += @intCast(ply);
                    }
                    const flag = (meta >> 24) & 3;
                    if (flag == EXACT) return s;
                    if (flag == LOWER) {
                        if (s >= beta) {
                            ctxCutoffs += 1;
                            return s;
                        }
                        if (s > alpha) alpha = s;
                    } else {
                        if (s <= alpha) {
                            ctxCutoffs += 1;
                            return s;
                        }
                        if (s < beta) beta = s;
                    }
                    if (alpha >= beta) {
                        ctxCutoffs += 1;
                        return s;
                    }
                }
            }
        }
    }

    const alphaOrig = alpha;
    const betaOrig = beta;
    var best: i32 = if (maximizing) -INF else INF;
    var bestPk: u32 = 0;
    var anyLegal = false;
    var repMin: i32 = INF_PLY;

    path1[pathLen] = r1;
    path2[pathLen] = r2;
    pathLen += 1;

    const pseudoAll = &moveBuf[ply];
    const pn = pseudoMoves(pseudoAll);
    const list = pseudoAll[0..pn];
    orderMoves(list, ttPk, ply, moverTurn);

    var abortErr: ?AbortError = null;
    for (list) |m| {
        const u = makeMove(m);
        const ks: i32 = if (typeOf(m.piece) == K) m.to else kingSq;
        if (isAttacked(ks, enemy)) {
            unmakeMove(u);
            continue;
        }
        var score: i32 = undefined;
        var childRep: i32 = undefined;
        var failed: ?AbortError = null;
        if (!anyLegal) {
            if (searchNode(depth - 1, alpha, beta, ply + 1)) |s| {
                score = s;
                childRep = repPlyOut;
            } else |e| failed = e;
        } else if (maximizing) {
            if (searchNode(depth - 1, alpha, alpha + 1, ply + 1)) |s| {
                score = s;
                childRep = repPlyOut;
                if (s > alpha and s < beta) {
                    ctxResearches += 1;
                    if (searchNode(depth - 1, alpha, beta, ply + 1)) |s2| {
                        score = s2;
                        if (repPlyOut < childRep) childRep = repPlyOut;
                    } else |e| failed = e;
                }
            } else |e| failed = e;
        } else {
            if (searchNode(depth - 1, beta - 1, beta, ply + 1)) |s| {
                score = s;
                childRep = repPlyOut;
                if (s < beta and s > alpha) {
                    ctxResearches += 1;
                    if (searchNode(depth - 1, alpha, beta, ply + 1)) |s2| {
                        score = s2;
                        if (repPlyOut < childRep) childRep = repPlyOut;
                    } else |e| failed = e;
                }
            } else |e| failed = e;
        }
        unmakeMove(u);
        if (failed) |e| {
            abortErr = e;
            break;
        }
        anyLegal = true;
        if (childRep < repMin) repMin = childRep;
        if (if (maximizing) score > best else score < best) {
            best = score;
            bestPk = packMove(m);
        }
        if (maximizing) {
            if (best > alpha) alpha = best;
        } else {
            if (best < beta) beta = best;
        }
        if (beta <= alpha) {
            ctxCutoffs += 1;
            if (m.captured == 0 and m.promo == 0) recordQuietCutoff(m, ply, depth, moverTurn);
            break;
        }
    }
    if (abortErr) |e| return e; // path stays un-popped, matching the JS throw
    pathLen -= 1;
    repPlyOut = repMin;

    if (!anyLegal) {
        if (inChk) {
            return if (maximizing) -(MATE - @as(i32, @intCast(ply))) else (MATE - @as(i32, @intCast(ply)));
        }
        return 0;
    }
    if (fifty) return 0;

    if (useTT and repMin >= @as(i32, @intCast(ply))) {
        const flag: u32 = if (best <= alphaOrig) UPPER else if (best >= betaOrig) LOWER else EXACT;
        ttStore(h1, h2, depth, @intCast(ply), best, flag, bestPk);
    }
    return best;
}

// ---- FEN parsing ----
var IN_BUF: [256]u8 = undefined;
var OUT_BUF: [300]i32 = undefined;

fn parseFen(len: usize) bool {
    initZobrist();
    @memset(&board, EMPTY);
    turn = 0;
    castling = @splat(false);
    ep = -1;
    halfmove = 0;
    fullmove = 1;
    const fen = IN_BUF[0..len];
    var pos: usize = 0;
    // skip leading whitespace
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    var sq: usize = 0;
    while (pos < fen.len and fen[pos] != ' ') : (pos += 1) {
        const ch = fen[pos];
        if (ch == '/') continue;
        if (ch >= '1' and ch <= '8') {
            sq += @intCast(ch - '0');
            continue;
        }
        if (sq >= 64) return false;
        const color: u8 = if (ch >= 'a' and ch <= 'z') 1 else 0;
        const up = if (color == 1) ch - 32 else ch;
        const t: u8 = switch (up) {
            'P' => P,
            'N' => N,
            'B' => B,
            'R' => R,
            'Q' => Q,
            'K' => K,
            else => return false,
        };
        board[sq] = mk(t, color);
        sq += 1;
    }
    // turn
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    if (pos < fen.len and fen[pos] != ' ') {
        turn = if (fen[pos] == 'b') 1 else 0;
        pos += 1;
    }
    // castling
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    while (pos < fen.len and fen[pos] != ' ') : (pos += 1) {
        switch (fen[pos]) {
            'K' => castling[0] = true,
            'Q' => castling[1] = true,
            'k' => castling[2] = true,
            'q' => castling[3] = true,
            else => {},
        }
    }
    // en passant
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    if (pos < fen.len and fen[pos] != ' ') {
        if (fen[pos] == '-') {
            pos += 1;
        } else if (pos + 1 < fen.len) {
            const file = fen[pos] - 'a';
            const rank = fen[pos + 1] - '0';
            if (file < 8 and rank >= 1 and rank <= 8) {
                ep = @as(i32, file) + (8 - @as(i32, rank)) * 8;
            }
            pos += 2;
        }
    }
    // halfmove
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    var hv: i32 = 0;
    var sawDigit = false;
    while (pos < fen.len and fen[pos] >= '0' and fen[pos] <= '9') : (pos += 1) {
        hv = hv * 10 + @as(i32, fen[pos] - '0');
        sawDigit = true;
    }
    if (sawDigit) halfmove = hv;
    // fullmove
    while (pos < fen.len and fen[pos] == ' ') pos += 1;
    var fv: i32 = 0;
    sawDigit = false;
    while (pos < fen.len and fen[pos] >= '0' and fen[pos] <= '9') : (pos += 1) {
        fv = fv * 10 + @as(i32, fen[pos] - '0');
        sawDigit = true;
    }
    if (sawDigit) fullmove = fv;
    return true;
}

// ---- root search (think) ----
const RootItem = struct {
    move: Move,
    initialIndex: i32,
    score: i32,
};
var rootItems: [MAX_MOVES]RootItem = undefined;
var rootMoves: [MAX_MOVES]Move = undefined;

fn shuffleMoves(list: []Move, randState: *u32) void {
    var i: usize = list.len;
    while (i > 1) {
        i -= 1;
        const r = mulberry32Next(randState);
        // JS: Math.floor((r / 2^32) * (i + 1)) — exact as (r * (i+1)) >> 32.
        const j: usize = @intCast((@as(u64, r) * @as(u64, i + 1)) >> 32);
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
    }
}

export fn search(fenLen: u32, maxDepthIn: i32, timeMs: f64, nodeLimitIn: i32, quiesce: i32, hasSeed: i32, seed: i32) i32 {
    if (!parseFen(fenLen)) {
        OUT_BUF[OUT_STATUS] = 1;
        return 1;
    }
    const startedAt = now_ms();
    // JS: Math.max(1, opts.maxDepth || 3). Clamped to the fixed per-ply
    // buffers (44 + QMAX quiescence plies < MAX_PLY); production uses <= 30.
    const maxDepth: i32 = @min(44, @max(1, if (maxDepthIn != 0) maxDepthIn else 3));
    const hasDeadline = timeMs > 0; // JS falsy: timeMs 0 means no deadline
    const deadline: f64 = if (hasDeadline) startedAt + timeMs else 0;
    const hasNodeLimit = nodeLimitIn >= 0; // negative = null (unbounded)
    ctxReset(quiesce != 0, hasDeadline, deadline, hasNodeLimit, nodeLimitIn);

    var out = &OUT_BUF;
    out[OUT_STATUS] = 0;
    out[OUT_FROM] = -1;
    out[OUT_TO] = -1;
    out[OUT_PROMO] = 0;
    out[OUT_SCORE] = 0;
    out[OUT_DEPTH] = 0;
    out[OUT_ATTEMPTED] = -1;
    out[OUT_STOP] = 4; // game-over until proven otherwise
    out[OUT_ROOT_N] = 0;

    const moverTurn = turn;
    const enemy: u8 = 1 - moverTurn;
    const maximizing = moverTurn == 0;
    const kingSq = findKing(moverTurn);

    // Legal root moves (Chess.legalMoves order: generation order, filtered).
    var pseudoRoot: [MAX_MOVES]Move = undefined;
    const pn = pseudoMoves(&pseudoRoot);
    var nLegal: usize = 0;
    for (pseudoRoot[0..pn]) |m| {
        const u = makeMove(m);
        const ks: i32 = if (typeOf(m.piece) == K) m.to else kingSq;
        const ok = !isAttacked(ks, enemy);
        unmakeMove(u);
        if (ok) {
            rootMoves[nLegal] = m;
            nLegal += 1;
        }
    }

    // Root game-over statuses (mate/stalemate/fifty/dead position; no
    // repetition table input in this ABI, matching the spike).
    const over = nLegal == 0 or halfmove >= 100 or insufficientMaterial();
    if (over) {
        finishOutput(0, 0, null, -1, 4); // stopReason: game-over
        return 0;
    }

    // Root variety: seeded (reproducible) or none (randomize:false).
    var randState: u32 = @bitCast(seed);
    const useRand = hasSeed != 0;
    const rootSlice = rootMoves[0..nLegal];
    if (useRand) shuffleMoves(rootSlice, &randState);

    hashState();
    rootRep1 = R1v;
    rootRep2 = R2v;
    rootRepCount = 1; // JS: gameCounts.set(rootRep, 1) when absent
    path1[0] = R1v;
    path2[0] = R2v;
    pathLen = 1;

    orderMoves(rootSlice, 0, 0, moverTurn);
    for (rootSlice, 0..) |m, i| {
        rootItems[i] = .{ .move = m, .initialIndex = @intCast(i), .score = 0 };
    }
    const items = rootItems[0..nLegal];

    var bestIdx: i32 = -1; // index into items (current order)
    var bestScore: i32 = 0;
    var completed: i32 = 0;
    var stopReason: i32 = 0; // max-depth
    var attemptedDepth: i32 = -1;

    var d: i32 = 1;
    outer: while (d <= maxDepth) : (d += 1) {
        var delta: i32 = 50;
        var lo: i32 = -INF;
        var hi: i32 = INF;
        if (d >= 2 and (if (bestScore < 0) -bestScore else bestScore) < MATE_NEAR) {
            lo = bestScore - delta;
            hi = bestScore + delta;
        }
        var iterBest: i32 = -1;
        var iterScore: i32 = 0;
        var aborted = false;
        while (true) { // aspiration attempts
            var alpha = lo;
            var beta = hi;
            iterBest = -1;
            iterScore = if (maximizing) -INF else INF;
            for (items, 0..) |*it, idx| {
                var score: i32 = undefined;
                var failed = false;
                // (repDraw is always false without a repetition table input.)
                const u = makeMove(it.move);
                if (iterBest == -1) {
                    if (searchNode(d - 1, alpha, beta, 1)) |s| {
                        score = s;
                    } else |_| failed = true;
                } else if (maximizing) {
                    if (searchNode(d - 1, alpha, alpha + 1, 1)) |s| {
                        score = s;
                        if (s > alpha and s < beta) {
                            ctxResearches += 1;
                            if (searchNode(d - 1, alpha, beta, 1)) |s2| {
                                score = s2;
                            } else |_| failed = true;
                        }
                    } else |_| failed = true;
                } else {
                    if (searchNode(d - 1, beta - 1, beta, 1)) |s| {
                        score = s;
                        if (s < beta and s > alpha) {
                            ctxResearches += 1;
                            if (searchNode(d - 1, alpha, beta, 1)) |s2| {
                                score = s2;
                            } else |_| failed = true;
                        }
                    } else |_| failed = true;
                }
                unmakeMove(u);
                if (failed) {
                    aborted = true;
                    break;
                }
                it.score = score;
                if (iterBest == -1 or (if (maximizing) score > iterScore else score < iterScore)) {
                    iterScore = score;
                    iterBest = @intCast(idx);
                }
                if (maximizing) {
                    if (iterScore > alpha) alpha = iterScore;
                } else {
                    if (iterScore < beta) beta = iterScore;
                }
            }
            if (aborted) break;
            if (iterScore <= lo) {
                ctxResearches += 1;
                delta *= 2;
                lo = if (delta > 800) -INF else iterScore - delta;
                continue;
            }
            if (iterScore >= hi) {
                ctxResearches += 1;
                delta *= 2;
                hi = if (delta > 800) INF else iterScore + delta;
                continue;
            }
            break;
        }
        if (aborted) {
            if (bestIdx == -1 and iterBest != -1) {
                bestIdx = iterBest;
                bestScore = iterScore;
            }
            attemptedDepth = d;
            stopReason = if (ctxAbortReason >= 0)
                ctxAbortReason
            else if (ctxHasNodeLimit and ctxNodes >= ctxNodeLimit) 2 else 1;
            break :outer;
        }
        bestScore = iterScore;
        completed = d;
        // Order the whole root by this iteration's scores (stable), then move
        // the best strictly first (JS splice + unshift). JS tracks the best by
        // object reference; initialIndex is the unique identity here.
        const bestInitial = items[@intCast(iterBest)].initialIndex;
        sortItemsByScore(items, maximizing);
        moveBestFirst(items, bestInitial);
        bestIdx = 0;
        if ((if (bestScore < 0) -bestScore else bestScore) >= MATE_NEAR) {
            stopReason = 3; // mate
            break;
        }
        if (d < maxDepth) {
            if (ctxHasDeadline and now_ms() >= ctxDeadline) {
                stopReason = 1;
                break;
            }
            if (ctxHasNodeLimit and ctxNodes >= ctxNodeLimit) {
                stopReason = 2;
                break;
            }
        }
    }

    if (bestIdx == -1) bestIdx = 0; // budget died inside depth 1
    finishOutput(completed, bestScore, items[@intCast(bestIdx)].move, attemptedDepth, stopReason);
    // root order in initial-order sequence
    out[OUT_ROOT_N] = @intCast(nLegal);
    for (items) |it| {
        OUT_BUF[OUT_ROOT0 + @as(usize, @intCast(it.initialIndex))] = @intCast(packMove(it.move));
    }
    return 0;
}

// Stable sort of root items by score (desc for White, asc for Black).
fn sortItemsByScore(items: []RootItem, maximizing: bool) void {
    var i: usize = 1;
    while (i < items.len) : (i += 1) {
        const x = items[i];
        var lo: usize = 0;
        var hi: usize = i;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const cmp = if (maximizing) items[mid].score < x.score else items[mid].score > x.score;
            if (cmp) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        var j: usize = i;
        while (j > lo) : (j -= 1) items[j] = items[j - 1];
        items[lo] = x;
    }
}

fn moveBestFirst(items: []RootItem, bestInitial: i32) void {
    var idx: usize = 0;
    for (items, 0..) |it, k| {
        if (it.initialIndex == bestInitial) {
            idx = k;
            break;
        }
    }
    const bestItem = items[idx];
    var j: usize = idx;
    while (j > 0) : (j -= 1) items[j] = items[j - 1];
    items[0] = bestItem;
}

fn finishOutput(completed: i32, score: i32, move: ?Move, attemptedDepth: i32, stopReason: i32) void {
    var out = &OUT_BUF;
    out[OUT_STATUS] = 0;
    if (move) |m| {
        out[OUT_FROM] = m.from;
        out[OUT_TO] = m.to;
        out[OUT_PROMO] = m.promo;
    } else {
        out[OUT_FROM] = -1;
        out[OUT_TO] = -1;
        out[OUT_PROMO] = 0;
    }
    out[OUT_SCORE] = score;
    out[OUT_DEPTH] = completed;
    out[OUT_ATTEMPTED] = attemptedDepth;
    out[OUT_NODES] = @intCast(ctxNodes);
    out[OUT_QNODES] = @intCast(ctxQnodes);
    out[OUT_CUTOFFS] = @intCast(ctxCutoffs);
    out[OUT_RESEARCHES] = @intCast(ctxResearches);
    out[OUT_STOP] = stopReason;
    out[OUT_ROOT_N] = 0;
}

// ---- exported utilities ----
export fn inPtr() u32 {
    return @intFromPtr(&IN_BUF);
}
export fn outPtr() u32 {
    return @intFromPtr(&OUT_BUF);
}

export fn reset() void {
    ttReset();
    ctxReset(false, false, 0, false, 0);
}

fn perftNode(depth: i32, ply: usize) u64 {
    if (depth == 0) return 1;
    const moverTurn = turn;
    const enemy: u8 = 1 - moverTurn;
    const kingSq = findKing(moverTurn);
    const listAll = &moveBuf[ply];
    const n = pseudoMoves(listAll);
    var total: u64 = 0;
    for (listAll[0..n]) |m| {
        const u = makeMove(m);
        const ks: i32 = if (typeOf(m.piece) == K) m.to else kingSq;
        if (!isAttacked(ks, enemy)) {
            total += perftNode(depth - 1, ply + 1);
        }
        unmakeMove(u);
    }
    return total;
}

export fn perft(fenLen: u32, depth: i32) f64 {
    if (!parseFen(fenLen)) return -1;
    return @floatFromInt(perftNode(depth, 0));
}

export fn evalFen(fenLen: u32) i32 {
    if (!parseFen(fenLen)) return -0x7FFFFFFF;
    return evaluate();
}
