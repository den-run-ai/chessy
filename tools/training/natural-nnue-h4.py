#!/usr/bin/env python3
"""One preregistered CPU H4 screen. Authenticated research data only; no runtime.

`select` never reads NNUE-test performance; `test` accepts only the exact
selection bound in canonical state, consumes its one-shot marker before loading
test rows, and cannot be reopened by copying a selection or changing --output.
Trusted isolated checkout/executables, as in the foundation; no hostile-user or
state-deletion resistance is claimed. Preserve state with the experiment archive.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[name] = "1"
import numpy as np
import scipy
from scipy import optimize
import h4_model as model
import h4_data as data_io

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "eval/training/natural-nnue-h4-v1.json"
CONTRACT_SHA = "9496075fddda26a02ac9a0e79a6271d914eede48eaf7e1a3a9de2de85dff1180"
SUMMARY_SHA = "8862475a1c4d22867832b6a7399da91f2a1a14f1aad26994826e98a8975bc26d"
PHASES = ("opening", "middlegame", "endgame")
SEEDS = (10501, 10502, 10503)
VARIANTS = ("net-only", "net-plus-existing-fixed-mop-up")
AUTHORED_FENS = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "4k3/P7/8/8/8/8/7p/4K3 w - - 0 1",
    "4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1",
    "4k3/3q4/8/8/8/8/8/4K3 w - - 0 1",
    "4k3/8/8/8/8/8/4N3/4K3 w - - 0 1",
]


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def read_exact(path, wanted):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("symlink input refused")
    with path.open("rb") as stream:
        payload = stream.read()
    if digest(payload) != wanted:
        raise ValueError("authenticated bytes changed: " + str(path))
    return payload


def recheck(expected):
    for path, wanted in expected.items():
        read_exact(path, wanted)


def publish(path, payload, expected):
    """No-replace fsynced artifact, input recheck immediately before publication."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".h4-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        recheck(expected)
        os.link(name, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(name).unlink(missing_ok=True)


def canonical_state():
    key = digest((CONTRACT_SHA + "\0" + SUMMARY_SHA + "\0nnue-test").encode())
    return ROOT / ".research-state" / key


def reserve(kind, payload, expected):
    path = canonical_state() / (kind + ".json")
    publish(path, encoded(payload), expected)
    return path


def implementation():
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise ValueError("requires frozen NumPy 2.3.5 / SciPy 1.17.0")
    rules = json.loads(read_exact(CONTRACT, CONTRACT_SHA))
    paths = [Path(__file__), CONTRACT, ROOT / "tools/training/h4_model.py",
             ROOT / "tools/training/h4_data.py", ROOT / "test/training/h4-reference.js"]
    expected = {path: digest(path.read_bytes()) for path in paths}
    expected.update(data_io.fit.closure())
    # Freeze actual tool identities before any child or model work. This is a
    # trusted-runner contract, not a hostile same-account process sandbox.
    for executable in (sys.executable, subprocess.check_output(["which", "node"], text=True).strip()):
        path = Path(executable).resolve()
        expected[path] = digest(path.read_bytes())
    status = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT)
    if status.strip():
        raise ValueError("commit implementation before real-data execution")
    tracked = set(subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines())
    if any(str(path.relative_to(ROOT)) not in tracked for path in paths):
        raise ValueError("all screen implementation files must be committed")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    return rules, expected, head


def quality_metrics(cp, data):
    cp = np.asarray(cp, dtype=float)
    if cp.shape != data.target.shape or not np.all(np.isfinite(cp)):
        raise ValueError("invalid prediction vector")
    error = cp - data.teacher_cp
    logits = cp / 100
    losses = np.logaddexp(0, logits) - data.target * logits
    def subset(mask):
        if not np.any(mask):
            return {"rows": 0}
        return {"rows": int(np.sum(mask)), "crossEntropy": float(np.mean(losses[mask])),
                "teacherCpMae": float(np.mean(np.abs(error[mask]))),
                "teacherCpRmse": float(np.sqrt(np.mean(error[mask] ** 2))),
                "p99AbsoluteCpError": float(np.quantile(np.abs(error[mask]), .99)),
                "signAccuracy": float(np.mean(np.sign(cp[mask]) == np.sign(data.teacher_cp[mask])))}
    result = subset(np.ones(len(cp), dtype=bool))
    result["byPhase"] = {phase: subset(data.phase == phase) for phase in PHASES}
    return result


