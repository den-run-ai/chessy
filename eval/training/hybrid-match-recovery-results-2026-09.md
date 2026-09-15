# Hybrid recovery match: complete development evidence

The separately registered infrastructure recovery completed all 400 games and
passed the built-in audit of every game from its retained canonical archive.
All 400 live game files also matched their capture receipts. Independent
Python-chess verification passed all 400 games, 48,851 searched moves and
401 archive members with zero mismatches.

| Evaluator versus shipped HCE | Games | Wins–draws–losses | Score | Descriptive opening-cluster 95% lower bound |
|---|---:|---:|---:|---:|
| Frozen `smooth-6-12` hybrid | 200 | 57–52–91 | 41.5% | 36.56% |
| Frozen expanded HCE | 200 | 73–50–77 | 49.0% | 43.82% |

Each arm used the same 100 exposed opening pairs, both colors, 20 ms requested
per move, one serial game at a time, and the original 180 searched-ply cap.
These are separate comparisons with shipped HCE; the two candidates did not
play each other. The short development test supplies no formal admission or
Elo estimate. The hybrid underperformed in this batch; expanded HCE did not
demonstrate a gain.

The hybrid's observed mean move time was 20.642 ms versus 20.500 ms for its
opponent; expanded HCE averaged 20.461 ms versus 20.413 ms. All overruns were
retained. Complete per-move requests, observed timings, depth, node counts,
history maps, legal moves and terminal outcomes remain in the archive. Game
NPS and mean depth concern different encountered positions, so the separately
paired static benchmark remains the evidence for causal runtime cost.

Capture retained exact emitted bytes in parent memory and atomically published
each completed game. The child waited for capture acknowledgement before
starting another timed game. Only after all timed searches stopped were the
retained bytes compressed and atomically archived; audit read the archive,
without reconstructing any data from live files. The archive has 401 members
(warmup plus 400 games), occupies 7,215,297 bytes and has SHA-256
`2fc4934b52fe60641c91dc77bb6ad2be6ae716ca8a3fb5c81322da7828cff834`.

The first 400-game batch remains invalid, and its damaged evidence was not
repaired or scored. The cached/fused 200-game follow-up remains skipped under
its frozen speed trigger. The separate lazy implementation trigger was frozen
before these recovery outcomes and must not change because of them. Paid
compute for this recovery: **$0**.

That [lazy follow-up was subsequently skipped](hybrid-match-lazy-results-2026-09.md):
its independently measured 3.696% speed improvement did not reach the frozen
5% trigger, so no further games were executed.

Independent audit receipt: `hybrid-match-recovery-independent-audit.json`,
SHA-256 `d518321ffcc74ae15c281c2d0cce646effedb37069e04cd691641b1e37770f45`.
The [original invalid batch](hybrid-match-results-2026-09.md) is preserved as a
separate incident and contributes no scores.
