#!/usr/bin/env python3
"""Preregister and run two cost-aware refits on the original train/validation.

The original corpus, fits, and exposed holdout remain unchanged. Registration
captures exact input bytes, historical feature/extractor sources, the original
convex optimizer, and this driver before fitting. Run executes that retained
driver. Every reconstructed packed array must match the original packed
manifest. Quality eligibility is not playing-strength or production admission.
"""
from __future__ import annotations

import argparse
from array import array
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

if __name__ == "__main__" and "_EXECUTED_BYTES" not in globals():
    _source = Path(__file__).read_bytes()
    exec(compile(_source, __file__, "exec"), {
        "__name__": "__main__", "__file__": __file__, "_EXECUTED_BYTES": _source,
    })
    raise SystemExit(0)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import numpy as np
import scipy
from scipy import sparse
from scipy.special import expit
from tools.sparse_eval.features import BASE_FEATURES, N_FEATURES, FAMILIES
from tools.sparse_eval.fit import fit, quantize, metrics

DATA_SHA = "16676c7aca9ea410b8c0518594fb78527668d00f6b3f343fe6c5c6f70883723e"
PACKED_SHA = "06da0458290bbede70b5ea1a2ffc7ca57cefa5af9ff6c3ea38d2eefc7ea8a13a"
FULL_SHA = "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304"
FIT_SHA = "c5f414b55d194b647ffdaf81f07a7a1a467a7477e5a8f0c857ba08c53c155a39"
FEATURE_SHA = "f4209aff52405bc0ffbb1b41bfdbb00e9c7a4a47e42e9efe4c0820cbf8bda709"
EXTRACTOR_SOURCE_SHA = "88e1fb3d79a8048e0792a0968733166ea3dcad5ef97a6d96577ff5273ffd2663"
ROLES = ("train", "validation")
ROW_COUNTS = {"train": 799145, "validation": 100164}
ARRAY_TYPES = {"indices.i32": "<i4", "values.f32": "<f4", "indptr.i64": "<i8",
               "teacher.f64": "<f8", "baseline.i32": "<i4", "phase.u8": "u1", "family.u32": "<u4"}
FILES = (*ARRAY_TYPES, "fens.txt")
RECIPES = (
    {"id": "refit-no-pawn", "removedFamily": "pawn_context",
     "families": ["pst", "own_king", "enemy_king", "ray"]},
    {"id": "refit-no-ray", "removedFamily": "ray",
     "families": ["pst", "own_king", "enemy_king", "pawn_context"]},
)
GUARDS = {"retainedFullCeGain": 0.75, "minimumCeImprovementOverHce": 0.005,
          "maximumMaeRatioToFull": 1.03, "maximumRmseRatioToFull": 1.03,
          "everyPhaseCeAtMostHce": True, "requireNumericalConvergence": True,
          "applyAlsoToFamilyBalancedMetrics": True}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def identity(raw):
    return {"bytes": len(raw), "sha256": sha(raw)}


def protocol():
    return {"schema": "chessy.eval-pipeline-refit-protocol.v1", "researchOnly": True,
        "dataManifestSha256": DATA_SHA, "packedManifestSha256": PACKED_SHA,
        "originalFullModelSha256": FULL_SHA, "rolesOpened": list(ROLES),
        "recipes": list(RECIPES), "fit": {"l1": 1e-5, "l2": 1e-4, "minSupport": 32,
            "maxIterations": 400, "optimizerSourceSha256": FIT_SHA,
            "sampleWeight": "inverse train structural-family count; normalized by original optimizer",
            "initialization": "all zero; no outcome or validation warm start",
            "boundsAndFamilyCosts": "unchanged original bounded L1/L2 convex fit"},
        "qualityRules": GUARDS, "batchRows": 4096,
        "validation": "exact integer numerator/24 residual, separately rounded from original HCE",
        "familyBalance": "each represented structural family has equal total weight within each phase stratum",
        "decision": "retain both recipes and all failures; quality eligibility only; no speed gate or winner",
        "strengthCriterion": "a later fresh equal-time crossover campaign; no fixed-node strength admission",
        "priorDifference": "v2 zeroed existing weights; these refit retained columns. Prior king removed both pawn and ray; neither recipe does that.",
        "productionAdmission": False, "noHoldoutOrOodFilesRead": True, "paidComputeUSD": 0}


