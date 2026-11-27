#!/usr/bin/env python3
"""Hash-bound packing, fitting, and once-only holdout research pipeline.

Every output directory is an exclusive reservation. Completion manifests are
written last; partial directories are evidence of failure, never fit inputs.
Run this code from an immutable source snapshot for real experiments.
"""
from __future__ import annotations

import argparse
from array import array
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from scipy import sparse

from tools.sparse_eval.features import N_FEATURES, BASE_FEATURES
from tools.sparse_eval.fit import GRID, fit, quantize, predict, metrics, eligible

ROOT = Path(__file__).resolve().parents[2]
ROLES = ("train", "validation", "holdout")


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def read_json(path):
    data = Path(path).read_bytes()
    return json.loads(data), sha(data)


def write(path, data):
    with open(path, "xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": Path(path).name, "sha256": sha(data), "bytes": len(data)}


def write_json(path, value):
    return write(path, encoded(value))


def bound_path(root, name):
    if not isinstance(name, str) or Path(name).name != name or name in (".", ".."):
        raise ValueError("manifest file must be a single relative filename")
    path = Path(root) / name
    if path.is_symlink():
        raise ValueError("manifest inputs may not be symlinks")
    return path


def authenticated_bytes(root, item):
    data = bound_path(root, item["path"]).read_bytes()
    if len(data) != item["bytes"] or sha(data) != item["sha256"]:
        raise ValueError("input bytes do not match manifest: " + item["path"])
    return data


def code_receipt():
    paths = sorted((ROOT / "tools/sparse_eval").glob("*.py"))
    paths += [ROOT / p for p in (
        "tools/sparse_eval/runtime.rs", "experiments/wasm/src/engine.rs",
        "experiments/wasm/src/eval.rs", "experiments/wasm/src/search.rs",
        "eval/sparse-pesto-v1/PLAN.md")]
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in paths if p.exists()}


class Writer:
    def __init__(self, path):
        self.path = path
        self.stream = open(path, "xb")
        self.hash = hashlib.sha256()
        self.size = 0

    def add(self, data):
        self.stream.write(data)
        self.hash.update(data)
        self.size += len(data)

    def finish(self):
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        return {"path": self.path.name, "sha256": self.hash.hexdigest(), "bytes": self.size}


