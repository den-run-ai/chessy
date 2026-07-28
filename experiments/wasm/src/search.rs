//! Allocation-free scalar port of the shipped Chessy Play search.

use crate::{engine, eval};
use engine::{Color, Move, Piece, PieceType, Position, MAX_MOVES};

#[cfg(not(test))]
#[link(wasm_import_module = "env")]
extern "C" {
    fn now_ms() -> f64;
}

#[cfg(test)]
unsafe fn now_ms() -> f64 {
    0.0
}

pub const MATE: i32 = 1_000_000;
pub const MATE_NEAR: i32 = MATE - 1_000;

const SCORE_INF: i32 = 2_000_000;
const ABORT_SCORE: i32 = i32::MIN;
const QMAX: usize = 16;
const QCHECK_PLIES: usize = 1;
const MAX_PLY: usize = 128;
pub const MAX_SEARCH_DEPTH: u32 = (MAX_PLY - QMAX - 1) as u32;
const REP_INFINITY: u16 = 0xffff;
const NMP_REDUCTION: i32 = 2;
const NMP_MIN_DEPTH: i32 = 5;
const NMP_STATIC_MARGIN: i32 = 64;

const TT_CAPACITY: usize = 1 << 20;
const TT_MASK: usize = TT_CAPACITY - 1;

const EXACT: u8 = 0;
const LOWER: u8 = 1;
const UPPER: u8 = 2;

#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Unknown = 0,
    MaxDepth = 1,
    TimeLimit = 2,
    NodeLimit = 3,
    Mate = 4,
    GameOver = 5,
}

pub struct SearchResult {
    pub mv: Option<Move>,
    pub score: i32,
    pub depth: u32,
    pub attempted_depth: Option<u32>,
    pub nodes: u64,
    pub qnodes: u64,
    pub cutoffs: u64,
    pub researches: u64,
    pub stop_reason: StopReason,
    pub tt_saturated: bool,
}

#[derive(Clone, Copy)]
struct Hash {
    h1: u32,
    h2: u32,
    r1: u32,
    r2: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TTEntry {
    h1: u32,
    h2: u32,
    score: i32,
    mv: u32,
    depth: i16,
    generation: u16,
    flag: u8,
}

impl TTEntry {
    const ZERO: Self = Self {
        h1: 0,
        h2: 0,
        score: 0,
        mv: 0,
        depth: 0,
        generation: 0,
        flag: 0,
    };
}

const _: [(); 24] = [(); core::mem::size_of::<TTEntry>()];

#[derive(Clone, Copy)]
struct RootItem {
    mv: Move,
    score: i32,
    #[allow(dead_code)]
    initial_index: u16,
}

impl RootItem {
    const ZERO: Self = Self {
        mv: 0,
        score: 0,
        initial_index: 0,
    };
}

struct Context {
    quiesce: bool,
    has_deadline: bool,
    deadline: f64,
    node_limit: u64,
    abort_reason: StopReason,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    use_nmp: bool,
    in_null: u8,
    nmp_disabled: u8,
    nmp_probes: u64,
    nmp_triggers: u64,
    nmp_verified_cutoffs: u64,
    nmp_verification_rejects: u64,
    nmp_probe_nodes: u64,
    nmp_verify_nodes: u64,
    rep_ply: u16,
    path1: [u32; MAX_PLY],
    path2: [u32; MAX_PLY],
    path_len: usize,
    killers: [[u32; 2]; MAX_PLY],
    hist_white: [i32; 4096],
    hist_black: [i32; 4096],
    moves: [[Move; MAX_MOVES]; MAX_PLY],
    move_scores: [[i32; MAX_MOVES]; MAX_PLY],
    tt_count: usize,
    tt_saturated: bool,
}

impl Context {
    const ZERO: Self = Self {
        quiesce: false,
        has_deadline: false,
        deadline: 0.0,
        node_limit: 0,
        abort_reason: StopReason::Unknown,
        nodes: 0,
        qnodes: 0,
        cutoffs: 0,
        researches: 0,
        use_nmp: true,
        in_null: 0,
        nmp_disabled: 0,
        nmp_probes: 0,
        nmp_triggers: 0,
        nmp_verified_cutoffs: 0,
        nmp_verification_rejects: 0,
        nmp_probe_nodes: 0,
        nmp_verify_nodes: 0,
        rep_ply: 0,
        path1: [0; MAX_PLY],
        path2: [0; MAX_PLY],
        path_len: 0,
        killers: [[0; 2]; MAX_PLY],
        hist_white: [0; 4096],
        hist_black: [0; 4096],
        moves: [[0; MAX_MOVES]; MAX_PLY],
        move_scores: [[0; MAX_MOVES]; MAX_PLY],
        tt_count: 0,
        tt_saturated: false,
    };
}

static mut CONTEXT: Context = Context::ZERO;
static mut TT: [TTEntry; TT_CAPACITY] = [TTEntry::ZERO; TT_CAPACITY];
static mut TT_GENERATION: u16 = 1;
static mut ROOT_ITEMS: [RootItem; MAX_MOVES] = [RootItem::ZERO; MAX_MOVES];

const Z_TURN: usize = 768;
const Z_CASTLE: usize = 769;
const Z_EP: usize = 773;
const Z_SIZE: usize = 781;

#[inline]
unsafe fn context() -> &'static mut Context {
    &mut *core::ptr::addr_of_mut!(CONTEXT)
}

#[inline]
unsafe fn root_item(index: usize) -> *mut RootItem {
    core::ptr::addr_of_mut!(ROOT_ITEMS)
        .cast::<RootItem>()
        .add(index)
}

