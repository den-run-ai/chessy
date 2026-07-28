# Minimal Zig/WASM experiment results

Run date: 2026-07-27

## Verdict

**GO-TO-DEVICES, not production GO.**

The scalar whole-search port cleared the cheap host screen by a wide margin
while preserving the exact JavaScript search tree. The next useful spend is a
production-like Web Worker probe on physical iOS/WebKit and Android/Chromium.
The experiment does not yet justify shipping a second engine backend or make
an Elo claim.

## Language disposition

The positive result validates the whole-search WASM boundary and compact
representation; it does not select Zig permanently. Zig was chosen to minimize
the time and runtime surface of the spike. A Rust
`wasm32-unknown-unknown` implementation with the same raw ABI would be expected
to deliver comparable-order performance, while offering a stable toolchain,
stronger memory safety, and a larger long-term ecosystem.

Do not fund a Zig-to-Rust rewrite before physical-device validation. If those
gates pass, the production-design decision should compare:

1. hardening the working Zig implementation; and
2. porting it to minimal Rust without `wasm-bindgen` on the hot interface.

Rust is the default long-term preference for a substantial maintained backend;
keeping Zig remains reasonable if avoiding a second port and preserving the
measured implementation outweigh pre-1.0 toolchain churn.

## Frozen input and environment

