# Chessy Zig/WASM feasibility experiment

This directory answers one narrow question: can a scalar, single-threaded
freestanding WebAssembly port of Chessy's complete hot search loop buy enough
mobile-browser throughput to justify a maintained second engine?

It is an isolated experiment. It does not change `assets/ai-worker.js`, the PWA
cache, Play behavior, or the JavaScript fallback.

## Scope

The module owns position state, move generation, make/unmake, attack detection,
evaluation, quiescence, the transposition table, move ordering, PVS, aspiration,
and iterative deepening. JavaScript crosses the boundary once to load a FEN and
once to start a search. There are no callbacks inside the tree except the
existing coarse deadline poll through `env.now_ms`.

The first experiment deliberately excludes:

- SIMD, threads, WASI, libc, a garbage collector, and per-node allocation;
- SEE, LMR, null-move pruning, NNUE, or any other algorithmic change;
- repetition-history transfer (the benchmark loads bare FENs, as
  `test/ai-bench.js` does);
- production worker, service-worker, UI, or release integration.

The root move shuffle is reset to Mulberry32 seed `0xC0FFEE` for every search,
matching `test/ai-bench.js`. The seed is temporarily frozen inside the
experiment rather than added to the ABI.

## Language decision

Zig is the implementation language for this feasibility spike, not a frozen
production choice. It was selected because `wasm32-freestanding`, a raw ABI,
and fixed memory make the smallest practical experiment with no binding
runtime, libc, garbage collector, or OS layer.

If the physical-device gates pass and Chessy decides to maintain a second
engine, hold a separate production-language checkpoint:

- harden the already-proven Zig core; or
- port the same core to Rust `wasm32-unknown-unknown`, keeping the raw coarse
  ABI and avoiding a per-node or binding-heavy interface.

Rust is the preferred long-term candidate when toolchain stability, memory
safety, and ecosystem/maintainer availability outweigh the cost of a second
port. It is expected to occupy the same broad performance class; rewriting the
spike now would add little feasibility evidence. Run the mobile gate first,
then compare maintained Zig against Rust using this exact parity and benchmark
contract.

## Build variants

The recorded experiment uses Zig 0.16.0 and Binaryen 131. Set
`CHESSY_ZIG_BIN` and `CHESSY_WASM_OPT_BIN` when they are not on `PATH`;
`CHESSY_ZIG_CACHE_ROOT` optionally relocates the Zig cache.
`build.sh` produces fast and small candidates from the same source and applies
Binaryen:

```sh
./experiments/wasm/build.sh
```

The outputs are `dist/chessy-ai-fast.wasm` (`ReleaseFast` plus `wasm-opt -O3`)
and `dist/chessy-ai-small.wasm` (`ReleaseSmall` plus `wasm-opt -Oz`). The fast
build is the harness default and decides search feasibility. The small build
records the lower download floor; it does not replace the fast build unless it
also clears the same performance gate. Keep the uncompressed `.wasm` available
because the harness reports both raw and Brotli sizes.

If the build writes somewhere else, pass its path explicitly:

```sh
node test/ai-wasm-parity.js --wasm /path/to/chessy-ai.wasm
node experiments/wasm/bench.js --wasm /path/to/chessy-ai.wasm
```

## Raw ABI, version 1

The module has exactly one import:

```text
env.now_ms() -> f64
```

Fixed-depth searches pass `timeMs=0` and must not poll that host clock. Required
exports are:

```text
memory
input_ptr() -> u32
result_ptr() -> u32
load_position(fenLength: u32)
search(maxDepth: u32, nodeLimit: u32, timeMs: u32, quiesce: u32) -> i32
```

JavaScript copies UTF-8 FEN bytes to `input_ptr()` and calls
`load_position(length)`. A zero `nodeLimit` or `timeMs` means unlimited.
`search()` returns zero on success, 1 if no position was loaded, and 2 if the
fixed transposition table saturated (which invalidates an exact-tree run).
Search results are written at
`result_ptr()` as this 64-byte little-endian record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | ABI version, exactly `1` |
| 4 | `u32` | struct size, exactly `64` |
| 8 | `u32` | move: from bits 0–5, to bits 6–11, promotion bits 12–14 |
| 12 | `i32` | score, from White's point of view |
| 16 | `u32` | last fully completed depth |
| 20 | `u32` | attempted depth, or `0xffffffff` for none |
| 24 | `u64` | nodes |
| 32 | `u64` | quiescence nodes |
| 40 | `u64` | cutoffs |
| 48 | `u64` | PVS/aspiration re-searches |
| 56 | `u32` | stop-reason code |
| 60 | `u32` | reserved, zero |

Move `0xffffffff` means no move. Promotion codes are 0 none, 1 queen, 2 rook,
3 bishop, and 4 knight. Stop-reason codes are 0 unknown, 1 max-depth, 2
time-limit, 3 node-limit, 4 mate, and 5 game-over. Counters are rejected if they
cannot be represented exactly by a JavaScript safe integer.

`bench.js` contains the native `DataView` decoder. It hard-fails on an ABI
version or struct-size mismatch so an incompatible binary cannot generate
plausible-looking benchmark data.

## Go/no-go funnel

First run exact parity:

```sh
node test/ai-wasm-parity.js --depth 5
```

All 18 positions must match JavaScript on move, score, completed/attempted
depth, nodes, qnodes, cutoffs, re-searches, and stop reason. A mismatch stops
the experiment; do not interpret speed from a different tree.

Then run the cheap host screen:

```sh
node experiments/wasm/bench.js --depth 5 --reps 4 --min-ms 250
```

The harness warms both engines, alternates WASM-first/JavaScript-first order,
batches short searches to at least 250 ms per side, and uses median paired NPS
ratios. Mirrored/color-swapped positions are aggregated into nine families.

- Geomean below **1.25x**: **NO-GO** and stop.
- Geomean from **1.25x through less than 1.35x**: allow one bounded profiling
  correction, then rerun once.
- Geomean at least **1.35x**, with no mirrored family below **1.00x**:
  **GO-TO-DEVICES**.
- Any exact-tree mismatch: invalid comparison and immediate stop.

Add `--require-go` when automation should return exit status 2 unless the last
condition passes. A host result is only a filter, not evidence that mobile
Safari or Chrome will behave the same way.

Only after that screen passes, build a production-like Web Worker probe and
measure on one physical iPhone/Safari and one midrange Android/Chrome:

- at least **1.50x** geomean warm NPS on each device;
- at least **1.25x** p10 family NPS and no repeatable family slowdown;
- at five seconds, one additional completed ply in at least 4 of the 8
  designated hard cases, and never a shallower result;
- no unacceptable initialization, memory, sustained/thermal, or offline-load
  regression. Repeat at ten seconds as a diagnostic.

Passing this funnel authorizes a separate production-design decision; it does
not authorize replacing the JavaScript engine. Failing it leaves production
unchanged and the experimental branch can be archived.