def read_exact(path, expected=None):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("symlink input is not allowed: " + str(path))
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read()
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("input changed while read")
    if expected is not None and identity(raw) != {"bytes": expected["bytes"], "sha256": expected["sha256"]}:
        raise ValueError("input identity mismatch: " + str(path))
    return raw


def safe_file(name):
    if not isinstance(name, str) or Path(name).name != name or name in (".", ".."):
        raise ValueError("a single relative file name is required")
    return name


def write(path, raw, executable=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o555 if executable else 0o444)
    return {"path": path.name, **identity(raw)}


def validate_manifests(data_raw, packed_raw):
    if sha(data_raw) != DATA_SHA or sha(packed_raw) != PACKED_SHA:
        raise ValueError("requires the exact original data and packed manifests")
    data, packed = json.loads(data_raw), json.loads(packed_raw)
    if (data.get("schema") != "chessy.sparse-eval-data.v1"
            or packed.get("schema") != "chessy.sparse-packed.v1"
            or packed.get("sourceManifestSha256") != DATA_SHA
            or not packed.get("noCrossRoleFamilyOrClusterOverlap")
            or packed.get("featureCount") != N_FEATURES):
        raise ValueError("original provenance is incomplete")
    for item in (data, packed):
        if item.get("status") != "complete-research-only" or item.get("researchOnly") is not True or item.get("productionFitAllowed") is not False:
            raise ValueError("research provenance must remain explicit")
    for role in ROLES:
        source = next(row for row in data["files"] if row["role"] == role)
        part = next(row for row in packed["roles"] if row["role"] == role)
        if source["rows"] != ROW_COUNTS[role] or part["rows"] != ROW_COUNTS[role] or set(part["files"]) != set(FILES):
            raise ValueError("complete original role inventory required")
        if safe_file(source["path"]) != role + ".jsonl":
            raise ValueError("wrong source role file")
        for key in FILES:
            if safe_file(part["files"][key]["path"]) != role + "." + key:
                raise ValueError("wrong packed role file")
    return data, packed


def snapshot_sources(root):
    retained = {"tools/eval_pipeline/refit.py": read_exact(root / "tools/eval_pipeline/refit.py"),
                "tools/eval_pipeline/prepare.py": read_exact(root / "tools/eval_pipeline/prepare.py"),
                "tools/sparse_eval/fit.py": read_exact(root / "tools/sparse_eval/fit.py"),
                "tools/sparse_eval/__init__.py": read_exact(root / "tools/sparse_eval/__init__.py")}
    if root == ROOT and "_EXECUTED_BYTES" in globals():
        if retained["tools/eval_pipeline/refit.py"] != globals()["_EXECUTED_BYTES"]:
            raise ValueError("executed refit source changed before capture")
        retained["tools/eval_pipeline/refit.py"] = globals()["_EXECUTED_BYTES"]
    if sha(retained["tools/sparse_eval/fit.py"]) != FIT_SHA:
        raise ValueError("original convex optimizer changed")
    for name, digest in (("features.py", FEATURE_SHA), ("runtime.rs", EXTRACTOR_SOURCE_SHA)):
        raw = read_exact(root / "eval/sparse-pesto-v1/source-snapshots" / (digest + ".txt"))
        if sha(raw) != digest:
            raise ValueError("historical source snapshot mismatch")
        retained["tools/sparse_eval/" + name] = raw
    manifest = json.loads(read_exact(root / "tools/sparse_eval/baseline/manifest.json"))
    for item in manifest["files"]:
        raw = read_exact(root / "tools/sparse_eval/baseline" / safe_file(item["path"]), item)
        retained["experiments/wasm/src/" + item["path"]] = raw
    for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        retained[name] = read_exact(root / name)
    return retained


