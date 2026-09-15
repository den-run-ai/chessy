#!/usr/bin/env python3
"""Authored-only v2 orchestration checks; never authenticate or read real data."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
spec = importlib.util.spec_from_file_location("h4_v2_screen_test_subject", ROOT / "tools/training/natural-nnue-h4-v2.py")
screen = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = screen
spec.loader.exec_module(screen)
RULES = json.loads((ROOT / "eval/training/natural-nnue-h4-v2.json").read_text())


def authored_data(rows=12, role="shared-train", repeated_families=False):
    """All FENs and targets are constructed here; no source archive involved."""
    fens = [
        "4k3/8/8/8/8/8/P7/4K3 w - - 0 1",
        "4k3/p7/8/8/8/8/8/4K3 b - - 0 1",
        "4k3/8/8/8/8/8/7P/4K3 b - - 0 1",
        "4k3/7p/8/8/8/8/8/4K3 w - - 0 1",
    ]
    prefix = role + ":"
    return screen.data_io.fit.Data(
        matrix=sparse.csr_matrix((rows, 965)), fixed_cp=np.zeros(rows),
        target=np.asarray([.6 if i % 2 == 0 else .4 for i in range(rows)]),
        teacher_cp=np.asarray([40 if i % 2 == 0 else -40 for i in range(rows)]),
        phase=np.asarray([screen.util.PHASES[i % 3] for i in range(rows)]),
        family=np.asarray([prefix + "family-" + str(i // 2 if repeated_families else i) for i in range(rows)]),
        source=np.asarray([prefix + "game-" + str(i) for i in range(rows)]),
        row_id=np.asarray([prefix + "row-" + str(i) for i in range(rows)]),
        cluster=np.asarray([prefix + "cluster-" + str(i) for i in range(rows)]),
        baseline_cp=np.zeros(rows, dtype=np.int64),
        fens=[fens[i % len(fens)] for i in range(rows)], role=role)


def miniature_settings():
    settings = copy.deepcopy(RULES["training"])
    settings.update(epochs=4, batchSize=4, checkpointEveryEpochs=1,
                    quantizationAwareStartEpoch=3, maximumElapsedTrainingSeconds=120)
    return settings


class H4V2ScreenTests(unittest.TestCase):
    def test_group_split_uses_nul_salted_family_hash_and_preserves_every_row(self):
        data = authored_data(30000, repeated_families=True)
        train, validation = screen.inner_split(data)
        independently_expected = {
            family for family in set(data.family)
            if int.from_bytes(hashlib.sha256(b"chessy-h4-v2-inner-20260915\x00" + family.encode()).digest()[:8], "big") % 5 == 0
        }
        self.assertEqual(set(validation.family), independently_expected)
        self.assertFalse(set(train.family) & set(validation.family))
        self.assertFalse(set(train.source) & set(validation.source))
        self.assertEqual(train.rows + validation.rows, data.rows)
        self.assertEqual(set(train.row_id) | set(validation.row_id), set(data.row_id))
        self.assertEqual(train.role, "inner-train")
        self.assertEqual(validation.role, "inner-validation")
        self.assertEqual(len(validation.fens), validation.rows)
        # Row order must not change the partition or split a repeated family.
        reverse = screen.subset(data, np.arange(data.rows - 1, -1, -1), data.role)
        again_train, again_validation = screen.inner_split(reverse)
        self.assertEqual(set(again_train.row_id), set(train.row_id))
        self.assertEqual(set(again_validation.row_id), set(validation.row_id))

    def test_group_split_rejects_cross_family_source_overlap_and_small_coverage(self):
        data = authored_data(30000)
        train, validation = screen.inner_split(data)
        first_train = int(train.row_id[0].rsplit("-", 1)[1])
        first_validation = int(validation.row_id[0].rsplit("-", 1)[1])
        data.source[first_validation] = data.source[first_train]
        with self.assertRaisesRegex(ValueError, "source contamination"):
            screen.inner_split(data)
        with self.assertRaisesRegex(ValueError, "coverage"):
            screen.inner_split(authored_data(30))

    def test_adam_matches_scalar_reference_including_clipping_and_bias_correction(self):
        params = np.asarray([1., -2.])
        first, second = np.zeros(2), np.zeros(2)
        reference_params = params.tolist()
        reference_first, reference_second = [0., 0.], [0., 0.]
        for step, original in enumerate(([3., 4.], [-.2, .1], [0., -8.]), start=1):
            norm = math.sqrt(sum(x * x for x in original))
            gradients = [x * min(1., 2. / max(norm, 1e-30)) for x in original]
            for i, gradient in enumerate(gradients):
                reference_first[i] = .9 * reference_first[i] + .1 * gradient
                reference_second[i] = .999 * reference_second[i] + .001 * gradient * gradient
                update = (reference_first[i] / (1 - .9 ** step)) / (
                    math.sqrt(reference_second[i] / (1 - .999 ** step)) + 1e-8)
                reference_params[i] -= .003 * update
            params, first, second, reported_norm = screen.adam_step(
                params, np.asarray(original), first, second, step, .003, 2.)
            np.testing.assert_allclose(params, reference_params, rtol=0, atol=1e-14)
            np.testing.assert_allclose(first, reference_first, rtol=0, atol=1e-14)
            np.testing.assert_allclose(second, reference_second, rtol=0, atol=1e-14)
            self.assertAlmostEqual(reported_norm, norm)
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            screen.adam_step(params, np.asarray([np.nan, 1.]), first, second, 4, .003, 2.)

    def test_seed_selection_uses_median_and_never_advances_h8(self):
        configurations = copy.deepcopy(RULES["configurations"])
        seeds = RULES["training"]["seeds"]
        losses = [[.10, .60, .50], [.40, .30, .20], [.45, .35, .25], [.01, .02, .03]]
        records = []
        for config, values in zip(configurations, losses):
            for seed, loss, epoch in zip(seeds, values, [210, 260, 240]):
                records.append({"config": config, "seed": seed, "selectedInnerCe": loss, "selectedEpoch": epoch})
        result = screen.choose(list(reversed(records)), configurations, seeds)
        self.assertEqual(result["config"]["id"], "h4-residual-l001")
        self.assertEqual(result["seed"], seeds[1])
        self.assertEqual(result["medianInnerCe"], .30)
        self.assertEqual(result["epochs"], 240)
        self.assertEqual(result["innerRepresentativeEpoch"], 260)
        for invalid in [records[:-1], records + [records[0]]]:
            with self.assertRaisesRegex(ValueError, "missing/duplicate"):
                screen.choose(invalid, configurations, seeds)

    def test_recipe_and_seed_ties_follow_registered_order(self):
        configurations = copy.deepcopy(RULES["configurations"])
        seeds = RULES["training"]["seeds"]
        records = [{"config": config, "seed": seed, "selectedInnerCe": .5, "selectedEpoch": 220}
                   for config in configurations for seed in seeds]
        decision = screen.choose(list(reversed(records)), configurations, seeds)
        self.assertEqual(decision["config"], configurations[0])
        self.assertEqual(decision["seed"], sorted(seeds)[1])

    def test_cosine_schedule_endpoints_and_refit_prefix_are_frozen(self):
        settings = RULES["training"]
        self.assertEqual(screen.learning_rate(1, settings), settings["learningRate"])
        self.assertEqual(screen.learning_rate(300, settings), settings["minimumLearningRate"])
        self.assertGreater(screen.learning_rate(210, settings), screen.learning_rate(300, settings))
        for epoch in (0, 301):
            with self.assertRaisesRegex(ValueError, "schedule"):
                screen.learning_rate(epoch, settings)
        tiny = miniature_settings()
        with contextlib.redirect_stdout(io.StringIO()):
            _, report = screen.fit(RULES["configurations"][1], 10511, authored_data(4), None,
                                   tiny, time.monotonic() + 30, epochs=3)
        self.assertEqual(report["selectedEpoch"], 3)
        self.assertEqual(report["epochsRun"], 3)
        self.assertEqual(report["curves"][-1]["learningRate"], screen.learning_rate(3, tiny))
        self.assertNotEqual(report["curves"][-1]["learningRate"], tiny["minimumLearningRate"])
        self.assertEqual([r["qat"] for r in report["curves"]], [False, False, True])

    def test_checkpoint_ties_choose_first_qat_epoch_and_expired_budget_stops(self):
        train, validation = authored_data(4), authored_data(4, "inner-validation")
        train.target[:] = .5
        validation.target[:] = .5
        settings = miniature_settings()
        # Zero residual, zero target logits, and zero regularization displacement
        # produce exact equal checkpoints. Epochs 1 and 2 cannot be selected.
        with contextlib.redirect_stdout(io.StringIO()):
            _, report = screen.fit(RULES["configurations"][1], 10511, train, validation,
                                   settings, time.monotonic() + 30)
        self.assertEqual(report["selectedEpoch"], 3)
        self.assertEqual(len({point["innerValidationQuantizedCe"] for point in report["curves"]}), 1)
        with patch.object(screen.model, "loss_and_grad") as loss:
            with self.assertRaisesRegex(TimeoutError, "budget exhausted"):
                screen.fit(RULES["configurations"][1], 10511, train, validation,
                           settings, time.monotonic() - 1)
            loss.assert_not_called()

    def test_canonical_markers_prevent_renamed_output_retry_and_recheck_inputs(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(screen, "ROOT", Path(temporary)):
            root = Path(temporary)
            key = hashlib.sha256((screen.CONTRACT_SHA + "\0" + screen.SUMMARY_SHA + "\0nnue-test").encode()).hexdigest()
            self.assertEqual(screen.state_root(), root / ".research-state" / key)
            for kind in ("run-started", "recipe-frozen", "model-frozen", "test-opened"):
                first = screen.reserve(kind, {"output": "first"}, {})
                original = first.read_bytes()
                with self.assertRaises(FileExistsError):
                    screen.reserve(kind, {"output": "renamed"}, {})
                self.assertEqual(first.read_bytes(), original)
            source = root / "synthetic-input"
            source.write_bytes(b"original")
            expected = {source: screen.digest(source.read_bytes())}
            source.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "authenticated bytes changed"):
                screen.reserve("validation-opened", {}, expected)
            self.assertFalse((screen.state_root() / "validation-opened.json").exists())

    def test_rejected_main_retry_does_not_mutate_preexisting_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "completed"
            output.mkdir()
            existing = output / "selection.json"
            existing.write_bytes(b'{"completed":true}\n')
            argv = ["screen", "--bundle", str(root / "bundle"), "--output", str(output)]
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            with patch.object(sys, "argv", argv), patch.object(screen, "run", side_effect=FileExistsError("completed output exists")):
                with self.assertRaises(FileExistsError):
                    screen.main()
            self.assertEqual({p.name: p.read_bytes() for p in output.iterdir()}, before)

    def test_main_preserves_failure_receipt_for_new_partial_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "partial"
            argv = ["screen", "--bundle", str(root / "bundle"), "--output", str(output)]

            def partial_failure(_bundle, actual_output):
                self.assertEqual(actual_output, output)
                output.mkdir()
                (output / "partial-checkpoint").write_bytes(b"retained")
                raise RuntimeError("authored failure")

            with patch.object(sys, "argv", argv), patch.object(screen, "run", side_effect=partial_failure):
                with self.assertRaisesRegex(RuntimeError, "authored failure"):
                    screen.main()
            self.assertEqual((output / "partial-checkpoint").read_bytes(), b"retained")
            failure = json.loads((output / "failure.json").read_text())
            self.assertEqual(failure["type"], "RuntimeError")
            self.assertTrue(failure["doNotRetryForScore"])

    def _end_to_end(self, permit_test):
        rules = copy.deepcopy(RULES)
        rules["training"] = miniature_settings()
        train = authored_data(12)
        inner_train = screen.subset(train, np.arange(8), "inner-train")
        inner_validation = screen.subset(train, np.arange(8, 12), "inner-validation")
        outer = authored_data(6, "nnue-validation")
        test = authored_data(6, "nnue-test")
        fixtures = authored_data(4, "authored")
        calls = []
        real_fit = screen.fit
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "canonical-state"
            auth = SimpleNamespace(expected={}, evidence={"synthetic": True})

            def load_role(_auth, role):
                self.assertIs(_auth, auth)
                self.assertTrue((state / "run-started.json").exists())
                if role == "shared-train":
                    self.assertFalse((state / "recipe-frozen.json").exists())
                    return train
                # No external role may be decoded before BOTH freezes.
                self.assertTrue((state / "recipe-frozen.json").exists())
                self.assertTrue((state / "model-frozen.json").exists())
                self.assertEqual(len(calls), 13)
                frozen = json.loads((root / "out" / "decision.json").read_text())
                self.assertFalse(frozen["selectionUsesOuter"])
                self.assertFalse(frozen["nnueValidationDecoded"])
                self.assertFalse(frozen["nnueTestDecoded"])
                if role == "nnue-validation":
                    self.assertTrue((state / "validation-opened.json").exists())
                    self.assertFalse((state / "test-opened.json").exists())
                    return outer
                self.assertEqual(role, "nnue-test")
                self.assertTrue(permit_test)
                self.assertTrue((state / "selection-frozen.json").exists())
                self.assertTrue((state / "test-opened.json").exists())
                return test

            def fitted(config, seed, actual_train, validation, settings, deadline, epochs=None):
                if len(calls) < 12:
                    self.assertIs(actual_train, inner_train)
                    self.assertIs(validation, inner_validation)
                    self.assertFalse((state / "recipe-frozen.json").exists())
                else:
                    self.assertEqual(len(calls), 12)
                    self.assertIs(actual_train, train)
                    self.assertIsNone(validation)
                    frozen = json.loads((state / "recipe-frozen.json").read_text())
                    self.assertEqual((config, seed, epochs), (frozen["config"], frozen["seed"], frozen["epochs"]))
                    self.assertEqual(settings["epochs"], 4)
                result = real_fit(config, seed, actual_train, validation, settings, deadline, epochs)
                calls.append((config["id"], seed, epochs))
                return result

            def comparators(_auth, data):
                return {"shipped": np.zeros(data.rows), "expanded": np.zeros(data.rows)}

            with contextlib.ExitStack() as stack, contextlib.redirect_stdout(io.StringIO()):
                stack.enter_context(patch.object(screen, "implementation", return_value=(rules, {}, "synthetic-head")))
                stack.enter_context(patch.object(screen, "state_root", return_value=state))
                stack.enter_context(patch.object(screen.data_io, "authenticate", return_value=auth))
                load = stack.enter_context(patch.object(screen.data_io, "load_role", side_effect=load_role))
                stack.enter_context(patch.object(screen, "inner_split", return_value=(inner_train, inner_validation)))
                stack.enter_context(patch.object(screen, "authored_data", return_value=fixtures))
                stack.enter_context(patch.object(screen, "fit", side_effect=fitted))
                stack.enter_context(patch.object(screen.util, "comparator_predictions", side_effect=comparators))
                if permit_test:
                    stack.enter_context(patch.object(screen.util, "guard", return_value=[]))
                    stack.enter_context(patch.object(screen.util, "bootstrap", return_value={"ci95": [-.2, -.1]}))
                # All thirteen miniature fits, serialization, JavaScript parity,
                # metric computation and durable markers remain real code.
                screen.run(root / "synthetic-bundle", root / "out")
                self.assertEqual(len(calls), 13)
                expected_roles = ["shared-train", "nnue-validation"] + (["nnue-test"] if permit_test else [])
                self.assertEqual([call.args[1] for call in load.call_args_list], expected_roles)
                report = json.loads((root / "out" / "selection.json").read_text())
                self.assertEqual(len(report["runs"]), 12)
                self.assertEqual(report["testEligible"], permit_test)
                self.assertEqual(report["decision"]["config"]["hidden"], 4)
                self.assertFalse(report["runtimeIntegrationPerformed"])
                self.assertEqual(report["final"]["artifacts"]["binary"]["bytes"], 6180)
                for record in report["runs"]:
                    self.assertGreaterEqual(record["selectedEpoch"], 3)
                    self.assertEqual(record["epochsRun"], 4)
                    for check in record["checks"].values():
                        self.assertEqual(check["integerMismatches"], 0)
                self.assertEqual((root / "out" / "test.json").exists(), permit_test)
                if permit_test:
                    result = json.loads((root / "out" / "test.json").read_text())
                    self.assertTrue(result["offlinePass"])
                    self.assertFalse(result["runtimeIntegrationAllowed"])
                    self.assertFalse(result["formalPass"])
                reads_before = load.call_count
                with self.assertRaises(FileExistsError):
                    screen.run(root / "renamed-bundle", root / "renamed-output")
                self.assertEqual(load.call_count, reads_before)

    def test_thirteen_tiny_fits_stop_without_test_when_real_quality_guards_fail(self):
        self._end_to_end(permit_test=False)

    def test_thirteen_tiny_fits_freeze_before_external_roles_and_open_test_once(self):
        self._end_to_end(permit_test=True)


if __name__ == "__main__":
    unittest.main()
