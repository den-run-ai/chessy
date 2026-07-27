//! Allocation-free scalar port of the shipped Chessy Play search.
//!
//! This feasibility core intentionally keeps the JavaScript algorithm:
//! iterative deepening, aspiration windows, PVS, bounded quiescence, exact
//! move ordering, repetition-path protection, and depth-pure TT scores.
//! Game-history repetition input and PV reconstruction are outside the first
//! benchmark ABI; the benchmark positions are bare FENs, matching ai-bench.js.

const engine = @import("engine.zig");
const evaluation = @import("eval.zig");

extern "env" fn now_ms() f64;

pub const MATE: i32 = 1_000_000;
pub const MATE_NEAR: i32 = MATE - 1_000;

const SCORE_INF: i32 = 2_000_000;
const ABORT_SCORE: i32 = -2_147_483_648;
const QMAX: usize = 16;
const QCHECK_PLIES: usize = 1;
const MAX_PLY: usize = 128;
const REP_INFINITY: u16 = 0xffff;

// The benchmark searches remain far below this capacity. Open addressing
// preserves JS Map semantics while the table is unsaturated: entries are keyed
// by h1 and guarded by h2, and a later store for the same h1 replaces it.
const TT_CAPACITY: usize = 1 << 20;
const TT_MASK: usize = TT_CAPACITY - 1;

const EXACT: u8 = 0;
const LOWER: u8 = 1;
const UPPER: u8 = 2;

pub const StopReason = enum(u32) {
    unknown = 0,
    max_depth = 1,
    time_limit = 2,
    node_limit = 3,
    mate = 4,
    game_over = 5,
};

pub const SearchResult = struct {
    move: ?engine.Move,
    score: i32,
    depth: u32,
    attempted_depth: ?u32,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    stop_reason: StopReason,
    tt_saturated: bool,
};

const Hash = struct {
    h1: u32,
    h2: u32,
    r1: u32,
    r2: u32,
};

const TTEntry = struct {
    h1: u32 = 0,
    h2: u32 = 0,
    score: i32 = 0,
    move: u32 = 0,
    depth: i16 = 0,
    generation: u16 = 0,
    flag: u8 = 0,
};

const RootItem = struct {
    move: engine.Move = 0,
    score: i32 = 0,
    initial_index: u16 = 0,
};

const Context = struct {
    quiesce: bool,
    has_deadline: bool,
    deadline: f64,
    node_limit: u64,
    abort_reason: StopReason,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    rep_ply: u16,
    path1: [MAX_PLY]u32,
    path2: [MAX_PLY]u32,
    path_len: usize,
    killers: [MAX_PLY][2]u32,
    hist_white: [4096]i32,
    hist_black: [4096]i32,
    moves: [MAX_PLY][engine.MAX_MOVES]engine.Move,
    move_scores: [MAX_PLY][engine.MAX_MOVES]i32,
    tt_count: usize,
    tt_saturated: bool,
};

var context: Context = undefined;
var tt: [TT_CAPACITY]TTEntry = [_]TTEntry{.{}} ** TT_CAPACITY;
var tt_generation: u16 = 1;
var root_items: [engine.MAX_MOVES]RootItem = [_]RootItem{.{}} ** engine.MAX_MOVES;

const Z_TURN: usize = 768;
const Z_CASTLE: usize = 769;
const Z_EP: usize = 773;
const Z_SIZE: usize = 781;

fn mulberryNext(seed: *u32) u32 {
    seed.* +%= 0x6D2B79F5;
    var value = (seed.* ^ (seed.* >> 15)) *% (1 | seed.*);
    value = (value +% ((value ^ (value >> 7)) *% (61 | value))) ^ value;
    return value ^ (value >> 14);
}

fn makeZobrist(comptime initial_seed: u32) [Z_SIZE]u32 {
    @setEvalBranchQuota(10_000);
    var result: [Z_SIZE]u32 = undefined;
    var seed = initial_seed;
    for (&result) |*slot| slot.* = mulberryNext(&seed);
    return result;
}

const Z1 = makeZobrist(0x9E3779B9);
const Z2 = makeZobrist(0x85EBCA6B);

