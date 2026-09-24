# Exploratory r80 level screen — results

**Exploratory development evidence. Not E4-v1 exploration or certification,
not a FIDE/Chess.com/Lichess rating, and not pooled with any E4 artifact.**
The plan, its two pre-Master addenda and every disclosure were committed before
the games they govern: see [`PLAN.md`](PLAN.md). The 1500/1700/1900/2100/2300+
labels remain provisional targets. After stage 1 the maintainer used this
screen to move the shipped budgets up one label and to add a depth-2 Easy.
That was a result-driven product decision, recorded in a PLAN.md addendum
before any new-Easy game; this screen certifies none of the levels.

## Setup

- Chessy: the draft r80 presets, driven exactly like the product worker
  request for an untimed game (draft Easy–Expert 10k/36k/230k/1.44M nodes,
  depth 30, 5 s ceiling; Master uncapped nodes, depth 111, 8 s), plus the
  shipped r80 Easy (10k nodes, depth 2, 5 s ceiling) for its confirmation
  block. Rust/WASM bytes are unchanged (`57166b29…5c5baec5f`).
- Anchor: pinned Stockfish 18 (`6b087694…b9f9`) with `UCI_LimitStrength`,
  `UCI_Elo` = anchor, Threads 1, Hash 64, MultiPV 1, Move Overhead 10,
  `go movetime 1000`, new game + Clear Hash before every game, no book.
- Openings: the exposed development list `test/ai-match-openings.js`; each
  opening once per color. Stage 1 = the 50 even-indexed lines against the
  target anchor; stage 2 (only when stage 1 scored above 0.80 or below 0.20) =
  the disjoint 50 odd-indexed lines at target ± 200. After the relabel, the
  r80 Easy preset played one more 100-game block against 1500 on the odd
  lines.
- Adjudication: rules terminals, draw at 180 total plies.
- Host: one Linux x86-64 container, 4 logical CPUs (Intel Xeon 2.8 GHz),
  Node.js 22.22.2, three games at a time. The exception is the r80 Easy block,
  which ran one game at a time beside the Master block, so up to four games
  shared the host during the overlap. Its `.runs` header records concurrency
  1 and a load average of 3.35.
- Estimate: logistic Elo from the score against the fixed anchor; 95%
  percentile interval from 10,000 opening-cluster bootstrap replicates
  (seed 20260924). Clusters are opening indices, some of which share a family,
  so the intervals are somewhat optimistic.

## Results

| Preset | Draft label | r80 label | Anchor | Openings | Games | W-D-L | Score (W / B) | Estimate | 95% interval | One-sided 95% lower |
| --- | --- | --- | ---: | --- | ---: | --- | --- | ---: | --- | ---: |
| 10k nodes, depth 2 | — | Easy | 1500 | odd | 100 | 58-10-32 | 0.630 (0.66 / 0.60) | 1592 | 1524–1664 | 1535 |
| 10k nodes | easy | Medium | 1500 | even | 100 | 69-11-20 | 0.745 (0.84 / 0.65) | 1686 | 1615–1763 | 1627 |
| 36k nodes | medium | Hard | 1700 | even | 100 | 71-13-16 | 0.775 (0.78 / 0.77) | 1915 | 1847–2001 | 1856 |
| 230k nodes | hard | Expert | 1900 | even | 100 | 71-13-16 | 0.775 (0.80 / 0.75) | 2115 | 2047–2195 | 2056 |
| 1440k nodes | expert | — (dropped) | 2100 | even | 100 | 79-12-9 | 0.850 (0.88 / 0.82) | 2401 | 2330–2492 | 2341 |
| 1440k nodes | expert | — (dropped) | 2300 | odd | 100 | 59-19-22 | 0.685 (0.73 / 0.64) | 2435 | 2381–2496 | 2389 |
| 8 s uncapped | master | Master | 2300 | even | 100 | 69-16-15 | 0.770 (0.82 / 0.72) | 2510 | 2451–2575 | 2464 |

Master scored 0.77, inside the 0.20–0.80 band, so no stage-2 Master block was
run. Every block completed its fixed 100 games. Container restarts interrupted
two blocks; each resume filled only the empty slots and added a `.runs` header
(Expert stage 2 resumed after 54 games; the first Master attempt recorded no
game before its restart).

## Chessy search on this host

