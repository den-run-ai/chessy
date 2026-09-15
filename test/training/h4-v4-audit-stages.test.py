#!/usr/bin/env python3
"""Authored aggregate receipts only; no trainer, models, fitting or row data."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("v4_stage_audit", ROOT / "tools/training/h4_v4_audit_stages.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
RULES = json.loads((ROOT / "eval/training/natural-nnue-h4-v4.json").read_text())
SEEDS = RULES["training"]["seeds"]
META = {"head": "authored-head", "contractSha256": "authored-contract", "selectionUsesOuter": False}


def quality(ce=.5):
    return {"rows": 600, "crossEntropy": ce,
            "byPhase": {phase: {"rows": 200, "crossEntropy": ce} for phase in m.PHASES}}


def records(config, ce, rejected=False):
    result = []
    for seed, offset, fraction in zip(SEEDS, (-.01, .01, 0), (.7, .9, .8)):
        epoch = int(config["epochs"] * fraction)
        result.append({"config": copy.deepcopy(config), "seed": seed, "selectedInnerCe": ce + offset,
                       "epochsRun": config["epochs"], "selectedEpoch": epoch,
                       "checks": {role: {"integerMismatches": 0, "reasons": []}
                                  for role in ("inner-train", "inner-validation", "authored")},
                       "quality": {role: quality(1.1 if rejected else ce + offset)
                                   for role in ("inner-train", "inner-validation")}})
    return result


def base_decision(config, ce, rejected=None):
    epoch = int(config["epochs"] * .8)
    return {"config": copy.deepcopy(config), "seed": SEEDS[2], "epochs": epoch,
            "medianInnerCe": ce, "innerRepresentativeEpoch": epoch, "phaseRejected": rejected or []}


def fixture(medians=(.5, .49, .4899), reject_factorial=False, reject_latest=False, time_cap=False):
    configs = RULES["configurations"]
    all_records = []
    for index, config in enumerate(configs):
        all_records += records(config, medians[0] if index == 0 else .55 + index * .01, reject_factorial)
    rejection = [{"config": config["id"], "reasons": ["shipped-hce:" + phase + "-CE-guard" for phase in m.PHASES]}
                 for config in configs] if reject_factorial else []
    first = ({"config": None, "stopReasons": ["no-inner-phase-eligible-candidate"], "phaseRejected": rejection}
             if reject_factorial else base_decision(configs[0], medians[0]))
    first.update(META)
    receipts = {"factorial-decision.json": copy.deepcopy(first)}
    summary = {**META, "factorialDecision": copy.deepcopy(first), "runs": all_records,
               "comparators": {"inner-validation": {"shipped-hce": quality(1.), "frozen-expanded-hce": quality(.01)}},
               "factorialAblations": m.factorial_ablations(all_records), "budgetProgression": [],
               "elapsedSeconds": RULES["training"]["maximumElapsedTrainingSeconds"] + 1 if time_cap else 1.,
               "testEligible": False, "stopReasons": []}
    empty = {"extendTo": None, "saturationReached": False, "latestRelativeImprovement": None,
             "endReason": "no-inner-phase-eligible-candidate", "boundedRecipeOnly": True, "convergenceClaimed": False}
    if reject_factorial:
        decision = copy.deepcopy(first)
        saturation = empty
        summary["stopReasons"] = ["no-inner-phase-eligible-candidate"]
    else:
        epochs = [300, 900, 1800, 3600, 7200][:len(medians)]
        budgets = [m.budget_config(configs[0], epoch) for epoch in epochs]
        for index in range(1, len(budgets)):
            all_records += records(budgets[index], medians[index], reject_latest and index == len(budgets) - 1)
        for count in range(3, len(budgets) + 1):
            ended = count == len(budgets)
            latest_rejected = reject_latest and ended
            eligible = [(epoch, median) for epoch, median in zip(epochs[:count], medians[:count])
                        if not (latest_rejected and epoch == epochs[count - 1])]
            best = min(ce for _, ce in eligible)
            selected_epoch, selected_ce = min((item for item in eligible if item[1] <= best * 1.001), key=lambda item: item[0])
            rejected = ([{"config": budgets[count - 1]["id"], "reasons": ["shipped-hce:" + phase + "-CE-guard" for phase in m.PHASES]}]
                        if latest_rejected else [])
            chosen = budgets[epochs.index(selected_epoch)]
            decision = {**base_decision(chosen, selected_ce), "bestEligibleBudgetMedianCe": best,
                        "relativeBudgetTolerance": .001,
                        "eligibleBudgetMedians": [{"epochs": epoch, "medianInnerCe": ce} for epoch, ce in eligible],
                        "allBudgetPhaseRejected": rejected, "convergenceClaimed": False}
            saturation = {**empty, "endReason": None}
            if time_cap and ended:
                saturation["endReason"] = "registered-time-cap"
            elif latest_rejected:
                saturation["endReason"] = "latest-budget-phase-guard"
            else:
                gain = 1 - medians[count - 1] / min(medians[:count - 1])
                saturation["latestRelativeImprovement"] = gain
                if gain <= .001:
                    saturation.update(endReason="bounded-budget-plateau", saturationReached=True)
                elif count == 5:
                    saturation["endReason"] = "maximum-epoch-budget-reached"
                else:
                    saturation.update(endReason="continue-registered-extension", extendTo=[3600, 7200][count - 3])
            progression = {"completedBudgets": epochs[:count], **saturation}
            summary["budgetProgression"].append(progression)
            receipts["budget-progression-" + str(epochs[count - 1]) + ".json"] = copy.deepcopy(progression)
        if time_cap:
            decision = {"config": None, "bestCompletedDecision": decision, "stopReasons": ["registered-time-cap"]}
            summary["stopReasons"] = ["registered-time-cap"]
        else:
            summary["final"] = {"fit": {"config": copy.deepcopy(decision["config"]), "seed": decision["seed"],
                                      "epochsRun": decision["epochs"], "selectedEpoch": decision["epochs"], "selectedInnerCe": None}}
            summary["testEligible"] = True
    decision.update(META, nnueValidationDecoded=False, nnueTestDecoded=False)
    summary.update(decision=decision, saturation=saturation, saturationReached=saturation["saturationReached"], endReason=saturation["endReason"])
    receipts["decision.json"] = copy.deepcopy(decision)
    return summary, receipts


class StageAuditTests(unittest.TestCase):
    def audit(self, summary, receipts):
        requested = []
        def reader(path):
            self.assertNotIn("test", path)
            requested.append(path)
            return copy.deepcopy(receipts[path])
        result = m.audit_stages(summary, RULES, reader)
        self.assertEqual(set(result), {"decision", "factorialDecision", "saturation", "factorialAblations"})
        self.assertEqual(set(requested), set(receipts))
        return result

    def test_plateau_picks_shortest_near_best_and_its_median_seed(self):
        summary, receipts = fixture()
        result = self.audit(summary, receipts)
        self.assertEqual(len(summary["runs"]), 30)
        self.assertEqual(result["decision"]["config"]["epochs"], 900)
        self.assertEqual(result["decision"]["seed"], SEEDS[2])
        self.assertEqual(result["decision"]["epochs"], 720)
        self.assertEqual(result["saturation"]["endReason"], "bounded-budget-plateau")
        self.assertTrue(result["saturation"]["saturationReached"])

    def test_registered_extensions_plateau_and_maximum_cap_are_distinct(self):
        for medians, reason, count in (((.5, .49, .48, .4801), "bounded-budget-plateau", 33),
                                      ((.5, .49, .48, .47, .46), "maximum-epoch-budget-reached", 36)):
            with self.subTest(reason=reason):
                summary, receipts = fixture(medians)
                result = self.audit(summary, receipts)
                self.assertEqual(len(summary["runs"]), count)
                self.assertEqual(result["saturation"]["endReason"], reason)
                self.assertEqual(result["saturation"]["saturationReached"], "plateau" in reason)

    def test_no_candidate_preserves_frozen_factorial_receipt_without_alias(self):
        summary, receipts = fixture(reject_factorial=True)
        result = self.audit(summary, receipts)
        self.assertIsNone(result["decision"]["config"])
        self.assertNotIn("nnueValidationDecoded", result["factorialDecision"])
        summary["factorialDecision"]["nnueValidationDecoded"] = False
        with self.assertRaises(AssertionError):
            self.audit(summary, receipts)

    def test_latest_phase_failure_and_consistent_time_cap_stop_without_saturation(self):
        summary, receipts = fixture(reject_latest=True)
        result = self.audit(summary, receipts)
        self.assertEqual(result["decision"]["config"]["epochs"], 900)
        self.assertEqual(result["saturation"]["endReason"], "latest-budget-phase-guard")
        summary, receipts = fixture(time_cap=True)
        result = self.audit(summary, receipts)
        self.assertIsNone(result["decision"]["config"])
        self.assertIn("bestCompletedDecision", result["decision"])
        self.assertFalse(result["saturation"]["saturationReached"])
        summary["elapsedSeconds"] = RULES["training"]["maximumElapsedTrainingSeconds"]
        with self.assertRaises(AssertionError):
            self.audit(summary, receipts)

    def test_shortest_tolerance_equality_and_plateau_equality(self):
        configs = [m.budget_config(RULES["configurations"][0], epoch) for epoch in (300, 900, 1800)]
        boundary = .5 * (1 + .001)
        runs = sum((records(config, ce) for config, ce in zip(configs, (boundary, .5, .5001))), [])
        selected = m.choose_budget(runs, configs, SEEDS, quality(1.), .001)
        self.assertEqual(selected["config"]["epochs"], 300)
        for record in runs[:3]:
            record["selectedInnerCe"] += 1e-9
        self.assertEqual(m.choose_budget(runs, configs, SEEDS, quality(1.), .001)["config"]["epochs"], 900)
        # Use an exactly representable binary fraction to inspect <= itself;
        # the production contract's 0.001 remains an exact float comparison.
        decision = {"eligibleBudgetMedians": [{"epochs": 300, "medianInnerCe": 1.}, {"epochs": 1800, "medianInnerCe": .875}]}
        result = m.progression_decision(decision, [300, 1800], [3600], .125, False)
        self.assertTrue(result["saturationReached"])
        self.assertIsNone(result["extendTo"])

    def test_inventory_order_recipe_and_progression_mutations_fail_closed(self):
        original, original_receipts = fixture((.5, .49, .48, .47, .46))
        mutations = [
            lambda s, r: s["runs"].pop(),
            lambda s, r: s["runs"].__setitem__(25, copy.deepcopy(s["runs"][24])),
            lambda s, r: s["runs"].__setitem__(slice(0, 2), list(reversed(s["runs"][:2]))),
            lambda s, r: s["runs"][24]["config"].update(hidden=8),
            lambda s, r: s["runs"][24].update(selectedInnerCe=float("nan")),
            lambda s, r: s["runs"][24]["checks"]["authored"].update(integerMismatches=1),
            lambda s, r: s["budgetProgression"].pop(1),
            lambda s, r: s["budgetProgression"][0].update(completedBudgets=[300, 1800, 900]),
            lambda s, r: s["budgetProgression"][0].update(extendTo=7200),
            lambda s, r: s["budgetProgression"][1].update(saturationReached=True),
            lambda s, r: r["budget-progression-1800.json"].update(extendTo=None),
            lambda s, r: r["factorial-decision.json"].update(seed=SEEDS[0]),
            lambda s, r: r["decision.json"].update(selectionUsesOuter=True),
            lambda s, r: s["factorialAblations"][0].update(relativeRightMedianImprovement=99.),
            lambda s, r: s["final"]["fit"].update(seed=SEEDS[0]),
        ]
        for mutation in mutations:
            summary, receipts = copy.deepcopy(original), copy.deepcopy(original_receipts)
            mutation(summary, receipts)
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                self.audit(summary, receipts)
        # A terminal plateau cannot be followed by an otherwise valid budget.
        summary, receipts = fixture()
        summary["runs"] += records(m.budget_config(RULES["configurations"][0], 3600), .47)
        with self.assertRaises(AssertionError):
            self.audit(summary, receipts)


if __name__ == "__main__":
    unittest.main()
