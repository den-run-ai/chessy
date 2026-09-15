# Tiny neural evaluation: diagnosis and transferable practices

Research checked on 2026-09-15. This document motivates a new, bounded follow-up;
it reports no follow-up training results. The new experiment's registration is
the authority for numerical settings and selection rules. The original H4
contract, checkpoints, and negative result remain unchanged.

## What the original screen established

The [original report](../neural-h4/REPORT.md) records three trained models, each
stopped at its 600-iteration L-BFGS budget. The median model improved training CE
by 12.94% but worsened reserved NNUE validation CE by 4.71%. Its floating-point
validation loss was almost identical to its quantized loss. Quantization error
therefore does not explain the generalization failure, although it independently
failed the registered 5 cp maximum / 1 cp mean limits. Integer Python/JavaScript
parity passed; agreement between implementations is a separate property from
agreement with the floating model.

Inspection of the preserved checkpoints and shared training role provides more
specific hypotheses:

| Observation | Consequence for the next experiment |
| --- | --- |
| The old regularizer was `0.5 * 1e-5 * mean(parameters**2)`, over 3,085 parameters. Its contribution was about 3.08e-7–4.47e-7 beside CE near 0.35, with maximum regularization-gradient magnitude below 8.5e-9. | It exerted little restraint. Specify the normalization and parameter groups explicitly; a sum penalty with the same coefficient is 3,085 times larger when applied to the same parameters. |
| Final maximum gradient components remained about 0.0017–0.00245, above the 1e-7 stopping tolerance. | These were finite budget endpoints, not established optima. Record learning curves, gradient norms, and stopping reasons. More optimization is a hypothesis, not a guaranteed improvement. |
| On training positions, one unit was upper-clamped about 92.5% of the time and another was inactive about 93.1% of the time. | Monitor per-unit activation and saturation. This can waste much of a four-unit model's capacity; it does not by itself prove an implementation bug. |
| First-layer absolute maxima were about 1.13–1.52; output absolute-weight sums were about 9.67–12.06. Output quantization already used its maximum Q2 of 4,096. | Simply increasing Q2 cannot repair the old export. First-layer rounding, output amplification, and clipping boundaries deserve direct checks. |
| 16,364 of 33,103 training teacher-WDL targets were exactly 0 or 1. | The target distribution is highly polarized. Preserve the target contract and inspect calibration/phase behavior; do not silently substitute a different score transform or human game-result mixture. |

These are training/checkpoint diagnostics, not measurements on the unopened NNUE
test role. The inaccurate secondary "mop-up" ablation remains invalid: its
`fixedCp` field included fixed material as well as `mopUpCp`. A residual model
using the complete shipped HCE must be named and trained as exactly that model.

## Stockfish: representation and export are part of training

Sources below are pinned to `official-stockfish/nnue-pytorch` commit
`9f72946529c4187d3679014036cd22c3be419716`, observed during this review. These are
trainer defaults at that commit, not a claim that one exact recipe produced a
particular released Stockfish network.

The current trainer combines `Full_Threats`, `PP_3Wide`, and factorized
`HalfKAv2_hm` features; hidden widths default to 1,024/32/32. The forward model
has a direct PSQT contribution in addition to the nonlinear layer stack. A
four-unit piece-square model is therefore a much more restrictive hypothesis
than "Stockfish NNUE, only smaller."
[Features](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/modules/features/__init__.py),
[widths](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/modules/config.py),
[forward model](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/model.py).

Fake activation and weight quantization are enabled by default. Weight fake
quantization uses rounding; activation fake quantization matches the inference
floor operation, with straight-through gradients. The exporter rejects
out-of-range conversion, and training clips constrained weights. The portable
lesson is to train against the exact arithmetic intended for export, including
rounding, accumulator limits, and output scaling. This does not establish that
Stockfish's scales are optimal for Chessy's different architecture.
[Configuration](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/config.py),
[quantization implementation](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/quantize.py).

