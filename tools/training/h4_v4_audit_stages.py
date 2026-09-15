"""Independent v4 selection replay from already-audited aggregate records.

No training/model imports, filesystem access, or row-level data. The caller
authenticates the contract/checkpoints and supplies a run-directory JSON reader.
Wall-clock time cannot be reconstructed: a time-cap receipt is accepted only
as an explicitly inherited claim consistent with the completion elapsed time.
"""
from __future__ import annotations

import copy
import math
import statistics

PHASES = ("opening", "middlegame", "endgame")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def same(actual, expected, where):
    """Strict structural identity; allow only scalar reduction roundoff."""
    if isinstance(expected, dict):
        require(isinstance(actual, dict) and actual.keys() == expected.keys(), where + ": fields differ")
        for key, value in expected.items():
            same(actual[key], value, where + "." + key)
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(actual) == len(expected), where + ": inventory differs")
        for index, (left, right) in enumerate(zip(actual, expected)):
            same(left, right, where + "." + str(index))
    elif type(expected) is float:
        require(type(actual) in (int, float) and math.isfinite(actual)
                and math.isclose(actual, expected, rel_tol=2e-10, abs_tol=2e-10), where + ": value differs")
    else:
        require(type(actual) is type(expected) and actual == expected, where + ": value differs")


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_metric(metric, where):
    require(isinstance(metric, dict), where + ": metric object required")
    require(all(finite(value) for key, value in metric.items() if key != "byPhase"),
            where + ": nonfinite metric")
    require(finite(metric.get("crossEntropy")) and metric["crossEntropy"] >= 0, where + ": invalid CE")


def gate(baseline, candidate):
    reasons = []
    for phase in PHASES:
        a, b = baseline["byPhase"][phase], candidate["byPhase"][phase]
        validate_metric(a, "baseline " + phase)
        validate_metric(b, "candidate " + phase)
        if min(a["rows"], b["rows"]) < 100:
            reasons.append("shipped-hce:" + phase + "-coverage")
        elif b["crossEntropy"] > a["crossEntropy"] * 1.01:
            reasons.append("shipped-hce:" + phase + "-CE-guard")
    return reasons


