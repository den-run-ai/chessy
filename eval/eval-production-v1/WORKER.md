# Candidate Play Worker contract

`test/training/eval-pipeline-worker.test.mjs` checks the built candidate modules
through the unchanged production `assets/ai-worker.js`. It uses a fresh local
HTTP origin and a headless browser, matching the existing browser harness's
Playwright resolution and optional `CHROMIUM_PATH` convention. The app shell,
service worker, and production assets are not modified.

The build must already contain `PREPARED.json`, `BUILT.json`, `modules/**`, and
the captured `runtime/{engine,wasm-engine}.js`. The test verifies their byte
identities and captures the Play Worker from the build's exact `baseCommit`.
The local server serves those captured bytes from memory. The Node signature
oracle executes the same captured loader and modules. The receipt retains the
Worker source, all source/module identities, requests and responses, full
fixture prefixes, HTTP request inventory, and browser/package versions.

## Run

Use the Playwright version pinned by `.github/workflows/test.yml`, installed
outside the repository when working locally. Install its Chromium and WebKit
bundles through the ordinary Playwright installer. No npm manifest or lockfile
belongs in this repository.

```sh
node test/training/eval-pipeline-worker.test.mjs \
  --browser chromium BUILD_DIR NEW_CHROMIUM_RECEIPT.json
node test/training/eval-pipeline-worker.test.mjs \
  --browser webkit BUILD_DIR NEW_WEBKIT_RECEIPT.json
```

`NODE_PATH` may point to a scratch installation of Playwright, and
`PLAYWRIGHT_BROWSERS_PATH` may identify its downloaded browser bundles. For a
local Chromium fallback, `CHROMIUM_PATH` names the installed executable; the
receipt records its actual version and hash. A system-browser run must not be
described as a run of Playwright's pinned browser bundle. Missing browser
dependencies fail the command; they do not produce a passing receipt.

The receipt path is exclusive. The command never replaces an earlier result.
CI can upload the prepared build inventory from the WASM job and download it
into each browser-matrix job before invoking this standalone contract.

## Coverage and limits

The test covers all six prepared modules, seeded fixed-node searches, exact
Node/browser signatures, exact signatures within the HCE and sparse
implementation groups, legal moves, per-request identity, initial request
serialization, and warm reuse. A legal complete prefix reaching threefold
repetition proves history delivery; removing that history restores search.
Verified equal mating moves prove that changing the supplied seed reaches the
engine. Invalid FEN, failed fetch, invalid WASM compilation, and request-queue
recovery checks require structured errors without a substitute move or engine.

The production Worker owns one WASM promise for its lifetime. Once loaded, a
different `wasmUrl` in a later request does not change its engine. A rejected
load remains rejected in that Worker. The contract checks both properties.
Future evaluator selection must bind the choice to the correct Worker
instance, recreating or selecting an instance when necessary; changing only a
request URL cannot implement evaluator switching.

Cold and warm request wall times, plus the Worker's own search elapsed time,
are retained descriptively. The first request includes Worker startup,
fetching, compilation, and initialization; the Worker elapsed counter begins
after loading and includes the search call. These small correctness probes
contain no speed threshold, latency percentile claim, playing-strength claim,
or production admission. Mobile devices, offline release activation, app-level
retry and stale-response ownership, and coaching integration remain separate
production checks.
