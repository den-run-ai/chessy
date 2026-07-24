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
  mobility, doubled/isolated/passed pawns, and king safety — the pawn shield,
  open/semi-open files near the king, and a non-linear king-danger term that
  rewards coordinated attacks on the enemy king (so a mating attack outweighs
  the material it invests, not the other way round). The
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
  running game, and starting over always goes through an explicit
  confirmation.
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
  and app restarts. Restores are validated by replaying every recorded move
  through the rules engine and checking the final position — a corrupted or
  tampered save falls back to a fresh game instead of undefined behavior.
- **Offline status** — the footer reports the real service-worker state
  (caching, ready offline, updating, failed, unsupported) instead of an
  unconditional claim.
- **PGN export** — save the game in standard PGN, plain or with an embedded
  debug log (engine depth/quiescence, think time, and the FEN before every
  move) for troubleshooting.
- **Game archive (coaching foundation)** — finished games are recorded
  automatically to IndexedDB, keyed on a per-game UUID (idempotent
  re-archive; per-move clock/think evidence and the side you played are
  retained). A failed write is reported in the game-over dialog (or on a
  page-level note once it has closed).
- **Review (read-only)** — a Play/Review/Train/Progress tab bar; Review lists
  the archived games and browses any of them position by position on an
  accessible mini board (same ARIA grid model as the Play board,
  inspection-only). A running timed game stays visible from the coach views
  via a live-clock banner that returns to Play.
- **Reflection → lesson cards** — flag one of your own positions in Review;
  the engine stays hidden until you answer the reflection questions, and each
  probe snapshots the answers as submitted (a rewrite after the verdict can't
  reach that probe's card). One request runs at a time — Verify disables while
  it's in flight — and you can revise your answers and re-probe the same
  moment, which updates its **one card per moment** (game + ply) in place. You
  own the diagnosis: a move that differs from Chessy's line is not declared
  wrong ("my move was also sound" is a first-class cause), and you write the
  one-sentence lesson.
- **Train** — due lesson cards replayed on the mini board, on the fixed
  **1 / 3 / 7 / 14 / 30 / 90-day** spaced ladder (Good climbs a rung, Hard
  repeats it, Again retries in ten minutes). No background timers — the queue
  rebuilds on view entry or the Refresh button. Grading is atomic and honest:
  a different answer "differs", it is not marked wrong.
- **Progress** — a read-only descriptive snapshot: games archived, lesson
  cards, due-now, 30-day reviews, and per-cause tallies. The one narrow signal
  ("matched Chessy's saved move on first try") is labelled as exactly that —
  **no headline accuracy**, weakness ranking, or confidence claims.
- Coaching-data import (PGN/Lichess), automatic scanning, archive
  export/restore + Delete All, and a language coach remain future work
  (roadmap [#23](https://github.com/den-run-ai/chessy/issues/23)). Standard PGN
  export and the validated single-game restore, described above, already ship.
- **PWA** — a service worker precaches every asset on first load; afterwards
  the app works with no network at all, and can be installed to the home
  screen / desktop via the web app manifest. Assets load as **release
  units**: every executable asset URL carries the release token and is
  cached per release, so a page always runs the scripts of its own release
  — never new HTML with old cached scripts (or the reverse) during an
  update. A browser test drives an old-worker → new-release transition
  (online and offline) and gates the token's coherence across files.

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
```

Two more AI tools are manual (too slow for PR CI): `node test/ai-bench.js
--base origin/main` measures search nodes over 16 benchmark positions
against a git ref, and `node test/ai-match.js --base origin/main` plays an
800-game paired self-play match (100 openings x 4 seeds x both colors; also
available as the "AI self-play match" workflow_dispatch action).

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
| `assets/app.js` | Board UI, game flow, persistence |
| `assets/store.js` | IndexedDB coaching store (games, lesson cards) |
| `assets/archive.js` | Records finished games into the store |
| `assets/mini-board.js` | Accessible read-only mini board for the coach views |
| `assets/review.js` | Review view: tabs, archived-game list, position browser |
| `assets/analysis-core.js` | Deterministic, provider-neutral analysis contract (MultiPV over every legal root, played-move standing, legal PVs, provenance) |
| `assets/analysis-worker.js` | Dedicated coaching-analysis Web Worker running the contract off the main thread |
| `assets/analysis-service.js` | Analysis transport: one interactive job, cancellation, watchdog + retry, validated IndexedDB result cache |
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
