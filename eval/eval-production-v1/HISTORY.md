# Earlier strength-versus-time evidence

The repository already contains relevant experiments. **None establishes a
general time threshold at which a richer evaluator becomes better.** The new
pipeline compares the complete engine at equal requested time over a fixed
grid, retains measured elapsed time, and treats any apparent crossing as a
development hypothesis requiring fresh confirmation.

This review checked the repository reports and their machine-readable
summaries, including the separate PR #187 branch. It ran no historical
searches, opened no locked evaluation bank, and did not pool old games with
the new campaign.

## Natural-game compact-evaluator pilot, September 14

This is the earlier result with a large apparent change between 50 and
200 milliseconds. It used a retuned HCE with six pawn-attack terms, distinct
from the sparse 17,280-coefficient model.

| Requested time per move | Candidate wins / draws / losses | Candidate score | Reported opening-pair bootstrap 95% interval | Games / opening pairs |
| --- | ---: | ---: | ---: | ---: |
| 50 ms | 12 / 10 / 18 | 42.50% | 28.75–56.25% | 40 / 20 |
| 200 ms | 15 / 17 / 8 | 58.75% | 48.75–68.75% | 40 / 20 |

The same 20 historically exposed openings were used at both budgets, with
both colors. Mean measured search times were 49.196 versus 49.181 ms at the
50 ms setting and 194.686 versus 195.116 ms at 200 ms, candidate versus HCE.
Seven and ten draws respectively reached the searched-ply cap. Four games
ran concurrently; this was a local development comparison, not a phone or
browser measurement.

Both intervals include parity. Their point estimates suggest a possible
change with time but do not identify a reliable crossing or prove that more
time favors that evaluator. The original decision retained HCE and made no
Elo conversion. These old per-budget intervals also are not the simultaneous
grid intervals implemented by the new analyzer.

Sources: [original report](../NATURAL-PILOT-2026-09.md),
[full report](../natural-pilot/REPORT.md), and
[machine-readable paired scores and audit](../natural-pilot/natural-runtime-match-2026-09.json).

## Pure NNUE prototype, PR #187, September 15

This separate study trained pure 768→H networks on about 20 million quiet
positions. It tested a larger 292-opening development bank and explicitly
measured both fixed-node and equal-time play. The snapshot reviewed here is
commit `5bb2667891f932fc785e3fe135a28457382dcbe5`; its files are not presumed
to be on the current default branch.

| Evaluator | Requested time per move | Candidate wins / draws / losses | Candidate score | Reported opening-clustered 95% interval | Games / opening pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| H64 | 50 ms | 268 / 67 / 249 | 51.63% | 47.73–55.53% | 584 / 292 |
| H128 | 50 ms | 263 / 72 / 249 | 51.20% | 47.31–55.09% | 584 / 292 |
| H128 | 200 ms | 251 / 80 / 253 | 49.83% | 46.15–53.51% | 584 / 292 |

H128 scored 58.65% at 10,000 nodes and 55.99% at 230,000 nodes, while its
equal-time intervals included parity. At 200 ms its recorded mean completed
depth was 5.50 versus HCE's 5.86; mean actual search times were 190.78 and
189.94 ms. These observations show why inference cost and full search must be
evaluated together. They do not prove that throughput alone caused the score
difference, nor a monotone relation between time and evaluator advantage.
The five-second Master comparison was unmeasured in that study.

Sources: [PR #187](https://github.com/den-run-ai/chessy/pull/187),
[pinned report](https://github.com/den-run-ai/chessy/blob/5bb2667891f932fc785e3fe135a28457382dcbe5/eval/nnue-proto-2026-09/REPORT.md), and
[pinned machine-readable results](https://github.com/den-run-ai/chessy/blob/5bb2667891f932fc785e3fe135a28457382dcbe5/eval/nnue-proto-2026-09/results.json).

## Earlier HCE level and time calibration, r80

The r80 screen measured the same HCE at increasing search budgets against
Stockfish 18 configured with its own `UCI_Elo` strength limit and one second
per move. These estimates informed the product's provisional level labels.

| HCE budget | Observed mean search time on that host | Descriptive anchor-relative estimate | Reported 95% interval |
| --- | ---: | ---: | ---: |
| 10,000 nodes | 17 ms | 1,686 | 1,615–1,763 |
| 36,000 nodes | 40 ms | 1,915 | 1,847–2,001 |
| 230,000 nodes | 222 ms | 2,115 | 2,047–2,195 |
| 1.44 million nodes, anchor 2,100 | 1,361 ms | 2,401 | 2,330–2,492 |
| 1.44 million nodes, anchor 2,300 | 1,275 ms | 2,435 | 2,381–2,496 |
| 8-second Master | 7,358 ms | 2,510 | 2,451–2,575 |

These are useful evidence that additional search work can improve this HCE.
They are not an equal-time HCE-versus-new-evaluator comparison: anchors,
opening subsets, budgets, and concurrent load vary. The numbers are neither
human/server ratings nor a universal conversion from milliseconds to Elo.
The new frontier must not fit one curve through these rows and different
models or hardware.

Source: [r80 level-screen setup, results, and limitations](../level-screen-r80/README.md).

## Sparse PeSTO v2, November 27

The current sparse evaluator's 25 ms development arm scored 44.14%
(36.70–51.58%); the 10,000-node arm scored 54.69% (47.57–61.80%). Each arm
used 64 opening pairs. This study supplied only one equal-time point. The
fixed-node arm runs at a different amount of work from the roughly
23,000–24,000 nodes observed in the timed arm, so these two observations do
not define a time crossover.

Sources: [v2 report](../sparse-pesto-v2/REPORT.md),
[complete game results](../sparse-pesto-v2/GAME-RESULTS.json), and
[registered game protocol](../sparse-pesto-v2/GAME-PROTOCOL.md).

## What the new pipeline can establish

The development configuration binds one exact base/candidate/build pair,
one runtime, the complete opening schedule, and the fixed time grid before
games. Each color pair is one opening observation. Resampling retains both
colors and uses the same opening/family cluster draw across the entire time
grid. Bonferroni percentile bands account for the declared number of time
comparisons; they remain approximate descriptive bootstrap intervals,
especially with few or related opening clusters.

An optional relative Elo figure is only the monotone transform
`400 * log10(score / (1 - score))`, with the score interval transformed too.
It has no human rating offset. Zero and one endpoints are unbounded and are
not silently clipped into finite ratings. A degenerate bootstrap receives
the uninformative interval `[0, 1]`, not a false zero-width certainty claim.

The analyzer reports measured grid points and any opposing-sign interval
brackets. It does not infer the crossing between points, extrapolate to
unmeasured times, assume monotonicity, or activate a production evaluator.
A promising region needs a frozen model/budget and a fresh confirmation
campaign plus the existing correctness, runtime, and release evidence.
Inconclusive intervals mean **no crossing established**, even when point
estimates lie on different sides of 50%.

The implementation is [frontier.py](../../tools/eval_pipeline/frontier.py);
its tests use artificial outcomes, never historical or locked game results.
