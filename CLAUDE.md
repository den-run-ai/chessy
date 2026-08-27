# Chessy agent guide

This is the canonical repository guide for coding agents. `AGENTS.md` must
remain a relative symlink to this file so Claude Code and Codex receive the
same instructions.

## Start with the current tree

- Read `README.md`, the relevant live GitHub issue, and the latest PR review
  before changing behavior. Use the issue for product intent and the checked-out
  code, tests, and `.github/workflows/test.yml` for what is actually shipped.
- Check the branch, status, base, and recent history. This repository frequently
  uses stacked PRs. A PR merged into another feature branch is not necessarily
  on `main`; prove default-branch ancestry (for example, with
  `git merge-base --is-ancestor <commit> origin/main`) instead of trusting a
  `merged` badge. A `Closes #...` line merged only into a non-default branch may
  also leave the issue open.
- Treat a review and CI result as evidence for their exact commit only. After a
  rebase, stack merge, or fix, validate and review the final aggregate head.
- Historical experiment notes and closed/rejected PRs are evidence, not current
  architecture. In particular, `experiments/wasm/RESULTS.md` predates the
  production Rust/WASM cutover.
- Keep changes focused on the requested issue. Do not silently fold in adjacent
  roadmap work, update GitHub state, or launch expensive formal workflows unless
  the task explicitly includes it.

## Product and architecture

Chessy is a static, installable, offline-first chess PWA. The shipped app has no
runtime packages, build step, analytics, fonts, or network service. Development,
CI, corpus fetching, and optional external evaluation may use online tools; that
does not relax the shipped app's offline boundary.

| Area | Ownership |
| --- | --- |
| `index.html` | App shell, DOM, ordered runtime asset loading, release identity |
| `assets/engine.js` | Dependency-free JavaScript chess rules, legal moves, SAN, draw state; **not AI search** |
| `experiments/wasm/src/` | Production Rust search, evaluation, move generation, exact-root analysis |
| `experiments/wasm/build.sh` | Pinned reproducible WASM build; output is copied to `assets/chessy-ai-fast.wasm` |
| `assets/{wasm-engine,ai-worker}.js` | Strict ABI-v2 loader and Worker-only Play search |
| `assets/{analysis-core,analysis-worker,analysis-service,analysis-result}.js` | Coaching orchestration, worker lifecycle, caching, result trust boundary |
| `assets/app.js` | Live game, clocks, replay, local save, UI orchestration |
| `assets/{store,archive,data-controls}.js` | IndexedDB records, archive durability, backup/restore/delete fences |
| `assets/{review,moment-scan,moment-selector,reflection,train,progress}.js` | Reflection-gated coaching loop |
| `sw.js`, `assets/runtime-update.js` | Immutable release units, offline cache, update/takeover lifecycle |
| `test/`, `eval/`, `.github/workflows/` | Contracts, regression suites, scorecards, and authoritative CI |

The live game and clock snapshot use `localStorage`. Durable games, cards,
recomputable analyses, and resumable scan jobs use IndexedDB. The current
product intentionally assumes one active tab; cross-tab coordination belongs to
issue #44 and must not be improvised as a side effect of another change.

## Non-negotiable runtime contracts

### Engine boundary

- Production Play and coaching search are Rust/WASM-only and Worker-only.
  `assets/ai.js` and the JavaScript search fallback were removed. Never restore
  a synchronous, main-thread, or alternate-engine fallback.
- A failed Play worker gets one fresh-worker retry against the exact unchanged
  request and position. A second failure stays visible and leaves the position
  unchanged until the player explicitly retries.
- JavaScript still owns the independent product rules layer, legal-root/PV
  validation, SAN formatting, persistence, and UI. Do not confuse removal of
  JavaScript search with removal of `assets/engine.js`.
- Production accepts raw WASM ABI v2 only. ABI-v1 support exists solely in
  narrow developer comparison harnesses for the frozen historical reference.

### Offline release units

- Runtime URLs are immutable per `rN`. Any executable change under `assets/**`
  or in `index.html` or `sw.js` must ship as one coherent release with a number
  strictly greater than the current **base-branch tip**, not merely the merge
  base. The shared CI release gate enforces those paths in pull requests and
  `main` pushes, and Pages deployment waits for that gate plus the other five
  full checks. Preserve that parity; never add a second reduced deploy path.
- Keep these identities equal: `sw.js` `RELEASE`, the visible version and
  `window.CHESSY_RELEASE` in `index.html`, every runtime `?r=rN` URL, and worker
  descendant URLs.
