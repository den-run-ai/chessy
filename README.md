# ♞ Chessy — Offline Chess PWA

A completely offline, installable chess web app. Zero dependencies, zero
network requests, zero build step — plain HTML, CSS, and vanilla JavaScript.

**▶ Play it: <https://den-run-ai.github.io/chessy/>** (works offline and is
installable once loaded — deployed automatically from `main` by GitHub Actions.)

## Features

- **Complete chess rules** — legal move generation with castling, en passant,
  and promotion; check, checkmate, and stalemate detection; draws by the
  50-move rule, threefold repetition, and insufficient material.
- **Play modes** — local two-player (hot-seat), or vs. the built-in computer
  as either color. Minimax with alpha-beta pruning and piece-square tables,
  running in a Web Worker so the UI never blocks. Five difficulty levels:
  Easy/Medium/Hard/Expert are increasing search depths (1/2/3/5 plies);
  **Master** adds quiescence search with delta pruning on top of Expert, so
  captures are resolved past the horizon and it stops falling for exchange
  tricks.
- **UI** — responsive board, tap/click to move, legal-move hints, last-move and
  check highlights, SAN move list, captured pieces, undo, board flip,
  promotion picker.
- **Persistence** — the game is saved to `localStorage`, so it survives
  reloads and app restarts.
- **PGN export** — save the game in standard PGN, plain or with an embedded
  debug log (engine depth/quiescence, think time, and the FEN before every
  move) for troubleshooting.
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

## Structure

| Path | Purpose |
| --- | --- |
| `index.html` | App shell |
| `js/engine.js` | Chess rules engine (move generation, status, SAN, FEN) |
| `js/ai.js` | Minimax + alpha-beta computer opponent |
| `js/ai-worker.js` | Web Worker wrapper so the search runs off the main thread |
| `js/app.js` | Board UI, game flow, persistence |
| `css/style.css` | Styling |
| `sw.js` | Service worker (precache, cache-first) |
| `manifest.webmanifest` | PWA manifest |
| `icons/` | App icons (generated, no external assets) |
| `test/engine.test.js` | Engine test suite |