| Preset | Anchor | Terminations | Chessy moves | Mean depth | Mean nodes | Mean / max ms | Retries | TT-saturated | Stop reasons |
| --- | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 10k nodes, depth 2 | 1500 | checkmate 90, ply-cap 10 | 4428 | 2.0 | 1,077 | 3 / 41 | 0 | 0 | max-depth 4264, mate 156, node-limit 8 |
| 10k nodes | 1500 | checkmate 89, ply-cap 11 | 4131 | 3.2 | 9,525 | 17 / 151 | 0 | n/r | not recorded |
| 36k nodes | 1700 | checkmate 87, ply-cap 13 | 4605 | 4.3 | 34,248 | 40 / 154 | 0 | n/r | not recorded |
| 230k nodes | 1900 | checkmate 87, threefold repetition 3, ply-cap 10 | 4513 | 5.6 | 215,834 | 222 / 761 | 0 | n/r | not recorded |
| 1440k nodes | 2100 | checkmate 88, ply-cap 9, threefold repetition 3 | 4340 | 6.9 | 1,332,444 | 1361 / 5001 | 0 | n/r | not recorded |
| 1440k nodes | 2300 | checkmate 81, ply-cap 18, insufficient material 1 | 5224 | 7.2 | 1,340,451 | 1275 / 2228 | 0 | n/r | not recorded |
| 8 s uncapped | 2300 | checkmate 84, ply-cap 16 | 4931 | 8.5 | 6,197,811 | 7358 / 8031 | 0 | 0 | time-limit 4510, mate 421 |

`n/r` / `not recorded`: the draft-preset runner predates the per-move
stop-reason instrumentation added before Master (PLAN.md); the r80 Easy block
used the instrumented runner. The Expert stage-1 maximum of
5001 ms shows that at least one Expert search reached its 5 s safety ceiling
while the host was heavily loaded.

## Reading the results

- **Every r79 budget played about one label above its target** on this scale:
  10k ≈ 1686, 36k ≈ 1915, 230k ≈ 2115 and 1.44M ≈ 2401–2435 nodes against
  targets of 1500/1700/1900/2100. The maintainer therefore moved the budgets
  up one label for r80 (PLAN.md addendum): Medium/Hard/Expert now use
  10k/36k/230k nodes, the 1.44M-node preset is dropped, and Easy is new.
- **r80 Easy** (the 10k cap limited to depth 2) measured about 1592
  (1524–1664) on the disjoint odd openings: clearly easier than Medium, but
  about 90 above its 1500 target. A depth-1 cap would be the next step down;
  it has not been measured and is not part of this PR.
- **Master** (8 s, uncapped nodes) measured about 2510 (2451–2575; one-sided
  95% lower bound 2464) against the 2300 anchor, averaging depth 8.5 with no
  transposition-table saturation and no retries. On this host its estimate is
  about 75–110 above the dropped 1.44M-node preset (2435 against 2300, 2401
  against 2100). The 95% intervals overlap, so the size of that gap is
  uncertain. Either way the 1.44M preset measured at Master strength, so
  dropping it leaves no gap in the ladder.
- **Only the node-capped levels transfer across devices.** Their results
  depend on node counts, not speed (apart from rare 5 s safety-ceiling stops).
  Master is wall-clock limited, and here it ran about 0.84M nodes per second
  per search under load, below an iPhone 12's roughly 1.5M. A faster device
  plays a stronger Master, and a slower one a weaker Master.
- **A 10k-node search very occasionally fails to finish depth 1** in extreme
  quiescence positions: one move in 4,131 at the old Easy/new Medium budget,
  and one in 4,428 for the new Easy. It then plays the best root move it
  finished scoring in the unfinished depth-1 pass (in both cases a move other
  than its first ordered root). This is not new in r80. The frozen-family contract test still passes.
- **What this is not.** These are one host's descriptive numbers against
  Stockfish's own UCI_Elo scale at one second per move, on a development
  opening list. They are not FIDE, Chess.com or Lichess ratings, not E4-v1
  evidence, and they certify no level. The adaptive stage-2 anchors and the
  post-result relabel are exactly what a certification protocol forbids, so
  certification (#87/#113) still needs a fresh preregistered protocol,
  holdout and supported devices.

## Files

- `stage{1,2}-<level>-<anchor>.ndjson` — one record per game of the draft
  presets (level names are the draft labels), and `relabel-easy-1500.ndjson`
  for the r80 Easy confirmation block. Each record carries the exact preset it
  played, its moves in UCI, result, termination and Chessy search statistics.
- `*.ndjson.runs` — one header per block start or resume, with the runner,
  preset, WASM, Stockfish and (for Master and the r80 Easy block) loader and
  rules hashes, commit and host load.
- Summaries: `node test/eval/level-screen.js --summarize <file.ndjson>`.
  The summary refuses a file that mixes levels, anchors or presets, repeats a
  schedule slot, or whose `.runs` headers disagree on any input hash. Every
  committed block passes that check. That includes both resumed blocks, whose
  start and resume headers carry identical runner, preset, WASM and Stockfish
  hashes.
- The runner and the presets file were changed after these games, so their
  current hashes differ from the hashes those headers record. The presets
  change is a comment correction; the preset values each record carries are
  unchanged. Runner changes:
  - Each run executes a private, read-only snapshot of the runner, rules,
    loader, WASM, presets, opening list and Stockfish. Its header records the
    hashes of that snapshot, including the opening list.
  - A resume must match the block's recorded inputs, preset and schedule.
  - An exclusive `<out>.lock` stops two runs from writing the same output.
  - A game is not recorded if the snapshot changes.
  None of this changes how a game is played or scored.