#[inline]
unsafe fn tt_entry(index: usize) -> *mut TTEntry {
    core::ptr::addr_of_mut!(TT).cast::<TTEntry>().add(index)
}

const fn mulberry_next(seed: &mut u32) -> u32 {
    *seed = seed.wrapping_add(0x6D2B79F5);
    let mut value = (*seed ^ (*seed >> 15)).wrapping_mul(1 | *seed);
    value = value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value)) ^ value;
    value ^ (value >> 14)
}

const fn make_zobrist(initial_seed: u32) -> [u32; Z_SIZE] {
    let mut result = [0_u32; Z_SIZE];
    let mut seed = initial_seed;
    let mut index = 0;
    while index < Z_SIZE {
        result[index] = mulberry_next(&mut seed);
        index += 1;
    }
    result
}

const Z1: [u32; Z_SIZE] = make_zobrist(0x9E3779B9);
const Z2: [u32; Z_SIZE] = make_zobrist(0x85EBCA6B);

unsafe fn reset_context(quiesce: bool, node_limit: u32, time_ms: u32) {
    let ctx = context();
    ctx.quiesce = quiesce;
    ctx.has_deadline = time_ms != 0;
    ctx.deadline = if time_ms != 0 {
        now_ms() + time_ms as f64
    } else {
        0.0
    };
    ctx.node_limit = if node_limit == 0 {
        u64::MAX
    } else {
        node_limit as u64
    };
    ctx.abort_reason = StopReason::Unknown;
    ctx.nodes = 0;
    ctx.qnodes = 0;
    ctx.cutoffs = 0;
    ctx.researches = 0;
    ctx.use_nmp = true;
    ctx.in_null = 0;
    ctx.nmp_disabled = 0;
    ctx.nmp_probes = 0;
    ctx.nmp_triggers = 0;
    ctx.nmp_verified_cutoffs = 0;
    ctx.nmp_verification_rejects = 0;
    ctx.nmp_probe_nodes = 0;
    ctx.nmp_verify_nodes = 0;
    ctx.rep_ply = REP_INFINITY;
    ctx.path_len = 0;
    ctx.tt_count = 0;
    ctx.tt_saturated = false;
    ctx.killers.fill([0, 0]);
    ctx.hist_white.fill(0);
    ctx.hist_black.fill(0);

    TT_GENERATION = TT_GENERATION.wrapping_add(1);
    if TT_GENERATION == 0 {
        let mut index = 0;
        while index < TT_CAPACITY {
            (*tt_entry(index)).generation = 0;
            index += 1;
        }
        TT_GENERATION = 1;
    }
}

fn piece_hash_index(piece: Piece) -> usize {
    piece as usize - 1
}

unsafe fn hash_position(position: &mut Position) -> Hash {
    let mut h1 = 0_u32;
    let mut h2 = 0_u32;
    let mut square = 0;
    while square < 64 {
        let piece = position.board[square];
        if piece != Piece::Empty {
            let index = piece_hash_index(piece) * 64 + square;
            h1 ^= Z1[index];
            h2 ^= Z2[index];
        }
        square += 1;
    }
    if position.turn == Color::White {
        h1 ^= Z1[Z_TURN];
        h2 ^= Z2[Z_TURN];
    }
    let rights = [
        engine::CASTLE_WHITE_K,
        engine::CASTLE_WHITE_Q,
        engine::CASTLE_BLACK_K,
        engine::CASTLE_BLACK_Q,
    ];
    let mut offset = 0;
    while offset < rights.len() {
        if position.castling & rights[offset] != 0 {
            h1 ^= Z1[Z_CASTLE + offset];
            h2 ^= Z2[Z_CASTLE + offset];
        }
        offset += 1;
    }

    let mut table_h1 = h1;
    let mut table_h2 = h2;
    if position.ep != engine::NO_SQUARE {
        let index = Z_EP + engine::col_of(position.ep) as usize;
        table_h1 ^= Z1[index];
        table_h2 ^= Z2[index];
        if engine::has_legal_en_passant(position) {
            h1 ^= Z1[index];
            h2 ^= Z2[index];
        }
    }
    Hash {
        h1: table_h1,
        h2: table_h2,
        r1: h1,
        r2: h2,
    }
}

unsafe fn check_repetition(r1: u32, r2: u32) -> Option<u16> {
    let mut index = context().path_len;
    while index > 0 {
        index -= 1;
        if context().path1[index] == r1 && context().path2[index] == r2 {
            return Some(index as u16);
        }
    }
    None
}

unsafe fn push_path(r1: u32, r2: u32) {
    let index = context().path_len;
    assert!(index < MAX_PLY);
    context().path1[index] = r1;
    context().path2[index] = r2;
    context().path_len = index + 1;
}

unsafe fn pop_path() {
    context().path_len -= 1;
}

#[inline]
fn tt_start_index(h1: u32) -> usize {
    h1.wrapping_mul(0x9E3779B1) as usize & TT_MASK
}

unsafe fn tt_lookup(h1: u32) -> *mut TTEntry {
    let mut index = tt_start_index(h1);
    let mut probes = 0;
    while probes < TT_CAPACITY {
        let entry = tt_entry(index);
        if (*entry).generation != TT_GENERATION {
            return core::ptr::null_mut();
        }
        if (*entry).h1 == h1 {
            return entry;
        }
        index = (index + 1) & TT_MASK;
        probes += 1;
    }
    core::ptr::null_mut()
}

#[inline]
fn tt_unavailable(count: usize, saturated: bool) -> bool {
    saturated || count >= TT_CAPACITY
}