def pack(manifest_path, output, runtime):
    manifest_path, output, runtime = map(Path, (manifest_path, output, runtime))
    manifest, manifest_sha = read_json(manifest_path)
    if (manifest.get("schema") != "chessy.sparse-eval-data.v1" or
        manifest.get("status") != "complete-research-only" or
        manifest.get("researchOnly") is not True or manifest.get("productionFitAllowed") is not False):
        raise ValueError("requires completed exploratory data, never certification input")
    files = manifest.get("files", [])
    if len(files) != 3 or {f.get("role") for f in files} != set(ROLES):
        raise ValueError("all three independently declared roles are required")
    receipt = code_receipt()
    runtime_data = runtime.read_bytes()
    output.mkdir(parents=False, exist_ok=False)
    # Execute a retained private copy of exactly the authenticated native bytes.
    native = output / "extractor"
    write(native, runtime_data)
    native.chmod(0o500)
    write_json(output / "plan.json", {"sourceManifestSha256": manifest_sha,
        "implementation": receipt, "nativeSha256": sha(runtime_data),
        "featureCount": N_FEATURES, "researchOnly": True})
    packed = []
    all_families, all_clusters = set(), set()
    start = time.monotonic()
    for role in ROLES:
        item = next(f for f in files if f["role"] == role)
        source = bound_path(manifest_path.parent, item["path"])
        writers = {name: Writer(output / (role + "." + name)) for name in
                   ("indices.i32", "values.f32", "indptr.i64", "teacher.f64",
                    "baseline.i32", "phase.u8", "family.u32", "fens.txt")}
        writers["indptr.i64"].add(np.array([0], dtype="<i8").tobytes())
        families, clusters, family_counts = {}, set(), Counter()
        rows = nnz = 0
        source_hash, source_size = hashlib.sha256(), 0

        def consume(batch):
            nonlocal rows, nnz
            fens = "\n".join(row["fen"] for row in batch) + "\n"
            result = subprocess.run([str(native), "features"], input=fens,
                                    capture_output=True, text=True, check=True)
            lines = result.stdout.splitlines()
            if len(lines) != len(batch):
                raise ValueError("native extractor row count mismatch")
            indices, values, pointers = array("i"), array("f"), array("q")
            targets, baselines, phases, family_ids = [], [], [], []
            for row, line in zip(batch, lines):
                fields = line.split()
                baseline, phase = map(int, fields[:2])
                if phase != row["phase"] or row["role"] != role:
                    raise ValueError("row phase/role mismatch")
                if not np.isfinite(row["cpWhite"]) or abs(row["cpWhite"]) > 2000:
                    raise ValueError("invalid admitted teacher score")
                family, cluster = row["family"], row["cluster"]
                if family in all_families or cluster in all_clusters or cluster in clusters:
                    raise ValueError("cross-role family or duplicate-cluster leakage")
                family_id = families.setdefault(family, len(families))
                family_counts[family_id] += 1
                clusters.add(cluster)
                raw = [tuple(map(int, term.split(":"))) for term in fields[2:]]
                if any(not 0 <= j < BASE_FEATURES or count == 0 for j, count in raw):
                    raise ValueError("invalid native sparse feature")
                if [j for j, _ in raw] != sorted(set(j for j, _ in raw)):
                    raise ValueError("native features not unique and sorted")
                for offset, factor in ((0, phase / 24), (BASE_FEATURES, (24-phase) / 24)):
                    if factor:
                        indices.extend(j + offset for j, _ in raw)
                        values.extend(count * factor for _, count in raw)
                        nnz += len(raw)
                pointers.append(nnz)
                targets.append(row["cpWhite"])
                baselines.append(baseline)
                phases.append(phase)
                family_ids.append(family_id)
            if sys.byteorder != "little":
                indices.byteswap(); values.byteswap(); pointers.byteswap()
            for name, data in (("indices.i32", indices.tobytes()), ("values.f32", values.tobytes()),
                               ("indptr.i64", pointers.tobytes()),
                               ("teacher.f64", np.asarray(targets, dtype="<f8").tobytes()),
                               ("baseline.i32", np.asarray(baselines, dtype="<i4").tobytes()),
                               ("phase.u8", np.asarray(phases, dtype="u1").tobytes()),
                               ("family.u32", np.asarray(family_ids, dtype="<u4").tobytes()),
                               ("fens.txt", fens.encode())):
                writers[name].add(data)
            rows += len(batch)

        with source.open("rb") as stream:
            identity = os.fstat(stream.fileno())
            batch = []
            for line in stream:
                source_hash.update(line)
                source_size += len(line)
                batch.append(json.loads(line))
                if len(batch) == 4096:
                    consume(batch); batch = []
            if batch:
                consume(batch)
            final = os.fstat(stream.fileno())
            current = os.stat(source, follow_symlinks=False)
            if (identity.st_ino, identity.st_dev, identity.st_size, identity.st_mtime_ns) != (
                final.st_ino, final.st_dev, final.st_size, final.st_mtime_ns) or (
                current.st_ino, current.st_dev) != (final.st_ino, final.st_dev):
                raise ValueError("source changed while consumed")
        if source_hash.hexdigest() != item["sha256"] or source_size != item["bytes"] or rows != item["rows"]:
            raise ValueError("consumed source does not match complete role declaration")
        if not rows or max(family_counts.values()) > 8:
            raise ValueError("invalid family support inventory")
        all_families.update(families)
        all_clusters.update(clusters)
        packed.append({"role": role, "rows": rows, "nnz": nnz, "families": len(families),
                       "files": {name: writer.finish() for name, writer in writers.items()}})
        print(json.dumps({"packed": role, "rows": rows, "nnz": nnz}), flush=True)
    if code_receipt() != receipt or sha(native.read_bytes()) != sha(runtime_data):
        raise ValueError("implementation changed during pack")
    result = {"schema": "chessy.sparse-packed.v1", "status": "complete-research-only",
              "researchOnly": True, "productionFitAllowed": False, "featureCount": N_FEATURES,
              "sourceManifestSha256": manifest_sha, "sourceCounts": manifest["counts"],
              "implementation": receipt, "nativeSha256": sha(runtime_data), "roles": packed,
              "seconds": time.monotonic()-start,
              "noCrossRoleFamilyOrClusterOverlap": True, "uniqueSourceGames": None}
    write_json(output / "manifest.json", result)
    return result


