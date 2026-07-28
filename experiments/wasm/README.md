# Chessy Rust/WASM feasibility experiment

This directory ports Chessy's complete hot search loop to dependency-free Rust
and `wasm32-unknown-unknown`. It tests whether the production-preferred language
can preserve the exact search proven by the Zig spike while retaining its
compact whole-search WebAssembly boundary.

It is an isolated experiment. It does not change `assets/ai-worker.js`, the PWA
cache, Play behavior, or the JavaScript fallback.

## Scope

The module owns position state, move generation, make/unmake, attack detection,
evaluation, quiescence, the transposition table, move ordering, PVS, aspiration,
and iterative deepening. JavaScript crosses the boundary once to load a FEN and
once to start a search. The only callback inside the tree is the existing
coarse deadline poll through `env.now_ms`.

The experiment deliberately excludes:

- SIMD, threads, WASI, libc, a garbage collector, an allocator, and per-node
  allocation;
- `wasm-bindgen` or any binding/runtime dependency;
- SEE, LMR, null-move pruning, NNUE, or any other algorithmic change;
- repetition-history transfer (the benchmark loads bare FENs, as
  `test/ai-bench.js` does);
- production worker, service-worker, UI, or release integration.

The root move shuffle resets to Mulberry32 seed `0xC0FFEE` for every search,
matching `test/ai-bench.js`. The seed remains frozen inside the experiment
rather than expanding the ABI.

## Language decision

Draft PRs #124 and #125 established the Zig feasibility result and the reusable
single-Web-Worker/mobile-target probe. This port leaves those branches intact
as historical evidence and changes only the implementation language behind the
same ABI and differential contract.

Rust is the long-lived candidate because it supplies a stable toolchain,
stronger compiler checks, testing/profiling support, and a larger maintainer
ecosystem. The current experiment still uses substantial `unsafe` global state
to match the fixed-memory Zig layout. It is explicitly single-worker and
non-reentrant; the ABI rejects an attempted nested search. The port is
justified only if Rust's maintenance benefits do not cost the measured search:

- exact JavaScript parity remains mandatory;
- deeper Rust/Zig differentials must remain exact;
- the fast Rust binary must stay in the same compact size class;
- the stacked worker/mobile matrix must be rerun against Rust rather than
  inheriting Zig's measurements by assumption.

The recorded host comparison clears those conditions. `RESULTS.md` contains the
numbers and explains why the fast build, not the absolute smallest build, is
the deployment candidate.

## Reproducible builds

The experiment pins Rust 1.97.1 (rustc commit
`8bab26f4f68e0e26f0bb7960be334d5b520ea452`), target
`wasm32-unknown-unknown`, and Binaryen 131. `Cargo.lock` contains no
third-party packages. The build rejects ambient Rust flags and asserts the
tool versions before compiling. Set `CHESSY_CARGO_BIN`,
`CHESSY_RUSTC_BIN`, and `CHESSY_WASM_OPT_BIN` when the tools are not on
`PATH`; `CHESSY_CARGO_TARGET_DIR` optionally relocates Cargo output.

```sh
./experiments/wasm/build.sh
```

The script builds two variants:

- `dist/chessy-ai-fast.wasm`: Cargo `release` (`opt-level=3`, fat LTO), then
  `wasm-opt -O3 --converge`;
- `dist/chessy-ai-small.wasm`: Cargo `small` (`opt-level=z`, fat LTO), then
  `wasm-opt -Oz --converge`.

Both use `panic=abort`, one codegen unit, stripped symbols, a one-MiB stack, and
an exact 405-page initial/maximum memory ceiling. Linking fails if a layout
change exceeds the recorded 26,542,080-byte budget. Binaryen enables only the
six default WebAssembly features permitted by the pinned Rust target; it does
not authorize SIMD, threads, GC, or all proposals. The stacked workflow also
checks the SHA-256 of the official Binaryen archive before building.

The fast build decides runtime feasibility. The small build records the
download floor. Generated `.wasm` files remain ignored.

## Tests and benchmarks

