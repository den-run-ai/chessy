"""Bounded H4/H8 research model; optional residual over the frozen shipped HCE.

This is a new numerical contract. The original H4 implementation is unchanged.
Both training and the integer boundary return White-POV scores. Integer residual
inference adds the external, already-rounded baseline after rounding the net.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.special import expit

from h4_model import features_from_fens

N_INPUTS, Q1, Q2, CP_SCALE, MAX_PIECES = 768, 16384, 4096, 400, 32
SCHEMA = "chessy-h4-v2-quantized-v1"
BASELINES = ("none", "shipped-hce")


def parameter_count(hidden=4):
    if type(hidden) is not int or hidden not in (4, 8):
        raise ValueError("hidden width must be 4 or 8")
    return 771 * hidden + 1


def parameter_bytes(hidden=4):
    parameter_count(hidden)
    return 1544 * hidden + 4


def unpack(params, hidden=4):
    params = np.asarray(params, dtype=np.float64)
    if params.shape != (parameter_count(hidden),) or not np.all(np.isfinite(params)):
        raise ValueError("incorrect parameter shape or nonfinite parameters")
    cut = N_INPUTS * hidden
    return params[:cut].reshape(N_INPUTS, hidden), params[cut:cut + hidden], params[cut + hidden:-1], params[-1]


def initialize(seed, hidden=4, residual=False):
    parameter_count(hidden)
    rng = np.random.default_rng(seed)
    first = rng.normal(0.0, 0.04, N_INPUTS * hidden)
    output = np.zeros(2 * hidden) if residual else rng.normal(0.0, 0.1, 2 * hidden)
    return np.concatenate((first, np.full(hidden, 0.25), output, [0.0]))


def anchor(params, hidden=4):
    """Anchor first-layer weights/bias to initialization; output weights to zero."""
    unpack(params, hidden)
    result = np.asarray(params, dtype=np.float64).copy()
    result[N_INPUTS * hidden + hidden:] = 0
    return result


def project(params, hidden=4):
    """Return a copy projected to the preregistered, quantization-safe box."""
    unpack(params, hidden)
    result = np.asarray(params, dtype=np.float64).copy()
    cut = N_INPUTS * hidden + hidden
    result[:cut] = np.clip(result[:cut], -1.9, 1.9)
    result[cut:-1] = np.clip(result[cut:-1], -4, 4)
    result[-1] = np.clip(result[-1], -2, 2)
    return result


def _inputs(white, black, turn, integer=False):
    if not sparse.isspmatrix_csr(white) or not sparse.isspmatrix_csr(black):
        raise ValueError("inputs must be CSR matrices")
    if white.shape != black.shape or white.shape[1] != N_INPUTS:
        raise ValueError("input shape differs")
    turn = np.asarray(turn)
    if turn.shape != (white.shape[0],) or not np.all((turn == 1) | (turn == -1)):
        raise ValueError("turn must contain +1 or -1")
    for matrix in (white, black):
        if (not matrix.has_canonical_format or not np.all(matrix.data == 1)
                or np.any(np.diff(matrix.indptr) > MAX_PIECES)):
            raise ValueError("canonical binary inputs with at most 32 pieces required")
    return turn.astype(np.int64 if integer else np.float64)


def _baseline(baseline_cp, rows, integer=False):
    if baseline_cp is None:
        return np.zeros(rows, dtype=np.int64 if integer else np.float64)
    value = np.asarray(baseline_cp)
    if (value.shape != (rows,) or not np.all(np.isfinite(value)) or np.any(np.abs(value) > 10000)
            or (integer and np.any(value != np.rint(value)))):
        raise ValueError("baseline must be finite White scores within 10000 cp, integer for inference")
    return value.astype(np.int64 if integer else np.float64)


def _effective(params, hidden, fake_quant):
    weights, bias, output, output_bias = unpack(params, hidden)
    if fake_quant:
        if not np.array_equal(np.asarray(params), project(params, hidden)):
            raise ValueError("fake quantization requires projected parameters")
        weights, bias = np.rint(weights * Q1) / Q1, np.rint(bias * Q1) / Q1
        output = np.rint(output * Q2) / Q2
        output_bias = np.rint(output_bias * Q1 * Q2) / (Q1 * Q2)
    return weights, bias, output, output_bias


def _forward(params, white, black, turn, hidden, baseline_cp, fake_quant):
    turn = _inputs(white, black, turn)
    weights, bias, output, output_bias = _effective(params, hidden, fake_quant)
    pre_white, pre_black = white @ weights + bias, black @ weights + bias
    a_white, a_black = np.clip(pre_white, 0, 1), np.clip(pre_black, 0, 1)
    white_moves = turn[:, None] == 1
    ordered = np.concatenate((np.where(white_moves, a_white, a_black),
                              np.where(white_moves, a_black, a_white)), axis=1)
    net_white = (ordered @ output + output_bias) * turn
    raw_white = net_white + _baseline(baseline_cp, len(turn)) / CP_SCALE
    return raw_white, ordered, pre_white, pre_black, output, turn


def predict_cp(params, white, black, turn, *, hidden=4, baseline_cp=None, fake_quant=False):
    # Add in cp space so a zero residual preserves every integer baseline
    # exactly, including integers which do not survive cp/400*400 bit-for-bit.
    net = CP_SCALE * _forward(params, white, black, turn, hidden, None, fake_quant)[0]
    return net + _baseline(baseline_cp, len(net))


def activation_diagnostics(params, white, black, turn, hidden=4, fake_quant=False):
    _inputs(white, black, turn)
    weights, bias, _, _ = _effective(params, hidden, fake_quant)
    pre = np.concatenate((white @ weights + bias, black @ weights + bias), axis=0)
    if not len(pre):
        raise ValueError("activation diagnostics require at least one row")
    return {
        "rows": int(white.shape[0]), "perspectivesPooled": 2,
        "zeroActivationFraction": (pre <= 0).mean(axis=0).tolist(),
        "upperSaturationFraction": (pre >= 1).mean(axis=0).tolist(),
        "interiorFraction": ((pre > 0) & (pre < 1)).mean(axis=0).tolist(),
    }


def loss_and_grad(params, white, black, turn, targets, *, hidden=4, baseline_cp=None,
                  l2=0.0, anchor_params=None, fake_quant=False):
    """Return objective, analytic/STE gradient and independently named diagnostics.

    Objective = mean BCE(predicted_cp_white / 100, teacher.targetWhite)
                + 0.5 * l2 * SUM((params - anchor_params)**2).
    Fake quantization uses identity derivatives through parameter rounding and
    the usual strict-interior CReLU derivative. Final cp rounding is omitted
    during training and applied only by integer inference.
    """
    raw, ordered, pre_w, pre_b, output, turn = _forward(
        params, white, black, turn, hidden, baseline_cp, fake_quant)
    target = np.asarray(targets, dtype=np.float64)
    if (target.shape != raw.shape or not len(target) or not np.all(np.isfinite(target))
            or np.any((target < 0) | (target > 1))):
        raise ValueError("targets must be a nonempty finite vector in [0,1]")
    if not np.isfinite(l2) or l2 < 0:
        raise ValueError("l2 must be finite and nonnegative")
    if anchor_params is None:
        if l2:
            raise ValueError("an explicit initialization anchor is required for regularization")
        anchor_params = np.zeros(parameter_count(hidden))
    unpack(anchor_params, hidden)
    logits = 4 * raw
    data_ce = float(np.mean(np.logaddexp(0, logits) - target * logits))
    d_stm = (expit(logits) - target) * (4 / len(target)) * turn
    d_first = d_stm[:, None] * output[:hidden]
    d_second = d_stm[:, None] * output[hidden:]
    white_moves = turn[:, None] == 1
    dw = np.where(white_moves, d_first, d_second) * ((pre_w > 0) & (pre_w < 1))
    db = np.where(white_moves, d_second, d_first) * ((pre_b > 0) & (pre_b < 1))
    data_gradient = np.concatenate((np.asarray(white.T @ dw + black.T @ db).ravel(),
                                    (dw + db).sum(axis=0), ordered.T @ d_stm, [d_stm.sum()]))
    displacement = np.asarray(params, dtype=np.float64) - np.asarray(anchor_params)
    regularizer = float(0.5 * l2 * np.dot(displacement, displacement))
    reg_gradient = l2 * displacement
    gradient = data_gradient + reg_gradient
    diagnostics = {
        "dataCE": data_ce, "regularizer": regularizer,
        "dataGradientL2": float(np.linalg.norm(data_gradient)),
        "regularizerGradientL2": float(np.linalg.norm(reg_gradient)),
        "gradientL2": float(np.linalg.norm(gradient)),
        "gradientMaxAbs": float(np.max(np.abs(gradient))),
        "fakeQuantization": bool(fake_quant),
    }
    return data_ce + regularizer, gradient, diagnostics


def _integer_array(value, dtype, shape, maximum, name):
    value = np.asarray(value)
    if (value.shape != shape or not np.all(np.isfinite(value)) or np.any(value != np.rint(value))
            or np.any(np.abs(value.astype(np.float64)) > maximum)):
        raise ValueError("invalid or out-of-contract " + name)
    result = value.astype(dtype, copy=True)
    result.setflags(write=False)
    return result


@dataclass(frozen=True)
class QuantizedModel:
    input_weights: np.ndarray
    input_bias: np.ndarray
    output_weights: np.ndarray
    output_bias: int
    baseline_id: str = "none"

    def __post_init__(self):
        candidate = np.asarray(self.input_weights)
        if candidate.ndim != 2 or candidate.shape[0] != N_INPUTS:
            raise ValueError("invalid first-layer shape")
        hidden = candidate.shape[1]
        parameter_count(hidden)
        if self.baseline_id not in BASELINES:
            raise ValueError("unknown frozen baseline identifier")
        for name, dtype, shape, bound in (
            ("input_weights", np.int16, (N_INPUTS, hidden), 31130),
            ("input_bias", np.int32, (hidden,), 31130),
            ("output_weights", np.int16, (2 * hidden,), 16384),
            ("output_bias", np.int32, (), 134217728),
        ):
            result = _integer_array(getattr(self, name), dtype, shape, bound, name)
            object.__setattr__(self, name, int(result) if name == "output_bias" else result)
        largest = np.sort(np.abs(self.input_weights.astype(np.int64)), axis=0)[-MAX_PIECES:]
        if np.any(largest.sum(axis=0) + np.abs(self.input_bias.astype(np.int64)) > np.iinfo(np.int32).max):
            raise ValueError("theoretical int32 accumulator overflow")
        bound = Q1 * sum(abs(int(v)) for v in self.output_weights) + abs(self.output_bias)
        if bound * CP_SCALE + Q1 * Q2 // 2 > np.iinfo(np.int64).max:
            raise ValueError("theoretical int64 output overflow")

    @property
    def hidden(self):
        return self.input_weights.shape[1]

    def metadata(self):
        h = self.hidden
        return {
            "schema": SCHEMA, "researchOnly": True, "inputs": N_INPUTS, "hidden": h,
            "parameters": parameter_count(h), "parameterBytes": parameter_bytes(h),
            "q1": Q1, "q2": Q2, "cpScale": CP_SCALE, "maximumPieces": MAX_PIECES,
            "layout": f"W1[768,{h}]:i16,b1[{h}]:i32,W2[{2*h}]:i16,b2[1]:i32;little-endian",
            "featureOrder": "PNBRQKpnbrqk; a8=0; black: color-swap,square^56",
            "outputOrder": f"side-to-move[{h}],other[{h}]",
            "weightRounding": "nearest-ties-to-even",
            "scoreRounding": "floor((numerator*400+denominator/2)/denominator);white-sign-after-stm-round",
            "activation": "clamp(sum(W1)+b1,0,16384)",
            "mode": "net-only" if self.baseline_id == "none" else "residual-shipped-hce",
            "fixedBaseline": self.baseline_id, "maximumAbsScoreCp": 10000,
        }

    def to_bytes(self):
        result = b"".join((self.input_weights.astype("<i2").tobytes(),
                            self.input_bias.astype("<i4").tobytes(),
                            self.output_weights.astype("<i2").tobytes(),
                            np.asarray(self.output_bias, dtype="<i4").tobytes()))
        assert len(result) == parameter_bytes(self.hidden)
        return result

    @classmethod
    def from_bytes(cls, payload, *, hidden=4, baseline_id="none", metadata=None):
        if len(payload) != parameter_bytes(hidden):
            raise ValueError("incorrect parameter binary length")
        cut = N_INPUTS * hidden * 2
        result = cls(np.frombuffer(payload, dtype="<i2", count=N_INPUTS*hidden).reshape(N_INPUTS, hidden),
                     np.frombuffer(payload, dtype="<i4", count=hidden, offset=cut),
                     np.frombuffer(payload, dtype="<i2", count=2*hidden, offset=cut+4*hidden),
                     int(np.frombuffer(payload, dtype="<i4", count=1, offset=len(payload)-4)[0]), baseline_id)
        if metadata is not None:
            expected = result.metadata()
            if (type(metadata) is not dict or metadata.keys() != expected.keys()
                    or any(type(metadata[k]) is not type(v) or metadata[k] != v for k, v in expected.items())):
                raise ValueError("metadata differs from the complete numerical contract")
        return result

    def predict_cp(self, white, black, turn, *, baseline_cp=None):
        turn = _inputs(white, black, turn, integer=True)
        if (self.baseline_id == "none") != (baseline_cp is None):
            raise ValueError("baseline presence differs from frozen model mode")
        base = _baseline(baseline_cp, len(turn), integer=True)
        weights = self.input_weights.astype(np.int64)
        w = np.clip(white.astype(np.int64) @ weights + self.input_bias, 0, Q1)
        b = np.clip(black.astype(np.int64) @ weights + self.input_bias, 0, Q1)
        white_moves = turn[:, None] == 1
        first, second = np.where(white_moves, w, b), np.where(white_moves, b, w)
        numerator = first @ self.output_weights[:self.hidden].astype(np.int64)
        numerator += second @ self.output_weights[self.hidden:].astype(np.int64) + self.output_bias
        denominator = Q1 * Q2
        rounded_stm = (numerator * CP_SCALE + denominator // 2) // denominator
        return rounded_stm * turn + base


def quantize(params, hidden=4, baseline_id="none"):
    if not np.array_equal(np.asarray(params), project(params, hidden)):
        raise ValueError("parameters outside registered projection bounds")
    weights, bias, output, output_bias = unpack(params, hidden)
    return QuantizedModel(np.rint(weights * Q1), np.rint(bias * Q1),
                          np.rint(output * Q2), np.rint(output_bias * Q1 * Q2), baseline_id)
