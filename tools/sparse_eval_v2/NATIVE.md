# Exact native evaluator variants

This directory is a research continuation of sparse PeSTO v1. It does not
change production Rust/WASM, app assets, the fitted v1 coefficients, or any v1
receipt. Both the native and WASM adapters use `core.rs` and the immutable r84
engine/search/evaluator under `../sparse_eval/baseline/`.

## The bounded implementation grid

| Variant | Changes | Numeric contract |
| --- | --- | --- |
| `compact` | Interleaved MG/EG `i8` lookup pairs; fused PST/own-king values; original HCE called separately | Exact original coefficients, arithmetic and two rounding steps |
| `fused` | Shares board analysis, pawn masks, phase, and adjacent occupied geometry with HCE | Exact original HCE plus exact original residual |
| `cached` | `fused` plus a direct-mapped 1,024-entry static-evaluation cache | Hash lookup followed by equality of all 64 board bytes and both king squares |

Each variant has a portable native build and an explicit SSE2 occupancy-mask
build. The corresponding WASM builds use scalar operations or `simd128`.
Compiler auto-vectorization is not disabled on native x86-64; “scalar” here
means that the explicit occupancy-mask SIMD helper is not selected. No claim
about SIMD speed follows from compiling the helper: runtime measurements must
compare the frozen binaries.

The full model stores 16,712 coefficient bytes: 6,144 PST/own-king bytes,
6,144 enemy-king bytes, 3,072 pawn-context bytes, and 1,352 paired-ray bytes.
Four active-family flags bring `Model` to 16,716 bytes. Original dense weights
are consumed at load and are not retained by `Model`.

Some existing models have fused PST/own-king values outside the `i8` range even
when each original coefficient fits. `--cfg v2_wide_fused` uses `i16` for this
table only, producing a 22,856-byte coefficient payload and 22,860-byte model.
This separately identified build preserves the original king-only model's
fused minimum of −134. Loaders reject unrepresentable values; they never clip,
round, or silently change precision. Dense little-endian `i16` and strict
sorted `SPV1` inputs are supported.

These counts describe the coefficient tables, not total process memory. The
fused evaluator also uses immutable geometry/HCE tables. The cache occupies
73,752 bytes, including exact keys, scores, generation tags and counters. The
bridge retains the original large search transposition table and reserves the
cache even when a different evaluation variant is selected.

## Why the fused arithmetic stays exact

The baseline and residual retain separate accumulators. HCE uses the original
`floor(x + 0.5)` rounding, including negative ties; the residual rounds ties
away from zero. Their rounded results are added only afterward. Combining the
two numerators before rounding would change scores and is not done here.

Sliding mobility starts with the distance to the edge in each allowed piece
direction. An ascending a1-to-h8 traversal connects adjacent occupied squares
on each rank, file and diagonal. For each pair, the algorithm subtracts both
occluded tails, including the blocker square for a friendly blocker and
allowing the blocker square for an enemy. This equals the original ray walk,
including pseudo-attacks on an enemy king. The same adjacent pair supplies
both directed sparse ray features. Pawn and king pieces still participate in
geometric residual relationships; their HCE mobility slope is zero.

Knights use an exact precomputed attack mask minus friendly occupied squares.
Pawn masks preserve doubled, isolated, passed and shield terms. The original
endgame mop-up term and capped phase remain unchanged. HCE constants are
generated from the authenticated r84 source by `generate_hce_constants.py`;
`--check` verifies the generated file against those bytes.

The original coefficients are bounded to `i8`, paired sums are checked to
`i8`, and the optional wide fused sums are bounded by the sum of two `i8`
values. With at most 64 occupied squares, the residual and phase-weighted
numerator fit comfortably in `i32`; no saturating arithmetic is used.

The cache returns a score only after the full key compares equal. A hash
collision therefore causes a miss or replacement, never a wrong score.
Static evaluation does not depend on side to move, castling rights, en passant,
or move counters. The search continues to handle repetition and fifty-move
draws before evaluation. Cache generations are cleared for each search or
model change; generation wrap clears every tag. The unit tests deliberately
put a wrong board in a matching cache slot and exercise generation wrap.

## Native commands

Build with the pinned compiler and a fresh output directory:

```sh
python3 tools/sparse_eval_v2/build_native.py \
  --rustc /path/to/pinned/rustc \
  --output /absolute/new-output-directory
```

The build script requires Rust 1.97.1 at its pinned commit. It retains the exact
source bytes, compiles scalar and SSE2 binaries with `opt-level=3`, `lto=fat`,
`codegen-units=1`, and `panic=abort`, authenticates the source snapshot, and
publishes `build.json` last. `--wide-fused` creates a separate wide-table build.

The binaries accept one six-field FEN per input line:

