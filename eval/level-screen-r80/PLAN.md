# Exploratory r80 level screen — preregistered plan

Status: **exploratory development evidence, not E4-v1 exploration or
certification.** Written and committed before any screen game was played.

## Why this is not E4

E4-v1 (#87/#113) admits games only after its exploration and certification
opening manifests are frozen from the preregistered Lichess archive, and its
certification additionally requires the declared minimum physical device and
the #84 baseline. None of those prerequisites exists here. This screen reuses
E4-v1's anchor settings and draw adjudication so its numbers are comparable in
kind, but it cannot certify a rating, cannot satisfy any E4 gate, and must never
be pooled with E4 artifacts. The 1500/1700/1900/2100/2300+ labels remain
provisional targets.

## Fixed contract

- Candidate: this branch's proposed r80 presets in `assets/level-presets.js`,
  unchanged Rust/WASM (`assets/chessy-ai-fast.wasm`). Untimed product request per
  move: `engine.search(fen, { maxDepth, timeMs, nodeLimit, quiesce,
  positions })`. Easy–Expert: 10k/36k/230k/1.44M nodes, depth 30, 5 s ceiling.
  Master: uncapped nodes, depth 111, 8 s.
- Anchor: pinned Stockfish 18 (`sf_18`, archive SHA-256
  `536c0c2c…17964`, executable SHA-256 `6b087694…b9f9`), `UCI_LimitStrength`
  true, `UCI_Elo` = anchor, Threads 1, Hash 64, Ponder false, MultiPV 1,
  SyzygyPath empty, Move Overhead 10, `go movetime 1000`; `ucinewgame`, Clear
  Hash and `isready` before every game. No book.
- Openings: the long-used development list `test/ai-match-openings.js`
  (100 lines, manifest hash enforced by that module). It is not an E4, v2
  formal-admission, or holdout split. Stage 1 uses the 50 even-indexed lines;
  stage 2 uses the disjoint 50 odd-indexed lines. Every opening is played once
  with each color.
- Adjudication: normal rules terminals via `assets/engine.js`; draw at 180
  total plies; no resignation, evaluation draw or tablebase. A failed Chessy
  search gets one identical retry (the product's fresh-worker retry); a second
  failure, an illegal move or a search slower than the product watchdog
  (`timeMs + 3000 ms`) loses for Chessy. An illegal, missing or late
  (15 s) Stockfish move loses for Stockfish.
- Runner: `test/eval/level-screen.js` (hash recorded in every `.runs` line).
  Four logical CPUs, Node.js 22, Linux x86-64 container. Concurrency 3 games.

## Schedule (fixed counts, no optional stopping)

Stage 1 — every level against the anchor equal to its provisional target,
even openings, 100 games each:

| Level | Anchor |
| --- | ---: |
| Easy | 1500 |
| Medium | 1700 |
| Hard | 1900 |
| Expert | 2100 |
| Master | 2300 |

Stage 2 — only for a level whose stage-1 score is below 0.20 or above 0.80
(where the logistic estimate is poorly conditioned): one more 100-game block on
the odd openings against target − 200 (score < 0.20) or target + 200
(score > 0.80), clamped to Stockfish's 1320–3190 range.

No game is rerun or replaced. An interrupted run may only fill schedule slots
that have no record yet.

## Reporting

Per block: W-D-L, score, per-color score, logistic Elo estimate relative to the
fixed anchor, 95% opening-cluster bootstrap interval (10,000 replicates, seed
20260924), termination reasons including every product failure, and Chessy
per-move depth/nodes/time. Master is wall-clock limited, so its result is
specific to this container's speed and load; per-move nodes are reported.

## Use of the results

Descriptive only. This PR does not retune any shipped budget from this screen
(E4-v1 exploration is likewise `mayChangeShippedBudgets: false`). A level found
off-target is reported as such; any future budget change needs its own
preregistered protocol and fresh disjoint evidence.

## Addendum before any Master game (candidate correction)

While Easy was running, review found that the draft candidate's uncapped
eight-second Master search can fill the engine's fixed 1M-entry
transposition table. The loader then threw, and the product's identical retry
failed the same way (a deterministic node count), so the draft could not move
in such positions. Commit `6a99dad` keeps the completed iteration instead. That
is a candidate defect fix, not a result-driven change: no Master game had been
played. Master therefore runs from a snapshot of `6a99dad`. Easy–Expert keep
their original snapshot (`246f6bf`): their node caps (at most 1.44M) cannot
fill the table, and their search requests and presets are unchanged. The
screen's rules, openings, anchors, counts and adjudication are unchanged.
