#!/usr/bin/env python3
"""Bounded width/architecture/weight factorial plus one-recipe budget stage.

The frozen v3 numerical, fitting, parity and holdout functions are loaded into
an isolated module instance. Explicit adapters change only the registered
training objective; none of the v1/v2/v3 source files are changed.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("_h4_v4_shared", ROOT / "tools/training/natural-nnue-h4-v3.py")
shared = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = shared
spec.loader.exec_module(shared)
import h4_v4_recipe as recipe

np, data_io, util = shared.np, shared.data_io, shared.util
digest, encoded, publish = shared.digest, shared.encoded, shared.publish
CONTRACT = ROOT / "eval/training/natural-nnue-h4-v4.json"
CONTRACT_SHA = "47c6c78c59e70b9a9d21156aff5ece7192bfad563bac360ebe6f0c20728e5cd1"
original_implementation = shared.implementation


def implementation():
    rules, expected, head = original_implementation()
    paths = [Path(__file__), ROOT / "tools/training/h4_v4_recipe.py"]
    tracked = set(subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines())
    if any(str(p.relative_to(ROOT)) not in tracked for p in paths):
        raise ValueError("all v4 executable implementation must be committed")
    expected.update({p: digest(p.read_bytes()) for p in paths})
    return rules, expected, head


def extras(config, data, indexes=None):
    # Both adapters accept material phase; providing it also lets the shared
    # fit loop pass normalized weights to the single-head adapter.
    values = recipe.phase.phase_from_fens(data.fens)
    return {"phase_units": values if indexes is None else values[indexes]}


shared.CONTRACT, shared.CONTRACT_SHA = CONTRACT, CONTRACT_SHA
shared.single_model, shared.phase_model = recipe.SINGLE, recipe.PHASE
shared.extras, shared.implementation = extras, implementation


def record_fit(config, seed, train, validation, fixtures, settings, deadline, output, expected):
    params, record = shared.fit(config, seed, train, validation, shared.settings_for(config, settings), deadline)
    record["checks"], record["quality"] = {}, {}
    for role, data in (("inner-train", train), ("inner-validation", validation), ("authored", fixtures)):
        cp, _, check, reasons = shared.parity(params, config, data, output)
        record["checks"][role] = {**check, "reasons": reasons}
        if role != "authored":
            record["quality"][role] = util.quality_metrics(cp, data)
    prefix = output / (config["id"]+"-"+str(seed))
    record["artifacts"] = shared.save_checkpoint(prefix, params, config, expected)
    publish(Path(str(prefix)+".report.json"), encoded(record), expected)
    return record


def budget_config(config, epochs):
    result = dict(config)
    result["id"] = config["id"].rsplit("-e", 1)[0]+"-e"+str(epochs)
    result["epochs"] = epochs
    return result


def choose_budget(records, configurations, seeds, comparators, tolerance):
    # One full inventory check catches numerical failures in any budget before
    # taking the shorter near-best budget. Per-budget decisions retain the
    # exact v3 median-seed, phase and epoch-selection rules.
    checked = shared.choose(records, configurations, seeds, comparators)
    if checked["config"] is None:
        return checked
    eligible = []
    for config in configurations:
        found = [r for r in records if r["config"] == config]
        decision = shared.choose(found, [config], seeds, comparators)
        if decision["config"] is not None:
            eligible.append(decision)
    best = min(d["medianInnerCe"] for d in eligible)
    selected = min((d for d in eligible if d["medianInnerCe"] <= best*(1+tolerance)),
                   key=lambda d:d["config"]["epochs"])
    return {**selected, "bestEligibleBudgetMedianCe": best, "relativeBudgetTolerance": tolerance,
            "eligibleBudgetMedians": [{"epochs": d["config"]["epochs"], "medianInnerCe": d["medianInnerCe"]}
                                       for d in sorted(eligible,key=lambda d:d["config"]["epochs"])],
            "allBudgetPhaseRejected": checked["phaseRejected"], "convergenceClaimed": False}


def extension_decision(records, configurations, seeds, comparators, tolerance, remaining_budgets,
                       time_capped=False):
    decision = choose_budget(records, configurations, seeds, comparators, tolerance)
    result = {"extendTo": None, "saturationReached": False, "latestRelativeImprovement": None,
              "endReason": None, "boundedRecipeOnly": True, "convergenceClaimed": False}
    if time_capped:
        return {**result, "endReason": "registered-time-cap"}
    latest = max(c["epochs"] for c in configurations)
    eligible = {item["epochs"]:item["medianInnerCe"] for item in decision.get("eligibleBudgetMedians",[])}
    if latest not in eligible:
        return {**result, "endReason": "latest-budget-phase-guard"}
    shorter = [ce for epochs,ce in eligible.items() if epochs<latest]
    if not shorter:
        return {**result, "endReason": "no-shorter-eligible-budget"}
    improvement = 1-eligible[latest]/min(shorter)
    result["latestRelativeImprovement"] = improvement
    if improvement <= tolerance:
        return {**result, "saturationReached": True, "endReason": "bounded-budget-plateau"}
    if not remaining_budgets:
        return {**result, "endReason": "maximum-epoch-budget-reached"}
    return {**result, "extendTo": remaining_budgets[0], "endReason": "continue-registered-extension"}


def factorial_ablations(records):
    cells = {}
    for record in records:
        c = record["config"]
        key = (c["hidden"], c["mode"], c["endgameWeight"])
        cells.setdefault(key, []).append(record["selectedInnerCe"])
    axes = [("hidden",0), ("architecture",1), ("endgameWeight",2)]
    result = []
    keys = sorted(cells)
    for name,index in axes:
        for i,left in enumerate(keys):
            for right in keys[i+1:]:
                if left[index] == right[index] or any(left[j]!=right[j] for j in range(3) if j!=index):
                    continue
                a,b=cells[left],cells[right]
                result.append({"dimension":name,"left":list(left),"right":list(right),
                    "leftMedianCe":float(np.median(a)),"rightMedianCe":float(np.median(b)),
                    "relativeRightMedianImprovement":1-float(np.median(b))/float(np.median(a)),
                    "leftSeedRange":[min(a),max(a)],"rightSeedRange":[min(b),max(b)],"exploratory":True})
    return result


def run(bundle, output):
    rules, code_expected, head = implementation()
    auth = data_io.authenticate(bundle)
    expected = {**code_expected, **auth.expected}
    output.mkdir(parents=True, exist_ok=False)
    shared.reserve("run-started", {"head":head,"contractSha256":CONTRACT_SHA,"output":str(output)}, expected)
    started=time.monotonic()
    deadline=started+rules["training"]["maximumElapsedTrainingSeconds"]
    train=data_io.load_role(auth,"shared-train")
    inner_train,inner_validation=shared.inner_split(train)
    identities={role:data_io.fit.identities(data) for role,data in
                (("shared-train",train),("inner-train",inner_train),("inner-validation",inner_validation))}
    publish(output/"split-identities.json",encoded(identities),expected)
    comparators={role:{name:util.quality_metrics(cp,data) for name,cp in util.comparator_predictions(auth,data).items()}
                 for role,data in (("inner-train",inner_train),("inner-validation",inner_validation),("shared-train",train))}
    fixtures=shared.authored_data()
    records=[]
    print(json.dumps({"stage":"factorial-started","fits":24,"innerTrainRows":inner_train.rows,
                      "innerValidationRows":inner_validation.rows}),flush=True)
    for config in rules["configurations"]:
        for seed in rules["training"]["seeds"]:
            records.append(record_fit(config,seed,inner_train,inner_validation,fixtures,
                           rules["training"],deadline,output,expected))
    factorial_decision=shared.choose(records,rules["configurations"],rules["training"]["seeds"],comparators["inner-validation"])
    factorial_decision.update({"head":head,"contractSha256":CONTRACT_SHA,"selectionUsesOuter":False})
    publish(output/"factorial-decision.json",encoded(factorial_decision),expected)
    shared.reserve("architecture-frozen",factorial_decision,expected)
    factorial_records=list(records)
    decision=copy.deepcopy(factorial_decision)
    saturation={"extendTo":None,"saturationReached":False,"endReason":"no-inner-phase-eligible-candidate",
                "latestRelativeImprovement":None,"boundedRecipeOnly":True,"convergenceClaimed":False}
    progression=[]
    if decision["config"] is not None:
        config=decision["config"]
        budgets=[config]+[budget_config(config,e) for e in rules["budgetStage"]["epochs"]]
        for budget in budgets[1:]:
            for seed in rules["training"]["seeds"]:
                records.append(record_fit(budget,seed,inner_train,inner_validation,fixtures,
                               rules["training"],deadline,output,expected))
        remaining=list(rules["budgetStage"]["extensionEpochs"])
        while True:
            budget_records=[r for r in records if r["config"] in budgets]
            saturation=extension_decision(budget_records,budgets,rules["training"]["seeds"],
                comparators["inner-validation"],rules["budgetStage"]["relativeTolerance"],remaining,
                time_capped=time.monotonic()>deadline)
            progression.append({"completedBudgets":[c["epochs"] for c in budgets],**saturation})
            publish(output/("budget-progression-"+str(budgets[-1]["epochs"])+".json"),encoded(progression[-1]),expected)
            if saturation["extendTo"] is None:
                break
            budget=budget_config(config,remaining.pop(0))
            budgets.append(budget)
            for seed in rules["training"]["seeds"]:
                records.append(record_fit(budget,seed,inner_train,inner_validation,fixtures,
                               rules["training"],deadline,output,expected))
        decision=choose_budget(budget_records,budgets,rules["training"]["seeds"],
                               comparators["inner-validation"],rules["budgetStage"]["relativeTolerance"])
        if saturation["endReason"]=="registered-time-cap":
            decision={"config":None,"bestCompletedDecision":decision,"stopReasons":["registered-time-cap"]}
    decision.update({"head":head,"contractSha256":CONTRACT_SHA,"selectionUsesOuter":False,
                     "nnueValidationDecoded":False,"nnueTestDecoded":False})
    publish(output/"decision.json",encoded(decision),expected)
    shared.reserve("recipe-frozen",decision,expected)
    summary={"schema":"chessy.h4-v4-screen.v1","head":head,"contractSha256":CONTRACT_SHA,
             "researchOnly":True,"productionFitAllowed":False,"paidSpendUsd":0,
             "innerRows":{"train":inner_train.rows,"validation":inner_validation.rows},
             "factorialDecision":factorial_decision,"decision":decision,"comparators":comparators,
             "runs":records,"factorialAblations":factorial_ablations(factorial_records),
             "budgetProgression":progression,"saturation":saturation,
             "saturationReached":saturation["saturationReached"],"endReason":saturation["endReason"],
             "stopReasons":decision.get("stopReasons",[]),"testOpened":False,"testEligible":False,
             "runtimeIntegrationPerformed":False,"trainingSeconds":sum(r["seconds"] for r in records),
             "inputSha256":{str(p):s for p,s in expected.items()},"auditEvidence":auth.evidence}
    if decision["config"] is not None:
        config=decision["config"]
        params,final_fit=shared.fit(config,decision["seed"],train,None,
            shared.settings_for(config,rules["training"]),deadline,epochs=decision["epochs"])
        artifacts=shared.save_checkpoint(output/"final",params,config,expected)
        shared.reserve("model-frozen",{"decisionSha256":digest(encoded(decision)),"artifacts":artifacts},expected)
        final={"fit":final_fit,"artifacts":artifacts,"quality":{},"floatQuality":{},"checks":{}}
        summary["final"]=final
        summary["trainingSeconds"]+=final_fit["seconds"]
        for role,data in (("shared-train",train),("authored",fixtures)):
            cp,floating,check,reasons=shared.parity(params,config,data,output)
            final["checks"][role]={**check,"reasons":reasons}
            summary["stopReasons"] += [role+":"+r for r in reasons]
            if role!="authored":
                final["quality"][role],final["floatQuality"][role]=util.quality_metrics(cp,data),util.quality_metrics(floating,data)
        if not summary["stopReasons"]:
            shared.reserve("validation-opened",{"modelSha256":artifacts["binary"]["sha256"],"previouslyExposed":True},expected)
            validation=data_io.load_role(auth,"nnue-validation")
            comparators["nnue-validation"]={name:util.quality_metrics(cp,validation) for name,cp in util.comparator_predictions(auth,validation).items()}
            cp,floating,check,reasons=shared.parity(params,config,validation,output)
            final["checks"]["nnue-validation"]={**check,"reasons":reasons}
            summary["stopReasons"] += ["nnue-validation:"+r for r in reasons]
            final["quality"]["nnue-validation"],final["floatQuality"]["nnue-validation"]=util.quality_metrics(cp,validation),util.quality_metrics(floating,validation)
            for name,base in comparators["nnue-validation"].items():
                summary["stopReasons"] += [name+":"+r for r in util.guard(base,final["quality"]["nnue-validation"])]
        if artifacts["binary"]["bytes"]>rules["quantization"]["advancementParameterBudgetBytes"]:
            summary["stopReasons"].append("parameter-size")
        summary["testEligible"]=not summary["stopReasons"]
    summary["elapsedSeconds"]=time.monotonic()-started
    publish(output/"selection.json",encoded(summary),expected)
    shared.reserve("selection-frozen",{"sha256":digest(encoded(summary)),"testEligible":summary["testEligible"],
                   "binarySha256":summary.get("final",{}).get("artifacts",{}).get("binary",{}).get("sha256")},expected)
    print(json.dumps({"stage":"completed","output":str(output),"selected":decision["config"],
        "testOpened":False,"testEligible":summary["testEligible"],"stopReasons":summary["stopReasons"],
        "trainingSeconds":summary["trainingSeconds"]}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle",type=Path,required=True)
    destination=parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output",type=Path)
    destination.add_argument("--open-test-from",type=Path)
    args=parser.parse_args()
    if args.open_test_from is not None:
        shared.open_test(args.bundle.absolute(),args.open_test_from.absolute())
        return
    existed=args.output.exists()
    try:
        run(args.bundle.absolute(),args.output.absolute())
    except Exception as error:
        if not existed and args.output.exists() and not (args.output/"failure.json").exists():
            (args.output/"failure.json").write_bytes(encoded({"type":type(error).__name__,"error":str(error),
                "doNotRetryForScore":True,"saturationReached":False,
                "endReason":"registered-time-cap" if isinstance(error,TimeoutError) else "numerical-or-execution-failure"}))
        raise


if __name__=="__main__":
    main()
