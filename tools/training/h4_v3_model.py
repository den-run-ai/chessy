"""Separately registered shared-trunk MG/EG residual; never an engine default.

The numerical phase is computed from board material, independent of the data's
coarse phase labels. The heads are tapered before one signed integer rounding.
"""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from scipy.special import expit
import h4_v2_model as v2
from h4_model import features_from_fens

N_INPUTS, Q1, Q2, CP_SCALE, MAX_PIECES = 768, 16384, 4096, 400, 32
SCHEMA = "chessy-h4-v3-quantized-v1"


def parameter_count(hidden=4):
    if type(hidden) is not int or hidden not in (4, 8):
        raise ValueError("hidden width must be 4 or 8")
    return 773 * hidden + 2


def parameter_bytes(hidden=4):
    parameter_count(hidden)
    return 1548 * hidden + 8


def phase_from_fens(fens):
    # Validate all FENs with the existing independent feature decoder first.
    white, _, _ = features_from_fens(fens)
    weights = np.repeat(np.asarray([0, 1, 1, 2, 4, 0] * 2), 64)
    return np.minimum(24, np.asarray(white @ weights).ravel()).astype(np.int64)


def _phase(phase_units, rows):
    value = np.asarray(phase_units)
    if (value.shape != (rows,) or not np.all(np.isfinite(value))
            or np.any(value != np.rint(value)) or np.any((value < 0) | (value > 24))):
        raise ValueError("phase units must be integer material phase in [0,24]")
    return value.astype(np.int64)


def unpack(params, hidden=4):
    params = np.asarray(params, dtype=np.float64)
    if params.shape != (parameter_count(hidden),) or not np.all(np.isfinite(params)):
        raise ValueError("incorrect parameter shape or nonfinite parameters")
    cut = N_INPUTS * hidden
    return (params[:cut].reshape(N_INPUTS, hidden), params[cut:cut+hidden],
            params[cut+hidden:-2].reshape(2, 2*hidden), params[-2:])


def initialize(seed, hidden=4, residual=True):
    if not residual:
        raise ValueError("v3 requires a frozen shipped-HCE residual")
    parameter_count(hidden)
    rng = np.random.default_rng(seed)
    return np.concatenate((rng.normal(0, .04, N_INPUTS*hidden), np.full(hidden, .25), np.zeros(4*hidden+2)))


def anchor(params, hidden=4):
    unpack(params, hidden)
    result = np.asarray(params, dtype=np.float64).copy()
    result[N_INPUTS*hidden+hidden:] = 0
    return result


def project(params, hidden=4):
    unpack(params, hidden)
    result = np.asarray(params, dtype=np.float64).copy()
    cut = N_INPUTS*hidden+hidden
    result[:cut] = np.clip(result[:cut], -1.9, 1.9)
    result[cut:-2] = np.clip(result[cut:-2], -4, 4)
    result[-2:] = np.clip(result[-2:], -2, 2)
    return result


def _effective(params, hidden, fake_quant):
    weights, bias, output, output_bias = unpack(params, hidden)
    if fake_quant:
        if not np.array_equal(np.asarray(params), project(params, hidden)):
            raise ValueError("fake quantization requires projected parameters")
        weights, bias = np.rint(weights*Q1)/Q1, np.rint(bias*Q1)/Q1
        output, output_bias = np.rint(output*Q2)/Q2, np.rint(output_bias*Q1*Q2)/(Q1*Q2)
    return weights, bias, output, output_bias


def _forward(params, white, black, turn, phase_units, hidden, fake_quant):
    turn = v2._inputs(white, black, turn)
    phase = _phase(phase_units, len(turn)) / 24
    mix = np.column_stack((phase, 1-phase))
    weights, bias, output, output_bias = _effective(params, hidden, fake_quant)
    pre_w, pre_b = white@weights+bias, black@weights+bias
    aw, ab = np.clip(pre_w, 0, 1), np.clip(pre_b, 0, 1)
    white_moves = turn[:, None] == 1
    ordered = np.concatenate((np.where(white_moves, aw, ab), np.where(white_moves, ab, aw)), axis=1)
    heads = ordered@output.T+output_bias
    net_white = np.sum(heads*mix, axis=1)*turn
    return net_white, ordered, pre_w, pre_b, output, turn, mix


def predict_cp(params, white, black, turn, *, phase_units, hidden=4, baseline_cp=None, fake_quant=False):
    if baseline_cp is None:
        raise ValueError("v3 requires frozen baseline")
    raw = _forward(params, white, black, turn, phase_units, hidden, fake_quant)[0]
    return raw*CP_SCALE+v2._baseline(baseline_cp, len(raw))