fn resetContext(quiesce: bool, node_limit: u32, time_ms: u32) void {
    context.quiesce = quiesce;
    context.has_deadline = time_ms != 0;
    context.deadline = if (time_ms != 0) now_ms() + @as(f64, @floatFromInt(time_ms)) else 0;
    context.node_limit = if (node_limit == 0) ~@as(u64, 0) else node_limit;
    context.abort_reason = .unknown;
    context.nodes = 0;
    context.qnodes = 0;
    context.cutoffs = 0;
    context.researches = 0;
    context.rep_ply = REP_INFINITY;
    context.path_len = 0;
    context.tt_count = 0;
    context.tt_saturated = false;
    for (&context.killers) |*pair| pair.* = .{ 0, 0 };
    @memset(context.hist_white[0..], 0);
    @memset(context.hist_black[0..], 0);

    tt_generation +%= 1;
    if (tt_generation == 0) {
        for (&tt) |*entry| entry.generation = 0;
        tt_generation = 1;
    }
}

fn pieceHashIndex(piece: engine.Piece) usize {
    return @intFromEnum(piece) - 1;
}

fn hashPosition(position: *engine.Position) Hash {
    var h1: u32 = 0;
    var h2: u32 = 0;
    for (position.board, 0..) |piece, square| {
        if (piece == .empty) continue;
        const index = pieceHashIndex(piece) * 64 + square;
        h1 ^= Z1[index];
        h2 ^= Z2[index];
    }
    if (position.turn == .white) {
        h1 ^= Z1[Z_TURN];
        h2 ^= Z2[Z_TURN];
    }
    const rights = [_]u8{
        engine.CASTLE_WHITE_K,
        engine.CASTLE_WHITE_Q,
        engine.CASTLE_BLACK_K,
        engine.CASTLE_BLACK_Q,
    };
    for (rights, 0..) |right, offset| {
        if (position.castling & right != 0) {
            h1 ^= Z1[Z_CASTLE + offset];
            h2 ^= Z2[Z_CASTLE + offset];
        }
    }

    var table_h1 = h1;
    var table_h2 = h2;
    if (position.ep != engine.NO_SQUARE) {
        const index = Z_EP + engine.colOf(position.ep);
        table_h1 ^= Z1[index];
        table_h2 ^= Z2[index];
        if (engine.hasLegalEnPassant(position)) {
            h1 ^= Z1[index];
            h2 ^= Z2[index];
        }
    }
    return .{ .h1 = table_h1, .h2 = table_h2, .r1 = h1, .r2 = h2 };
}

fn checkRepetition(r1: u32, r2: u32) ?u16 {
    var index = context.path_len;
    while (index > 0) {
        index -= 1;
        if (context.path1[index] == r1 and context.path2[index] == r2) {
            return @intCast(index);
        }
    }
    return null;
}

fn pushPath(r1: u32, r2: u32) void {
    if (context.path_len >= MAX_PLY) unreachable;
    context.path1[context.path_len] = r1;
    context.path2[context.path_len] = r2;
    context.path_len += 1;
}

fn popPath() void {
    context.path_len -= 1;
}

fn ttStartIndex(h1: u32) usize {
    return @as(usize, h1 *% 0x9E3779B1) & TT_MASK;
}

fn ttLookup(h1: u32) ?*TTEntry {
    var index = ttStartIndex(h1);
    var probes: usize = 0;
    while (probes < TT_CAPACITY) : (probes += 1) {
        const entry = &tt[index];
        if (entry.generation != tt_generation) return null;
        if (entry.h1 == h1) return entry;
        index = (index + 1) & TT_MASK;
    }
    return null;
}

fn ttStore(h1: u32, h2: u32, depth: i32, ply: usize, raw_score: i32, flag: u8, move: u32) void {
    var score = raw_score;
    if (score > MATE_NEAR) score += @intCast(ply) else if (score < -MATE_NEAR) score -= @intCast(ply);

    var index = ttStartIndex(h1);
    var probes: usize = 0;
    while (probes < TT_CAPACITY) : (probes += 1) {
        const entry = &tt[index];
        if (entry.generation != tt_generation) {
            entry.* = .{
                .h1 = h1,
                .h2 = h2,
                .score = score,
                .move = move,
                .depth = @intCast(depth),
                .generation = tt_generation,
                .flag = flag,
            };
            context.tt_count += 1;
            return;
        }
        if (entry.h1 == h1) {
            entry.h2 = h2;
            entry.score = score;
            entry.move = move;
            entry.depth = @intCast(depth);
            entry.flag = flag;
            return;
        }
        index = (index + 1) & TT_MASK;
    }
    context.tt_saturated = true;
}

