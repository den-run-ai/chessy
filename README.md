# Chessy

[Play Chessy](https://den-run-ai.github.io/chessy/) ·
[Player guide](docs/PLAYING.md) ·
[Developer guide](docs/DEVELOPMENT.md) ·
[Release notes](CHANGELOG.md)

Chessy is an installable chess app that works offline after its first load.
Play against the computer or a friend, review your games, and turn your own
reflections into spaced practice. Games and training data stay in your browser;
no account is required.

The app uses plain HTML, CSS, and JavaScript with a dependency-free Rust engine
compiled to WebAssembly. Search runs in background workers. The shipped app
needs no build step, external libraries, analytics, or remote chess service.

## Features

| View | What you can do |
| --- | --- |
| Play | Face five computer levels with varied openings or a local opponent. Choose either color, use optional clocks, undo moves, and replay the game. |
| Review | Browse saved or imported games, find critical moments, and reflect before revealing engine analysis. |
| Train | Practice your lesson cards on a spaced review schedule. |
| Progress | See game and practice counts, due cards, and storage usage. |

The board supports touch, mouse, keyboard navigation, and screen readers.
You can export PGN, include a diagnostic log, or back up games and lesson
cards together as JSON.

Computer ratings are provisional calibration targets. They are not certified
FIDE, Chess.com, or Lichess ratings. The [player guide](docs/PLAYING.md) explains
difficulty, clock behavior, draw rules, and the limits of engine analysis.

## Get started

1. Open [Chessy](https://den-run-ai.github.io/chessy/) and choose **New game**.
2. Select the opponent, difficulty, and time control, then press **Start game**.
3. Wait for the footer to confirm offline readiness before disconnecting.

Use your browser's install or **Add to Home Screen** action to keep Chessy
on your phone or desktop. The header shows the running release; the footer
reports caching, updates, and offline availability.

## Run it

From the repository root, start a local static server:

```sh
python3 -m http.server 8000
```

Open [localhost:8000](http://localhost:8000). No package installation is needed
to run the app. Use localhost or HTTPS for service workers and installation.

## Test

Start with the rules and fixed-node tactics suites:

```sh
node test/engine.test.js
node test/ai-tactics.js
```

The [developer guide](docs/DEVELOPMENT.md) covers focused tests, Chromium and
WebKit checks, and CI. Rust builds and engine changes have additional
[WASM requirements](experiments/wasm/README.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Playing and training](docs/PLAYING.md) | Controls, clocks, review, lessons, offline use, and backups |
| [Development](docs/DEVELOPMENT.md) | Local setup, testing, contribution checks, and deployment |
| [Architecture](docs/ARCHITECTURE.md) | Module ownership, search budgets, analysis, storage, and updates |
| [Release notes](CHANGELOG.md) | Recent app changes |
| [Evaluation](eval/README.md) | Correctness, coaching quality, calibration, and research evidence |
| [Training research](eval/training/README.md) | Data preparation, evaluator experiments, and admission requirements |
| [Rust/WASM engine](experiments/wasm/README.md) | Reproducible build, ABI, resource limits, and engine tests |
| [Agent guide](CLAUDE.md) | Repository instructions for coding agents |

## Structure

| Path | Purpose |
| --- | --- |
| `index.html`, `assets/` | App shell, interface, rules, workers, and shipped engine |
| `experiments/wasm/` | Production Rust engine source and isolated experiments |
| `test/`, `eval/` | Regression tests, evaluation tools, and recorded evidence |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline caching and installation |
| `docs/` | Player and developer guides |

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) and the
[evaluation license report](eval/LICENSE-REPORT.md) for external data and tools.