def register(data_manifest, packed_manifest, output, rustc, *, root=ROOT):
    data_manifest, packed_manifest, output, rustc = map(Path, (data_manifest, packed_manifest, output, rustc))
    root = Path(root).resolve()
    if output.exists() or output.is_symlink() or root == output.absolute() or root in output.absolute().parents:
        raise ValueError("new output directory must be outside the repository")
    data_raw, packed_raw = read_exact(data_manifest), read_exact(packed_manifest)
    data, packed = validate_manifests(data_raw, packed_raw)
    sources = snapshot_sources(root)
    full = read_exact(root / "eval/sparse-pesto-v1/fit/full.i16le")
    if sha(full) != FULL_SHA or len(full) != N_FEATURES * 2:
        raise ValueError("original full model identity mismatch")
    output.mkdir(parents=True, exist_ok=False)
    inventory = {}

    def retain(name, raw, executable=False):
        item = write(output / name, raw, executable)
        inventory[name] = {k: v for k, v in item.items() if k != "path"}

    retain("PROTOCOL.json", encoded(protocol()))
    retain("inputs/data-manifest.json", data_raw)
    retain("inputs/packed-manifest.json", packed_raw)
    retain("inputs/original-full.i16le", full)
    for name, raw in sources.items():
        retain("source/" + name, raw)
    # Authenticate and consume the same retained bytes; no pathname is hashed
    # and then reopened for actual training. No holdout path is constructed.
    for role in ROLES:
        item = next(row for row in data["files"] if row["role"] == role)
        retain("inputs/" + role + ".jsonl", read_exact(data_manifest.parent / item["path"], item))
    compiler_raw = read_exact(rustc)
    retain("tools/rustc", compiler_raw, True)
    sysroot = subprocess.check_output([str(rustc), "--print", "sysroot"], text=True).strip()
    environment = dict(os.environ)
    environment["LD_LIBRARY_PATH"] = str(Path(sysroot) / "lib") + os.pathsep + environment.get("LD_LIBRARY_PATH", "")
    private_compiler = output.absolute() / "tools/rustc"
    version = subprocess.check_output([str(private_compiler), "--version", "--verbose"], env=environment, text=True)
    if "release: 1.97.1\n" not in version or "commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\n" not in version:
        raise ValueError("pinned Rust 1.97.1 compiler required")
    compiler_libraries = {str(path): identity(read_exact(path)) for path in sorted((Path(sysroot) / "lib").glob("*.so*"))}
    command = [str(private_compiler), "--sysroot", sysroot, "--edition=2021", "-O",
               str(output.absolute() / "source/tools/sparse_eval/runtime.rs"),
               "-o", str(output.absolute() / "extractor")]
    built = subprocess.run(command, env=environment, capture_output=True, check=True)
    (output / "extractor").chmod(0o555)
    inventory["extractor"] = identity(read_exact(output / "extractor"))
    retain("EXTRACTOR-BUILD.json", encoded({"command": command, "compilerVersion": version,
           "compilerSha256": sha(compiler_raw), "sysroot": sysroot, "compilerLibraries": compiler_libraries,
           "stdout": built.stdout.decode(), "stderr": built.stderr.decode(), "sourceSha256": EXTRACTOR_SOURCE_SHA}))
    for path, item in compiler_libraries.items():
        read_exact(path, item)
    if read_exact(rustc) != compiler_raw:
        raise ValueError("compiler changed during registration")
    registration = {"schema": "chessy.eval-pipeline-refit-registration.v1", "researchOnly": True,
        "protocol": protocol(), "files": inventory, "trainingStarted": False,
        "python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__,
        "noHoldoutOrOodFilesRead": True, "productionAdmission": False}
    write(output / "REGISTRATION.json", encoded(registration))
    return registration


def verify_registration(output):
    output = Path(output)
    raw = read_exact(output / "REGISTRATION.json")
    registration = json.loads(raw)
    if registration.get("schema") != "chessy.eval-pipeline-refit-registration.v1" or registration.get("protocol") != protocol():
        raise ValueError("registration protocol changed")
    for name, item in registration["files"].items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("invalid registration path")
        read_exact(output / name, item)
    if (np.__version__, scipy.__version__) != (registration["numpy"], registration["scipy"]):
        raise ValueError("numerical package versions changed since registration")
    return registration, raw


