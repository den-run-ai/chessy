#!/usr/bin/env python3
"""Authored-only factorial/budget orchestration; no source archive is opened."""
import contextlib
import copy
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
spec = importlib.util.spec_from_file_location("h4_v4_screen_test_subject", ROOT / "tools/training/natural-nnue-h4-v4.py")
screen = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = screen
spec.loader.exec_module(screen)
shared = screen.shared
RULES = json.loads((ROOT / "eval/training/natural-nnue-h4-v4.json").read_text())


def authored_data(rows=12, role="shared-train"):
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
        phase=np.asarray([shared.util.PHASES[i % 3] for i in range(rows)]),
        family=np.asarray([f"{role}:family-{i}" for i in range(rows)]),
        source=np.asarray([f"{role}:game-{i}" for i in range(rows)]),
        row_id=np.asarray([f"{role}:row-{i}" for i in range(rows)]),
        cluster=np.asarray([f"{role}:cluster-{i}" for i in range(rows)]),
        baseline_cp=np.zeros(rows, dtype=np.int64), fens=[fens[i % 6] for i in range(rows)], role=role)


def miniature_rules():
    rules = copy.deepcopy(RULES)
    rules["training"].update(epochs=4, batchSize=4, checkpointEveryEpochs=1,
                             quantizationAwareStartEpoch=3, maximumElapsedTrainingSeconds=120)
    for config in rules["configurations"]:
        config["epochs"] = 4
    rules["budgetStage"].update(epochs=[6, 9], baselineEpochs=4, extensionEpochs=[])
    return rules


def phase_metrics(loss):
    return {"crossEntropy": loss,
            "byPhase": {phase: {"rows": 100, "crossEntropy": loss} for phase in shared.util.PHASES}}


def budget_records(medians=(.5004, .5, .5001)):
    configs = [screen.budget_config(RULES["configurations"][0], epochs) for epochs in (300, 900, 1800)]
    records = []
    for config, median in zip(configs, medians):
        for seed, delta, epoch_fraction in zip(RULES["training"]["seeds"], (.01, -.01, 0), (.7, .9, .8)):
            records.append({"config": copy.deepcopy(config), "seed": seed, "selectedInnerCe": median + delta,
                            "epochsRun": config["epochs"], "selectedEpoch": int(config["epochs"] * epoch_fraction),
                            "checks": {role: {"integerMismatches": 0, "reasons": []}
                                       for role in ("inner-train", "inner-validation", "authored")},
                            "quality": {role: phase_metrics(median + delta)
                                        for role in ("inner-train", "inner-validation")}})
    return configs, records