unsafe fn tt_store(h1: u32, h2: u32, depth: i32, ply: usize, raw_score: i32, flag: u8, mv: u32) {
    if tt_unavailable(context().tt_count, context().tt_saturated) {
        context().tt_saturated = true;
        return;
    }
    let mut score = raw_score;
    if score > MATE_NEAR {
        score += ply as i32;
    } else if score < -MATE_NEAR {
        score -= ply as i32;
    }

    let mut index = tt_start_index(h1);
    let mut probes = 0;
    while probes < TT_CAPACITY {
        let entry = tt_entry(index);
        if (*entry).generation != TT_GENERATION {
            *entry = TTEntry {
                h1,
                h2,
                score,
                mv,
                depth: depth as i16,
                generation: TT_GENERATION,
                flag,
            };
            context().tt_count += 1;
            if context().tt_count == TT_CAPACITY {
                context().tt_saturated = true;
            }
            return;
        }
        if (*entry).h1 == h1 {
            (*entry).h2 = h2;
            (*entry).score = score;
            (*entry).mv = mv;
            (*entry).depth = depth as i16;
            (*entry).flag = flag;
            return;
        }
        index = (index + 1) & TT_MASK;
        probes += 1;
    }
    context().tt_saturated = true;
}

unsafe fn check_budget() -> bool {
    // A full open-addressed table makes every subsequent lookup/store scan all
    // 1,048,576 slots. The ABI reports saturation as a hard search error, so
    // continuing cannot produce a usable result and can turn one overflow
    // into an effectively hung worker.
    if tt_unavailable(context().tt_count, context().tt_saturated) {
        context().tt_saturated = true;
        return false;
    }
    if context().nodes >= context().node_limit {
        context().abort_reason = StopReason::NodeLimit;
        return false;
    }
    let next_node = context().nodes + 1;
    if context().has_deadline && next_node & 1023 == 0 && now_ms() >= context().deadline {
        context().abort_reason = StopReason::TimeLimit;
        return false;
    }
    context().nodes = next_node;
    true
}

#[inline]
fn ordering_value(kind: PieceType) -> i32 {
    match kind {
        PieceType::Pawn => 100,
        PieceType::Knight => 320,
        PieceType::Bishop => 330,
        PieceType::Rook => 500,
        PieceType::Queen => 900,
        PieceType::King => 0,
    }
}

#[inline]
fn tt_pack_move(mv: Move) -> u32 {
    let promotion = match engine::move_promotion(mv) {
        Some(PieceType::Queen) => 1,
        Some(PieceType::Rook) => 2,
        Some(PieceType::Bishop) => 3,
        Some(PieceType::Knight) => 4,
        _ => 0,
    };
    ((engine::move_from(mv) as u32) << 9) | ((engine::move_to(mv) as u32) << 3) | promotion
}

unsafe fn move_order(mv: Move, tt_move: u32, ply: usize, turn: Color) -> i32 {
    let packed_move = tt_pack_move(mv);
    if packed_move == tt_move {
        return 2_000_000_000;
    }
    if let Some(promotion) = engine::move_promotion(mv) {
        return 1_000_000_000 + ordering_value(promotion);
    }
    if engine::move_is_capture(mv) {
        return 100_000_000
            + 10 * ordering_value(engine::piece_type(engine::move_captured(mv)).unwrap())
            - ordering_value(engine::piece_type(engine::move_piece(mv)).unwrap());
    }
    let killers = context().killers[ply];
    if packed_move == killers[0] {
        return 10_000_000;
    }
    if packed_move == killers[1] {
        return 9_999_999;
    }
    let history_index = engine::move_from(mv) as usize * 64 + engine::move_to(mv) as usize;
    if turn == Color::White {
        context().hist_white[history_index]
    } else {
        context().hist_black[history_index]
    }
}

unsafe fn order_moves(ply: usize, count: usize, tt_move: u32, turn: Color) {
    let mut index = 0;
    while index < count {
        let mv = context().moves[ply][index];
        context().move_scores[ply][index] = move_order(mv, tt_move, ply, turn);
        index += 1;
    }
    index = 1;
    while index < count {
        let mv = context().moves[ply][index];
        let score = context().move_scores[ply][index];
        let mut insertion = index;
        while insertion > 0 && context().move_scores[ply][insertion - 1] < score {
            context().moves[ply][insertion] = context().moves[ply][insertion - 1];
            context().move_scores[ply][insertion] = context().move_scores[ply][insertion - 1];
            insertion -= 1;
        }
        context().moves[ply][insertion] = mv;
        context().move_scores[ply][insertion] = score;
        index += 1;
    }
}

unsafe fn record_quiet_cutoff(mv: Move, ply: usize, depth: i32, turn: Color) {
    let packed_move = tt_pack_move(mv);
    if context().killers[ply][0] != packed_move {
        context().killers[ply][1] = context().killers[ply][0];
        context().killers[ply][0] = packed_move;
    }
    let history_index = engine::move_from(mv) as usize * 64 + engine::move_to(mv) as usize;
    let bonus = depth * depth;
    if turn == Color::White {
        context().hist_white[history_index] =
            context().hist_white[history_index].wrapping_add(bonus);
    } else {
        context().hist_black[history_index] =
            context().hist_black[history_index].wrapping_add(bonus);
    }
}

unsafe fn generate_pseudo_at(position: &Position, ply: usize) -> usize {
    let output = &mut *core::ptr::addr_of_mut!(CONTEXT.moves[ply]);
    engine::generate_pseudo(position, output)
}

unsafe fn has_legal_move(
    position: &mut Position,
    ply: usize,
    existing_count: Option<usize>,
) -> bool {
    let count = match existing_count {
        Some(count) => count,
        None => generate_pseudo_at(position, ply),
    };
    let mover = position.turn;
    let mut index = 0;
    while index < count {
        let mv = context().moves[ply][index];
        let undo = engine::make_move(position, mv);
        let legal = !engine::in_check(position, mover);
        engine::unmake_move(position, mv, undo);
        if legal {
            return true;
        }
        index += 1;
    }
    false
}

