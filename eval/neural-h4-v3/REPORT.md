# Phase, capacity and schedule screen — 2026-09-15

**The bounded v3 screen is complete. Keep the shipped evaluator; the NNUE test remains sealed.**

The run completed **18 development fits + 1 frozen refit**, with **805.575 seconds** of reported fitting time and **$0 paid compute**. It reused the authenticated natural-game data; no new labels were generated.

## Registered execution

- Execution: [`228c07c00351`](https://github.com/den-run-ai/chessy/commit/228c07c003512215486adadf8a5871dab5b1ec9b).
- [Exact v3 preregistration](../training/natural-nnue-h4-v3.json): six fixed configurations × three seeds, followed by one selected refit.
- Shared training: 33,103 rows; reused family split: 26,489 inner training / 6,614 inner validation.
- Inner eligibility used shipped-HCE phase guards; expanded HCE is reported diagnostically because it trained on these inner rows.
- Outer and test quality guards retain both frozen HCE comparators. Outer validation is previously exposed exploratory evidence.
- Recorded wall time including admission/feature extraction/parity: 903.583 seconds. All fits used one local CPU thread.

## Development capacity and schedule ablations

Values are the median of three seeds’ best eligible, quantized inner-validation checkpoints. Lower CE is better.

| Configuration | Median inner CE | Best epochs by seed 10511/12/13 | Parameter bytes |
| --- | ---: | --- | ---: |
| h4-single-e300 | 0.401311 | 300, 290, 240 | 6,180 |
| h4-phase-e300 | 0.400779 | 300, 300, 240 | 6,200 |
| h4-phase-e900 | 0.400833 | 880, 890, 750 | 6,200 |
| h4-phase-e900-eg2 | 0.401483 | 880, 890, 710 | 6,200 |
| h8-phase-e900-eg2 | 0.400615 | 880, 890, 900 | 12,392 |
| h8-phase-e1800-eg2 | 0.400054 | 1730, 1700, 1780 | 12,392 |

| Comparison | Relative median CE improvement |
| --- | ---: |
| phase-heads-and-head-regularization | +0.132% |
| h4-training-budget | -0.013% |
| endgame-weight | -0.162% |
| capacity | +0.216% |
| h8-training-budget | +0.140% |

These are finite-grid comparisons, not proof of convergence or general performance saturation. The longer schedules change learning-rate duration and the QAT start. The two phase heads also double the output penalty for identical duplicated heads at the same sum-L2 coefficient; the phase comparison therefore includes a regularization change. Seed ranges and all per-seed selected epochs appear in the [aggregate JSON](results-2026-09.json).

## Frozen refit and outer validation

Selected **h8-phase-e1800-eg2**, median seed **10513**, then refit once for **1730 epochs** on full shared training. The recipe, seed, epoch count and model digest were frozen before outer decoding; there was no outer reselection.

| Evaluator | Outer CE | CP MAE | CP RMSE | Endgame CE |
| --- | ---: | ---: | ---: | ---: |
| shipped-hce | 0.406480 | 130.67 | 179.92 | 0.280213 |
| frozen-expanded-hce | 0.403504 | 129.05 | 178.28 | 0.271050 |
| Selected v3 residual | 0.398820 | 126.85 | 175.83 | 0.274721 |

Aggregate outer CE improves 1.884% versus shipped HCE and 1.161% versus frozen expanded HCE. This does not establish an Elo or equal-time search improvement.

Endgame CE is **1.354% worse than expanded HCE** on 332 rows, exceeding the unchanged 1% allowance. This observed guard failure is not proof of an endgame playing-strength regression.

The outer loss is only approximately 0.034% below the [previous H4 v2 result](../neural-h4-v2/REPORT.md) (published CE 0.398956), with approximately twice the parameter storage. This comparison is exploratory and cannot justify the extra runtime cost by itself.

**Recorded advancement result:** frozen-expanded-hce:endgame-CE-guard.

## Quantization and independent verification

- Run-side Python/JavaScript integer parity: **0 mismatches across 631,464 comparisons**.
- Across every consumed checkpoint/role: maximum float/integer difference **0.596 cp**; largest role-mean difference **0.332 cp**.
- Independent audit: **PASS**, 631,464 independently decoded outputs; selected metrics, quantization, phase guards, decisions and ablations reproduce.
- Every retained learning-curve epoch, QAT flag, cosine rate, update count and selected checkpoint was checked. Unretained weights and optimizer trajectories were not independently regenerated.
- Separate post-run filesystem inspection found zero dataset-global or legacy test-opening markers. The independent audit read or hashed zero NNUE-test files.
- Parameter bytes exclude evaluator code and retained HCE computation; they are not a measured production WASM increase. Production runtime and WASM were unchanged.

## Next decision

A matched comparison should include H8 single-head residuals and compensate for duplicated phase-head output regularization. This closes an attribution gap in the current grid before spending the 2,331-row test. New comparisons require a separate frozen registration; v3 results remain immutable. Production adoption still requires device/runtime and playing-strength evidence.

The [prior primary-source research](../neural-h4-v2/RESEARCH.md) informed the residual, quantization and optimization approach. The [independent audit CLI](../../tools/training/audit-h4-v3.py) contains no trainer/model imports. The [public aggregate receipt](results-2026-09.json) contains no weights, source positions, split identities or private paths.
