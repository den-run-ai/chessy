#!/usr/bin/env python3
"""Regression tests for natural HCE fit gates and split exposure controls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("natural_fit", ROOT / "tools/training/natural-pilot-fit.py")
fit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fit
spec.loader.exec_module(fit)
np, sparse = fit.np, fit.sparse


class NaturalFitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = fit.contract()
        cls.center, cls.scales = fit.metadata()

    def data(self, serial=0, rows=90, signal=0):
        values = np.arange(rows) % 41 - 20
        matrix = sparse.csr_matrix((values.astype(float), (np.arange(rows), np.full(rows, 17))), shape=(rows, 965))
        matrix.eliminate_zeros()
        baseline = matrix @ self.center
        teacher = matrix @ (self.center + np.eye(1, 965, 17).ravel() * signal)
        return fit.Data(matrix, np.zeros(rows), fit.arith.sigmoid(teacher / 400), teacher,
            np.asarray([fit.PHASES[i % 3] for i in range(rows)]),
            np.asarray([f"family-{serial}-{i // 3}" for i in range(rows)]),
            np.asarray([f"source-{serial}-{i}" for i in range(rows)]),
            np.asarray([f"row-{serial}-{i}" for i in range(rows)]),
            np.asarray([f"cluster-{serial}-{i}" for i in range(rows)]),
            baseline, ["unused"] * rows, fit.ROLES[min(serial, 2)])

    def test_integer_bounds_preserve_mobility_and_unsupported_weights(self):
        data = self.data(signal=8)
        low, high = fit.bounds(self.center, data)
        self.assertTrue(np.all(low[:4] > 0))
        self.assertTrue(np.array_equal(low[:4], self.center[:4]))
        self.assertTrue(np.array_equal(high[:4], self.center[:4]))
        self.assertEqual(low[17], self.center[17] - 10)
        self.assertEqual(high[17], self.center[17] + 10)
        self.assertTrue(np.array_equal(low[18:], self.center[18:]))
        fitted, info = fit.fit(data, self.center, self.scales, 1, 759, .02, (low, high), self.rules)
        self.assertTrue(info["success"])
        self.assertTrue(np.all(fitted[759:] == 0))
        self.assertTrue(np.array_equal(fitted[:17], self.center[:17]))
        self.assertTrue(np.array_equal(fitted[18:], self.center[18:]))
        self.assertGreater(fitted[17], self.center[17])
        self.assertTrue(np.all(fitted == np.rint(fitted)))

    def test_half_tie_rounding_reproduces_rust_sign_behavior(self):
        data = self.data(rows=2)
        data.matrix = sparse.csr_matrix((2, 965))
        data.fixed_cp = np.asarray([-1138.5000000000002, 1138.4999999999998])
        self.assertEqual(fit.arith.runtime_predictions(data, self.center).tolist(), [-1138, 1139])
        with self.assertRaisesRegex(ValueError, "integer weights"):
            fit.arith.runtime_predictions(data, self.center + .5)

    def test_real_node_feature_stream_matches_wasm_and_integer_affine(self):
        rows = [{"id": "opening", "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
                {"id": "endgame", "fen": "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1"}]
        changed = self.center.copy()
        changed[17] += 2
        features = [json.loads(line) for line in fit.node_features({"rows": rows, "weights": changed.astype(int).tolist()}).splitlines()]
        for feature in features:
            data = self.data(rows=1)
            data.matrix = sparse.csr_matrix((feature["data"], feature["indices"], [0, len(feature["data"])]), shape=(1, 965))
            data.fixed_cp = np.asarray([feature["fixedCp"]])
            self.assertEqual(fit.arith.runtime_predictions(data, self.center)[0], feature["baselineCp"])
            self.assertEqual(fit.arith.runtime_predictions(data, changed)[0], feature["candidateCp"])

    def test_teacher_fails_frozen_cp_wdl_and_budget_admission(self):
        valid = {"scoreCp": 50, "wdl": [300, 400, 300], "targetWhite": .5,
                 "depth": 16, "seldepth": 22, "nodes": 100000, "scoreNodes": 99900,
                 "bestmove": "e2e4", "pv": ["e2e4", "e7e5"]}
        fit.check_teacher(valid, self.rules["teacherAdmission"])
        for mutation in ({"scoreCp": 2001}, {"nodes": 99999}, {"wdl": [300, 400, 301]},
                         {"targetWhite": .6}, {"scoreNodes": 100001}, {"pv": ["d2d4"]}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                fit.check_teacher(valid | mutation, self.rules["teacherAdmission"])

    def test_all_leakage_keys_checked(self):
        left = fit.identities(self.data(0))
        right = fit.identities(self.data(1))
        fit.assert_disjoint(left, right)
        for key in left:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                fit.assert_disjoint(left, right | {key: left[key]})

    def test_cp_and_phase_guards_prevent_ce_only_candidate(self):
        baseline = {"crossEntropy": .5, "teacherCpMae": 100, "teacherCpRmse": 200,
                    "byPhase": {p: {"rows": 101, "crossEntropy": .5} for p in fit.PHASES}}
        candidate = baseline | {"crossEntropy": .49, "teacherCpMae": 103}
        self.assertIn("teacherCpMae-deterioration-over-2-percent", fit.guard(baseline, candidate, self.rules))
        candidate = baseline | {"crossEntropy": .49, "byPhase": baseline["byPhase"] | {"endgame": {"rows": 101, "crossEntropy": .51}}}
        self.assertIn("endgame-cross-entropy-deterioration-over-1-percent", fit.guard(baseline, candidate, self.rules))
        self.assertTrue(fit.guard(baseline, baseline, self.rules))

    def test_family_bootstrap_preserves_row_estimand(self):
        data = self.data(rows=5)
        data.family = np.asarray(["a", "b", "b", "b", "b"])
        base = np.asarray([0, 0, 0, 0, 0])
        candidate = np.asarray([100, 1, 1, 1, 1])
        result = fit.bootstrap_families(data, base, candidate, 1, self.rules)
        delta = fit.arith.row_losses(candidate, data.target, 1) - fit.arith.row_losses(base, data.target, 1)
        self.assertAlmostEqual(result["candidateMinusBaselineMean"], float(np.mean(delta)))
        self.assertEqual(result["families"], 2)
        self.assertEqual(result["maxRowsPerFamily"], 4)

    def test_baseline_selection_never_loads_test(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            summary_path, manifest_path = root / "labels.json", root / "manifest.json"
            summary_path.write_text("{}")
            manifest_path.write_text("{}")
            calls = []
            def load(summary, directory, role, *args):
                calls.append(role)
                self.assertNotEqual(role, "hce-test")
                return self.data(0 if role == "shared-train" else 1)
            with patch.object(fit, "load_summary", return_value=({}, {})), \
                    patch.object(fit, "load_role", side_effect=load), \
                    patch.object(fit, "candidate_parity"):
                result = fit.select(summary_path, manifest_path, root / "selection.json")
            self.assertEqual(calls, ["shared-train", "hce-validation"])
            self.assertEqual(result["selected"]["surface"], "baseline")
            self.assertFalse(result["testEligible"])
            with patch.object(fit, "load_role") as loader:
                with self.assertRaisesRegex(ValueError, "cannot open test"):
                    fit.evaluate_test(root / "selection.json", root / "report.json")
                loader.assert_not_called()
            self.assertFalse((root / "selection.json.test-opened").exists())

    def test_failed_test_consumes_exposure_and_refuses_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selection = root / "selection.json"
            frozen = {"schema": "chessy.natural-pilot-frozen-selection.v1", "inputSha256": {},
                "researchWeights": self.center.astype(int).tolist(), "labelSummaryPath": str(root / "labels.json"),
                "selectionManifestPath": str(root / "manifest.json"),
                "report": {"testEligible": True, "selected": {"surface": "constrained753", "weightsSha256": fit.arith.sha256_json_ints(self.center)}}}
            selection.write_text(json.dumps(frozen))
            with patch.object(fit, "load_summary", return_value=({}, {})), patch.object(fit, "load_role", side_effect=ValueError("bad test hash")):
                with self.assertRaisesRegex(ValueError, "bad test hash"):
                    fit.evaluate_test(selection, root / "report.json")
            self.assertTrue((root / "selection.json.test-opened").exists())
            with patch.object(fit, "load_role") as loader:
                with self.assertRaises(FileExistsError):
                    fit.evaluate_test(selection, root / "report.json")
                loader.assert_not_called()
            self.assertFalse((root / "report.json").exists())

    def test_summary_identity_coverage_and_exclusion_checks_precede_fit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rules_path = ROOT / "eval/training/natural-pilot-v1.json"
            teacher_path = ROOT / "eval/training/natural-teacher-v1.json"
            rules = fit.read_json(rules_path)
            manifest = {"schema": "chessy.natural-pilot-selection.v1", "status": "complete-research-only-selection",
                "productionFitAllowed": False, "coverage": {"fullPilotReady": True, "failedGates": []},
                "preregistration": {"sha256": fit.sha(rules_path)}, "fitPreregistration": {"sha256": fit.CONTRACT_SHA},
                "teacherContract": {"sha256": fit.sha(teacher_path)},
                "source": {"sha256": rules["source"]["sha256"], "uncompressedSha256": "a" * 64,
                           "games": rules["source"]["games"], "license": "CC0-1.0"},
                "selection": {"rows": 50000, "uniqueSourceGames": 50000, "uniqueClusters": 50000,
                              "sourceDispositions": {"admitted": 50000, "excluded": rules["source"]["games"] - 50000}}}
            manifest_path, summary_path = root / "manifest.json", root / "summary.json"
            manifest_path.write_text(json.dumps(manifest))
            summary = {"schema": "chessy.natural-pilot-label-summary.v1", "status": "completed",
                "teacher": fit.read_json(teacher_path), "failures": [],
                "provenance": {"selectionManifestSha256": fit.sha(manifest_path),
                    "preregistrationSha256": fit.sha(rules_path), "fitPreregistrationSha256": fit.CONTRACT_SHA,
                    "teacherManifestSha256": fit.sha(teacher_path), "sourceSha256": rules["source"]["sha256"],
                    "sourceUncompressedSha256": "a" * 64},
                "output": {"selectedRows": 50000, "acceptedRows": 49000, "excludedRows": 1000,
                    "exclusionFraction": .02, "files": [{"role": r, "rows": n} for r, n in
                    zip(("shared-train", "hce-validation", "hce-test", "nnue-validation", "nnue-test"), (35000, 4500, 4500, 2500, 2500))]}}
            summary_path.write_text(json.dumps(summary))
            fit.load_summary(summary_path, manifest_path)
            bad = json.loads(json.dumps(summary))
            bad["provenance"]["sourceSha256"] = "b" * 64
            summary_path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "source identity"):
                fit.load_summary(summary_path, manifest_path)
            bad = json.loads(json.dumps(summary))
            bad["output"].update(acceptedRows=44000, excludedRows=6000, exclusionFraction=.12)
            bad["output"]["files"][0]["rows"] -= 5000
            summary_path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "exclusion fraction"):
                fit.load_summary(summary_path, manifest_path)
            manifest["coverage"] = {"fullPilotReady": False, "failedGates": ["fewer-than-40000-selected"]}
            manifest_path.write_text(json.dumps(manifest))
            summary["provenance"]["selectionManifestSha256"] = fit.sha(manifest_path)
            summary_path.write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "failed preregistered coverage"):
                fit.load_summary(summary_path, manifest_path)

    def test_publication_input_change_never_creates_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input"
            source.write_text("before")
            expected = {source: fit.sha(source)}
            source.write_text("changed")
            with self.assertRaisesRegex(ValueError, "input changed"):
                fit.publish(root / "output", {"ok": True}, expected)
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