def guard(base, candidate):
    reasons = []
    if candidate["crossEntropy"] > base["crossEntropy"] * .995:
        reasons.append("CE-gain-below-0.5-percent")
    for field, limit in (("teacherCpMae", 1.02), ("teacherCpRmse", 1.02), ("p99AbsoluteCpError", 1.05)):
        if candidate[field] > base[field] * limit:
            reasons.append(field + "-guard")
    for phase in PHASES:
        b, c = base["byPhase"][phase], candidate["byPhase"][phase]
        if min(b["rows"], c["rows"]) < 100:
            reasons.append(phase + "-coverage")
        elif c["crossEntropy"] > b["crossEntropy"] * 1.01:
            reasons.append(phase + "-CE-guard")
    return reasons


def median_candidate(records):
    if sorted(record["seed"] for record in records) != list(SEEDS):
        raise ValueError("all three fixed seeds required exactly once")
    if any(not record["completed"] for record in records):
        return None
    return sorted(records, key=lambda r: (r["validation"]["crossEntropy"], r["seed"]))[1]


def comparator_predictions(auth, data):
    expanded = data_io.fit.arith.runtime_predictions(data, auth.hce_weights)
    data_io.fit.candidate_parity(data, auth.hce_weights)
    return {"shipped-hce": data.baseline_cp, "frozen-expanded-hce": expanded}


def parity(quantized, params, data, directory):
    features = model.features_from_fens(data.fens)
    reference = quantized.predict_cp(*features)
    floating = model.predict_cp(params, *features)
    delta = np.abs(reference - floating)
    with tempfile.TemporaryDirectory(prefix="h4-parity-", dir=directory) as name:
        temp = Path(name)
        (temp / "model.bin").write_bytes(quantized.to_bytes())
        (temp / "model.json").write_bytes(encoded(quantized.metadata()))
        source = "".join(json.dumps({"id": str(i), "fen": fen}) + "\n" for i, fen in enumerate(data.fens))
        result = subprocess.run(["node", str(ROOT / "test/training/h4-reference.js"),
                                 str(temp / "model.bin"), str(temp / "model.json")],
                                input=source, text=True, capture_output=True, check=True, cwd=ROOT)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
    if len(rows) != len(reference) or any(row["id"] != str(i) for i, row in enumerate(rows)):
        raise ValueError("JS parity inventory differs")
    mismatches = int(np.sum(reference != [row["cpWhite"] for row in rows]))
    report = {"rows": len(reference), "integerMismatches": mismatches,
              "maximumAbsFloatDifferenceCp": float(np.max(delta)),
              "meanAbsFloatDifferenceCp": float(np.mean(delta)),
              "maximumAbsCp": int(np.max(np.abs(reference))),
              "maximumAbsFloatCp": float(np.max(np.abs(floating)))}
    reasons = []
    if mismatches:
        raise ValueError("cross-language semantic mismatch stops experiment")
    if report["maximumAbsFloatDifferenceCp"] > 5 or report["meanAbsFloatDifferenceCp"] > 1:
        reasons.append("quantization-float-difference")
    if max(report["maximumAbsCp"], report["maximumAbsFloatCp"]) > 10000:
        reasons.append("score-range")
    return reference, floating, report, reasons


def bootstrap(data, baseline, candidate):
    def losses(cp):
        logits = np.asarray(cp) / 100
        return np.logaddexp(0, logits) - data.target * logits
    delta = losses(candidate) - losses(baseline)
    families, inverse = np.unique(data.family, return_inverse=True)
    sums, counts = np.bincount(inverse, weights=delta), np.bincount(inverse)
    rng = np.random.default_rng(1050915)
    draws = []
    for _ in range(2000):
        selected = rng.integers(0, len(families), len(families))
        draws.append(np.sum(sums[selected]) / np.sum(counts[selected]))
    return {"families": len(families), "iterations": 2000, "seed": 1050915,
            "candidateMinusBaselineMean": float(np.mean(delta)), "ci95": np.quantile(draws, [.025, .975]).tolist()}