class V4ScreenTests(unittest.TestCase):
    def choose_budget(self, configurations, records):
        return screen.choose_budget(records, configurations, RULES["training"]["seeds"],
                                    {"shipped-hce": phase_metrics(.8), "frozen-expanded-hce": phase_metrics(.01)}, .001)

    def test_budget_selection_uses_shortest_near_best_and_its_own_median_seed(self):
        configurations, records = budget_records()
        result = self.choose_budget(configurations, list(reversed(records)))
        self.assertEqual(result["config"], configurations[0])
        self.assertEqual(result["bestEligibleBudgetMedianCe"], .5)
        self.assertEqual(result["medianInnerCe"], .5004)
        self.assertEqual(result["seed"], RULES["training"]["seeds"][2])
        self.assertEqual(result["epochs"], 240)
        self.assertEqual(result["innerRepresentativeEpoch"], 240)
        self.assertFalse(result["convergenceClaimed"])
        configurations, records = budget_records((.5006, .5001, .5))
        result = self.choose_budget(configurations, records)
        self.assertEqual(result["config"], configurations[1])
        self.assertEqual(result["epochs"], 720)
        self.assertEqual(result["seed"], RULES["training"]["seeds"][2])
        self.assertEqual(screen.budget_config(configurations[0], 6)["id"], "h4-single-eg1-e6")

    def test_numerically_invalid_losing_budget_rejects_the_entire_inventory(self):
        configs, original = budget_records()
        invalid = []
        changed = copy.deepcopy(original)
        changed[-1]["checks"]["authored"]["reasons"] = ["quantization-float-difference"]
        invalid.append(changed)
        changed = copy.deepcopy(original)
        changed[-1]["checks"]["inner-validation"]["integerMismatches"] = 1
        invalid.append(changed)
        changed = copy.deepcopy(original)
        changed[-1]["selectedInnerCe"] = float("nan")
        invalid.append(changed)
        invalid += [original[:-1], original[:-1] + [copy.deepcopy(original[-2])]]
        for records in invalid:
            with self.assertRaises(ValueError):
                self.choose_budget(configs, records)

    def test_extension_requires_material_gain_and_distinguishes_plateau_from_caps(self):
        comparators = {"shipped-hce": phase_metrics(.8), "frozen-expanded-hce": phase_metrics(.01)}
        seeds = RULES["training"]["seeds"]
        configs, improving = budget_records((.6, .5, .4))
        result = screen.extension_decision(improving, configs, seeds, comparators, .001, [3600, 7200])
        self.assertEqual(result["extendTo"], 3600)
        self.assertFalse(result["saturationReached"])
        self.assertAlmostEqual(result["latestRelativeImprovement"], .2)
        configs, plateau = budget_records((.6, .5, .49975))
        result = screen.extension_decision(plateau, configs, seeds, comparators, .001, [3600, 7200])
        self.assertIsNone(result["extendTo"])
        self.assertTrue(result["saturationReached"])
        self.assertAlmostEqual(result["latestRelativeImprovement"], .0005)
        plateau_reason = result["endReason"]
        configs, improving = budget_records((.6, .5, .4))
        for remaining, time_capped in (([], False), ([3600, 7200], True)):
            with self.subTest(remaining=remaining, time_capped=time_capped):
                result = screen.extension_decision(improving, configs, seeds, comparators, .001,
                                                   remaining, time_capped=time_capped)
                self.assertIsNone(result["extendTo"])
                self.assertFalse(result["saturationReached"])
                self.assertNotEqual(result["endReason"], plateau_reason)
        invalid = copy.deepcopy(improving)
        invalid[-1]["checks"]["authored"]["reasons"] = ["quantization-float-difference"]
        with self.assertRaises(ValueError):
            screen.extension_decision(invalid, configs, seeds, comparators, .001, [3600, 7200])

    def _lifecycle(self, reject_inner=False):
        rules = miniature_rules()
        train = authored_data()
        inner_train = shared.subset(train, np.arange(9), "inner-train")
        inner_validation = shared.subset(train, np.arange(9, 12), "inner-validation")
        outer, test, fixtures = (authored_data(6, role) for role in ("nnue-validation", "nnue-test", "authored"))
        fit_calls, markers = [], []
        real_fit, real_reserve = shared.fit, shared.reserve
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "test").symlink_to(ROOT / "test", target_is_directory=True)
            output, bundle = root / "out", root / "synthetic-bundle"
            auth = SimpleNamespace(expected={}, evidence={"synthetic": True})
            with contextlib.ExitStack() as stack, contextlib.redirect_stdout(io.StringIO()):
                stack.enter_context(patch.object(shared, "ROOT", root))
                state = shared.state_root()

                def reserve(kind, value, expected):
                    if kind == "architecture-frozen":
                        self.assertEqual(len(fit_calls), 24)
                    elif kind == "recipe-frozen":
                        self.assertEqual(len(fit_calls), 24 if reject_inner else 30)
                    elif kind in ("model-frozen", "validation-opened"):
                        self.assertEqual(len(fit_calls), 31)
                    markers.append(kind)
                    return real_reserve(kind, value, expected)

                def fitted(config, seed, actual_train, validation, settings, deadline, epochs=None):
                    self.assertEqual(settings["epochs"], config["epochs"])
                    self.assertEqual(settings["quantizationAwareStartEpoch"], config["epochs"] * 2 // 3 + 1)
                    if len(fit_calls) < 30:
                        self.assertIs(actual_train, inner_train)
                        self.assertIs(validation, inner_validation)
                        self.assertFalse((state / "recipe-frozen.json").exists())
                        if len(fit_calls) < 24:
                            self.assertFalse((state / "architecture-frozen.json").exists())
                            self.assertEqual(config["epochs"], 4)
                        else:
                            frozen = json.loads((state / "architecture-frozen.json").read_text())
                            self.assertEqual(config, screen.budget_config(frozen["config"], config["epochs"]))
                            self.assertIn(config["epochs"], [6, 9])
                    else:
                        self.assertEqual(len(fit_calls), 30)
                        self.assertIs(actual_train, train)
                        self.assertIsNone(validation)
                        frozen = json.loads((state / "recipe-frozen.json").read_text())
                        self.assertEqual((config, seed, epochs), (frozen["config"], frozen["seed"], frozen["epochs"]))
                        self.assertFalse((state / "model-frozen.json").exists())
                    result = real_fit(config, seed, actual_train, validation, settings, deadline, epochs)
                    fit_calls.append((config, seed, epochs))
                    return result

                def load_role(actual_auth, role):
                    self.assertIs(actual_auth, auth)
                    self.assertTrue((state / "run-started.json").exists())
                    if role == "shared-train":
                        self.assertEqual(fit_calls, [])
                        self.assertFalse((state / "architecture-frozen.json").exists())
                        return train
                    self.assertFalse(reject_inner)
                    self.assertEqual(len(fit_calls), 31)
                    self.assertTrue((state / "architecture-frozen.json").exists())
                    self.assertTrue((state / "recipe-frozen.json").exists())
                    self.assertTrue((state / "model-frozen.json").exists())
                    decision = json.loads((output / "decision.json").read_text())
                    self.assertFalse(decision["selectionUsesOuter"])
                    self.assertFalse(decision["nnueValidationDecoded"])
                    self.assertFalse(decision["nnueTestDecoded"])
                    if role == "nnue-validation":
                        self.assertTrue((state / "validation-opened.json").exists())
                        self.assertFalse(shared.test_registry().exists())
                        return outer
                    self.assertEqual(role, "nnue-test")
                    self.assertTrue((state / "selection-frozen.json").exists())
                    self.assertTrue(shared.test_registry().exists())
                    marker = json.loads(shared.test_registry().read_text())
                    self.assertEqual(marker["selectionSha256"], screen.digest((output / "selection.json").read_bytes()))
                    self.assertEqual(marker["contractSha256"], screen.CONTRACT_SHA)
                    self.assertEqual(marker["summarySha256"], shared.SUMMARY_SHA)
                    self.assertFalse((output / "test.json").exists())
                    return test

                frozen_implementation = (rules, {}, "synthetic-v4-head")
                stack.enter_context(patch.object(screen, "implementation", return_value=frozen_implementation))
                stack.enter_context(patch.object(shared, "implementation", return_value=frozen_implementation))
                stack.enter_context(patch.object(screen.data_io, "authenticate", return_value=auth))
                load = stack.enter_context(patch.object(screen.data_io, "load_role", side_effect=load_role))
                stack.enter_context(patch.object(shared, "inner_split", return_value=(inner_train, inner_validation)))
                stack.enter_context(patch.object(shared, "authored_data", return_value=fixtures))
                stack.enter_context(patch.object(shared, "fit", side_effect=fitted))
                stack.enter_context(patch.object(shared, "reserve", side_effect=reserve))
                stack.enter_context(patch.object(shared, "phase_guard", return_value=["authored-coverage"] if reject_inner else []))
                stack.enter_context(patch.object(shared.util, "comparator_predictions", side_effect=lambda _auth, data: {
                    "shipped-hce": np.zeros(data.rows), "frozen-expanded-hce": np.zeros(data.rows)}))
                stack.enter_context(patch.object(shared.util, "guard", return_value=[]))
                stack.enter_context(patch.object(shared.util, "bootstrap", return_value={"ci95": [-.2, -.1]}))
                # All fits, adapter objectives, numerical gates, JS oracles,
                # serialization, metric reports, and state transitions are real.
                screen.run(bundle, output)
                report = json.loads((output / "selection.json").read_text())
                self.assertEqual(report["factorialDecision"],
                                 json.loads((state / "architecture-frozen.json").read_text()))
                self.assertFalse(report["testOpened"])
                self.assertFalse(shared.test_registry().exists())
                self.assertFalse((output / "test.json").exists())
                self.assertFalse(report["runtimeIntegrationPerformed"])
                self.assertFalse(report["productionFitAllowed"])
                self.assertEqual(report["auditEvidence"], {"synthetic": True})
                self.assertEqual(report["inputSha256"], {})
                self.assertEqual(report["innerRows"], {"train": 9, "validation": 3})
                self.assertGreater(report["elapsedSeconds"], 0)
                self.assertEqual(len(report["factorialAblations"]), 12)
                if reject_inner:
                    self.assertEqual(len(fit_calls), 24)
                    self.assertEqual(len(report["runs"]), 24)
                    self.assertEqual([call.args[1] for call in load.call_args_list], ["shared-train"])
                    self.assertFalse(report["testEligible"])
                    self.assertIsNone(report["decision"]["config"])
                    self.assertNotIn("final", report)
                    self.assertFalse((state / "model-frozen.json").exists())
                    self.assertFalse((state / "validation-opened.json").exists())
                    reads = load.call_count
                    with self.assertRaises(ValueError):
                        shared.open_test(bundle, output)
                    self.assertEqual(load.call_count, reads)
                    return
                self.assertEqual(len(fit_calls), 31)
                self.assertEqual(len(report["runs"]), 30)
                self.assertTrue(report["testEligible"])
                self.assertEqual([call.args[1] for call in load.call_args_list], ["shared-train", "nnue-validation"])
                self.assertEqual(markers, ["run-started", "architecture-frozen", "recipe-frozen", "model-frozen",
                                           "validation-opened", "selection-frozen"])
                for record in report["runs"]:
                    self.assertGreater(record["selectedEpoch"], record["config"]["epochs"] * 2 // 3)
                    self.assertEqual(record["epochsRun"], record["config"]["epochs"])
                    for check in record["checks"].values():
                        self.assertEqual(check["integerMismatches"], 0)
                        self.assertEqual(check["reasons"], [])
                shared.open_test(bundle, output)
                self.assertEqual([call.args[1] for call in load.call_args_list], ["shared-train", "nnue-validation", "nnue-test"])
                result = json.loads((output / "test.json").read_text())
                self.assertTrue(result["offlinePass"])
                self.assertFalse(result["runtimeIntegrationAllowed"])
                self.assertFalse(result["formalPass"])
                self.assertTrue((state / "test-completed.json").exists())
                reads = load.call_count
                with self.assertRaises(FileExistsError):
                    shared.open_test(bundle, output)
                self.assertEqual(load.call_count, reads)
                with self.assertRaises(FileExistsError):
                    screen.run(root / "renamed-bundle", root / "renamed-output")
                self.assertEqual(load.call_count, reads)

    def test_31_real_mini_fits_freeze_architecture_before_budgets_then_open_test_separately(self):
        self._lifecycle()

    def test_no_inner_candidate_stops_after_24_fits_without_outer_or_test(self):
        self._lifecycle(reject_inner=True)


if __name__ == "__main__":
    unittest.main()