```sh
(cd experiments/wasm && cargo test --locked --offline)
node test/ai-wasm-parity.js --depth 5
node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100 --require-go
node experiments/wasm/deep-bench.test.js
```

The Rust tests retain the Zig spike's perft, move-order, make/unmake, and
evaluator-reference checks. The JavaScript differential compares move, score,
completed/attempted depth, nodes, qnodes, cutoffs, re-searches, and stop reason
on all 18 positions, plus fixed-node aborts and reset determinism.

If a build lives elsewhere, pass it explicitly:

```sh
node test/ai-wasm-parity.js --wasm /path/to/chessy-ai.wasm --depth 5
node experiments/wasm/bench.js --wasm /path/to/chessy-ai.wasm
```

To reproduce the deeper differential and direct language comparison, first
build PR #124's pinned Zig source, then supply its fast module as the reference:

```sh
node test/ai-wasm-parity.js \
  --reference-wasm /path/to/zig/chessy-ai-fast.wasm
node experiments/wasm/bench.js \
  --baseline-wasm /path/to/zig/chessy-ai-fast.wasm \
  --depth 5 --reps 2 --min-ms 100
```

## Raw ABI, version 1

The module has exactly one import:

```text
env.now_ms() -> f64
```

Fixed-depth searches pass `timeMs=0` and do not poll the host clock. Timed
searches may call `env.now_ms`, but that callback must not mutate the module;
nested search/load calls are rejected. Required exports are:

```text
memory
input_ptr() -> u32
result_ptr() -> u32
load_position(fenLength: u32)
search(maxDepth: u32, nodeLimit: u32, timeMs: u32, quiesce: u32) -> i32
```

JavaScript copies UTF-8 FEN bytes to `input_ptr()` and calls
`load_position(length)`, checking the fixed 1,024-byte capacity before the
copy. A zero `nodeLimit` or `timeMs` means unlimited. `maxDepth` is limited to
111 so the 128-ply fixed storage also covers the 16-ply quiescence ceiling.
`search()` returns zero on success, 1 if no position is loaded, 2 if the fixed
transposition table saturated (which invalidates exact-tree comparison), and 3
for an invalid depth or rejected re-entry.
Search results are written at `result_ptr()` as this 64-byte little-endian
record:

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

`bench.js` hard-fails on an ABI version or struct-size mismatch before accepting
any benchmark result.

## Divergent deep-search experiments

`deep-bench.js` compares a candidate WASM module with its exact, frozen
`origin/main` merge-base build without requiring identical trees. Its default
screen runs fixed depth 7 over the canonical 18-position/mirrored corpus,
fixed depth 8 over four tractable endgame positions, and two order-balanced five-second
pairs over all 18 positions. It also replays two AI-to-move witnesses from the
2026-07-28 iPhone A14 debug game: the depth-6, 83%-quiescence position before
`18...Nb4` and the depth-9 peak before `27...Rb8`.

The JSON and Markdown reports retain per-position and per-family nodes, qnodes,
NPS, wall time, move/score/depth divergence, aggregate and tail metrics, and
time-to-depth outcomes. A diagnostic decision never makes a rejected
experiment fail CI; only a broken or incomplete measurement does. Tactics,
strength, physical-device, and production gates remain separate.

The workflow executes `deep-bench.js`, its imported `bench.js`, and their
contract tests from a pinned trusted-harness commit rather than from the
candidate checkout. Every timed candidate and reference search must also
report coherent stop/depth metadata and finish within the requested budget
plus a host-observed overshoot allowance of 2% or 25 ms, whichever is larger.
An overrun or malformed timed result fails the measurement before completed
depth can influence the diagnostic decision.

The diagnostic classifier requires activity in at least three canonical
families and a material benefit: at least 5% lower depth-7 geomean nodes, or
more candidate-deeper than candidate-shallower outcomes in the paired
five-second screen. It also retains no-regression checks for geomean nodes,
fixed-depth wall time, and the 1.25x per-position node tail.

Candidate branches may optionally export:

```text
experiment_metric(index: u32) -> u64
```

