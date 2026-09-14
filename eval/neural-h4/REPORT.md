# H4 neural screen — 2026-09-14

**Keep the shipped evaluator. The registered H4 net-only screen failed validation
and quantization gates. NNUE test remains unopened.** This is a negative result
for one small architecture/training recipe, not a result about all compact neural
evaluators. No runtime integration, matches, larger dataset, H8, GPU job or level
recalibration followed. Paid compute: **$0**.

## Registration and reused data

[PR #174](https://github.com/den-run-ai/chessy/pull/174) published the separate
[H4 contract](../training/natural-nnue-h4-v1.json) at `2447932` before any neural
performance access. Reviewed implementation and execution were frozen at
`438f091a20c1df24cdfff17e3cb59c590bde8116` (tree
`bc05edd64c3493185998cd51e2fe0c316466c4d1`). The contract SHA-256 remains
`9496075fddda26a02ac9a0e79a6271d914eede48eaf7e1a3a9de2de85dff1180`.

The existing clean CC0 natural-game pilot supplied 33,103 shared training rows,
2,374 reserved NNUE validation rows, and 2,331 reserved NNUE test rows. No labels
or splits were regenerated. HCE validation/test were not used for neural fitting
or selection. Mechanical archive hashing is distinct from performance exposure.

The preserved archive downloaded successfully after transient HTTP 502 failures.
Its SHA-256 is `08ea9b8921765c8b6ec7c450dc06fc1685c48c6214fdd2ff7c4e7c734af66f9a`.
It intentionally omitted an external teacher executable and a code-held opening
file. The opening file was restored from immutable Git bytes; the teacher was
rebuilt from the original pinned official source ZIP with its recorded command
`make -j2 build ARCH=x86-64`. The resulting 113,242,056-byte executable matches
SHA-256 `ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319`
**byte-for-byte**, including both recorded embedded network identities.

All **53 original audited artifacts** authenticate with unchanged original
path-key closure digest
`5f5deaf0ff2240ce4e507451322af465f67d4b219d1ddb0a030a70f56ab3156f`.
Relocation finds exact bytes by digest; it does not rewrite the original audits.
The independently audited label summary and frozen expanded-HCE selection also
match their published identities. This is research-data reuse, not production
source/certification admission under #146.

## Model and fixed-budget training

The model has 768 piece-square inputs, a shared four-unit CReLU layer, two ordered
perspectives, and one scalar output: 3,085 parameters. White perspective uses
native a8=0 squares; Black swaps colors and flips ranks. The output is converted
from side-to-move to White POV. NumPy 2.3.5 / SciPy 1.17.0 runs deterministic,
single-threaded sparse L-BFGS-B with fixed seeds 10501/10502/10503. Calibration
`k=4.0` is retained from the preceding shared-train HCE calibration.

All three fits reached the registered **600-iteration budget**, rather than
optimizer convergence. The preregistration explicitly allows a finite final
budget iterate; there was no extension or restart. The optimizer calls took
7.763, 7.783 and 7.707 seconds (23.253 seconds total). The timed
training/export/reference stage took 35.063 seconds, excluding initial evidence
admission and comparator preparation. These are local CPU timings, not search
or device performance.

The frozen rule chooses the median quantized validation seed, not the best seed.
Seed **10503** is the median net-only run. Every seed fails the quality guards.

## Validation results

All rows below use the same **2,374 NNUE validation positions**. Lower loss and
error are better. The expanded comparator is the previous frozen 753-coefficient
plus six pawn-attack selection; it was not refitted.

| Evaluator | Training CE | NNUE validation CE | Validation CP MAE | Validation CP RMSE |
| --- | ---: | ---: | ---: | ---: |
| Shipped HCE | 0.400337 | 0.406480 | 130.67 | 179.92 |
| Frozen expanded HCE | 0.392985 | 0.403504 | 129.05 | 178.28 |
| H4 seed 10501 | 0.350987 | 0.419372 | 157.79 | 225.38 |
| H4 seed 10502 | 0.360374 | 0.434629 | 147.29 | 207.72 |
| **H4 median seed 10503** | **0.348519** | **0.425628** | **153.42** | **215.50** |

The median H4 reduces training loss by 12.94%, but validation loss is **4.71%
worse** than shipped HCE; MAE is 17.41% worse and RMSE 19.78% worse. Every phase
also misses its validation guard. This training/validation gap is consistent
with overfitting or a mismatched training recipe; it does not prove which cause
dominates. The floating model has virtually the same validation loss
(0.425632), so quantization alone cannot explain the quality failure.

The frozen expanded HCE improves CE by 0.732% on this additional reserved role.
This supports its predictive transfer, but adds no playing-strength evidence
and does not reopen its completed inconclusive 80-game screen.

## Quantization and size

Three-seed integer Python versus independent JavaScript parity has **zero
mismatches** across 35,477 consumed train/validation positions plus seven authored
fixtures per seed (106,452 position/model checks total). Representability and
theoretical int32 accumulator/int64 output bounds pass. Cross-language agreement
does not imply that float-to-integer accuracy passes.

| Seed | Maximum float/quantized difference, train | Mean difference, train | Maximum difference, validation | Mean difference, validation |
| --- | ---: | ---: | ---: | ---: |
| 10501 | 7.319 cp | 1.385 cp | 6.833 cp | 1.414 cp |
| 10502 | 6.405 cp | 1.075 cp | 4.814 cp | 1.068 cp |
| 10503 | 8.678 cp | 1.385 cp | 7.499 cp | 1.416 cp |

The registered maximum/mean limits were **5/1 cp**. All three seeds fail. No
post-result scale search, quantization retuning or second training pass occurred.

| Component | Bytes |
| --- | ---: |
| Integer parameters | 6,180 |
| Per-model metadata | 587 |
| Portable JavaScript reference source | 4,299 |
| Reference package sum | 11,066 |

The sum excludes Node itself and is **not a measured production WASM delta**.
No Rust inference kernel, accumulator integration or device test was added.
Shipped WASM stays 37,172 raw / 17,690 Brotli bytes, with SHA-256
`57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.

## Disclosed secondary-ablation error

The named `net-plus-existing-fixed-mop-up` comparison is **invalid**. The contract
named a mop-up ablation but mistakenly specified the affine helper's `fixedCp`.
That field is `fixedTaperCp + mopUpCp` and includes fixed material values. The
implementation followed the wrong field, so it added material as well as mop-up.
The pre-run synthetic parity checks and independent review missed that semantic
error; it was caught during inspection of the completed results.

Original outputs are preserved as the actual, mislabeled arithmetic, explicitly
marked invalid in the machine-readable report. They support **no claim** about
the correct mop-up ablation. The net-only loss, fitted weights, quantization,
comparators and seed order are independent of that additive comparison and remain
valid. No corrected real-data ablation was scored, no seed was retrained or
reselected, and the test was not opened.

The current entrypoint fails closed on the contradictory v1 contract. A later
contract must explicitly select `mopUpCp`; the prospective scoring code now reads
that isolated field, but no corrected real-data scoring was run. Added semantic regressions distinguish
a pawn advantage with **94 cp fixed material and 0 cp mop-up**, and a queen versus
lone king with **38 cp mop-up** plus more than 900 cp fixed material. The original
contract and execution code remain immutable in Git for audit.

## Decision and retained evidence

Stop this H4 candidate. The canonical run-start and frozen-selection markers
are preserved, with no test-exposure marker. The 2,331 NNUE test rows remain
unused for performance. No stronger claim than a failed fixed-budget H4 recipe
is justified. A later hypothesis would need a new registration and must disclose
that these NNUE validation outcomes are now exposed; it must not treat this as
permission for a larger network or a retry.

Full original selection SHA-256:
`ca581e7197f6e94b9e112759ce2d8ba36ef356c8ce191ee0866a3a92aced64c0`.
Private checkpoints, exact quantized blobs, all original per-seed records,
canonical state, teacher reconstruction and source provenance are retained.
The [weight-free complete results](h4-screen-2026-09.json) retain every seed and
identify the invalid secondary rows. Source/teacher terms and generated-artifact
release decisions remain separate; checkpoints are not automatically MIT.

An [independent net-only audit](h4-independent-audit-2026-09.json) reconstructs
all **106,431** train/validation predictions across the three seeds using
python-chess feature indexing, manual NumPy gather/sum, a separate little-endian
decoder and alternative BCE expression. It reproduces every reported net-only
metric, both HCE comparators, seed order and guard failure, with zero integer
JavaScript mismatches. It reads no NNUE-test files and does not retrain or
recompute the invalid ablation. Original audit SHA-256:
`858bebd769c207ad0cee5b3edd8428b5d31ab6583e2d3eb98634d9d74a9587c4`.
It does not independently replay the optimizer trajectory; source/teacher
authentication is inherited from the separately pinned original audits.

Physical-device baseline #84 still blocks G3 runtime integration. Formal
family/estimator/holdout admission is tracked by #175. The foundation's repaired
generic transcript/partition admission is in #146; neither its code validation
nor this teacher-loss screen substitutes for strength evidence.
