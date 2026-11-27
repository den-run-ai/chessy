//! Research-only fixed-memory WASM bridge for the shared sparse v2 evaluator.
//! No WASI, allocator, threads, production asset changes, or JS evaluator.
#![no_std]
#![allow(dead_code, static_mut_refs)]

#[path = "../sparse_eval/baseline/engine.rs"]
mod engine;
#[path = "../sparse_eval/baseline/eval.rs"]
mod baseline;
#[path = "../sparse_eval/baseline/search.rs"]
mod search;
#[path = "core.rs"]
mod model;
mod simd;

use engine::{Piece, Position};
use model::{EvalCache, Model, Variant};

const ABI_VERSION: u32 = 1;
const INPUT_BYTES: usize = 1024 * 1024;
const MAX_POSITIONS: usize = 4096;
const NONE: u32 = u32::MAX;

static mut INPUT: [u8; INPUT_BYTES] = [0; INPUT_BYTES];
static mut MODEL: Model = Model::ZERO;
static mut MODEL_READY: bool = false;
static mut CACHE: EvalCache = EvalCache::ZERO;
static mut POSITIONS: [Position; MAX_POSITIONS] = [Position::EMPTY; MAX_POSITIONS];
static mut SCORES: [i32; MAX_POSITIONS] = [0; MAX_POSITIONS];
static mut POSITION_COUNT: usize = 0;
static mut CURRENT_VARIANT: u32 = 0;
static mut BUSY: bool = false;

#[repr(C)]
struct SearchRecord {
    abi: u32,
    bytes: u32,
    mv: u32,
    score: i32,
    depth: u32,
    attempted_depth: u32,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    stop_reason: u32,
    flags: u32,
}

const _: [(); 64] = [(); core::mem::size_of::<SearchRecord>()];
static mut RESULT: SearchRecord = SearchRecord {
    abi: ABI_VERSION, bytes: 64, mv: NONE, score: 0, depth: 0,
    attempted_depth: NONE, nodes: 0, qnodes: 0, cutoffs: 0,
    researches: 0, stop_reason: 0, flags: 0,
};

