# Mobile-target probe

Runs the experiment's differential protocol — exact parity (depths 1..N),
fixed-node abort parity, order-balanced paired NPS, five-second depth, and
memory readings — against the shipped JS engine, inside a real Web Worker on
browser targets. The engine loading/ABI contract is `../bench.js`'s
(`spike-abi.js` is its browser-compatible port; `host-report.js` reuses
`../bench.js` directly).

Build the module first (`../build.sh`), then:

```sh
# host (JSON report + gates)
node experiments/wasm/probe/host-report.js --depth 5 --reps 2 --min-ms 100

# any local Playwright browser
node experiments/wasm/probe/server.js --port 8123 &
node experiments/wasm/probe/run-playwright.js --browser chromium --depth 5

# real Chrome on an attached Android emulator / real Mobile Safari simulator
bash experiments/wasm/probe/run-android.sh
bash experiments/wasm/probe/run-ios-sim.sh
```

CI: the **WASM mobile probe** workflow builds the module with the pinned
toolchain and runs node-host, Chromium (1x + 4x CPU throttle), WebKit, real
Chrome for Android (x86_64 KVM emulator), and real Mobile Safari (arm64 iOS
Simulator), aggregating per-target JSON artifacts into the run summary.

CI scope: functional reproduction and engine-family performance signals
only. The physical-device gate (ARM SoC wall-time, thermal soak, battery,
jetsam/watchdog) still requires hardware; this probe page is also the
harness to open on those physical devices when that step happens.

Operational notes for the emulator target are inline in `run-android.sh`
(post-boot GMS churn can kill foreground Chrome via a dying FontsProvider
dependency; the script settles, retries, and fails fast on progress
staleness).
