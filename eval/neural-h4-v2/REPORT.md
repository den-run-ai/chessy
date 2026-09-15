# H4 recipe repair: aggregate gain, endgame guard still fails

**The repaired H4 residual improves aggregate teacher loss and CP accuracy, and
passes quantization. It does not advance: one preregistered endgame guard fails.**
The shipped evaluator and WASM remain unchanged; NNUE test stays unopened.

## Registered execution

- [Preregistration](https://github.com/den-run-ai/chessy/commit/77b4d945adffbe3b353487e32044619b4bd6ce56)
  preceded new performance; its numerical contract SHA-256 is
  `f40b32d8201eea731e022a9940ec0d33b682d50c219a2ca4c35df241738082b0`.
- Exact execution commit: `b57e1320a18579c797f7dfc19c459d7859f757bd`.
  Original v1 evidence and its invalid mop-up ablation remain immutable.
- Reused all 53 authenticated original evidence identities. No labels generated.
  Shared-train has 33,103 rows; family hashing gives **26,489 inner training /
  6,614 inner validation**. Each admitted row has a different source game.
- Twelve fixed development fits: four configurations × seeds 10511/10512/10513;
  each ran 300 epochs. Selection used quantized inner CE only, restricted to QAT
  checkpoints at epochs 210–300. The chosen H4 configuration's median seed and
  median checkpoint epoch were frozen before a single full-shared-train refit.
- Selected `h4-residual-l010`, seed **10512**, refit **290 epochs** using the
  registered schedule prefix. The outer validation role was decoded only after
  the final model digest was frozen; no outer checkpoint/seed reselection.
- **13 fits, 154.886 seconds of fitting; 219.856 seconds for the
  admitted run including feature extraction, parity and checks. Paid compute $0.**
  CPU, one thread, NumPy 2.3.5 / SciPy 1.17.0. All finite budget endpoints;
  convergence is not claimed. No Modal job, GPU or additional dataset required.

## Same outer NNUE validation role

These 2,374 rows were exposed by v1. This is an **exploratory transfer check**,
not an untouched confirmatory result. The 2,331-row NNUE test remains sealed.

| Evaluator | Teacher cross-entropy | CP MAE | CP RMSE |
| --- | ---: | ---: | ---: |
| Shipped HCE | 0.406480 | 130.67 | 179.92 |
| Frozen expanded HCE | 0.403504 | 129.05 | 178.28 |
| H4 v2 residual | 0.398956 | 127.14 | 176.16 |

H4 v2 lowers CE **1.851% versus shipped HCE** and
**1.127% versus frozen expanded HCE**.
MAE improves 2.697% / 1.474%; RMSE improves 2.090% / 1.192%, respectively.
The prior H4 v1 median CE was 0.425628 on these same validation rows; this is
meaningful recipe progress, but it cannot be attributed to a single change:
optimizer, regularization, residual structure and quantization all changed.

**The sole failed guard is endgame CE versus expanded HCE** on 332 rows:
0.275116 versus 0.271050, **1.500% worse**, above the registered 1% maximum.
It is still 1.819% better than shipped HCE's endgame CE of 0.280213. This observed
gate failure is not a statistical proof of an endgame playing-strength regression.
All aggregate CE/MAE/RMSE/p99, other-phase coverage/CE, score, size and quantization
guards passed. The threshold was not relaxed and the test was not opened.

## Development controls and capacity scaling

Values below are medians of three seeds' selected inner checkpoints. They use a
different role from the outer table and must not be mixed with it.

| Configuration | Inner CE, median seed | Best epochs, seeds 10511/12/13 | Parameter bytes |
| --- | ---: | --- | ---: |
| h4-net-l001 | 0.420097 | 260, 260, 260 | 6,180 |
| h4-residual-l001 | 0.404956 | 210, 210, 210 | 6,180 |
| h4-residual-l010 | 0.401311 | 300, 290, 240 | 6,180 |
| h8-residual-l010 | 0.398765 | 300, 300, 240 | 12,356 |

Shipped HCE inner CE is 0.410030.
These inner rows were withheld only from the new v2 fits; v1 neural training and
expanded HCE fitting previously consumed them. Expanded HCE is frozen and its
inner comparison is in-sample for that comparator. This is development evidence.

The H8 probe improves median inner CE by **0.627%** relative to the selected H4
recipe while doubling parameter storage. It never competed for final selection
and was not scored on outer validation or test, because its 12,356-byte encoding
exceeds the registered 6,500-byte advancement budget. This does not establish an
H8 transfer or Elo gain. The low-regularization residual curves deteriorate late
while the stronger regularization arm is more stable; more iterations alone are
not a sufficient response to the original failure.

## Quantization and size

Exact integer Python/JavaScript parity has zero mismatches for all 12 selected
inner checkpoints on 33,103 training-role rows each, plus the final model on
35,477 consumed rows: **432,713 real-row comparisons**, plus 91 authored-FEN
comparisons. Every model also passed the float-error and output-range checks.

Final raw-float versus integer error is **0.570 cp maximum /
0.250 cp mean on full training**, and
**0.558 / 0.251 cp on outer validation**,
comfortably within 5 / 1 cp. Q1 increased from 1,024 to 16,384; representable
ranges are enforced during training. QAT mirrors export weight quantization;
exact exported integer inference, including final CP rounding, is checked independently.
This fixes the former quantization failure without increasing H4 parameter bytes.

H4 parameters occupy **6,180 bytes**, metadata **690 bytes**. The independent
BigInt reference source occupies **7,645 bytes**;
these components are reported separately and are not a compiled WASM delta or a
production inference-time measurement. Residual evaluation also retains shipped
HCE computation. The existing shipped WASM stays **37,172 raw / 17,690 Brotli**.
Weights, split identities and experiment state are preserved privately.

## Verification and next decision

Independent audit passed: **432,804** separately decoded integer outputs match the JavaScript reference exactly. It reproduced all selected-checkpoint/final metrics, quantization deltas, regularization and QAT gradients, split identities and selection/state bindings. It read or hashed no NNUE-test files. Source/teacher authentication and the frozen HCE extractor are explicit dependencies; optimizer trajectories were not replayed.

21 new synthetic tests cover gradients, sum-L2, straight-through quantization,
residual semantics, H4/H8 binary/parity, grouped splitting, Adam, checkpoint/seed
selection, complete synthetic 13-fit runs and no-replace holdout markers. Rejected
reruns cannot add a false failure receipt to a completed output directory.

[Primary-source research](RESEARCH.md) explains the Stockfish PSQT bypass and
quantization controls, Reckless/Bullet training/export practices, and Leela's
sampling/optimization lessons. Leela's policy/value/MCTS architecture is distinct
from NNUE. No external trainer code or weights were imported.

The next targeted hypothesis is **phase-aware residual training or representation**,
selected using training-only phase diagnostics; the current evidence does not
justify GPU scaling or blindly increasing iterations. A future experiment must
register its phase policy and capacity/size budget before scoring, preserve the
remaining test, and cannot retroactively repair this run's failed gate.
Runtime integration stays behind #84; formal family/estimator acceptance remains
open in #175. No runtime code, formal matches, level recalibration or Elo claim.

Complete result receipts, model identities, learning curves and independent audit evidence are retained with the private checkpoint bundle. This public report contains aggregate findings only.
