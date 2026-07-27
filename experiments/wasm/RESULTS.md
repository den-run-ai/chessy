# Reproduction results

Reconstruction of the 2026-07-27 Zig/WASM host spike
([#84 comment](https://github.com/den-run-ai/chessy/issues/84#issuecomment-5094097872)),
extended to mobile-family browser targets in GitHub Actions. JS engine bytes:
`assets/engine.js` + `assets/ai.js` at `main` `1591223` (play-engine
identical to the spike's base `ff82084`).

## Host checkpoint (this container: Node v22.22.2, Linux x64, 4 vCPU)

Command: `node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100`

| Metric | Original spike (2026-07-27) | This reconstruction |
|---|---:|---:|
| Exact parity, depths 1–5, 18 positions | PASS 18/18 | PASS 18/18 (90 checks) |
| Fixed-node abort parity (5,000 nodes) | PASS 18/18 | PASS 18/18 |
| Geomean paired NPS (wasm/js) | 24.4535x | 23.2234x |
| Worst / p10 family NPS | 17.8735x | 17.2330x (promotion race) |
| Slower families | 0/9 | 0/9 |
| 5s Kiwipete | wasm d7 (att. d8, 5,800,959 n) vs js d4 (att. d5, 178,175 n) | wasm d7 (att. d8, 4,320,255 n) vs js d4 (att. d5, 124,927 n) |
| Fast module | 35,256 B raw / 16,704 B brotli | 27,451 B raw / 9,422 B brotli |
| Size module | 22,416 B raw / 14,060 B brotli | 18,271 B raw / 14,060* B brotli |
| Instantiation | 0.47 ms | 1.37 ms |
| Linear memory | 25.31 MiB | 33.69 MiB |

\* size-module brotli not re-measured separately in the headline run; see the
JSON artifact for exact figures per run.

The host filter (>=1.35x) passes by a decisive margin; the absolute ratio
differs from the spike's within host-speed variance (this container's JS
baseline ran the 18-position depth-5 sweep in 51.3 s vs the spike's ~44 s).
The memory delta (33.69 vs 25.31 MiB) is this port's 16-byte TT entries
(2^21 × 16 B = 32 MiB table); the spike packed tighter. Semantics are
identical — parity is the gate.

## Local Chromium (desktop V8, this container, Playwright 1194 build)

| Metric | Value |
|---|---:|
| Exact parity d1–5 + abort | PASS (90 + 18 checks) |
| Geomean paired NPS | 7.5829x |
| Worst family | 6.6178x (KID) |
| Slower families | 0/9 |
| 5s Dragon | wasm d7 (5,339,135 n) vs js d5 (573,439 n) |

The Node-host 23x compresses to ~7.6x in browser V8 — the browser-runtime
shrinkage the spike's GO-TO-DEVICES disposition anticipated, still far above
the >=1.50x/>=1.25x device gate thresholds, with parity intact.

## GitHub Actions targets

Run the **WASM mobile probe** workflow; per-target JSON artifacts and the
aggregated `$GITHUB_STEP_SUMMARY` table are the canonical record. Recorded
runs:

| Run | Trigger | Result |
|---|---|---|
| (fill in after first CI run) | | |

### CI evidence scope

CI establishes functional reproduction (exact parity + abort protocol) on
real Chrome for Android (x86_64 emulator) and real Mobile Safari (arm64 iOS
Simulator), plus V8/JavaScriptCore performance signals. It does **not**
establish the binding physical-device gate (ARM SoC wall-time, thermal,
battery, jetsam/watchdog) — physical hardware remains the deciding step for
#84/#113.
