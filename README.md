# ♞ Chessy — Offline Chess PWA

A completely offline, installable chess web app. The shipped PWA has no runtime
dependencies or network requests: plain HTML/CSS/JavaScript around a
dependency-free Rust/WebAssembly chess engine.

**▶ Play it: <https://den-run-ai.github.io/chessy/>** (works offline and is
installable once loaded — deployed automatically from `main` by GitHub Actions.)

## Features

- **Chess rules** — legal move generation with castling, en passant, and
  promotion; check, checkmate, and stalemate detection; draws by the 50-move
  rule, threefold repetition (with FIDE 9.2.3 en-passant-rights
  normalization), and dead positions (insufficient material, incl. any number
  of same-colored bishops). One deliberate simplification for casual play:
  threefold and 50-move draws are applied automatically instead of FIDE's
  claim-based procedure (automatic would be five-fold/75 moves).
- **Play modes** — local two-player (hot-seat), or vs. the built-in computer
  as either color. The Rust/WASM engine uses iterative-deepening minimax with
  alpha-beta pruning, a
  Zobrist-keyed transposition table, and hash/killer/history move ordering,
  running in a Web Worker so the UI never blocks. The evaluation is tapered
  between midgame and endgame (the king hides, then centralizes) and scores
  mobility, doubled/isolated/passed pawns, and the king's pawn shield. The
  search knows about draws: repetitions of game or search-path positions and
  dead positions score 0, so it avoids repeating when winning, heads for
  perpetual check when losing, and won't grab a last piece that kills its own
  mating material. All five difficulty levels use quiescent iterative
  deepening. Easy/Medium/Hard/Expert use reproducible 10k/10k/36k/230k-node
  caps (Easy also stops at depth 2); each also has a five-second safety
  ceiling, so slower devices can stop earlier. **Master** thinks for
  up to eight seconds, with uncapped nodes and the full supported 111-ply
  ceiling. In timed games, every level reserves time for move delivery and
  one identical-request retry after a reported worker failure (a silent worker
  is only detected by a watchdog three seconds past the limit, which a very low
  clock may not cover); the effective limit decreases as the clock runs down
  (and is retained in move telemetry). An AI clock that is already empty flags
  before any search starts. If the engine's fixed transposition table fills
  during an uncapped Master search, the deepest completed iteration's move is
  played. Search is WASM-only
  and Worker-only: a failed worker is retried once against the exact unchanged
  position, then Play stops visibly with a manual Retry action rather than
  substituting another engine. The displayed 1500/1700/1900/2100/2300+ bands
  are provisional
  calibration targets on an external engine-rating scale—not certified FIDE,
  Chess.com, or Lichess ratings; absolute and adjacent-level certification
  remains tracked in #87/#113. In r80 the budgets moved up one label after an
  exploratory screen against pinned Stockfish 18 on a Linux container
  (`eval/level-screen-r80/`) placed each r79 budget about one label above its
  target: 10k, 36k and 230k nodes now serve Medium, Hard and Expert, the
  1.44M-node preset (already Master strength there) was dropped, and Easy is
  new. That screen is exploratory, not an E4-v1 certification, and the
  historical E4 artifacts stay unchanged; a fresh protocol/holdout and
  supported-device measurements are required before certifying this ladder.
