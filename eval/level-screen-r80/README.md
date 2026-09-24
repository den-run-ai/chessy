# Exploratory r80 level screen — results

**Exploratory development evidence. Not E4-v1 exploration or certification,
not a FIDE/Chess.com/Lichess rating, and not pooled with any E4 artifact.**
The plan, its two pre-Master addenda and every disclosure were committed before
the games they govern: see [`PLAN.md`](PLAN.md). The 1500/1700/1900/2100/2300+
labels remain provisional targets, and no shipped budget was retuned from this
screen.

## Setup

- Chessy: the r80 candidate presets, driven exactly like the product worker
  request for an untimed game (Easy–Expert 10k/36k/230k/1.44M nodes, depth 30,
  5 s ceiling; Master uncapped nodes, depth 111, 8 s). Rust/WASM bytes are
  unchanged (`57166b29…5c5baec5f`).
- Anchor: pinned Stockfish 18 (`6b087694…b9f9`) with `UCI_LimitStrength`,
  `UCI_Elo` = anchor, Threads 1, Hash 64, MultiPV 1, Move Overhead 10,
  `go movetime 1000`, new game + Clear Hash before every game, no book.
- Openings: the exposed development list `test/ai-match-openings.js`; each
  opening once per color. Stage 1 = the 50 even-indexed lines against the
  target anchor; stage 2 (only when stage 1 scored above 0.80 or below 0.20) =
  the disjoint 50 odd-indexed lines at target ± 200.
- Adjudication: rules terminals, draw at 180 total plies.
- Host: one Linux x86-64 container, 4 logical CPUs (Intel Xeon 2.8 GHz),
  Node.js 22.22.2, three games at a time.
- Estimate: logistic Elo from the score against the fixed anchor; 95%
  percentile interval from 10,000 opening-cluster bootstrap replicates
  (seed 20260924). Clusters are opening indices, some of which share a family,
  so the intervals are somewhat optimistic.

## Results

| Level | Anchor | Games | W-D-L | Score (W / B) | Estimate | 95% interval | One-sided 95% lower |
| --- | ---: | ---: | --- | --- | ---: | --- | ---: |
| easy | 1500 | 100 | 69-11-20 | 0.745 (0.84 / 0.65) | 1686 | 1615–1763 | 1627 |
| medium | 1700 | 100 | 71-13-16 | 0.775 (0.78 / 0.77) | 1915 | 1847–2001 | 1856 |
| hard | 1900 | 100 | 71-13-16 | 0.775 (0.80 / 0.75) | 2115 | 2047–2195 | 2056 |
| expert | 2100 | 100 | 79-12-9 | 0.850 (0.88 / 0.82) | 2401 | 2330–2492 | 2341 |
| expert | 2300 | 100 | 59-19-22 | 0.685 (0.73 / 0.64) | 2435 | 2381–2496 | 2389 |

**Master: stage 1 (100 games against 2300) is running; its rows and the reading below will be completed before this PR leaves draft.**

## Chessy search on this host

| Level | Terminations | Chessy moves | Mean depth | Mean nodes | Mean / max ms | Retries | TT-saturated | Stop reasons |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| easy | checkmate 89, ply-cap 11 | 4131 | 3.2 | 9,525 | 17 / 151 | 0 | n/r | not recorded |
| medium | checkmate 87, ply-cap 13 | 4605 | 4.3 | 34,248 | 40 / 154 | 0 | n/r | not recorded |
| hard | checkmate 87, threefold repetition 3, ply-cap 10 | 4513 | 5.6 | 215,834 | 222 / 761 | 0 | n/r | not recorded |
| expert | checkmate 88, ply-cap 9, threefold repetition 3 | 4340 | 6.9 | 1,332,444 | 1361 / 5001 | 0 | n/r | not recorded |
| expert | checkmate 81, ply-cap 18, insufficient material 1 | 5224 | 7.2 | 1,340,451 | 1275 / 2228 | 0 | n/r | not recorded |

`n/r` / `not recorded`: the Easy–Expert runner predates the per-move stop-reason
instrumentation added before Master (PLAN.md). The Expert stage-1 maximum of
5001 ms shows that at least one Expert search reached its 5 s safety ceiling
while the host was heavily loaded.

## Reading the results

Pending the Master block.

## Files

- `stage{1,2}-<level>-<anchor>.ndjson` — one record per game (moves in UCI,
  result, termination, Chessy per-game search statistics).
- `*.ndjson.runs` — one header per block start or resume, with the runner,
  preset, WASM, Stockfish and (for Master) loader/rules hashes, commit and
  host load.
- Summaries: `node test/eval/level-screen.js --summarize <file.ndjson>`.
