# Architecture

[Home](../README.md) · [Development](DEVELOPMENT.md) ·
[Player guide](PLAYING.md) · [Rust/WASM ABI](../experiments/wasm/README.md#raw-abi-version-2)

Chessy runs entirely in the browser. JavaScript owns the interface, independent
chess rules, storage, and worker coordination. Rust compiled to WebAssembly
owns computer search and position evaluation. Play and coaching use separate
workers so search does not block the interface.

## Module map

| Area | Main files |
| --- | --- |
| App shell and live game | `index.html`, `assets/app.js`, `assets/style.css` |
| Rules, legal moves, SAN, and FEN | `assets/engine.js` |
| Search, evaluation, and exact-root analysis | `experiments/wasm/src/`, `assets/chessy-ai-fast.wasm` |
| Play transport and evidence | `assets/wasm-engine.js`, `assets/ai-worker.js`, `assets/ai-telemetry.js` |
| Difficulty and clock budgets | `assets/level-presets.js` |
| Analysis orchestration and validation | `assets/analysis-core.js`, `assets/analysis-worker.js`, `assets/analysis-service.js`, `assets/analysis-result.js` |
| Review and reflection | `assets/review.js`, `assets/mini-board.js`, `assets/moment-scan.js`, `assets/moment-selector.js`, `assets/analysis-notation.js`, `assets/reflection.js` |
| Training and progress | `assets/train.js`, `assets/progress.js` |
| Durable data and recovery | `assets/store.js`, `assets/archive.js`, `assets/data-controls.js`, `assets/storage-health.js` |
| Offline releases | `sw.js`, `assets/runtime-update.js`, `manifest.webmanifest` |

## Play search

The Rust engine uses iterative deepening, alpha-beta search with principal
variation search and aspiration windows, quiescence, a Zobrist-keyed
transposition table, and hash/killer/history move ordering. Evaluation tapers
between middlegame and endgame and includes mobility, pawn structure, passed
pawns, and king shelter.

Search accounts for game-history repetitions, search-path cycles, and dead
positions. The JavaScript rules layer validates moves independently before
committing them to the live game.

During the first 12 plies, Play varies the initial root ordering with a seed
derived from the saved game ID and exact position. The same position retains
its seed across retries, Undo, and reloads. Evaluation, strict improving-score
selection, and difficulty budgets remain unchanged; finite-budget search can
still follow a different path or complete a different depth. Later Play moves
and all coaching analysis use ordinary fixed ordering.

### Difficulty budgets

The shipped presets are defined in [level-presets.js](../assets/level-presets.js).
Ratings are provisional external-engine calibration targets, not certified
human or server ratings.

| Level | Rating target | Node cap | Time ceiling | Depth ceiling |
| --- | --- | ---: | ---: | ---: |
| Easy | 1500 | 10,000 | 5 s | 2 |
| Medium | 1700 | 10,000 | 5 s | 30 |
| Hard | 1900 | 36,000 | 5 s | 30 |
| Expert | 2100 | 230,000 | 5 s | 30 |
| Master | 2300+ | Uncapped | 8 s | 111 |

All levels use quiescence. A time ceiling can stop a fixed-node search early
on slower devices. A full transposition table can also stop an uncapped search;
the engine retains its deepest completed iteration.

Timed games reduce the effective search limit as the clock runs down. The
budget reserves delivery time and one identical-request retry after a reported
worker failure. A silent worker is detected only three seconds after its
search limit, which a nearly empty clock may not cover. An expired clock flags
before search starts, and a late move cannot change the finished position.

### Failure recovery and telemetry

Play retries a failed worker once against the unchanged request and position.
After a second failure, it stops visibly and offers a manual Retry action.
There is no alternate search engine or main-thread search fallback.

Each computer move retains the release, engine identity, effective search
configuration, opening seed when used, completed and attempted depth, counters,
score from White's point of view, and stop reason. PGN debug exports include
this evidence and the position before each move. Historical JavaScript-search provenance remains
readable for old records but is not executable.

## Coaching analysis

[analysis-core.js](../assets/analysis-core.js) defines shared immutable quick
and deep profiles. Review's quick pass screens every non-terminal played move;
selected moments, manual Verify, and Train's live check use the deep profile.

### Search and verification

Quick analysis uses a fixed-node scan, then scores every legal root move under
a full window at the scan's completed depth. A separate shallower phase supplies
stability evidence.

Deep analysis has two stages:

1. An uncapped-node scan runs for up to 16 seconds, with a depth ceiling of 111.
2. One phase of at most 16 million nodes verifies every legal move at depths
   1, 2, 3, and onward, up to the scan's depth or a minimum target of depth 3.

The reported depth is the deepest fully verified iteration, not the scan's
deeper depth. The previous iteration supplies stability evidence. If a deeper scan
prefers a move ranked strictly lower at the verified depth, the best move is
unstable: it cannot produce an automatic mistake mark or suggested moment.
Manual Verify can still show its lines for the player's judgment.

If even depth 1 cannot finish, the result is partial and retains at most the
scan's single best move. It never invents a continuation or claims all-move coverage.
Larger budgets do not guarantee a better move than Master; device speed and
the fixed transposition table still limit search. Node caps are work limits,
not wall-clock promises, and the service watchdog can stop slow requests.

### Visibility and ownership

Scores and alternatives stay hidden until a valid structured reflection is
submitted for that moment. Unlock receipts are durably bound to the exact
game revision, replayed position, played move, clocks, and submitted answer.
Scan caches and lesson cards alone cannot unlock results.

Quick-pass scores use `≈` and all displayed scores use White's point of view.
Only stable, deep-confirmed evidence can produce Chessy's `?!`, `?`, or `??`
annotations. Imported PGN annotations retain their own provenance.

One interactive analysis request runs at a time. Progress reports actual
scan/root-verification work and elapsed time without provisional scores or
invented completion estimates. Cancelled or superseded workers cannot update
the current view or persist stale results. An optional cache read has a
one-second deadline; a late result cannot replace a worker already selected
for the request.

## Storage and recovery

| Storage | Contents |
| --- | --- |
| `localStorage` | Live game and clock snapshot |
| IndexedDB | Archived games, lesson cards, structured reflection receipts, analysis cache, and resumable scans |
| Cache Storage | Complete offline app releases |

Saved and imported games are validated by replaying their moves and checking
the resulting position. Malformed archive rows remain available for recovery;
invalid recomputable analysis can be discarded. Archives use a per-game UUID,
so retrying the same write does not create another game.

Starting over after a move archives the displaced game as incomplete and
abandoned. A failed checkpoint keeps the live game until the player explicitly
chooses to proceed without saving. Clock snapshots persist on page hide/close,
so reloading does not refund thinking time.

Backup, restore, deletion, and ending retraction use transactional writes and
durable fences to prevent late work from resurrecting removed data. The
current product assumes one active tab; cross-tab coordination is tracked in
[#44](https://github.com/den-run-ai/chessy/issues/44).

## Offline releases

Every executable asset URL carries the same `rN` token as its app shell and
service worker. The worker precaches the complete release and serves versioned
assets from immutable, release-specific cache entries. Navigation prefers the
network and falls back to the cached shell. This prevents an update from
mixing one release's HTML with another release's scripts.

Long-open tabs check for updates when they become visible and before New game
or Rematch replaces the current save. When a new worker takes control, the app
reloads into that release and restores the game. A failed update check does
not block offline play. Cache cleanup stays within Chessy's verified release
caches because GitHub Pages projects share an origin.

See [development](DEVELOPMENT.md#before-submitting-a-change) for release checks
and the [agent guide](../CLAUDE.md) for the full persistence and async contracts.