fn null_material_safe(position: &Position, turn: Color) -> bool {
    let mut total = 0_u8;
    let mut own = 0_u8;
    let mut square = 0;
    while square < position.board.len() {
        let piece = position.board[square];
        if piece != Piece::Empty {
            let kind = engine::piece_type(piece).unwrap();
            if kind != PieceType::Pawn && kind != PieceType::King {
                total += 1;
                if engine::piece_color(piece) == Some(turn) {
                    own += 1;
                }
            }
        }
        square += 1;
    }
    own > 0 && total >= 4
}

#[derive(Clone, Copy)]
struct NullUndo {
    turn: Color,
    ep: u8,
    halfmove: u16,
    fullmove: u16,
}

fn make_null_move(position: &mut Position) -> NullUndo {
    let undo = NullUndo {
        turn: position.turn,
        ep: position.ep,
        halfmove: position.halfmove,
        fullmove: position.fullmove,
    };
    position.turn = engine::opposite(position.turn);
    position.ep = engine::NO_SQUARE;
    position.halfmove = position.halfmove.saturating_add(1);
    if undo.turn == Color::Black {
        position.fullmove = position.fullmove.saturating_add(1);
    }
    undo
}

fn unmake_null_move(position: &mut Position, undo: NullUndo) {
    position.turn = undo.turn;
    position.ep = undo.ep;
    position.halfmove = undo.halfmove;
    position.fullmove = undo.fullmove;
}

unsafe fn quiesce_node(
    position: &mut Position,
    alpha_initial: i32,
    beta_initial: i32,
    ply: usize,
    qply: usize,
) -> i32 {
    if !check_budget() {
        return ABORT_SCORE;
    }
    context().qnodes += 1;
    context().rep_ply = REP_INFINITY;
    if engine::position_insufficient_material(position) {
        return 0;
    }

    let turn = position.turn;
    let enemy = engine::opposite(turn);
    let maximizing = turn == Color::White;
    let in_check = engine::in_check(position, turn);

    let mut hash = Hash {
        h1: 0,
        h2: 0,
        r1: 0,
        r2: 0,
    };
    let track_repetition = context().in_null == 0 && position.halfmove >= 4;
    if track_repetition {
        hash = hash_position(position);
        if let Some(ancestor) = check_repetition(hash.r1, hash.r2) {
            context().rep_ply = ancestor;
            return 0;
        }
    }

    let mut count = generate_pseudo_at(position, ply);
    if !has_legal_move(position, ply, Some(count)) {
        return if in_check {
            if maximizing {
                -(MATE - ply as i32)
            } else {
                MATE - ply as i32
            }
        } else {
            0
        };
    }
    if position.halfmove >= 100 {
        return 0;
    }
    if qply >= QMAX {
        return eval::evaluate(position);
    }

    let mut alpha = alpha_initial;
    let mut beta = beta_initial;
    let mut best;
    if in_check {
        best = if maximizing { -SCORE_INF } else { SCORE_INF };
    } else {
        best = eval::evaluate(position);
        if maximizing {
            if best >= beta {
                return best;
            }
            if best > alpha {
                alpha = best;
            }
        } else {
            if best <= alpha {
                return best;
            }
            if best < beta {
                beta = best;
            }
        }
    }

    if track_repetition {
        push_path(hash.r1, hash.r2);
    }
    let mut rep_min = REP_INFINITY;

    if !in_check {
        let generate_checks = qply < QCHECK_PLIES;
        let mut filtered = 0;
        let mut index = 0;
        while index < count {
            let mv = context().moves[ply][index];
            let mut keep = engine::move_is_capture(mv) || engine::move_promotion(mv).is_some();
            if !keep && generate_checks {
                let undo = engine::make_move(position, mv);
                keep = engine::in_check(position, enemy);
                engine::unmake_move(position, mv, undo);
            }
            if keep {
                context().moves[ply][filtered] = mv;
                filtered += 1;
            }
            index += 1;
        }
        count = filtered;
    }

    order_moves(ply, count, 0, turn);
    let mut index = 0;
    while index < count {
        let mv = context().moves[ply][index];
        let undo = engine::make_move(position, mv);
        if engine::in_check(position, turn) {
            engine::unmake_move(position, mv, undo);
            index += 1;
            continue;
        }
        let score = quiesce_node(position, alpha, beta, ply + 1, qply + 1);
        let child_rep = context().rep_ply;
        engine::unmake_move(position, mv, undo);
        if score == ABORT_SCORE {
            if track_repetition {
                pop_path();
            }
            return ABORT_SCORE;
        }
        if child_rep < rep_min {
            rep_min = child_rep;
        }
        if maximizing {
            if score > best {
                best = score;
            }
            if best > alpha {
                alpha = best;
            }
        } else {
            if score < best {
                best = score;
            }
            if best < beta {
                beta = best;
            }
        }
        if beta <= alpha {
            break;
        }
        index += 1;
    }

    if track_repetition {
        pop_path();
    }
    context().rep_ply = rep_min;
    best
}