def activation_diagnostics(params, white, black, turn, hidden=4, fake_quant=False):
    v2._inputs(white, black, turn)
    weights, bias, _, _ = _effective(params, hidden, fake_quant)
    pre = np.concatenate((white@weights+bias, black@weights+bias), axis=0)
    if not len(pre):
        raise ValueError("activation diagnostics require at least one row")
    return {"rows": int(white.shape[0]), "perspectivesPooled": 2,
            "zeroActivationFraction": (pre<=0).mean(axis=0).tolist(),
            "upperSaturationFraction": (pre>=1).mean(axis=0).tolist(),
            "interiorFraction": ((pre>0)&(pre<1)).mean(axis=0).tolist()}


def loss_and_grad(params, white, black, turn, targets, *, phase_units, hidden=4, baseline_cp=None,
                  sample_weight=None, l2=0.0, anchor_params=None, fake_quant=False):
    if baseline_cp is None:
        raise ValueError("v3 requires frozen baseline")
    raw, ordered, pre_w, pre_b, output, turn, mix = _forward(
        params, white, black, turn, phase_units, hidden, fake_quant)
    target = np.asarray(targets, dtype=np.float64)
    if (target.shape != raw.shape or not len(target) or not np.all(np.isfinite(target))
            or np.any((target<0)|(target>1))):
        raise ValueError("targets must be a nonempty finite vector in [0,1]")
    weight = np.ones(len(target)) if sample_weight is None else np.asarray(sample_weight, dtype=np.float64)
    if weight.shape != raw.shape or not np.all(np.isfinite(weight)) or np.any(weight<=0):
        raise ValueError("sample weights must be finite positive row weights")
    weight = weight/weight.sum()
    if not np.isfinite(l2) or l2<0:
        raise ValueError("l2 must be finite and nonnegative")
    if anchor_params is None:
        if l2:
            raise ValueError("an explicit initialization anchor is required for regularization")
        anchor_params = np.zeros(parameter_count(hidden))
    unpack(anchor_params, hidden)
    logits = 4*raw+v2._baseline(baseline_cp, len(raw))/100
    data_ce = float(np.dot(weight, np.logaddexp(0, logits)-target*logits))
    d_stm = (expit(logits)-target)*4*weight*turn
    d_heads = d_stm[:, None]*mix
    d_ordered = d_heads@output
    white_moves = turn[:, None] == 1
    dw = np.where(white_moves, d_ordered[:, :hidden], d_ordered[:, hidden:])*((pre_w>0)&(pre_w<1))
    db = np.where(white_moves, d_ordered[:, hidden:], d_ordered[:, :hidden])*((pre_b>0)&(pre_b<1))
    data_grad = np.concatenate((np.asarray(white.T@dw+black.T@db).ravel(),
        (dw+db).sum(axis=0), (d_heads.T@ordered).ravel(), d_heads.sum(axis=0)))
    displacement = np.asarray(params)-np.asarray(anchor_params)
    reg = float(.5*l2*np.dot(displacement, displacement))
    reg_grad = l2*displacement
    grad = data_grad+reg_grad
    return data_ce+reg, grad, {"dataCE": data_ce, "regularizer": reg,
        "dataGradientL2": float(np.linalg.norm(data_grad)), "regularizerGradientL2": float(np.linalg.norm(reg_grad)),
        "gradientL2": float(np.linalg.norm(grad)), "gradientMaxAbs": float(np.max(np.abs(grad))),
        "fakeQuantization": bool(fake_quant), "normalizedWeightedMean": True}


