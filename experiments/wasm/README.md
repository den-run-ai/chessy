# Chessy Rust/WASM engine

This directory contains Chessy's production search engine. Rust owns position
state, move generation, make/unmake, attack detection, tapered evaluation,
quiescence, the fixed transposition table, move ordering, PVS, aspiration,
iterative deepening, repetition-aware Play search, and exact-root coaching
analysis.

JavaScript is limited to ABI transport, canonical SAN/PV formatting, UI, and
worker lifecycle. There is no JavaScript search fallback.

## Reproducible build

The build pins:

- Rust 1.97.1, rustc commit
  `8bab26f4f68e0e26f0bb7960be334d5b520ea452`;
- target `wasm32-unknown-unknown`;
- Binaryen 131.

`Cargo.lock` contains no third-party packages. The production CI job runs Rust
tests, builds with those exact tools, and byte-compares the result with
`assets/chessy-ai-fast.wasm`.

```sh
./experiments/wasm/build.sh
```

The script emits:

- `dist/chessy-ai-fast.wasm`: Cargo `release` plus
  `wasm-opt -O3 --converge`;
- `dist/chessy-ai-small.wasm`: Cargo `small` plus
  `wasm-opt -Oz --converge`.

Both use `panic=abort`, one codegen unit, stripped symbols, a one-MiB stack, and
an exact 405-page initial/maximum memory ceiling (26,542,080 bytes). Linking
fails if fixed storage exceeds that limit. No SIMD, threads, WASI, libc,
allocator, garbage collector, `wasm-bindgen`, or per-node allocation is used.

## Tests

```sh
(cd experiments/wasm && cargo test --locked --offline)
node test/wasm-asset.test.js
node test/wasm-signatures.test.js
node test/analysis-core.test.js
node test/ai-tactics.js
```

The frozen `test/fixtures/wasm-r69-signatures.json` records the last accepted
ABI-v1 production behavior before the JavaScript engine was removed. It keeps
move, score, completed/attempted depth, nodes, quiescence nodes, cutoffs,
re-searches, and stop reason pinned across the 18-position mirrored corpus.
Rust unit tests cover internal search invariants, repetition, exact roots,
shared budgets, PV export, and malformed ABI input.

Developer performance and match tools use the isolated ordinary-search loader
in `bench.js`. It accepts only result ABI v1 or v2 because those versions share
the same `input_ptr` / `load_position` / four-argument `search` surface and
64-byte result record. That narrow compatibility window lets the formal
efficiency gate and diagnostic deep-search workflow compare the frozen ABI-v1
reference with an ABI-v2 candidate. It does not expose history or analysis
operations, and it does not relax the production loader, which remains
strictly ABI-v2.

## Raw ABI, version 2

The module has one import:

```text
env.now_ms() -> f64
```

Required exports:

```text
memory
input_ptr() -> u32
history_ptr() -> u32
result_ptr() -> u32
pv_ptr() -> u32
pv_len() -> u32

load_position(fenLength: u32) -> i32
load_history(historyLength: u32) -> i32

search(maxDepth: u32, nodeLimit: u32, timeMs: u32, quiesce: u32) -> i32
analysis_begin(nodeLimit: u32, quiesce: u32) -> i32
analysis_root(packedMove: u32, totalDepth: u32, pvLen: u32) -> i32

evaluate_loaded() -> i32
fixed_search(depth: u32, nodeLimit: u32, quiesce: u32) -> i32
```

JavaScript copies UTF-8 FEN bytes to the 1,024-byte input buffer.
`load_position()` clears stale repetition history. It then copies
newline-delimited repetition identities to the 64-KiB history buffer, one FEN
line per occurrence, and calls `load_history()`. The fixed table accepts up to
768 occurrences; counts above three for one position are unnecessary. Before
transport, the loader losslessly drops positions with a different pawn
placement or piece count from the root. Those positions precede an irreversible
pawn move or capture and can never recur. Every relevant position is therefore
inside the live game's sub-100-ply halfmove window, independent of how long the
aggregate saved-game map has grown.

Normal `search()` is the only Play entry point. A root that already occurred
three times returns `game-over`; a child whose loaded count is at least two
scores as a path-independent draw. Search-path cycles retain the engine's
separate path-dependent repetition treatment.

Zero `nodeLimit` or `timeMs` means unlimited. `maxDepth` is limited to 111 so
the 128-ply fixed storage also covers the 16-ply quiescence ceiling.

### Exact-root analysis

`analysis_begin()` starts one phase with shared TT, heuristics, counters, and
node budget. `analysis_root()` validates and forces one legal root, evaluates
it under a full window at `totalDepth >= 1`, and exports a legal packed-move PV
whose first move is that root. Counters are cumulative across roots in the
phase.

Analysis status codes:

| Code | Meaning |
| ---: | --- |
| 0 | complete exact root |
| 1 | position/analysis not initialized |
| 2 | fixed transposition table saturated |
| 3 | invalid move/depth or rejected re-entry |
| 4 | shared node budget exhausted |

Status 4 preserves cumulative counters and attempted depth but exposes no PV.
The JS analysis contract marks the overall result partial and never presents a
budget-aborted root as exact.

### Result record

Every search writes this 64-byte little-endian result:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | ABI version, exactly `2` |
| 4 | `u32` | struct size, exactly `64` |
| 8 | `u32` | move: from bits 0–5, to bits 6–11, promotion bits 12–14 |
| 12 | `i32` | score from White's point of view |
| 16 | `u32` | last fully completed depth |
| 20 | `u32` | attempted depth, or `0xffffffff` |
| 24 | `u64` | nodes |
| 32 | `u64` | quiescence nodes |
| 40 | `u64` | cutoffs |
| 48 | `u64` | PVS/aspiration re-searches |
| 56 | `u32` | stop-reason code |
| 60 | `u32` | reserved, zero |

Move `0xffffffff` means no move. Promotion codes are 0 none, 1 queen, 2 rook,
3 bishop, and 4 knight. Stop reasons are 0 unknown, 1 max-depth, 2 time-limit,
3 node-limit, 4 mate, and 5 game-over. The JS loader rejects foreign ABI
versions, result sizes, reserved bits, invalid promotions, invalid stop codes,
out-of-bounds pointers, and counters outside JavaScript's safe-integer range.

## Worker and failure model

Play and coaching analysis each own a dedicated Worker and instantiate one
module per worker. Play retries a failed load/search once in a fresh worker
against the exact unchanged FEN, then stops with a visible manual Retry action.
It never substitutes another engine or performs search on the main thread.

Coaching analysis uses a deterministic iterative scan to select a completed
depth, then evaluates every legal root exactly at that depth. A separate
one-ply-shallower phase supplies stability evidence. The JavaScript contract
resolves every packed move through the rules engine before producing SAN or a
persistable PV.

The earlier mobile feasibility/probe workflow was retired when the owner
waived its Android memory/thermal acceptance gates and authorized the
production cutover. The fixed-memory link ceiling, pinned byte-reproducible
build, Chromium/WebKit browser suites, offline cache tests, and functional
correctness gates remain active.
