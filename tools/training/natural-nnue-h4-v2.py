#!/usr/bin/env python3
"""Bounded v2 recipe repair. Private checkpoints; no engine integration.

No-replace state prevents accidental renamed-output retries in a trusted isolated
checkout. It is not an adversarial same-account filesystem security boundary.
The original v1 executable/contract/results remain unchanged.
"""
from __future__ import annotations
import argparse
from dataclasses import fields
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"
import numpy as np
import scipy
import h4_data as data_io
import h4_v2_model as model

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "eval/training/natural-nnue-h4-v2.json"
CONTRACT_SHA = "f40b32d8201eea731e022a9940ec0d33b682d50c219a2ca4c35df241738082b0"
SUMMARY_SHA = "8862475a1c4d22867832b6a7399da91f2a1a14f1aad26994826e98a8975bc26d"
_spec = importlib.util.spec_from_file_location("_h4_v1_util", ROOT / "tools/training/natural-nnue-h4.py")
util = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = util
_spec.loader.exec_module(util)
digest, encoded, publish = util.digest, util.encoded, util.publish


def state_root():
    key = digest((CONTRACT_SHA + "\0" + SUMMARY_SHA + "\0nnue-test").encode())
    return ROOT / ".research-state" / key


def reserve(kind, value, expected):
    path = state_root() / (kind + ".json")
    publish(path, encoded(value), expected)
    return path


def implementation():
    rules = json.loads(util.read_exact(CONTRACT, CONTRACT_SHA))
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise ValueError("frozen NumPy/SciPy versions required")
    paths = [Path(__file__), CONTRACT, ROOT / "tools/training/h4_v2_model.py",
             ROOT / "test/training/h4-v2-reference.js", ROOT / "tools/training/h4_model.py",
             ROOT / "tools/training/h4_data.py", ROOT / "tools/training/natural-nnue-h4.py",
             ROOT / "tools/training/h4_ablation.py"]
    expected = {path: digest(path.read_bytes()) for path in paths}
    expected.update(data_io.fit.closure())
    for executable in (sys.executable, subprocess.check_output(["which", "node"], text=True).strip()):
        path = Path(executable).resolve()
        expected[path] = digest(path.read_bytes())
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT).strip():
        raise ValueError("commit clean implementation before real-data execution")
    tracked = set(subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines())
    if any(str(p.relative_to(ROOT)) not in tracked for p in paths):
        raise ValueError("all executable implementation files must be committed")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    return rules, expected, head


def subset(data, indexes, role):
    indexes = np.asarray(indexes)
    return data_io.fit.Data(**{
        field.name: (role if field.name == "role" else
                     [data.fens[int(i)] for i in indexes] if field.name == "fens" else
                     getattr(data, field.name)[indexes])
        for field in fields(data)
    })


def inner_split(data):
    mask = np.asarray([int(hashlib.sha256(("chessy-h4-v2-inner-20260915\0" + str(f)).encode()).hexdigest()[:16], 16) % 5 == 0
                       for f in data.family])
    train, validation = subset(data, np.flatnonzero(~mask), "inner-train"), subset(data, np.flatnonzero(mask), "inner-validation")
    data_io.fit.assert_disjoint(data_io.fit.identities(train), data_io.fit.identities(validation))
    if train.rows < 20000 or validation.rows < 4000:
        raise ValueError("unexpected inner split coverage")
    return train, validation


def baseline(data, config):
    return data.baseline_cp if config["mode"] == "residual-shipped-hce" else None


def ce(cp, target):
    logits = np.asarray(cp, dtype=float) / 100
    if logits.shape != target.shape or not np.all(np.isfinite(logits)):
        raise ValueError("invalid predictions")
    return float(np.mean(np.logaddexp(0, logits) - target * logits))


def learning_rate(epoch, settings):
    if not 1 <= epoch <= settings["epochs"]:
        raise ValueError("epoch out of schedule range")
    fraction = (epoch - 1) / (settings["epochs"] - 1)
    lo, hi = settings["minimumLearningRate"], settings["learningRate"]
    return lo + .5 * (hi - lo) * (1 + math.cos(math.pi * fraction))


