#![cfg_attr(not(test), no_std)]
#![allow(static_mut_refs)]

mod engine;
mod eval;
mod search;

use engine::Position;

const ABI_VERSION: u32 = 2;
const RESULT_BYTES: u32 = 64;
const NONE_U32: u32 = 0xffff_ffff;
const INPUT_BYTES: usize = 1024;
const HISTORY_INPUT_BYTES: usize = 64 * 1024;

#[repr(C)]
#[derive(Clone, Copy)]
struct AbiResult {
    abi_version: u32,
    struct_bytes: u32,
    mv: u32,
    score: i32,
    depth: u32,
    attempted_depth: u32,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    stop_reason: u32,
    reserved: u32,
}

const _: [(); RESULT_BYTES as usize] = [(); core::mem::size_of::<AbiResult>()];

static mut INPUT_BUFFER: [u8; INPUT_BYTES] = [0; INPUT_BYTES];
static mut ROOT_POSITION: Position = Position::EMPTY;
static mut POSITION_LOADED: bool = false;
static mut SEARCH_ACTIVE: bool = false;
static mut ANALYSIS_READY: bool = false;
static mut RESULT: AbiResult = AbiResult {
    abi_version: ABI_VERSION,
    struct_bytes: RESULT_BYTES,
    mv: NONE_U32,
    score: 0,
    depth: 0,
    attempted_depth: NONE_U32,
    nodes: 0,
    qnodes: 0,
    cutoffs: 0,
    researches: 0,
    stop_reason: search::StopReason::Unknown as u32,
    reserved: 0,
};

#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[no_mangle]
pub extern "C" fn input_ptr() -> u32 {
    core::ptr::addr_of_mut!(INPUT_BUFFER).cast::<u8>() as usize as u32
}

#[no_mangle]
pub extern "C" fn result_ptr() -> u32 {
    core::ptr::addr_of_mut!(RESULT) as usize as u32
}

#[no_mangle]
pub extern "C" fn history_ptr() -> u32 {
    search::history_input_ptr() as usize as u32
}