The default optimizer is RangerLite at learning rate 8.75e-4, with an epoch
decay factor of 0.992; alternatives include schedule-free optimization and an
optional one-cycle schedule. Explicit weight-decay defaults are zero, so it
would be inaccurate to claim Stockfish mandates strong L2. The training loop
also has gradient clipping, checkpointing, finite-value termination, and optional
stochastic weight averaging.
[Optimizer defaults](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/optimizers/config.py),
[scheduler](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/optimizers/rangerlite_wrapper.py),
[training loop](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/train.py).

Its current loss is an absolute probability-error power of 2.5, using separate
score-to-expected-result transforms for teacher and network. It supports a blend
with actual outcomes but defaults to teacher evaluations only. Our frozen
teacher-WDL BCE remains a valid comparison metric; changing loss or calibration
would be an additional experiment, not an automatic repair.
[Loss calculation](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/model/nnue.py).

Sampling is also engineered: configurable tactical/WLD filtering, early-ply
skipping, and piece-count weighting. The current epoch default is 100 million
positions, far beyond this pilot. Old wiki statements about hundreds of epochs
must not be interpreted as hundreds of passes over 33,103 repeated rows. For
Chessy, keep the authenticated labels and role boundaries, shuffle training
batches, and make correlated-family weighting or new filters explicit before use.
[Sampling controls](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/data_loader/config.py),
[epoch definition](https://github.com/official-stockfish/nnue-pytorch/blob/9f72946529c4187d3679014036cd22c3be419716/config.py).

## Reckless and Bullet: keep scale and arithmetic claims precise

Reckless identifies Bullet as its current NNUE trainer. The engine at commit
`31d9cd6fd2bea6d9f72eeb35e0bac70daa295fb1` has ten input buckets, eight output
buckets, and widths 768/16/32. It accumulates king-bucketed piece-square and
piece-threat features; the first feature transform uses clipped multiplicative
pairing. Its inference becomes floating point after the first dense layer, with
careful scalar/SIMD ordering. It is neither an H4 model nor an entirely integer
reference for Chessy. The 0.9.0 release specifically describes the addition of
threat features.
[Trainer acknowledgement](https://github.com/codedeliveryservice/Reckless/blob/31d9cd6fd2bea6d9f72eeb35e0bac70daa295fb1/README.md),
[architecture](https://github.com/codedeliveryservice/Reckless/blob/31d9cd6fd2bea6d9f72eeb35e0bac70daa295fb1/src/nnue.rs),
[scalar inference](https://github.com/codedeliveryservice/Reckless/blob/31d9cd6fd2bea6d9f72eeb35e0bac70daa295fb1/src/nnue/forward/scalar.rs),
[release explanation](https://github.com/codedeliveryservice/Reckless/releases/tag/v0.9.0).

Bullet's simple progression example at commit
`629ee50000b2afb7b3337595401c830d3b1e0f42` is a more useful architectural reference:
768 inputs, 128 hidden units shared across two perspectives, squared clipped
ReLU, and one scalar output. It uses AdamW, cosine learning-rate decay, sigmoid
MSE, explicit quantization, and periodic checkpoints. Its example batches contain
16,384 positions; each superbatch approaches 100 million positions. These are
example choices, not a verified recipe for Reckless's released weights. Borrow
the explicit schedule/export discipline without importing the example's capacity
or data budget.
[Simple training example](https://github.com/jw1912/bullet/blob/629ee50000b2afb7b3337595401c830d3b1e0f42/examples/progression/1_simple.rs).

Bullet's data guidance calls for shuffling and interleaving converted data and
filtering noisy positions from contiguous game records. Its format documentation
distinguishes optimizer state, raw weights, and quantized exports, warns that
integer overflow prevents a quantized save, and specifies little-endian layout
and the difference between truncation and explicit rounding. These details
transfer directly to a reproducible small-network pipeline.
[Data handling](https://github.com/jw1912/bullet/blob/629ee50000b2afb7b3337595401c830d3b1e0f42/docs/3-data.md),
[checkpoint/export format](https://github.com/jw1912/bullet/blob/629ee50000b2afb7b3337595401c830d3b1e0f42/docs/4-saved-networks.md).

## Leela: transferable experiment discipline, different engine design

Lc0 combines policy and value prediction with MCTS/PUCT and now documents
transformer-based networks, plus a moves-left head. It is not an NNUE training
recipe for a tiny scalar evaluator inside Chessy's alpha-beta search. Its old
convolutional topology page is explicitly listed as outdated in the current
developer overview.
[Current architecture and search](https://lczero.org/dev/lc0/search/alphazero/),
[developer overview](https://lczero.org/dev/overview/).

Leela's training guidance warns that repeatedly sampling the same positions can
cause overfitting and connects sampling ratio, learning rate, and regularization.
Its network overview also explains why collected self-play data can be reused
for supervised experiments with different schedules and sampling choices. That
supports diagnosing the recipe on existing data before generating a larger
corpus. Historical wiki heuristics are not universal numerical defaults.
[Training guidance](https://lczero.org/dev/wiki/neural-net-training/),
[networks and runs](https://lczero.org/play/networks/).

The TensorFlow trainer inspected in this review includes L2 regularization,
minibatch gradient accumulation, global gradient clipping, configurable
learning-rate boundaries and warmup, checkpoint state, and optional weight
averaging. Its `q_ratio` interpolates search estimates and game outcomes. These
are useful engineering precedents for an observable, resumable training loop,
not numerical defaults to copy into H4. The inspected `tfprocess.py` Git blob
identity is `17d198fe5c6ca12f1882015fdc092fb3fc7d9f85`; this is a file identity,
not a release-network training receipt.
[Leela trainer](https://github.com/LeelaChessZero/lczero-training/blob/master/tf/tfprocess.py).

Outcome blending in these ecosystems generally concerns engine self-play
outcomes/search targets. It does not imply that the human-game outcome in
Chessy's source PGN is a reliable label for an individual position. This
follow-up retains the authenticated teacher targets and adds no human-outcome
blend, policy head, MCTS, or self-play generation.

## Bounded follow-up and what each arm can answer

The new registration separates an H4 net-only control, H4 residual-to-shipped-HCE
arms at two regularization levels, and an H8 residual capacity probe, using three
fixed seeds per arm. A frozen full-HCE bypass lets the small nonlinear part learn
corrections instead of relearning material and existing positional terms through
four clipped units. This is our inference from the diagnosis and PSQT-bypass
precedent; neither Stockfish nor Reckless establishes that it will help Chessy.

The recipe makes sum-L2 explicit, uses shuffled Adam minibatches and a cosine
schedule, records checkpoints and activation/gradient diagnostics, and finishes
with straight-through quantization-aware training. An inner family split drawn
only from the original shared training role controls checkpoint/configuration
selection. The already exposed NNUE validation role is not a tuning set, and the
NNUE test role remains unopened during troubleshooting. The registration must
also account for the original pilot's prior use of the entire shared-train role;
an internal split does not create an untouched external holdout retroactively.

Q1 rises from 1,024 to 16,384 with corresponding train-time representability
bounds. This improves the first-layer quantization lattice without increasing
its int16 storage, but narrows representable floating weights to approximately
[-2, 2). Exact accumulator/output bounds, serialization, rounding, and
cross-language parity must still be verified. QAT and a finer scale do not
guarantee the old maximum/mean cp error guards will pass.

The H4 parameter encoding remains 6,180 bytes. The equivalent H8 encoding is
12,356 bytes and exceeds the original 6,500-byte parameter cap; H8 is a
diagnostic capacity probe, not an eligible shipping candidate under that cap.
Neither count includes inference code or establishes the eventual WASM delta.

Use local CPU first. This plan initially adds no new labels or GPU job; any paid
scale-up remains inside the authorized cap and needs a measured reason. Keep
source/teacher/model release decisions separate: external trainer source is a
reference, not imported code, and unresolved checkpoint licensing keeps weights
private. Runtime integration still requires size, device timing, quantized
correctness, and an adequately powered preregistered strength experiment. Formal
family/estimator admission remains separate under issue #175.