The loader records exactly 16 non-negative, JavaScript-safe slots after every
search. Implementations must return zero for unused/out-of-range slots. The
baseline may omit the export; ABI v1 and its 64-byte result stay unchanged.

## Formal efficiency non-inferiority match

`test/wasm-efficiency-match.js` is the separately gated strength-safety check
for a Rust/WASM search optimization that has already demonstrated a material
efficiency benefit. It builds on the frozen match corpus and clustered
statistics, but compares two exact WASM modules rather than accidentally
replaying the unchanged `assets/ai.js` engine:

- 10,000 nodes per move and a 180-ply cap;
- 100 frozen openings, four seed slots, and both colours (800 games);
- one-sided 95% lower confidence bound over the 100 per-opening means;
- pass only when that lower bound is **strictly above 49%**.

This is an efficiency non-inferiority gate, not the separate pure-strength
claim whose lower bound must exceed 50%. Candidate/base source commits and
both optimized-module SHA-256 digests are bound into every shard. The
aggregator rejects mixed, duplicated, missing, or non-canonical evidence.
Protocol v2 additionally binds the exact trusted-main harness commit and
Actions run. Its shard runner validates the node count, stop reason, and
depth metadata after every candidate and reference search, not just during a
startup probe. A formal v2 verdict cannot run without independently generated
trusted provenance.

ABI v1 has no seed or game-prefix-history input. Root ordering resets to the
same embedded `0xC0FFEE` seed for every search, so the four manifest seed slots
are deterministic repeats for WASM. They do not inflate the analysis:
`test/match-stats.js` still treats the opening as the independent unit
(`n = 100`, never 400 pairs). Keeping the 20-shard `4 x 5` geometry preserves
the frozen protocol and gives a direct completeness check; it does not claim
four independent observations per opening.

The Actions workflow is intentionally maintainer-label gated. It does not run
when the shared harness PR or a candidate PR is opened or updated. It accepts
only a same-repository pull request targeting `main` whose diff is confined to
Rust sources and experiment notes. After reviewing that exact candidate head
and allowed-file diff, a maintainer launches one complete experiment by
applying the `run-wasm-efficiency-v2` label. Ordinary pushes do not launch the
800-game matrix, and a second run for the same candidate SHA is rejected. A
later push makes the recorded candidate SHA stale: remove the label, review
the new exact head, and reapply it only for a genuinely new complete
experiment. Re-running a completed attempt is inadmissible. Replacing an
infrastructure-invalid run also requires a fresh reviewed commit and therefore
a new candidate SHA.

The trusted-main workflow admits only candidate Rust-source and
experiment-note changes. It compiles that source with the trusted build driver
in an isolated job, while a separate trusted job builds the frozen
`808a2ef3e140718facd384acfebdd8781f1db162` source with Rust 1.97.1 and
Binaryen 131 and verifies its pinned module digest. Fresh trusted jobs
recompute both downloaded module digests, run every shard and the aggregator
from the exact base commit, and emit the verdict only after all 20
first-attempt artifacts tile the full manifest. Evidence produced by protocol
v1 did not have these trust and per-search checks and is therefore
inadmissible for a v2 merge gate. Do not rerun selected shards or a valid
statistical miss.

## Go/no-go funnel

1. Rust unit tests and byte-reproducible fast/small builds.
2. Exact JavaScript parity through depth 5, fixed-node abort parity, and reset
   determinism.
3. Direct Rust/Zig depth-6 and 100,000-node differentials, plus special-move
   witnesses.
4. Order-balanced host screen: at least 1.35x geomean versus JavaScript and no
   mirrored family below 1.00x.
5. The stacked Web Worker matrix on Node, Chromium, WebKit, Android Chrome in
   the KVM emulator, and Mobile Safari in the arm64 iOS Simulator.
6. Physical iPhone and midrange-Android testing for ARM wall time, cold start,
   memory pressure, thermal soak, battery, watchdog behavior, and offline load.

Passing the hosted matrix selects a production-language candidate; it does not
by itself authorize replacing JavaScript in the shipped PWA. The physical
device and production-integration gates remain explicit.