class StreamWriter:
    def __init__(self, path):
        self.path, self.hash, self.size = Path(path), hashlib.sha256(), 0
        self.stream = self.path.open("xb")

    def add(self, raw):
        self.stream.write(raw)
        self.hash.update(raw)
        self.size += len(raw)

    def finish(self):
        self.stream.flush(); os.fsync(self.stream.fileno()); self.stream.close()
        self.path.chmod(0o444)
        return {"path": self.path.name, "bytes": self.size, "sha256": self.hash.hexdigest()}


def pack_roles(output, packed):
    destination = output / "packed"
    destination.mkdir(exist_ok=False)
    all_families, all_clusters, results = set(), set(), []
    for role in ROLES:
        expected = next(row for row in packed["roles"] if row["role"] == role)
        writers = {key: StreamWriter(destination / (role + "." + key)) for key in FILES}
        writers["indptr.i64"].add(np.array([0], dtype="<i8").tobytes())
        families, clusters, counts, rows, nnz = {}, set(), Counter(), 0, 0

        def consume(batch):
            nonlocal rows, nnz
            fens = "\n".join(row["fen"] for row in batch) + "\n"
            extracted = subprocess.run([str(output / "extractor"), "features"], input=fens,
                                       text=True, capture_output=True, check=True).stdout.splitlines()
            if len(extracted) != len(batch):
                raise ValueError("extractor row count mismatch")
            indices, values, pointers = array("i"), array("f"), array("q")
            teacher, baseline, phases, family_ids = [], [], [], []
            for row, line in zip(batch, extracted):
                fields = line.split()
                base, phase = map(int, fields[:2])
                if row["role"] != role or row["phase"] != phase or not 0 <= phase <= 24 or not np.isfinite(row["cpWhite"]) or abs(row["cpWhite"]) > 2000:
                    raise ValueError("source role/phase/teacher contract failed")
                family, cluster = row["family"], row["cluster"]
                if family in all_families or cluster in all_clusters or cluster in clusters:
                    raise ValueError("cross-role family or duplicate cluster")
                family_id = families.setdefault(family, len(families))
                counts[family_id] += 1; clusters.add(cluster)
                terms = [tuple(map(int, term.split(":"))) for term in fields[2:]]
                if any(not 0 <= index < BASE_FEATURES or count == 0 for index, count in terms) or [i for i, _ in terms] != sorted({i for i, _ in terms}):
                    raise ValueError("invalid canonical feature row")
                for offset, factor in ((0, phase / 24), (BASE_FEATURES, (24 - phase) / 24)):
                    if factor:
                        indices.extend(index + offset for index, _ in terms)
                        values.extend(count * factor for _, count in terms)
                        nnz += len(terms)
                pointers.append(nnz)
                teacher.append(row["cpWhite"]); baseline.append(base)
                phases.append(phase); family_ids.append(family_id)
            if sys.byteorder != "little":
                indices.byteswap(); values.byteswap(); pointers.byteswap()
            arrays = {"indices.i32": indices.tobytes(), "values.f32": values.tobytes(), "indptr.i64": pointers.tobytes(),
                "teacher.f64": np.asarray(teacher, dtype="<f8").tobytes(), "baseline.i32": np.asarray(baseline, dtype="<i4").tobytes(),
                "phase.u8": np.asarray(phases, dtype="u1").tobytes(), "family.u32": np.asarray(family_ids, dtype="<u4").tobytes(),
                "fens.txt": fens.encode()}
            for key, raw in arrays.items():
                writers[key].add(raw)
            rows += len(batch)

        source_hash, source_bytes = hashlib.sha256(), 0
        with (output / "inputs" / (role + ".jsonl")).open("rb") as stream:
            batch = []
            for line in stream:
                source_hash.update(line); source_bytes += len(line)
                batch.append(json.loads(line))
                if len(batch) == 4096:
                    consume(batch); batch = []
            if batch:
                consume(batch)
        source_item = json.loads(read_exact(output / "inputs/data-manifest.json"))["files"]
        source_item = next(item for item in source_item if item["role"] == role)
        if source_bytes != source_item["bytes"] or source_hash.hexdigest() != source_item["sha256"]:
            raise ValueError("consumed source bytes changed")
        files = {key: writer.finish() for key, writer in writers.items()}
        actual = {"role": role, "rows": rows, "nnz": nnz, "families": len(families), "files": files}
        if actual != expected or not counts or max(counts.values()) > 8:
            raise ValueError("reconstructed role differs from original packed bytes: " + role)
        all_families.update(families); all_clusters.update(clusters); results.append(actual)
        print(json.dumps({"packed": role, "rows": rows, "nnz": nnz, "exactOriginalHashes": True}), flush=True)
    receipt = {"schema": "chessy.eval-pipeline-refit-packed.v1", "originalPackedManifestSha256": PACKED_SHA,
               "roles": results, "noHoldoutOrOodFilesRead": True, "noCrossRoleFamilyOrClusterOverlap": True}
    write(destination / "PACKED.json", encoded(receipt))
    return receipt


