#!/usr/bin/env python3
"""Convex sparse residual fitting with fixed features and exact L1 penalties.

No nonlinear trunk, phase, target scale or feature routing is learned here.
Integer export and support selection are discrete steps outside the convex fit.
"""
from __future__ import annotations

from dataclasses import dataclass
import time
import numpy as np
from scipy import optimize, sparse
from scipy.special import expit

from tools.sparse_eval.features import BASE_FEATURES, N_FEATURES, FAMILIES

GRID = (
    {"id": "pst", "families": ["pst"], "l2": 1e-4, "l1": 0.0},
    {"id": "king", "families": ["pst", "own_king", "enemy_king"], "l2": 1e-4, "l1": 1e-5},
    {"id": "full", "families": list(FAMILIES), "l2": 1e-4, "l1": 1e-5},
    {"id": "full-ridge", "families": list(FAMILIES), "l2": 1e-3, "l1": 1e-5},
    {"id": "full-sparse", "families": list(FAMILIES), "l2": 1e-4, "l1": 1e-4},
)


def _vector(value, rows, name):
    result = np.asarray(value, dtype=np.float64)
    if result.shape != (rows,) or not np.all(np.isfinite(result)):
        raise ValueError(f"{name} must be a finite vector of length {rows}")
    return result


def regularization_vectors():
    cost = np.ones(N_FEATURES)
    bound = np.full(N_FEATURES, 128.0 / 400)
    for phase in (0, BASE_FEATURES):
        a, b = FAMILIES["pawn_context"]
        cost[a + phase:b + phase] = 2
        a, b = FAMILIES["ray"]
        cost[a + phase:b + phase] = 4
        bound[a + phase:b + phase] = 64.0 / 400
    return cost, bound


def allowed_columns(families):
    mask = np.zeros(N_FEATURES, dtype=bool)
    if not families or set(families) - FAMILIES.keys():
        raise ValueError("unknown or empty feature families")
    for family in families:
        lo, hi = FAMILIES[family]
        mask[lo:hi] = True
        mask[lo + BASE_FEATURES:hi + BASE_FEATURES] = True
    return mask


@dataclass
class FitResult:
    weights_cp: np.ndarray
    report: dict


def objective(beta, matrix, baseline_cp, targets, row_weight, l2):
    """Smooth convex part and its analytic gradient (beta in 400 CP units)."""
    logits = baseline_cp / 400 + matrix @ beta
    value = np.dot(row_weight, np.logaddexp(0, logits) - targets * logits)
    residual = row_weight * (expit(logits) - targets)
    grad = np.asarray(matrix.T @ residual).ravel() + l2 * beta
    return float(value + 0.5 * l2 * np.dot(beta, beta)), grad