def adam_step(params, grad, first, second, step, lr, clip_norm):
    norm = float(np.linalg.norm(grad))
    if not np.isfinite(norm):
        raise ValueError("nonfinite gradient")
    grad = grad * min(1.0, clip_norm / max(norm, 1e-30))
    first = .9 * first + .1 * grad
    second = .999 * second + .001 * grad * grad
    update = (first / (1 - .9 ** step)) / (np.sqrt(second / (1 - .999 ** step)) + 1e-8)
    return params - lr * update, first, second, norm


def fit(config, seed, train, validation, settings, deadline, epochs=None):
    """Only passed-in training and inner-validation are accessible here."""
    hidden = config["hidden"]
    residual = config["mode"] == "residual-shipped-hce"
    params = model.initialize(seed, hidden=hidden, residual=residual)
    anchor = model.anchor(params, hidden)
    first, second = np.zeros_like(params), np.zeros_like(params)
    train_features = model.features_from_fens(train.fens)
    val_features = model.features_from_fens(validation.fens) if validation is not None else None
    rng = np.random.default_rng(seed)
    offset = baseline(train, config)
    curves, best, step, clipped_updates = [], None, 0, 0
    started = time.monotonic()
    epochs = settings["epochs"] if epochs is None else epochs
    for epoch in range(1, epochs + 1):
        if time.monotonic() > deadline:
            raise TimeoutError("registered total training budget exhausted")
        lr = learning_rate(epoch, settings)
        qat = epoch >= settings["quantizationAwareStartEpoch"]
        order = rng.permutation(train.rows)
        last_norm = 0.0
        for start in range(0, train.rows, settings["batchSize"]):
            indexes = order[start:start + settings["batchSize"]]
            features = tuple(value[indexes] for value in train_features)
            _, grad, diagnostics = model.loss_and_grad(params, *features, train.target[indexes],
                hidden=hidden, baseline_cp=None if offset is None else offset[indexes],
                l2=config["l2"], anchor_params=anchor, fake_quant=qat)
            step += 1
            params, first, second, last_norm = adam_step(params, grad, first, second, step, lr, settings["gradientClipNorm"])
            projected = model.project(params, hidden)
            clipped_updates += int(not np.array_equal(params, projected))
            params = projected
        if epoch % settings["checkpointEveryEpochs"] == 0 or epoch == epochs:
            quantized = model.quantize(params, hidden=hidden, baseline_id="shipped-hce" if config["mode"] == "residual-shipped-hce" else "none")
            train_cp = quantized.predict_cp(*train_features, baseline_cp=offset)
            _, full_grad, components = model.loss_and_grad(params, *train_features, train.target,
                hidden=hidden, baseline_cp=offset, l2=config["l2"], anchor_params=anchor, fake_quant=qat)
            point = {"epoch": epoch, "learningRate": lr, "qat": qat,
                     "trainQuantizedCe": ce(train_cp, train.target), "objectiveComponents": components,
                     "gradientNorm": float(np.linalg.norm(full_grad)), "maximumAbsGradient": float(np.max(np.abs(full_grad))),
                     "projectedUpdates": clipped_updates,
                     "activations": model.activation_diagnostics(params, *train_features, hidden=hidden, fake_quant=qat)}
            if validation is not None:
                val_cp = quantized.predict_cp(*val_features, baseline_cp=baseline(validation, config))
                point["innerValidationQuantizedCe"] = ce(val_cp, validation.target)
                if qat and (best is None or point["innerValidationQuantizedCe"] < best["ce"]):
                    best = {"epoch": epoch, "ce": point["innerValidationQuantizedCe"], "params": params.copy()}
            curves.append(point)
        if epoch % 100 == 0 or epoch == epochs:
            print(json.dumps({"config": config["id"], "seed": seed, "epoch": epoch,
                              "elapsedSeconds": round(time.monotonic() - started, 3),
                              "trainCe": curves[-1]["trainQuantizedCe"],
                              "innerCe": curves[-1].get("innerValidationQuantizedCe")}), flush=True)
    if validation is not None and best is None:
        raise ValueError("no eligible QAT checkpoint")
    selected = params if validation is None else best["params"]
    return selected, {"config": config, "seed": seed, "epochsRun": epochs,
                      "selectedEpoch": epochs if best is None else best["epoch"],
                      "selectedInnerCe": None if best is None else best["ce"],
                      "updates": step, "seconds": time.monotonic() - started,
                      "convergenceClaimed": False, "curves": curves}