- Add every new runtime asset to the applicable ordered load in `index.html`
  and to the `sw.js` precache list. Workers must forward the same release query
  to imported scripts and WASM.
- Treat any app-shell/runtime change as one coherent release. README-, test-,
  eval-, workflow-, and agent-guide-only edits do not need a release bump.
- Preserve long-open-tab, first-controller, upgrade, offline-reload, and saved
  game behavior. A failed update check must never block offline play.
- GitHub Pages sibling projects share an origin. Service-worker cleanup must
  remain scoped to verified `chessy-*` release caches; never clear unrelated
  origin caches or storage.

### Persistence and trust boundaries

- Treat localStorage, IndexedDB, imported PGN, restored backup JSON, cached
  analysis, worker replies, and legacy records as untrusted input.
- Validate at both write and read/serve boundaries. Check schema and field
  coherence, replay moves through the rules engine, compare the reconstructed
  final FEN, and bind evidence to the correct game ID/revision, ply, side to
  move, repetition-aware position fingerprint, engine/provider version, config,
  and completeness state.
- Cache keys are not proof. Evict or recompute malformed recomputable data;
  quarantine or visibly reject malformed durable data. Never delete the only
  recovery record just because it fails validation.
- Keep released saves and backups readable where safely possible. Migrations
  must be non-destructive, transactional, and tested from old schemas. Games
  and cards are user data; analysis cache rows may be bounded or rebuilt.
- Backup/restore/delete, archive replacement, manual-ending retraction, and
  card cleanup must be atomic across related records. Use durable fences so a
  crash, reload, pagehide, or late write cannot resurrect deleted/retracted
  state or report false success.
- Retract or delete an archived ending only when its complete expected revision
  matches (game ID, moves, result, and reason), then remove its derived
  cards/analyses/jobs in the same transaction. A UUID alone must not erase a
  newer revised ending.
- Malformed Undo tombstones are preserved or losslessly quarantined and block
  their game ID from boot rearchive, Review, and Backup. Keep the #154
  field-mutation, two-reload, mixed-game, and unreadable-whole-queue regressions
  intact. Issue #96 tracks the broader same-ID source-authority design.

### Async ownership

- Request identity, generation, owner, game revision, and worker instance are
  part of correctness. Late replies from cancelled, superseded, navigated-away,
  reloaded, or prior-game work must neither render nor persist.
- Leaving a view cancels work owned by that view. Progress is monotonic,
  non-terminal, score-free, and cannot extend the watchdog. Retries preserve the
  exact original request and ignore replies from the retired worker.
- Test both committed and in-flight writes, cancellation, retry, reload, and
  failure recovery. Happy-path button tests are insufficient for async changes.

### Coaching Gate 0 and honest evidence

- Before a valid structured reflection, public controller/UI state may expose
  only permitted moment identity such as `{ ply, playedSan }`—never scores,
  labels, alternatives, PVs, imported NAGs, or hidden candidate evidence.
- The two-location cap applies to engine-selected suggestions. A private scan
  may score every non-terminal move, but the matching row unlocks only after its
  reflection receipt; the full SAN score trail unlocks only under the reviewed
  all-suggestions/zero-suggestion rule.
- Persisted `analysisJobs.candidates`, `shortlist`, and `reflected` fields are
  not authority. Since r79, schema-v3 scan jobs rebuild restored candidates and
  the shortlist from canonical full quick/deep result contracts revalidated
  against the exact replay/request profile; compact summaries and selector
  fields are comparison mirrors only, unresolved rows rewind for retry, and
  pass-two progress/admission is exact. Legacy jobs restart spoiler-free. Since
  r78, Gate-0 unlock
  is derived only from durable, revision-
  bound, replay-validated structured-reflection receipts; their exact source
  includes clock and time-control evidence, and shape-valid cache records or
  lesson cards cannot reveal a score. Preserve field-tampering tests, source-
  revision invalidation, plus the real submit -> reload -> reveal flow in
  Chromium and WebKit.
- Scores use White POV. Quick-pass scores remain visibly approximate. Chessy
  may add only conservative negative `?!`, `?`, or `??` marks from stable,
  deep-confirmed evidence; imported PGN NAGs retain separate provenance.
- A different move is not automatically wrong. Preserve equivalent, sound,
  unresolved, partial, and unknown states. The player owns the diagnosis; never
  turn missing engine coverage into a negative claim.
- Ordinary Play remains hint-free. Lesson cards require explicit player
  approval, and producing zero lessons is valid. Any future assisted-practice
  mode must stay distinct from evidence of independent play.
- Engine output and legal board facts determine correctness. Do not add remote
  coaching, telemetry, or transmission of game/user data outside the explicit,
  consent-gated language-coach roadmap in #109.