def select(bundle, output):
    rules, expected, head = implementation()
    auth = data_io.authenticate(bundle)
    expected.update(auth.expected)
    # Authentication alone may be repeated on a transfer failure. Reserve before
    # reading model-performance roles or constructing predictions.
    output.mkdir(parents=True, exist_ok=False)
    reserve("run-started", {"head": head, "output": str(output), "contractSha256": CONTRACT_SHA}, expected)
    train = data_io.load_role(auth, "shared-train")
    validation = data_io.load_role(auth, "nnue-validation")
    expected.update(auth.expected)
    data_io.fit.assert_disjoint(data_io.fit.identities(train), data_io.fit.identities(validation))
    comparators = {role: {name: quality_metrics(cp, data) for name, cp in comparator_predictions(auth, data).items()}
                   for role, data in (("train", train), ("validation", validation))}
    features = model.features_from_fens(train.fens)
    records = []
    start = time.monotonic()
    options = rules["training"]
    for seed in SEEDS:
        tick = time.monotonic()
        result = optimize.minimize(model.loss_and_grad, model.initialize(seed),
            args=(*features, train.target), jac=True, method="L-BFGS-B",
            options={"maxiter": options["maxIterations"], "maxfun": options["maxFunctionEvaluations"],
                     "maxls": options["maxLineSearchSteps"], "gtol": options["gradientTolerance"], "ftol": options["functionTolerance"]})
        finite = bool(np.all(np.isfinite(result.x)) and np.isfinite(result.fun))
        completed = finite and (result.success or result.status == 1)
        info = {"seed": seed, "completed": bool(completed), "seconds": time.monotonic() - tick,
                "iterations": int(result.nit), "functionEvaluations": int(result.nfev),
                "converged": bool(result.success), "status": int(result.status), "message": str(result.message)}
        if not completed:
            records.extend([info | {"variant": variant, "validation": None, "stopReasons": ["optimizer-abnormal"]} for variant in VARIANTS])
            continue
        params_payload = encoded(result.x.tolist())
        publish(output / f"seed-{seed}.float.json", params_payload, expected)
        try:
            quantized = model.quantize(result.x)
        except ValueError as error:
            records.extend([info | {"completed": False, "variant": variant, "validation": None,
                                   "stopReasons": ["quantization-rejected: " + str(error)]} for variant in VARIANTS])
            continue
        qpayload = quantized.to_bytes()
        publish(output / f"seed-{seed}.bin", qpayload, expected)
        metadata_payload = encoded(quantized.metadata())
        publish(output / f"seed-{seed}.metadata.json", metadata_payload, expected)
        evaluated = {}
        stops = []
        _, _, authored_parity, authored_reasons = parity(quantized, result.x, SimpleNamespace(fens=AUTHORED_FENS), output)
        stops.extend("authored:" + reason for reason in authored_reasons)
        for role, data in (("train", train), ("validation", validation)):
            quant, floating, evidence, reasons = parity(quantized, result.x, data, output)
            evaluated[role] = (quant, floating, evidence)
            stops.extend(role + ":" + reason for reason in reasons)
        for variant in VARIANTS:
            record = info | {"variant": variant, "floatSha256": digest(params_payload), "modelSha256": digest(qpayload),
                             "metadata": quantized.metadata(), "metadataBytes": len(metadata_payload),
                             "authoredParity": authored_parity, "parity": {role: value[2] for role, value in evaluated.items()}}
            variant_stops = []
            for role, data in (("train", train), ("validation", validation)):
                extra = data.fixed_cp if variant != "net-only" else 0
                record[role] = quality_metrics(evaluated[role][0] + extra, data)
                record[role + "Float"] = quality_metrics(evaluated[role][1] + extra, data)
                if max(np.max(np.abs(evaluated[role][0] + extra)), np.max(np.abs(evaluated[role][1] + extra))) > 10000:
                    variant_stops.append(role + ":ablation-score-range")
            reasons = stops + variant_stops
            for name, base in comparators["validation"].items():
                reasons.extend(name + ":" + reason for reason in guard(base, record["validation"]))
            record["stopReasons"] = reasons
            records.append(record)
        publish(output / f"seed-{seed}.report.json", encoded([r for r in records if r["seed"] == seed]), expected)
        print(json.dumps({"seed": seed, "iterations": info["iterations"], "seconds": info["seconds"]}), flush=True)
    medians = [median_candidate([r for r in records if r["variant"] == variant]) for variant in VARIANTS]
    eligible = [r for r in medians if r is not None and not r["stopReasons"]]
    chosen = None
    if eligible:
        best = min(r["validation"]["crossEntropy"] for r in eligible)
        chosen = min((r for r in eligible if r["validation"]["crossEntropy"] <= best + 1e-12), key=lambda r: VARIANTS.index(r["variant"]))
    report = {"schema": "chessy.h4-screen-selection.v1", "status": "validation-complete-test-unopened",
        "head": head, "contractSha256": CONTRACT_SHA, "labelSummarySha256": SUMMARY_SHA,
        "researchOnly": True, "productionFitAllowed": False, "testOpened": False, "testEligible": bool(chosen),
        "paidSpendUsd": 0, "seconds": time.monotonic() - start, "auditEvidence": auth.evidence,
        "comparators": comparators, "runs": records, "medianSeeds": [None if r is None else r["seed"] for r in medians],
        "selected": chosen, "usedIdentities": {key: sorted(set(data_io.fit.identities(train)[key]) | set(data_io.fit.identities(validation)[key]))
                                                for key in data_io.fit.identities(train)},
        "inputSha256": {str(path): wanted for path, wanted in expected.items()},
        "stopReasons": [] if chosen else ["no-median-seed-variant-passed-frozen-guards"],
        "size": {"parameterBytes": model.BINARY_BYTES, "portableReferenceBytes": (ROOT / "test/training/h4-reference.js").stat().st_size,
                 "productionWasmDeltaMeasured": False}, "runtimeIntegrationPerformed": False}
    payload = encoded(report)
    publish(output / "selection.json", payload, expected)
    reserve("selection-frozen", {"selectionSha256": digest(payload), "output": str(output)}, expected)
    return report