- Baseline: `ff820848454d30f7c22bb94914250ed6214e30ba` on `origin/main`
  (the accepted #116 search core, plus later non-play-engine changes).
- Host: Linux x86_64, AMD EPYC 9V74.
- Node: 24.14.0.
- Zig: 0.16.0, `wasm32-freestanding`.
- Binaryen: 131.
- Fast build: Zig `ReleaseFast`, then `wasm-opt -O3 --converge`.
- Small build: Zig `ReleaseSmall`, then `wasm-opt -Oz --converge`.
- Scalar, single-threaded, no SIMD, no WASI/libc/GC, no per-node allocation.

## Correctness gates

- Zig rules tests pass the shipped perft gates through start position depth 4,
  Kiwipete depth 3, en-passant position 3 depth 4, and promotion-heavy
  position 5 depth 3.
- The tapered evaluator's 768 PeSTO entries match `assets/ai.js`; its
  representative cross-language score tests pass.
- Fixed-depth parity passes at every depth from 1 through 5 on all 18
  benchmark positions (nine mirrored families).
- At depth 5, WASM and JavaScript match on move, score, completed and attempted
  depth, nodes, qnodes, cutoffs, re-searches, and stop reason.
- A separate 5,000-node abort screen matches all eight fields on 18/18
  positions.
- Reloading the same FEN produces the same result, proving that root RNG,
  counters, heuristics, and TT state reset between searches.
- The fixed TT did not saturate in these tests or in the five-second Kiwipete
  probe.

## Depth-5 host throughput screen

Command:

```sh
node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100
```

Method: one full-depth warm-up, two order-balanced AB/BA repetitions, batched
to at least 100 ms per side, exact-tree comparison before accepting timing.

| Metric | Result |
| --- | ---: |
| Exact search parity | 18/18 |
| Geometric-mean paired NPS ratio | **24.4535x** |
| Worst mirrored-family ratio | **17.8735x** |
| p10 mirrored-family ratio | **17.8735x** |
| Slower families | 0/9 |
| Fast binary | 35,256 B raw / 16,704 B Brotli |
| Small binary | 22,416 B raw / 14,060 B Brotli |
| Fast instantiation in the measured run | 0.47 ms |
| First measured depth-5 search | 44.06 ms |
| Initial/final linear memory | 26,542,080 B (25.31 MiB) |

The ratio is a Node/V8 host result, not a browser or mobile estimate. Its value
is that it easily clears the predeclared 1.35x host filter without changing the
tree; it must not be copied into a product performance claim.

One diagnostic five-second Kiwipete run completed depth 7 in WASM
(5,800,959 nodes, attempted depth 8) versus depth 4 in JavaScript
(178,175 nodes, attempted depth 5). That is encouraging time-to-depth evidence
on this host, but it is one position and not the frozen physical-device gate.

## Scope and codebase cost

The spike adds about 2,400 lines of Zig for rules, evaluation, search, and the
raw ABI, plus the benchmark/parity harness and documentation. Production JS,
the PWA cache, and worker behavior remain unchanged.

A production backend would create a second maintained implementation of chess
rules and search semantics. It would also need:

- complete repetition-history input, PV/provenance output, and JS legal-move
  re-resolution;
- worker loading/prewarming, timeout/cancellation, fallback, and stale-result
  handling;
- service-worker precaching/update tests and correct `application/wasm`
  delivery;
- browser differential CI and a reproducible pinned native build;
- memory/TT sizing work, because the experimental fixed TT makes the current
  module reserve 25.31 MiB;
- physical-device latency, p10/tail, thermal, battery, and offline validation.

The failed SEE ordering experiment in closed draft #121 does not invalidate
this result. SEE changed move ordering and failed its family tail gate; this
WASM spike deliberately ports the accepted #116 algorithm unchanged and
measures representation/runtime cost. The SEE result reinforces keeping
algorithm changes out of the language/runtime comparison.

## Next gate

Run a production-like single Web Worker on one physical iPhone/Safari and one
midrange Android/Chrome. Continue only if each device achieves at least 1.50x
geomean warm NPS and 1.25x p10 family NPS, adds a completed ply in at least
4/8 frozen hard five-second cases with no shallower case, and shows acceptable
cold start, peak memory, 30-minute thermal behavior, battery use, and offline
loading.

## Mobile-target CI probe (stacked follow-up)

The probe layer under `probe/` ran this experiment's differential protocol
in a real Web Worker on every mobile-family target a GitHub-hosted runner
provides, against the module built from this source by the pinned toolchain
(Zig 0.16.0 + Binaryen 131; byte-identical to the recorded binaries).
Canonical run:
[30317174817](https://github.com/den-run-ai/chessy/actions/runs/30317174817)
(depth 5, reps 2, min-ms 100, five 4; Android uses min-ms 50).

| target | parity d1–5 | fixed-node abort | paired NPS geomean | worst family | slower families | linear memory |
|---|---|---|---:|---|---|---:|
| node-host (Node v22.23.1) | PASS 90 | PASS | 23.0229x | 16.4844x (promotion race) | 0/9 | 25.31 MiB |
| chromium (HeadlessChrome 149, V8) | PASS 90 | PASS | 6.9318x | 6.5782x (promotion race) | 0/9 | 25.31 MiB |
| chromium, 4x CPU throttle | PASS 90 | PASS | 7.0101x | 6.4624x (promotion race) | 0/9 | 25.31 MiB |
| webkit (desktop JSC 605.1.15) | PASS 90 | PASS | 9.1748x | 7.7035x (KID) | 0/9 | 25.31 MiB |
| **ios-safari (real Mobile Safari, iOS 18.7 sim, arm64)** | **PASS 90** | **PASS** | **9.9926x** | 8.2945x (KID) | **0/9** | 25.31 MiB |
| **android-chrome (real Chrome 113, Android 14 emulator)** | **PASS 90** | **PASS** | **6.7955x** | 6.3837x (Lucena) | **0/9** | 25.31 MiB |

Five-second diagnostics (hard positions, wasm vs js completed depth):
android-chrome and ios-safari **d7 vs d5–d6 on 4/4**, chromium and webkit
d7 vs d5–d6 on 4/4, node-host d7 vs d4–d5 on 4/4; no case anywhere was
shallower.

Readings against this experiment's open questions:

- The host-only 24.45x compresses to **~7–10x inside real browser engines**
  (both V8 and JavaScriptCore) — still far above the 1.50x/1.25x device
  thresholds, with zero slower families on any target.
- A 4x CPU throttle does not move the Chromium ratio (7.01x vs 6.93x),
  evidence the ratio survives uniform slowdown.
- The 25.31 MiB linear-memory reservation is confirmed inside real Mobile
  Safari and Android Chrome workers without incident.

Scope: these are emulator/simulator containers — functional reproduction
plus engine-family performance signals. The physical-device gate above
(ARM SoC wall-time, thermal soak, battery, jetsam/watchdog) is unchanged
and still requires hardware; `probe/` is also the harness to open on those
devices when that step happens.

An independent same-contract reconstruction of this port (branch
`claude/wasm-zig-mobile-validation-x0fwkv`, built before this source was
published) agrees with this module search-for-search on all 36 cross-checked
depth-6 and 100k-node-abort workloads — two implementations converging
exactly on searches neither was verified against JS on.
