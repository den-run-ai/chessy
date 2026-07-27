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
aggregated `$GITHUB_STEP_SUMMARY` table are the canonical record.

[Run 1 (30296955152)](https://github.com/den-run-ai/chessy/actions/runs/30296955152)
at `c57eedc`, defaults (depth 5, reps 2, min-ms 100, five 4):

| target | parity d1–5 | fixed-node abort | paired NPS geomean | worst family | slower families |
|---|---|---|---:|---|---|
| node-host (Node v22.23.1) | PASS 90 | PASS | 23.4709x | 15.9136x (promotion race) | 0/9 |
| chromium (HeadlessChrome 149, V8) | PASS 90 | PASS | 7.1178x | 6.4101x (promotion race) | 0/9 |
| chromium-throttle4 (4x CPU throttle) | PASS 90 | PASS | 7.2042x | 6.3658x (promotion race) | 0/9 |
| webkit (desktop JSC 605.1.15) | PASS 90 | PASS | 9.7530x | 7.3996x (KID) | 0/9 |
| **ios-safari (real Mobile Safari, iOS 18.7 sim, arm64)** | **PASS 90** | **PASS** | **9.4429x** | **8.0598x (Dragon)** | **0/9** |
| android-chrome (real Chrome, x86_64 emulator) | — failed on a probe-script bug (fixed in `7e4c375`); see run 2 | | | | |

Five-second diagnostics (all four hard positions, wasm vs js completed
depth): ios-safari **d7 vs d5 on 4/4**; webkit d7 vs d5–d6 on 4/4; chromium
d7 vs d5–d6 on 4/4; node-host d7 vs d4–d5 on 4/4. No case was shallower.

Observations: the Node-host ~23x compresses to **~7–10x inside browser
engines** (both V8 and JavaScriptCore) — the browser-runtime shrinkage the
spike's GO-TO-DEVICES disposition anticipated — while staying far above the
physical-device thresholds (>=1.50x geomean / >=1.25x p10). A 4x CPU
throttle does not move the ratio (7.20x vs 7.12x), evidence the ratio is
robust to uniform slowdown. Real Mobile Safari (JSC on arm64) matches
desktop WebKit's picture.

[Run 2 (30297382584)](https://github.com/den-run-ai/chessy/actions/runs/30297382584)
at `7e4c375` re-ran everything green and reached real **Chrome for Android**
(Chrome 113, Android 14, x86_64 emulator) for the first time. Its progress
log records, before the Chrome process was low-memory-killed mid-NPS-phase
on the default 2.5 GB emulator:

- exact parity depths 1–5: **90 checks, 0 divergences**;
- fixed-node abort screen: **18/18, 0 divergences**;
- module instantiation 28.8 ms; first NPS families 7.74x / 5.64x (Ruy pair).

So the functional reproduction on real Android Chrome is already
established; the completed performance phases needed more emulator RAM
(raised to 4 GB) plus GC-friendly yields between probe positions — both
landed after run 2 along with fail-fast stall detection.

### CI evidence scope

CI establishes functional reproduction (exact parity + abort protocol) on
real Chrome for Android (x86_64 emulator) and real Mobile Safari (arm64 iOS
Simulator), plus V8/JavaScriptCore performance signals. It does **not**
establish the binding physical-device gate (ARM SoC wall-time, thermal,
battery, jetsam/watchdog) — physical hardware remains the deciding step for
#84/#113.
