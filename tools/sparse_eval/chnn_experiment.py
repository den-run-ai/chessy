"""One frozen, bounded direct NNUE head-edit diagnostic; never opens holdout.

Run as python -m tools.sparse_eval.chnn_experiment. Source weights and the
dataset live outside the repository. The retained config is written before
training rows are decoded; the candidate is frozen before validation opens.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

import numpy as np

from .chnn import FrozenCHNN
from .wsp import solve_sparse_edit


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "eval/sparse-pesto-v1/CHNN-CONFIG.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False)+"\n").encode()


def publish(path, data):
    with path.open("xb") as stream:
        stream.write(data)


def prefix(dataset, manifest, role, count):
    entries = [entry for entry in manifest["files"] if entry["role"] == role]
    if len(entries) != 1 or entries[0]["path"] != role+".jsonl":
        raise ValueError("dataset role inventory is incomplete or ambiguous")
    entry = entries[0]
    retained, hasher, rows, size = [], hashlib.sha256(), 0, 0
    previous = -1
    # Hash and consume the same descriptor; only the selected prefix is decoded.
    with (dataset/entry["path"]).open("rb") as stream:
        for line in stream:
            hasher.update(line)
            size += len(line)
            rows += 1
            if len(retained) < count:
                row = json.loads(line)
                if (row["role"] != role or type(row["sourceRecord"]) is not int
                        or row["sourceRecord"] <= previous or not np.isfinite(row["cpWhite"])):
                    raise ValueError("invalid or unordered dataset prefix")
                previous = row["sourceRecord"]
                retained.append(row)
    if (len(retained) != count or rows != entry["rows"] or size != entry["bytes"]
            or hasher.hexdigest() != entry["sha256"]):
        raise ValueError("retained dataset descriptor failed authentication")
    return retained


def metrics(target, prediction):
    error = np.asarray(prediction)-target
    return {"rows": len(error), "maeCp": float(np.mean(np.abs(error))),
            "rmseCp": float(np.sqrt(np.mean(error*error))),
            "maximumAbsoluteErrorCp": float(np.max(np.abs(error)))}


def native_parity(binary, net, fens, model):
    command = "".join("position fen "+fen+"\neval\n" for fen in fens)+"quit\n"
    result = subprocess.run([str(binary), "--nnue", str(net)], input=command, text=True,
                            capture_output=True, timeout=60, check=True)
    found = [int(v) for v in re.findall(r"nnue: Some\((-?\d+)\)", result.stdout)]
    batch = model.activations(fens)
    expected = (model.predict(batch)*batch.turn).tolist()
    if len(found) != len(expected):
        raise ValueError("native engine returned incomplete static scores")
    return {"rows": len(found), "mismatches": sum(a != b for a, b in zip(found, expected)),
            "transcriptSha256": digest(result.stdout.encode()),
            "maximumDifferenceCp": max(abs(a-b) for a, b in zip(found, expected))}


def run(manifest_path, net_path, output, native_binary, native_sha256):
    config_bytes = CONFIG.read_bytes()
    config = json.loads(config_bytes)
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if (manifest.get("schema") != "chessy.sparse-eval-data.v1"
            or manifest.get("researchOnly") is not True or manifest.get("productionFitAllowed") is not False):
        raise ValueError("expected research-only admitted data manifest")
    native_bytes = native_binary.read_bytes()
    if digest(native_bytes) != native_sha256:
        raise ValueError("native binary SHA-256 mismatch")
    model = FrozenCHNN.from_file(net_path, expected_sha256=config["sourceNetSha256"])
    if len(model.payload) != config["sourceNetBytes"]:
        raise ValueError("source network size mismatch")
    output.mkdir(parents=True, exist_ok=False)
    # Execute and evaluate retained authenticated snapshots, not reopened sources.
    source_snapshot, native_snapshot = output/"source.nnue", output/"chatarunga"
    publish(source_snapshot, model.payload)
    publish(native_snapshot, native_bytes)
    source_snapshot.chmod(0o444)
    native_snapshot.chmod(0o555)
    implementation = {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in
                      (Path(__file__), ROOT/"tools/sparse_eval/chnn.py", ROOT/"tools/sparse_eval/wsp.py",
                       ROOT/"tools/sparse_eval/features.py")}
    frozen = {"config": config, "configSha256": digest(config_bytes),
              "datasetManifestSha256": digest(manifest_bytes), "implementation": implementation,
              "nativeBinarySha256": native_sha256, "nativePath": str(native_binary),
              "source": model.metadata()}
    publish(output/"config-frozen.json", encoded(frozen))
    print(json.dumps({"stage": "config-frozen", "configSha256": digest(config_bytes)}), flush=True)
    started = time.monotonic()
    train = prefix(manifest_path.parent, manifest, "train", config["trainPrefixRows"])
    n = config["repairRows"]
    if n+config["preservationRows"] != len(train):
        raise ValueError("repair/preservation inventory differs")
    fens = [r["fen"] for r in train]
    target = np.asarray([r["cpWhite"] for r in train], dtype=np.float64)
    batch = model.activations(fens)
    X = model.design(batch)
    baseline_float = model.predict(batch, integer=False)
    baseline_int = model.predict(batch)
    frequencies = Counter(r["family"] for r in train[:n])
    sample_weight = np.asarray([1/frequencies[r["family"]] for r in train[:n]])
    sample_weight /= sample_weight.sum()
    rms = np.sqrt(np.asarray(X[:n].power(2).T@sample_weight).ravel())
    derivative = np.asarray(X[:n].T@(sample_weight*np.sign(baseline_float[:n]-target[:n]))).ravel()
    effect = np.abs(derivative)/np.maximum(rms, 1e-12)
    eligible = np.flatnonzero(rms > 0)
    order = np.lexsort((eligible, -effect[eligible]))
    support = eligible[order[:config["supportBudget"]]]
    publish(output/"support-frozen.json", encoded({"columns": support.tolist(),
            "trainingSourceRecords": [train[0]["sourceRecord"], train[-1]["sourceRecord"]],
            "selectionUsesValidation": False, "derivativeScores": effect[support].tolist()}))
    print(json.dumps({"stage": "lp-started", "repairRows": n, "preservationRows": len(train)-n,
                      "support": len(support)}), flush=True)
    fit = solve_sparse_edit(X[:n], baseline_float[:n], target[:n], support=support,
            l1=config["l1"], feature_cost=np.maximum(rms, 1e-12), sample_weight=sample_weight,
            max_abs_delta=config["maximumAbsoluteHeadWeightDelta"], preserve_X=X[n:],
            preserve_epsilon=config["floatingPreservationEpsilonCp"],
            time_limit=config["solverTimeLimitSeconds"])
    report = {"schema": "chessy.chnn-head-screen.v1", "frozen": frozen, "optimization": fit.report,
              "researchOnly": True, "productionEligible": False, "playingStrengthMeasured": False,
              "holdoutOpened": False, "validationOpened": False, "outputBiasesFrozen": True,
              "supportSelectionIsConvex": False, "quantizedOptimizationIsConvex": False,
              "staticNetworkOnly": True, "upstreamMaterialSearchCalibrationIncluded": False,
              "trainRows": len(train), "trainFamilies": len({r["family"] for r in train}),
              "sourceGameLineageAvailable": all(r["sourceGameId"] is not None for r in train)}
    if not fit.report["success"]:
        report.update(outcome="optimization-failed", elapsedSeconds=time.monotonic()-started)
        publish(output/"report.json", encoded(report))
        print(json.dumps({"stage": "completed", "outcome": report["outcome"]}), flush=True)
        return report
    delta = np.rint(fit.delta).astype(np.int64)
    patch, payload = model.patch(delta)
    patched = FrozenCHNN(payload)
    publish(output/"output-head.patch.json", encoded(patch))
    publish(output/"patched.nnue", payload)
    candidate_frozen = {"patchSha256": digest(encoded(patch)), "networkSha256": digest(payload),
                        "changedWeights": len(patch["changes"]), "validationOpened": False,
                        "nearestTiesToEven": True}
    publish(output/"candidate-frozen.json", encoded(candidate_frozen))
    print(json.dumps({"stage": "candidate-frozen", **candidate_frozen}), flush=True)
    edited_int = model.predict(batch, delta=delta)
    integer_preserve = int(np.max(np.abs(edited_int[n:]-baseline_int[n:]), initial=0))
    report.update(candidate=candidate_frozen, maximumIntegerPreservationChangeCp=integer_preserve,
                  integerPreservationPassed=integer_preserve <= config["integerPreservationGateCp"],
                  repair={"before": metrics(target[:n], baseline_int[:n]),
                          "after": metrics(target[:n], edited_int[:n])},
                  preservation={"before": metrics(target[n:], baseline_int[n:]),
                                "after": metrics(target[n:], edited_int[n:])})
    validation = prefix(manifest_path.parent, manifest, "validation", config["validationPrefixRows"])
    report["validationOpened"] = True
    if {r["family"] for r in train} & {r["family"] for r in validation}:
        raise ValueError("train/validation family overlap")
    vfens = [r["fen"] for r in validation]
    vtarget = np.asarray([r["cpWhite"] for r in validation], dtype=np.float64)
    vbatch = model.activations(vfens)
    before, after = model.predict(vbatch), model.predict(vbatch, delta=delta)
    report["validation"] = {"before": metrics(vtarget, before), "after": metrics(vtarget, after),
                            "families": len({r["family"] for r in validation}),
                            "selectionUsesValidation": False}
    parity_fens = fens[:config["nativeParityRowsPerSplit"]]+vfens[:config["nativeParityRowsPerSplit"]]
    report["nativeParity"] = {
        "source": native_parity(native_snapshot, source_snapshot, parity_fens, model),
        "edited": native_parity(native_snapshot, output/"patched.nnue", parity_fens, patched)}
    parity_passed = all(v["mismatches"] == 0 for v in report["nativeParity"].values())
    report["outcome"] = ("diagnostic-complete" if parity_passed and report["integerPreservationPassed"]
                         else "quantized-candidate-failed-preservation-or-parity")
    report["elapsedSeconds"] = time.monotonic()-started
    # Detect implementation or input-manifest changes before publishing completion.
    if (CONFIG.read_bytes() != config_bytes or manifest_path.read_bytes() != manifest_bytes
            or any(digest((ROOT/p).read_bytes()) != sha for p, sha in implementation.items())
            or digest(native_snapshot.read_bytes()) != native_sha256
            or digest(source_snapshot.read_bytes()) != config["sourceNetSha256"]):
        raise ValueError("implementation/input identity changed during diagnostic")
    publish(output/"report.json", encoded(report))
    print(json.dumps({"stage": "completed", "outcome": report["outcome"],
                      "validation": report["validation"], "nativeParity": report["nativeParity"]}), flush=True)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dataset-manifest", type=Path, required=True)
    p.add_argument("--net", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--native-binary", type=Path, required=True)
    p.add_argument("--native-binary-sha256", required=True)
    a = p.parse_args()
    run(a.dataset_manifest, a.net, a.output, a.native_binary, a.native_binary_sha256)


if __name__ == "__main__":
    main()
