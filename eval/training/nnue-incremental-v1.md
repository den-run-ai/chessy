# Prospective incremental NNUE mechanism study

This is the final bounded synthetic runtime mechanism study in this work. It
compares H4/H8 incremental accumulators with newly measured, concurrent fused
controls. It does not replace or pool the prior canonical run 34919106656, and
accepts no trained parameters or sealed-data input. The machine contract is
[nnue-incremental-v1.json](nnue-incremental-v1.json). Publish this protocol and
implementation before any timing run; no timing results are currently claimed.

Only copied research crates change. Incremental copies add two unclamped int32
accumulator arrays to `Position`, initialized from the fixed hidden bias. A
single helper subtracts the old square's features and adds the new piece's
features. The adapter accounts for all 16 original board writes: seven in
`make_move`, eight in `unmake_move`, and one in FEN loading. Captures, castling,
en passant and promotions therefore share the same mutation path. Rook values
are captured before a mutable borrow. Cache orientation is independent of side
to move; taper, clipping, integer rounding and HCE mop-up remain unchanged.

`Undo` and search code do not change. Position copies carry their own arrays;
there is no separate mutable global cache. Payload grows by 32 bytes for H4 and
64 for H8, but Rust alignment can add padding. Both copied controls export the
actual Position/Undo sizes, and the result reports measured Position growth,
module bytes and fixed memory. The one-page research allowance remains
26,607,616 bytes versus production's unchanged 26,542,080-byte cap.

All four variants must build and pass native tests before measurement begins.
The runner then validates source closure and compiled static parity for the
entire grid before collecting its first timing sample. Native tests independently
refresh every raw accumulator after parsed positions and nested legal moves;
they check exact restoration after legal generation, EP legality probes and
unmake. Explicit nonzero coverage counters require both colors, both castle
directions for both colors, EP, captures, and every Q/R/B/N promotion, including
quiet and capture promotions. Pinned EP rejection is also covered. The engine
has no null-move pruning; a turn-only test verifies side-independent cache state.

The complete study is H4 fused, H4 incremental, H8 fused, H8 incremental on one
runner. Each uses the original eight positions, four alternating paired
repetitions against shipped HCE, 1,000 warm-up plus 10,000 measured evaluation
calls, and 4,096/16,384-node search budgets. Six positions are endgames: every
interpretation must retain per-position results and disclose that bias. The
fused and incremental implementations at each width must also produce identical
complete fixed-node search signatures. All four configurations publish together;
incomplete grids cannot be scored or assembled from separate runs.
If the complete measured grid fails the final cross-mechanism signature check,
the report retains every raw record with `status: failed` and the failure reason;
CI fails and that study remains invalid rather than silently discarding it.

Incremental updates execute during legality probes as well as searched moves.
Their extra make/unmake work and larger copied Position can outweigh saved
evaluation work. Performance and module-size benefits therefore remain an
empirical question. No outcome authorizes production integration, device
acceptance, trained-model strength or an Elo/time saturation claim.

The optional CI step runs only for `nnue_incremental_probe=true` on manual
dispatch or the distinct `nnue-incremental-probe` PR label. Label only immediately
before the frozen source push, and remove it after the canonical completed run.
The previous probe code and template remain untouched.