def load_role(output, part):
    if part["role"] not in ROLES:
        raise ValueError("refits may only open train or validation")
    arrays = {key: np.frombuffer(read_exact(output / "packed" / safe_file(part["files"][key]["path"]), part["files"][key]), dtype=dtype)
              for key, dtype in ARRAY_TYPES.items()}
    n, nnz = part["rows"], part["nnz"]
    if (len(arrays["indices.i32"]) != nnz or len(arrays["values.f32"]) != nnz or len(arrays["indptr.i64"]) != n + 1
            or arrays["indptr.i64"][0] != 0 or arrays["indptr.i64"][-1] != nnz
            or np.any(np.diff(arrays["indptr.i64"]) < 0) or np.any(arrays["indices.i32"] < 0)
            or np.any(arrays["indices.i32"] >= N_FEATURES) or not np.all(np.isfinite(arrays["values.f32"]))
            or any(len(arrays[k]) != n for k in ("teacher.f64", "baseline.i32", "phase.u8", "family.u32"))):
        raise ValueError("invalid packed dimensions")
    counts = np.bincount(arrays["family.u32"], minlength=part["families"])
    if len(counts) != part["families"] or np.any(counts < 1) or np.any(counts > 8):
        raise ValueError("invalid family count")
    matrix = sparse.csr_matrix((arrays["values.f32"], arrays["indices.i32"], arrays["indptr.i64"]), shape=(n, N_FEATURES), copy=False)
    return {"X": matrix, "teacher": arrays["teacher.f64"], "baseline": arrays["baseline.i32"],
            "phase": arrays["phase.u8"], "family": arrays["family.u32"], "weight": 1 / counts[arrays["family.u32"]]}


def integer_matrix(matrix):
    raw = matrix.data.astype(np.float64) * 24
    numerator = np.rint(raw)
    if np.any(np.abs(raw - numerator) > 0.001) or np.any(np.abs(numerator) > np.iinfo(np.int32).max):
        raise ValueError("feature matrix is not an exact denominator-24 representation")
    return sparse.csr_matrix((numerator.astype(np.int32), matrix.indices, matrix.indptr), shape=matrix.shape, copy=False)