def evaluate_test(bundle, selection_path, output):
    rules, current, _ = implementation()
    frozen_state = json.loads((canonical_state() / "selection-frozen.json").read_bytes())
    report = json.loads(read_exact(selection_path, frozen_state["selectionSha256"]))
    if not report["testEligible"] or report["selected"] is None or report["contractSha256"] != CONTRACT_SHA:
        raise ValueError("no-go or foreign selection cannot open test")
    expected = {Path(path): wanted for path, wanted in report["inputSha256"].items()}
    if any(expected.get(path) != wanted for path, wanted in current.items()):
        raise ValueError("implementation changed since selection")
    recheck(expected)
    auth = data_io.authenticate(bundle)
    if auth.evidence != report["auditEvidence"]:
        raise ValueError("independent audit identity changed")
    expected.update(auth.expected)
    expected[selection_path] = frozen_state["selectionSha256"]
    candidate = report["selected"]
    original = Path(frozen_state["output"])
    params_path = original / f"seed-{candidate['seed']}.float.json"
    model_path = original / f"seed-{candidate['seed']}.bin"
    params = np.asarray(json.loads(read_exact(params_path, candidate["floatSha256"])))
    quantized = model.QuantizedModel.from_bytes(read_exact(model_path, candidate["modelSha256"]), candidate["metadata"]["q2"])
    expected.update({params_path: candidate["floatSha256"], model_path: candidate["modelSha256"]})
    if output.exists():
        raise FileExistsError("refusing to overwrite test output")
    reserve("test-opened", {"selectionSha256": frozen_state["selectionSha256"]}, expected)
    test = data_io.load_role(auth, "nnue-test")
    expected.update(auth.expected)
    data_io.fit.assert_disjoint(report["usedIdentities"], data_io.fit.identities(test))
    quant, floating, parity_report, reasons = parity(quantized, params, test, output.parent)
    if candidate["variant"] != "net-only":
        quant, floating = quant + test.fixed_cp, floating + test.fixed_cp
    if max(np.max(np.abs(quant)), np.max(np.abs(floating))) > 10000:
        reasons.append("ablation-score-range")
    metric = quality_metrics(quant, test)
    comparisons = {}
    for name, cp in comparator_predictions(auth, test).items():
        base = quality_metrics(cp, test)
        interval = bootstrap(test, cp, quant)
        reasons.extend(name + ":" + reason for reason in guard(base, metric))
        if interval["ci95"][1] >= 0:
            reasons.append(name + ":bootstrap-upper95-not-negative")
        comparisons[name] = {"metrics": base, "bootstrap": interval}
    result = {"schema": "chessy.h4-screen-test.v1", "status": "test-completed-research-only", "researchOnly": True,
              "testOpened": True, "selectedSeed": candidate["seed"], "selectedVariant": candidate["variant"],
              "selectionSha256": frozen_state["selectionSha256"], "modelSha256": candidate["modelSha256"],
              "metrics": metric, "floatMetrics": quality_metrics(floating, test), "comparators": comparisons,
              "parity": parity_report, "stopReasons": reasons, "offlineQualityPassed": not reasons,
              "runtimeIntegrationAllowed": False, "formalMatchAllowed": False, "paidSpendUsd": 0}
    publish(output, encoded(result), expected)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["authenticate", "select", "test"])
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selection", type=Path)
    args = parser.parse_args()
    if args.command == "authenticate":
        result = data_io.authenticate(args.bundle.resolve()).evidence
    elif args.command == "select":
        if args.output is None:
            parser.error("select requires --output")
        result = select(args.bundle.resolve(), args.output.resolve())
    else:
        if args.output is None or args.selection is None:
            parser.error("test requires --selection and --output")
        result = evaluate_test(args.bundle.resolve(), args.selection.resolve(), args.output.resolve())
    print(json.dumps({key: value for key, value in result.items() if key in
                     ("status", "testEligible", "testOpened", "stopReasons", "offlineQualityPassed", "auditedFiles")}, sort_keys=True))


if __name__ == "__main__":
    main()
