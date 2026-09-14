"""Research-only H4 piece-square network and bounded integer reference.

There is deliberately no engine loader or runtime integration here. Scores are
white-centric at the public boundary; the output layer sees side-to-move first.
Square zero is a8, matching Chessy, and black perspective flips ranks and colors.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
from scipy import sparse
from scipy.special import expit


N_INPUTS = 768
HIDDEN = 4
N_PARAMS = N_INPUTS * HIDDEN + HIDDEN + 2 * HIDDEN + 1
BINARY_BYTES = N_INPUTS * HIDDEN * 2 + HIDDEN * 4 + 2 * HIDDEN * 2 + 4
Q1 = 1024
CP_SCALE = 400
MAX_PIECES = 32
PIECES = "PNBRQKpnbrqk"


def features_from_fens(fens: Iterable[str]):
    """Return white/black binary CSR inputs and +1 white/-1 black turn signs."""
    white_indices, black_indices, indptr, turns = [], [], [0], []
    for fen in fens:
        fields = fen.split()
        if len(fields) != 6 or fields[1] not in ("w", "b"):
            raise ValueError("expected six-field FEN with w/b turn")
        ranks = fields[0].split("/")
        if len(ranks) != 8:
            raise ValueError("FEN must contain eight ranks")
        start = len(white_indices)
        for rank, cells in enumerate(ranks):
            file = 0
            for char in cells:
                if char in "12345678":
                    file += int(char)
                elif char in PIECES and file < 8:
                    channel, square = PIECES.index(char), rank * 8 + file
                    white_indices.append(channel * 64 + square)
                    black_indices.append(((channel + 6) % 12) * 64 + (square ^ 56))
                    file += 1
                else:
                    raise ValueError("invalid FEN piece placement")
                if file > 8:
                    raise ValueError("FEN rank exceeds eight squares")
            if file != 8:
                raise ValueError("FEN rank must contain eight squares")
        if len(white_indices) - start > MAX_PIECES:
            raise ValueError("H4 input exceeds 32-piece bound")
        indptr.append(len(white_indices))
        turns.append(1 if fields[1] == "w" else -1)
    shape = (len(turns), N_INPUTS)
    values = np.ones(len(white_indices), dtype=np.float64)
    white = sparse.csr_matrix((values, white_indices, indptr), shape=shape)
    black = sparse.csr_matrix((values.copy(), black_indices, indptr), shape=shape)
    white.sort_indices()
    black.sort_indices()
    return white, black, np.asarray(turns, dtype=np.int8)


def initialize(seed: int) -> np.ndarray:
    """A deterministic, small random start away from CReLU's flat regions."""
    rng = np.random.default_rng(seed)
    return np.concatenate((
        rng.normal(0.0, 0.04, N_INPUTS * HIDDEN),
        np.full(HIDDEN, 0.25),
        rng.normal(0.0, 0.1, 2 * HIDDEN),
        np.zeros(1),
    ))


def unpack(params):
    params = np.asarray(params, dtype=np.float64)
    if params.shape != (N_PARAMS,) or not np.all(np.isfinite(params)):
        raise ValueError(f"expected {N_PARAMS} finite parameters")
    cut = N_INPUTS * HIDDEN
    return (params[:cut].reshape(N_INPUTS, HIDDEN), params[cut:cut + HIDDEN],
            params[cut + HIDDEN:-1], params[-1])


def _check_inputs(white, black, turn, *, integer=False):
    if not sparse.isspmatrix_csr(white) or not sparse.isspmatrix_csr(black):
        raise ValueError("H4 inputs must be CSR matrices")
    if white.shape != black.shape or white.shape[1] != N_INPUTS:
        raise ValueError("H4 input shape mismatch")
    turn = np.asarray(turn)
    if turn.shape != (white.shape[0],) or not np.all((turn == 1) | (turn == -1)):
        raise ValueError("turn signs must be +1 or -1")
    if integer:
        for matrix in (white, black):
            if not np.all(matrix.data == 1) or not matrix.has_canonical_format:
                raise ValueError("quantized inference requires canonical binary inputs")
            if np.any(np.diff(matrix.indptr) > MAX_PIECES):
                raise ValueError("H4 input exceeds 32-piece bound")
    return turn