def fit(matrix, baseline_cp, teacher_cp, *, families, l2, l1,
        sample_weight=None, min_support=32, max_iterations=400):
    # Keep the authenticated full matrix in compact storage. Convert only the
    # selected columns to float64 for solver accuracy; a full float64 copy plus
    # a second selected copy would unnecessarily triple corpus memory.
    matrix = sparse.csr_matrix(matrix, copy=False)
    if not matrix.has_canonical_format or np.any(matrix.data == 0):
        matrix = matrix.copy()
        matrix.sum_duplicates()
        matrix.eliminate_zeros()
    n, d = matrix.shape
    if not n or d != N_FEATURES or not np.all(np.isfinite(matrix.data)):
        raise ValueError("invalid sparse feature matrix")
    if not np.isfinite(l2) or l2 <= 0 or not np.isfinite(l1) or l1 < 0:
        raise ValueError("positive L2 and nonnegative L1 are required")
    if type(min_support) is not int or min_support < 1:
        raise ValueError("minimum support must be a positive integer")
    if type(max_iterations) is not int or max_iterations < 1:
        raise ValueError("iteration limit must be positive")
    baseline = _vector(baseline_cp, n, "baseline")
    target = expit(_vector(teacher_cp, n, "teacher") / 400)
    weight = np.ones(n) if sample_weight is None else _vector(sample_weight, n, "sample weight")
    if np.any(weight <= 0):
        raise ValueError("sample weights must be positive")
    weight = weight / weight.sum()
    coverage = np.bincount(matrix.indices, minlength=d)
    active = np.flatnonzero(allowed_columns(families) & (coverage >= min_support))
    if not len(active):
        raise ValueError("no supported feature columns")
    x = matrix[:, active].astype(np.float64)
    cost, bound = regularization_vectors()
    cost, bound = cost[active], bound[active]
    k = len(active)
    history = []
    start = time.monotonic()

    def loss(parts):
        beta = parts[:k] - parts[k:]
        value, grad = objective(beta, x, baseline, target, weight, l2)
        value += l1 * np.dot(cost, parts[:k] + parts[k:])
        return value, np.concatenate((grad + l1 * cost, -grad + l1 * cost))

    def record(parts):
        # Count iterations without another full sparse objective evaluation.
        history.append(time.monotonic() - start)

    result = optimize.minimize(
        loss, np.zeros(2 * k), jac=True, method="L-BFGS-B",
        bounds=optimize.Bounds(np.zeros(2 * k), np.tile(bound, 2)),
        callback=record,
        options={"maxiter": max_iterations, "maxls": 40, "ftol": 1e-11,
                 "gtol": 2e-6, "maxcor": 15},
    )
    parts = result.x
    value, gradient = loss(parts)
    upper = np.tile(bound, 2)
    projected = gradient.copy()
    projected[(parts <= 1e-9) & (gradient > 0)] = 0
    projected[(parts >= upper - 1e-9) & (gradient < 0)] = 0
    weights = np.zeros(d)
    weights[active] = 400 * (parts[:k] - parts[k:])
    integer = quantize(weights)
    report = {
        "schema": "chessy.sparse-convex-fit.v1", "researchOnly": True,
        "rows": n, "columns": d, "supportedColumns": k,
        "l1": float(l1), "l2": float(l2), "families": list(families),
        "iterations": int(result.nit), "evaluations": int(result.nfev),
        "solverSuccess": bool(result.success), "solverMessage": str(result.message),
        "objective": float(value), "projectedGradientInfinityNorm": float(np.max(np.abs(projected))),
        "numericallyConverged": bool(result.success and np.max(np.abs(projected)) <= 1e-5),
        "seconds": time.monotonic() - start,
        "nonzeroFloat": int(np.count_nonzero(np.abs(weights) > 1e-8)),
        "nonzeroInteger": int(np.count_nonzero(integer)),
        "maxAbsCp": float(np.max(np.abs(weights))),
        "integerParameterBytes": int(integer.nbytes),
        "familyNonzeroInteger": {name: int(np.count_nonzero(integer[a:b]) +
                                              np.count_nonzero(integer[a+BASE_FEATURES:b+BASE_FEATURES]))
                                 for name, (a, b) in FAMILIES.items()},
        "noGlobalIntegerOptimalityClaim": True,
    }
    return FitResult(weights, report)


def quantize(weights):
    weights = np.asarray(weights, dtype=np.float64)
    if weights.shape != (N_FEATURES,) or not np.all(np.isfinite(weights)):
        raise ValueError("invalid weights")
    rounded = np.sign(weights) * np.floor(np.abs(weights) + 0.5)
    if np.any(np.abs(rounded) > 32767):
        raise ValueError("int16 saturation")
    return rounded.astype("<i2")


def predict(matrix, baseline, weights, *, integer=True):
    correction = np.asarray(matrix @ np.asarray(weights, dtype=np.float64)).ravel()
    if integer:
        # Taper fractions have denominator 24; absorb floating point error at
        # exact half ties while matching the native symmetric integer rule.
        numerator = np.rint(correction * 24)
        correction = np.sign(numerator) * np.floor((np.abs(numerator) + 12) / 24)
    return np.asarray(baseline) + correction


def metrics(predictions, teacher, phase):
    prediction = np.asarray(predictions, dtype=np.float64)
    teacher = _vector(teacher, len(prediction), "teacher")
    phase = np.asarray(phase)
    if phase.shape != prediction.shape:
        raise ValueError("phase mismatch")
    target = expit(teacher / 400)
    logits = prediction / 400
    error = prediction - teacher
    loss = np.logaddexp(0, logits) - target * logits

    def one(mask):
        if not np.any(mask):
            return {"rows": 0}
        e = error[mask]
        return {"rows": int(np.sum(mask)), "ce": float(np.mean(loss[mask])),
                "maeCp": float(np.mean(np.abs(e))), "rmseCp": float(np.sqrt(np.mean(e**2))),
                "p95AbsCp": float(np.quantile(np.abs(e), .95)),
                "p99AbsCp": float(np.quantile(np.abs(e), .99)),
                "signAccuracy": float(np.mean(np.sign(prediction[mask]) == np.sign(teacher[mask])))}

    return {"overall": one(np.ones(len(prediction), dtype=bool)),
            "opening": one(phase >= 18), "middlegame": one((phase >= 7) & (phase < 18)),
            "endgame": one(phase < 7)}


def eligible(candidate, baseline, *, converged):
    if not converged or candidate["overall"]["ce"] > baseline["overall"]["ce"] * .995:
        return False
    for metric in ("maeCp", "rmseCp"):
        if candidate["overall"][metric] > baseline["overall"][metric] * 1.02:
            return False
    for phase in ("opening", "middlegame", "endgame"):
        if candidate[phase]["rows"] == 0 or candidate[phase]["ce"] > baseline[phase]["ce"] * 1.01:
            return False
    return True
