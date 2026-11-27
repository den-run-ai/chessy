"""Frozen train-only LP correction of the predeclared full interaction table.

Only 4096 training rows are decoded, while the complete train-role files are
authenticated through the same retained descriptors. No validation or holdout
role is opened. The base variant is always 'full', independent of grid scores.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import numpy as np
from scipy import sparse

from .features import N_FEATURES
from .fit import predict, quantize
from .wsp import select_support, solve_sparse_edit


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT/"eval/sparse-pesto-v1/TABLE-EDIT-CONFIG.json"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False)+"\n").encode()


def write(path, raw):
    with Path(path).open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def local_path(root, name):
    if not isinstance(name, str) or Path(name).name != name or name in (".", ".."):
        raise ValueError("input path must be a single local filename")
    path = Path(root)/name
    if path.is_symlink():
        raise ValueError("input file must not be a symlink")
    return path


def retained_prefix(root, item, keep):
    """Authenticate every byte, return a bounded prefix from that descriptor."""
    if type(keep) is not int or keep < 0:
        raise ValueError("prefix size must be nonnegative")
    path = local_path(root, item["path"])
    hasher, total, chunks = hashlib.sha256(), 0, []
    with path.open("rb") as stream:
        initial = os.fstat(stream.fileno())
        while True:
            raw = stream.read(1024*1024)
            if not raw:
                break
            hasher.update(raw)
            if total < keep:
                chunks.append(raw[:keep-total])
            total += len(raw)
        final = os.fstat(stream.fileno())
    visible = path.stat(follow_symlinks=False)
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if (identity(initial) != identity(final) or identity(final) != identity(visible)
            or total != item["bytes"] or hasher.hexdigest() != item["sha256"] or total < keep):
        raise ValueError("retained input failed complete authentication")
    return b"".join(chunks)


def fen_prefix(root, item, count, total_rows):
    path = local_path(root, item["path"])
    hasher, size, rows, selected = hashlib.sha256(), 0, 0, []
    with path.open("rb") as stream:
        initial = os.fstat(stream.fileno())
        for raw in stream:
            if not raw.endswith(b"\n"):
                raise ValueError("incomplete FEN line")
            hasher.update(raw); size += len(raw); rows += 1
            if len(selected) < count:
                selected.append(raw.decode("utf8").rstrip("\n"))
        final = os.fstat(stream.fileno())
    visible = path.stat(follow_symlinks=False)
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if (identity(initial) != identity(final) or identity(final) != identity(visible)
            or size != item["bytes"] or hasher.hexdigest() != item["sha256"]
            or rows != total_rows or len(selected) != count):
        raise ValueError("FEN role inventory failed authentication")
    return selected


def load_train_prefix(manifest_path, expected_sha256, count):
    raw = manifest_path.read_bytes()
    if digest(raw) != expected_sha256:
        raise ValueError("packed manifest SHA-256 changed")
    manifest = json.loads(raw)
    if (manifest.get("schema") != "chessy.sparse-packed.v1"
            or manifest.get("status") != "complete-research-only"
            or manifest.get("researchOnly") is not True or manifest.get("productionFitAllowed") is not False
            or manifest.get("featureCount") != N_FEATURES
            or len(manifest.get("roles", [])) != 3
            or {r.get("role") for r in manifest["roles"]} != {"train", "validation", "holdout"}):
        raise ValueError("incomplete packed role declaration")
    train = next(r for r in manifest["roles"] if r["role"] == "train")
    keys = {"indices.i32", "values.f32", "indptr.i64", "teacher.f64", "baseline.i32",
            "phase.u8", "family.u32", "fens.txt"}
    if set(train["files"]) != keys or type(count) is not int or not 0 < count <= train["rows"]:
        raise ValueError("invalid train prefix or file inventory")
    files, root = train["files"], manifest_path.parent
    for name, item in files.items():
        if item["path"] != "train."+name:
            raise ValueError("train-role file path mismatch")
    indptr = np.frombuffer(retained_prefix(root, files["indptr.i64"], (count+1)*8), dtype="<i8")
    if indptr[0] != 0 or np.any(np.diff(indptr) < 0) or indptr[-1] > train["nnz"]:
        raise ValueError("invalid prefix row pointers")
    nnz = int(indptr[-1])
    indices = np.frombuffer(retained_prefix(root, files["indices.i32"], nnz*4), dtype="<i4")
    values = np.frombuffer(retained_prefix(root, files["values.f32"], nnz*4), dtype="<f4")
    teacher = np.frombuffer(retained_prefix(root, files["teacher.f64"], count*8), dtype="<f8")
    baseline = np.frombuffer(retained_prefix(root, files["baseline.i32"], count*4), dtype="<i4")
    phase = np.frombuffer(retained_prefix(root, files["phase.u8"], count), dtype="u1")
    retained_prefix(root, files["family.u32"], 0)  # authenticate the declared unused inventory too
    fens = fen_prefix(root, files["fens.txt"], count, train["rows"])
    if (np.any((indices < 0) | (indices >= N_FEATURES)) or not np.all(np.isfinite(values))
            or not np.all(np.isfinite(teacher)) or np.any(np.abs(teacher) > 2000)
            or np.any(phase > 24)):
        raise ValueError("invalid training-prefix values")
    X = sparse.csr_matrix((values, indices, indptr), shape=(count, N_FEATURES))
    if not X.has_canonical_format or np.any(X.data == 0):
        raise ValueError("noncanonical prefix feature matrix")
    return X, teacher, baseline, fens


def quality(target, prediction):
    error = np.asarray(prediction)-target
    return {"rows": len(error), "maeCp": float(np.mean(np.abs(error))),
            "rmseCp": float(np.sqrt(np.mean(error*error))), "meanSignedErrorCp": float(np.mean(error))}


def native_eval(binary, weights, fens):
    result = subprocess.run([str(binary), "eval", str(weights)], input="\n".join(fens)+"\n",
                            capture_output=True, text=True, check=True, timeout=60)
    lines = result.stdout.splitlines()
    if len(lines) != len(fens):
        raise ValueError("incomplete native evaluation")
    decoded = np.asarray([list(map(int, line.split())) for line in lines])
    if decoded.shape != (len(fens), 3):
        raise ValueError("unexpected native score layout")
    return decoded, digest(result.stdout.encode())


def run(packed_manifest, fit_entry, output):
    packed_bytes = packed_manifest.read_bytes()
    packed_sha = digest(packed_bytes)
    manifest = json.loads(packed_bytes)
    entry_bytes = fit_entry.read_bytes()
    entry = json.loads(entry_bytes)
    plan_bytes = (fit_entry.parent/"plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    config_bytes = CONFIG.read_bytes()
    config = json.loads(config_bytes)
    if (entry.get("id") != config["baseVariant"] or entry.get("fit", {}).get("numericallyConverged") is not True
            or plan.get("schema") != "chessy.sparse-fit-plan.v1"
            or plan.get("sourceManifestSha256") != packed_sha
            or [r for r in plan.get("grid", []) if r.get("id") == "full"] !=
               [{"id": "full", "families": ["pst", "own_king", "enemy_king", "pawn_context", "ray"],
                 "l2": 1e-4, "l1": 1e-5}]):
        raise ValueError("base must be the completed predeclared full fit tied to this packed corpus")
    weight_bytes = retained_prefix(fit_entry.parent, entry["weights"], 2*N_FEATURES)
    if entry["weights"]["bytes"] != 2*N_FEATURES:
        raise ValueError("unexpected full-model parameter bytes")
    weights = np.frombuffer(weight_bytes, dtype="<i2")
    runtime_bytes = (packed_manifest.parent/"extractor").read_bytes()
    if digest(runtime_bytes) != manifest["nativeSha256"]:
        raise ValueError("native evaluator bytes differ from the frozen packed extractor")
    implementation = {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in
                      (Path(__file__), ROOT/"tools/sparse_eval/wsp.py", ROOT/"tools/sparse_eval/fit.py",
                       ROOT/"tools/sparse_eval/features.py")}
    output.mkdir(parents=True, exist_ok=False)
    binary = output/"extractor"
    write(binary, runtime_bytes); binary.chmod(0o500)
    write(output/"before.i16le", weight_bytes)
    frozen = {"config": config, "configSha256": digest(config_bytes), "packedManifestSha256": packed_sha,
              "fitEntrySha256": digest(entry_bytes), "fitPlanSha256": digest(plan_bytes),
              "baseModelSha256": digest(weight_bytes), "nativeSha256": digest(runtime_bytes),
              "implementation": implementation, "validationUsedToChooseBase": False}
    write(output/"config-frozen.json", encoded(frozen))
    print(json.dumps({"stage": "table-edit-config-frozen", "baseModelSha256": digest(weight_bytes)}), flush=True)
    started = time.monotonic()
    X, target, hce, fens = load_train_prefix(packed_manifest, packed_sha, config["trainPrefixRows"])
    before = predict(X, hce, weights)
    n = config["repairRows"]
    if n+config["preservationRows"] != len(target):
        raise ValueError("inconsistent repair/preservation declaration")
    support = select_support(X, weights, budget=config["supportBudget"])
    rms = np.sqrt(np.asarray(X.astype(np.float64).power(2).mean(axis=0)).ravel())
    write(output/"support-frozen.json", encoded({"columns": support.tolist(), "usesOnlyTrainPrefix": True}))
    fit = solve_sparse_edit(X[:n], before[:n], target[:n], support=support,
            l1=config["l1"], feature_cost=np.maximum(rms, 1e-12),
            max_abs_delta=config["maximumAbsoluteCoefficientDeltaCp"], preserve_X=X[n:],
            preserve_epsilon=config["floatingPreservationEpsilonCp"],
            time_limit=config["solverTimeLimitSeconds"])
    report = {"schema": "chessy.sparse-table-edit.v1", "frozen": frozen, "optimization": fit.report,
              "validationOpened": False, "holdoutOpened": False, "trainOnlyMechanismDiagnostic": True,
              "additionalCandidateSelectionAllowed": False, "productionEligible": False,
              "playingStrengthMeasured": False, "baseVariant": "full", "baseVariantChosenBeforeScores": True}
    if not fit.report["success"]:
        report["outcome"] = "optimization-failed"
    else:
        candidate = quantize(weights.astype(np.float64)+fit.delta)
        write(output/"after.i16le", candidate.tobytes())
        changed = np.flatnonzero(candidate != weights)
        patch = {"schema": "chessy.sparse-table-correction.v1", "baseModelSha256": digest(weight_bytes),
                 "resultModelSha256": digest(candidate.tobytes()), "productionEligible": False,
                 "changes": [{"index": int(i), "old": int(weights[i]), "new": int(candidate[i])} for i in changed]}
        write(output/"correction.patch.json", encoded(patch))
        after = predict(X, hce, candidate)
        actual_before, before_trace = native_eval(binary, output/"before.i16le", fens)
        actual_after, after_trace = native_eval(binary, output/"after.i16le", fens)
        mismatches = int(np.count_nonzero(actual_before[:, 1] != before)+
                         np.count_nonzero(actual_after[:, 1] != after)+
                         np.count_nonzero(actual_before[:, 0] != hce)+
                         np.count_nonzero(actual_after[:, 0] != hce))
        drift = int(np.max(np.abs(actual_after[n:, 1]-actual_before[n:, 1]), initial=0))
        passed = drift <= config["integerPreservationGateCp"]
        report.update(changedIntegerCoefficients=len(changed),
            resultModelSha256=digest(candidate.tobytes()),
            maximumIntegerPreservationChangeCp=drift, integerPreservationPassed=passed,
            repair={"before": quality(target[:n], actual_before[:n, 1]),
                    "after": quality(target[:n], actual_after[:n, 1])},
            preservation={"before": quality(target[n:], actual_before[n:, 1]),
                          "after": quality(target[n:], actual_after[n:, 1])},
            nativeParity={"rowsPerModel": len(fens), "models": 2, "mismatches": mismatches,
                          "beforeTranscriptSha256": before_trace, "afterTranscriptSha256": after_trace},
            outcome="diagnostic-complete" if passed and not mismatches else "quantized-candidate-rejected")
    report["elapsedSeconds"] = time.monotonic()-started
    if (packed_manifest.read_bytes() != packed_bytes or fit_entry.read_bytes() != entry_bytes
            or (fit_entry.parent/"plan.json").read_bytes() != plan_bytes or CONFIG.read_bytes() != config_bytes
            or any(digest((ROOT/path).read_bytes()) != sha for path, sha in implementation.items())
            or binary.read_bytes() != runtime_bytes):
        raise ValueError("input or implementation changed before completion")
    write(output/"report.json", encoded(report))
    print(json.dumps({"stage": "table-edit-completed", "outcome": report["outcome"],
                      "changedIntegerCoefficients": report.get("changedIntegerCoefficients"),
                      "maximumIntegerPreservationChangeCp": report.get("maximumIntegerPreservationChangeCp")}), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packed-manifest", type=Path, required=True)
    parser.add_argument("--fit-entry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.packed_manifest, args.fit_entry, args.output)


if __name__ == "__main__":
    main()
