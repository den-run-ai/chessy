#!/usr/bin/env python3
"""Restore omitted train/validation inputs of the frozen refit evidence bundle.

Requires the original authenticated data/eval-v1 directory, the retained native
extractor, Python, NumPy 2.3.5 and SciPy 1.17.0. No Rust compiler is executed.
The extractor must run on this host (the retained build is native Linux x86-64).
Only missing raw inputs and packed arrays are restored; no fit or holdout is
opened. Existing mismatches are errors. A failed attempt keeps evidence intact,
may leave already-restored valid inputs, and never writes a success receipt.
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

if __name__ == "__main__" and "_EXECUTED_BYTES" not in globals():
    _source = Path(__file__).read_bytes()
    exec(compile(_source, __file__, "exec"), {
        "__name__": "__main__", "__file__": __file__, "_EXECUTED_BYTES": _source,
    })
    raise SystemExit(0)

RESULTS_SHA = "3a703fb06361eacd4dfd120fc85492b5c33de8e1e01b987763be82ae8925bc1e"
DATA_SHA = "16676c7aca9ea410b8c0518594fb78527668d00f6b3f343fe6c5c6f70883723e"
PACKED_SHA = "06da0458290bbede70b5ea1a2ffc7ca57cefa5af9ff6c3ea38d2eefc7ea8a13a"
DRIVER_SHA = "75d7fe25efe772dbadb3a158564ccf42a78d939c497155a34b41b191668c2dfa"
ROLES = ("train", "validation")
ARRAYS = ("indices.i32", "values.f32", "indptr.i64", "teacher.f64", "baseline.i32", "phase.u8", "family.u32", "fens.txt")
STAGED = ("extractor", "REGISTRATION.json", "inputs/data-manifest.json", "inputs/packed-manifest.json",
          "inputs/train.jsonl", "inputs/validation.jsonl")
RECOVERABLE = {*("inputs/" + role + ".jsonl" for role in ROLES), "packed/PACKED.json",
               *("packed/" + role + "." + suffix for role in ROLES for suffix in ARRAYS)}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def safe(path):
    path = Path(path).absolute()
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError("symlinks are not allowed: " + str(path))
    return path.resolve(strict=False)


def target(root, name):
    if (not isinstance(name, str) or not name or Path(name).is_absolute()
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError("unsafe retained relative path")
    return safe(Path(root) / name)


def stream_identity(path, expected=None, destination=None):
    """Hash the same opened source descriptor that is optionally copied."""
    path = safe(path)
    hasher, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        before = os.fstat(source.fileno())
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk); size += len(chunk)
            if destination is not None:
                destination.write(chunk)
        after = os.fstat(source.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("input changed during consumption")
    result = {"bytes": size, "sha256": hasher.hexdigest()}
    if expected is not None and result != {key: expected[key] for key in ("bytes", "sha256")}:
        raise ValueError("retained identity mismatch: " + str(path))
    return result


def read_small(path, expected_sha=None):
    path = safe(path)
    with path.open("rb") as source:
        raw = source.read()
    if expected_sha is not None and digest(raw) != expected_sha:
        raise ValueError("frozen manifest/source identity mismatch: " + str(path))
    return raw


def write_once(path, raw):
    path = safe(path); path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    path.chmod(0o444)
    return {"bytes": len(raw), "sha256": digest(raw)}


def copy_verified(source, destination, expected, executable=False):
    destination = safe(destination); destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as output:
        result = stream_identity(source, expected, output)
        output.flush(); os.fsync(output.fileno())
    destination.chmod(0o555 if executable else 0o444)
    return result


def preflight(study, inventory):
    missing = []
    for name, item in inventory.items():
        path = target(study, name)
        if path.exists():
            stream_identity(path, item)
        elif name in RECOVERABLE:
            missing.append(name)
        else:
            raise ValueError("preserved evidence/source is missing: " + name)
    return missing


def publish_missing(source, destination, expected):
    """Publish a verified file atomically and exclusively on the target volume."""
    destination = safe(destination)
    if destination.exists():
        stream_identity(destination, expected)
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".refit-restore-stage-", dir=destination.parent) as directory:
        staged = Path(directory) / "input"
        copy_verified(source, staged, expected)
        try:
            os.link(staged, destination, follow_symlinks=False)
        except FileExistsError:
            stream_identity(destination, expected)
            return False
    return True


def pack(work):
    """Execute only the pinned captured pack_roles, never study() or fit()."""
    work = safe(work)
    plan = json.loads(read_small(work / "PACK-PLAN.json"))
    if (plan.get("schema") != "chessy.eval-pipeline-refit-restore-plan.v1" or plan.get("resultsSha256") != RESULTS_SHA
            or plan.get("roles") != list(ROLES) or plan.get("fitAllowed") is not False or plan.get("holdoutAllowed") is not False):
        raise ValueError("pack-only restoration plan differs")
    driver = work / "source/tools/eval_pipeline/refit.py"
    raw = read_small(driver, DRIVER_SHA)
    completed_raw = read_small(work / "RESULTS.json", RESULTS_SHA)
    completed = json.loads(completed_raw)
    expected = {name: item for name, item in completed["files"].items() if name.startswith("source/") or name in STAGED}
    own = read_small(Path(__file__))
    if (Path(__file__).resolve() != work / "restore_refit_inputs.py"
            or "_EXECUTED_BYTES" in globals() and own != globals()["_EXECUTED_BYTES"]):
        raise ValueError("packing must execute the retained restoration helper")
    expected.update({"RESULTS.json": {"bytes": len(completed_raw), "sha256": RESULTS_SHA},
                     "source/tools/__init__.py": {"bytes": 0, "sha256": digest(b"")},
                     "restore_refit_inputs.py": {"bytes": len(own), "sha256": digest(own)}})
    if plan["files"] != expected:
        raise ValueError("complete preserved packing source/input inventory required")
    for name, item in plan["files"].items():
        stream_identity(target(work, name), item)
    registration = json.loads(read_small(work / "REGISTRATION.json", completed["registrationSha256"]))
    if (plan["numpy"], plan["scipy"]) != (registration["numpy"], registration["scipy"]):
        raise ValueError("packing package versions differ from original registration")
    import numpy
    import scipy
    if (numpy.__version__, scipy.__version__) != (plan["numpy"], plan["scipy"]):
        raise ValueError("NumPy/SciPy versions differ from the retained registration")
    namespace = {"__name__": "retained_refit_pack_only", "__file__": str(driver)}
    exec(compile(raw, str(driver), "exec"), namespace)
    def forbidden(*args, **kwargs):
        raise RuntimeError("fitting is forbidden during input restoration")
    namespace["fit"] = namespace["study"] = forbidden
    packed = json.loads(read_small(work / "inputs/packed-manifest.json", PACKED_SHA))
    namespace["pack_roles"](work, packed)
    for name, item in plan["files"].items():
        stream_identity(target(work, name), item)


def restore(study, data_directory, work_directory):
    study, data_directory, work = map(safe, (study, data_directory, work_directory))
    if work.exists() or study in work.parents or data_directory in work.parents:
        raise ValueError("a new reconstruction directory outside both input trees is required")
    result_raw = read_small(study / "RESULTS.json", RESULTS_SHA)
    result = json.loads(result_raw); inventory = result["files"]
    if (result.get("schema") != "chessy.eval-pipeline-refit-results.v1" or len(inventory) != 49
            or result.get("status") != "complete-research-only" or result.get("noHoldoutOrOodFilesRead") is not True):
        raise ValueError("the complete frozen 49-file refit inventory is required")
    missing = preflight(study, inventory)
    registration = json.loads(read_small(study / "REGISTRATION.json", result["registrationSha256"]))
    data_raw = read_small(data_directory / "manifest.json", DATA_SHA)
    if data_raw != read_small(study / "inputs/data-manifest.json", DATA_SHA):
        raise ValueError("external data manifest differs from preserved manifest")
    data = json.loads(data_raw)
    packed = json.loads(read_small(study / "inputs/packed-manifest.json", PACKED_SHA))
    for role in ROLES:
        source = next(item for item in data["files"] if item["role"] == role)
        part = next(item for item in packed["roles"] if item["role"] == role)
        if source["path"] != role + ".jsonl" or set(part["files"]) != set(ARRAYS):
            raise ValueError("original train/validation inventory differs")
        for name, item in [("inputs/" + role + ".jsonl", source),
                           *(("packed/" + value["path"], value) for value in part["files"].values())]:
            if inventory[name] != {key: item[key] for key in ("bytes", "sha256")}:
                raise ValueError("original input binding differs from completed refit")
    if target(study, "RESTORED-INPUTS.json").exists():
        raise FileExistsError("restoration already has a receipt; no replacement is implicit")
    lock_path = target(study, ".restore-inputs.lock")
    with lock_path.open("xb") as lock:
        lock.write(encoded({"workDirectory": str(work), "resultsSha256": RESULTS_SHA}))
        lock.flush(); os.fsync(lock.fileno())
        owned_lock = os.fstat(lock.fileno())
    try:
        work.mkdir(parents=True, exist_ok=False)
        staged = {}
        for name, item in inventory.items():
            if name.startswith("source/") or name in STAGED and not name.endswith(".jsonl"):
                staged[name] = copy_verified(target(study, name), target(work, name), item, name == "extractor")
        # Anchor the captured tools package rather than merging it with an
        # ambient namespace package. No captured source file is modified.
        staged["source/tools/__init__.py"] = write_once(work / "source/tools/__init__.py", b"")
        for role in ROLES:
            name = "inputs/" + role + ".jsonl"
            source = target(study, name) if name not in missing else target(data_directory, role + ".jsonl")
            staged[name] = copy_verified(source, target(work, name), inventory[name])
        own = read_small(Path(__file__))
        if "_EXECUTED_BYTES" in globals() and own != globals()["_EXECUTED_BYTES"]:
            raise ValueError("executed restoration source changed before capture")
        staged["restore_refit_inputs.py"] = write_once(work / "restore_refit_inputs.py", own)
        staged["RESULTS.json"] = write_once(work / "RESULTS.json", result_raw)
        write_once(work / "PACK-PLAN.json", encoded({"schema": "chessy.eval-pipeline-refit-restore-plan.v1",
            "resultsSha256": RESULTS_SHA, "files": staged, "numpy": registration["numpy"], "scipy": registration["scipy"],
            "roles": list(ROLES), "fitAllowed": False, "holdoutAllowed": False}))
        environment = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "PYTHONHASHSEED": "0"}
        with (work / "packing.stdout").open("xb") as stdout, (work / "packing.stderr").open("xb") as stderr:
            subprocess.run([sys.executable, "-I", "-B", str(work / "restore_refit_inputs.py"), "_pack", str(work)],
                           env=environment, stdout=stdout, stderr=stderr, check=True)
        # Authenticate every reconstructed packed file and receipt before any
        # missing input is published into the preserved thin evidence tree.
        for name in sorted(RECOVERABLE):
            stream_identity(target(work, name), inventory[name])
        restored = [name for name in sorted(missing)
                    if publish_missing(target(work, name), target(study, name), inventory[name])]
        if preflight(study, inventory):
            raise ValueError("refit inventory remains incomplete")
        read_small(study / "RESULTS.json", RESULTS_SHA)
        if read_small(Path(__file__)) != own:
            raise ValueError("restoration implementation changed before publication")
        receipt = {"schema": "chessy.eval-pipeline-refit-restored-inputs.v1", "status": "complete",
            "resultsSha256": RESULTS_SHA, "dataManifestSha256": DATA_SHA, "packedManifestSha256": PACKED_SHA,
            "capturedPackingSourceSha256": DRIVER_SHA, "restorerSha256": digest(own), "restoredFiles": restored,
            "verifiedInventoryFiles": len(inventory), "all16PackedArraysExact": True, "packedReceiptExact": True,
            "refitExecuted": False, "holdoutOpened": False, "workDirectory": str(work)}
        write_once(study / "RESTORED-INPUTS.json", encoded(receipt))
        return receipt
    finally:
        try:
            observed = lock_path.stat(follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            if (observed.st_dev, observed.st_ino) == (owned_lock.st_dev, owned_lock.st_ino):
                lock_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    if len(sys.argv) > 1 and sys.argv[1] == "_pack":
        parser.add_argument("command", choices=("_pack",)); parser.add_argument("work", type=Path)
        args = parser.parse_args(); pack(args.work); return
    for name in ("study", "data-directory", "work-directory"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(restore(args.study, args.data_directory, args.work_directory), sort_keys=True))


if __name__ == "__main__":
    main()