def parity(params, config, data, output):
    quantized = model.quantize(params, hidden=config["hidden"], baseline_id="shipped-hce" if config["mode"] == "residual-shipped-hce" else "none")
    features, offset = model.features_from_fens(data.fens), baseline(data, config)
    integer = quantized.predict_cp(*features, baseline_cp=offset)
    floating = model.predict_cp(params, *features, hidden=config["hidden"], baseline_cp=offset)
    with tempfile.TemporaryDirectory(prefix="v2-parity-", dir=output) as name:
        tmp = Path(name)
        (tmp / "model.bin").write_bytes(quantized.to_bytes())
        (tmp / "metadata.json").write_bytes(encoded(quantized.metadata()))
        rows = []
        for i, fen in enumerate(data.fens):
            row = {"id": str(i), "fen": fen}
            if offset is not None:
                row["baselineCp"] = int(offset[i])
            rows.append(json.dumps(row))
        result = subprocess.run(["node", str(ROOT / "test/training/h4-v2-reference.js"),
                                 str(tmp / "model.bin"), str(tmp / "metadata.json")],
                                input="\n".join(rows) + "\n", text=True, capture_output=True, check=True)
        actual = [json.loads(line) for line in result.stdout.splitlines()]
    if len(actual) != data.rows or any(row["id"] != str(i) for i, row in enumerate(actual)):
        raise ValueError("independent reference row identity mismatch")
    mismatches = int(np.sum(integer != np.asarray([row["cpWhite"] for row in actual])))
    if mismatches:
        raise ValueError("independent integer mismatch stops experiment")
    delta = np.abs(integer - floating)
    report = {"rows": data.rows, "integerMismatches": mismatches,
              "maximumAbsFloatDifferenceCp": float(np.max(delta)),
              "meanAbsFloatDifferenceCp": float(np.mean(delta)),
              "maximumAbsoluteScoreCp": float(max(np.max(np.abs(integer)), np.max(np.abs(floating))))}
    reasons = []
    if report["maximumAbsFloatDifferenceCp"] > 5 or report["meanAbsFloatDifferenceCp"] > 1:
        reasons.append("quantization-float-difference")
    if report["maximumAbsoluteScoreCp"] > 10000:
        reasons.append("score-range")
    return integer, floating, report, reasons


def authored_data():
    from types import SimpleNamespace
    fens = util.AUTHORED_FENS
    feature_rows = [json.loads(line) for line in data_io.fit.node_features(
        {"rows": [{"id": str(i), "fen": f} for i, f in enumerate(fens)]}).splitlines()]
    return SimpleNamespace(fens=fens, rows=len(fens), baseline_cp=np.asarray([r["baselineCp"] for r in feature_rows]))


def save_checkpoint(prefix, params, config, expected):
    quantized = model.quantize(params, hidden=config["hidden"], baseline_id="shipped-hce" if config["mode"] == "residual-shipped-hce" else "none")
    paths = {"float": Path(str(prefix) + ".float.json"), "binary": Path(str(prefix) + ".bin"),
             "metadata": Path(str(prefix) + ".metadata.json")}
    contents = {"float": encoded(params.tolist()), "binary": quantized.to_bytes(), "metadata": encoded(quantized.metadata())}
    for key, path in paths.items():
        publish(path, contents[key], expected)
    return {key: {"path": path.name, "sha256": digest(contents[key]), "bytes": len(contents[key])} for key, path in paths.items()}