def load_role(manifest_path, role):
    manifest_path = Path(manifest_path)
    manifest, _ = read_json(manifest_path)
    if (manifest.get("schema") != "chessy.sparse-packed.v1" or
        manifest.get("status") != "complete-research-only" or
        manifest.get("featureCount") != N_FEATURES or
        len(manifest.get("roles", [])) != 3 or
        {r.get("role") for r in manifest["roles"]} != set(ROLES)):
        raise ValueError("incomplete packed-role inventory")
    part = next(r for r in manifest["roles"] if r["role"] == role)
    expected = {"indices.i32", "values.f32", "indptr.i64", "teacher.f64", "baseline.i32", "phase.u8", "family.u32", "fens.txt"}
    if set(part["files"]) != expected:
        raise ValueError("incomplete packed file inventory")
    arrays = {}
    for key, dtype in (("indices.i32", "<i4"), ("values.f32", "<f4"), ("indptr.i64", "<i8"),
                       ("teacher.f64", "<f8"), ("baseline.i32", "<i4"),
                       ("phase.u8", "u1"), ("family.u32", "<u4")):
        arrays[key] = np.frombuffer(authenticated_bytes(manifest_path.parent, part["files"][key]), dtype=dtype)
    n, nnz = part["rows"], part["nnz"]
    if (len(arrays["indices.i32"]) != nnz or len(arrays["values.f32"]) != nnz or
        len(arrays["indptr.i64"]) != n+1 or arrays["indptr.i64"][0] != 0 or arrays["indptr.i64"][-1] != nnz or
        np.any(np.diff(arrays["indptr.i64"]) < 0) or
        np.any((arrays["indices.i32"] < 0) | (arrays["indices.i32"] >= N_FEATURES)) or
        not np.all(np.isfinite(arrays["values.f32"])) or
        any(len(arrays[k]) != n for k in ("teacher.f64", "baseline.i32", "phase.u8", "family.u32")) or
        not np.all(np.isfinite(arrays["teacher.f64"])) or np.any(arrays["phase.u8"] > 24)):
        raise ValueError("invalid packed array dimensions/values")
    family = arrays["family.u32"]
    counts = np.bincount(family, minlength=part["families"])
    if len(counts) != part["families"] or np.any((counts < 1) | (counts > 8)):
        raise ValueError("invalid packed family inventory")
    matrix = sparse.csr_matrix((arrays["values.f32"], arrays["indices.i32"], arrays["indptr.i64"]),
                               shape=(n, N_FEATURES), copy=False)
    return {"X": matrix, "teacher": arrays["teacher.f64"], "baseline": arrays["baseline.i32"],
            "phase": arrays["phase.u8"], "weight": 1/counts[family], "family": family,
            "metadata": part}