unsafe fn search_node(
    position: &mut Position,
    depth: i32,
    alpha_initial: i32,
    beta_initial: i32,
    ply: usize,
) -> i32 {
    if !check_budget() {
        return ABORT_SCORE;
    }
    context().rep_ply = REP_INFINITY;

    let turn = position.turn;
    let maximizing = turn == Color::White;
    let in_check = engine::in_check(position, turn);
    let fifty = position.halfmove >= 100;
    if fifty && !in_check {
        return 0;
    }
    if engine::position_insufficient_material(position) {
        return 0;
    }

    let mut hash = Hash {
        h1: 0,
        h2: 0,
        r1: 0,
        r2: 0,
    };
    if context().in_null == 0 {
        hash = hash_position(position);
        if let Some(ancestor) = check_repetition(hash.r1, hash.r2) {
            context().rep_ply = ancestor;
            return 0;
        }
    }

    if depth <= 0 {
        if context().quiesce {
            return quiesce_node(position, alpha_initial, beta_initial, ply, 0);
        }
        if !has_legal_move(position, ply, None) {
            return if in_check {
                if maximizing {
                    -(MATE - ply as i32)
                } else {
                    MATE - ply as i32
                }
            } else {
                0
            };
        }
        if fifty {
            return 0;
        }
        return eval::evaluate(position);
    }

    let mut alpha = alpha_initial;
    let mut beta = beta_initial;
    let remaining_to_fifty =
        position.halfmove as i32 + depth + if context().quiesce { QMAX as i32 } else { 0 };
    let use_tt = context().in_null == 0 && remaining_to_fifty < 100;
    let mut tt_move = 0;
    if use_tt {
        let entry = tt_lookup(hash.h1);
        if !entry.is_null() && (*entry).h2 == hash.h2 {
            tt_move = (*entry).mv;
            if (*entry).depth as i32 == depth {
                let mut score = (*entry).score;
                if score > MATE_NEAR {
                    score -= ply as i32;
                } else if score < -MATE_NEAR {
                    score += ply as i32;
                }
                if (*entry).flag == EXACT {
                    return score;
                }
                if (*entry).flag == LOWER {
                    if score >= beta {
                        context().cutoffs += 1;
                        return score;
                    }
                    if score > alpha {
                        alpha = score;
                    }
                } else {
                    if score <= alpha {
                        context().cutoffs += 1;
                        return score;
                    }
                    if score < beta {
                        beta = score;
                    }
                }
                if alpha >= beta {
                    context().cutoffs += 1;
                    return score;
                }
            }
        }
    }

    let alpha_original = alpha;
    let beta_original = beta;

    // Always-verified null-move pruning. Eligibility uses the entry window,
    // before a TT bound can narrow it. The artificial pass cannot touch the
    // TT, repetition paths, killers, or history. A trigger is only a hint:
    // the real position must cross the same bound at depth - 1 before the
    // cutoff is accepted.
    let null_depth = depth - NMP_REDUCTION - 1;
    let entry_null_window = alpha_initial > -SCORE_INF
        && beta_initial < SCORE_INF
        && beta_initial - alpha_initial == 1;
    let null_eligible = context().use_nmp
        && context().quiesce
        && context().in_null == 0
        && context().nmp_disabled == 0
        && entry_null_window
        && depth >= NMP_MIN_DEPTH
        && !in_check
        && alpha_initial > -MATE_NEAR
        && beta_initial < MATE_NEAR
        && null_material_safe(position, turn)
        && (position.halfmove as i32) + 1 + null_depth + (QMAX as i32) < 100;
    if null_eligible {
        let static_score = eval::evaluate(position);
        let static_supports = if maximizing {
            static_score >= beta + NMP_STATIC_MARGIN
        } else {
            static_score <= alpha - NMP_STATIC_MARGIN
        };
        if static_supports {
            let probe_start = context().nodes;
            context().nmp_probes += 1;
            context().in_null += 1;
            context().nmp_disabled += 1;
            let null_undo = make_null_move(position);
            let null_score = if maximizing {
                search_node(position, null_depth, beta - 1, beta, ply + 1)
            } else {
                search_node(position, null_depth, alpha, alpha + 1, ply + 1)
            };
            unmake_null_move(position, null_undo);
            context().in_null -= 1;
            context().nmp_disabled -= 1;
            context().nmp_probe_nodes += context().nodes - probe_start;
            context().rep_ply = REP_INFINITY;
            if null_score == ABORT_SCORE {
                return ABORT_SCORE;
            }

            let triggered = if maximizing {
                null_score >= beta
            } else {
                null_score <= alpha
            };
            if triggered {
                context().nmp_triggers += 1;
                let verify_start = context().nodes;
                context().nmp_disabled += 1;
                let verify_score = if maximizing {
                    search_node(position, depth - 1, beta - 1, beta, ply)
                } else {
                    search_node(position, depth - 1, alpha, alpha + 1, ply)
                };
                let verify_rep = context().rep_ply;
                context().nmp_disabled -= 1;
                context().nmp_verify_nodes += context().nodes - verify_start;
                if verify_score == ABORT_SCORE {
                    return ABORT_SCORE;
                }

                let confirmed = if maximizing {
                    verify_score >= beta
                } else {
                    verify_score <= alpha
                };
                if confirmed {
                    context().nmp_verified_cutoffs += 1;
                    context().cutoffs += 1;
                    context().rep_ply = verify_rep;
                    return if maximizing { beta } else { alpha };
                }
                context().nmp_verification_rejects += 1;
                context().rep_ply = REP_INFINITY;
            }
        }
    }

    let mut best = if maximizing { -SCORE_INF } else { SCORE_INF };
    let mut best_move = 0;
    let mut any_legal = false;
    let mut rep_min = REP_INFINITY;

    if context().in_null == 0 {
        push_path(hash.r1, hash.r2);
    }
    let count = generate_pseudo_at(position, ply);
    order_moves(ply, count, tt_move, turn);

    let mut index = 0;
    while index < count {
        let mv = context().moves[ply][index];
        let undo = engine::make_move(position, mv);
        if engine::in_check(position, turn) {
            engine::unmake_move(position, mv, undo);
            index += 1;
            continue;
        }

        let mut score;
        let mut child_rep;
        if !any_legal {
            score = search_node(position, depth - 1, alpha, beta, ply + 1);
            child_rep = context().rep_ply;
        } else if maximizing {
            score = search_node(position, depth - 1, alpha, alpha + 1, ply + 1);
            child_rep = context().rep_ply;
            if score != ABORT_SCORE && score > alpha && score < beta {
                context().researches += 1;
                score = search_node(position, depth - 1, alpha, beta, ply + 1);
                if context().rep_ply < child_rep {
                    child_rep = context().rep_ply;
                }
            }
        } else {
            score = search_node(position, depth - 1, beta - 1, beta, ply + 1);
            child_rep = context().rep_ply;
            if score != ABORT_SCORE && score < beta && score > alpha {
                context().researches += 1;
                score = search_node(position, depth - 1, alpha, beta, ply + 1);
                if context().rep_ply < child_rep {
                    child_rep = context().rep_ply;
                }
            }
        }
        engine::unmake_move(position, mv, undo);

        if score == ABORT_SCORE {
            if context().in_null == 0 {
                pop_path();
            }
            return ABORT_SCORE;
        }
        any_legal = true;
        if child_rep < rep_min {
            rep_min = child_rep;
        }
        if (maximizing && score > best) || (!maximizing && score < best) {
            best = score;
            best_move = tt_pack_move(mv);
        }
        if maximizing {
            if best > alpha {
                alpha = best;
            }
        } else if best < beta {
            beta = best;
        }
        if beta <= alpha {
            context().cutoffs += 1;
            if context().in_null == 0
                && !engine::move_is_capture(mv)
                && engine::move_promotion(mv).is_none()
            {
                record_quiet_cutoff(mv, ply, depth, turn);
            }
            break;
        }
        index += 1;
    }
    if context().in_null == 0 {
        pop_path();
    }
    context().rep_ply = rep_min;

    if !any_legal {
        if in_check {
            return if maximizing {
                -(MATE - ply as i32)
            } else {
                MATE - ply as i32
            };
        }
        return 0;
    }
    if fifty {
        return 0;
    }

    if use_tt && rep_min as usize >= ply {
        let flag = if best <= alpha_original {
            UPPER
        } else if best >= beta_original {
            LOWER
        } else {
            EXACT
        };
        tt_store(hash.h1, hash.h2, depth, ply, best, flag, best_move);
        if tt_unavailable(context().tt_count, context().tt_saturated) {
            context().tt_saturated = true;
            return ABORT_SCORE;
        }
    }
    best
}

