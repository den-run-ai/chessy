# Matched architecture and training-budget screen — 2026-09-15

**V4 reached the registered training-budget plateau and failed the endgame advancement guard.** Endgame CE is 1.350% worse than expanded HCE against a 1% allowance. The NNUE test remains unopened and production evaluation remains unchanged.

Completed **24 factorial fits + 6 budget fits + 1 frozen refit** (31 fits total), with **870.062 seconds** of reported fitting time and **$0 paid compute**. Full elapsed time including admission, feature extraction and parity was 1088.993 seconds.

## Registered design

- Execution: [`53a8724503dd`](https://github.com/den-run-ai/chessy/commit/53a8724503dd2567969fc3e12a32ba12e53c8b53); [exact preregistration](../training/natural-nnue-h4-v4.json).
- Stage 1: H4/H8 × single/phase heads × endgame weights 1/4, all at 300 epochs and the same three seeds.
- Matched regularization: trunk L2 0.01; single-head output L2 0.01; each phase-head output L2 0.005. This removes v3’s doubled tied-head penalty.
- Freeze the factorial winner, then test 900/1800 epochs. Registered 3600/7200 extensions occur only when the latest eligible budget improves more than 0.1% over the best shorter eligible budget.
- Select the shortest eligible budget within 0.1% of the best eligible median CE, then refit once using its median seed and median selected epoch.
- Shared training: 33,103 rows; inner split: 26,489 training / 6,614 validation. No new labels or datasets.
- Inner phase eligibility uses shipped HCE. Expanded HCE is diagnostic on inner data it previously trained on; both comparators remain required for outer/test guards.
- Both inner and outer validation are previously exposed development evidence. The 2,331-row NNUE test was not opened by this screen.

## Complete factorial

| Configuration | Median inner CE | Best epochs by seed 10511/12/13 | Parameter bytes |
| --- | ---: | --- | ---: |
| h4-single-eg1-e300 | 0.401311 | 300, 290, 240 | 6,180 |
| h4-single-eg4-e300 | 0.402293 | 240, 230, 210 | 6,180 |
| h4-phase-eg1-e300 | 0.400483 | 250, 300, 240 | 6,200 |
| h4-phase-eg4-e300 | 0.401732 | 250, 230, 210 | 6,200 |
| h8-single-eg1-e300 | 0.398765 | 300, 300, 240 | 12,356 |
| h8-single-eg4-e300 | 0.400614 | 280, 300, 210 | 12,356 |
| h8-phase-eg1-e300 | 0.397701 | 280, 300, 290 | 12,392 |
| h8-phase-eg4-e300 | 0.399531 | 300, 300, 240 | 12,392 |

The frozen factorial winner was **h8-phase-eg1-e300**. All 12 matched axis comparisons, with median losses and seed ranges, are preserved in the [public aggregate JSON](results-2026-09.json).

Across the four matched comparisons for each axis, H8 lowered median inner CE by 0.417–0.695% versus H4, and phase heads lowered it by 0.140–0.270% versus a single head. Raising endgame weight from 1 to 4 increased aggregate inner CE by 0.245–0.464%. These are exploratory comparisons on the same reused inner split; they do not establish outer phase performance or playing strength.

## Registered budget progression

| Budget | Median inner CE | Best epochs by seed 10511/12/13 |
| --- | ---: | --- |
| 300 | 0.397701 | 280, 300, 290 |
| 900 | 0.397362 | 880, 840, 800 |
| 1800 | 0.397051 | 1670, 1770, 1650 |

| Completed budgets | Latest improvement over best shorter eligible budget | Registered decision |
| --- | ---: | --- |
| 300, 900, 1800 | +0.078% | bounded-budget-plateau |

**Budget-stage outcome:** `bounded-budget-plateau`; bounded plateau observed: **true**.
This is a result for the frozen recipe and registered schedule grid. Longer budgets stretch the learning-rate and QAT schedule; they do not demonstrate optimizer convergence or exhaust other architectures, regularization settings, features or datasets.

## Frozen refit and outer validation

Selected **h8-phase-eg1-e900**, median seed **10513**; refit once for **840 epochs**. Architecture, budget, seed, epoch count and model digest were frozen before outer scoring.

| Evaluator | Outer CE | CP MAE | CP RMSE | Endgame CE |
| --- | ---: | ---: | ---: | ---: |
| shipped-hce | 0.406480 | 130.67 | 179.92 | 0.280213 |
| frozen-expanded-hce | 0.403504 | 129.05 | 178.28 | 0.271050 |
| Selected v4 residual | 0.396092 | 125.50 | 174.31 | 0.274708 |

Aggregate outer CE improves **2.556% versus shipped HCE** and **1.837% versus expanded HCE**. Endgame CE changes **+1.350%** versus expanded HCE on 332 rows; the maximum allowed regression remains 1%.

**Offline advancement result:** frozen-expanded-hce:endgame-CE-guard.

## Independent verification

- Python/JavaScript integer parity: **0 mismatches across 1,028,784 comparisons**.
- Maximum float/integer difference: **0.619 cp**; largest role-mean difference: **0.350 cp**.
- Independent audit: **PASS**, 1,028,784 independently decoded outputs; **31** independently reconstructed selected/final normalized objectives and analytic gradients.
- Verified every selected binary and float checkpoint, scalar/phase metric, matched regularization coefficient, QAT gradient, complete curve inventory, cosine schedule, update count, factorial/budget receipt, plateau decision and final guard.
- The audit read or hashed **zero NNUE-test files** and observed **0 global/legacy test-opening markers**. Marker contents were not read.
- Optimizer trajectories and unretained checkpoint values were not regenerated. Source/teacher admission remains an inherited authenticated dependency.
- Stored parameter bytes exclude inference code and retained HCE computation. This screen measures no production WASM delta, physical-device speed, game result or Elo gain.

The [v3 report](../neural-h4-v3/REPORT.md) documents the preceding attribution gap. The [independent audit CLI](../../tools/training/audit-h4-v4.py) imports no trainer/model implementation. The [public receipt](results-2026-09.json) contains no weights, source positions, split identities or private paths.
