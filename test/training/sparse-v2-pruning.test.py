#!/usr/bin/env python3
"""Rounding, structured pruning and eligibility boundaries independent of data."""
from pathlib import Path
import sys
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.sparse_eval.features import N_FEATURES, BASE_FEATURES, FAMILIES
from tools.sparse_eval_v2.prune import derive, quality_guard


class Pruning(unittest.TestCase):
    def test_threshold_and_family_boundaries(self):
        w = np.full(N_FEATURES, 5, dtype=np.int16); w[:6] = [-3, -2, -1, 0, 1, 2]
        x, _ = derive(w, {"operation": "zero-small", "threshold": 2}, w)
        self.assertEqual(x[:7].tolist(), [-3, 0, 0, 0, 0, 0, 5])
        x, _ = derive(w, {"operation": "zero-families", "families": ["ray"]}, w)
        a, b = FAMILIES["ray"]
        self.assertTrue(np.all(x[a:b] == 0)); self.assertTrue(np.all(x[a+BASE_FEATURES:b+BASE_FEATURES] == 0))
        self.assertEqual(x[a-1], 5); self.assertEqual(x[a+BASE_FEATURES-1], 5)
        self.assertEqual(w[a], 5)

    def test_four_bit_negative_ties_and_independent_phase_scales(self):
        w = np.zeros(N_FEATURES, dtype=np.int16)
        w[:7] = [14, -14, 1, -1, 3, -3, 0]
        w[BASE_FEATURES:BASE_FEATURES+2] = [7, -7]
        x, detail = derive(w, {"operation": "symmetric-int4", "maxCode": 7}, w)
        self.assertEqual(x[:7].tolist(), [14, -14, 2, -2, 4, -4, 0])
        self.assertEqual(detail["integerScales"]["mg:pst"], 2)
        self.assertEqual(detail["integerScales"]["eg:pst"], 1)
        self.assertTrue(np.array_equal(x[BASE_FEATURES:], w[BASE_FEATURES:]))

    def test_existing_model_and_invalid_operations(self):
        w = np.zeros(N_FEATURES, dtype=np.int16); king = w.copy(); king[10] = 50
        x, _ = derive(w, {"operation": "existing-king"}, king)
        self.assertEqual(x[10], 50)
        for recipe in ({"operation": "oops"}, {"operation": "zero-small", "threshold": -1},
                       {"operation": "zero-families", "families": ["missing"]},
                       {"operation": "symmetric-int4", "maxCode": 8}):
            with self.assertRaises(ValueError): derive(w, recipe, king)

    def test_quality_rejects_phase_and_error_tradeoffs(self):
        def metric(ce, mae=10, rmse=20):
            return {p: {"rows": 1, "ce": ce, "maeCp": mae, "rmseCp": rmse}
                    for p in ["overall", "opening", "middlegame", "endgame"]}
        rules = {"minimumRetainedFractionOfFullCeGain": .75,
                 "minimumCeImprovementOverHce": .005, "maximumMaeRatioToFull": 1.03,
                 "maximumRmseRatioToFull": 1.03}
        b, f = metric(.68), metric(.67)
        self.assertTrue(quality_guard(metric(.672), f, b, rules)["passed"])
        self.assertFalse(quality_guard(metric(.674), f, b, rules)["passed"])
        self.assertFalse(quality_guard(metric(.671, mae=11), f, b, rules)["passed"])
        x = metric(.671); x["endgame"]["ce"] = .681
        self.assertFalse(quality_guard(x, f, b, rules)["passed"])


if __name__ == "__main__":
    unittest.main()
