# Fitting each feature family separately

This exploratory refit reduced the objective it trained on and lost ground on move choice. On 78 held-out source games it achieved the lowest mixed cross-entropy, 0.6893. Its mean teacher regret was 191.47 cp, 22.97 cp worse than the full model. The paired source-game bootstrap interval for that difference was +6.08 to +43.94 cp. The test set had already been used for the primary scalar analysis, so these are development results.

| Evaluator | Mixed cross-entropy ↓ | Mean move regret ↓ | Top-move agreement ↑ | Quiet validation MAE ↓ |
| --- | ---: | ---: | ---: | ---: |
| Chessy HCE | 0.7194 | 208.32 cp | 46.79% | 134.78 cp |
| Full model | 0.6966 | 168.49 cp | 48.72% | 124.89 cp |
| No-pawn refit | 0.7004 | 178.06 cp | 48.72% | 125.30 cp |
| Scalar 12/16 | 0.7027 | 184.53 cp | 49.36% | 124.88 cp |
| Family/phase refit | 0.6893 | 191.47 cp | 46.79% | 129.42 cp |

Mixed cross-entropy weights pairwise targets at 75% and absolute-score targets at 25%. Move regret measures the difference between the best available teacher score and the score of the chosen sibling. Both average within a source game before pooling games. The final column uses the separate, previously exposed 100,164-row quiet validation set.

## Fit and export

The single recipe uses 210 fitting games, with the same historical exclusions and game partitions as the scalar experiment. One multiplier rescales each phase of each retained feature family within the no-pawn model. A quadratic penalty shrinks the scales toward zero and a second quadratic penalty shrinks the differences between their values. The protocol froze the objective, penalties and [0,1] bounds before this secondary fit. Prior held-out results motivated the experiment.

| Original no-pawn weights | Midgame scale | Endgame scale |
| --- | ---: | ---: |
| Piece-square | 0.668 | 0.000 |
| Own king × piece-square | 0.374 | 0.318 |
| Enemy king × piece-square | 0.407 | 0.238 |
| Nearest-ray interactions | 1.000 | 0.000 |

The optimizer converged in 11 iterations. Export applies the scales to the existing weights offline and rounds each coefficient. The exported table has 1,854 nonzero integer weights. Every fused int8 lookup fits its existing range, and all 1,812 eligible child scores matched the independent native evaluator. The throughput of this model has not been measured. The frozen game candidate remains the scalar selection.

The compressed sibling collection and its original shallow Chatarunga labels are fixed inputs. Regenerating teacher labels can change some close decisions. The mean regret difference between the family fit and HCE was −16.85 cp, with a paired interval of −73.12 to +23.92 cp. These decisions supply no equal-time game-score estimate.

Run from the repository root with the restored PR #202 refit directory as the first argument.

```sh
OPENBLAS_NUM_THREADS=1 python tools/eval_robustness/family_fit.py \
  "$REFIT" /tmp/family-model.i16le /tmp/family-results.json
```
