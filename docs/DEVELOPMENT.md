# Development

[Home](../README.md) · [Architecture](ARCHITECTURE.md) ·
[Engine build](../experiments/wasm/README.md) · [Evaluation](../eval/README.md)

Chessy is a static app. The checked-in WebAssembly module is ready to serve;
you only need the Rust toolchain when changing or rebuilding the engine.
Run the commands below from the repository root.

## Local setup

Serve the checkout with Python or another static server:

```sh
python3 -m http.server 8000
```

Open [localhost:8000](http://localhost:8000). Service workers require localhost
or HTTPS. Use a browser's development tools to inspect storage, worker errors,
and offline behavior.

Node.js runs the JavaScript tests. CI uses Node 22, with **22.23.2** pinned for
the engine job and its authoritative Brotli size check. The repository has no
npm runtime manifest. Install test dependencies only when their suites need
them; do not commit generated package files or `node_modules/`.

## Choose the relevant checks

Start with the suites for the code you changed.
[Tests and Pages](../.github/workflows/test.yml) contains the full CI command
list; this guide is a practical subset.

### Rules and Play

```sh
node test/engine.test.js
node test/ai-tactics.js
node test/opening-variety.test.js
node test/level-presets.test.js
node test/ai-telemetry.test.js
```

The rules suite includes standard
[perft positions](https://www.chessprogramming.org/Perft_Results), special
moves, endings, notation, and undo. The tactics suite uses fixed node budgets.

### Coaching and updates

```sh
node test/analysis-core.test.js
node test/analysis-service.test.js
node test/analysis-result.test.js
node test/analysis-notation.test.js
node test/moment-scan.test.js
node test/runtime-update.test.js
node test/release-gate.test.js
```

These cover worker and cache contracts, score interpretation, reflection gates,
resumable scans, and release consistency. Browser tests are also required when
the affected behavior crosses the UI, persistence, or service-worker boundary.

### Browser tests

Install the same Playwright version as CI and run both browser engines:

```sh
npm install --no-save playwright@1.61.1
npx playwright install --with-deps chromium webkit
BROWSER=chromium node test/browser/all.js
BROWSER=webkit node test/browser/all.js
```

The harness uses a fresh origin for each suite to isolate service workers and
saved state. Coverage includes mobile dialogs, keyboard access, clocks,
reloads, release upgrades, and the complete coaching flow. Add new browser
suites to `test/browser/all.js`; discovery is explicit.

### Evaluation scorecards

The independent legal-move oracle is a development dependency:

```sh
npm install --no-save chess.js@1.4.0
node test/eval/scorecard.js --baseline eval/BASELINE.json
node test/eval/analysis-scorecard.js --baseline eval/ANALYSIS-BASELINE.json
```

See the [evaluation guide](../eval/README.md) for full-corpus checks, corpus
reproduction, and the distinction between correctness, quality, and playing
strength. Do not dispatch historical match workflows for a new candidate;
the [match history](../eval/MATCH-HISTORY.md) and
[current formal contract](../eval/match-formal/CONTRACT.md) explain their scope.

### Rust and WebAssembly

Follow the [engine guide](../experiments/wasm/README.md) for the pinned toolchain,
rebuild, byte comparison, ABI tests, and resource limits. Engine behavior
changes also need reviewed [signature evidence](../experiments/wasm/SIGNATURE-ROTATION.md)
and the applicable admission gates.

### Historical incident diagnostics

```sh
node test/master-incident.test.js
node test/master-e4-regression.test.js
```

The second command tracks the known r69 `11...Bd4` miss. It validates the
recorded source/oracle fixture and skips the exact historical search signature
when the shipped module differs from the pinned r69 bytes. Reproduce that
signature from recorded commit `8b887c4`. Its Stockfish Lite comparison covers
four forced moves, not every legal move.

`--require-fix` is an opt-in candidate gate. Passing the normal diagnostic does
not establish that the incident is fixed.

## Before submitting a change

Read the [agent guide](../CLAUDE.md) for the repository's detailed contracts.
Keep changes scoped, then check the final combined diff:

```sh
git diff --check
```

For documentation-only edits, verify relative links, heading anchors, command
paths, and factual agreement with the current code. No app release bump is
needed. New non-browser test gates must be wired explicitly into CI.

Runtime edits require a coherent release number greater than the current base
branch tip. Keep the header, `CHESSY_RELEASE`, service worker, asset URLs, and
worker imports aligned. The [architecture guide](ARCHITECTURE.md#offline-releases)
explains how those release units preserve offline behavior.

## CI and deployment

Every pull request and `main` push runs the same six required checks:

| Check | Purpose |
| --- | --- |
| Hygiene | Reject committed merge-conflict markers |
| Rust/WASM reproducibility | Run native tests and compare the pinned build with the shipped module |
| Release gate | Require coherent release tokens for executable changes |
| Engine and evaluation | Run rules, search, data, analysis, and scorecard contracts |
| Chromium | Exercise the app in Chromium |
| WebKit | Exercise the app in WebKit |

GitHub Pages deploys `main` after all six pass. The separate
[Full evaluation](../.github/workflows/full-eval.yml) workflow runs the complete
117-case correctness and 103-case analysis scorecards weekly and on manual
pre-release dispatch. Statistical engine experiments have their own protocols;
a successful app CI run does not certify an Elo rating.
