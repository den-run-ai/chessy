#!/usr/bin/env python3
"""Authored-only v3 lifecycle checks; no source bundle or real roles are read."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
spec = importlib.util.spec_from_file_location("h4_v3_screen_test_subject", ROOT / "tools/training/natural-nnue-h4-v3.py")
screen = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = screen
spec.loader.exec_module(screen)
RULES = json.loads((ROOT / "eval/training/natural-nnue-h4-v3.json").read_text())


def authored_data(rows=12, role="shared-train"):
    """Tiny authored FENs span opening, middlegame, and endgame material."""
    fens = [
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r2qk2r/8/8/8/8/8/8/R3K2R b - - 0 1",
        "4k3/8/8/8/8/8/P7/4K3 w - - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
        "r3k2r/8/8/8/8/8/8/R2QK2R w - - 0 1",
        "4k3/p7/8/8/8/8/8/4K3 b - - 0 1",
    ]
    return screen.data_io.fit.Data(
        matrix=sparse.csr_matrix((rows, 965)), fixed_cp=np.zeros(rows),
        target=np.asarray([.6 if i % 2 == 0 else .4 for i in range(rows)]),
        teacher_cp=np.asarray([40 if i % 2 == 0 else -40 for i in range(rows)]),
        phase=np.asarray([screen.util.PHASES[i % 3] for i in range(rows)]),
        family=np.asarray([f"{role}:family-{i}" for i in range(rows)]),
        source=np.asarray([f"{role}:game-{i}" for i in range(rows)]),
        row_id=np.asarray([f"{role}:row-{i}" for i in range(rows)]),
        cluster=np.asarray([f"{role}:cluster-{i}" for i in range(rows)]),
        baseline_cp=np.zeros(rows, dtype=np.int64),
        fens=[fens[i % len(fens)] for i in range(rows)], role=role)


def miniature_rules():
    rules = copy.deepcopy(RULES)
    rules["training"].update(epochs=4, batchSize=4, checkpointEveryEpochs=1,
                             quantizationAwareStartEpoch=3, maximumElapsedTrainingSeconds=120)
    for config in rules["configurations"]:
        config["epochs"] = 4
    return rules


def phase_metrics(loss=.5, rows=100):
    return {"crossEntropy": loss,
            "byPhase": {phase: {"rows": rows, "crossEntropy": loss} for phase in screen.util.PHASES}}


def selection_records():
    records = []
    for index, config in enumerate(RULES["configurations"]):
        for seed, delta in zip(RULES["training"]["seeds"], (.01, 0, -.01)):
            loss = .4 + index * .01 + delta
            records.append({
                "config": copy.deepcopy(config), "seed": seed,
                "selectedInnerCe": loss, "epochsRun": config["epochs"],
                "selectedEpoch": config["epochs"] * 2 // 3 + 1,
                "checks": {role: {"reasons": [], "integerMismatches": 0}
                           for role in ("inner-train", "inner-validation", "authored")},
                "quality": {role: phase_metrics(loss) for role in ("inner-train", "inner-validation")}})
    return records


class H4V3ScreenTests(unittest.TestCase):
    def choose(self, records, comparators=None):
        return screen.choose(records, RULES["configurations"], RULES["training"]["seeds"],
                             comparators or {"shipped-hce": phase_metrics(.8), "frozen-expanded-hce": phase_metrics(.8)})

    def test_choose_requires_complete_unique_finite_numerically_valid_inventory(self):
        records = selection_records()
        chosen = self.choose(list(reversed(records)))
        self.assertEqual(chosen["config"], RULES["configurations"][0])
        self.assertEqual(chosen["seed"], RULES["training"]["seeds"][1])
        invalid = [
            ("missing", records[:-1]),
            ("extra", records + [copy.deepcopy(records[0])]),
            ("duplicate", records[:-1] + [copy.deepcopy(records[-2])]),
        ]
        for value in (float("nan"), float("inf"), -float("inf")):
            changed = copy.deepcopy(records)
            changed[0]["selectedInnerCe"] = value
            invalid.append((f"nonfinite-{value}", changed))
        for role in ("inner-train", "inner-validation"):
            changed = copy.deepcopy(records)
            changed[0]["quality"][role]["byPhase"]["endgame"]["crossEntropy"] = float("nan")
            invalid.append((f"nonfinite-{role}-phase-quality", changed))
        for role, reason in (("inner-train", "quantization-float-difference"),
                             ("inner-validation", "score-range"),
                             ("authored", "quantization-float-difference")):
            changed = copy.deepcopy(records)
            changed[0]["checks"][role]["reasons"] = [reason]
            invalid.append((f"{role}-{reason}", changed))
        changed = copy.deepcopy(records)
        changed[0]["checks"]["authored"]["integerMismatches"] = 1
        invalid.append(("integer-mismatch", changed))
        changed = copy.deepcopy(records)
        del changed[0]["checks"]["authored"]
        invalid.append(("missing-check", changed))
        changed = copy.deepcopy(records)
        changed[0]["selectedEpoch"] = changed[0]["config"]["epochs"] * 2 // 3
        invalid.append(("before-QAT", changed))
        changed = copy.deepcopy(records)
        changed[0]["selectedEpoch"] = changed[0]["config"]["epochs"] + 1
        invalid.append(("after-training-budget", changed))
        for name, candidate in invalid:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.choose(candidate)

    def test_choose_phase_filter_uses_shipped_comparator_without_in_sample_expanded_veto(self):
        records = selection_records()
        # All seeds in the leading recipe lack endgame coverage. The complete
        # recipe stays in the report, but the next eligible recipe is selected.
        for record in records[:3]:
            record["quality"]["inner-validation"]["byPhase"]["endgame"]["rows"] = 99
        result = self.choose(records)
        self.assertEqual(result["config"], RULES["configurations"][1])
        self.assertEqual(result["phaseRejected"][0]["config"], RULES["configurations"][0]["id"])
        self.assertIn("shipped-hce:endgame-coverage", result["phaseRejected"][0]["reasons"])
        result = self.choose(selection_records(), {"shipped-hce": phase_metrics(.8, 99), "frozen-expanded-hce": phase_metrics(.8)})
        self.assertIsNone(result["config"])
        self.assertEqual(result["stopReasons"], ["no-inner-phase-eligible-candidate"])
        self.assertEqual(len(result["phaseRejected"]), 6)
        # Expanded HCE was fitted on these inner rows; even an unbeatable
        # in-sample score or low comparator coverage must not veto selection.
        result = self.choose(selection_records(), {"shipped-hce": phase_metrics(.8),
                                                  "frozen-expanded-hce": phase_metrics(.001, 99)})
        self.assertEqual(result["config"], RULES["configurations"][0])
        self.assertEqual(result["phaseRejected"], [])
        # Strong aggregate loss cannot compensate for one regressing phase.
        records = selection_records()
        for record in records:
            record["quality"]["inner-validation"]["byPhase"]["endgame"]["crossEntropy"] = .81
        result = self.choose(records)
        self.assertIsNone(result["config"])
        self.assertTrue(all("shipped-hce:endgame-CE-guard" in r["reasons"] for r in result["phaseRejected"]))

    def test_dataset_registry_is_independent_of_contract_identity(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(screen, "ROOT", Path(temporary)):
            expected_key = hashlib.sha256((screen.SUMMARY_SHA + "\0nnue-test").encode()).hexdigest()
            registry = screen.test_registry()
            self.assertEqual(registry, Path(temporary) / ".research-state" / ("dataset-" + expected_key) / "test-opened.json")
            with patch.object(screen, "CONTRACT_SHA", "a-different-registered-experiment"):
                self.assertEqual(screen.test_registry(), registry)
            screen.reserve_test({"synthetic": True}, {})
            original = registry.read_bytes()
            with patch.object(screen, "CONTRACT_SHA", "another-contract"), self.assertRaises(FileExistsError):
                screen.reserve_test({"synthetic": "retry"}, {})
            self.assertEqual(registry.read_bytes(), original)

    def _end_to_end(self, open_after_screen):
        rules = miniature_rules()
        train = authored_data()
        inner_train = screen.subset(train, np.arange(9), "inner-train")
        inner_validation = screen.subset(train, np.arange(9, 12), "inner-validation")
        outer, test = authored_data(6, "nnue-validation"), authored_data(6, "nnue-test")
        fixtures = authored_data(6, "authored")
        fit_calls = []
        real_fit = screen.fit
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Retain real oracle execution while isolating every output and
            # legacy/current state marker from the actual research checkout.
            (root / "test").symlink_to(ROOT / "test", target_is_directory=True)
            auth = SimpleNamespace(expected={}, evidence={"synthetic": True})
            output = root / "out"
            bundle = root / "synthetic-bundle"
            with contextlib.ExitStack() as stack, contextlib.redirect_stdout(io.StringIO()):
                stack.enter_context(patch.object(screen, "ROOT", root))
                state = screen.state_root()

                def load_role(actual_auth, role):
                    self.assertIs(actual_auth, auth)
                    self.assertTrue((state / "run-started.json").exists())
                    if role == "shared-train":
                        self.assertFalse((state / "recipe-frozen.json").exists())
                        return train
                    self.assertTrue((state / "recipe-frozen.json").exists())
                    self.assertTrue((state / "model-frozen.json").exists())
                    self.assertEqual(len(fit_calls), 19)
                    frozen = json.loads((output / "decision.json").read_text())
                    self.assertFalse(frozen["selectionUsesOuter"])
                    self.assertFalse(frozen["nnueValidationDecoded"])
                    self.assertFalse(frozen["nnueTestDecoded"])
                    if role == "nnue-validation":
                        self.assertTrue((state / "validation-opened.json").exists())
                        self.assertFalse(screen.test_registry().exists())
                        return outer
                    self.assertEqual(role, "nnue-test")
                    self.assertTrue(open_after_screen)
                    self.assertTrue((state / "selection-frozen.json").exists())
                    self.assertTrue(screen.test_registry().exists())
                    marker = json.loads(screen.test_registry().read_text())
                    self.assertEqual(marker["summarySha256"], screen.SUMMARY_SHA)
                    self.assertEqual(marker["role"], "nnue-test")
                    self.assertEqual(marker["selectionSha256"], screen.digest((output / "selection.json").read_bytes()))
                    self.assertFalse((output / "test.json").exists())
                    return test

                def fitted(config, seed, actual_train, validation, settings, deadline, epochs=None):
                    self.assertEqual(settings["epochs"], 4)
                    self.assertEqual(settings["quantizationAwareStartEpoch"], 3)
                    if len(fit_calls) < 18:
                        self.assertIs(actual_train, inner_train)
                        self.assertIs(validation, inner_validation)
                        self.assertFalse((state / "recipe-frozen.json").exists())
                    else:
                        self.assertEqual(len(fit_calls), 18)
                        self.assertIs(actual_train, train)
                        self.assertIsNone(validation)
                        frozen = json.loads((state / "recipe-frozen.json").read_text())
                        self.assertEqual((config, seed, epochs), (frozen["config"], frozen["seed"], frozen["epochs"]))
                        self.assertFalse((state / "model-frozen.json").exists())
                    result = real_fit(config, seed, actual_train, validation, settings, deadline, epochs)
                    fit_calls.append((config["id"], seed, epochs))
                    return result

                stack.enter_context(patch.object(screen, "implementation", return_value=(rules, {}, "synthetic-head")))
                stack.enter_context(patch.object(screen.data_io, "authenticate", return_value=auth))
                load = stack.enter_context(patch.object(screen.data_io, "load_role", side_effect=load_role))
                stack.enter_context(patch.object(screen, "inner_split", return_value=(inner_train, inner_validation)))
                stack.enter_context(patch.object(screen, "authored_data", return_value=fixtures))
                stack.enter_context(patch.object(screen, "fit", side_effect=fitted))
                stack.enter_context(patch.object(screen.util, "comparator_predictions", side_effect=lambda _auth, data: {
                    "shipped-hce": np.zeros(data.rows), "frozen-expanded-hce": np.zeros(data.rows)}))
                # Only statistical eligibility is bypassed for miniature rows;
                # optimization, numeric guards, both JS oracles, serialization,
                # metrics, candidate selection, and durable markers stay real.
                stack.enter_context(patch.object(screen, "phase_guard", return_value=[]))
                stack.enter_context(patch.object(screen.util, "guard", return_value=[]))
                stack.enter_context(patch.object(screen.util, "bootstrap", return_value={"ci95": [-.2, -.1]}))
                screen.run(bundle, output)
                self.assertEqual(len(fit_calls), 19)
                self.assertEqual([call.args[1] for call in load.call_args_list], ["shared-train", "nnue-validation"])
                report = json.loads((output / "selection.json").read_text())
                self.assertEqual(len(report["runs"]), 18)
                self.assertTrue(report["testEligible"])
                self.assertFalse(report["testOpened"])
                self.assertFalse(report["runtimeIntegrationPerformed"])
                self.assertFalse((output / "test.json").exists())
                self.assertFalse(screen.test_registry().exists())
                self.assertEqual(len(report["ablations"]), 5)
                self.assertEqual({record["config"]["hidden"] for record in report["runs"]}, {4, 8})
                for record in report["runs"]:
                    self.assertGreaterEqual(record["selectedEpoch"], 3)
                    self.assertEqual(record["epochsRun"], 4)
                    self.assertEqual([point["qat"] for point in record["curves"]], [False, False, True, True])
                    for check in record["checks"].values():
                        self.assertEqual(check["integerMismatches"], 0)
                        self.assertEqual(check["reasons"], [])
                if open_after_screen:
                    # A restored v1/v2 marker blocks opening this v3 candidate
                    # before any decoding and before a new registry is created.
                    legacy = root / ".research-state" / "authored-legacy-contract" / "test-opened.json"
                    legacy.parent.mkdir()
                    legacy.write_text('{"syntheticLegacyOpening":true}\n')
                    reads = load.call_count
                    with self.assertRaisesRegex(FileExistsError, "legacy"):
                        screen.open_test(bundle, output)
                    self.assertEqual(load.call_count, reads)
                    self.assertFalse(screen.test_registry().exists())
                    self.assertFalse((output / "test.json").exists())
                    legacy.unlink()  # Remove only this authored blocked-case fixture.
                    screen.open_test(bundle, output)
                    self.assertEqual([call.args[1] for call in load.call_args_list],
                                     ["shared-train", "nnue-validation", "nnue-test"])
                    result = json.loads((output / "test.json").read_text())
                    self.assertTrue(result["offlinePass"])
                    self.assertFalse(result["runtimeIntegrationAllowed"])
                    self.assertFalse(result["formalPass"])
                    self.assertTrue((state / "test-completed.json").exists())
                    preserved = {path: path.read_bytes() for path in (screen.test_registry(), output / "test.json")}
                    reads = load.call_count
                    with self.assertRaises(FileExistsError):
                        screen.open_test(bundle, output)
                    self.assertEqual(load.call_count, reads)
                    self.assertEqual({path: path.read_bytes() for path in preserved}, preserved)
                reads = load.call_count
                with self.assertRaises(FileExistsError):
                    screen.run(root / "renamed-bundle", root / "renamed-output")
                self.assertEqual(load.call_count, reads)

    def test_nineteen_real_mini_fits_never_open_test_during_eligible_screen(self):
        self._end_to_end(open_after_screen=False)

    def test_separate_test_open_rejects_legacy_marker_then_marks_before_one_decode(self):
        self._end_to_end(open_after_screen=True)


if __name__ == "__main__":
    unittest.main()
