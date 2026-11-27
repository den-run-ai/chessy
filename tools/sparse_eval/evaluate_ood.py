#!/usr/bin/env python3
"""One transfer diagnosis of the already selected model on fresh SF18 labels.

No alternative model or hyperparameter is evaluated or selected here.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

import numpy as np
from scipy import sparse

from .features import extract, baseline_score, N_FEATURES
from .fit import predict, metrics
from .pipeline import authenticated_bytes, write, write_json, read_json, code_receipt


def run(fit_path, labels_path, output, runtime):
    fit_path, labels_path, output, runtime = map(Path, (fit_path, labels_path, output, runtime))
    fitted, fit_sha = read_json(fit_path)
    labels, labels_sha = read_json(labels_path)
    if fitted.get("status") != "complete-research-only" or fitted.get("selected") == "baseline":
        raise ValueError("requires the completed frozen non-baseline validation choice")
    if labels.get("researchOnly") is not True or labels.get("productionFitAllowed") is not False:
        raise ValueError("requires research OOD labels")
    if not labels.get("status", "").startswith("complete"):
        raise ValueError("requires completed OOD labels")
    audit_path = labels_path.parent / "independent-audit.json"
    audit_bytes = audit_path.read_bytes()
    audit = json.loads(audit_bytes)
    if audit.get("status") != "pass" and audit.get("passed") is not True:
        raise ValueError("requires a successful independent label audit")
    if audit.get("labelManifestSha256") != labels_sha or audit.get("rowsVerified") != 4096:
        raise ValueError("independent audit does not bind this complete label manifest")
    chosen = next(row for row in fitted["candidates"] if row["id"] == fitted["selected"])
    weight_bytes = authenticated_bytes(fit_path.parent, chosen["weights"])
    weights = np.frombuffer(weight_bytes, dtype="<i2")
    if weights.shape != (N_FEATURES,):
        raise ValueError("invalid selected weight inventory")
    binary = runtime.read_bytes()
    implementation = code_receipt()
    output.mkdir(parents=False, exist_ok=False)
    native_path, weight_path = output / "sparse-eval", output / "selected.i16le"
    native = write(native_path, binary); native_path.chmod(0o500)
    model = write(weight_path, weight_bytes); weight_path.chmod(0o400)
    # Freeze before decoding any OOD teacher scores.
    write_json(output / "plan.json", {"schema": "chessy.sparse-ood-evaluation-plan.v1",
        "researchOnly": True, "model": chosen["id"], "weights": model,
        "fitResultsSha256": fit_sha, "labelsManifestSha256": labels_sha,
        "auditSha256": hashlib.sha256(audit_bytes).hexdigest(), "native": native,
        "implementation": implementation, "usesOODForSelection": False,
        "metricScaleCp": 400})
    files = labels["files"]
    if isinstance(files, dict):
        items = list(files.values())
    else:
        items = files
    binding = next(item for item in items if item["path"] == "labels.jsonl")
    payload = authenticated_bytes(labels_path.parent, binding)
    rows = [json.loads(line) for line in payload.splitlines()]
    if len(rows) != binding["rows"]:
        raise ValueError("incomplete OOD label inventory")
    accepted = [row for row in rows if row.get("teacher") is not None]
    if not accepted or len(accepted) != labels["counts"]["accepted"]:
        raise ValueError("no admitted OOD labels")
    fens = [row["fen"] for row in accepted]
    if len(set(row["sourceGameId"] for row in accepted)) != len(accepted):
        raise ValueError("duplicate source games")
    indices, values, indptr = [], [], [0]
    for fen in fens:
        ids, vals = extract(fen)
        indices.extend(ids); values.extend(vals); indptr.append(len(indices))
    x = sparse.csr_matrix((values, indices, indptr), shape=(len(fens), N_FEATURES))
    baseline = np.array([baseline_score(fen) for fen in fens])
    candidate = predict(x, baseline, weights)
    command = subprocess.run([str(native_path), "eval", str(weight_path)],
                             input="\n".join(fens)+"\n", text=True, capture_output=True, check=True)
    native_scores = np.asarray([list(map(int, line.split())) for line in command.stdout.splitlines()])
    if (native_scores.shape != (len(fens), 3) or
        not np.array_equal(native_scores[:, 0], baseline) or
        not np.array_equal(native_scores[:, 1], candidate) or
        not np.array_equal(native_scores[:, 2], candidate-baseline)):
        raise ValueError("OOD native/reference parity failed")
    score_file = write(output / "native-scores.txt", command.stdout.encode())
    teacher = np.array([row["teacher"]["cpWhite"] for row in accepted])
    phase = np.array([row["phase"] for row in accepted])
    result = {"schema": "chessy.sparse-ood-evaluation.v1", "status": "complete-research-only",
        "researchOnly": True, "productionEligible": False, "selected": chosen["id"],
        "weightsSha256": chosen["weights"]["sha256"], "fitResultsSha256": fit_sha,
        "labelsManifestSha256": labels_sha, "independentAuditSha256": hashlib.sha256(audit_bytes).hexdigest(),
        "implementation": implementation, "native": native, "nativeScores": score_file,
        "sourceRows": len(rows), "acceptedRows": len(accepted), "distinctSourceGames": len(accepted),
        "nativeParityMismatches": 0, "usesOODForSelection": False,
        "baseline": metrics(baseline, teacher, phase), "selectedModel": metrics(candidate, teacher, phase),
        "limitations": ["strict admission excludes part of the balanced source sample",
                        "separate archive and family/cluster exclusion; upstream game disjointness unprovable",
                        "static agreement with fixed Stockfish18 at100k nodes is not an Elo result"]}
    if code_receipt() != implementation:
        raise ValueError("implementation changed during OOD evaluation")
    write_json(output / "results.json", result)
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fit", required=True, type=Path)
    p.add_argument("--labels", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--runtime", required=True, type=Path)
    a = p.parse_args()
    print(json.dumps(run(a.fit, a.labels, a.output, a.runtime), sort_keys=True))