@dataclass(frozen=True)
class QuantizedModel:
    input_weights: np.ndarray
    input_bias: np.ndarray
    output_weights: np.ndarray
    output_bias: np.ndarray
    baseline_id: str = "shipped-hce"

    def __post_init__(self):
        candidate = np.asarray(self.input_weights)
        if candidate.ndim != 2 or candidate.shape[0] != N_INPUTS:
            raise ValueError("invalid first-layer shape")
        hidden = candidate.shape[1]
        parameter_count(hidden)
        if self.baseline_id != "shipped-hce":
            raise ValueError("v3 requires frozen shipped-hce baseline")
        for name, dtype, shape, bound in (
            ("input_weights", np.int16, (N_INPUTS, hidden), 31130),
            ("input_bias", np.int32, (hidden,), 31130),
            ("output_weights", np.int16, (2, 2*hidden), 16384),
            ("output_bias", np.int32, (2,), 134217728)):
            object.__setattr__(self, name, v2._integer_array(getattr(self, name), dtype, shape, bound, name))
        largest = np.sort(np.abs(self.input_weights.astype(np.int64)), axis=0)[-MAX_PIECES:]
        if np.any(largest.sum(axis=0)+np.abs(self.input_bias.astype(np.int64)) > np.iinfo(np.int32).max):
            raise ValueError("theoretical int32 accumulator overflow")
        head_bound = Q1*np.abs(self.output_weights.astype(np.int64)).sum(axis=1)+np.abs(self.output_bias.astype(np.int64))
        if int(max(head_bound))*24*CP_SCALE+24*Q1*Q2//2 > np.iinfo(np.int64).max:
            raise ValueError("theoretical int64 output overflow")

    @property
    def hidden(self):
        return self.input_weights.shape[1]

    def metadata(self):
        h = self.hidden
        return {"schema": SCHEMA, "researchOnly": True, "inputs": N_INPUTS, "hidden": h,
            "parameters": parameter_count(h), "parameterBytes": parameter_bytes(h),
            "q1": Q1, "q2": Q2, "cpScale": CP_SCALE, "maximumPieces": MAX_PIECES,
            "layout": f"W1[768,{h}]:i16,b1[{h}]:i32,W2[2,{2*h}]:i16,b2[2]:i32;little-endian",
            "featureOrder": "PNBRQKpnbrqk; a8=0; black: color-swap,square^56",
            "outputOrder": f"MG,EG;side-to-move[{h}],other[{h}]",
            "weightRounding": "nearest-ties-to-even",
            "scoreRounding": "floor((taperedNumerator*400+denominator/2)/denominator);white-sign-after-stm-round",
            "activation": "clamp(sum(W1)+b1,0,16384)", "mode": "phase-residual-shipped-hce",
            "fixedBaseline": self.baseline_id, "maximumAbsScoreCp": 10000,
            "phaseRule": "min(24,N+B+2R+4Q);both-colors"}

    def to_bytes(self):
        result = b"".join((self.input_weights.astype("<i2").tobytes(), self.input_bias.astype("<i4").tobytes(),
                            self.output_weights.astype("<i2").tobytes(), self.output_bias.astype("<i4").tobytes()))
        assert len(result) == parameter_bytes(self.hidden)
        return result

    @classmethod
    def from_bytes(cls, payload, *, hidden=4, baseline_id="shipped-hce", metadata=None):
        if len(payload) != parameter_bytes(hidden):
            raise ValueError("incorrect parameter binary length")
        cut = N_INPUTS*hidden*2
        result = cls(np.frombuffer(payload, dtype="<i2", count=N_INPUTS*hidden).reshape(N_INPUTS, hidden),
            np.frombuffer(payload, dtype="<i4", count=hidden, offset=cut),
            np.frombuffer(payload, dtype="<i2", count=4*hidden, offset=cut+4*hidden).reshape(2, 2*hidden),
            np.frombuffer(payload, dtype="<i4", count=2, offset=len(payload)-8), baseline_id)
        if metadata is not None:
            expected = result.metadata()
            if (type(metadata) is not dict or metadata.keys()!=expected.keys()
                    or any(type(metadata[k]) is not type(v) or metadata[k]!=v for k,v in expected.items())):
                raise ValueError("metadata differs from the complete numerical contract")
        return result

    def predict_cp(self, white, black, turn, *, phase_units, baseline_cp=None):
        if baseline_cp is None:
            raise ValueError("v3 requires frozen baseline")
        turn = v2._inputs(white, black, turn, integer=True)
        phase = _phase(phase_units, len(turn))
        base = v2._baseline(baseline_cp, len(turn), integer=True)
        weights = self.input_weights.astype(np.int64)
        aw = np.clip(white.astype(np.int64)@weights+self.input_bias, 0, Q1)
        ab = np.clip(black.astype(np.int64)@weights+self.input_bias, 0, Q1)
        wm = turn[:, None] == 1
        ordered = np.concatenate((np.where(wm, aw, ab), np.where(wm, ab, aw)), axis=1)
        heads = ordered@self.output_weights.astype(np.int64).T+self.output_bias
        numerator = phase*heads[:, 0]+(24-phase)*heads[:, 1]
        denominator = 24*Q1*Q2
        return ((numerator*CP_SCALE+denominator//2)//denominator)*turn+base


def quantize(params, hidden=4, baseline_id="shipped-hce"):
    if not np.array_equal(np.asarray(params), project(params, hidden)):
        raise ValueError("parameters outside registered projection bounds")
    w,b,o,ob = unpack(params, hidden)
    return QuantizedModel(np.rint(w*Q1), np.rint(b*Q1), np.rint(o*Q2), np.rint(ob*Q1*Q2), baseline_id)