fn checkBudget() bool {
    if (context.nodes >= context.node_limit) {
        context.abort_reason = .node_limit;
        return false;
    }
    const next_node = context.nodes + 1;
    if (context.has_deadline and (next_node & 1023) == 0 and now_ms() >= context.deadline) {
        context.abort_reason = .time_limit;
        return false;
    }
    context.nodes = next_node;
    return true;
}

fn orderingValue(kind: engine.PieceType) i32 {
    return switch (kind) {
        .pawn => 100,
        .knight => 320,
        .bishop => 330,
        .rook => 500,
        .queen => 900,
        .king => 0,
    };
}

fn ttPackMove(move: engine.Move) u32 {
    const promotion_index: u32 = if (engine.movePromotion(move)) |promotion|
        switch (promotion) {
            .queen => 1,
            .rook => 2,
            .bishop => 3,
            .knight => 4,
            else => 0,
        }
    else
        0;
    return (@as(u32, engine.moveFrom(move)) << 9) |
        (@as(u32, engine.moveTo(move)) << 3) |
        promotion_index;
}

fn moveOrder(move: engine.Move, tt_move: u32, ply: usize, turn: engine.Color) i32 {
    const packed_move = ttPackMove(move);
    if (packed_move == tt_move) return 2_000_000_000;
    if (engine.movePromotion(move)) |promotion| {
        return 1_000_000_000 + orderingValue(promotion);
    }
    if (engine.moveIsCapture(move)) {
        return 100_000_000 +
            10 * orderingValue(engine.pieceType(engine.moveCaptured(move)).?) -
            orderingValue(engine.pieceType(engine.movePiece(move)).?);
    }
    const killers = context.killers[ply];
    if (packed_move == killers[0]) return 10_000_000;
    if (packed_move == killers[1]) return 9_999_999;
    const history_index =
        @as(usize, engine.moveFrom(move)) * 64 + engine.moveTo(move);
    return if (turn == .white)
        context.hist_white[history_index]
    else
        context.hist_black[history_index];
}

fn orderMoves(ply: usize, count: usize, tt_move: u32, turn: engine.Color) void {
    const moves = &context.moves[ply];
    const scores = &context.move_scores[ply];
    for (moves[0..count], 0..) |move, index| {
        scores[index] = moveOrder(move, tt_move, ply, turn);
    }
    // Stable insertion sort exactly preserves JS stable-sort tie order.
    var index: usize = 1;
    while (index < count) : (index += 1) {
        const move = moves[index];
        const score = scores[index];
        var insertion = index;
        while (insertion > 0 and scores[insertion - 1] < score) {
            moves[insertion] = moves[insertion - 1];
            scores[insertion] = scores[insertion - 1];
            insertion -= 1;
        }
        moves[insertion] = move;
        scores[insertion] = score;
    }
}

fn recordQuietCutoff(move: engine.Move, ply: usize, depth: i32, turn: engine.Color) void {
    const packed_move = ttPackMove(move);
    if (context.killers[ply][0] != packed_move) {
        context.killers[ply][1] = context.killers[ply][0];
        context.killers[ply][0] = packed_move;
    }
    const history_index =
        @as(usize, engine.moveFrom(move)) * 64 + engine.moveTo(move);
    const bonus = depth * depth;
    if (turn == .white) {
        context.hist_white[history_index] +%= bonus;
    } else {
        context.hist_black[history_index] +%= bonus;
    }
}

fn hasLegalMove(position: *engine.Position, ply: usize, existing_count: ?usize) bool {
    const count = existing_count orelse engine.generatePseudo(position, &context.moves[ply]);
    const mover = position.turn;
    for (context.moves[ply][0..count]) |move| {
        const undo = engine.makeMove(position, move);
        const legal = !engine.inCheck(position, mover);
        engine.unmakeMove(position, move, undo);
        if (legal) return true;
    }
    return false;
}