def _forward(params, white, black, turn):
    turn = _check_inputs(white, black, turn)
    weights, bias, output, output_bias = unpack(params)
    pre_white, pre_black = white @ weights + bias, black @ weights + bias
    act_white, act_black = np.clip(pre_white, 0, 1), np.clip(pre_black, 0, 1)
    white_moves = turn[:, None] == 1
    first = np.where(white_moves, act_white, act_black)
    second = np.where(white_moves, act_black, act_white)
    ordered = np.concatenate((first, second), axis=1)
    raw_stm = ordered @ output + output_bias
    return raw_stm * turn, ordered, pre_white, pre_black, output, turn


def predict_cp(params, white, black, turn):
    """Float white score; no centipawn rounding before the fitting objective."""
    return _forward(params, white, black, turn)[0] * CP_SCALE


def loss_and_grad(params, white, black, turn, target_white, k=4.0, l2=1e-5):
    """Mean sigmoid BCE plus 0.5*l2*mean(params**2), with analytic gradient."""
    raw_white, ordered, pre_white, pre_black, output, turn = _forward(
        params, white, black, turn)
    target = np.asarray(target_white, dtype=np.float64)
    if (target.shape != raw_white.shape or not len(target) or
            not np.all(np.isfinite(target)) or np.any((target < 0) | (target > 1))):
        raise ValueError("targets must be a nonempty vector in [0,1]")
    if not np.isfinite(k) or k <= 0 or not np.isfinite(l2) or l2 < 0:
        raise ValueError("invalid loss coefficients")
    params = np.asarray(params, dtype=np.float64)
    logits = k * raw_white
    loss = np.mean(np.logaddexp(0, logits) - target * logits)
    derivative_stm = (expit(logits) - target) * (k / len(target)) * turn
    grad_output = ordered.T @ derivative_stm
    grad_output_bias = derivative_stm.sum()
    grad_first = derivative_stm[:, None] * output[:HIDDEN]
    grad_second = derivative_stm[:, None] * output[HIDDEN:]
    white_moves = turn[:, None] == 1
    grad_white = np.where(white_moves, grad_first, grad_second)
    grad_black = np.where(white_moves, grad_second, grad_first)
    grad_white *= (pre_white > 0) & (pre_white < 1)
    grad_black *= (pre_black > 0) & (pre_black < 1)
    grad_weights = white.T @ grad_white + black.T @ grad_black
    grad_bias = (grad_white + grad_black).sum(axis=0)
    grad = np.concatenate((np.asarray(grad_weights).ravel(), grad_bias,
                           grad_output, [grad_output_bias]))
    loss += 0.5 * l2 * np.mean(params * params)
    grad += l2 * params / N_PARAMS
    return float(loss), grad


def _integer_array(value, dtype, shape, name):
    value = np.asarray(value)
    info = np.iinfo(dtype)
    if (value.shape != shape or not np.all(np.isfinite(value)) or
            np.any(value != np.rint(value)) or np.any(value < info.min) or
            np.any(value > info.max)):
        raise ValueError(f"invalid or saturated {name}")
    result = value.astype(dtype, copy=True)
    result.setflags(write=False)
    return result