def choose(records, configurations, seeds):
    choices = []
    for config in configurations:
        found = [r for r in records if r["config"]["id"] == config["id"]]
        if sorted(r["seed"] for r in found) != sorted(seeds):
            raise ValueError("missing/duplicate preregistered seed")
        ranked = sorted(found, key=lambda r: (r["selectedInnerCe"], r["seed"]))
        median = ranked[1]
        if config["eligibleForTest"]:
            choices.append((median["selectedInnerCe"], config, median,
                            sorted(r["selectedEpoch"] for r in found)[1]))
    _, config, representative, epoch = min(choices, key=lambda item: item[0])
    return {"config": config, "seed": representative["seed"], "epochs": epoch,
            "medianInnerCe": representative["selectedInnerCe"], "innerRepresentativeEpoch": representative["selectedEpoch"]}


def run(bundle, output):
    rules, code_expected, head = implementation()
    auth = data_io.authenticate(bundle)
    expected = {**code_expected, **auth.expected}
    output.mkdir(parents=True, exist_ok=False)
    reserve("run-started", {"head": head, "contractSha256": CONTRACT_SHA, "output": str(output)}, expected)
    started = time.monotonic()
    deadline = started + rules["training"]["maximumElapsedTrainingSeconds"]
    train = data_io.load_role(auth, "shared-train")
    inner_train, inner_validation = inner_split(train)
    identities = {role: data_io.fit.identities(data) for role, data in
                  (("shared-train", train), ("inner-train", inner_train), ("inner-validation", inner_validation))}
    publish(output / "split-identities.json", encoded(identities), expected)
    comparators = {role: {name: util.quality_metrics(cp, data) for name, cp in util.comparator_predictions(auth, data).items()}
                  for role, data in (("inner-train", inner_train), ("inner-validation", inner_validation), ("shared-train", train))}
    print(json.dumps({"stage": "admitted", "innerTrainRows": inner_train.rows, "innerValidationRows": inner_validation.rows}), flush=True)
    records, fixtures = [], authored_data()
    for config in rules["configurations"]:
        for seed in rules["training"]["seeds"]:
            params, record = fit(config, seed, inner_train, inner_validation, rules["training"], deadline)
            record["checks"], record["quality"] = {}, {}
            for role, data in (("inner-train", inner_train), ("inner-validation", inner_validation), ("authored", fixtures)):
                cp, floating, check, reasons = parity(params, config, data, output)
                record["checks"][role] = {**check, "reasons": reasons}
                if role != "authored":
                    record["quality"][role] = util.quality_metrics(cp, data)
            prefix = output / (config["id"] + "-" + str(seed))
            record["artifacts"] = save_checkpoint(prefix, params, config, code_expected)
            publish(Path(str(prefix) + ".report.json"), encoded(record), code_expected)
            records.append(record)
    decision = choose(records, rules["configurations"], rules["training"]["seeds"])
    decision.update({"head": head, "contractSha256": CONTRACT_SHA, "selectionUsesOuter": False,
                     "nnueValidationDecoded": False, "nnueTestDecoded": False})
    publish(output / "decision.json", encoded(decision), expected)
    reserve("recipe-frozen", decision, expected)
    config = decision["config"]
    params, final_fit = fit(config, decision["seed"], train, None, rules["training"], deadline, epochs=decision["epochs"])
    artifacts = save_checkpoint(output / "final", params, config, expected)
    reserve("model-frozen", {"decisionSha256": digest(encoded(decision)), "artifacts": artifacts}, expected)
    final = {"fit": final_fit, "artifacts": artifacts, "quality": {}, "floatQuality": {}, "checks": {}}
    stop_reasons = []
    for role, data in (("shared-train", train), ("authored", fixtures)):
        cp, floating, check, reasons = parity(params, config, data, output)
        final["checks"][role] = {**check, "reasons": reasons}
        stop_reasons += [role + ":" + r for r in reasons]
        if role != "authored":
            final["quality"][role], final["floatQuality"][role] = util.quality_metrics(cp, data), util.quality_metrics(floating, data)
    reserve("validation-opened", {"modelSha256": artifacts["binary"]["sha256"], "previouslyExposed": True}, expected)
    validation = data_io.load_role(auth, "nnue-validation")
    comparators["nnue-validation"] = {name: util.quality_metrics(cp, validation) for name, cp in util.comparator_predictions(auth, validation).items()}
    cp, floating, check, reasons = parity(params, config, validation, output)
    final["checks"]["nnue-validation"] = {**check, "reasons": reasons}
    stop_reasons += ["nnue-validation:" + r for r in reasons]
    final["quality"]["nnue-validation"], final["floatQuality"]["nnue-validation"] = util.quality_metrics(cp, validation), util.quality_metrics(floating, validation)
    for name, base in comparators["nnue-validation"].items():
        stop_reasons += [name + ":" + r for r in util.guard(base, final["quality"]["nnue-validation"])]
    if artifacts["binary"]["bytes"] > rules["quantization"]["advancementParameterBudgetBytes"]:
        stop_reasons.append("parameter-size")
    summary = {"schema": "chessy.h4-v2-screen.v1", "head": head, "contractSha256": CONTRACT_SHA,
               "researchOnly": True, "productionFitAllowed": False, "paidSpendUsd": 0,
               "innerRows": {"train": inner_train.rows, "validation": inner_validation.rows},
               "decision": decision, "comparators": comparators, "runs": records, "final": final,
               "stopReasons": stop_reasons, "testOpened": False, "testEligible": not stop_reasons,
               "runtimeIntegrationPerformed": False, "trainingSeconds": sum(r["seconds"] for r in records) + final_fit["seconds"],
               "elapsedSeconds": time.monotonic() - started, "inputSha256": {str(p): s for p, s in expected.items()},
               "auditEvidence": auth.evidence}
    publish(output / "selection.json", encoded(summary), expected)
    reserve("selection-frozen", {"sha256": digest(encoded(summary)), "testEligible": not stop_reasons,
                                 "binarySha256": artifacts["binary"]["sha256"]}, expected)
    if not stop_reasons:
        reserve("test-opened", {"selectionSha256": digest(encoded(summary)), "binarySha256": artifacts["binary"]["sha256"]}, expected)
        test = data_io.load_role(auth, "nnue-test")
        test_cp, test_float, test_check, test_reasons = parity(params, config, test, output)
        bases = util.comparator_predictions(auth, test)
        metrics = util.quality_metrics(test_cp, test)
        intervals = {name: util.bootstrap(test, b, test_cp) for name, b in bases.items()}
        for name, b in bases.items():
            test_reasons += [name + ":" + r for r in util.guard(util.quality_metrics(b, test), metrics)]
            if intervals[name]["ci95"][1] >= 0:
                test_reasons.append(name + ":bootstrap-upper95-not-negative")
        result = {"schema": "chessy.h4-v2-test.v1", "selectionSha256": digest(encoded(summary)),
                  "testOpened": True, "quality": metrics, "floatQuality": util.quality_metrics(test_float, test),
                  "checks": test_check, "comparators": {name: util.quality_metrics(b, test) for name, b in bases.items()},
                  "bootstrap": intervals, "stopReasons": test_reasons, "offlinePass": not test_reasons,
                  "runtimeIntegrationAllowed": False, "formalPass": False}
        publish(output / "test.json", encoded(result), expected)
        reserve("test-completed", {"sha256": digest(encoded(result)), "offlinePass": not test_reasons}, expected)
    print(json.dumps({"stage": "completed", "output": str(output), "selected": config["id"],
                      "testOpened": not stop_reasons, "stopReasons": stop_reasons,
                      "trainingSeconds": summary["trainingSeconds"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output_existed = args.output.exists()
    try:
        run(args.bundle.absolute(), args.output.absolute())
    except Exception as error:
        # An accidental retry must never add a failure receipt to a completed
        # run or alter another pre-existing output directory.
        if not output_existed and args.output.exists():
            failed = args.output / "failure.json"
            if not failed.exists():
                failed.write_bytes(encoded({"type": type(error).__name__, "error": str(error), "doNotRetryForScore": True}))
        raise


if __name__ == "__main__":
    main()
