//! Raw browser ABI for the isolated Chessy Zig/WASM feasibility experiment.

const engine = @import("engine.zig");
const search_core = @import("search.zig");

const ABI_VERSION: u32 = 1;
const RESULT_BYTES: u32 = 64;
const NONE_U32: u32 = 0xffffffff;
const INPUT_BYTES: usize = 1024;

const AbiResult = extern struct {
    abi_version: u32,
    struct_bytes: u32,
    move: u32,
    score: i32,
    depth: u32,
    attempted_depth: u32,
    nodes: u64,
    qnodes: u64,
    cutoffs: u64,
    researches: u64,
    stop_reason: u32,
    reserved: u32,
};

comptime {
    if (@sizeOf(AbiResult) != RESULT_BYTES) {
        @compileError("unexpected WASM result ABI layout");
    }
}

var input_buffer: [INPUT_BYTES]u8 = undefined;
var root_position: engine.Position = undefined;
var position_loaded = false;
var result: AbiResult = .{
    .abi_version = ABI_VERSION,
    .struct_bytes = RESULT_BYTES,
    .move = NONE_U32,
    .score = 0,
    .depth = 0,
    .attempted_depth = NONE_U32,
    .nodes = 0,
    .qnodes = 0,
    .cutoffs = 0,
    .researches = 0,
    .stop_reason = @intFromEnum(search_core.StopReason.unknown),
    .reserved = 0,
};

export fn input_ptr() u32 {
    return @intCast(@intFromPtr(&input_buffer));
}

export fn result_ptr() u32 {
    return @intCast(@intFromPtr(&result));
}

/// Returns 0 on success, 1 when the input is too long, and 2 for invalid FEN.
export fn load_position(length: u32) i32 {
    const fen_length: usize = @intCast(length);
    if (fen_length > input_buffer.len) return 1;
    root_position = engine.parseFen(input_buffer[0..fen_length]) catch return 2;
    position_loaded = true;
    return 0;
}

/// Returns 0 on success, 1 when no position is loaded, and 2 if the fixed
/// transposition table saturated (which invalidates exact-tree comparison).
export fn search(max_depth: u32, node_limit: u32, time_ms: u32, quiesce: u32) i32 {
    if (!position_loaded) return 1;

    var position = root_position;
    const search_result = search_core.run(
        &position,
        max_depth,
        node_limit,
        time_ms,
        quiesce != 0,
    );
    result = .{
        .abi_version = ABI_VERSION,
        .struct_bytes = RESULT_BYTES,
        .move = if (search_result.move) |move| search_core.abiMove(move) else NONE_U32,
        .score = search_result.score,
        .depth = search_result.depth,
        .attempted_depth = search_result.attempted_depth orelse NONE_U32,
        .nodes = search_result.nodes,
        .qnodes = search_result.qnodes,
        .cutoffs = search_result.cutoffs,
        .researches = search_result.researches,
        .stop_reason = @intFromEnum(search_result.stop_reason),
        .reserved = 0,
    };

    return if (search_result.tt_saturated) 2 else 0;
}