fn quiesceNode(position: *engine.Position, alpha_initial: i32, beta_initial: i32, ply: usize, qply: usize) i32 {
    if (!checkBudget()) return ABORT_SCORE;
    context.qnodes += 1;
    context.rep_ply = REP_INFINITY;
    if (engine.positionInsufficientMaterial(position)) return 0;

    const turn = position.turn;
    const enemy = engine.opposite(turn);
    const maximizing = turn == .white;
    const in_check = engine.inCheck(position, turn);

    var hash: Hash = undefined;
    const track_repetition = position.halfmove >= 4;
    if (track_repetition) {
        hash = hashPosition(position);
        if (checkRepetition(hash.r1, hash.r2)) |ancestor| {
            context.rep_ply = ancestor;
            return 0;
        }
    }

    var count = engine.generatePseudo(position, &context.moves[ply]);
    if (!hasLegalMove(position, ply, count)) {
        return if (in_check)
            (if (maximizing) -(MATE - @as(i32, @intCast(ply))) else MATE - @as(i32, @intCast(ply)))
        else
            0;
    }
    if (position.halfmove >= 100) return 0;
    if (qply >= QMAX) return evaluation.evaluate(position);

    var alpha = alpha_initial;
    var beta = beta_initial;
    var best: i32 = undefined;
    if (in_check) {
        best = if (maximizing) -SCORE_INF else SCORE_INF;
    } else {
        best = evaluation.evaluate(position);
        if (maximizing) {
            if (best >= beta) return best;
            if (best > alpha) alpha = best;
        } else {
            if (best <= alpha) return best;
            if (best < beta) beta = best;
        }
    }

    if (track_repetition) pushPath(hash.r1, hash.r2);
    var rep_min: u16 = REP_INFINITY;

    if (!in_check) {
        const generate_checks = qply < QCHECK_PLIES;
        var filtered: usize = 0;
        var index: usize = 0;
        while (index < count) : (index += 1) {
            const move = context.moves[ply][index];
            var keep = engine.moveIsCapture(move) or engine.movePromotion(move) != null;
            if (!keep and generate_checks) {
                const undo = engine.makeMove(position, move);
                keep = engine.inCheck(position, enemy);
                engine.unmakeMove(position, move, undo);
            }
            if (keep) {
                context.moves[ply][filtered] = move;
                filtered += 1;
            }
        }
        count = filtered;
    }

    orderMoves(ply, count, 0, turn);
    var index: usize = 0;
    while (index < count) : (index += 1) {
        const move = context.moves[ply][index];
        const undo = engine.makeMove(position, move);
        if (engine.inCheck(position, turn)) {
            engine.unmakeMove(position, move, undo);
            continue;
        }
        const score = quiesceNode(position, alpha, beta, ply + 1, qply + 1);
        const child_rep = context.rep_ply;
        engine.unmakeMove(position, move, undo);
        if (score == ABORT_SCORE) {
            if (track_repetition) popPath();
            return ABORT_SCORE;
        }
        if (child_rep < rep_min) rep_min = child_rep;
        if (maximizing) {
            if (score > best) best = score;
            if (best > alpha) alpha = best;
        } else {
            if (score < best) best = score;
            if (best < beta) beta = best;
        }
        if (beta <= alpha) break;
    }

    if (track_repetition) popPath();
    context.rep_ply = rep_min;
    return best;
}

