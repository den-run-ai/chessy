#!/usr/bin/env python3
"""Synthetic H4 selection guards and once-only test exposure regressions."""

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
spec = importlib.util.spec_from_file_location("h4_screen", ROOT / "tools/training/natural-nnue-h4.py")
screen = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = screen
spec.loader.exec_module(screen)


class H4ScreenTests(unittest.TestCase):
    def metric(self):
        return {"rows": 300, "crossEntropy": .6, "teacherCpMae": 100,
                "teacherCpRmse": 150, "p99AbsoluteCpError": 350,
                "byPhase": {phase: {"rows": 100, "crossEntropy": .6} for phase in screen.PHASES}}

    def data(self, rows=300):
        return SimpleNamespace(target=np.full(rows, .5), teacher_cp=np.zeros(rows),
                               phase=np.asarray([screen.PHASES[i % 3] for i in range(rows)]),
                               family=np.asarray([f"family-{i // 3}" for i in range(rows)]))

    def selection_fixture(self, root):
        original = root / "original"
        original.mkdir()
        params = screen.model.initialize(10502)
        model = screen.model.quantize(params)
        floats = screen.encoded(params.tolist())
        weights = model.to_bytes()
        (original / "seed-10502.float.json").write_bytes(floats)
        (original / "seed-10502.bin").write_bytes(weights)
        report = {"testEligible": True, "contractSha256": screen.CONTRACT_SHA,
                  "inputSha256": {}, "auditEvidence": {"fixture": "synthetic-only"},
                  "selected": {"seed": 10502, "variant": "net-only", "metadata": model.metadata(),
                               "floatSha256": screen.digest(floats), "modelSha256": screen.digest(weights)}}
        selection = original / "selection.json"
        selection.write_bytes(screen.encoded(report))
        screen.reserve("selection-frozen", {"selectionSha256": screen.digest(selection.read_bytes()),
                                            "output": str(original)}, {})
        auth = SimpleNamespace(evidence=report["auditEvidence"], expected={})
        return selection, original, auth

    def test_quality_metrics_use_frozen_k4_white_logits_and_absolute_p99_error(self):
        data = self.data(6)
        data.teacher_cp = np.asarray([-200, 0, 0, 100, 200, 1000])
        data.target = np.asarray([.1, .5, .6, .7, .8, .99])
        cp = np.asarray([-100, 0, 50, 100, 0, 200])
        result = screen.quality_metrics(cp, data)
        logits = 4 * cp / 400
        error = cp - data.teacher_cp
        self.assertAlmostEqual(result["crossEntropy"], np.mean(np.logaddexp(0, logits) - data.target * logits))
        self.assertAlmostEqual(result["teacherCpMae"], np.mean(np.abs(error)))
        self.assertAlmostEqual(result["teacherCpRmse"], np.sqrt(np.mean(error ** 2)))
        self.assertAlmostEqual(result["p99AbsoluteCpError"], np.quantile(np.abs(error), .99))
        self.assertEqual(result["rows"], 6)
        for phase in screen.PHASES:
            self.assertEqual(result["byPhase"][phase]["rows"], 2)
        for invalid in [np.ones(7), np.full(6, np.nan), np.full(6, np.inf)]:
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "prediction"):
                screen.quality_metrics(invalid, data)

    def test_guards_enforce_relative_ce_cp_tail_phase_and_coverage_thresholds(self):
        baseline, candidate = self.metric(), self.metric()
        candidate["crossEntropy"] *= .995
        candidate["teacherCpMae"] *= 1.02
        candidate["teacherCpRmse"] *= 1.02
        candidate["p99AbsoluteCpError"] *= 1.05
        for phase in screen.PHASES:
            candidate["byPhase"][phase]["crossEntropy"] *= 1.01
        self.assertEqual(screen.guard(baseline, candidate), [])
        for key in ("crossEntropy", "teacherCpMae", "teacherCpRmse", "p99AbsoluteCpError"):
            changed = copy.deepcopy(candidate)
            changed[key] += 1e-6
            self.assertEqual(len(screen.guard(baseline, changed)), 1, key)
        for phase in screen.PHASES:
            changed = copy.deepcopy(candidate)
            changed["byPhase"][phase]["crossEntropy"] += 1e-6
            self.assertEqual(screen.guard(baseline, changed), [phase + "-CE-guard"])
            changed["byPhase"][phase] = {"rows": 99}
            self.assertEqual(screen.guard(baseline, changed), [phase + "-coverage"])
        self.assertIn("CE-gain-below-0.5-percent", screen.guard(baseline, baseline))

    def test_fewer_than_100_phase_rows_are_not_silently_omitted(self):
        data = self.data(2)
        metric = screen.quality_metrics(np.zeros(2), data)
        self.assertEqual(metric["byPhase"]["endgame"], {"rows": 0})
        reasons = screen.guard(metric, metric)
        for phase in screen.PHASES:
            self.assertIn(phase + "-coverage", reasons)

    def test_median_requires_every_seed_and_does_not_choose_the_luckiest(self):
        records = [{"seed": seed, "completed": True, "validation": {"crossEntropy": ce}}
                   for seed, ce in zip(screen.SEEDS, [.20, .40, .30])]
        self.assertEqual(screen.median_candidate(records)["seed"], 10503)
        self.assertEqual(screen.median_candidate(list(reversed(records)))["seed"], 10503)
        records[1]["completed"] = False
        self.assertIsNone(screen.median_candidate(records))
        with self.assertRaisesRegex(ValueError, "all three"):
            screen.median_candidate(records[:2])
        with self.assertRaisesRegex(ValueError, "all three"):
            screen.median_candidate([records[0], records[0], records[2]])

    def test_median_ties_have_frozen_seed_order(self):
        records = [{"seed": seed, "completed": True, "validation": {"crossEntropy": .3}}
                   for seed in reversed(screen.SEEDS)]
        self.assertEqual(screen.median_candidate(records)["seed"], 10502)

    def test_family_bootstrap_preserves_row_weighting_and_is_deterministic(self):
        data = self.data(5)
        data.family = np.asarray(["a", "b", "b", "b", "b"])
        baseline, candidate = np.zeros(5), np.asarray([100, 1, 1, 1, 1])
        result = screen.bootstrap(data, baseline, candidate)
        delta = np.logaddexp(0, candidate / 100) - .5 * candidate / 100 - np.log(2)
        self.assertAlmostEqual(result["candidateMinusBaselineMean"], np.mean(delta))
        self.assertEqual(result["families"], 2)
        self.assertEqual(result["iterations"], 2000)
        self.assertEqual(result, screen.bootstrap(data, baseline, candidate))

    def test_canonical_marker_ignores_renamed_outputs_and_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(screen, "ROOT", Path(temporary)):
            expected_key = screen.digest((screen.CONTRACT_SHA + "\0" + screen.SUMMARY_SHA + "\0nnue-test").encode())
            self.assertEqual(screen.canonical_state(), Path(temporary) / ".research-state" / expected_key)
            for kind in ("run-started", "test-opened"):
                first = screen.reserve(kind, {"output": "first", "bundle": "a"}, {})
                original = first.read_bytes()
                with self.assertRaises(FileExistsError):
                    screen.reserve(kind, {"output": "renamed", "bundle": "b"}, {})
                self.assertEqual(first.read_bytes(), original)

    def test_publication_rechecks_inputs_and_preserves_existing_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "input", root / "output"
            source.write_bytes(b"original")
            expected = {source: screen.digest(source.read_bytes())}
            screen.publish(output, b"first", expected)
            with self.assertRaises(FileExistsError):
                screen.publish(output, b"replacement", expected)
            self.assertEqual(output.read_bytes(), b"first")
            source.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "authenticated bytes changed"):
                screen.publish(root / "new-output", b"bad", expected)
            self.assertFalse((root / "new-output").exists())
            self.assertEqual(list(root.glob(".h4-*")), [])

    def test_tampered_selection_is_rejected_before_any_test_loading(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(screen, "ROOT", Path(temporary)):
            root = Path(temporary)
            selection, _, auth = self.selection_fixture(root)
            report = json.loads(selection.read_bytes())
            report["selected"]["seed"] = 10501
            selection.write_bytes(screen.encoded(report))
            with patch.object(screen, "implementation", return_value=({}, {}, "fixture")), \
                    patch.object(screen.data_io, "authenticate", return_value=auth), \
                    patch.object(screen.data_io, "load_role") as load:
                with self.assertRaisesRegex(ValueError, "authenticated bytes changed"):
                    screen.evaluate_test(root / "bundle", selection, root / "test.json")
                load.assert_not_called()
            self.assertFalse((screen.canonical_state() / "test-opened.json").exists())

    def test_tampered_checkpoint_is_rejected_before_any_test_loading(self):
        for artifact in ("seed-10502.float.json", "seed-10502.bin"):
            with self.subTest(artifact=artifact), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(screen, "ROOT", Path(temporary)):
                root = Path(temporary)
                selection, original, auth = self.selection_fixture(root)
                path = original / artifact
                path.write_bytes(path.read_bytes() + b"x")
                with patch.object(screen, "implementation", return_value=({}, {}, "fixture")), \
                        patch.object(screen.data_io, "authenticate", return_value=auth), \
                        patch.object(screen.data_io, "load_role") as load:
                    with self.assertRaisesRegex(ValueError, "authenticated bytes changed"):
                        screen.evaluate_test(root / "bundle", selection, root / "test.json")
                    load.assert_not_called()
                self.assertFalse((screen.canonical_state() / "test-opened.json").exists())

    def test_test_marker_is_consumed_before_loading_and_copied_selection_cannot_retry(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(screen, "ROOT", Path(temporary)):
            root = Path(temporary)
            selection, _, auth = self.selection_fixture(root)
            renamed = root / "copied-selection.json"
            renamed.write_bytes(selection.read_bytes())
            with patch.object(screen, "implementation", return_value=({}, {}, "fixture")), \
                    patch.object(screen.data_io, "authenticate", return_value=auth), \
                    patch.object(screen.data_io, "load_role", side_effect=RuntimeError("synthetic stop before test rows")) as load:
                with self.assertRaisesRegex(RuntimeError, "synthetic stop"):
                    screen.evaluate_test(root / "bundle", selection, root / "test-first.json")
                self.assertTrue((screen.canonical_state() / "test-opened.json").is_file())
                with self.assertRaises(FileExistsError):
                    screen.evaluate_test(root / "renamed-bundle", renamed, root / "test-renamed.json")
                self.assertEqual(load.call_count, 1)
                self.assertEqual(load.call_args.args[1], "nnue-test")


if __name__ == "__main__":
    unittest.main()