### Accessibility and mobile behavior

- Preserve the ARIA-grid/row/gridcell model, one roving tab stop, visual-board
  arrow directions when flipped, focus restoration, live-region semantics, and
  inspection-only behavior of coaching boards.
- Test narrow layouts, touch targets, keyboard-only use, and visible focus. Do
  not solve a desktop layout at the cost of WebKit/iOS behavior; Chromium and
  WebKit are both required browser gates.
- Preserve the text-variation selector used for chess glyphs; iOS otherwise
  renders pawns as emoji with incorrect colors.

## Change coupling and required evidence

| If you change… | Also do… |
| --- | --- |
| `assets/**`, `index.html`, or `sw.js` runtime behavior | Bump/cohere the release unit as applicable; run runtime-update and service-worker browser tests |
| Rust engine, search, eval, ABI, or build | Run Rust tests, pinned rebuild and byte comparison, WASM/ABI/signature/tactics/analysis tests; never hand-edit the binary |
| Worker/service/cache code | Test identity, retry, cancellation, stale replies, malformed cached results, and read-time validation |
| Store schema, archive, backup, restore, or delete | Add migration/legacy fixtures plus crash, partial-write, atomicity, and recovery tests |
| Clocks, terminal results, resignation, draw agreement, or Undo | Test clock/search freeze and resume, archive/retraction, reload/pagehide, backup, Review, and PGN semantics |
| Scan, Review, reflection, or annotations | Prove pre-reflection non-disclosure, trustworthy resume/unlock, custom-FEN numbering, mobile overflow, and keyboard/focus behavior |
| A browser test file | Register it in `test/browser/all.js`; tests are not auto-discovered |
| A new non-browser gate | Wire it explicitly into `.github/workflows/test.yml`; Node tests are not auto-discovered |
| User-visible shipped behavior | Update `README.md` without presenting pending roadmap work or provisional ratings as complete |

Tests should be mutation-sensitive: reintroducing the bug must make the new
test fail. Avoid self-referential fixtures where mutable aliases, the code under
test, or duplicated constants can satisfy both the implementation and oracle.
Browser tests that seed `localStorage` before boot should use the harness's
pre-navigation injection or an app-less `/blank` page; seeding on the app page
and then reloading can be overwritten by the app's `pagehide` persistence.

The Master `11...e4` target regression test is intentionally diagnostic on the
current baseline: normal mode tracks the known miss, while `--require-fix` is opt-in.
Do not claim that incident is fixed or make the opt-in gate mandatory without a
genuinely new candidate and its required formal evidence.

## Rust/WASM rules

- The reproducible build is pinned in `experiments/wasm/README.md`, the
  toolchain file, build script, and CI. Do not casually change Rust, Binaryen,
  target features, memory limits, link flags, or lockfiles.
- The production module has fixed linear memory and no WASI, allocator,
  `wasm-bindgen`, threads, or per-node allocation. Any change to these
  constraints needs explicit performance, browser, offline, and correctness
  evidence.
- Build through `experiments/wasm/build.sh`; copy only the pinned `fast` output
  to `assets/chessy-ai-fast.wasm`, then bump the release unit. Never accept a
  locally produced binary that fails byte-for-byte CI reproduction.
- `test/fixtures/wasm-r69-signatures.json` is immutable evidence tied to its
  recorded historical commit. Never regenerate or relabel it from current
  bytes; a new behavioral baseline needs separately versioned evidence.
- `test/gen-wasm-signatures.js` intentionally rejects every module except the
  exact r69 hash. Do not weaken that guard or overwrite the r69 fixture; an
  approved new production baseline requires a separately named fixture,
  generator contract, and review.
- Preserve score perspective, mate ordering, repetition identity/counts,
  complete legal-root analysis, shared-budget accounting, and legal PV replay.

## Evaluation and experiment discipline

- Baselines and frozen fixtures are reviewed contracts. Do not rebaseline just
  to make a failure green, shrink coverage, inspect a locked split for routine
  tuning, or silently change an oracle/config/selection rule.
- Correctness scorecards gate at 100%. Quality ratchets may improve without
  treating unsolved positions as infrastructure failures. Coverage counts are
  part of the result.
- The current v1 fixed-node runners encode 100 openings × 4 seed slots × both
  colors. Rust/WASM search has no seed input, so the four slots are deterministic
  repeats: existing clustered results contain 100 independent opening clusters,
  not 400. They are not automatically invalid, but v1 wastes 75% of its games;
  do not dispatch it for a new candidate.
