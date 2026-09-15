# Phase-aware residual screen, v3

This is a new, separately registered experiment following the v2 endgame miss.
It keeps v1/v2 contracts, reports and implementations intact. No runtime weight,
engine default, release number or chess level changes are part of this screen.

The model adds two learned output heads to the shared piece-square trunk:
middlegame and endgame. Material phase is `min(24, N+B+2R+4Q)` over both colors.
The two heads interpolate before a single exact integer rounding, then add a
correction to the frozen shipped HCE. The data's coarse endgame label controls
the weighting ablation; it does not control inference phase.

| Configuration | Width | Heads | Epoch budget | Endgame row weight |
| --- | ---: | --- | ---: | ---: |
| h4-single-e300 | 4 | v2 single | 300 | 1 |
| h4-phase-e300 | 4 | MG/EG | 300 | 1 |
| h4-phase-e900 | 4 | MG/EG | 900 | 1 |
| h4-phase-e900-eg2 | 4 | MG/EG | 900 | 2 |
| h8-phase-e900-eg2 | 8 | MG/EG | 900 | 2 |
| h8-phase-e1800-eg2 | 8 | MG/EG | 1800 | 2 |

Each configuration uses three fixed seeds, explicit anchor regularization
`lambda=.01`, normalized weighted BCE, and quantization-aware training in the
last third of its cosine schedule. Selection uses unweighted quantized CE.
The phase-versus-single comparison changes architecture and effective output
regularization: duplicating identical heads doubles their sum-L2 penalty.
It does not isolate phase dependence alone.
The epoch ablation stretches the schedule as well as the duration; it is not
an optimizer continuation experiment. Eighteen development fits and at most
one refit are allowed; CPU training is bounded to 3,600 elapsed seconds, with
$0 planned paid compute and a $30 absolute paid budget. The CPU deadline also
covers admission, parity and publication overhead after authentication.

The same development split permits matched comparisons but was already used
in v2. No result on it is fresh confirmatory evidence. All development runs
must pass numerical gates before any selection; the median seed must also
pass each inner phase's coverage and 1% CE limit against shipped HCE.
Expanded HCE was trained on these inner labels, so its inner score is reported
but cannot veto selection. Both frozen comparators remain required for every
outer and test guard. This choice is fixed before any v3 measurements.
One recipe/seed/epoch count is frozen and refitted before outer
validation. If none qualify, the experiment stops without decoding outer
validation or test. After the one exploratory outer evaluation, any failed
quality, numerical or size guard blocks test opening.

H4 phase parameters occupy 6,200 bytes and H8 12,392 bytes. The 13 KB limit
only admits an offline experiment; actual WASM size, device/search performance
and formal strength remain separate required evidence. Small returns within
this finite configuration grid do not prove optimizer convergence or universal
performance saturation.

After committing a clean implementation and restoring prior research markers:

```sh
python tools/training/natural-nnue-h4-v3.py --bundle /absolute/audited-bundle --output /absolute/new-v3-output
```

The command always leaves test sealed. Only the same clean commit and one
eligible frozen selection can be tested with:

```sh
python tools/training/natural-nnue-h4-v3.py --bundle /absolute/audited-bundle --open-test-from /absolute/new-v3-output
```

The dataset-scoped opening marker is independent of this contract's identity,
and restored legacy test-open markers also block opening. Test bootstrap and
phase/error guards retain the original thresholds. The complete checkpoint
artifacts and state must be preserved externally; source-data licensing is
not replaced by the repository license.

The following authored-only tests exercise gradients, phase interpolation,
cross-language exact arithmetic, the complete lifecycle, and fail-closed
selection/test boundaries without reading experimental data:

```sh
python test/training/h4-v3-model.test.py
python test/training/h4-v3-screen.test.py
```