def train(manifest_path, output):
    manifest_path, output = Path(manifest_path), Path(output)
    manifest, manifest_sha = read_json(manifest_path)
    receipt = code_receipt()
    output.mkdir(parents=False, exist_ok=False)
    write_json(output / "plan.json", {"schema": "chessy.sparse-fit-plan.v1", "grid": GRID,
        "sourceManifestSha256": manifest_sha, "implementation": receipt, "researchOnly": True,
        "validationSelection": "minimum integer CE among converged fits passing frozen guards; baseline selectable"})
    train_data = load_role(manifest_path, "train")
    validation = load_role(manifest_path, "validation")
    baseline_metrics = metrics(validation["baseline"], validation["teacher"], validation["phase"])
    results = []
    choice = {"id": "baseline", "validation": baseline_metrics, "eligible": True}
    for config in GRID:
        print(json.dumps({"fitting": config["id"], "rows": len(train_data["teacher"])}), flush=True)
        fitted = fit(train_data["X"], train_data["baseline"], train_data["teacher"],
                     families=config["families"], l2=config["l2"], l1=config["l1"],
                     sample_weight=train_data["weight"])
        weights = quantize(fitted.weights_cp)
        prediction = predict(validation["X"], validation["baseline"], weights)
        scores = metrics(prediction, validation["teacher"], validation["phase"])
        float_prediction = predict(validation["X"], validation["baseline"], fitted.weights_cp, integer=False)
        entry = {"id": config["id"], "fit": fitted.report, "validation": scores,
                 "quantizationMaeCp": float(np.mean(np.abs(prediction-float_prediction))),
                 "quantizationMaxCp": float(np.max(np.abs(prediction-float_prediction))),
                 "eligible": eligible(scores, baseline_metrics, converged=fitted.report["numericallyConverged"])}
        entry["weights"] = write(output / (config["id"] + ".i16le"), weights.tobytes())
        entry["floatWeights"] = write(output / (config["id"] + ".f64le"), fitted.weights_cp.astype("<f8").tobytes())
        write_json(output / (config["id"] + ".json"), entry)
        results.append(entry)
        print(json.dumps({"fitComplete": entry["id"], "converged": fitted.report["numericallyConverged"],
                          "validationCE": scores["overall"]["ce"], "eligible": entry["eligible"],
                          "nonzero": fitted.report["nonzeroInteger"]}), flush=True)
        if entry["eligible"] and scores["overall"]["ce"] < choice["validation"]["overall"]["ce"]:
            choice = entry
    # This durable frozen choice is published before any holdout score is computed.
    write_json(output / "selection.json", {"schema": "chessy.sparse-selection.v1", "researchOnly": True,
        "sourceManifestSha256": manifest_sha, "implementation": receipt, "selected": choice["id"],
        "validationBaseline": baseline_metrics, "candidates": results})
    del train_data, validation
    if code_receipt() != receipt:
        raise ValueError("implementation changed during fit")
    holdout = load_role(manifest_path, "holdout")
    if choice["id"] == "baseline":
        final_weights = np.zeros(N_FEATURES, dtype="<i2")
    else:
        final_weights = np.frombuffer(authenticated_bytes(output, choice["weights"]), dtype="<i2")
    scores = metrics(predict(holdout["X"], holdout["baseline"], final_weights), holdout["teacher"], holdout["phase"])
    base_scores = metrics(holdout["baseline"], holdout["teacher"], holdout["phase"])
    result = {"schema": "chessy.sparse-study.v1", "status": "complete-research-only", "researchOnly": True,
              "productionFitAllowed": False, "sourceManifestSha256": manifest_sha,
              "implementation": receipt, "selected": choice["id"], "featureCount": N_FEATURES,
              "validationBaseline": baseline_metrics, "candidates": results,
              "holdoutBaseline": base_scores, "holdoutSelected": scores,
              "holdoutTransferGuardsPassed": choice["id"] != "baseline" and eligible(scores, base_scores, converged=True),
              "holdoutOpenedOnceAfterSelection": True, "paidComputeUSD": 0,
              "limitations": ["exploratory mixed-teacher prefix sample with no source-game IDs",
                              "teacher agreement does not establish playing strength",
                              "discrete integer export is not a convex global optimum"]}
    if code_receipt() != receipt:
        raise ValueError("implementation changed before completion")
    write_json(output / "results.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pack")
    p.add_argument("manifest", type=Path); p.add_argument("output", type=Path)
    p.add_argument("--runtime", type=Path, required=True)
    p = sub.add_parser("fit")
    p.add_argument("manifest", type=Path); p.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "pack":
        result = pack(args.manifest, args.output, args.runtime)
    else:
        result = train(args.manifest, args.output)
    print(json.dumps({"complete": result["schema"], "output": str(args.output)}))


if __name__ == "__main__":
    main()
