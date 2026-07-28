#![cfg_attr(not(test), no_std)]
#![allow(static_mut_refs)]

mod engine;
mod eval;
mod search;

use engine::Position;

const ABI_VERSION: u32 = 1;
const RESULT_BYTES: u32 = 64;
const NONE_U32: u32 = 0xffff_ffff;
const INPUT_BYTES: usize = 1024;

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
    0
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
    SEARCH_ACTIVE = true;
    let search_result = search::run(&mut position, max_depth, node_limit, time_ms, quiesce != 0);
    SEARCH_ACTIVE = false;
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
    if search_result.tt_saturated {
        2
    } else {
        0
    }
}

/// Optional algorithm-experiment telemetry from the most recent search.
///
/// Index 0 is guarded-LMR applications and index 1 is the number of reduced
/// scouts that improved the bound and therefore received mandatory full-depth
/// verification. Unknown indexes return zero. The stable v1 result record is
/// intentionally unchanged.
#[no_mangle]
pub unsafe extern "C" fn experiment_metric(index: u32) -> u64 {
    search::experiment_metric(index)
}

#[cfg(test)]
mod tests {
    #[test]
    fn exported_search_rejects_depth_beyond_fixed_storage() {
        unsafe {
            assert_eq!(
                super::search(super::search::MAX_SEARCH_DEPTH + 1, 0, 0, 1),
                3
            );
        }
    }
}