def exact_predict(numerators, baseline, weights):
    weights = np.asarray(weights)
    if weights.shape != (N_FEATURES,) or weights.dtype.kind not in "iu":
        raise ValueError("exact prediction requires full integer coefficient vector")
    numerator = np.asarray(numerators @ weights.astype(np.int64)).ravel()
    result = np.asarray(baseline, dtype=np.int64) + np.sign(numerator) * ((np.abs(numerator) + 12) // 24)
    if np.any(result < np.iinfo(np.int32).min) or np.any(result > np.iinfo(np.int32).max):
        raise ValueError("score export overflow")
    return result.astype("<i4")


def balanced_metrics(prediction, teacher, phase, family):
    prediction, teacher, phase, family = map(np.asarray, (prediction, teacher, phase, family))
    if not (prediction.shape == teacher.shape == phase.shape == family.shape) or prediction.ndim != 1:
        raise ValueError("metric shapes differ")
    logits, error = prediction / 400, prediction - teacher
    loss = np.logaddexp(0, logits) - expit(teacher / 400) * logits
    result = {}
    for name, mask in (("overall", np.ones(len(phase), bool)), ("opening", phase >= 18),
                       ("middlegame", (phase >= 7) & (phase < 18)), ("endgame", phase < 7)):
        if not np.any(mask):
            result[name] = {"rows": 0, "families": 0}; continue
        _, inverse, counts = np.unique(family[mask], return_inverse=True, return_counts=True)
        weights = 1 / counts[inverse]; weights /= weights.sum()
        result[name] = {"rows": int(mask.sum()), "families": len(counts), "ce": float(weights @ loss[mask]),
            "maeCp": float(weights @ np.abs(error[mask])), "rmseCp": float(np.sqrt(weights @ error[mask] ** 2))}
    return result


def quality_guard(candidate, full, baseline, *, converged, removed_zero):
    checks = {"numericallyConverged": bool(converged), "removedFamilyExactlyZero": bool(removed_zero)}
    gain = baseline["overall"]["ce"] - full["overall"]["ce"]
    checks["retainedFullCeGain"] = gain > 0 and baseline["overall"]["ce"] - candidate["overall"]["ce"] >= GUARDS["retainedFullCeGain"] * gain
    checks["minimumCeGainOverHce"] = candidate["overall"]["ce"] <= baseline["overall"]["ce"] * (1 - GUARDS["minimumCeImprovementOverHce"])
    for metric, rule in (("maeCp", "maximumMaeRatioToFull"), ("rmseCp", "maximumRmseRatioToFull")):
        checks[metric] = candidate["overall"][metric] <= full["overall"][metric] * GUARDS[rule]
    for phase in ("opening", "middlegame", "endgame"):
        checks[phase + "Ce"] = candidate[phase]["rows"] > 0 and candidate[phase]["ce"] <= baseline[phase]["ce"]
    return {"passed": all(checks.values()), "checks": checks,
            "retainedFullCeGain": (baseline["overall"]["ce"] - candidate["overall"]["ce"]) / gain if gain > 0 else None}


def study(output):
    output = Path(output).resolve()
    if Path(__file__).resolve() != output / "source/tools/eval_pipeline/refit.py":
        raise ValueError("run must execute the retained registered source snapshot")
    registration, registration_raw = verify_registration(output)
    if read_exact(output / "source/tools/eval_pipeline/refit.py") != read_exact(Path(__file__)):
        raise ValueError("driver identity mismatch")
    write(output / "RUN-STARTED.json", encoded({"registrationSha256": sha(registration_raw), "protocol": protocol()}))
    _, packed = validate_manifests(read_exact(output / "inputs/data-manifest.json"), read_exact(output / "inputs/packed-manifest.json"))
    rebuilt = pack_roles(output, packed)
    train = load_role(output, rebuilt["roles"][0])
    validation = load_role(output, rebuilt["roles"][1])
    exact = integer_matrix(validation["X"])
    full = np.frombuffer(read_exact(output / "inputs/original-full.i16le"), dtype="<i2")
    reference = {}
    for name, prediction in (("hce", validation["baseline"]), ("full", exact_predict(exact, validation["baseline"], full))):
        reference[name] = {"validation": metrics(prediction, validation["teacher"], validation["phase"]),
            "familyBalanced": balanced_metrics(prediction, validation["teacher"], validation["phase"], validation["family"]),
            "scores": write(output / (name + ".validation.i32"), np.asarray(prediction, dtype="<i4").tobytes())}
    from tools.eval_pipeline.prepare import tables
    candidates = []
    for recipe in RECIPES:
        print(json.dumps({"fitting": recipe["id"], "rows": len(train["teacher"]), "noHoldout": True}), flush=True)
        fitted = fit(train["X"], train["baseline"], train["teacher"], families=recipe["families"],
                     l2=1e-4, l1=1e-5, sample_weight=train["weight"], min_support=32, max_iterations=400)
        weights = quantize(fitted.weights_cp)
        prediction = exact_predict(exact, validation["baseline"], weights)
        row_metrics = metrics(prediction, validation["teacher"], validation["phase"])
        family_metrics = balanced_metrics(prediction, validation["teacher"], validation["phase"], validation["family"])
        start, stop = FAMILIES[recipe["removedFamily"]]
        removed_zero = not np.any(weights[start:stop]) and not np.any(weights[start + BASE_FEATURES:stop + BASE_FEATURES])
        row_guard = quality_guard(row_metrics, reference["full"]["validation"], reference["hce"]["validation"],
                                  converged=fitted.report["numericallyConverged"], removed_zero=removed_zero)
        family_guard = quality_guard(family_metrics, reference["full"]["familyBalanced"], reference["hce"]["familyBalanced"],
                                     converged=fitted.report["numericallyConverged"], removed_zero=removed_zero)
        try:
            tables(weights.tobytes())
            runtime = {"losslessI8TablesSupported": True, "reason": None}
        except ValueError as error:
            runtime = {"losslessI8TablesSupported": False, "reason": str(error)}
        entry = {"schema": "chessy.eval-pipeline-refit-model.v1", "id": recipe["id"], "recipe": recipe,
            "researchOnly": True, "productionAdmission": False, "noHoldoutOrOodFilesRead": True,
            "registrationSha256": sha(registration_raw), "dataManifestSha256": DATA_SHA, "packedManifestSha256": PACKED_SHA,
            "originalFullModelSha256": FULL_SHA, "fit": fitted.report, "validation": row_metrics,
            "familyBalanced": family_metrics, "qualityGuards": {"rows": row_guard, "families": family_guard},
            "qualityEligible": row_guard["passed"] and family_guard["passed"], "runtime": runtime,
            "weights": write(output / (recipe["id"] + ".i16le"), weights.tobytes()),
            "floatWeights": write(output / (recipe["id"] + ".f64le"), fitted.weights_cp.astype("<f8").tobytes()),
            "validationScores": write(output / (recipe["id"] + ".validation.i32"), prediction.tobytes()),
            "selection": "no winner selected; no latency or playing-strength admission"}
        write(output / (recipe["id"] + ".json"), encoded(entry))
        candidates.append(entry)
        print(json.dumps({"fitComplete": recipe["id"], "qualityEligible": entry["qualityEligible"],
                          "narrowExportEligible": runtime["losslessI8TablesSupported"], "validationCE": row_metrics["overall"]["ce"]}), flush=True)
    # All retained identities are rechecked before publishing completion. The
    # exposed validation results remain development evidence, never a new test.
    verify_registration(output)
    inventory = {name: item for name, item in registration["files"].items()}
    for role in rebuilt["roles"]:
        inventory.update({"packed/" + item["path"]: {k: v for k, v in item.items() if k != "path"} for item in role["files"].values()})
    for path in sorted(output.glob("*")):
        if path.is_file():
            inventory[path.name] = identity(read_exact(path))
    inventory["packed/PACKED.json"] = identity(read_exact(output / "packed/PACKED.json"))
    result = {"schema": "chessy.eval-pipeline-refit-results.v1", "status": "complete-research-only",
        "researchOnly": True, "productionAdmission": False, "protocol": protocol(),
        "registrationSha256": sha(registration_raw), "references": reference, "candidates": candidates,
        "files": inventory, "noHoldoutOrOodFilesRead": True, "strengthEvidence": False, "paidComputeUSD": 0,
        "limitations": ["original corpus has no source-game IDs", "validation is previously exposed development data",
                        "teacher-score guards do not establish equal-time playing strength", "integer export is outside the convex optimization"]}
    write(output / "RESULTS.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("register")
    p.add_argument("data_manifest", type=Path); p.add_argument("packed_manifest", type=Path)
    p.add_argument("output", type=Path); p.add_argument("--rustc", type=Path, required=True)
    p = sub.add_parser("run"); p.add_argument("output", type=Path)
    p = sub.add_parser("_run"); p.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "register":
        register(args.data_manifest, args.packed_manifest, args.output, args.rustc)
        print(json.dumps({"registered": str(args.output / "REGISTRATION.json"), "trainingStarted": False}))
    elif args.command == "run":
        verify_registration(args.output)
        environment = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "PYTHONHASHSEED": "0"}
        subprocess.run([sys.executable, str(args.output.resolve() / "source/tools/eval_pipeline/refit.py"),
                        "_run", str(args.output.resolve())], env=environment, check=True)
    else:
        study(args.output)


if __name__ == "__main__":
    main()
