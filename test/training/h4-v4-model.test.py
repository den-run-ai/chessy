#!/usr/bin/env python3
"""Authored-only checks of weighted training and matched phase-head penalties."""
from pathlib import Path
import sys
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
import h4_v4_recipe as recipe

FENS = [
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1",
    "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    "r2qk2r/8/8/8/8/8/8/R3K2R w - - 0 1",
]
FEATURES = recipe.SINGLE.features_from_fens(FENS)
PHASE = recipe.PHASE.phase_from_fens(FENS)
TARGET = np.asarray([.6, .1, .8, .5, .9])
BASELINE = np.asarray([21, 717, -13, 4, 15])
WEIGHTS = np.asarray([4., 4., 1., 1., 1.])


def authored_parameters(model, hidden):
    original = model.implementation
    params = original.initialize(711, hidden=hidden, residual=True)
    anchor = original.anchor(params, hidden)
    rng = np.random.default_rng(124)
    params += rng.normal(0, .003, len(params))
    cut = 769 * hidden
    params[cut:] = rng.normal(0, .13, len(params) - cut)
    # Include lower and upper clipped units, interior units, and a nonzero
    # trunk regularization displacement, away from activation kink points.
    params[768 * hidden] = -1.8
    params[768 * hidden + 1] = 1.8
    return params, anchor


def tied_phase_params(single_params, hidden):
    weights, bias, output, output_bias = recipe.SINGLE.implementation.unpack(single_params, hidden)
    return np.concatenate((weights.ravel(), bias, output, output, [output_bias, output_bias]))


