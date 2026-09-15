"""V4 recipe adapters; the v2/v3 inference and numerical contracts stay frozen.

Only the training objective changes. Normalized weighting is exact, and phase
output heads receive half the single-head L2 coefficient, so tying both heads
recovers the single-head penalty rather than doubling it.
"""
import numpy as np
import h4_v2_model as single
import h4_v3_model as phase


class Recipe:
    def __init__(self, implementation, phase_heads):
        self.implementation = implementation
        self.phase_heads = phase_heads

    def __getattr__(self, name):
        return getattr(self.implementation, name)

    def _kwargs(self, kwargs):
        result = dict(kwargs)
        if not self.phase_heads:
            result.pop("phase_units", None)
        return result

    def predict_cp(self, *args, **kwargs):
        return self.implementation.predict_cp(*args, **self._kwargs(kwargs))

    def quantize(self, *args, **kwargs):
        original = self.implementation.quantize(*args, **kwargs)
        return IntegerRecipe(original, self.phase_heads)

    def loss_and_grad(self, params, white, black, turn, targets, *, hidden=4,
                      phase_units=None, baseline_cp=None, sample_weight=None,
                      l2=0.0, anchor_params=None, fake_quant=False):
        targets = np.asarray(targets, dtype=np.float64)
        if targets.ndim != 1 or not len(targets):
            raise ValueError("targets must be nonempty vector")
        weight = np.ones(len(targets)) if sample_weight is None else np.asarray(sample_weight, dtype=np.float64)
        if (weight.shape != targets.shape or not np.all(np.isfinite(weight))
                or np.any(weight <= 0)):
            raise ValueError("sample weights must be finite positive row weights")
        if not np.isfinite(l2) or l2 < 0:
            raise ValueError("l2 must be finite and nonnegative")
        self.implementation.unpack(params, hidden)
        if anchor_params is None:
            if l2:
                raise ValueError("an explicit initialization anchor is required for regularization")
            anchor_params = np.zeros_like(params)
        self.implementation.unpack(anchor_params, hidden)
        options = dict(hidden=hidden, baseline_cp=baseline_cp, fake_quant=fake_quant)
        if self.phase_heads:
            data_ce, data_grad, _ = phase.loss_and_grad(params, white, black, turn, targets,
                phase_units=phase_units, sample_weight=weight, **options)
        else:
            # Exact weighted mean by constant-weight groups. Each underlying
            # objective is unchanged v2 mean BCE, so no duplicate model gradient
            # implementation is introduced. The registered weights are 1 or 4.
            data_ce, data_grad = 0.0, np.zeros_like(params, dtype=np.float64)
            turn = np.asarray(turn)
            base = None if baseline_cp is None else np.asarray(baseline_cp)
            for value in np.unique(weight):
                indexes = np.flatnonzero(weight == value)
                fraction = float(value*len(indexes)/weight.sum())
                ce, grad, _ = single.loss_and_grad(params, white[indexes], black[indexes], turn[indexes], targets[indexes],
                    hidden=hidden, baseline_cp=None if base is None else base[indexes], fake_quant=fake_quant)
                data_ce += fraction*ce
                data_grad += fraction*grad
        coefficients = np.full(len(params), l2, dtype=np.float64)
        coefficients[768*hidden+hidden:] *= .5 if self.phase_heads else 1
        displacement = np.asarray(params)-np.asarray(anchor_params)
        regularizer = float(.5*np.dot(coefficients, displacement*displacement))
        reg_grad = coefficients*displacement
        gradient = data_grad+reg_grad
        return data_ce+regularizer, gradient, {
            "dataCE": data_ce, "regularizer": regularizer,
            "dataGradientL2": float(np.linalg.norm(data_grad)),
            "regularizerGradientL2": float(np.linalg.norm(reg_grad)),
            "gradientL2": float(np.linalg.norm(gradient)),
            "gradientMaxAbs": float(np.max(np.abs(gradient))),
            "fakeQuantization": bool(fake_quant), "normalizedWeightedMean": True,
            "trunkL2": l2, "outputL2": l2*(.5 if self.phase_heads else 1)}


class IntegerRecipe:
    def __init__(self, implementation, phase_heads):
        self.implementation = implementation
        self.phase_heads = phase_heads

    def __getattr__(self, name):
        return getattr(self.implementation, name)

    def predict_cp(self, *args, **kwargs):
        if not self.phase_heads:
            kwargs.pop("phase_units", None)
        return self.implementation.predict_cp(*args, **kwargs)


SINGLE = Recipe(single, False)
PHASE = Recipe(phase, True)