mod eval {
    pub fn evaluate(position: &crate::engine::Position) -> i32 {
        unsafe { crate::score(position, crate::CURRENT_VARIANT) }
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

unsafe fn score(position: &Position, variant: u32) -> i32 {
    match variant {
        0 => baseline::evaluate(position),
        1 => MODEL.evaluate(position, Variant::Compact),
        2 => MODEL.evaluate(position, Variant::Fused),
        3 => CACHE.evaluate(&MODEL, position),
        _ => unreachable!(),
    }
}

unsafe fn variant_valid(variant: u32) -> bool {
    variant <= 3 && (variant == 0 || MODEL_READY)
}

fn valid_position(fen: &[u8]) -> Option<Position> {
    let p = engine::parse_fen(fen)?;
    if p.board.iter().filter(|&&x| x == Piece::WhiteKing).count() != 1
        || p.board.iter().filter(|&&x| x == Piece::BlackKing).count() != 1 {
        return None;
    }
    Some(p)
}

#[no_mangle]
pub extern "C" fn research_abi_version() -> u32 { ABI_VERSION }
#[no_mangle]
pub extern "C" fn input_ptr() -> u32 { core::ptr::addr_of_mut!(INPUT).cast::<u8>() as u32 }
#[no_mangle]
pub extern "C" fn input_capacity() -> u32 { INPUT_BYTES as u32 }
#[no_mangle]
pub extern "C" fn positions_capacity() -> u32 { MAX_POSITIONS as u32 }
#[no_mangle]
pub unsafe extern "C" fn positions_count() -> u32 { POSITION_COUNT as u32 }
#[no_mangle]
pub extern "C" fn scores_ptr() -> u32 { core::ptr::addr_of_mut!(SCORES).cast::<u8>() as u32 }
#[no_mangle]
pub extern "C" fn result_ptr() -> u32 { core::ptr::addr_of_mut!(RESULT).cast::<u8>() as u32 }
#[no_mangle]
pub extern "C" fn model_resident_bytes() -> u32 { core::mem::size_of::<Model>() as u32 }
#[no_mangle]
pub extern "C" fn model_coefficient_bytes() -> u32 { model::COEFFICIENT_BYTES as u32 }
#[no_mangle]
pub extern "C" fn cache_resident_bytes() -> u32 { core::mem::size_of::<EvalCache>() as u32 }
#[no_mangle]
pub unsafe extern "C" fn cache_hits() -> u64 { CACHE.stats().0 }
#[no_mangle]
pub unsafe extern "C" fn cache_misses() -> u64 { CACHE.stats().1 }
#[no_mangle]
pub unsafe extern "C" fn clear_cache() -> i32 {
    if BUSY { return -1; }
    CACHE.clear();
    0
}
#[no_mangle]
pub extern "C" fn simd_compiled() -> u32 {
    (cfg!(v2_simd) && simd::HAS_EXPLICIT_SIMD) as u32
}

/// Status: 0 success; -1 busy; -2 length; -3 model; -4 FEN/count;
/// -5 invalid or unloaded variant; -6 history; -7 search budget.
#[no_mangle]
pub unsafe extern "C" fn load_model(length: u32) -> i32 {
    if BUSY { return -1; }
    MODEL_READY = false;
    CACHE.clear();
    if length as usize > INPUT_BYTES { return -2; }
    let bytes = core::slice::from_raw_parts(core::ptr::addr_of!(INPUT).cast::<u8>(), length as usize);
    match MODEL.load_dense(bytes) {
        Ok(()) => { MODEL_READY = true; 0 },
        Err(_) => -3,
    }
}

#[no_mangle]
pub unsafe extern "C" fn load_positions(length: u32) -> i32 {
    if BUSY { return -1; }
    POSITION_COUNT = 0;
    CACHE.clear();
    search::clear_game_history();
    if length as usize > INPUT_BYTES { return -2; }
    let bytes = core::slice::from_raw_parts(core::ptr::addr_of!(INPUT).cast::<u8>(), length as usize);
    let mut count = 0;
    for raw in bytes.split(|&c| c == b'\n') {
        let fen = if raw.last() == Some(&b'\r') { &raw[..raw.len()-1] } else { raw };
        if fen.is_empty() { continue; }
        if count >= MAX_POSITIONS { return -4; }
        let Some(position) = valid_position(fen) else { return -4; };
        POSITIONS[count] = position;
        count += 1;
    }
    if count == 0 { return -4; }
    POSITION_COUNT = count;
    0
}

#[no_mangle]
pub unsafe extern "C" fn load_history(length: u32) -> i32 {
    if BUSY { return -1; }
    if length as usize > INPUT_BYTES { return -2; }
    let bytes = core::slice::from_raw_parts(core::ptr::addr_of!(INPUT).cast::<u8>(), length as usize);
    match search::load_game_history(bytes) { Ok(()) => 0, Err(_) => -6 }
}

#[no_mangle]
pub unsafe extern "C" fn eval_positions(variant: u32) -> i32 {
    if BUSY { return -1; }
    if !variant_valid(variant) { return -5; }
    if POSITION_COUNT == 0 { return -4; }
    for i in 0..POSITION_COUNT { SCORES[i] = score(&POSITIONS[i], variant); }
    0
}

/// Timed by the host around one call. All repeated evaluation stays in WASM;
/// parsing, copying, compilation and instantiation are outside this loop.
#[no_mangle]
pub unsafe extern "C" fn bench_positions(passes: u32, variant: u32) -> i64 {
    if BUSY || !variant_valid(variant) || POSITION_COUNT == 0 || passes == 0 || passes > 1_000_000 {
        return i64::MIN;
    }
    BUSY = true;
    let mut checksum = 0_i64;
    for _ in 0..passes {
        for i in 0..POSITION_COUNT {
            let position = core::hint::black_box(&POSITIONS[i]);
            checksum += core::hint::black_box(score(position, variant)) as i64;
        }
    }
    BUSY = false;
    checksum
}

#[no_mangle]
pub unsafe extern "C" fn search_position(index: u32, variant: u32, depth: u32,
                                        node_limit: u32, time_ms: u32) -> i32 {
    if BUSY { return -1; }
    if !variant_valid(variant) { return -5; }
    if index as usize >= POSITION_COUNT { return -4; }
    if depth == 0 || depth > search::MAX_SEARCH_DEPTH || (node_limit == 0 && time_ms == 0) {
        return -7;
    }
    BUSY = true;
    CURRENT_VARIANT = variant;
    CACHE.clear();
    let mut position = POSITIONS[index as usize];
    let result = search::run(&mut position, depth, node_limit, time_ms, true);
    RESULT = SearchRecord {
        abi: ABI_VERSION, bytes: 64,
        mv: result.mv.map(search::abi_move).unwrap_or(NONE),
        score: result.score, depth: result.depth,
        attempted_depth: result.attempted_depth.unwrap_or(NONE),
        nodes: result.nodes, qnodes: result.qnodes, cutoffs: result.cutoffs,
        researches: result.researches, stop_reason: result.stop_reason as u32,
        flags: result.tt_saturated as u32,
    };
    BUSY = false;
    0
}