def choose(records, configs, seeds, baseline):
    require(len(records) == len(configs) * len(seeds), "development inventory differs")
    choices, rejected = [], []
    for index, config in enumerate(configs):
        group = [record for record in records if record["config"] == config]
        require(sorted(record["seed"] for record in group) == sorted(seeds), "missing/duplicate/foreign seed")
        for record in group:
            require(finite(record["selectedInnerCe"]) and record["selectedInnerCe"] > 0, "invalid selected CE")
            require(type(record["selectedEpoch"]) is int and record["epochsRun"] == config["epochs"]
                    and config["epochs"] * 2 // 3 < record["selectedEpoch"] <= config["epochs"], "invalid checkpoint epoch")
            require(set(record["checks"]) == {"inner-train", "inner-validation", "authored"}, "numerical check roles differ")
            require(all(check["integerMismatches"] == 0 and check["reasons"] == []
                        for check in record["checks"].values()), "development numerical gate failed")
            for role in ("inner-train", "inner-validation"):
                quality = record["quality"][role]
                validate_metric(quality, role)
                require(set(quality["byPhase"]) == set(PHASES), "phase inventory differs")
                for phase in PHASES:
                    validate_metric(quality["byPhase"][phase], role + " " + phase)
        representative = sorted(group, key=lambda record: (record["selectedInnerCe"], record["seed"]))[1]
        reasons = gate(baseline, representative["quality"]["inner-validation"])
        if reasons:
            rejected.append({"config": config["id"], "reasons": reasons})
        elif config["eligibleForTest"]:
            choices.append((representative["selectedInnerCe"], index, config, representative,
                            sorted(record["selectedEpoch"] for record in group)[1]))
    if not choices:
        return {"config": None, "stopReasons": ["no-inner-phase-eligible-candidate"], "phaseRejected": rejected}
    loss, _, config, representative, epoch = min(choices, key=lambda item: item[:2])
    return {"config": copy.deepcopy(config), "seed": representative["seed"], "epochs": epoch,
            "medianInnerCe": loss, "innerRepresentativeEpoch": representative["selectedEpoch"], "phaseRejected": rejected}


def budget_config(config, epochs):
    result = copy.deepcopy(config)
    result.update(id=config["id"].rsplit("-e", 1)[0] + "-e" + str(epochs), epochs=epochs)
    return result


def choose_budget(records, configs, seeds, baseline, tolerance):
    combined = choose(records, configs, seeds, baseline)
    if combined["config"] is None:
        return combined
    eligible = []
    for config in configs:
        selected = choose([record for record in records if record["config"] == config], [config], seeds, baseline)
        if selected["config"] is not None:
            eligible.append(selected)
    best = min(item["medianInnerCe"] for item in eligible)
    result = min((item for item in eligible if item["medianInnerCe"] <= best * (1 + tolerance)),
                 key=lambda item: item["config"]["epochs"])
    return {**result, "bestEligibleBudgetMedianCe": best, "relativeBudgetTolerance": tolerance,
            "eligibleBudgetMedians": [{"epochs": item["config"]["epochs"], "medianInnerCe": item["medianInnerCe"]}
                                      for item in sorted(eligible, key=lambda item: item["config"]["epochs"])],
            "allBudgetPhaseRejected": combined["phaseRejected"], "convergenceClaimed": False}


def progression_decision(decision, budgets, remaining, tolerance, time_capped):
    result = {"extendTo": None, "saturationReached": False, "latestRelativeImprovement": None,
              "endReason": None, "boundedRecipeOnly": True, "convergenceClaimed": False}
    if time_capped:
        return {**result, "endReason": "registered-time-cap"}
    latest = max(budgets)
    eligible = {item["epochs"]: item["medianInnerCe"] for item in decision.get("eligibleBudgetMedians", [])}
    if latest not in eligible:
        return {**result, "endReason": "latest-budget-phase-guard"}
    shorter = [ce for epoch, ce in eligible.items() if epoch < latest]
    if not shorter:
        return {**result, "endReason": "no-shorter-eligible-budget"}
    improvement = 1 - eligible[latest] / min(shorter)
    result["latestRelativeImprovement"] = improvement
    if improvement <= tolerance:
        return {**result, "saturationReached": True, "endReason": "bounded-budget-plateau"}
    if not remaining:
        return {**result, "endReason": "maximum-epoch-budget-reached"}
    return {**result, "extendTo": remaining[0], "endReason": "continue-registered-extension"}


def factorial_ablations(records):
    cells = {}
    for record in records:
        config = record["config"]
        key = (config["hidden"], config["mode"], config["endgameWeight"])
        cells.setdefault(key, []).append(record["selectedInnerCe"])
    keys, result = sorted(cells), []
    for dimension, coordinate in (("hidden", 0), ("architecture", 1), ("endgameWeight", 2)):
        for index, left in enumerate(keys):
            for right in keys[index + 1:]:
                if left[coordinate] == right[coordinate] or any(left[k] != right[k] for k in range(3) if k != coordinate):
                    continue
                a, b = cells[left], cells[right]
                a_median, b_median = statistics.median(a), statistics.median(b)
                result.append({"dimension": dimension, "left": list(left), "right": list(right),
                               "leftMedianCe": a_median, "rightMedianCe": b_median,
                               "relativeRightMedianImprovement": 1 - b_median / a_median,
                               "leftSeedRange": [min(a), max(a)], "rightSeedRange": [min(b), max(b)], "exploratory": True})
    require(len(result) == 12, "factorial pair inventory differs")
    return result


def audit_stages(summary, contract, read_receipt):
    """Return independently reconstructed decisions, saturation and ablations.

    ``read_receipt(relative_filename)`` must return the authenticated decoded
    JSON object. This module never requests row data or a holdout receipt.
    """
    configs, seeds = contract["configurations"], contract["training"]["seeds"]
    require(len(configs) == 8 and len(seeds) == 3 and len(set(seeds)) == 3, "registered factorial dimensions differ")
    require(len({config["id"] for config in configs}) == 8, "duplicate factorial configuration")
    require({(c["hidden"], c["mode"], c["endgameWeight"]) for c in configs}
            == {(h, mode, w) for h in (4, 8) for mode in ("residual-shipped-hce", "phase-residual-shipped-hce") for w in (1, 4)},
            "factorial cells differ")
    initial = contract["budgetStage"]["baselineEpochs"]
    require(all(c["epochs"] == initial for c in configs), "factorial budgets differ")
    mandatory, extensions = contract["budgetStage"]["epochs"], contract["budgetStage"]["extensionEpochs"]
    require(initial == 300 and mandatory == [900, 1800] and extensions == [3600, 7200], "registered budget sequence differs")
    tolerance = contract["budgetStage"]["relativeTolerance"]
    require(finite(tolerance) and tolerance == .001, "budget tolerance differs")
    baseline = summary["comparators"]["inner-validation"]["shipped-hce"]
    records = summary["runs"]
    require(len(records) >= 24, "incomplete factorial inventory")
    expected_inventory = [(config, seed) for config in configs for seed in seeds]
    same([[record["config"], record["seed"]] for record in records[:24]],
         [[config, seed] for config, seed in expected_inventory], "ordered factorial inventory")
    metadata = {"head": summary["head"], "contractSha256": summary["contractSha256"], "selectionUsesOuter": False}
    factorial = {**choose(records[:24], configs, seeds, baseline), **metadata}
    same(summary["factorialDecision"], factorial, "factorial decision")
    same(read_receipt("factorial-decision.json"), factorial, "frozen factorial receipt")
    ablations = factorial_ablations(records[:24])
    same(summary["factorialAblations"], ablations, "factorial ablations")
    decision = copy.deepcopy(factorial)
    saturation = {"extendTo": None, "saturationReached": False, "endReason": "no-inner-phase-eligible-candidate",
                  "latestRelativeImprovement": None, "boundedRecipeOnly": True, "convergenceClaimed": False}
    observed = summary["budgetProgression"]
    if factorial["config"] is None:
        require(len(records) == 24 and observed == [], "no-candidate screen continued fitting")
    else:
        selected = factorial["config"]
        budgets = [copy.deepcopy(selected)] + [budget_config(selected, epoch) for epoch in mandatory]
        remaining = list(extensions)
        expected_inventory += [(config, seed) for config in budgets[1:] for seed in seeds]
        require(1 <= len(observed) <= 3, "progression inventory differs")
        terminal = False
        for index, entry in enumerate(observed):
            require(not terminal, "progression continued after terminal decision")
            same(entry["completedBudgets"], [config["epochs"] for config in budgets], "progression budget order")
            prefix = records[:len(expected_inventory)]
            same([[record["config"], record["seed"]] for record in prefix],
                 [[config, seed] for config, seed in expected_inventory], "ordered completed fit inventory")
            relevant = [record for record in prefix if record["config"] in budgets]
            decision = choose_budget(relevant, budgets, seeds, baseline, tolerance)
            time_capped = entry["endReason"] == "registered-time-cap"
            if time_capped:
                require(index == len(observed) - 1, "time cap must end progression")
                require(finite(summary["elapsedSeconds"]) and summary["elapsedSeconds"] > contract["training"]["maximumElapsedTrainingSeconds"],
                        "time-cap claim contradicts completion elapsed time")
            saturation = progression_decision(decision, [config["epochs"] for config in budgets], remaining, tolerance, time_capped)
            expected_entry = {"completedBudgets": [config["epochs"] for config in budgets], **saturation}
            same(entry, expected_entry, "progression decision")
            same(read_receipt("budget-progression-" + str(budgets[-1]["epochs"]) + ".json"), expected_entry, "frozen progression receipt")
            if saturation["extendTo"] is None:
                terminal = True
            else:
                require(index < len(observed) - 1, "required registered extension missing")
                next_config = budget_config(selected, remaining.pop(0))
                budgets.append(next_config)
                expected_inventory += [(next_config, seed) for seed in seeds]
        require(terminal, "progression lacks terminal decision")
        require(len(records) == len(expected_inventory), "foreign/extra development fits")
        if saturation["endReason"] == "registered-time-cap":
            decision = {"config": None, "bestCompletedDecision": decision, "stopReasons": ["registered-time-cap"]}
    decision.update(metadata, nnueValidationDecoded=False, nnueTestDecoded=False)
    same(summary["decision"], decision, "final recipe decision")
    same(read_receipt("decision.json"), decision, "frozen recipe receipt")
    same(summary["saturation"], saturation, "saturation")
    same(summary["saturationReached"], saturation["saturationReached"], "saturation flag")
    same(summary["endReason"], saturation["endReason"], "end reason")
    require(len(records) + ("final" in summary) <= contract["training"]["maximumFits"], "fit cap exceeded")
    if decision["config"] is None:
        require("final" not in summary and summary["testEligible"] is False, "stopped selection has final/test eligibility")
        same(summary["stopReasons"], decision["stopReasons"], "stopped selection reasons")
    else:
        require("final" in summary, "eligible recipe lacks refit")
        fit = summary["final"]["fit"]
        same(fit["config"], decision["config"], "refit config")
        require(fit["seed"] == decision["seed"] and fit["epochsRun"] == fit["selectedEpoch"] == decision["epochs"]
                and fit["selectedInnerCe"] is None, "refit seed/epoch differs")
    return {"decision": decision, "factorialDecision": factorial, "saturation": saturation, "factorialAblations": ablations}
