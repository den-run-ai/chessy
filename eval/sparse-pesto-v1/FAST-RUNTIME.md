# Cost-only adjacent-pair evaluator

The initial sparse model improved prediction metrics but added substantial
evaluation cost. This follow-up changes how the **same frozen coefficients and
features** are evaluated. It performs no new fit, output calibration, feature
selection, label selection, or holdout-based model change. The original runtime
measurements remain the evidence for the original implementation.

## What changes

The reference evaluator walks eight rays outward from each occupied square to
find each ray's first occupied square. The `sparse_fast` build instead sweeps
the board once in ascending a1-to-h8 order, keeping the previous occupied piece
on each rank, file, diagonal and antidiagonal.

For each current piece, those four predecessors generate the adjacent occupied
pairs along east, north, northeast and northwest. A 13 × 13 × 4 table, computed
once when the model loads, already contains the sum of both directed MG/EG
contributions for each piece-code pair and direction. Empty predecessor entries
are zero. The extra derived table occupies **5,408 bytes**; it is not additional
trained model capacity.

The native model retains 34,560 bytes of dense i16 coefficients, 24,576 bytes
of coalesced PST/own-king i32 pairs, and this 5,408-byte ray-pair table: **64,544
bytes of coefficient/table payload**, excluding container metadata. SPV1 saves
stored/downloaded model bytes; this implementation expands it at load time.
The resident table footprint should not be confused with the compact artifact
size or a measured production WASM footprint.

The fast build also hoists the four own/enemy king-bucket offsets out of the
piece loop and constructs pawn attack masks with the equivalent bit shifts.
PST/own-king coalescing, all feature coefficients, phase interpolation,
White-POV signs, residual rounding and the shipped HCE offset are unchanged.
There is no per-evaluation allocation.

## Why the ray computation is identical

For any occupied squares A and B on one straight chess ray, A's first occupied
target is B exactly when A and B are adjacent in that ray's ordered list of
occupied squares. In that case, B's opposite ray has A as its first occupied
target. The reference loop therefore contributes two directed features for
every adjacent occupied pair.

The four predecessor arrays enumerate every such undirected pair exactly once.
The precomputed entry adds the two original directed features, with the same
piece types, same/opponent-color flag, and individual White/Black signs. Before
looking up a Black source's feature, global directions are mapped through the
same vertical reflection used by the reference extractor. For the second
source, the global direction is reversed before that color-specific mapping.

All sums use integer arithmetic with the same wide accumulators, so changing
the addition order introduces no floating-point or rounding differences.
Rounding still occurs once after the complete MG/EG correction is tapered.

## Validation before timing

The new `sparse-fast.test.py` suite passes three tests covering:

- 1,550 authored, generated, color-mirrored and pair-geometry boards across
  eight coefficient vectors: zero, distinct coefficients, int16 extremes,
  and each of the five feature families separately;
- every realizable ordered piece-code pair in all four axes, including gaps,
  blockers, king pieces and both source colors;
- unchanged Python-reference arithmetic, compact/dense model parity,
  castling, en passant, promotions, sparse endings and capped material phase;
- identical returned fixed-node search signatures on eleven authored roots.

The frozen full model then produced **identical baseline/candidate/correction
triples on all 100,164 validation FENs** against the original frozen native
runtime. This comparison read no teacher labels and measured no timings.

| Identity | SHA-256 |
|---|---|
| Original frozen native | `b9827497e32a636b40bbfc9f15db814402c0f55a33b5c2e5f2a095fcafe88400` |
| Frozen fast native | `47d481ab0c1892126c108f4dd87ab1bda3280bdd9b9358540e9d8449644d9a55` |
| Unchanged full-model weights | `4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304` |
| Complete validation FENs | `1f5402d0b61d18f2c8c1dd791d99fc1bcecd2c44956b5bc28c8ed8bcf0c81900` |
| Identical validation score output | `489cb41f8ee9dbfd61ed546bbd172804dd51ff82e4f538c4982ae79668fc1df0` |
| Fast build receipt | `e5eaddfc589f057b9c6a087c9e8a6a3876c20851f4a769e2cfa8e2f5618c9fbe` |

The standalone fast executable is built with the pinned Rust 1.97.1 compiler:

```sh
rustc --edition=2021 -O --cfg sparse_fast \
  tools/sparse_eval/runtime.rs -o /absolute/sparse-eval-fast
```

Omitting `--cfg sparse_fast` retains the reference ray-walk implementation.
Neither build changes production `experiments/wasm` or app assets. These native
executables include development/runtime overhead and are not shipping WASM
modules or physical-device measurements.

## Separate measurement

The new cost-only measurement uses the exact frozen full weights and the
original 24 validation roots. It records old/fast paired observations with
balanced order and requires exact search-signature equality at both 10,000 and
36,000 nodes. Its newly registered results remain separate from the original
model/runtime comparison. A speed result does not change model quality,
establish Elo, or admit this evaluator for production.

## Observed cost results

The complete new comparison passed: all 100,164 validation evaluations and all
192 old/new search-signature pairs agree exactly. The search inventory contains
384 observations: 24 roots × two node budgets × two replicates × two binaries
× baseline/candidate modes. All requested nodes were consumed in the candidate
comparisons; no shard, root or valid result was selectively rerun.

| Requested nodes per root | Old-to-fast full-model speedup | Fast full-model NPS / HCE NPS |
|---|---:|---:|
| 10,000 | 1.480× | 0.801× |
| 36,000 | 1.412× | 0.793× |

These are geometric means over 48 paired full-model observations per budget.
The direct old-to-fast comparison uses the identical model and search tree.
The HCE-relative column compares the full model with the HCE in the fast
binary; their evaluation functions and resulting search trees differ. The
remaining throughput cost is about 20–21%, equivalent to approximately 25–26%
more time for a fixed node count. The evaluator is substantially cheaper than
its initial implementation and remains slower than the shipped HCE on this
native development workload.

The four static timing blocks give a 1.467× geometric-mean old-to-fast speedup.
Individual block timings vary substantially, so the small static comparison
should be read as descriptive. Neither comparison supplies a confidence
interval, a match result, a WASM speed claim, or a physical-device result.

The new runtime result SHA-256 is
`afe620988625451a43e2cc4d62e01c87eb462ee8d6811cb9d2c5b7bb723dd740`.
It is a separate completed experiment; the original negative cost evidence is
preserved without reassignment to this faster implementation.
