#!/usr/bin/env python3
"""Independent synthetic LP solutions and exact frozen NNUE-head boundaries."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools/training"))
from tools.sparse_eval.wsp import (FrozenH4V3Head, apply_rank_one_edit,
                                  select_support, solve_sparse_edit)
import h4_v3_model as h4

FENS = [
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1",
    "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
]


class SparseEditTests(unittest.TestCase):
    def test_known_unique_lad_solution_and_duality(self):
        # Independent coordinate minima: .5|d-target|+.1|d| -> d=target.
        result = solve_sparse_edit(sparse.eye(2), [10, -10], [13, -12],
                                   l1=.1, max_abs_delta=5)
        self.assertTrue(result.report["success"])
        np.testing.assert_allclose(result.delta, [3, -2], atol=1e-8)
        self.assertAlmostEqual(result.report["objective"], .5)
        self.assertLess(result.report["absoluteDualityGap"], 1e-7)
        self.assertEqual(result.report["editedWeightedMaeCp"], 0)
        self.assertFalse(result.delta.flags.writeable)

    def test_frozen_support_and_box_are_enforced(self):
        result = solve_sparse_edit(np.eye(3), [0]*3, [8, 9, 10], support=[2, 0],
                                   l1=.01, max_abs_delta=[2, 100, 3])
        np.testing.assert_allclose(result.delta, [2, 0, 3], atol=1e-8)
        self.assertEqual(result.report["supportSize"], 2)
        self.assertFalse(result.report["implicitBias"])

    def test_hard_preservation_forces_repair_through_other_coordinate(self):
        result = solve_sparse_edit([[1, 1]], [7], [11], l1=.01,
                                   preserve_X=[[1, 0]], preserve_epsilon=0)
        np.testing.assert_allclose(result.delta, [0, 4], atol=1e-8)
        self.assertLess(result.report["maximumPreservationChangeCp"], 1e-7)

    def test_infeasible_hard_margin_exposes_no_weights(self):
        result = solve_sparse_edit([[1]], [0], [2], preserve_X=[[1]],
                                   preserve_epsilon=0, margin_X=[[1]], minimum_gain=1)
        self.assertFalse(result.report["success"])
        self.assertEqual(result.report["status"], 2)
        self.assertIsNone(result.delta)

    def test_explicit_preservation_slack_is_reported(self):
        result = solve_sparse_edit([[1]], [0], [2], l1=.01,
                                   preserve_X=[[1]], preserve_epsilon=0,
                                   preserve_penalty=.1)
        np.testing.assert_allclose(result.delta, [2], atol=1e-8)
        self.assertTrue(result.report["preservationIsSoft"])
        self.assertAlmostEqual(result.report["preservationSlackSum"], 2)
        self.assertAlmostEqual(result.report["maximumPreservationExcessCp"], 2)

    def test_soft_margin_keeps_hard_preservation(self):
        result = solve_sparse_edit([[1]], [0], [2], preserve_X=[[1]],
                                   preserve_epsilon=0, margin_X=[[1]], minimum_gain=1,
                                   margin_penalty=10)
        np.testing.assert_allclose(result.delta, [0], atol=1e-8)
        self.assertAlmostEqual(result.report["marginSlackSum"], 1)

    def test_weight_normalization_and_l1_zero_solution(self):
        a = solve_sparse_edit([[1], [1]], [0, 0], [1, 3], sample_weight=[4, 1], l1=.1)
        b = solve_sparse_edit([[1], [1]], [0, 0], [1, 3], sample_weight=[4e200, 1e200], l1=.1)
        np.testing.assert_allclose(a.delta, [1], atol=1e-8)
        np.testing.assert_allclose(a.delta, b.delta, atol=1e-8)
        c = solve_sparse_edit([[1]], [0], [7], l1=2)
        np.testing.assert_allclose(c.delta, [0], atol=1e-8)

    def test_sparse_input_aggregation_and_zero_support(self):
        duplicate = sparse.coo_matrix(([1, 2], ([0, 0], [0, 0])), shape=(1, 2))
        a = solve_sparse_edit(duplicate, [0], [6], l1=.1)
        np.testing.assert_allclose(a.delta, [2, 0], atol=1e-8)
        b = solve_sparse_edit([[1, 2]], [3], [5], support=np.array([], dtype=np.int64))
        self.assertTrue(b.report["success"])
        np.testing.assert_array_equal(b.delta, [0, 0])

    def test_support_ranking_uses_effect_not_raw_weight(self):
        # Effects: [1,2,0,2]; tied indices sort deterministically.
        np.testing.assert_array_equal(select_support([[1, 2, 0, 4]], [1, 1, 100, .5], budget=2), [1, 3])
        np.testing.assert_array_equal(select_support([[1, 0]], [0, 3], budget=2), [])
        with self.assertRaises(ValueError):
            select_support([[1]], [1], budget=True)

    def test_invalid_inputs_rejected_before_solver(self):
        cases = [
            dict(X=[[np.nan]], baseline_cp=[0], target_cp=[1]),
            dict(X=[[1]], baseline_cp=[np.inf], target_cp=[1]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1, 2]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], support=[0, 0]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], support=[.0]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], support=[True]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], max_abs_delta=np.inf),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], sample_weight=[0]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], preserve_X=[[1, 2]]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], preserve_epsilon=np.nan),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], preserve_penalty=1),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], margin_X=[[1]]),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], minimum_gain=1),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], l1=-1),
            dict(X=[[1]], baseline_cp=[0], target_cp=[1], time_limit=0),
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                solve_sparse_edit(**case)

    def test_rank_one_convention_is_fixed_direction(self):
        W = np.array([[1, 2, 3], [4, 5, 6]])
        u, v, h = np.array([2, -1]), np.array([.5, 0, -.25]), np.array([3, 4, 5])
        edited = apply_rank_one_edit(W, u, v)
        np.testing.assert_allclose((edited-W)@h, u*np.dot(v, h))
        np.testing.assert_array_equal(W, [[1, 2, 3], [4, 5, 6]])
        for bad in ([0, 0], [np.nan, 1], [1]):
            with self.assertRaises(ValueError):
                apply_rank_one_edit(W, bad, v)


class FrozenHeadTests(unittest.TestCase):
    def test_affine_prediction_matches_actual_forward_both_widths(self):
        features = h4.features_from_fens(FENS)
        phase = h4.phase_from_fens(FENS)
        base = [7, -94, -12, 950]
        for hidden in (4, 8):
            p = h4.initialize(125, hidden)
            p[769*hidden:] = np.random.default_rng(99).normal(0, .1, 4*hidden+2)
            head = FrozenH4V3Head(p, hidden)
            X = head.design(*features, phase_units=phase)
            expected = np.asarray(base) + X @ head.head
            np.testing.assert_allclose(expected, head.predict_cp(*features, phase_units=phase, baseline_cp=base), atol=1e-10)
            delta = np.random.default_rng(3).normal(0, .01, 4*hidden+2)
            audit = head.audit_edit(delta, *features, phase_units=phase, baseline_cp=base)
            self.assertTrue(audit["affineParity"])
            self.assertTrue(audit["roundingParity"])
            self.assertTrue(audit["frozenTrunkEqual"])
            self.assertTrue(audit["quantizedConstraintsRequireRecheck"])
            self.assertEqual(audit["modelBytes"], 6200 if hidden == 4 else 12392)
            np.testing.assert_array_equal(head.params, p)

    def test_real_head_lp_repairs_known_bias_with_trunk_frozen(self):
        features = h4.features_from_fens(FENS)
        phase = h4.phase_from_fens(FENS)
        head = FrozenH4V3Head(h4.initialize(47))
        X = head.design(*features, phase_units=phase)
        current = head.predict_cp(*features, phase_units=phase, baseline_cp=[0]*4)
        known = np.zeros(18)
        known[-2:] = [.02, -.03]
        target = current + X @ known
        fit = solve_sparse_edit(X, current, target, support=[16, 17], l1=.01, max_abs_delta=.1)
        self.assertTrue(fit.report["success"])
        np.testing.assert_allclose(fit.delta, known, atol=1e-9)
        audit = head.audit_edit(fit.delta, *features, phase_units=phase, baseline_cp=[0]*4)
        self.assertTrue(audit["affineParity"])

    def test_checkpoint_hash_and_quantized_roundtrip(self):
        p = h4.initialize(47)
        p[0] = 1.9  # rounds to the valid 31130 integer boundary
        head = FrozenH4V3Head(p)
        q = head.quantized()
        rebuilt = FrozenH4V3Head.from_quantized_bytes(q.to_bytes(), metadata=q.metadata())
        self.assertEqual(rebuilt.quantized().to_bytes(), q.to_bytes())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.float.json"
            payload = json.dumps(p.tolist()).encode()
            path.write_bytes(payload)
            loaded = FrozenH4V3Head.from_float_json(path, expected_sha256=hashlib.sha256(payload).hexdigest())
            np.testing.assert_array_equal(loaded.params, p)
            with self.assertRaises(ValueError):
                FrozenH4V3Head.from_float_json(path, expected_sha256="0"*64)
        with self.assertRaises(ValueError):
            head.apply(np.full(18, 100))
        with self.assertRaises(ValueError):
            head.apply(np.full(18, np.nan))


if __name__ == "__main__":
    unittest.main()
