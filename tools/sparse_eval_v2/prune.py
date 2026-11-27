#!/usr/bin/env python3
"""Frozen validation-only sparsification screen; never reads holdout labels."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

from tools.sparse_eval.features import BASE_FEATURES, FAMILIES, N_FEATURES
from tools.sparse_eval.fit import metrics, predict
from tools.sparse_eval.pipeline import encoded, load_role, write, write_json

ROOT = Path(__file__).resolve().parents[2]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def derive(source, recipe, king):
    source = np.asarray(source, dtype=np.int32)
    if source.shape != (N_FEATURES,) or np.asarray(king).shape != source.shape:
        raise ValueError("wrong model shape")
    result = source.copy()
    operation = recipe["operation"]
    extra = {}
    if operation == "identity":
        pass
    elif operation == "zero-small":
        threshold = recipe["threshold"]
        if type(threshold) is not int or threshold < 0:
            raise ValueError("invalid pruning threshold")
        result[np.abs(result) <= threshold] = 0
    elif operation == "zero-families":
        if not recipe["families"] or set(recipe["families"]) - FAMILIES.keys():
            raise ValueError("invalid feature family")
        for family in recipe["families"]:
            start, end = FAMILIES[family]
            for phase in (0, BASE_FEATURES):
                result[phase + start:phase + end] = 0
    elif operation == "existing-king":
        result = np.asarray(king, dtype=np.int32).copy()
    elif operation == "symmetric-int4":
        if recipe["maxCode"] != 7:
            raise ValueError("four-bit symmetric codes must lie in [-7,7]")
        scales = {}
        for phase in (0, BASE_FEATURES):
            for family, (start, end) in FAMILIES.items():
                block = result[phase + start:phase + end]
                scale = max(1, (int(np.max(np.abs(block))) + 6) // 7)
                # Integer-only symmetric half-away-from-zero rounding.
                code = np.sign(block) * ((2 * np.abs(block) + scale) // (2 * scale))
                if np.any(np.abs(code) > 7):
                    raise ValueError("four-bit code overflow")
                result[phase + start:phase + end] = code * scale
                scales[f"{'mg' if phase == 0 else 'eg'}:{family}"] = scale
        extra = {"integerScales": scales, "codes": "signed symmetric4-bit [-7,7]",
                 "runtimeStorage": "reconstructed integer coefficients; no packed-int4 inference claim"}
    else:
        raise ValueError("unknown pruning operation")
    if np.any(result < -32768) or np.any(result > 32767):
        raise ValueError("export overflow")
    return result.astype("<i2"), extra


def quality_guard(candidate, full, baseline, rules):
    c, f, b = (value["overall"] for value in (candidate, full, baseline))
    gain = b["ce"] - f["ce"]
    checks = {
        "retainedFullCeGain": gain > 0 and b["ce"] - c["ce"] >= rules["minimumRetainedFractionOfFullCeGain"] * gain,
        "minimumGainOverHce": c["ce"] <= b["ce"] * (1 - rules["minimumCeImprovementOverHce"]),
        "maeBound": c["maeCp"] <= f["maeCp"] * rules["maximumMaeRatioToFull"],
        "rmseBound": c["rmseCp"] <= f["rmseCp"] * rules["maximumRmseRatioToFull"],
        "phaseCe": all(candidate[p]["rows"] > 0 and candidate[p]["ce"] <= baseline[p]["ce"]
                       for p in ("opening", "middlegame", "endgame")),
    }
    return {"passed": all(checks.values()), "checks": checks,
            "retainedCeGainFraction": (b["ce"] - c["ce"]) / gain if gain > 0 else None}


def implementation():
    files = list((ROOT / "tools/sparse_eval").glob("*.py"))
    files += list((ROOT / "tools/sparse_eval/baseline").glob("*.rs"))
    files += [Path(__file__), Path(__file__).with_name("__init__.py"),
              ROOT / "tools/sparse_eval/baseline/manifest.json"]
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(files)}


def run(config_path, packed_path, output):
    config_path, packed_path, output = map(Path, (config_path, packed_path, output))
    config_raw = config_path.read_bytes()
    config = json.loads(config_raw)
    if config.get("schema") != "chessy.sparse-v2-pruning.v1" or config.get("role") != "validation":
        raise ValueError("wrong pruning configuration or role")
    source_raw = (ROOT / config["sourceModel"]).read_bytes()
    king_raw = (ROOT / config["kingModel"]).read_bytes()
    if (sha(source_raw) != config["sourceModelSha256"] or sha(king_raw) != config["kingModelSha256"]
            or len(source_raw) != N_FEATURES * 2 or len(king_raw) != N_FEATURES * 2):
        raise ValueError("wrong frozen source model")
    source = np.frombuffer(source_raw, dtype="<i2")
    king = np.frombuffer(king_raw, dtype="<i2")
    recipes = config["recipes"]
    ids = [r["id"] for r in recipes]
    if (len(ids) != len(set(ids)) or not ids or ids[0] != "full"
            or any(Path(name).name != name or name in (".", "..") for name in ids)):
        raise ValueError("invalid recipe inventory")
    snapshot = implementation()
    output.mkdir(parents=False, exist_ok=False)
    models = []
    for recipe in recipes:
        weights, detail = derive(source, recipe, king)
        item = write(output / (recipe["id"] + ".i16le"), weights.tobytes())
        models.append({"id": recipe["id"], "weights": item, "recipe": recipe,
                       "nonzero": int(np.count_nonzero(weights)), "minimum": int(weights.min()),
                       "maximum": int(weights.max()), "derivation": detail})
    plan = {"schema": "chessy.sparse-v2-pruning-plan.v1", "researchOnly": True,
            "config": config, "configSha256": sha(config_raw), "implementation": snapshot,
            "models": models, "validationOpened": False,
            "noHoldoutOrOodFilesRead": True, "noRefit": True}
    plan_identity = write_json(output / "plan.json", plan)
    # Model bytes and their plan exist before any validation teacher is decoded.
    role = load_role(packed_path, "validation", expected_manifest_sha=config["packedManifestSha256"])
    baseline = metrics(role["baseline"], role["teacher"], role["phase"])
    results = []
    for item in models:
        raw = (output / item["weights"]["path"]).read_bytes()
        if sha(raw) != item["weights"]["sha256"]:
            raise ValueError("derived model changed before use")
        scores = predict(role["X"], role["baseline"], np.frombuffer(raw, dtype="<i2"))
        evidence = write(output / (item["id"] + ".scores.i32"), np.asarray(scores, dtype="<i4").tobytes())
        results.append(dict(item, metrics=metrics(scores, role["teacher"], role["phase"]), scores=evidence))
    full = results[0]["metrics"]
    for item in results:
        item["qualityGuard"] = quality_guard(item["metrics"], full, baseline, config["qualityRules"])
    if (implementation() != snapshot or config_path.read_bytes() != config_raw
            or (ROOT / config["sourceModel"]).read_bytes() != source_raw
            or (ROOT / config["kingModel"]).read_bytes() != king_raw):
        raise ValueError("implementation or source changed during execution")
    report = {"schema": "chessy.sparse-v2-pruning-results.v1", "status": "complete-research-only",
              "researchOnly": True, "productionAdmission": False,
              "plan": plan_identity, "configSha256": sha(config_raw), "implementation": snapshot,
              "rows": len(role["teacher"]), "baseline": baseline, "candidates": results,
              "modelSelection": "quality eligibility only; WASM cost selection still required before games",
              "noHoldoutOrOodFilesRead": True, "noRefit": True}
    write_json(output / "results.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packed_manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--config", type=Path, default=ROOT / "eval/sparse-pesto-v2/PRUNING-CONFIG.json")
    args = parser.parse_args()
    result = run(args.config, args.packed_manifest, args.output)
    print(json.dumps({"rows": result["rows"], "candidates": [
        {"id": x["id"], "nonzero": x["nonzero"], "ce": x["metrics"]["overall"]["ce"],
         "maeCp": x["metrics"]["overall"]["maeCp"], "eligible": x["qualityGuard"]["passed"]}
        for x in result["candidates"]]}, indent=2))


if __name__ == "__main__":
    main()