- Replace v1 under a new manifest hash and protocol identity with 400 distinct
  openings × both colors = 800 games, clustered by opening. Pre-register the
  budget, ply cap, selection rule, and acceptance threshold, and update the
  runner, aggregator, workflows, tests, and README together. Never relabel or
  combine v1 artifacts as v2 evidence.
- The lower >49% bound is only for a separately demonstrated material
  efficiency optimization under the formal WASM efficiency protocol. It is not
  a substitute strength gate. Equal-time infrastructure remains diagnostic.
- Never selectively rerun shards, retry a valid statistical miss, combine
  artifacts from dispatches, stop early, or choose a protocol after seeing the
  result. A genuinely changed candidate requires a fresh complete preregistered
  run.
- Candidate-controlled deep/equal-time workflows are diagnostic. Formal
  merge-authoritative workflows keep verdict code and artifacts bound to the
  trusted base and exact candidate. Do not broaden a `pull_request_target`
  permission, candidate path allowlist, action pin, or maintainer-label trigger
  casually.
- Provisional 1500–2300+ labels are calibration targets, not certified human,
  FIDE, Chess.com, or Lichess Elo. Follow #84, #87, and #113 for device and
  external-calibration evidence; do not infer rating from nodes, NPS, or depth.
- NNUE/HCE work follows #105/#137 and cannot bypass the frozen HCE/device,
  licensing, holdout, runtime, and strength gates.

For data, labelling, and training pipelines—including experimental branches:

- Hash and consume the same retained descriptor or immutable snapshot; never
  authenticate a pathname and reopen it later for parsing or training.
- Execute verified tools from an immutable retained inode/snapshot. Capture
  implementation, config, source, and manifest identities before long work and
  recheck them under the publication lock.
- Require the complete declared shard inventory independently for every input
  role. Keep certification/test clusters and families out of selection and
  training, even if an adjacent manifest is internally self-consistent.
- Publish related artifacts under one exclusive output-prefix lock with
  no-replace semantics, data first and authenticated completion metadata last.
  Roll back only artifacts owned by the losing writer.
- Sample, smoke, diagnostic, or mechanism-only artifacts cannot become
  fit-eligible, certified, publishable, or production inputs by omission.
  Preserve source and generated-artifact licensing; never assume MIT covers
  third-party data, labels, weights, or checkpoints.
- Generate `eval/corpus/**` and baseline artifacts through their scripts; do
  not hand-format hash-bound files. `fetch-corpus.js` is the intentional online
  source-refresh step, while `gen-corpus.js` must remain deterministic offline.

## Validation

Run focused tests first, then the CI-equivalent suites for every boundary the
change touches. `.github/workflows/test.yml` is the authoritative full command
list; the README intentionally shows only a subset.

Basic hygiene:

```sh
git diff --check
git diff --name-only --diff-filter=ACM -- '*.js' | xargs -r -n1 node --check
```

Rust/WASM changes (requires the pinned Rust/Binaryen tools):

```sh
(cd experiments/wasm && cargo test --locked --offline)
./experiments/wasm/build.sh
cmp experiments/wasm/dist/chessy-ai-fast.wasm assets/chessy-ai-fast.wasm
node test/wasm-asset.test.js
node test/wasm-signatures.test.js
node test/analysis-core.test.js
node test/ai-tactics.js
```

Evaluation-contract changes:

```sh
npm install --no-save chess.js@1.4.0
node test/eval/scorecard.js --baseline eval/BASELINE.json
node test/eval/analysis-scorecard.js --baseline eval/ANALYSIS-BASELINE.json
node test/eval/gen-corpus.js
git diff --exit-code -- eval/corpus/
```

Browser parity (CI pins the version):

```sh
npm install --no-save playwright@1.61.1
npx playwright install chromium webkit
BROWSER=chromium node test/browser/all.js
BROWSER=webkit node test/browser/all.js
```

Do not commit `node_modules`, `package.json`, or lockfiles created by local
tooling; the repository deliberately has no npm runtime manifest. For a
documentation/symlink-only change, hygiene and link verification are sufficient.

## Completion checklist

- Confirm the diff contains only intended files and no generated/local tooling
  residue.
- Confirm stacked-branch ancestry and validate the final head, not only an
  earlier reviewed commit.
- Confirm release-token, script order, worker URL, and precache coupling when
  runtime files changed.
- Run focused tests plus every affected CI-equivalent suite; report exactly
  what ran and any environment-limited gap.
- Keep README claims, persisted schemas, fixtures, and tests aligned with the
  implementation. State pending, diagnostic, waived, failed, and certified
  work truthfully and distinctly.
