# Train-only LP correction of the expanded table

The bounded correction LP improved repair-position error, but its rounded
candidate is **rejected**. Its maximum preservation drift was **8 CP**,
exceeding the predeclared **5 CP** limit. The correction is not part of the
primary five-model selection and never opened validation or holdout data.

## Frozen inputs and procedure

The base was the predeclared `full` interaction model, selected for this
mechanism diagnostic before any grid scores, irrespective of which model the
primary validation later selected. Its completed `full.json` record bound the
34,560-byte model to SHA-256
`4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304`.
The fit plan was checked against the exact packed dataset manifest.

The [frozen configuration](TABLE-EDIT-CONFIG.json) used only the first 4,096
training rows: 2,048 repair rows and 2,048 preservation rows. Support selection
ranked `abs(base coefficient) * training-prefix feature RMS` and froze 128
coordinates. The L1 coefficient was 0.01 with RMS feature costs, each edit was
bounded to eight CP, and preservation constraints were hard five-CP limits.
Repair rows had equal weight. No validation result chose the base, support,
penalty or bounds.

The reader authenticated every byte of every declared train-role file while
retaining only the required prefix. It checked the full-file hashes, sizes and
descriptor identities. It did not read any validation or holdout role file.

## Measured result

| Measurement | Base `full` table | Rounded correction |
| --- | ---: | ---: |
| Repair MAE, 2,048 rows | 122.8091 CP | 121.6982 CP |
| Repair RMSE | 196.8674 CP | 195.9233 CP |
| Repair mean signed error | −18.7485 CP | −19.0791 CP |
| Preservation MAE, 2,048 rows | 111.2578 CP | 110.7915 CP |
| Preservation RMSE | 177.3230 CP | 176.8743 CP |
| Preservation mean signed error | −28.9902 CP | −29.0444 CP |

The continuous LP reached HiGHS optimal status, with reconstructed absolute
duality gap `1.42e-14` and maximum primal violation `8.86e-13`. Continuous repair
MAE was 121.6449 CP. Eighty-seven edit coordinates were nonzero before rounding;
**62 integer coefficients changed** after applying the table fitter's
nearest-ties-away-from-zero rule.

The floating preservation limit was met within numerical tolerance. Integer
coefficient export and the native tapered-score rounding increased the actual
maximum preservation change to eight CP. That fails the fixed limit even
though average error improved. No corrective rerounding, second fit or
post-selection update was attempted.

The retained native Rust evaluator matched the Python integer prediction for
**all 4,096 positions for both the base and corrected model**, including the
unchanged HCE offsets: zero mismatches over 8,192 candidate-score checks.
This verifies that the preservation failure is present in the actual native
arithmetic, rather than being a Python-only artifact. The full diagnostic,
including complete train-file authentication, completed in 4.96 seconds in
this environment; that duration is not an inference benchmark.

The [complete report](TABLE-EDIT-RESULTS.json) and
[rejected compact correction](TABLE-EDIT-REJECTED-PATCH.json) preserve the
negative result. The corrected model hash is
`b257c4161cef230aed0f77a95285693557af2a6ddf6423b15aeb69a50a5117df`.
This diagnostic establishes no held-out improvement, playing strength or
production eligibility.

## Implication

Both this table correction and the separate
[real NNUE head edit](CHNN-RESULTS.md) demonstrate that a well-solved continuous
LP can lose its preservation guarantee when exported to integer evaluation.
An integer-aware repair or explicitly budgeted rounding error needs a separate
training-only experiment. Tightening the reported result after observing
validation would not repair this experiment's evidence, so the rejected
corrections remain unchanged.

## Reproduction

```sh
python test/training/sparse-wsp.test.py
python test/training/sparse-table-edit.test.py
python -m tools.sparse_eval.table_edit \
  --packed-manifest /data/packed-v1/manifest.json \
  --fit-entry /data/fit-v1/full.json \
  --output /data/table-edit-v1
```

The entry may be used once that individual `full` fit has completed; the other
grid variants need not be complete. Its adjacent plan and model bytes are
authenticated before the diagnostic starts. A fresh output directory is
required. The source model, data, and executable are retained unchanged.