unsafe fn shuffle_root(count: usize) {
    let mut seed = 0x00C0FFEE_u32;
    let mut index = count;
    while index > 1 {
        index -= 1;
        let random = mulberry_next(&mut seed);
        let target = ((random as u64 * (index + 1) as u64) >> 32) as usize;
        core::ptr::swap(root_item(index), root_item(target));
    }
}

fn root_order_score(mv: Move) -> i32 {
    if let Some(promotion) = engine::move_promotion(mv) {
        return 1_000_000_000 + ordering_value(promotion);
    }
    if engine::move_is_capture(mv) {
        return 100_000_000
            + 10 * ordering_value(engine::piece_type(engine::move_captured(mv)).unwrap())
            - ordering_value(engine::piece_type(engine::move_piece(mv)).unwrap());
    }
    0
}

unsafe fn order_initial_root(count: usize) {
    let mut index = 1;
    while index < count {
        let item = *root_item(index);
        let score = root_order_score(item.mv);
        let mut insertion = index;
        while insertion > 0 && root_order_score((*root_item(insertion - 1)).mv) < score {
            *root_item(insertion) = *root_item(insertion - 1);
            insertion -= 1;
        }
        *root_item(insertion) = item;
        index += 1;
    }
}

unsafe fn reorder_root_after_iteration(count: usize, maximizing: bool, best_move: Move) {
    let mut index = 1;
    while index < count {
        let item = *root_item(index);
        let mut insertion = index;
        while insertion > 0
            && if maximizing {
                (*root_item(insertion - 1)).score < item.score
            } else {
                (*root_item(insertion - 1)).score > item.score
            }
        {
            *root_item(insertion) = *root_item(insertion - 1);
            insertion -= 1;
        }
        *root_item(insertion) = item;
        index += 1;
    }

    let mut best_index = 0;
    while best_index < count && (*root_item(best_index)).mv != best_move {
        best_index += 1;
    }
    if best_index < count {
        let best = *root_item(best_index);
        while best_index > 0 {
            *root_item(best_index) = *root_item(best_index - 1);
            best_index -= 1;
        }
        *root_item(0) = best;
    }
}

#[inline]
fn abs_score(score: i32) -> i32 {
    if score < 0 {
        -score
    } else {
        score
    }
}