@dataclass(frozen=True)
class QuantizedModel:
    input_weights: np.ndarray
    input_bias: np.ndarray
    output_weights: np.ndarray
    output_bias: int
    q2: int

    def __post_init__(self):
        if (not isinstance(self.q2, (int, np.integer)) or isinstance(self.q2, bool) or
                self.q2 < 1 or self.q2 > 4096 or self.q2 & (self.q2 - 1)):
            raise ValueError("Q2 must be a power of two from 1 through 4096")
        object.__setattr__(self, "input_weights", _integer_array(
            self.input_weights, np.int16, (N_INPUTS, HIDDEN), "input weights"))
        object.__setattr__(self, "input_bias", _integer_array(
            self.input_bias, np.int32, (HIDDEN,), "input bias"))
        object.__setattr__(self, "output_weights", _integer_array(
            self.output_weights, np.int16, (2 * HIDDEN,), "output weights"))
        output_bias = _integer_array(self.output_bias, np.int32, (), "output bias")
        object.__setattr__(self, "output_bias", int(output_bias))
        # Any legal input has <=32 distinct active features. A per-unit bound
        # using the largest 32 magnitudes is stronger than observed-data checks.
        largest = np.sort(np.abs(self.input_weights.astype(np.int64)), axis=0)[-MAX_PIECES:]
        accumulator_bound = largest.sum(axis=0) + np.abs(self.input_bias.astype(np.int64))
        if np.any(accumulator_bound > np.iinfo(np.int32).max):
            raise ValueError("theoretical int32 accumulator overflow")
        dot_bound = Q1 * sum(abs(int(x)) for x in self.output_weights) + abs(self.output_bias)
        if dot_bound * CP_SCALE + Q1 * self.q2 // 2 > np.iinfo(np.int64).max:
            raise ValueError("theoretical int64 output overflow")

    def metadata(self):
        return {
            "schema": "chessy-h4-quantized-v1", "researchOnly": True,
            "inputs": N_INPUTS, "hidden": HIDDEN, "parameters": N_PARAMS,
            "parameterBytes": BINARY_BYTES, "q1": Q1, "q2": int(self.q2),
            "cpScale": CP_SCALE, "maximumPieces": MAX_PIECES,
            "layout": "W1[768,4]:i16,b1[4]:i32,W2[8]:i16,b2[1]:i32;little-endian",
            "featureOrder": "PNBRQKpnbrqk; a8=0; black: color-swap,square^56",
            "outputOrder": "side-to-move[4],other[4]",
            "weightRounding": "nearest-ties-to-even",
            "scoreRounding": "floor((numerator*400+denominator/2)/denominator);white-sign-after-stm-round",
            "activation": "clamp(sum(W1)+b1,0,1024)",
        }

    def to_bytes(self):
        payload = b"".join((self.input_weights.astype("<i2").tobytes(),
                            self.input_bias.astype("<i4").tobytes(),
                            self.output_weights.astype("<i2").tobytes(),
                            np.asarray(self.output_bias, dtype="<i4").tobytes()))
        assert len(payload) == BINARY_BYTES
        return payload

    @classmethod
    def from_bytes(cls, payload: bytes, q2: int):
        if len(payload) != BINARY_BYTES:
            raise ValueError(f"expected exactly {BINARY_BYTES} model bytes")
        cut = N_INPUTS * HIDDEN * 2
        return cls(np.frombuffer(payload, dtype="<i2", count=N_INPUTS * HIDDEN).reshape(N_INPUTS, HIDDEN),
                   np.frombuffer(payload, dtype="<i4", count=HIDDEN, offset=cut),
                   np.frombuffer(payload, dtype="<i2", count=2 * HIDDEN, offset=cut + HIDDEN * 4),
                   int(np.frombuffer(payload, dtype="<i4", count=1, offset=BINARY_BYTES - 4)[0]), q2)

    def predict_cp(self, white, black, turn):
        turn = _check_inputs(white, black, turn, integer=True)
        weights = self.input_weights.astype(np.int64)
        # Cast CSR values before matmul: float64 sparse multiplication would
        # silently turn an integer parity check into a floating calculation.
        act_white = np.clip(white.astype(np.int64) @ weights + self.input_bias, 0, Q1)
        act_black = np.clip(black.astype(np.int64) @ weights + self.input_bias, 0, Q1)
        white_moves = turn[:, None] == 1
        first = np.where(white_moves, act_white, act_black)
        second = np.where(white_moves, act_black, act_white)
        numerator = (first @ self.output_weights[:HIDDEN].astype(np.int64) +
                     second @ self.output_weights[HIDDEN:].astype(np.int64) + self.output_bias)
        denominator = Q1 * self.q2
        stm_cp = (numerator * CP_SCALE + denominator // 2) // denominator
        return stm_cp * turn


def quantize(params):
    """Round without clipping; reject saturation and unbounded integer paths."""
    weights, bias, output, output_bias = unpack(params)
    q2 = 4096
    while q2 >= 1:
        rounded = np.rint(output * q2)
        if np.all((rounded >= -32768) & (rounded <= 32767)):
            break
        q2 //= 2
    if q2 < 1:
        raise ValueError("output weights saturate even at Q2=1")
    return QuantizedModel(np.rint(weights * Q1), np.rint(bias * Q1), rounded,
                          np.rint(output_bias * Q1 * q2), q2)
