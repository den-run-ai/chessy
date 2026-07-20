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
  with delta pruning (captures are resolved past the horizon, so it stops
  falling for exchange tricks) and thinks on a 2-second-per-move budget,
  deepening as far as the clock allows.
- **UI** — responsive board, tap/click to move, legal-move hints, last-move and
  check highlights, SAN move list, captured pieces, undo, board flip,
  promotion picker. Game replay: click any move (or use the ⏮◀▶⏭ controls,
  arrow/Home/End keys) to review earlier positions — browsing is read-only
  and never disturbs the live game; after a game ends, "Review game" starts
  the replay and "Rematch" starts over. Undo during an AI search cancels the
  search and takes back the triggering move.
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
- **Game archive (coaching foundation)** — two sections: **Play · Review**.
  Finished games are archived automatically to IndexedDB (with per-move
  clock/think evidence and which side you played), and "Review game" after
  a game ends opens the archived game in a position-by-position browser.
  PGN games can be imported with an "I played White/Black" choice — the
  parser tolerates real-world exports (comments, variations, NAGs, glued
  move numbers, `0-0` castling, multi-game and tagless files) and every
  imported game is replay-validated before it is stored.
  **Scan for key moments** runs a quick engine pass over *your* decisions
  only and lists up to two moments without revealing severity — a
  deliberately *experimental Chessy estimate* (single-line, sub-second
  probes), not authoritative analysis. Flagging a moment requires your
  *own* reading first (threat, candidates, evaluation — all required; the
  engine's verdict stays hidden until you answer), then verifies in a
  dedicated worker (with a watchdog + synchronous fallback) and saves a
  lesson card: error cards need your cause diagnosis, good moves become
  positive *pattern* cards.
  Reflection, engine verification, lesson cards and spaced review build on
  this archive (coaching roadmap
  [#23](https://github.com/den-run-ai/chessy/issues/23)). The archive
  assumes one active tab; a unique per-game signature makes the one real
  cross-tab hazard (archiving the same finished game twice) safe at the
  database level.
- **PWA** — a service worker precaches every asset on first load; afterwards
  the app works with no network at all, and can be installed to the home
  screen / desktop via the web app manifest.

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
```

Browser suites drive the real app headless via Playwright — replay/review,
board accessibility (ARIA grid + keyboard), New Game setup + validated
restore + offline status, chess clocks (including a real flag fall and a
reload-refund regression), and the game archive (auto-archive, dedupe,
review browsing). Each suite gets a fresh web origin so service-worker,
localStorage and IndexedDB state never leak between them:

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
| `js/engine.js` | Chess rules engine (move generation, status, SAN, FEN) |
| `js/ai.js` | Computer opponent: iterative deepening, alpha-beta, transposition table, quiescence |
| `js/ai-worker.js` | Web Worker wrapper so the search runs off the main thread |
| `js/app.js` | Board UI, game flow, persistence |
| `js/store.js` | IndexedDB game archive (games, lesson cards) |
| `js/coach.js` | Review: archived-game list + position browser |
| `css/style.css` | Styling |
| `sw.js` | Service worker (precache; network-first navigations, stale-while-revalidate assets) |
| `manifest.webmanifest` | PWA manifest |
| `icons/` | App icons (generated, no external assets) |
| `test/engine.test.js` | Engine test suite |

## License

[MIT](LICENSE)