fn searchNode(position: *engine.Position, depth: i32, alpha_initial: i32, beta_initial: i32, ply: usize) i32 {
    if (!checkBudget()) return ABORT_SCORE;
    context.rep_ply = REP_INFINITY;

    const turn = position.turn;
    const maximizing = turn == .white;
    const in_check = engine.inCheck(position, turn);
    const fifty = position.halfmove >= 100;
    if (fifty and !in_check) return 0;
    if (engine.positionInsufficientMaterial(position)) return 0;

    const hash = hashPosition(position);
    if (checkRepetition(hash.r1, hash.r2)) |ancestor| {
        context.rep_ply = ancestor;
        return 0;
    }

    if (depth <= 0) {
        if (context.quiesce) return quiesceNode(position, alpha_initial, beta_initial, ply, 0);
        if (!hasLegalMove(position, ply, null)) {
            return if (in_check)
                (if (maximizing) -(MATE - @as(i32, @intCast(ply))) else MATE - @as(i32, @intCast(ply)))
            else
                0;
        }
        if (fifty) return 0;
        return evaluation.evaluate(position);
    }

    var alpha = alpha_initial;
    var beta = beta_initial;
    const remaining_to_fifty: i32 =
        @as(i32, position.halfmove) + depth +
        (if (context.quiesce) @as(i32, QMAX) else 0);
    const use_tt = remaining_to_fifty < 100;
    var tt_move: u32 = 0;
    if (use_tt) {
        if (ttLookup(hash.h1)) |entry| {
            if (entry.h2 == hash.h2) {
                tt_move = entry.move;
                if (entry.depth == depth) {
                    var score = entry.score;
                    if (score > MATE_NEAR) score -= @intCast(ply) else if (score < -MATE_NEAR) score += @intCast(ply);
                    if (entry.flag == EXACT) return score;
                    if (entry.flag == LOWER) {
                        if (score >= beta) {
                            context.cutoffs += 1;
                            return score;
                        }
                        if (score > alpha) alpha = score;
                    } else {
                        if (score <= alpha) {
                            context.cutoffs += 1;
                            return score;
                        }
                        if (score < beta) beta = score;
                    }
                    if (alpha >= beta) {
                        context.cutoffs += 1;
                        return score;
                    }
                }
            }
        }
    }

    const alpha_original = alpha;
    const beta_original = beta;
    var best = if (maximizing) -SCORE_INF else SCORE_INF;
    var best_move: u32 = 0;
    var any_legal = false;
    var rep_min: u16 = REP_INFINITY;

    pushPath(hash.r1, hash.r2);
    const count = engine.generatePseudo(position, &context.moves[ply]);
    orderMoves(ply, count, tt_move, turn);

    var index: usize = 0;
    while (index < count) : (index += 1) {
        const move = context.moves[ply][index];
        const undo = engine.makeMove(position, move);
        if (engine.inCheck(position, turn)) {
            engine.unmakeMove(position, move, undo);
            continue;
        }

        var score: i32 = undefined;
        var child_rep: u16 = REP_INFINITY;
        if (!any_legal) {
            score = searchNode(position, depth - 1, alpha, beta, ply + 1);
            child_rep = context.rep_ply;
        } else if (maximizing) {
            score = searchNode(position, depth - 1, alpha, alpha + 1, ply + 1);
            child_rep = context.rep_ply;
            if (score != ABORT_SCORE and score > alpha and score < beta) {
                context.researches += 1;
                score = searchNode(position, depth - 1, alpha, beta, ply + 1);
                if (context.rep_ply < child_rep) child_rep = context.rep_ply;
            }
        } else {
            score = searchNode(position, depth - 1, beta - 1, beta, ply + 1);
            child_rep = context.rep_ply;
            if (score != ABORT_SCORE and score < beta and score > alpha) {
                context.researches += 1;
                score = searchNode(position, depth - 1, alpha, beta, ply + 1);
                if (context.rep_ply < child_rep) child_rep = context.rep_ply;
            }
        }
        engine.unmakeMove(position, move, undo);

        if (score == ABORT_SCORE) {
            popPath();
            return ABORT_SCORE;
        }
        any_legal = true;
        if (child_rep < rep_min) rep_min = child_rep;
        if ((maximizing and score > best) or (!maximizing and score < best)) {
            best = score;
            best_move = ttPackMove(move);
        }
        if (maximizing) {
            if (best > alpha) alpha = best;
        } else {
            if (best < beta) beta = best;
        }
        if (beta <= alpha) {
            context.cutoffs += 1;
            if (!engine.moveIsCapture(move) and engine.movePromotion(move) == null) {
                recordQuietCutoff(move, ply, depth, turn);
            }
            break;
        }
    }
    popPath();
    context.rep_ply = rep_min;

    if (!any_legal) {
        if (in_check) {
            return if (maximizing)
                -(MATE - @as(i32, @intCast(ply)))
            else
                MATE - @as(i32, @intCast(ply));
        }
        return 0;
    }
    if (fifty) return 0;

    if (use_tt and rep_min >= ply) {
        const flag: u8 =
            if (best <= alpha_original) UPPER else if (best >= beta_original) LOWER else EXACT;
        ttStore(hash.h1, hash.h2, depth, ply, best, flag, best_move);
    }
    return best;
}