pub unsafe fn run(
    position: &mut Position,
    max_depth_input: u32,
    node_limit: u32,
    time_ms: u32,
    quiesce: bool,
) -> SearchResult {
    reset_context(quiesce, node_limit, time_ms);
    let max_depth = core::cmp::max(1, max_depth_input);

    let mut root_moves = [0_u32; MAX_MOVES];
    let root_count = engine::generate_root_moves(position, &mut root_moves);
    if root_count == 0
        || position.halfmove >= 100
        || engine::position_insufficient_material(position)
    {
        return SearchResult {
            mv: None,
            score: 0,
            depth: 0,
            attempted_depth: None,
            nodes: 0,
            qnodes: 0,
            cutoffs: 0,
            researches: 0,
            stop_reason: StopReason::GameOver,
            tt_saturated: false,
        };
    }

    let mut index = 0;
    while index < root_count {
        *root_item(index) = RootItem {
            mv: root_moves[index],
            score: 0,
            initial_index: index as u16,
        };
        index += 1;
    }
    shuffle_root(root_count);
    order_initial_root(root_count);

    let root_hash = hash_position(position);
    push_path(root_hash.r1, root_hash.r2);

    let maximizing = position.turn == Color::White;
    let mut best_move = None;
    let mut best_score = 0;
    let mut completed = 0;
    let mut attempted = None;
    let mut stop_reason = StopReason::MaxDepth;

    let mut depth = 1;
    while depth <= max_depth {
        let mut delta = 50;
        let mut low = -SCORE_INF;
        let mut high = SCORE_INF;
        if depth >= 2 && abs_score(best_score) < MATE_NEAR {
            low = best_score - delta;
            high = best_score + delta;
        }

        let mut iteration_best;
        let mut iteration_score;
        let mut aborted = false;
        loop {
            let mut alpha = low;
            let mut beta = high;
            iteration_best = None;
            iteration_score = if maximizing { -SCORE_INF } else { SCORE_INF };

            index = 0;
            while index < root_count {
                let mv = (*root_item(index)).mv;
                let undo = engine::make_move(position, mv);
                let mut score;
                if iteration_best.is_none() {
                    score = search_node(position, depth as i32 - 1, alpha, beta, 1);
                } else if maximizing {
                    score = search_node(position, depth as i32 - 1, alpha, alpha + 1, 1);
                    if score != ABORT_SCORE && score > alpha && score < beta {
                        context().researches += 1;
                        score = search_node(position, depth as i32 - 1, alpha, beta, 1);
                    }
                } else {
                    score = search_node(position, depth as i32 - 1, beta - 1, beta, 1);
                    if score != ABORT_SCORE && score < beta && score > alpha {
                        context().researches += 1;
                        score = search_node(position, depth as i32 - 1, alpha, beta, 1);
                    }
                }
                engine::unmake_move(position, mv, undo);

                if score == ABORT_SCORE {
                    aborted = true;
                    break;
                }
                (*root_item(index)).score = score;
                if iteration_best.is_none()
                    || if maximizing {
                        score > iteration_score
                    } else {
                        score < iteration_score
                    }
                {
                    iteration_score = score;
                    iteration_best = Some(mv);
                }
                if maximizing {
                    if iteration_score > alpha {
                        alpha = iteration_score;
                    }
                } else if iteration_score < beta {
                    beta = iteration_score;
                }
                index += 1;
            }

            if aborted {
                break;
            }
            if iteration_score <= low {
                context().researches += 1;
                delta *= 2;
                low = if delta > 800 {
                    -SCORE_INF
                } else {
                    iteration_score - delta
                };
                continue;
            }
            if iteration_score >= high {
                context().researches += 1;
                delta *= 2;
                high = if delta > 800 {
                    SCORE_INF
                } else {
                    iteration_score + delta
                };
                continue;
            }
            break;
        }

        if aborted {
            if best_move.is_none() && iteration_best.is_some() {
                best_move = iteration_best;
                best_score = iteration_score;
            }
            attempted = Some(depth);
            stop_reason = if context().abort_reason == StopReason::Unknown {
                StopReason::TimeLimit
            } else {
                context().abort_reason
            };
            break;
        }

        best_move = iteration_best;
        best_score = iteration_score;
        completed = depth;
        reorder_root_after_iteration(root_count, maximizing, iteration_best.unwrap());
        if abs_score(best_score) >= MATE_NEAR {
            stop_reason = StopReason::Mate;
            break;
        }
        if depth < max_depth {
            if context().has_deadline && now_ms() >= context().deadline {
                stop_reason = StopReason::TimeLimit;
                break;
            }
            if context().nodes >= context().node_limit {
                stop_reason = StopReason::NodeLimit;
                break;
            }
        }
        depth += 1;
    }

    pop_path();
    if best_move.is_none() {
        best_move = Some((*root_item(0)).mv);
    }
    SearchResult {
        mv: best_move,
        score: best_score,
        depth: completed,
        attempted_depth: attempted,
        nodes: context().nodes,
        qnodes: context().qnodes,
        cutoffs: context().cutoffs,
        researches: context().researches,
        stop_reason,
        tt_saturated: context().tt_saturated,
    }
}

pub fn abi_move(mv: Move) -> u32 {
    let promotion = match engine::move_promotion(mv) {
        Some(PieceType::Queen) => 1,
        Some(PieceType::Rook) => 2,
        Some(PieceType::Bishop) => 3,
        Some(PieceType::Knight) => 4,
        _ => 0,
    };
    engine::move_from(mv) as u32 | ((engine::move_to(mv) as u32) << 6) | (promotion << 12)
}

/// Experiment-only counters read by the deep-search benchmark. The shipped
/// result ABI remains unchanged; an unknown metric index returns zero.
pub unsafe fn experiment_metric(index: u32) -> u64 {
    match index {
        0 => context().nmp_probes,
        1 => context().nmp_triggers,
        2 => context().nmp_verified_cutoffs,
        3 => context().nmp_verification_rejects,
        4 => context().nmp_probe_nodes,
        5 => context().nmp_verify_nodes,
        _ => 0,
    }
}

#[cfg(test)]
mod tt_saturation_tests {
    #[test]
    fn full_table_short_circuits_before_an_unknown_probe() {
        assert!(!super::tt_unavailable(super::TT_CAPACITY - 1, false));
        assert!(super::tt_unavailable(super::TT_CAPACITY, false));
        assert!(super::tt_unavailable(0, true));
    }
}

#[cfg(test)]
mod nmp_tests {
    use super::*;