- **Analysis headroom** — quick whole-game screening stays inexpensive.
  Selected moments, manual verification and Train's live check share one
  immutable deep profile: an uncapped-node, up-to-16-second scan (twice
  Master's time), then one exact phase of at most 16M nodes that scores
  **every** legal move under a full window at depth 1, 2, 3, … up to the
  scan's depth (at least depth 3). The reported depth is the deepest depth at
  which every move was verified — usually a few plies below the scan, and
  shown as such — and the previous depth supplies stability. If the deeper
  scan prefers a move that the verified depth ranks strictly lower, the best
  move is marked unstable, so Chessy adds no mistake mark and suggests no
  moment from it; a manual Verify still shows its lines and leaves the
  diagnosis to the player. This allocates more search than Master, not a
  guarantee of a better move in every position: the engine's fixed
  transposition table can stop Master and the scan at the same node count on
  fast devices, and a timed scan's depth depends on the device. A result is
  partial only if not even depth 1 completes; it then keeps only the scan's
  single best move, never an invented PV or full-MultiPV claim. Deep work
  remains worker-only and cancellable; node budgets are work caps, not
  wall-clock promises, and slow devices can reach the service watchdog.
  Because the deep profile changed, a Review scan completed under r79
  restarts when reopened (its deep evidence no longer matches), and manual
  verifications are recomputed rather than served from the old cache.
- **UI** — responsive board, tap/click to move, legal-move hints, last-move and
  check highlights, SAN move list, captured pieces, undo, board flip,
  promotion picker. Game replay: click any move (or use the ⏮◀▶⏭ controls,
  arrow/Home/End keys) to review earlier positions — browsing is read-only
  and never disturbs the live game; after a game ends, "Review game" opens
  the archived record in the coaching Review view (falling back to the
  on-board replay if Review is unavailable) and "Rematch" starts over. Undo
  during an AI search cancels the search and takes back the triggering move.
  Resign and Offer draw controls use a confirmation that immediately freezes
  the clock and any computer search; resignation records the correct losing
  side, while the draw confirmation records an agreed result.
- **Accessibility** — the board is an ARIA grid (rows/gridcells) with a single
  roving tab stop: Tab enters the board once, arrow keys move square to square
  (directions follow the visual board, also when flipped), Home/End jump to
  row edges, Enter/Space selects and moves. Every square announces its name,
  piece and state (selected, legal move, capture available, in check,
  last move) to assistive technology.
- **Game setup** — a New Game dialog chooses opponent (two players, or the
  computer as either color), difficulty, and time control; settings apply
  only when Start is pressed, so browsing the dialog never disturbs the
  running game. Starting over after at least one move first saves the displaced
  game to Review as **Incomplete · Abandoned**; if that checkpoint fails, the
  current game stays in place unless the player explicitly starts without
  saving it. Zero-move starts do not clutter the archive.
- **Chess clocks** — optional Fischer time controls (5+3, 15+10, 30+20) for
  both players including the computer. Flag falls end the game, with the
  FIDE 6.9 nuance that the game is a draw — not a loss — when the flagging
  player's opponent could not possibly checkmate by any series of legal
  moves (a helpmate counts, tested on the full position with both sides'
  pieces on the board). Every move records its think time and both
  remaining clocks. During replay the primary clocks stay live and visibly
  active, while a separately labelled snapshot shows the clocks after the
  viewed move; replay exits automatically when the live side reaches 20
  seconds. Undo rewinds the clocks, and the debug PGN embeds standard
  `[%clk h:mm:ss]` comments plus a `TimeControl` tag. The live clock is
  persisted whenever the page is hidden or closed, so reloading never refunds
  thinking time.
- **Persistence** — the game is saved to `localStorage` and survives reloads
  and app restarts. Each computer move retains its release, effective search
  config, completed/attempted depth, counters, White-POV score (including
  mate-distance encoding), stop reason, and engine identity for incident
  diagnosis. Historical JavaScript/fallback provenance remains
  readable and exportable but is never an executable path. Restores are
  validated by replaying every recorded move
  through the rules engine and checking the final position — a corrupted or
  tampered save falls back to a fresh game instead of undefined behavior.
- **Offline status and version** — the persistent header shows the running
  `rN` release, while the footer reports the real service-worker state
  (caching, ready offline, updating, failed, unsupported) instead of an
  unconditional claim. After a real offline-app upgrade, a non-modal,
  session-scoped note identifies the old and new releases and confirms that
  saved games and training data were not changed.
- **PGN export** — save the game in standard PGN, plain or with an embedded
  debug log (effective engine config, total/search time, counters and explicit
  White-POV score, release/execution/engine provenance, stop reason,
  any historical PV evidence, and the FEN before every move) for
  troubleshooting. Resignations and draws by agreement retain their exact
  result and use the standard `Termination "normal"` tag in both Play and
  Review exports.
- **Game archive (coaching foundation)** — finished games and non-empty games
  displaced by New Game are recorded to IndexedDB, keyed on a per-game UUID
  (idempotent re-archive; per-move clock/think and computer-search evidence,
  game-start release, and the side you played are retained). Displaced games
  use PGN `Result "*"` and `Termination "abandoned"` rather than inventing a
  loss; resignation and agreed-draw records remain scored terminal games.
  A failed finish write is reported in the game-over dialog (or on a
  page-level note once it has closed); a failed incomplete checkpoint keeps the
  live game and reports inside New Game.
- **Review (read-only game browsing)** — a Play/Review/Train/Progress tab bar; Review lists
  the archived games and browses any of them position by position on an
  accessible mini board (same ARIA grid model as the Play board,
  inspection-only). A complete, clickable SAN ledger is always shown and uses
  the archived move number/side for custom SetUp/FEN games. The selected archive
  record can be saved as a clean PGN, including imported tags, annotations, and
  custom SetUp/FEN positions. A running timed game stays visible from the coach
  views via a live-clock banner that returns to Play. Raw archive rows are
  revalidated before display; malformed FENs or illegal replays are skipped
  with a visible count and preserved unchanged for backup or recovery.
- **Critical-moment suggestions** — Review can explicitly start, pause, and
  resume a durable two-pass scan. An unusable deep check is recomputed on
  Resume, including after pausing or reloading during its retry. Its quick
  pass scores every non-terminal played move, while coaching nominations and
  at most two deep checks remain limited to the selected player's decisions.
  Imported games with no known
  player side ask for White, Black, or Both first. The scan shows accessible
  progress and at most two move-location suggestions; scores, categories,
  annotations, and alternative moves remain absent from public scan state
  until a valid structured reflection is submitted. That submission reveals
  only the matching move first; reflecting on every suggestion unlocks the
  scanned score trail. Each unlock receipt is durably bound to the exact game
  revision—including clock and time-control evidence—the replayed position,
  played SAN, and canonical structured answer, so it survives reload without
  trusting scan caches or lesson cards. Scores
  evaluate the played root line, use a fixed
  White-POV sign, and mark quick-pass values with `≈`.
  Chessy adds only conservative negative `?!`, `?`, or `??` badges to stable,
  deep-confirmed critical moments; imported move-quality PGN NAGs carry a
  separate `PGN` badge. Unresolved moves never receive an invented score.
  Opening a suggestion
  navigates to that position and starts a fresh blank reflection, and scanning
  is unavailable while a live timed game is running.
- **Reflection → lesson cards** — flag one of your own positions in Review;
  the engine stays hidden until you answer the reflection questions, and each
  probe snapshots the answers as submitted (a rewrite after the verdict can't
  reach that probe's card). One request runs at a time — Verify shows monotonic
  elapsed time, truthful initial-scan/root progress, and an accessible Cancel
  action, with no fabricated ETA or provisional score/PV streaming — and
  you can revise your answers and re-probe the same moment, which updates its
  **one card per moment** (game + ply) in place. You own the diagnosis: a move
  that differs from Chessy's line is not declared wrong ("my move was also
  sound" is a first-class cause), and you write the one-sentence lesson.
- **Train** — due lesson cards replayed on the mini board, on the fixed
  **1 / 3 / 7 / 14 / 30 / 90-day** spaced ladder (Good climbs a rung, Hard
  repeats it, Again retries in ten minutes). No background timers — the queue
  rebuilds on view entry or the Refresh button. Grading is atomic and honest:
  a different answer "differs", it is not marked wrong. A malformed saved card
  is quarantined independently, so it cannot hide otherwise valid due cards.
- **Progress** — a read-only descriptive snapshot: games archived, lesson
  cards, due-now, 30-day reviews, and per-cause tallies. The one narrow signal
  ("matched Chessy's saved move on first try") is labelled as exactly that —
  **no headline accuracy**, weakness ranking, or confidence claims. A Storage
  block shows the persistent-storage state and approximate usage/quota;
  persistence is requested once, after the first durable archive write, and
  reduces eviction exposure without guaranteeing it.
- **Coaching data controls** — paste or upload one PGN into the archive
  (legality-validated and deduplicated), back up games/cards/structured
  reflections to versioned JSON, including release/search provenance,
  atomically restore a validated backup,
  or Delete All behind a recovery fence. Bulk/Lichess import and an optional
  language coach remain future work (roadmap
  [#23](https://github.com/den-run-ai/chessy/issues/23), scan tracker
  [#73](https://github.com/den-run-ai/chessy/issues/73)).
- **PWA** — a service worker precaches every asset on first load; afterwards
  the app works with no network at all, and can be installed to the home
  screen / desktop via the web app manifest. Assets load as **release
  units**: every executable asset URL carries the release token and is
  cached per release, so a page always runs the scripts of its own release
  — never new HTML with old cached scripts (or the reverse) during an
  update. Long-open tabs check for a new worker when they return to view and
  immediately before New game or Rematch replaces the current save. If an
  update takes control, the page reloads into that release first and restores
  the current game; a failed check never blocks offline play. A browser test
  drives an old-worker → new-release transition (online and offline) and
  gates the token's coherence and this fresh-game boundary across files.

No fonts, images, or libraries are fetched from the network: pieces are
Unicode glyphs, styling is system fonts, and the icons ship in the repo.

## Run it

Serve the directory with any static file server and open it in a browser:

```sh
npx http-server .          # or: python3 -m http.server
```

(Service workers require a secure context, so use `localhost` or HTTPS —
opening `index.html` via `file://` works for playing, but not for the
offline/install features.)

## Test

The rules engine is validated against standard
[perft](https://www.chessprogramming.org/Perft_Results) node counts
(initial position, Kiwipete, and promotion/en-passant-heavy positions),
plus tests for endings, special moves, SAN, undo, and the AI:

```sh
node test/engine.test.js
node test/ai-tactics.js     # fixed-node, deterministic AI regression suite
node test/master-incident.test.js  # exact 2026-07-24 screenshot-game replay
node test/master-e4-regression.test.js  # exact r69 11...Bd4 miss; add --require-fix to gate a candidate
node test/ai-telemetry.test.js      # behavior-neutral search provenance
node test/wasm-signatures.test.js   # frozen pre-removal WASM behavior
node test/level-presets.test.js     # target bands and WASM budgets
node test/ai-match-cli.test.js      # match-budget validation/time smoke
node test/runtime-update.test.js
node test/analysis-notation.test.js # White-POV score + ?!/?/?? policy
node test/moment-scan.test.js       # durable scan and reflection-gated report
```

The Master e4 diagnostic treats Git commit `8b887c4` and the recorded WASM
SHA-256 as the immutable r69 artifact rather than committing a second binary.
After the shipped WASM changes, the test keeps validating the source/oracle
fixture but intentionally skips the exact r69 search signature; check out the
recorded commit to reproduce that historical result. Its pinned Stockfish Lite
comparison covers four forced root moves only, not every legal move.

The [versioned engine-signature mechanism](experiments/wasm/SIGNATURE-ROTATION.md)
prepares reproducibly rebuilt old/new contracts and a complete 144-case diff.
Activation requires evidence already present in the trusted base; this mechanism
retains the r69 behavior and does not authorize a new evaluator or search policy.

The engine measurement tools below are **historical v1 infrastructure**.
Do not dispatch them for a new candidate: Rust/WASM ignores the four seed
slots, so 800 games repeat only 100 opening pairs. The v2 execution work
from issue #156 replaces them.
The [prospective 400-opening CC0 manifest](eval/match-v2/PROVENANCE.md) is
frozen. The [v2 diagnostic runner](eval/match-v2/EXECUTION.md) registers exact
commits, raw modules and budgets before executing 20 complete shards with
both colors. It preserves and replays every move, repetition history and
terminal result. The fixed-node `evaluator-easy` (10k nodes, endpoint lower
bound >50%) and `selective-hard` (230k nodes, >49%) profiles are separate.
Their IDs predate r80 and do not track the Play presets (230k nodes is now
Expert). Every result
remains diagnostic: 400 unique endpoints do not prove 400 independent
families, and source reproduction, correctness and device admission remain
separate. The [fresh finite-bank formal software contract](eval/match-formal/CONTRACT.md)
adds randomized sampling, conservative uncertainty and authenticated prerequisites
under a separate protocol. Its conservative selective-search profile cannot
admit exactly behavior-preserving cost changes; their equivalence/runtime
policy remains open. Its campaign registry is empty: fresh-bank and
candidate evidence remain open in
[#175](https://github.com/den-run-ai/chessy/issues/175). The
[prospective decision and complete dependency map](eval/match-v2/ADMISSION-PROPOSAL.md)
explain the current bank's exposure limits and a possible future statistical
design. No candidate has been measured on this manifest. The
[expanded PeSTO pilot](eval/PESTO-PILOT-2026-09.md) changed
neither the shipped evaluator nor level budgets.
The [clean natural-game follow-up](eval/NATURAL-PILOT-2026-09.md) records the
50,000-position experiment, audited admission, frozen selection and mixed
80-game development result; no evaluator or level change ships.
The compact neural research continues through the
[original H4 screen](eval/neural-h4/REPORT.md),
[residual recipe repair](eval/neural-h4-v2/REPORT.md),
[phase and width screen](eval/neural-h4-v3/REPORT.md), and
[matched factorial and budget plateau](eval/neural-h4-v4/REPORT.md).
The [compiled synthetic cost report](eval/training/nnue-phase-runtime-results-2026-09.md)
separates parameter storage, module growth, memory and per-position overhead.
The [incremental accumulator comparison](eval/training/nnue-incremental-results-2026-09.md)
records faster direct evaluation but slower aggregate search.
These studies preserve the shipped evaluator and the separate admission gates.

For historical reproduction, `test/ai-match.js` supports the archived
paired-WASM protocol plus diagnostic modes. `--formal --nodes 10000 --plies 180`
aggregated over 100 openings x 4 seeds x both colors (800 games), against a
distinct base commit, was the formal gate for a pure evaluation/strength
change, and it passes only when the opening-clustered one-sided 95% lower
bound is strictly above 50%. The looser lower-bound-above-49% non-inferiority
criterion is not sufficient for such a change; it is reserved for a separately
demonstrated efficiency optimization. Any custom fixed-node budget or ply cap
emits a separate non-formal diagnostic protocol. Equal time
(`--time 5000 --seeds 1`, the same openings x both colors = 200 games) is DRAFT
diagnostic infrastructure, not a second merge gate. Prior opening-level
variance implies only about 12%
power to clear a one-percentage-point non-inferiority margin with 100 clusters:
a clean pass is useful strong evidence, but neither a pass nor a failure
replaces the fixed-node result. Equal-time artifacts also lack per-move
deadline/elapsed/overshoot records, so their equal-compute premise is not yet
independently auditable.

`--nodes` and `--time` are mutually exclusive. The separate "AI fixed-node
strict-strength gate" and "AI equal-time diagnostic (DRAFT)"
workflow-dispatch actions each fan out to exactly 20 shards and aggregate
automatically, so their check contexts cannot substitute for one another.
Formal shard artifacts report statistics but deliberately make no PASS/FAIL
claim; only the complete 800-game aggregate emits the strict-strength verdict.
A valid statistical miss fails the strict-strength check but is
informational/green in the equal-time diagnostic;
malformed, mixed or incomplete diagnostic artifacts still fail. Never
selectively rerun shards, combine artifacts across dispatches, or retry a
valid statistical miss. Historical protocol IDs and artifacts are retained;
new formal shipping evidence requires the fresh-bank campaign and complete
candidate prerequisites under #175. Historically exposed openings support only separately registered
development diagnostics, such as the natural-game pilot above.

Historical Rust/WASM search optimizations used a separate formal efficiency
non-inferiority protocol after first demonstrating a material efficiency
benefit. `test/wasm-efficiency-match.js` compares exact candidate and frozen
base modules across the reviewed ABI-v2/v1 ordinary-search boundary at the
same 10,000-node, 100-opening x 4-seed x both-colours, 180-ply contract; it
passes only when the opening-clustered one-sided 95% lower bound is strictly
above 49%. The production loader remains ABI-v2-only. The maintainer-label-gated
`WASM fixed-node efficiency gate` workflow is documented in
`experiments/wasm/README.md`; adding the shared harness alone does not launch
the 800-game run.

Browser suites drive the real app headless via Playwright — replay,
board accessibility (ARIA grid + keyboard), New Game setup + validated
restore + offline status, chess clocks (including a real flag fall and a
reload-refund regression), the service-worker release-unit transition, and
the coaching flow end to end (archive, Review browsing, reflection cards,
Train grading, Progress counts). Each suite gets a fresh web origin so
service-worker and localStorage state never leak between them:

```sh
npm install --no-save playwright
npx playwright install chromium
node test/browser/all.js            # BROWSER=webkit for the WebKit engine
```

(With `playwright-core` instead, point `CHROMIUM_PATH` at a Chromium
binary.) Every pull request and every `main` deployment runs the same six CI
checks: hygiene, pinned Rust/WASM reproducibility, release-token enforcement,
the complete engine/eval job, Chromium, and WebKit. Pages deployment waits for
all six. A separate **Full evaluation** action runs the complete 117-case
correctness and 103-case analysis scorecards weekly and on manual pre-release
dispatch.

## Structure

| Path | Purpose |
| --- | --- |
| `index.html` | App shell |
| `assets/engine.js` | Chess rules engine (move generation, status, SAN, FEN) |
| `assets/chessy-ai-fast.wasm` | Rust search/evaluation engine used by Play and coaching analysis |
| `assets/wasm-engine.js` | Strict ABI-v2 loader for search, history, exact-root analysis, evaluation, and PVs |
| `assets/ai-telemetry.js` | Search-provenance sanitizer, including read-only legacy JS/fallback compatibility |
| `assets/level-presets.js` | Stable difficulty IDs, provisional rating targets, and search budgets |
| `assets/ai-worker.js` | WASM-only Play worker |
| `assets/runtime-update.js` | Release-freshness gate for New game/Rematch |
| `assets/app.js` | Board UI, game flow, persistence |
| `assets/store.js` | IndexedDB coaching store (games, lesson cards, durable revision-bound reflection receipts, bounded LRU analysis cache, resumable scan jobs) |
| `assets/storage-health.js` | One-time persistent-storage request (after the first durable archive write) and the Progress storage snapshot |
| `assets/archive.js` | Records finished and deliberately abandoned games into the store |
| `assets/mini-board.js` | Accessible read-only mini board for the coach views |
| `assets/review.js` | Review view: tabs, archived-game list, position browser, full SAN ledger, and gated score/annotation overlays |
| `assets/analysis-core.js` | Rust/WASM analysis contract: deterministic fixed-node quick analysis, and timed deep analysis whose iterative exact verification is capped by a device-dependent scan depth (exact MultiPV over every legal root, played-move standing, legal PVs, provenance, bounded progress checkpoints) |
| `assets/analysis-worker.js` | Dedicated WASM coaching-analysis worker with throttled non-terminal progress |
| `assets/analysis-service.js` | Analysis transport: one interactive job, owner-scoped progress/cancellation, watchdog + retry, validated IndexedDB result cache |
| `assets/analysis-result.js` | Shared trust boundary for cached/worker analysis (provenance, completeness, legal canonical lines, stable-depth evidence) |
| `assets/moment-selector.js` | Pure, deterministic critical-moment evidence, collapse suppression, clustering and deep-admission policy |
| `assets/analysis-notation.js` | Versioned White-POV played-score summary and conservative deep `?!`/`?`/`??` policy |
| `assets/moment-scan.js` | Explicit, sequential two-pass scan controller with durable checkpoints, pause/resume and reflection-gated public reports |
| `assets/reflection.js` | Manual reflection flow: flag → answer → contract analysis → lesson card |
| `assets/train.js` | Train view: due-card queue on the fixed spaced-review ladder |
| `assets/progress.js` | Progress view: read-only descriptive counts and storage health |
| `assets/style.css` | Styling |
| `sw.js` | Service worker (precache; network-first navigations, stale-while-revalidate assets) |
| `manifest.webmanifest` | PWA manifest |
| `icons/` | App icons (generated, no external assets) |
| `test/engine.test.js` | Engine test suite |

## License

[MIT](LICENSE)
