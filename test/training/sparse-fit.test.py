#!/usr/bin/env python3
"""Numerical and admission contracts for the convex prototype."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np
from scipy import sparse
from scipy.special import expit
from tools.sparse_eval.fit import objective, fit, quantize, predict, metrics, eligible
from tools.sparse_eval.features import N_FEATURES
from tools.sparse_eval.pipeline import authenticated_bytes, bound_path, write, load_role


class SolverTests(unittest.TestCase):
    def test_gradient_and_convexity(self):
        rng = np.random.default_rng(170280)
        x = sparse.csr_matrix(rng.normal(size=(90, 7)))
        base = rng.normal(size=90) * 100
        target = expit(rng.normal(size=90))
        weight = np.full(90, 1/90)
        a, b = rng.normal(size=(2, 7))
        fun = lambda v: objective(v, x, base, target, weight, .03)
        loss, grad = fun(a)
        for j in range(7):
            delta = np.eye(7)[j] * 1e-5
            self.assertAlmostEqual((fun(a+delta)[0]-fun(a-delta)[0])/2e-5, grad[j], places=8)
        self.assertLessEqual(fun(.37*a+.63*b)[0], .37*fun(a)[0]+.63*fun(b)[0]+1e-12)

    def test_recovers_informative_supported_coefficient(self):
        x = sparse.csr_matrix((np.tile([-1., 1.], 100), (np.arange(200), np.zeros(200, int))), shape=(200, N_FEATURES))
        fitted = fit(x, np.zeros(200), np.tile([-40., 40.], 100), families=["pst"], l2=1e-4, l1=0, min_support=10)
        self.assertTrue(fitted.report["numericallyConverged"])
        self.assertAlmostEqual(fitted.weights_cp[0], 40, delta=.1)
        self.assertEqual(np.count_nonzero(fitted.weights_cp), 1)

    def test_l1_can_remove_weak_feature(self):
        x = sparse.csr_matrix((np.tile([-1., 1.], 100), (np.arange(200), np.zeros(200, int))), shape=(200, N_FEATURES))
        result = fit(x, np.zeros(200), np.tile([-1., 1.], 100), families=["pst"], l2=1e-4, l1=.01)
        self.assertLess(abs(result.weights_cp[0]), 1e-8)

    def test_no_holdout_mask_or_nan_weights(self):
        x = sparse.csr_matrix(np.ones((40, N_FEATURES)))
        for weight in (np.zeros(40), np.full(40, np.nan)):
            with self.assertRaises(ValueError):
                fit(x, np.zeros(40), np.zeros(40), families=["pst"], l2=.01, l1=0, sample_weight=weight)

    def test_rounding_and_integer_taper(self):
        w = np.zeros(N_FEATURES); w[:4] = [-1.5, -.5, .5, 1.5]
        self.assertEqual(quantize(w)[:4].tolist(), [-2, -1, 1, 2])
        x = sparse.csr_matrix(([.5, -.5], ([0, 1], [0, 0])), shape=(2, N_FEATURES))
        w[:] = 0; w[0] = 1
        self.assertEqual(predict(x, [10, 10], w).tolist(), [11, 9])
        w[0] = 40000
        with self.assertRaises(ValueError): quantize(w)

    def test_baseline_remains_selectable_and_phase_guard(self):
        phase = np.array([20, 10, 0]); target = np.array([100., 100., 100.])
        baseline = metrics([0, 0, 0], target, phase)
        better = metrics([95, 95, 95], target, phase)
        self.assertFalse(eligible(baseline, baseline, converged=True))
        self.assertFalse(eligible(better, baseline, converged=False))
        self.assertTrue(eligible(better, baseline, converged=True))
        better["endgame"]["ce"] = 2*baseline["endgame"]["ce"]
        self.assertFalse(eligible(better, baseline, converged=True))

    def test_input_integrity_and_no_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = write(root / "x", b"abc")
            self.assertEqual(authenticated_bytes(root, item), b"abc")
            with self.assertRaises(FileExistsError): write(root / "x", b"def")
            (root / "x").write_bytes(b"abd")
            with self.assertRaises(ValueError): authenticated_bytes(root, item)
            with self.assertRaises(ValueError): bound_path(root, "../x")


if __name__ == "__main__":
    unittest.main()
