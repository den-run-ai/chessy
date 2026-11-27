"""Bounded sparse weight edits on a fixed, explicitly supplied feature map.

The LP is exact for linear table coefficients and frozen NNUE output heads.
It makes no convexity claim for changing NNUE hidden weights, quantization,
support selection, search or playing strength. No implicit bias is added.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
from pathlib import Path
import sys

import numpy as np
from scipy import sparse
from scipy.optimize import linprog


def _matrix(value, name, *, columns=None, nonempty=False):
    if sparse.issparse(value):
        result = sparse.csr_matrix(value, dtype=np.float64, copy=True)
    else:
        array = np.asarray(value, dtype=np.float64)
        if array.ndim != 2:
            raise ValueError(f"{name} must be a matrix")
        result = sparse.csr_matrix(array)
    result.sum_duplicates()
    result.eliminate_zeros()
    result.sort_indices()
    if (result.ndim != 2 or not np.all(np.isfinite(result.data))
            or (columns is not None and result.shape[1] != columns)
            or (nonempty and (not result.shape[0] or not result.shape[1]))):
        raise ValueError(f"{name} has invalid shape or nonfinite values")
    return result


def _vector(value, size, name, *, scalar=False, minimum=None, strict=False):
    result = np.asarray(value, dtype=np.float64)
    if scalar and result.ndim == 0:
        if not np.isfinite(result):
            raise ValueError(f"{name} must be finite")
        result = np.full(size, float(result))
    if result.shape != (size,) or not np.all(np.isfinite(result)):
        raise ValueError(f"{name} must be a finite vector of length {size}")
    if minimum is not None and np.any(result <= minimum if strict else result < minimum):
        raise ValueError(f"{name} has values outside its permitted range")
    return result.copy()


def _scalar(value, name, *, minimum=0, strict=False):
    result = np.asarray(value)
    if result.ndim != 0 or result.dtype.kind == "b":
        raise ValueError(f"{name} must be a finite scalar")
    result = float(result)
    if not np.isfinite(result) or (result <= minimum if strict else result < minimum):
        raise ValueError(f"{name} is outside its permitted range")
    return result


def _support(value, columns):
    if value is None:
        return np.arange(columns, dtype=np.int64)
    raw = np.asarray(value)
    if (raw.ndim != 1 or raw.dtype.kind not in "iu" or np.any(raw < 0)
            or np.any(raw >= columns) or len(np.unique(raw)) != len(raw)):
        raise ValueError("support must contain distinct integer column indices")
    return raw.astype(np.int64, copy=True)


def select_support(X_train, weights, *, budget=128):
    """Rank |weight| times TRAIN-only feature RMS; selection is not convex.

    Ties use feature index and unseen/zero-effect entries are excluded. The
    caller owns data lineage; this helper must never receive a test matrix.
    """
    X = _matrix(X_train, "X_train", nonempty=True)
    weights = _vector(weights, X.shape[1], "weights")
    if type(budget) is not int or budget < 1:
        raise ValueError("budget must be a positive integer")
    with np.errstate(over="ignore", invalid="ignore"):
        rms = np.sqrt(np.asarray(X.power(2).mean(axis=0)).ravel())
        effect = np.abs(weights) * rms
    if not np.all(np.isfinite(effect)):
        raise ValueError("support ranking overflow")
    eligible = np.flatnonzero(effect > 0)
    order = np.lexsort((eligible, -effect[eligible]))
    return eligible[order[:budget]].astype(np.int64)


@dataclass(frozen=True)
class EditResult:
    # Failed/incomplete/infeasible solves never expose an applicable edit.
    delta: np.ndarray | None
    report: dict


def solve_sparse_edit(X, baseline_cp, target_cp, *, support=None, l1=0.01,
                      max_abs_delta=50.0, sample_weight=None, feature_cost=1.0,
                      preserve_X=None, preserve_epsilon=0.0, preserve_penalty=None,
                      margin_X=None, minimum_gain=None, margin_penalty=None,
                      time_limit=60.0):
    """Minimize weighted mean absolute residual plus weighted L1 edit cost.

    The fitted correction is X @ delta, added to the supplied baseline.
    Every coefficient is box bounded, including any caller-supplied bias.
    preserve_X enforces |preserve_X @ delta| <= preserve_epsilon; margin_X
    enforces margin_X @ delta >= minimum_gain (e.g. good-minus-bad features).
    These are hard constraints unless their explicit positive penalty is set.
    Soft penalties multiply the SUM of slacks, not their mean. A frozen
    support is solved exactly; selecting it beforehand is a separate step.
    """
    X = _matrix(X, "X", nonempty=True)
    rows, columns = X.shape
    base = _vector(baseline_cp, rows, "baseline_cp")
    target = _vector(target_cp, rows, "target_cp")
    residual = target - base
    if not np.all(np.isfinite(residual)):
        raise ValueError("target minus baseline overflow")
    chosen = _support(support, columns)
    k = len(chosen)
    limit = _vector(max_abs_delta, columns, "max_abs_delta", scalar=True, minimum=0)[chosen]
    cost = _vector(feature_cost, columns, "feature_cost", scalar=True, minimum=0, strict=True)[chosen]
    l1 = _scalar(l1, "l1")
    time_limit = _scalar(time_limit, "time_limit", strict=True)
    weight = (np.ones(rows) if sample_weight is None else
              _vector(sample_weight, rows, "sample_weight", minimum=0, strict=True))
    # Normalize without overflow on finite, unusually large supplied weights.
    weight = weight / np.max(weight)
    weight = weight / weight.sum()
    if np.any(weight == 0):
        raise ValueError("sample weights underflow during normalization")
    P = (_matrix(preserve_X, "preserve_X", columns=columns) if preserve_X is not None
         else sparse.csr_matrix((0, columns)))
    M = (_matrix(margin_X, "margin_X", columns=columns) if margin_X is not None
         else sparse.csr_matrix((0, columns)))
    m, r = P.shape[0], M.shape[0]
    eps = _vector(preserve_epsilon, m, "preserve_epsilon", scalar=True, minimum=0)
    if margin_X is None and minimum_gain is not None:
        raise ValueError("minimum_gain requires margin_X")
    if margin_X is not None and minimum_gain is None:
        raise ValueError("margin_X requires minimum_gain")
    gain = _vector(0.0 if minimum_gain is None else minimum_gain, r, "minimum_gain", scalar=True)
    if preserve_penalty is not None:
        if preserve_X is None:
            raise ValueError("preserve_penalty requires preserve_X")
        preserve_penalty = _scalar(preserve_penalty, "preserve_penalty", strict=True)
    if margin_penalty is not None:
        if margin_X is None:
            raise ValueError("margin_penalty requires margin_X")
        margin_penalty = _scalar(margin_penalty, "margin_penalty", strict=True)
    npreserve = m if preserve_penalty is not None else 0
    nmargin = r if margin_penalty is not None else 0
    # Variables: delta[k], absolute fit errors[rows], |delta|[k], optional slacks.
    nvars = 2*k + rows + npreserve + nmargin
    zero = lambda n, c: sparse.csr_matrix((n, c))
    I = sparse.eye(k, format="csr")
    errors = sparse.eye(rows, format="csr")
    A = X[:, chosen]
    P = P[:, chosen]
    M = M[:, chosen]
    tail = npreserve + nmargin
    blocks = [sparse.hstack((A, -errors, zero(rows, k+tail))),
              sparse.hstack((-A, -errors, zero(rows, k+tail))),
              sparse.hstack((I, zero(k, rows), -I, zero(k, tail))),
              sparse.hstack((-I, zero(k, rows), -I, zero(k, tail)))]
    rhs = [residual, -residual, np.zeros(k), np.zeros(k)]
    if m:
        slack = -sparse.eye(m, format="csr") if npreserve else zero(m, 0)
        for sign in (1, -1):
            blocks.append(sparse.hstack((sign*P, zero(m, rows+k), slack, zero(m, nmargin))))
            rhs.append(eps)
    if r:
        slack = -sparse.eye(r, format="csr") if nmargin else zero(r, 0)
        blocks.append(sparse.hstack((-M, zero(r, rows+k+npreserve), slack)))
        rhs.append(-gain)
    Aub = sparse.vstack(blocks, format="csr")
    bub = np.concatenate(rhs)
    objective = np.concatenate((np.zeros(k), weight, l1*cost,
                                np.full(npreserve, preserve_penalty or 0),
                                np.full(nmargin, margin_penalty or 0)))
    if objective.shape != (nvars,) or not np.all(np.isfinite(objective)):
        raise ValueError("invalid or overflowing objective")
    bounds = [(-float(v), float(v)) for v in limit] + [(0, None)]*(nvars-k)
    solved = linprog(objective, A_ub=Aub, b_ub=bub, bounds=bounds, method="highs",
                     options={"time_limit": time_limit, "primal_feasibility_tolerance": 1e-8,
                              "dual_feasibility_tolerance": 1e-8})
    report = {"schema": "chessy.sparse-linear-edit.v1", "success": False,
              "status": int(solved.status), "message": str(solved.message),
              "solver": "scipy.optimize.linprog/highs", "rows": rows,
              "features": columns, "supportSize": k, "preservationRows": m,
              "marginRows": r, "preservationIsSoft": preserve_penalty is not None,
              "marginIsSoft": margin_penalty is not None, "implicitBias": False,
              "l1": l1, "supportSelectionIsConvex": False,
              "fixedFeatureOptimizationIsConvex": True,
              "productionEligible": False, "playingStrengthMeasured": False}
    if not solved.success or solved.x is None or not np.all(np.isfinite(solved.x)):
        return EditResult(None, report)
    z = solved.x
    violation = float(max(0, np.max(Aub @ z - bub, initial=0),
                          np.max(np.abs(z[:k])-limit, initial=0),
                          np.max(-z[k:], initial=0)))
    report["maximumPrimalViolation"] = violation
    if violation > 1e-6:
        report["message"] = "solver result failed independent primal-feasibility check"
        return EditResult(None, report)
    delta = np.zeros(columns)
    delta[chosen] = z[:k]
    changed = np.asarray(A @ z[:k]).ravel()
    pchange = np.abs(np.asarray(P @ z[:k]).ravel())
    mgain = np.asarray(M @ z[:k]).ravel()
    pslack = z[2*k+rows:2*k+rows+npreserve]
    mslack = z[2*k+rows+npreserve:]
    # HiGHS marginals give a separately reconstructed dual objective.
    dual = float(np.dot(bub, solved.ineqlin.marginals))
    dual += float(np.dot(-limit, solved.lower.marginals[:k]))
    dual += float(np.dot(limit, solved.upper.marginals[:k]))
    primal = float(np.dot(objective, z))
    report.update(success=True, objective=primal, dualObjective=dual,
                  absoluteDualityGap=abs(primal-dual),
                  nonzeroDelta=int(np.count_nonzero(delta)),
                  l1Delta=float(np.abs(delta).sum()),
                  baselineWeightedMaeCp=float(np.dot(weight, np.abs(residual))),
                  editedWeightedMaeCp=float(np.dot(weight, np.abs(changed-residual))),
                  maximumPreservationChangeCp=float(np.max(pchange, initial=0)),
                  maximumPreservationExcessCp=float(np.max(pchange-eps, initial=0)),
                  maximumMarginShortfallCp=float(np.max(gain-mgain, initial=0)),
                  preservationSlackSum=float(pslack.sum()), marginSlackSum=float(mslack.sum()))
    delta.setflags(write=False)
    return EditResult(delta, report)


def apply_rank_one_edit(weights, direction, coefficients):
    """Apply W + u v.T with explicitly FIXED u; no normalization or hidden bias."""
    W = np.asarray(weights, dtype=np.float64)
    if W.ndim != 2 or not np.all(np.isfinite(W)):
        raise ValueError("weights must be a finite matrix")
    u = _vector(direction, W.shape[0], "direction")
    v = _vector(coefficients, W.shape[1], "coefficients")
    if not np.any(u):
        raise ValueError("direction must be nonzero")
    with np.errstate(over="ignore", invalid="ignore"):
        edited = W + np.outer(u, v)
    if not np.all(np.isfinite(edited)):
        raise ValueError("rank-one edit overflow")
    return edited


def _h4_backend():
    # Existing research modules use sibling imports, not a Python package.
    directory = str(Path(__file__).resolve().parents[1] / "training")
    sys.path.insert(0, directory)
    try:
        return importlib.import_module("h4_v3_model")
    finally:
        sys.path.remove(directory)


@dataclass(frozen=True)
class FrozenH4V3Head:
    """Exact floating head edit for Chessy's existing H4/H8 MG/EG CReLU model.

    The trunk is immutable. Head order is MG weights, EG weights, MG bias,
    EG bias, exactly matching h4_v3_model. Returned features are White-POV CP.
    Quantized inference rounds once and is audited separately, never called LP.
    """
    params: np.ndarray
    hidden: int = 4

    def __post_init__(self):
        m = _h4_backend()
        params = np.asarray(self.params, dtype=np.float64).copy()
        m.unpack(params, self.hidden)
        if not np.array_equal(params, m.project(params, self.hidden)):
            # Valid integer checkpoints may decode to 31130/16384, just above
            # the float projection limit 1.9. Admit only exact valid grids in
            # that case; never clip or silently change the retained trunk.
            w, b, o, ob = m.unpack(params, self.hidden)
            q = m.QuantizedModel(np.rint(w*m.Q1), np.rint(b*m.Q1),
                                np.rint(o*m.Q2), np.rint(ob*m.Q1*m.Q2))
            decoded = np.concatenate((q.input_weights.ravel()/m.Q1, q.input_bias/m.Q1,
                                      q.output_weights.ravel()/m.Q2, q.output_bias/(m.Q1*m.Q2)))
            if not np.array_equal(params, decoded):
                raise ValueError("checkpoint is outside existing quantization bounds")
        params.setflags(write=False)
        object.__setattr__(self, "params", params)

    @classmethod
    def from_float_json(cls, path, *, expected_sha256, hidden=4):
        if (not isinstance(expected_sha256, str) or len(expected_sha256) != 64
                or any(c not in "0123456789abcdef" for c in expected_sha256)):
            raise ValueError("a lowercase SHA-256 for the frozen checkpoint is required")
        # Authenticate and parse the same retained bytes, not a reopened path.
        payload = Path(path).read_bytes()
        if hashlib.sha256(payload).hexdigest() != expected_sha256:
            raise ValueError("checkpoint SHA-256 mismatch")
        return cls(np.asarray(json.loads(payload), dtype=np.float64), hidden)

    @classmethod
    def from_quantized_bytes(cls, payload, *, hidden=4, metadata=None):
        m = _h4_backend()
        q = m.QuantizedModel.from_bytes(bytes(payload), hidden=hidden, metadata=metadata)
        params = np.concatenate((q.input_weights.ravel()/m.Q1, q.input_bias/m.Q1,
                                 q.output_weights.ravel()/m.Q2, q.output_bias/(m.Q1*m.Q2)))
        return cls(params, hidden)

    @property
    def head(self):
        return self.params[769*self.hidden:].copy()

    def design(self, white, black, turn, *, phase_units):
        m = _h4_backend()
        _, ordered, _, _, _, turn, mix = m._forward(
            self.params, white, black, turn, phase_units, self.hidden, False)
        signed_mix = mix * (turn*m.CP_SCALE)[:, None]
        result = np.concatenate((ordered*signed_mix[:, :1],
                                 ordered*signed_mix[:, 1:], signed_mix), axis=1)
        return _matrix(result, "frozen head design")

    def predict_cp(self, white, black, turn, *, phase_units, baseline_cp):
        return _h4_backend().predict_cp(self.params, white, black, turn,
            phase_units=phase_units, hidden=self.hidden, baseline_cp=baseline_cp)

    def apply(self, delta):
        delta = _vector(delta, 4*self.hidden+2, "head delta")
        params = self.params.copy()
        params[769*self.hidden:] += delta
        return FrozenH4V3Head(params, self.hidden)

    def quantized(self):
        m = _h4_backend()
        w, b, o, ob = m.unpack(self.params, self.hidden)
        return m.QuantizedModel(np.rint(w*m.Q1), np.rint(b*m.Q1),
                               np.rint(o*m.Q2), np.rint(ob*m.Q1*m.Q2))

    def audit_edit(self, delta, white, black, turn, *, phase_units, baseline_cp):
        """Re-run edited forward and quantized inference against affine values."""
        edited = self.apply(delta)
        X = self.design(white, black, turn, phase_units=phase_units)
        base = self.predict_cp(white, black, turn, phase_units=phase_units, baseline_cp=baseline_cp)
        if not len(base):
            raise ValueError("head audit requires nonempty independent examples")
        affine = base + X @ delta
        forward = edited.predict_cp(white, black, turn, phase_units=phase_units, baseline_cp=baseline_cp)
        q = edited.quantized()
        qm = FrozenH4V3Head.from_quantized_bytes(q.to_bytes(), hidden=self.hidden, metadata=q.metadata())
        before_round = qm.predict_cp(white, black, turn, phase_units=phase_units, baseline_cp=baseline_cp)
        integer = q.predict_cp(white, black, turn, phase_units=phase_units, baseline_cp=baseline_cp)
        affine_error = float(np.max(np.abs(affine-forward), initial=0))
        rounding_error = float(np.max(np.abs(before_round-integer), initial=0))
        return {"rows": len(base), "headOnly": True,
                "frozenTrunkEqual": bool(np.array_equal(self.params[:769*self.hidden],
                                                        edited.params[:769*self.hidden])),
                "maximumAffineErrorCp": affine_error,
                "maximumIntegerRoundingErrorCp": rounding_error,
                "maximumTotalQuantizationErrorCp": float(np.max(np.abs(forward-integer), initial=0)),
                "affineParity": affine_error <= 1e-9,
                "roundingParity": rounding_error <= 0.50000001,
                "quantizationIsConvex": False,
                "quantizedConstraintsRequireRecheck": True,
                "modelBytes": len(q.to_bytes())}
