# ♞ Chessy — Offline Chess PWA

A completely offline, installable chess web app. Zero dependencies, zero
network requests, zero build step — plain HTML, CSS, and vanilla JavaScript.

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
  as either color. Iterative-deepening minimax with alpha-beta pruning, a
  Zobrist-keyed transposition table, and hash/killer/history move ordering,
  running in a Web Worker so the UI never blocks. The evaluation is tapered
  between midgame and endgame (the king hides, then centralizes) and scores
  mobility, doubled/isolated/passed pawns, and the king's pawn shield. The
  search knows about draws: repetitions of game or search-path positions and
  dead positions score 0, so it avoids repeating when winning, heads for
  perpetual check when losing, and won't grab a last piece that kills its own
  mating material. Five difficulty levels: Easy/Medium/Hard/Expert are
  increasing search depths (1/2/3/5 plies); **Master** adds quiescence search
  (captures are resolved past the horizon, so it stops falling for exchange
  tricks, with a bounded quiet-check extension so a mating check just past the
  horizon isn't missed) and thinks on a 5-second-per-move budget, deepening as
  far as the clock allows.
- **UI** — responsive board, tap/click to move, legal-move hints, last-move and
  check highlights, SAN move list, captured pieces, undo, board flip,
  promotion picker. Game replay: click any move (or use the ⏮◀▶⏭ controls,
  arrow/Home/End keys) to review earlier positions — browsing is read-only
  and never disturbs the live game; after a game ends, "Review game" opens
  the archived record in the coaching Review view (falling back to the
  on-board replay if Review is unavailable) and "Rematch" starts over. Undo
  during an AI search cancels the search and takes back the triggering move.
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
  remaining clocks, so replay shows the clocks as they stood, undo rewinds
  them, and the debug PGN embeds standard `[%clk h:mm:ss]` comments plus a
  `TimeControl` tag. The live clock is persisted whenever the page is
  hidden or closed, so reloading never refunds thinking time.
- **Persistence** — the game is saved to `localStorage` and survives reloads
  and app restarts. Each computer move retains its release, effective search
  config, actual initial root order, completed/attempted depth, counters,
  White-POV score (including mate-distance encoding), stop/fallback reason and
  best-effort PV for incident diagnosis. The captured root order can be supplied
  back to the engine for an exact fixed-node replay even when casual Play used
  an unseeded shuffle. Restores are validated by replaying every recorded move
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
  White-POV score, release/execution/fallback path, stop reason, captured root
  order, best-effort PV, and the FEN before every move) for troubleshooting.
- **Game archive (coaching foundation)** — finished games and non-empty games
  displaced by New Game are recorded to IndexedDB, keyed on a per-game UUID
  (idempotent re-archive; per-move clock/think and computer-search evidence,
  game-start release, and the side you played are retained). Displaced games
  use PGN `Result "*"` and `Termination "abandoned"` rather than inventing a
  loss. A failed finish write is reported in the game-over dialog (or on a
  page-level note once it has closed); a failed incomplete checkpoint keeps the
  live game and reports inside New Game.
- **Review (read-only)** — a Play/Review/Train/Progress tab bar; Review lists
  the archived games and browses any of them position by position on an
  accessible mini board (same ARIA grid model as the Play board,
  inspection-only). The selected archive record can be saved as a clean PGN,
  including imported tags, annotations, and custom SetUp/FEN positions. A
  running timed game stays visible from the coach views via a live-clock banner
  that returns to Play. Raw archive rows are revalidated before display;
  malformed FENs or illegal replays are skipped with a visible count and
  preserved unchanged for backup or recovery.
- **Critical-moment suggestions** — Review can explicitly start, pause, and
  resume a durable two-pass scan of the player's decisions. Imported games
  with no known player side ask for White, Black, or Both first. The scan shows
  accessible progress and at most two move-location suggestions; scores,
  categories, and alternative moves remain hidden. Opening a suggestion
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
  **no headline accuracy**, weakness ranking, or confidence claims.
- **Coaching data controls** — paste or upload one PGN into the archive
  (legality-validated and deduplicated), back up games/cards to versioned JSON,
  including release/search provenance, atomically restore a validated backup,
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
node test/ai-telemetry.test.js      # behavior-neutral search provenance
node test/ai-match-cli.test.js      # match-budget validation/time smoke
node test/runtime-update.test.js
```

The AI measurement tools are manual (too slow for PR CI). `node
test/ai-bench.js --base origin/main` measures search nodes over 16 benchmark
positions against a git ref. `test/ai-match.js` supports one formal paired
protocol plus diagnostic modes. Only `--formal --nodes 10000 --plies 180`
aggregated over 100 openings x 4 seeds x both colors (800 games), against a
distinct base commit, is the formal gate for a pure evaluation/strength
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
valid statistical miss. Start a fresh complete 20-shard run for a genuinely
new experiment, because post-selection invalidates the predeclared result.

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
binary.) Both test layers run on every pull request via GitHub Actions —
the browser suites on both Chromium and WebKit — and deploys to Pages are
gated on the engine *and* browser suites.

## Structure

| Path | Purpose |
| --- | --- |
| `index.html` | App shell |
| `assets/engine.js` | Chess rules engine (move generation, status, SAN, FEN) |
| `assets/ai.js` | Computer opponent: iterative deepening, alpha-beta, transposition table, quiescence |
| `assets/ai-worker.js` | Web Worker wrapper so the search runs off the main thread |
| `assets/runtime-update.js` | Release-freshness gate for New game/Rematch |
| `assets/app.js` | Board UI, game flow, persistence |
| `assets/store.js` | IndexedDB coaching store (games, lesson cards, analysis cache, resumable scan jobs) |
| `assets/archive.js` | Records finished and deliberately abandoned games into the store |
| `assets/mini-board.js` | Accessible read-only mini board for the coach views |
| `assets/review.js` | Review view: tabs, archived-game list, position browser, and spoiler-free scan controls/suggestions |
| `assets/analysis-core.js` | Deterministic, provider-neutral analysis contract (MultiPV over every legal root, played-move standing, legal PVs, provenance, bounded progress checkpoints) |
| `assets/analysis-worker.js` | Dedicated coaching-analysis Web Worker running the contract and throttling non-terminal progress off the main thread |
| `assets/analysis-service.js` | Analysis transport: one interactive job, owner-scoped progress/cancellation, watchdog + retry, validated IndexedDB result cache |
| `assets/analysis-result.js` | Shared trust boundary for cached/worker analysis (provenance, completeness, legal canonical lines, stable-depth evidence) |
| `assets/moment-selector.js` | Pure, deterministic critical-moment evidence, collapse suppression, clustering and deep-admission policy |
| `assets/moment-scan.js` | Explicit, sequential two-pass scan controller with durable checkpoints, pause/resume and spoiler-safe public state |
| `assets/reflection.js` | Manual reflection flow: flag → answer → contract analysis → lesson card |
| `assets/train.js` | Train view: due-card queue on the fixed spaced-review ladder |
| `assets/progress.js` | Progress view: read-only descriptive counts |
| `assets/style.css` | Styling |
| `sw.js` | Service worker (precache; network-first navigations, stale-while-revalidate assets) |
| `manifest.webmanifest` | PWA manifest |
| `icons/` | App icons (generated, no external assets) |
| `test/engine.test.js` | Engine test suite |

## License

[MIT](LICENSE)