    const KID: &[u8] =
        b"r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1";
    const KID_MIRRORED: &[u8] =
        b"r1bq1rk1/pp3ppp/2n2n2/2p1p3/3pP3/3P2P1/PPP1N1BP/R1BQ1RK1 b - - 0 1";
    const DEFENCE: &[u8] =
        b"r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27";
    const DEFENCE_MIRRORED: &[u8] =
        b"2r4k/p5p1/3b3p/1p5b/3Ppn1q/1B2N3/1PPQ1PP1/R3R1K1 w - - 0 27";
    const IN_CHECK: &[u8] = b"6k1/5ppp/8/8/8/2N5/6PP/r5K1 w - - 0 1";

    unsafe fn search_window(
        fen: &[u8],
        depth: i32,
        alpha: i32,
        beta: i32,
        enabled: bool,
    ) -> i32 {
        let mut position = engine::parse_fen(fen).unwrap();
        reset_context(true, 0, 0);
        context().use_nmp = enabled;
        search_node(&mut position, depth, alpha, beta, 0)
    }

    #[test]
    fn null_move_restores_position_metadata() {
        let mut position = engine::parse_fen(KID).unwrap();
        let original = position;
        let undo = make_null_move(&mut position);
        assert!(position.turn == Color::Black);
        assert!(position.ep == engine::NO_SQUARE);
        assert!(position.halfmove == original.halfmove + 1);
        unmake_null_move(&mut position, undo);
        assert!(position == original);
    }

    #[test]
    fn depth_and_tactical_guards_preserve_baseline() {
        unsafe {
            let baseline = search_window(KID, 4, 44, 45, false);
            let candidate = search_window(KID, 4, 44, 45, true);
            assert_eq!(candidate, baseline);
            assert_eq!(experiment_metric(0), 0);

            for (fen, alpha, beta) in [
                (IN_CHECK, -1000, -999),
                (DEFENCE, -70, -69),
                (DEFENCE_MIRRORED, 69, 70),
            ] {
                let baseline = search_window(fen, 5, alpha, beta, false);
                let candidate = search_window(fen, 5, alpha, beta, true);
                assert_eq!(candidate, baseline);
                assert_eq!(experiment_metric(0), 0);
            }
        }
    }

    #[test]
    fn sparse_zugzwang_material_never_probes() {
        unsafe {
            let fen = b"8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1";
            let baseline = search_window(fen, 6, -200, -199, false);
            let candidate = search_window(fen, 6, -200, -199, true);
            assert_eq!(candidate, baseline);
            assert_eq!(experiment_metric(0), 0);
        }
    }

    #[test]
    fn eligible_cutoff_is_verified_in_real_position() {
        unsafe {
            for (fen, alpha, beta, maximizing) in
                [(KID, 44, 45, true), (KID_MIRRORED, -45, -44, false)]
            {
                let baseline = search_window(fen, 5, alpha, beta, false);
                let score = search_window(fen, 5, alpha, beta, true);
                if maximizing {
                    assert!(score >= beta && baseline >= beta);
                } else {
                    assert!(score <= alpha && baseline <= alpha);
                }
                assert_eq!(experiment_metric(0), 1);
                assert_eq!(experiment_metric(1), 1);
                assert_eq!(experiment_metric(2), 1);
                assert_eq!(experiment_metric(3), 0);
                assert!(experiment_metric(4) > 0);
                assert!(experiment_metric(5) > 0);
            }
        }
    }

    #[test]
    fn fifty_move_horizon_and_abort_unwinding_are_safe() {
        unsafe {
            let at_last_safe_horizon =
                b"r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 80 1";
            let beyond_safe_horizon =
                b"r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 81 1";
            let _ = search_window(at_last_safe_horizon, 5, 44, 45, true);
            assert_eq!(experiment_metric(0), 1);
            assert_eq!(experiment_metric(2), 1);
            let _ = search_window(beyond_safe_horizon, 5, 44, 45, true);
            assert_eq!(experiment_metric(0), 0);

            let mut position = engine::parse_fen(KID).unwrap();
            let original = position;
            reset_context(true, 500, 0);
            context().use_nmp = true;
            let score = search_node(&mut position, 5, 44, 45, 0);
            assert_eq!(score, ABORT_SCORE);
            assert_eq!(context().nmp_probes, 1);
            assert_eq!(context().nmp_triggers, 1);
            assert_eq!(context().in_null, 0);
            assert_eq!(context().nmp_disabled, 0);
            assert_eq!(context().path_len, 0);
            assert!(position == original);
        }
    }

    #[test]
    fn synthetic_repetition_and_shared_tt_stay_isolated() {
        unsafe {
            let mut position = engine::parse_fen(KID).unwrap();
            reset_context(true, 0, 0);
            context().use_nmp = true;

            let null_undo = make_null_move(&mut position);
            let artificial = hash_position(&mut position);
            unmake_null_move(&mut position, null_undo);
            context().path1[0] = artificial.r1;
            context().path2[0] = artificial.r2;
            context().path_len = 1;

            let score = search_node(&mut position, 5, 44, 45, 0);
            assert_eq!(score, 45);
            assert_eq!(context().nmp_probes, 1);
            assert_eq!(context().nmp_verified_cutoffs, 1);
            assert_eq!(context().path_len, 1);

            context().path_len = 0;
            context().use_nmp = false;
            let warm_exact =
                search_node(&mut position, 4, -SCORE_INF, SCORE_INF, 0);
            assert_ne!(warm_exact, ABORT_SCORE);

            reset_context(true, 0, 0);
            context().use_nmp = false;
            let fresh_exact =
                search_node(&mut position, 4, -SCORE_INF, SCORE_INF, 0);
            assert_eq!(warm_exact, fresh_exact);
        }
    }
}
