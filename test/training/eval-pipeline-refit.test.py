#!/usr/bin/env python3
"""Refit boundary, exact-score, family-guard, and actual convex-refit contracts."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("eval_pipeline_refit_test", ROOT / "tools/eval_pipeline/refit.py")
refit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refit)


class RefitContracts(unittest.TestCase):
    def test_protocol_has_two_new_refits_and_no_admission_by_nodes(self):
        protocol = refit.protocol()
        self.assertEqual(protocol["rolesOpened"], ["train", "validation"])
        self.assertTrue(protocol["noHoldoutOrOodFilesRead"])
        self.assertFalse(protocol["productionAdmission"])
        self.assertEqual([row["id"] for row in protocol["recipes"]], ["refit-no-pawn", "refit-no-ray"])
        self.assertEqual(protocol["fit"]["l1"], 1e-5)
        self.assertEqual(protocol["fit"]["l2"], 1e-4)
        self.assertEqual(protocol["fit"]["minSupport"], 32)
        self.assertEqual(protocol["fit"]["maxIterations"], 400)
        self.assertIn("equal-time", protocol["strengthCriterion"])
        for recipe in protocol["recipes"]:
            self.assertEqual(set(recipe["families"]), set(refit.FAMILIES) - {recipe["removedFamily"]})
            self.assertNotEqual(set(recipe["families"]), {"pst", "own_king", "enemy_king"})

    def test_wrong_manifest_cannot_open_any_role(self):
        with patch.object(refit, "read_exact", side_effect=AssertionError("must not read any role")):
            with self.assertRaisesRegex(ValueError, "exact original"):
                refit.validate_manifests(b"{}", b"{}")

    def test_holdout_role_rejected_before_access(self):
        with patch.object(refit, "read_exact", side_effect=AssertionError("must not open holdout")):
            with self.assertRaisesRegex(ValueError, "only open train or validation"):
                refit.load_role(Path("unavailable"), {"role": "holdout"})

    def test_filenames_reject_traversal_and_absolute_paths(self):
        for name in ("../holdout.teacher.f64", "/tmp/data", ".", "..", "dir/data", None):
            with self.subTest(name=name), self.assertRaises(ValueError):
                refit.safe_file(name)
        self.assertEqual(refit.safe_file("train.values.f32"), "train.values.f32")

    def test_exact_signed_half_rounding_keeps_baseline_separate(self):
        numerators = np.array([12, -12, 36, -36, 11, -11, 0], dtype=np.int32)
        matrix = sparse.csr_matrix((numerators, (np.arange(7), np.zeros(7, dtype=int))), shape=(7, refit.N_FEATURES))
        weights = np.zeros(refit.N_FEATURES, dtype="<i2"); weights[0] = 1
        self.assertEqual(refit.exact_predict(matrix, np.ones(7, dtype="<i4"), weights).tolist(), [2, 0, 3, -1, 1, 1, 1])
        floating = sparse.csr_matrix((np.array([0.5, -0.5, 1.5], np.float32),
            (np.arange(3), np.zeros(3, dtype=int))), shape=(3, refit.N_FEATURES))
        rebuilt = refit.integer_matrix(floating)
        self.assertEqual(rebuilt.data.tolist(), [12, -12, 36])
        floating.data[0] = 0.01
        with self.assertRaisesRegex(ValueError, "denominator-24"):
            refit.integer_matrix(floating)

    def test_exact_prediction_rejects_float_weights_and_overflow(self):
        matrix = sparse.csr_matrix(([24], ([0], [0])), shape=(1, refit.N_FEATURES))
        with self.assertRaisesRegex(ValueError, "integer coefficient"):
            refit.exact_predict(matrix, [0], np.zeros(refit.N_FEATURES))
        weights = np.zeros(refit.N_FEATURES, dtype="<i2"); weights[0] = 1
        with self.assertRaisesRegex(ValueError, "overflow"):
            refit.exact_predict(matrix, [np.iinfo(np.int32).max], weights)

    def test_family_balance_prevents_repeated_family_dominating(self):
        result = refit.balanced_metrics(np.array([400, 400, 400, 0]), np.zeros(4),
                                       np.full(4, 24), np.array([0, 0, 0, 1]))
        self.assertAlmostEqual(result["overall"]["maeCp"], 200)
        self.assertAlmostEqual(result["opening"]["maeCp"], 200)
        self.assertEqual(result["overall"]["families"], 2)
        self.assertEqual(result["endgame"]["rows"], 0)

    @staticmethod
    def metrics(ce, mae=100):
        return {name: {"rows": 10, "ce": ce, "maeCp": mae, "rmseCp": mae * 1.5}
                for name in ("overall", "opening", "middlegame", "endgame")}

    def test_quality_guard_checks_each_phase_and_actual_convergence(self):
        baseline, full = self.metrics(.7, 120), self.metrics(.68, 100)
        candidate = self.metrics(.681, 101)
        self.assertTrue(refit.quality_guard(candidate, full, baseline, converged=True, removed_zero=True)["passed"])
        failed = copy.deepcopy(candidate); failed["endgame"]["ce"] = .701
        self.assertFalse(refit.quality_guard(failed, full, baseline, converged=True, removed_zero=True)["passed"])
        self.assertFalse(refit.quality_guard(candidate, full, baseline, converged=False, removed_zero=True)["passed"])
        self.assertFalse(refit.quality_guard(candidate, full, baseline, converged=True, removed_zero=False)["passed"])
        failed = self.metrics(.69, 100)
        self.assertFalse(refit.quality_guard(failed, full, baseline, converged=True, removed_zero=True)["passed"])

    def test_both_recipes_actually_refit_retained_columns(self):
        # Small synthetic optimizer contract only; never corpus or eligibility evidence.
        n = 256
        rows = np.arange(n)
        signs = np.where(rows % 2, 1, -1)
        context = np.where((rows // 2) % 2, 1, -1)
        ray = np.where((rows // 4) % 2, 1, -1)
        matrix = sparse.csr_matrix((np.concatenate((signs, context, ray)),
            (np.tile(rows, 3), np.repeat([0, refit.FAMILIES["pawn_context"][0], refit.FAMILIES["ray"][0]], n))),
            shape=(n, refit.N_FEATURES))
        teacher = 100 * signs + 40 * context + 25 * ray
        for recipe in refit.RECIPES:
            with self.subTest(recipe=recipe["id"]):
                fitted = refit.fit(matrix, np.zeros(n), teacher, families=recipe["families"], l1=1e-5, l2=1e-4,
                                   sample_weight=np.ones(n), min_support=32, max_iterations=400)
                self.assertTrue(fitted.report["numericallyConverged"])
                weights = refit.quantize(fitted.weights_cp)
                self.assertGreater(abs(weights[0]), 20)
                start, stop = refit.FAMILIES[recipe["removedFamily"]]
                self.assertFalse(np.any(weights[start:stop]))
                self.assertFalse(np.any(weights[start + refit.BASE_FEATURES:stop + refit.BASE_FEATURES]))
                retained = "ray" if recipe["removedFamily"] == "pawn_context" else "pawn_context"
                self.assertNotEqual(weights[refit.FAMILIES[retained][0]], 0)

    def test_snapshot_pins_original_optimizer_features_and_extractor(self):
        source = refit.snapshot_sources(ROOT)
        self.assertEqual(refit.sha(source["tools/sparse_eval/fit.py"]), refit.FIT_SHA)
        self.assertEqual(refit.sha(source["tools/sparse_eval/features.py"]), refit.FEATURE_SHA)
        self.assertEqual(refit.sha(source["tools/sparse_eval/runtime.rs"]), refit.EXTRACTOR_SOURCE_SHA)
        self.assertIn("experiments/wasm/src/eval.rs", source)

    def test_write_is_no_replace_and_retained_bytes_authenticate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weights.i16le"
            item = refit.write(path, b"retained exact data")
            self.assertEqual(refit.read_exact(path, item), b"retained exact data")
            with self.assertRaises(FileExistsError):
                refit.write(path, b"replacement")
            item["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                refit.read_exact(path, item)


if __name__ == "__main__":
    unittest.main()