```text
binary metadata
binary baseline
binary eval weights.i16le fused
binary parts weights.i16le fused
binary bench weights.i16le fused PASSES [WARMUP_PASSES=1]
binary search weights.i16le fused NODES [MAX_DEPTH=30] [ORDER_OFFSET=0] [WARMUP_CYCLES=0]
binary serve weights.i16le fused
```

`eval` prints original HCE, candidate and residual scores. `parts` prints the
fused implementation's separately computed HCE and residual, so both rounding
paths can be checked. `search` emits paired HCE/candidate fixed-node results
with the same empty-history static-root contract as v1. Complete games must
use `serve`.

`bench` measures whole batches inside the process. Its cached mode retains
entries across repeated passes and therefore measures a hot-cache workload;
that result is distinct from search cost. It emits hit/miss counts. Fixed-node
search, actual equal-time games, and static batches are separate evidence.

The cost protocol supplies 128 static warm-up passes, excluded from the timer
and checksum. Search warm-up uses the four authored FENs in `COST-CONFIG.json`,
10,000 nodes, depth 30, HCE followed by candidate, and four cycles: 32 requests
before measurement. Both modes start with empty game history and a cleared
evaluation cache on every warm-up and measured search. Warm-up search results
are not emitted. `ORDER_OFFSET` changes only the measured HCE/candidate order:
even `row + offset` runs HCE first, odd runs candidate first. Output records
the actual warm-up request count and order offset for auditing. Defaults retain
the original bridge's one static warm-up pass, zero search warm-up cycles and
zero order offset.

## Persistent full-game protocol

Start the process once with `binary serve WEIGHTS VARIANT`. Each request is
one line with exactly these ten tab-separated fields:

```text
SEARCH    id    mode    nodes    time_ms    max_depth    root_seed    initial_fen    expected_final_fen    uci_moves
```

The spaces above show field boundaries; actual separators are tabs. `mode` is
`hce` or `candidate`. `uci_moves` is the complete space-separated legal history
from the supplied initial FEN and may be empty. Both FENs include all six
fields. At least one budget is positive; a zero node/time budget means that
particular limit is disabled. The pinned r84 search has fixed root ordering,
so `root_seed` must be exactly `0`; nonzero seeds are rejected.

The adapter legally replays every supplied move, verifies equality with the
expected full root FEN, and loads every position occurrence, including the
initial position and current root. The pinned history table admits at most
768 occurrences. The search resets transposition-table generation, killers,
move-history heuristics and evaluation cache on every request. No previous
process request contributes game history implicitly.

One JSON response is flushed per request. It includes `id`, `move`, `score`,
`scorePov: "white"`, `depth`, `attempted_depth`, `nodes`, `qnodes`, `cutoffs`,
`researches`, `stop_reason`, `tt_saturated`, `elapsed_ns`, `replay_ns`,
`verifiedFen`, `root_fen`, `history_occurrences` and `mode`. Stop reasons are
`unknown`, `max_depth`, `time_limit`, `node_limit`, `mate` or `game_over`.
Invalid requests return an `error` and do not run a search.

`elapsed_ns` covers search, including the engine's normal per-request reset;
replay is measured separately. A host must also record request round-trip wall
time. Equal-time work is a diagnostic, not a claim about physical-device
speed, human Elo, or the current production release.

## Verification and profiling

```sh
SPARSE_EVAL_RUSTC=/path/to/pinned/rustc \
  python3 test/training/sparse-v2-native.test.py
python3 tools/sparse_eval_v2/generate_hce_constants.py --check
```

The ten focused Python tests include four Rust unit contracts, full-model and
family-specific coefficients, 1,550 authored/generated/piece-pair boards,
color orientation, scalar/SSE2 parity, separate HCE rounding, fixed-node search
signatures, special-move replay, twofold versus threefold history, malformed
requests, zero-model search parity, the wide king-model path, and timing-control
smoke checks that exclude warm-ups and preserve search signatures. The
`verify_native.py` correctness receipt additionally authenticates all 100,164
validation FENs and saved v1 full-model scores, then checks the complete native
grid and fixed-node signatures on the existing 24 roots. It never reads
teacher labels or uses timing observations as a selection rule.

Before implementation, `profile_v1.py` instrumented 24 existing roots at
10,000 nodes. Across 143,090 candidate evaluations, average occupancy was
17.91 pieces and 9.59 pawns. The baseline and residual took approximately
53% and 47% of instrumented component time. Repeated exact boards accounted
for 33.95% of calls within a search; a 1,024-slot direct cache would have hit
22.27%. Per-call clock/locking overhead means these component times are
profiling diagnostics, not a runtime benchmark. These observations motivated
the three implementation variants before their cost comparison.
