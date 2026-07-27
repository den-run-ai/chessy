# Zig → WASM whole-search experiment: mobile-target reproduction

This directory reproduces the bounded Zig/WASM play-search feasibility spike
recorded on 2026-07-27 in
[#84 (comment)](https://github.com/den-run-ai/chessy/issues/84#issuecomment-5094097872)
and [#113 (comment)](https://github.com/den-run-ai/chessy/issues/113#issuecomment-5094100099),
and extends it to the **mobile browser targets that GitHub Actions runners can
provide**. Production JS/PWA behavior is unchanged; nothing here is wired into
the app or into PR CI.

## Why a reconstruction

The original spike's source and binaries were never pushed to this repository
(no branch, PR, or tag contains them — only the issue comments record the
results). This directory is an independent re-port of the same experiment,
against the same engine bytes (`assets/engine.js` + `assets/ai.js`, unchanged
as play-engine since the spike's base `ff82084`), holding the same contract:

- entire scalar play-search hot loop resident in one `wasm32-freestanding`
  module: compact numeric board, packed moves, in-place make/unmake,
  attack/move generation, PeSTO tapered evaluation, dual-u32 Zobrist +
  repetition-path handling, fixed packed TT with JS `Map` semantics,
  hash/killer/history ordering, PVS, bounded quiescence, aspiration,
  iterative deepening;
- one coarse load/search ABI and a single `env.now_ms() -> f64` import;
- no SIMD, threads, WASI, allocator, NNUE, or any search-policy change;
- **exact differential parity** with the shipped JS engine: move, score,
  completed/attempted depth, nodes, qnodes, cutoffs, re-searches, stop
  reason, and root order, at every depth 1..5 over the 18 frozen bench
  positions, plus a fixed-node abort-replay screen.

Known deltas vs the original spike (documented, not hidden): TT entries here
are 16 bytes (32 MiB table, 33.7 MiB linear memory total) where the spike
packed 25.31 MiB total; module sizes differ accordingly (this build is
smaller raw). The search *semantics* are identical — that is what parity
gates.

## Layout

```
src/main.zig          — the whole engine port (Zig 0.16.0)
build.sh              — pinned build (ReleaseFast/ReleaseSmall + wasm-opt 131)
chessy.wasm           — committed speed candidate (+ provenance file)
chessy-size.wasm      — committed size candidate
js/wasm-engine.js     — raw-ABI loader/adapter (Node + browser/worker)
bench.js              — host checkpoint: parity, abort screen, paired NPS,
                        five-second diagnostics (ai-bench.js methodology)
probe/                — browser probe: page + Web Worker + report server +
                        Playwright / Android-emulator / iOS-simulator drivers
```

## Running

Host checkpoint (the original spike's screen):

```
node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100
```

Browser probe locally (Playwright):

```
node experiments/wasm/probe/server.js --port 8123 &
node experiments/wasm/probe/run-playwright.js --browser chromium --depth 5
```

Rebuild from source (`zig` 0.16.0, optionally `wasm-opt` from Binaryen 131):

```
experiments/wasm/build.sh
```

CI (all targets): the **WASM mobile probe** workflow
(`.github/workflows/wasm-mobile-probe.yml`) — `workflow_dispatch`, or push to
the experiment branch. Jobs: pinned-toolchain rebuild/reproducibility check,
node-host checkpoint, Playwright Chromium (1x and 4x CPU-throttled) and
WebKit, **real Chrome for Android on an x86_64 emulator (KVM)**, and **real
Mobile Safari on an arm64 iOS Simulator**. Each target runs the same
differential protocol in a Web Worker (the production execution context) and
reports parity, paired NPS, five-second depth, and memory.

## What CI containers can and cannot answer

CI **can** establish, per target: exact functional reproduction (search
parity + abort protocol) on the real mobile browser stacks; engine-family
performance signals (V8 and JavaScriptCore, including an arm64 JSC via the
Apple-silicon simulator); module size/instantiation/memory readings.

CI **cannot** establish the physical-device gate that #84/#113 declare
binding (>=1.50x geomean, >=1.25x p10 on device, +1 completed ply in >=4/8
hard five-second cases, cold/p95 latency, 30-minute thermal soak, battery,
jetsam/watchdog behavior). Emulator x86_64 wall-time is not ARM SoC
wall-time; the simulator runs JSC on the host's M-series cores with macOS
memory management. Physical hardware remains the deciding step.

## Results

See [RESULTS.md](RESULTS.md) for the reproduction numbers (host + CI
targets) side by side with the original spike's recorded numbers.

## Language note (carried from the issue record)

Zig is the spike implementation, not a frozen production choice. The issue
record keeps Rust (`wasm32-unknown-unknown`, same raw ABI) as the default
long-term preference for a substantial maintained backend; if physical
devices pass the gate, the production checkpoint compares hardening this Zig
core against that Rust port under the same parity/performance contract.
