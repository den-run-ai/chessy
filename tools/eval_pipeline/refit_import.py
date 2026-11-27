"""Authenticate a complete optional refit before an isolated candidate build.

This module uses only the standard library and never executes imported refit
code. Bulk arrays are stream-verified and remain bound by the retained complete
manifest; source, reports, model bytes, and validation scores are retained.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import struct

DATA_SHA = "16676c7aca9ea410b8c0518594fb78527668d00f6b3f343fe6c5c6f70883723e"
PACKED_SHA = "06da0458290bbede70b5ea1a2ffc7ca57cefa5af9ff6c3ea38d2eefc7ea8a13a"
FULL_SHA = "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304"
SOURCE_HASHES = {
    "source/tools/sparse_eval/fit.py": "c5f414b55d194b647ffdaf81f07a7a1a467a7477e5a8f0c857ba08c53c155a39",
    "source/tools/sparse_eval/features.py": "f4209aff52405bc0ffbb1b41bfdbb00e9c7a4a47e42e9efe4c0820cbf8bda709",
    "source/tools/sparse_eval/runtime.rs": "88e1fb3d79a8048e0792a0968733166ea3dcad5ef97a6d96577ff5273ffd2663",
    "source/experiments/wasm/src/engine.rs": "7bd7126c39fad50fe4fa7527fe857996391e46378491a21171b3928cf3d60103",
    "source/experiments/wasm/src/eval.rs": "3a107218a6d7a42f771022956fab04b28935a39867b74eaea911d27b2598a6b7",
    "source/experiments/wasm/src/search.rs": "e13b53fdb744f8fb647ae9c74ebc5ea2289c6881ba676122336b3f93ec8671cd",
}
ROLES = {"train": 799145, "validation": 100164}
PACKED_FILES = ("indices.i32", "values.f32", "indptr.i64", "teacher.f64", "baseline.i32", "phase.u8", "family.u32", "fens.txt")
RECIPES = {
    "refit-no-pawn": {"id": "refit-no-pawn", "removedFamily": "pawn_context",
                      "families": ["pst", "own_king", "enemy_king", "ray"]},
    "refit-no-ray": {"id": "refit-no-ray", "removedFamily": "ray",
                     "families": ["pst", "own_king", "enemy_king", "pawn_context"]},
}
SPECIALIZATIONS = {
    "refit-no-pawn": {"cfg": "eval_pipeline_no_pawn", "removedRange": (6528, 8064), "coefficientBytes": 13640},
    "refit-no-ray": {"cfg": "eval_pipeline_no_ray", "removedRange": (8064, 8640), "coefficientBytes": 15360},
}
QUALITY = {"retainedFullCeGain": 0.75, "minimumCeImprovementOverHce": 0.005,
           "maximumMaeRatioToFull": 1.03, "maximumRmseRatioToFull": 1.03,
           "everyPhaseCeAtMostHce": True, "requireNumericalConvergence": True,
           "applyAlsoToFamilyBalancedMetrics": True}
REQUIRED_REGISTERED = {
    "PROTOCOL.json", "inputs/data-manifest.json", "inputs/packed-manifest.json",
    "inputs/original-full.i16le", "inputs/train.jsonl", "inputs/validation.jsonl",
    "source/tools/eval_pipeline/refit.py", "source/tools/eval_pipeline/prepare.py",
    "source/tools/sparse_eval/__init__.py", *SOURCE_HASHES,
    "source/LICENSE", "source/THIRD_PARTY_NOTICES.md", "tools/rustc", "extractor", "EXTRACTOR-BUILD.json",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def relative(name):
    require(isinstance(name, str) and name and not Path(name).is_absolute()
            and all(part not in ("", ".", "..") for part in name.split("/")), "unsafe refit path")
    return name


def file_identity(item):
    require(isinstance(item, dict) and type(item.get("bytes")) is int and item["bytes"] >= 0
            and isinstance(item.get("sha256"), str) and len(item["sha256"]) == 64
            and all(c in "0123456789abcdef" for c in item["sha256"]), "invalid refit file identity")
    return {"bytes": item["bytes"], "sha256": item["sha256"]}


def read(root, name, expected=None, *, retain=True):
    name = relative(name)
    target = root / name
    require(not any(p.is_symlink() for p in (target, *target.parents)), "symlink in refit input")
    hasher, size, chunks = hashlib.sha256(), 0, []
    with target.open("rb") as stream:
        before = os.fstat(stream.fileno())
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
            size += len(chunk)
            if retain:
                chunks.append(chunk)
        after = os.fstat(stream.fileno())
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "refit input changed while read")
    observed = {"bytes": size, "sha256": hasher.hexdigest()}
    if expected is not None:
        require(observed == file_identity(expected), "refit file identity mismatch: " + name)
    return (b"".join(chunks) if retain else None), observed


def metrics_guard(candidate, full, baseline, *, converged, removed_zero, family_counts=False):
    for group in (candidate, full, baseline):
        for phase in ("overall", "opening", "middlegame", "endgame"):
            row = group[phase]
            require(type(row.get("rows")) is int and row["rows"] > 0, "empty validation phase")
            for metric in ("ce", "maeCp", "rmseCp"):
                value = row[metric]
                require(type(value) in (float, int) and math.isfinite(value) and value >= 0,
                        "invalid validation metric")
            if family_counts:
                require(type(row.get("families")) is int and 0 < row["families"] <= row["rows"],
                        "invalid validation family inventory")
        require(sum(group[p]["rows"] for p in ("opening", "middlegame", "endgame")) == group["overall"]["rows"],
                "phase rows do not sum to the validation inventory")
    require(candidate["overall"]["rows"] == full["overall"]["rows"] == baseline["overall"]["rows"] == ROLES["validation"],
            "validation inventory differs")
    require(all(candidate[p]["rows"] == full[p]["rows"] == baseline[p]["rows"]
                for p in ("opening", "middlegame", "endgame")), "phase inventory differs")
    if family_counts:
        require(all(candidate[p]["families"] == full[p]["families"] == baseline[p]["families"]
                    for p in ("overall", "opening", "middlegame", "endgame")), "family inventory differs")
    gain = baseline["overall"]["ce"] - full["overall"]["ce"]
    checks = {"numericallyConverged": converged, "removedFamilyExactlyZero": removed_zero,
              "retainedFullCeGain": gain > 0 and baseline["overall"]["ce"] - candidate["overall"]["ce"] >= 0.75 * gain,
              "minimumCeGainOverHce": candidate["overall"]["ce"] <= baseline["overall"]["ce"] * 0.995,
              "maeCp": candidate["overall"]["maeCp"] <= full["overall"]["maeCp"] * 1.03,
              "rmseCp": candidate["overall"]["rmseCp"] <= full["overall"]["rmseCp"] * 1.03}
    checks.update({phase + "Ce": candidate[phase]["ce"] <= baseline[phase]["ce"]
                   for phase in ("opening", "middlegame", "endgame")})
    return checks


def capture(manifest: Path, recipe: str, *, validate_tables):
    require(recipe in RECIPES, "unknown refit recipe")
    manifest = Path(manifest).absolute()
    require(manifest.name == "RESULTS.json", "refit-manifest must name the complete RESULTS.json")
    root = manifest.parent
    result_raw, result_identity = read(root, manifest.name)
    result = json.loads(result_raw)
    require(result.get("schema") == "chessy.eval-pipeline-refit-results.v1"
            and result.get("status") == "complete-research-only", "complete refit result required")
    require(result.get("researchOnly") is True and result.get("productionAdmission") is False
            and result.get("noHoldoutOrOodFilesRead") is True and result.get("strengthEvidence") is False,
            "refit scope or admission changed")
    files = result["files"]
    require(isinstance(files, dict), "missing complete refit inventory")
    for name, item in files.items():
        relative(name); file_identity(item)
    retained = {"RESULTS.json": result_raw}
    inspected = {}

    def consume(name, retain=True):
        require(name in files, "missing required refit file: " + name)
        if name not in inspected:
            raw, observed = read(root, name, files[name], retain=retain)
            inspected[name] = observed
            if retain:
                retained[name] = raw
        return retained.get(name)

    registration_raw = consume("REGISTRATION.json")
    require(sha(registration_raw) == result.get("registrationSha256"), "refit registration binding differs")
    registration = json.loads(registration_raw)
    require(registration.get("schema") == "chessy.eval-pipeline-refit-registration.v1"
            and registration.get("researchOnly") is True and registration.get("productionAdmission") is False
            and registration.get("trainingStarted") is False
            and registration.get("noHoldoutOrOodFilesRead") is True,
            "invalid refit registration")
    require(set(registration["files"]) == REQUIRED_REGISTERED, "incomplete registered input/source inventory")
    for name, declared in registration["files"].items():
        require(name in files and file_identity(declared) == file_identity(files[name]),
                "registered input was omitted or replaced: " + name)
    protocol = result["protocol"]
    require(protocol == registration.get("protocol") == json.loads(consume("PROTOCOL.json")), "refit protocol differs")
    require(protocol.get("schema") == "chessy.eval-pipeline-refit-protocol.v1"
            and protocol.get("researchOnly") is True
            and protocol.get("rolesOpened") == ["train", "validation"]
            and protocol.get("dataManifestSha256") == DATA_SHA
            and protocol.get("packedManifestSha256") == PACKED_SHA
            and protocol.get("originalFullModelSha256") == FULL_SHA
            and protocol.get("recipes") == list(RECIPES.values())
            and protocol.get("qualityRules") == QUALITY
            and protocol.get("productionAdmission") is False
            and protocol.get("noHoldoutOrOodFilesRead") is True, "unrecognized prospective refit protocol")
    require(protocol["fit"]["l1"] == 1e-5 and protocol["fit"]["l2"] == 1e-4
            and protocol["fit"]["minSupport"] == 32 and protocol["fit"]["maxIterations"] == 400
            and protocol["fit"]["optimizerSourceSha256"] == SOURCE_HASHES["source/tools/sparse_eval/fit.py"],
            "refit optimizer recipe differs")
    started = json.loads(consume("RUN-STARTED.json"))
    require(started.get("registrationSha256") == sha(registration_raw)
            and started.get("protocol") == protocol, "refit run did not bind the registered protocol")
    data_raw, packed_raw = consume("inputs/data-manifest.json"), consume("inputs/packed-manifest.json")
    require(sha(data_raw) == DATA_SHA and sha(packed_raw) == PACKED_SHA, "original corpus manifest identity differs")
    require(sha(consume("inputs/original-full.i16le")) == FULL_SHA, "original full model differs")
    data, packed = json.loads(data_raw), json.loads(packed_raw)
    require(data.get("schema") == "chessy.sparse-eval-data.v1"
            and packed.get("schema") == "chessy.sparse-packed.v1"
            and packed.get("sourceManifestSha256") == DATA_SHA and packed.get("featureCount") == 17280
            and packed.get("noCrossRoleFamilyOrClusterOverlap") is True, "original corpus provenance is incomplete")
    for item in (data, packed):
        require(item.get("status") == "complete-research-only" and item.get("researchOnly") is True
                and item.get("productionFitAllowed") is False, "original research provenance changed")
    rebuilt = json.loads(consume("packed/PACKED.json"))
    require(rebuilt.get("schema") == "chessy.eval-pipeline-refit-packed.v1"
            and rebuilt.get("originalPackedManifestSha256") == PACKED_SHA
            and rebuilt.get("noHoldoutOrOodFilesRead") is True
            and rebuilt.get("noCrossRoleFamilyOrClusterOverlap") is True, "rebuilt packed provenance differs")
    bulk = {"tools/rustc", "extractor"}
    required_roles = []
    for role, rows in ROLES.items():
        source_rows = [item for item in data["files"] if item["role"] == role]
        packed_rows = [item for item in packed["roles"] if item["role"] == role]
        require(len(source_rows) == len(packed_rows) == 1, "missing original role")
        source, part = source_rows[0], packed_rows[0]
        require(source["rows"] == part["rows"] == rows and source["path"] == role + ".jsonl"
                and set(part["files"]) == set(PACKED_FILES), "original role inventory differs")
        required_roles.append(part)
        name = "inputs/" + source["path"]
        require(name in files and file_identity(files[name]) == file_identity(source), "source role was omitted or replaced")
        bulk.add(name)
        for suffix in PACKED_FILES:
            item = part["files"][suffix]
            require(item["path"] == role + "." + suffix, "packed role filename differs")
            name = "packed/" + item["path"]
            require(name in files and file_identity(files[name]) == file_identity(item), "packed role was omitted or replaced")
            bulk.add(name)
    require(rebuilt.get("roles") == required_roles, "packed arrays were not reconstructed exactly")
    for name, expected_hash in SOURCE_HASHES.items():
        require(sha(consume(name)) == expected_hash, "historical fit/feature/engine source differs")
    for label in ("hce", "full"):
        score = result["references"][label]["scores"]
        require(score.get("path") == label + ".validation.i32"
                and score["bytes"] == ROLES["validation"] * 4
                and score["path"] in files
                and file_identity(score) == file_identity(files[score["path"]]),
                "reference score inventory differs")
        consume(score["path"])
    candidates = result.get("candidates")
    require(isinstance(candidates, list) and [entry["id"] for entry in candidates] == list(RECIPES),
            "complete two-recipe result inventory required")
    for entry in candidates:
        name = entry["id"]
        require(json.loads(consume(name + ".json")) == entry, "recipe report differs from completion")
        require(entry.get("schema") == "chessy.eval-pipeline-refit-model.v1"
                and entry.get("researchOnly") is True and entry.get("productionAdmission") is False
                and entry.get("noHoldoutOrOodFilesRead") is True
                and entry.get("recipe") == RECIPES[name] and entry.get("registrationSha256") == sha(registration_raw)
                and entry.get("dataManifestSha256") == DATA_SHA and entry.get("packedManifestSha256") == PACKED_SHA
                and entry.get("originalFullModelSha256") == FULL_SHA, "recipe provenance differs")
        for key, suffix in (("weights", ".i16le"), ("floatWeights", ".f64le"), ("validationScores", ".validation.i32")):
            item = entry[key]
            require(item.get("path") == name + suffix and item["path"] in files
                    and file_identity(item) == file_identity(files[item["path"]]), "recipe artifact binding differs")
            consume(item["path"])
        require(entry["weights"]["bytes"] == 17280 * 2 and entry["floatWeights"]["bytes"] == 17280 * 8
                and entry["validationScores"]["bytes"] == ROLES["validation"] * 4, "recipe artifact dimensions differ")
    for name, declared in files.items():
        require(not (name.startswith(("inputs/", "packed/")) and ("holdout" in name or "ood" in name.lower())),
                "held-out data cannot enter refit closure")
        consume(name, retain=name not in bulk)
    selected = next(entry for entry in candidates if entry["id"] == recipe)
    model = retained[selected["weights"]["path"]]
    weights = struct.unpack("<17280h", model)
    floats = struct.unpack("<17280d", retained[selected["floatWeights"]["path"]])
    require(all(math.isfinite(value) and integer == (1 if value >= 0 else -1) * math.floor(abs(value) + 0.5)
                for value, integer in zip(floats, weights)), "integer export is not symmetric half-away rounding")
    start, stop = SPECIALIZATIONS[recipe]["removedRange"]
    removed_zero = all(value == 0 for value in weights[start:stop] + weights[start + 8640:stop + 8640])
    require(removed_zero, "removed coefficient family is not exactly zero")
    fit = selected["fit"]
    gradient = fit.get("projectedGradientInfinityNorm")
    require(fit.get("schema") == "chessy.sparse-convex-fit.v1" and fit.get("researchOnly") is True
            and fit.get("rows") == ROLES["train"] and fit.get("columns") == 17280
            and fit.get("families") == RECIPES[recipe]["families"]
            and fit.get("l1") == 1e-5 and fit.get("l2") == 1e-4
            and type(fit.get("iterations")) is int and 0 <= fit["iterations"] <= 400,
            "fitted optimization differs from registered recipe")
    converged = (fit.get("solverSuccess") is True and type(gradient) in (float, int)
                 and math.isfinite(gradient) and 0 <= gradient <= 1e-5)
    require(fit.get("numericallyConverged") is True and converged, "refit did not numerically converge")
    checks = {}
    for label, metric_key in (("rows", "validation"), ("families", "familyBalanced")):
        actual = metrics_guard(selected[metric_key], result["references"]["full"][metric_key],
                               result["references"]["hce"][metric_key], converged=converged,
                               removed_zero=removed_zero, family_counts=label == "families")
        require(selected["qualityGuards"][label].get("checks") == actual
                and selected["qualityGuards"][label].get("passed") is all(actual.values()),
                "reported quality guard differs from metrics")
        checks[label] = actual
    require(selected.get("qualityEligible") is True and all(all(group.values()) for group in checks.values()),
            "refit is not validation eligible")
    require(selected.get("runtime", {}).get("losslessI8TablesSupported") is True,
            "refit is not lossless-runtime eligible")
    validate_tables(model)
    receipt = {"schema": "chessy.eval-pipeline-refit-import.v1", "researchOnly": True,
               "productionAdmission": False, "recipe": recipe, "manifest": result_identity,
               "registrationSha256": sha(registration_raw), "dataManifestSha256": DATA_SHA,
               "packedManifestSha256": PACKED_SHA, "originalFullModelSha256": FULL_SHA,
               "completeInventoryFilesVerified": len(inspected), "files": inspected,
               "retainedFiles": sorted(retained), "bulkFilesVerifiedByStreaming": sorted(bulk),
               "qualityEligible": True, "runtimeExportEligible": True,
               "specialization": SPECIALIZATIONS[recipe], "selectedModel": file_identity(selected["weights"]),
               "limits": ["Validation is exposed development data, not playing-strength evidence.",
                          "Hashes bind supplied evidence; they do not independently establish training honesty.",
                          "The original corpus lacks source-game IDs."]}
    retained["IMPORT.json"] = encoded(receipt)
    return {"model": model, "selection": encoded(selected), "retained": retained,
            "specialization": SPECIALIZATIONS[recipe], "receipt": receipt}
