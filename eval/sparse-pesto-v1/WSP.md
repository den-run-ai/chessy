# Sparse table corrections and direct NNUE head editing

`tools/sparse_eval/wsp.py` implements a bounded linear program over **fixed
features**. It can correct the expanded sparse PeSTO table, or edit the final
linear head of an existing frozen NNUE checkpoint. It adds no implicit bias.
Any bias column supplied by the caller is subject to the same finite bounds
and regularization as other coefficients.

## Objective and constraints

Given features `X`, current White-POV centipawns `b`, teacher values `y`, positive
row weights `a` normalized to sum to one, and edit `d`, the objective is:

```
sum_i a_i * abs(b_i + X_i @ d - y_i)
    + lambda * sum_j feature_cost_j * abs(d_j)
    + preservation_penalty * sum(preservation_slack)
    + margin_penalty * sum(margin_slack)
```

Every coefficient has a finite `[-max_abs_delta, +max_abs_delta]` bound.
Optional preservation rows impose `abs(P @ d) <= epsilon`; optional ranking
rows impose `M @ d >= minimum_gain`. For example, `M` can be good-minus-bad
child-position features in one consistent player perspective. Each constraint
family is hard unless an explicit positive slack penalty is supplied. Slack
penalties multiply the sum, not the mean, and slack is reported separately.

`solve_sparse_edit` returns `EditResult(delta, report)`. Failed, infeasible,
time-limited and independently non-feasible solves expose `delta=None`. The
report records primal violations, a reconstructed dual objective and duality
gap, error changes, preservation violations and slack. It does not grant
production or playing-strength status.

```python
from tools.sparse_eval.wsp import select_support, solve_sparse_edit

support = select_support(X_train, fitted_weights, budget=128)
result = solve_sparse_edit(
    X_train, current_cp, teacher_cp,
    support=support, l1=0.01, max_abs_delta=10,
    preserve_X=P_train, preserve_epsilon=2,
)
if result.report["success"]:
    candidate_weights = fitted_weights + result.delta
```

Support ranking uses `abs(weight) * RMS(feature)` computed on training rows
only. It excludes unseen/zero-effect features and breaks ties by feature index.
**Support selection is not convex.** The subsequent LP on its frozen support
is convex. Likewise, optimization of search decisions, jointly learned
low-rank factors, clipping-region changes, or integer rounding is not covered
by the convexity claim.

## Direct editing of the existing Chessy H4/H8 NNUE

`FrozenH4V3Head` uses the existing `h4_v3_model.py` model and integer format.
Its first layer, clipped activations and material taper stay frozen. The
design matrix exposes the two final linear heads, including their two explicit
biases, in the model's original parameter order. This is an actual edit of NNUE
output weights; it is separate from a correction to HCE table weights.

- `from_float_json(path, expected_sha256=..., hidden=4|8)` authenticates and
  parses the same retained bytes. The historical trainer emits `.float.json`,
  `.bin`, and `.metadata.json` companions, not NPZ checkpoints.
- `from_quantized_bytes(payload, hidden=..., metadata=...)` reuses the existing
  strict binary/metadata decoder and preserves valid integer endpoint values.
- `design(...)` returns exact floating linear features in White-POV CP units.
- `apply(delta)` edits only the head and rejects values outside the original
  model's bounds. It never clips an infeasible edit into apparent success.
- `audit_edit(...)` independently reruns the existing forward function,
  verifies the affine prediction, checks frozen-trunk equality, and compares
  exported integer inference with the decoded model before rounding.

Integer export can change preservation/ranking constraints. A float LP success
does not certify the rounded model; constraints and errors must be measured
again after quantization. The audit reports this explicitly. Tests use authored
synthetic checkpoints and make no trained-model or strength claim.

## WSP inspiration and scope

Nathan Barry's [Weight-Space LP](https://nathan.rs/posts/weight-space-lp/)
selects a sparse vector `v` for a fixed-direction rank-one edit `Delta W=u v^T`,
using repair and preservation constraints on recorded activations. Its
[implementation](https://github.com/nathanrs/weight-space-lp) and the original
[Weight-Space Programming experiments](https://rikiyat.github.io/blog/weight-space-programming/)
motivate this correction interface. `apply_rank_one_edit` uses exactly that
convention and never normalizes the supplied direction silently. Chessy's
last-linear-head adaptation is exact before rounding; applying the same LP to
arbitrary hidden NNUE layers would not be exact.

The user's DWE reference is interpreted here as direct weight editing; a
particular paper or canonical expansion has not been verified. No unrelated
Differential Weight Evolution or Distillation with Errors result is claimed.

Stockfish's [official NNUE documentation](https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md)
provides the sparse input, king-piece interaction, incremental accumulator and
training-only feature-factorization inspiration for the expanded table model.
Those architecture ideas are distinct from the LP solver.

## Verification

Run `python test/training/sparse-wsp.test.py`. Tests cover an independently known
unique LP solution, duality, bounded support, hard and soft preservation,
infeasibility, ranking slack, weight normalization, invalid inputs, rank-one
orientation, authenticated checkpoint loading, both H4/H8 widths, a known
head repair, actual forward parity and integer serialization/rounding.

No production runtime or historical frozen training contract is changed by
this module. Train/validation/test lineage remains the caller's responsibility.
