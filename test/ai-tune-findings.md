# Evaluation-weight tuning — experiment log

**Decision: no evaluation-weight change ships.** The evaluation constants in
`assets/ai.js` are already at (or indistinguishably close to) a local optimum of
the Texel loss on a large, diverse, outcome-labelled self-play position set. The
only candidate that moves the weights substantially overfits and *fails the
tactics gate*. Runtime is unchanged — zero lines — which was the point: the plan
identified evaluation tuning as the most plausible remaining strength gain, and
the disciplined experiment shows that gain is not there to be had.

Reproduce with `test/ai-tune.js` (development only; not in PR CI).

## Setup

- **Terms tuned** (the ones the plan named, all shipped constants): knight /
  bishop / rook / queen mobility, the doubled and isolated pawn penalties, the
  pawn shield, and the passed-pawn midgame/endgame arrays — 19 parameters.
- **Data**: 600 self-play games (random 6-ply openings for spread, then an
  engine playout at 700 nodes/move), 1-of-4 quiet-position sampling →
  **13,763 positions, 77.8 % decisive**, each labelled by its game's outcome
  from White's point of view. 11,010 train / 2,753 held-out validation.
- **Fit**: the sigmoid scale `K` is fitted on the baseline weights (K ≈ 0.51),
  then held fixed; the weights are fitted by RMSProp gradient descent plus an
  integer polish, L2-**regularised toward the shipped values**.
- **Fidelity**: the tuner's feature reconstruction equals `ai.js`'s own
  `evaluate()` at the shipped weights on every checked position, so the fit
  optimises the exact function the engine plays.

## Regularisation sweep (held-out validation loss)

| λ        | weights moved                    | train Δloss | val Δloss | reading |
|----------|----------------------------------|-------------|-----------|---------|
| ≥ 0.1    | none                             | 0.000 %     | 0.000 %   | baseline is the integer optimum |
| 0.05     | `passedEg[4]` 80→81 (one +1)     | 0.002 %     | 0.002 %   | noise |
| 0 (none) | all 19, several to their bounds  | 0.325 %     | 0.693 %   | overfit, chess-nonsensical |

Under any regularisation that keeps the weights sane, the fit does not move a
single constant. Only removing regularisation entirely lets them move — and then
they overfit 13.7 k noisy labels into values no chess engine would use: a
**zero doubled-pawn penalty**, an inflated shield, and non-monotonic passed-pawn
arrays (`PASSED_MG [0,0,59,57,29,80]`).

## The λ = 0 candidate fails validation

The only substantively-moved candidate:

```
MOBILITY { N: 5, B: 5, R: 4, Q: 2 }
DOUBLED 0, ISOLATED 16, SHIELD 23
PASSED_MG [0, 0, 0, 59, 57, 29, 80]
PASSED_EG [0, 81, 69, 87, 167, 191, 180]
```

- **Tactics suite**: FAILS — 61/63 (regresses from 63/0). It can no longer
  convert **K+Q vs K** or **K+R vs K** within the mate-in-N budget: the distorted
  passed-pawn / shield / mobility weights corrupt the endgame evaluation.
- **Self-play match** vs the shipped weights (candidate = working tree, base =
  HEAD; 2000 nodes/move, both colours): the candidate trailed throughout and
  scored **8.5 / 20 = 42.5 %** (W5 / D7 / L8) before the run was stopped —
  comfortably on the losing side of the 50 % gate, so the match was not run to
  its full length.

A tactics regression disqualifies a candidate before the match even matters; the
match merely confirms the direction — the lower-Texel-loss weights play *worse*.

## Conclusion

Lower Texel loss here is either unattainable (with regularisation) or spurious
(without it). The shipped evaluation weights stand unchanged. This is exactly the
result the disciplined protocol is built to surface — it stops noise and
overfitting from shipping as if they were strength. Anything materially stronger
than the current opponent belongs in a separate optional analysis engine, not in
more evaluation terms or weight churn inside Chessy.
