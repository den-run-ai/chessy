# Separate H4 neural screen

This research experiment asks whether a four-unit piece-square network can
improve the clean natural pilot's teacher predictions at a small parameter cost.
It does not replace the shipped HCE, change the H64 production plan, or establish
an Elo/time improvement. [PR #174](https://github.com/den-run-ai/chessy/pull/174)
registered the [contract](natural-nnue-h4-v1.json) before neural performance access.

The existing 33,103 shared training rows, 2,374 NNUE validation rows and 2,331
NNUE test rows keep their original game/family roles. Shipped HCE and the frozen
753-plus-six-pawn-attack comparator are evaluated unchanged on the same NNUE
roles. HCE validation/test are not reused for neural selection. All raw evidence,
the original 53-file audit closure and exact selected HCE weights must be
recovered and authenticated; a missing file stops the screen.

## Model and decisions

The shared 768-by-4 first layer has two perspectives and CReLU. Three fixed seeds
use CPU full-batch L-BFGS-B; the median validation seed is selected for each of
two explicit net-only/mop-up variants. Selection uses quantized predictions and
requires all registered quality guards against both frozen comparators. No
qualifying variant means stop with the test unopened. A selected hash can open
NNUE test once, with the same guards and family-cluster confidence intervals.

Integer parameters occupy exactly 6,180 bytes. This excludes metadata and code.
The independent JavaScript scalar reference is a test oracle, not a production
implementation. Its source size and metadata are reported separately; adding
them is a portable reference package size, not the future WASM delta. Synthetic
math/parity tests and theoretical int32/int64 bounds precede real training.
Physical-device evidence in #84 still blocks runtime integration; formal family
and estimator admission is tracked by #175. No held-out opening is searched.

## Reproduction

Use a clean committed checkout of this branch and the existing safely extracted
private archive. Keep NumPy 2.3.5 and SciPy 1.17.0, Node, Python and the checkout
fixed during the run. Exact-byte relocated source files or the original teacher
executable may be placed inside the bundle; original audit documents are never
rewritten. The loader verifies every required digest and retains parsed bytes.

```sh
python tools/training/natural-nnue-h4.py authenticate --bundle /absolute/recovered/bundle
python test/training/h4-model.test.py
python test/training/h4-data.test.py
python test/training/h4-screen.test.py
python tools/training/natural-nnue-h4.py select --bundle /absolute/recovered/bundle --output /absolute/new/h4-run
# Only if selection.json records testEligible:true:
python tools/training/natural-nnue-h4.py test --bundle /absolute/recovered/bundle --selection /absolute/new/h4-run/selection.json --output /absolute/new/h4-run/test.json
```

The canonical `.research-state` records run start, frozen selection and test
exposure independent of output/selection filenames. Preserve it alongside the
private output archive. Do not delete it, rerun failed seeds, or reopen test
under a new checkout. The contract assumes a trusted isolated runner; it does
not claim protection against deliberate state deletion or hostile same-user
processes. A failed run preserves its partial outputs and consumed markers.

The trainer writes private float/quantized artifacts and complete per-seed
reports. Commit only weight-free summaries; retain original source/teacher and
generated-artifact licensing. CPU is the default and the paid cap is $5; this
implementation itself launches no paid service. Dataset expansion, H8, GPU
scaling and difficulty recalibration are outside this run.
