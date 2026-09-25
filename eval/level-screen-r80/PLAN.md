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
played. Master therefore runs from a later snapshot that contains it (see the
next addendum). Easy–Expert keep
their original snapshot (`246f6bf`): their node caps (at most 1.44M) cannot
fill the table, and their search requests and presets are unchanged. The
screen's rules, openings, anchors, counts and adjudication are unchanged.

## Addendum before any Master game (instrumentation and disclosures)

The Master block runs from the commit that adds this addendum. Its runner
differs from the Easy–Expert runner only in recorded fields: the run header
adds the git commit, a dirty-tree flag, OS and load average, and hashes of
`assets/wasm-engine.js` and `assets/engine.js`; each game adds per-move
Chessy stop reasons and a count of TT-saturated searches. Game play,
adjudication, openings, anchors, counts and statistics are unchanged.

Disclosures fixed before any Master game:

- The 180-ply draw counts total game plies, including the 4–10 opening plies.
  Repository match runners count plies after the opening; E4-v1 does not say.
- A stage-2 anchor at target ± 200 is outside E4-v1's nearest-anchor rule and
  is chosen from the stage-1 score; that is allowed only because this screen is
  not E4, and it is reported as adaptive.
- The runner retries a thrown search once, as the product does; a search slower
  than the watchdog or an illegal move loses immediately, whereas the product
  would retry those once too. No such event is expected for node-capped levels.
- Opening indices are the bootstrap clusters, but several development lines
  share a family, so the intervals are somewhat optimistic.
- The logistic estimate with percentile bootstrap intervals is the only
  registered estimator. No Davidson/E4 fit is computed for this screen.
- A crashed game worker aborts a block; resuming only fills empty slots. Every
  resume is visible as another `.runs` header line.

## Addendum after stage 1: maintainer relabel and new Easy (before any new-Easy game)

Stage 1 placed every node budget roughly one label above its target on this
scale (10k ≈ 1686, 36k ≈ 1915, 230k ≈ 2115, 1.44M ≈ 2401–2435). The maintainer
therefore decided to shift the budgets up one label, drop the 1.44M-node preset
(already Master strength; Master keeps its eight-second uncapped search) and
add an easier Easy. Stable IDs are kept: `1` Easy (new), `2` Medium = 10k,
`3` Hard = 36k, `5` Expert = 230k, `master` unchanged. This is a result-driven
product decision informed by exploratory evidence, not an E4 result; any
certification still needs a fresh preregistered protocol and holdout.

New Easy budget, fixed before any game: 3,500 nodes (depth 30, 5 s ceiling,
quiescence), from log-linear interpolation between the measured 10k and 36k
blocks (about 124 Elo per doubling) toward 1500. Confirmation block, fixed
before any game: 100 games against the 1500 anchor on the 50 odd-indexed
openings (disjoint from the stage-1 even openings), same anchor settings and
adjudication, one game at a time beside the running Master block. No further
budget search follows in this PR; the result is reported as measured.

### Amendment before any new-Easy game: depth cap instead of 3,500 nodes

The product contract requires every level to complete at least depth 1 on the
frozen position families. Depth 1 in the tactical Kiwipete family costs about
9,050 nodes, so any pure node budget below roughly 9.1k — including the 3,500
proposed above — would sometimes play an unsearched root move. The new Easy is
therefore Medium's 10k-node work cap with `maxDepth: 2` (quiescence on, 5 s
ceiling): depth 1 always completes, and play stays deterministic. Across the
stage-1 blocks, each ply of average completed depth was worth roughly 200 Elo
on this scale (10k nodes averaged depth 3.2 ≈ 1686), which puts a depth-2 cap
near 1450–1500. The confirmation block is unchanged: 100 games against the 1500
anchor on the odd openings, one game at a time beside the Master block, and no
further budget search in this PR.

## Note after the screen (2026-09-24)

This note corrects two statements above without changing them.

- "Use of the results" said this PR would not retune any shipped budget from
  this screen. The maintainer relabel addendum superseded that: the shipped
  budgets did move from this screen. Medium, Hard and Expert rest on the
  stage-1 blocks, not on fresh disjoint evidence. Only the new Easy has a
  disjoint (odd-opening) confirmation block.
- The depth-cap amendment said depth 1 "always completes". It does not quite:
  in rare extreme quiescence positions a 10k-node search stops before
  finishing depth 1. That happened once in 4,131 moves at the 10k draft budget
  and once in 4,428 for the new Easy. The engine then plays the best root move
  it finished scoring, or its first ordered root if none finished. The
  frozen-family depth-1 contract still passes.