#[no_mangle]
pub extern "C" fn pv_ptr() -> u32 {
    search::pv_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn pv_len() -> u32 {
    search::pv_len()
}

unsafe fn store_result(search_result: &search::SearchResult) {
    RESULT = AbiResult {
        abi_version: ABI_VERSION,
        struct_bytes: RESULT_BYTES,
        mv: search_result.mv.map(search::abi_move).unwrap_or(NONE_U32),
        score: search_result.score,
        depth: search_result.depth,
        attempted_depth: search_result.attempted_depth.unwrap_or(NONE_U32),
        nodes: search_result.nodes,
        qnodes: search_result.qnodes,
        cutoffs: search_result.cutoffs,
        researches: search_result.researches,
        stop_reason: search_result.stop_reason as u32,
        reserved: 0,
    };
}

/// Returns 0 on success, 1 when the input is too long, 2 for invalid FEN, and
/// 3 when mutation is rejected during an active search.
#[no_mangle]
pub unsafe extern "C" fn load_position(length: u32) -> i32 {
    if SEARCH_ACTIVE {
        return 3;
    }
    let fen_length = length as usize;
    if fen_length > INPUT_BYTES {
        return 1;
    }
    let fen =
        core::slice::from_raw_parts(core::ptr::addr_of!(INPUT_BUFFER).cast::<u8>(), fen_length);
    let Some(position) = engine::parse_fen(fen) else {
        return 2;
    };
    ROOT_POSITION = position;
    POSITION_LOADED = true;
    ANALYSIS_READY = false;
    search::clear_game_history();
    0
}

/// Loads newline-delimited repetition FENs, one line per occurrence. Returns
/// 0 on success, 1 when the fixed buffer/table capacity is exceeded, 2 for an
/// invalid FEN line, and 3 during a re-entrant search.
#[no_mangle]
pub unsafe extern "C" fn load_history(length: u32) -> i32 {
    if SEARCH_ACTIVE {
        return 3;
    }
    let byte_length = length as usize;
    if byte_length > HISTORY_INPUT_BYTES {
        return 1;
    }
    let input = core::slice::from_raw_parts(
        search::history_input_ptr().cast_const(),
        byte_length,
    );
    ANALYSIS_READY = false;
    match search::load_game_history(input) {
        Ok(()) => 0,
        Err(search::HistoryError::Capacity) => 1,
        Err(search::HistoryError::InvalidFen) => 2,
    }
}

/// Returns 0 on success, 1 when no position is loaded, 2 if the fixed
/// transposition table saturated, and 3 for an invalid depth or re-entry.
#[no_mangle]
pub unsafe extern "C" fn search(
    max_depth: u32,
    node_limit: u32,
    time_ms: u32,
    quiesce: u32,
) -> i32 {
    if max_depth > search::MAX_SEARCH_DEPTH || SEARCH_ACTIVE {
        return 3;
    }
    if !POSITION_LOADED {
        return 1;
    }
    let mut position = ROOT_POSITION;
    ANALYSIS_READY = false;
    SEARCH_ACTIVE = true;
    let search_result = search::run(&mut position, max_depth, node_limit, time_ms, quiesce != 0);
    SEARCH_ACTIVE = false;
    store_result(&search_result);
    if search_result.tt_saturated {
        2
    } else {
        0
    }
}

/// Starts one shared root-verification phase. Zero node_limit means unlimited,
/// matching `search`. Returns 0 on success, 1 without a loaded position, and 3
/// on re-entry.
#[no_mangle]
pub unsafe extern "C" fn analysis_begin(node_limit: u32, quiesce: u32) -> i32 {
    if SEARCH_ACTIVE {
        return 3;
    }
    if !POSITION_LOADED {
        return 1;
    }
    SEARCH_ACTIVE = true;
    search::begin_analysis(node_limit, quiesce != 0);
    SEARCH_ACTIVE = false;
    ANALYSIS_READY = true;
    0
}

/// Scores one ABI-packed legal root at total depth >=1 under a full window.
/// Counters and budget are cumulative since `analysis_begin`. Returns 0 for a
/// complete exact root, 1 when not initialized, 2 on TT saturation, 3 for an
/// invalid move/depth or re-entry, and 4 when the shared node budget aborts.
#[no_mangle]
pub unsafe extern "C" fn analysis_root(
    packed_move: u32,
    total_depth: u32,
    requested_pv_len: u32,
) -> i32 {
    if SEARCH_ACTIVE {
        return 3;
    }
    if !POSITION_LOADED || !ANALYSIS_READY {
        return 1;
    }
    SEARCH_ACTIVE = true;
    let mut position = ROOT_POSITION;
    let outcome =
        search::analyse_root(&mut position, packed_move, total_depth, requested_pv_len);
    SEARCH_ACTIVE = false;
    store_result(&outcome.result);
    match outcome.status {
        search::AnalysisStatus::Complete => 0,
        search::AnalysisStatus::TtSaturated => 2,
        search::AnalysisStatus::Invalid => 3,
        search::AnalysisStatus::Budget => 4,
    }
}

/// Static white-POV evaluation of the loaded position. Callers must first
/// establish a position with `load_position`.
#[no_mangle]
pub unsafe extern "C" fn evaluate_loaded() -> i32 {
    if !POSITION_LOADED || SEARCH_ACTIVE {
        return 0;
    }
    eval::evaluate(&ROOT_POSITION)
}

/// Deterministic full-window score of the loaded root. Depth zero is allowed.
/// Status codes match `analysis_root`; the result move is always NONE.
#[no_mangle]
pub unsafe extern "C" fn fixed_search(depth: u32, node_limit: u32, quiesce: u32) -> i32 {
    if SEARCH_ACTIVE || depth > search::MAX_SEARCH_DEPTH {
        return 3;
    }
    if !POSITION_LOADED {
        return 1;
    }
    ANALYSIS_READY = false;
    SEARCH_ACTIVE = true;
    let mut position = ROOT_POSITION;
    let search_result = search::run_fixed(&mut position, depth, node_limit, quiesce != 0);
    SEARCH_ACTIVE = false;
    store_result(&search_result);
    if search_result.tt_saturated {
        2
    } else if search_result.stop_reason == search::StopReason::NodeLimit {
        4
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn abi_v2_layout_and_depth_guard_are_fixed() {
        let _guard = super::TEST_LOCK.lock().unwrap();
        assert_eq!(super::ABI_VERSION, 2);
        assert_eq!(super::RESULT_BYTES as usize, core::mem::size_of::<super::AbiResult>());
        assert_eq!(super::HISTORY_INPUT_BYTES, 64 * 1024);
        unsafe {
            assert_eq!(
                super::search(super::search::MAX_SEARCH_DEPTH + 1, 0, 0, 1),
                3
            );
        }
    }
}