fn shuffleRoot(count: usize) void {
    var seed: u32 = 0x00C0FFEE;
    var index = count;
    while (index > 1) {
        index -= 1;
        const random = mulberryNext(&seed);
        const target: usize = @intCast(
            (@as(u64, random) * @as(u64, index + 1)) >> 32,
        );
        const temporary = root_items[index];
        root_items[index] = root_items[target];
        root_items[target] = temporary;
    }
}

fn rootOrderScore(move: engine.Move) i32 {
    // At root the TT, killers, and history are empty before the first ordering.
    if (engine.movePromotion(move)) |promotion| {
        return 1_000_000_000 + orderingValue(promotion);
    }
    if (engine.moveIsCapture(move)) {
        return 100_000_000 +
            10 * orderingValue(engine.pieceType(engine.moveCaptured(move)).?) -
            orderingValue(engine.pieceType(engine.movePiece(move)).?);
    }
    return 0;
}

fn orderInitialRoot(count: usize) void {
    var index: usize = 1;
    while (index < count) : (index += 1) {
        const item = root_items[index];
        const score = rootOrderScore(item.move);
        var insertion = index;
        while (insertion > 0 and rootOrderScore(root_items[insertion - 1].move) < score) {
            root_items[insertion] = root_items[insertion - 1];
            insertion -= 1;
        }
        root_items[insertion] = item;
    }
}

fn reorderRootAfterIteration(count: usize, maximizing: bool, best_move: engine.Move) void {
    // Stable score sort.
    var index: usize = 1;
    while (index < count) : (index += 1) {
        const item = root_items[index];
        var insertion = index;
        while (insertion > 0 and
            (if (maximizing)
                root_items[insertion - 1].score < item.score
            else
                root_items[insertion - 1].score > item.score))
        {
            root_items[insertion] = root_items[insertion - 1];
            insertion -= 1;
        }
        root_items[insertion] = item;
    }
    // JS removes the strict iterBest identity and unshifts it.
    var best_index: usize = 0;
    while (best_index < count and root_items[best_index].move != best_move) : (best_index += 1) {}
    if (best_index < count) {
        const best = root_items[best_index];
        while (best_index > 0) : (best_index -= 1) {
            root_items[best_index] = root_items[best_index - 1];
        }
        root_items[0] = best;
    }
}

fn absScore(score: i32) i32 {
    return if (score < 0) -score else score;
}