class V4RecipeTests(unittest.TestCase):
    def test_weighted_gradients_match_finite_differences_for_both_widths_and_heads(self):
        active = sorted(set(FEATURES[0].indices) | set(FEATURES[1].indices))
        for model in (recipe.SINGLE, recipe.PHASE):
            for hidden in (4, 8):
                with self.subTest(phase_heads=model.phase_heads, hidden=hidden):
                    params, anchor = authored_parameters(model, hidden)
                    options = dict(hidden=hidden, phase_units=PHASE, baseline_cp=BASELINE,
                                   sample_weight=WEIGHTS, l2=.037, anchor_params=anchor)
                    _, gradient, _ = model.loss_and_grad(params, *FEATURES, TARGET, **options)
                    # Every bias/output parameter, selected active trunk
                    # coordinates, and an inactive regularized coordinate.
                    selected_features = active[::max(1, len(active) // 4)][:4]
                    indexes = [feature * hidden + unit for feature in selected_features for unit in range(hidden)]
                    indexes += list(range(768 * hidden, len(params))) + [700 * hidden]
                    for index in indexes:
                        plus, minus = params.copy(), params.copy()
                        plus[index] += 1e-6
                        minus[index] -= 1e-6
                        numerical = (model.loss_and_grad(plus, *FEATURES, TARGET, **options)[0] -
                                     model.loss_and_grad(minus, *FEATURES, TARGET, **options)[0]) / 2e-6
                        self.assertAlmostEqual(gradient[index], numerical, delta=7e-9)

    def test_objective_matches_independent_weighted_ce_and_group_penalties(self):
        for model in (recipe.SINGLE, recipe.PHASE):
            for hidden in (4, 8):
                params, anchor = authored_parameters(model, hidden)
                options = dict(hidden=hidden, phase_units=PHASE, baseline_cp=BASELINE,
                               sample_weight=WEIGHTS, l2=.037, anchor_params=anchor)
                objective, gradient, diagnostics = model.loss_and_grad(params, *FEATURES, TARGET, **options)
                logits = model.predict_cp(params, *FEATURES, hidden=hidden,
                                          phase_units=PHASE, baseline_cp=BASELINE) / 100
                losses = [np.logaddexp(0, z) - t * z for z, t in zip(logits, TARGET)]
                data_ce = sum(w * loss for w, loss in zip(WEIGHTS, losses)) / sum(WEIGHTS)
                displacement = params - anchor
                cut = 769 * hidden
                head_factor = .5 if model.phase_heads else 1
                penalty = .5 * .037 * (sum(v * v for v in displacement[:cut]) +
                                       head_factor * sum(v * v for v in displacement[cut:]))
                self.assertAlmostEqual(objective, data_ce + penalty, places=13)
                self.assertAlmostEqual(diagnostics["regularizer"], penalty, places=14)
                self.assertAlmostEqual(diagnostics["dataCE"], data_ce, places=14)
                # Arbitrary positive rescaling preserves the whole objective,
                # including its balance against both regularization groups.
                for scale in (.001, 17., 1e5):
                    scaled_loss, scaled_grad, _ = model.loss_and_grad(
                        params, *FEATURES, TARGET, **dict(options, sample_weight=WEIGHTS * scale))
                    self.assertAlmostEqual(scaled_loss, objective, places=13)
                    np.testing.assert_allclose(scaled_grad, gradient, atol=2e-14, rtol=2e-14)
                unweighted = dict(options, sample_weight=None)
                ones = dict(options, sample_weight=np.ones(len(TARGET)))
                a, ga, _ = model.loss_and_grad(params, *FEATURES, TARGET, **unweighted)
                b, gb, _ = model.loss_and_grad(params, *FEATURES, TARGET, **ones)
                self.assertEqual(a, b)
                np.testing.assert_array_equal(ga, gb)

    def test_tied_phase_heads_match_single_full_objective_and_tied_direction_gradient(self):
        for hidden in (4, 8):
            params, anchor = authored_parameters(recipe.SINGLE, hidden)
            phase_params = tied_phase_params(params, hidden)
            phase_anchor = tied_phase_params(anchor, hidden)
            cut = 769 * hidden
            for fake_quant in (False, True):
                options = dict(hidden=hidden, baseline_cp=BASELINE, sample_weight=WEIGHTS,
                               l2=.037, fake_quant=fake_quant)
                loss, gradient, diagnostics = recipe.SINGLE.loss_and_grad(
                    params, *FEATURES, TARGET, anchor_params=anchor, phase_units=PHASE, **options)
                # Check all legal material phases and a mixed-material batch;
                # this equality must be independent of how the heads mix.
                for phases in [np.full(len(TARGET), phase) for phase in range(25)] + [PHASE]:
                    phase_loss, phase_gradient, phase_diagnostics = recipe.PHASE.loss_and_grad(
                        phase_params, *FEATURES, TARGET, anchor_params=phase_anchor,
                        phase_units=phases, **options)
                    self.assertAlmostEqual(phase_loss, loss, places=13)
                    self.assertAlmostEqual(phase_diagnostics["regularizer"], diagnostics["regularizer"], places=14)
                    summed_heads = phase_gradient[cut:-2].reshape(2, 2 * hidden).sum(axis=0)
                    tied_gradient = np.concatenate((phase_gradient[:cut], summed_heads, [sum(phase_gradient[-2:])]))
                    np.testing.assert_allclose(tied_gradient, gradient, atol=3e-14, rtol=3e-14)

    def test_zero_negative_nonfinite_and_malformed_weights_are_rejected(self):
        invalid_weights = ([0, 1, 1, 1, 1], [0] * 5, [-1, 1, 1, 1, 1],
                           [np.nan, 1, 1, 1, 1], [np.inf, 1, 1, 1, 1],
                           [-np.inf, 1, 1, 1, 1], [1] * 4, [], [[1] * 5])
        for model in (recipe.SINGLE, recipe.PHASE):
            for hidden in (4, 8):
                params, anchor = authored_parameters(model, hidden)
                options = dict(hidden=hidden, phase_units=PHASE, baseline_cp=BASELINE,
                               anchor_params=anchor, l2=.037)
                for weights in invalid_weights:
                    with self.subTest(phase_heads=model.phase_heads, hidden=hidden, weights=weights), self.assertRaises(ValueError):
                        model.loss_and_grad(params, *FEATURES, TARGET, sample_weight=weights, **options)
                for value in (np.nan, np.inf, -np.inf):
                    target = TARGET.copy()
                    target[0] = value
                    with self.assertRaises(ValueError):
                        model.loss_and_grad(params, *FEATURES, target, sample_weight=WEIGHTS, **options)
                    invalid_params = params.copy()
                    invalid_params[0] = value
                    with self.assertRaises(ValueError):
                        model.loss_and_grad(invalid_params, *FEATURES, TARGET, sample_weight=WEIGHTS, **options)
                    with self.assertRaises(ValueError):
                        model.loss_and_grad(params, *FEATURES, TARGET, sample_weight=WEIGHTS,
                                            **dict(options, l2=value))


if __name__ == "__main__":
    unittest.main()
