# Direct NNUE output-head LP: measured improvement, rejected integer patch

The first direct edit of a real pretrained NNUE completed successfully as an
experiment. Its rounded candidate is **rejected**: preservation positions
moved by up to **8 CP**, exceeding the frozen **5 CP** limit. Neither the
original nor edited network is a Chessy production evaluator.

The LP improved teacher agreement, including on the separately opened
validation prefix. That result establishes a working direct-weight-editing
pipeline and a concrete quantization issue, not a playing-strength gain.
No post-validation adjustment or repeat candidate was made.

## What was edited

The source is the external
[`h100_v7_screlu_1024_6b.nnue`](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/nets/h100_v7_screlu_1024_6b.nnue)
checkpoint from Chatarunga commit
[`4f389446`](https://github.com/deedy/chess-chatarunga/commit/4f389446c685e011bcc2550c682e26bdb9f7a96b).
It is a 25,200,704-byte CHNN v1 SCReLU network with 16 king buckets, 1,024
hidden channels per perspective, eight material-dependent output buckets,
`qa=255`, `qb=64`, and `scale=160`.

Its SHA-256 is
`3877ab704904d8cee199be6a4d59c94ca13d945f08421f6cd31b3f92bafac0db`.
The feature transformer and all eight output biases were frozen. The LP
selected changes to the final linear output weights, before the native
integer truncations. The rounded patch changes **28 of 16,384 output weights**
by at most two integer units. It changes no first-layer weights.

The [frozen configuration](CHNN-CONFIG.json),
[complete measured report](CHNN-RESULTS.json), and
[rejected compact patch](CHNN-REJECTED-HEAD-PATCH.json) retain the exact result.
The patch is experimental evidence and is not eligible for activation. Its
parent and result hashes prevent applying it to another checkpoint. The full
25 MB source and edited network are not stored in this repository.

## Data and frozen procedure

The primary corpus's first 8,192 train-role rows, already ordered by source
record, supplied 6,144 repair positions and 2,048 preservation positions.
Those rows contain 5,019 distinct structural families. Repair families have
equal total weight. A train-only normalized LAD derivative selected 128
output-weight coordinates. The solver used an L1 penalty, a two-unit edit
box and hard five-CP preservation constraints.

Only after rounding and freezing the candidate did the script open the first
4,096 validation-role positions, comprising 2,347 families. Their families do
not intersect the training prefix. Validation did not select or modify the
candidate. The primary holdout was never opened by this experiment.

These are positions from the exploratory mixed-teacher Lichess evaluation
archive, which lacks source-game IDs. They must not be described as 12,288
independent games. The metrics compare the raw Chatarunga static network with
the archived CP labels; Chatarunga's separate material-dependent search
calibration is not applied. This is not a head-to-head engine comparison.

## Results

| Split / measurement | Original | Rounded edit |
| --- | ---: | ---: |
| Repair, 6,144 rows: MAE | 90.5457 CP | 90.1007 CP |
| Repair: RMSE | 156.4493 CP | 156.1239 CP |
| Preservation, 2,048 rows: MAE | 93.6211 CP | 93.3164 CP |
| Preservation: RMSE | 184.9812 CP | 184.7457 CP |
| Validation, 4,096 rows: MAE | 85.9426 CP | 85.6697 CP |
| Validation: RMSE | 153.4971 CP | 153.3210 CP |

Validation MAE fell by **0.2729 CP (0.318%)**. This is a descriptive result on
one frozen diagnostic prefix; no statistical or Elo claim is made. The full
experiment, including dataset authentication and native parity, took 9.28
seconds in this environment. This is an experiment completion time, not an
inference-speed measurement.

The floating LP reached HiGHS's optimal status. Its independently reconstructed
dual objective matched the primal objective to the reported precision, with
maximum primal violation `1.14e-13`. Family-weighted repair MAE before integer
rounding fell from 95.0988 to 94.5162 CP. Seventy-two coordinates were nonzero
in the continuous edit; 28 survived nearest-ties-to-even rounding.

The floating maximum preservation change was `5.000000000000012` CP, within
solver tolerance. **The actual rounded network moved preservation outputs by
8 CP.** Integer export therefore invalidated the requested bound. This is why
the candidate was rejected despite lower teacher error.

## Native parity and arithmetic

The adapter models all of the upstream evaluator's relevant operations:
king-based horizontal mirroring, Black's rank/color orientation, material
output buckets, wrapping int16 accumulators, clipped-and-squared activations,
and both signed integer divisions. Output weights also stay within the
upstream SIMD product bound of 128 in absolute value.

A release binary was built from a clean git-archive snapshot of the pinned
upstream source. Source and edited predictions each matched that binary on
**128 of 128 positions**, with **zero CP difference**. Each set contains 64
train-prefix and 64 validation-prefix positions. The tested native binary's
SHA-256 is
`a3b3fe59985900655940c1088f3d24d2388d359b498a5d84664577fa46135e4a`.
The original source checkpoint was never modified.

These checks establish actual quantized forward parity for the measured
positions. They do not establish search parity, smartphone cost, or playing
strength. Frozen feature maps make the continuous head LP convex; the
rounding step is outside that claim. A future experiment would need a
training-only integer-aware repair or a mixed-integer formulation and a new
declared validation protocol. This rejected patch is retained unchanged.

After this run, the reusable adapter's header validation was narrowed to
`qa <= 255` to exclude untested high-activation formats that could overflow
upstream SIMD partial sums. A regression test rejects `qa=256`. The pinned
checkpoint has `qa=255`; this guard does not change its arithmetic. The measured
report preserves the exact earlier implementation hashes and is not relabeled
as a rerun of the hardened reader.

## Provenance and license

The pinned Chatarunga repository's
[LICENSE](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/LICENSE)
and README identify the project as MIT, copyright Deedy Das 2026, and document
the embedded checkpoint. No separate license file was found under `nets/`.
The upstream training-data rights were not independently audited; this
experiment records the upstream declaration and does not relabel third-party
weights as original Chessy weights. Retain upstream attribution with any
checkpoint redistribution. The committed compact patch contains 28 changed
output coordinates and binds to the original checkpoint's exact hash.

## Reproduction

Run the adapter tests:

```sh
python test/training/sparse-wsp.test.py
python test/training/sparse-chnn.test.py
```

Run the same frozen experiment against the authenticated external data and
network, giving a fresh output directory and the exact locally built native
binary digest:

```sh
python -m tools.sparse_eval.chnn_experiment \
  --dataset-manifest /data/eval-v1/manifest.json \
  --net /data/h100_v7_screlu_1024_6b.nnue \
  --output /data/chnn-head-screen-v1 \
  --native-binary /opt/chatarunga \
  --native-binary-sha256 <sha256-of-that-binary>
```

The script snapshots authenticated executable/network bytes, publishes its
configuration before fitting, freezes the candidate before validation, and
publishes completion metadata last. Reproduction is not a new independent
validation trial; the already exposed validation prefix cannot be reused to
claim unseen confirmation for a revised candidate.