pub fn run(position: *engine.Position, max_depth_input: u32, node_limit: u32, time_ms: u32, quiesce: bool) SearchResult {
    resetContext(quiesce, node_limit, time_ms);
    const max_depth = @max(@as(u32, 1), max_depth_input);

    var root_moves: [engine.MAX_MOVES]engine.Move = undefined;
    const root_count = engine.generateRootMoves(position, &root_moves);
    if (root_count == 0 or position.halfmove >= 100 or engine.positionInsufficientMaterial(position)) {
        return .{
            .move = null,
            .score = 0,
            .depth = 0,
            .attempted_depth = null,
            .nodes = 0,
            .qnodes = 0,
            .cutoffs = 0,
            .researches = 0,
            .stop_reason = .game_over,
            .tt_saturated = false,
        };
    }

    for (root_moves[0..root_count], 0..) |move, index| {
        root_items[index] = .{
            .move = move,
            .score = 0,
            .initial_index = @intCast(index),
        };
    }
    shuffleRoot(root_count);
    orderInitialRoot(root_count);

    const root_hash = hashPosition(position);
    pushPath(root_hash.r1, root_hash.r2);

    const maximizing = position.turn == .white;
    var best_move: ?engine.Move = null;
    var best_score: i32 = 0;
    var completed: u32 = 0;
    var attempted: ?u32 = null;
    var stop_reason: StopReason = .max_depth;

    var depth: u32 = 1;
    while (depth <= max_depth) : (depth += 1) {
        var delta: i32 = 50;
        var low: i32 = -SCORE_INF;
        var high: i32 = SCORE_INF;
        if (depth >= 2 and absScore(best_score) < MATE_NEAR) {
            low = best_score - delta;
            high = best_score + delta;
        }

        var iteration_best: ?engine.Move = null;
        var iteration_score: i32 = 0;
        var aborted = false;
        while (true) {
            var alpha = low;
            var beta = high;
            iteration_best = null;
            iteration_score = if (maximizing) -SCORE_INF else SCORE_INF;

            var index: usize = 0;
            while (index < root_count) : (index += 1) {
                const move = root_items[index].move;
                const undo = engine.makeMove(position, move);
                var score: i32 = undefined;
                if (iteration_best == null) {
                    score = searchNode(position, @as(i32, @intCast(depth)) - 1, alpha, beta, 1);
                } else if (maximizing) {
                    score = searchNode(position, @as(i32, @intCast(depth)) - 1, alpha, alpha + 1, 1);
                    if (score != ABORT_SCORE and score > alpha and score < beta) {
                        context.researches += 1;
                        score = searchNode(position, @as(i32, @intCast(depth)) - 1, alpha, beta, 1);
                    }
                } else {
                    score = searchNode(position, @as(i32, @intCast(depth)) - 1, beta - 1, beta, 1);
                    if (score != ABORT_SCORE and score < beta and score > alpha) {
                        context.researches += 1;
                        score = searchNode(position, @as(i32, @intCast(depth)) - 1, alpha, beta, 1);
                    }
                }
                engine.unmakeMove(position, move, undo);

                if (score == ABORT_SCORE) {
                    aborted = true;
                    break;
                }
                root_items[index].score = score;
                if (iteration_best == null or
                    (if (maximizing) score > iteration_score else score < iteration_score))
                {
                    iteration_score = score;
                    iteration_best = move;
                }
                if (maximizing) {
                    if (iteration_score > alpha) alpha = iteration_score;
                } else {
                    if (iteration_score < beta) beta = iteration_score;
                }
            }

            if (aborted) break;
            if (iteration_score <= low) {
                context.researches += 1;
                delta *= 2;
                low = if (delta > 800) -SCORE_INF else iteration_score - delta;
                continue;
            }
            if (iteration_score >= high) {
                context.researches += 1;
                delta *= 2;
                high = if (delta > 800) SCORE_INF else iteration_score + delta;
                continue;
            }
            break;
        }

        if (aborted) {
            if (best_move == null and iteration_best != null) {
                best_move = iteration_best;
                best_score = iteration_score;
            }
            attempted = depth;
            stop_reason = if (context.abort_reason == .unknown) .time_limit else context.abort_reason;
            break;
        }

        best_move = iteration_best;
        best_score = iteration_score;
        completed = depth;
        reorderRootAfterIteration(root_count, maximizing, iteration_best.?);
        if (absScore(best_score) >= MATE_NEAR) {
            stop_reason = .mate;
            break;
        }
        if (depth < max_depth) {
            if (context.has_deadline and now_ms() >= context.deadline) {
                stop_reason = .time_limit;
                break;
            }
            if (context.nodes >= context.node_limit) {
                stop_reason = .node_limit;
                break;
            }
        }
    }

    popPath();
    if (best_move == null) best_move = root_items[0].move;
    return .{
        .move = best_move,
        .score = best_score,
        .depth = completed,
        .attempted_depth = attempted,
        .nodes = context.nodes,
        .qnodes = context.qnodes,
        .cutoffs = context.cutoffs,
        .researches = context.researches,
        .stop_reason = stop_reason,
        .tt_saturated = context.tt_saturated,
    };
}

pub fn abiMove(move: engine.Move) u32 {
    const promotion: u32 = if (engine.movePromotion(move)) |kind|
        switch (kind) {
            .queen => 1,
            .rook => 2,
            .bishop => 3,
            .knight => 4,
            else => 0,
        }
    else
        0;
    return @as(u32, engine.moveFrom(move)) |
        (@as(u32, engine.moveTo(move)) << 6) |
        (promotion << 12);
}
