#!/usr/bin/env python3
"""A separate, prospective exact-cost comparison for the frozen full model.

The original runtime-v1 is preserved. This is not a retry of that study: one
new, source-identified implementation is compared with its exact reference.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

import numpy as np

from tools.sparse_eval.features import N_FEATURES
from tools.sparse_eval.fit import predict
from tools.sparse_eval.pipeline import authenticated_bytes, load_role
from tools.sparse_eval.measure import (sha, encoded, write, validate_parity, validate_static,
                                       validate_search, geometric_mean, PHASES)

ROOT = Path(__file__).resolve().parents[2]
SIGNATURE = ("nodes", "qnodes", "depth", "score", "move")


def validate_config(config):
    required = {"schema": "chessy.sparse-fast-runtime-config.v1", "researchOnly": True,
                "changeClass": "cost-only-exact-evaluation", "model": "full", "positions": 24,
                "staticPasses": 6000, "nodeBudgets": [10000, 36000], "replicates": 2,
                "maximumDepth": 64, "searchSignatureFields": list(SIGNATURE), "modelSelectionByTiming": False}
    for name, expected in required.items():
        if config.get(name) != expected:
            raise ValueError("frozen fast protocol differs: " + name)
    for name in ("weightsSha256", "fitResultsSha256", "packedManifestSha256", "previousRuntimeResultsSha256",
                 "positionsSha256", "referenceNativeSha256", "candidateNativeSha256", "candidateBuildReceiptSha256"):
        value = config.get(name)
        if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
            raise ValueError("missing frozen content identity: " + name)


def compare_search(rows):
    grouped = {}
    for row in rows:
        key = (row["requested_nodes"], row["replicate"], row["positionIndex"], row["candidate"])
        by_runtime = grouped.setdefault(key, {})
        if row["runtime"] in by_runtime:
            raise ValueError("duplicate runtime search observation")
        by_runtime[row["runtime"]] = row
    compared, signature_checks = [], 0
    for key, variants in grouped.items():
        if set(variants) != {"reference", "fast"}:
            raise ValueError("missing old/new observation")
        old, fast = variants["reference"], variants["fast"]
        if any(old[name] != fast[name] for name in SIGNATURE):
            raise ValueError(f"cost-only search signature mismatch: {key}")
        if old["fenSha256"] != fast["fenSha256"] or old["phaseBucket"] != fast["phaseBucket"]:
            raise ValueError("old/new position identities differ")
        signature_checks += 1
        compared.append({"requestedNodes": key[0], "replicate": key[1], "positionIndex": key[2],
                         "candidate": key[3], "phaseBucket": old["phaseBucket"],
                         "referenceOverFastTime": old["elapsed_ns"] / fast["elapsed_ns"],
                         "nodes": old["nodes"], "bothConsumedRequestedNodes": old["consumedRequestedNodes"] and fast["consumedRequestedNodes"]})
    relative_to_hce = {}
    for row in rows:
        key = (row["runtime"], row["requested_nodes"], row["replicate"], row["positionIndex"])
        relative_to_hce.setdefault(key, {})[row["candidate"]] = row
    if any(set(pair) != {False, True} for pair in relative_to_hce.values()):
        raise ValueError("missing within-runtime HCE pair")
    summaries = []
    for nodes in (10000, 36000):
        for phase in ("all", *PHASES):
            part = [row for row in compared if row["candidate"] and row["requestedNodes"] == nodes and
                    (phase == "all" or row["phaseBucket"] == phase)]
            if not part:
                continue
            item = {"requestedNodes": nodes, "phaseBucket": phase, "candidatePairs": len(part),
                    "referenceOverFastTimeGeometricMean": geometric_mean(r["referenceOverFastTime"] for r in part),
                    "bothConsumedRequestedNodes": sum(r["bothConsumedRequestedNodes"] for r in part)}
            for runtime in ("reference", "fast"):
                pairs = [pair for key, pair in relative_to_hce.items() if key[0] == runtime and key[1] == nodes and
                         (phase == "all" or pair[False]["phaseBucket"] == phase)]
                if any(set(pair) != {False, True} for pair in pairs):
                    raise ValueError("missing within-runtime HCE pair")
                item[runtime + "CandidateOverHceNpsGeometricMean"] = geometric_mean(
                    pair[True]["nodes"] / pair[False]["nodes"] * pair[False]["elapsed_ns"] / pair[True]["elapsed_ns"]
                    for pair in pairs if pair[True]["nodes"] and pair[False]["nodes"])
                item[runtime + "HceOverCandidateTimeGeometricMean"] = geometric_mean(
                    pair[False]["elapsed_ns"] / pair[True]["elapsed_ns"] for pair in pairs)
            summaries.append(item)
    return {"signatureComparisons": signature_checks, "pairs": compared, "summary": summaries}


def receipt(config_path):
    names = ("__init__.py", "measure_fast.py", "measure.py", "pipeline.py", "fit.py", "features.py")
    paths = [ROOT / "tools/sparse_eval" / name for name in names] + [Path(config_path)]
    return {str(path): sha(path.read_bytes()) for path in paths}


def measure(packed_path, fit_path, previous_path, reference_path, fast_path, fast_receipt_path, output, config_path):
    packed_path, fit_path, previous_path, reference_path, fast_path, fast_receipt_path, output, config_path = map(
        Path, (packed_path, fit_path, previous_path, reference_path, fast_path, fast_receipt_path, output, config_path))
    config_raw = config_path.read_bytes(); config = json.loads(config_raw); validate_config(config)
    retained = {}
    for key, path in (("packedManifest", packed_path), ("fitResults", fit_path), ("previousRuntimeResults", previous_path)):
        raw = path.read_bytes()
        if sha(raw) != config[key + "Sha256"]:
            raise ValueError("wrong frozen input: " + key)
        retained[key] = raw
    packed, fitted, previous = (json.loads(retained[key]) for key in ("packedManifest", "fitResults", "previousRuntimeResults"))
    if fitted.get("status") != "complete-research-only" or previous.get("status") != "complete-research-only":
        raise ValueError("incomplete preceding experiment")
    if fitted.get("sourceManifestSha256") != config["packedManifestSha256"]:
        raise ValueError("fit data identity differs")
    position_raw = authenticated_bytes(previous_path.parent, previous["plan"]["selectedPositions"])
    if sha(position_raw) != config["positionsSha256"]:
        raise ValueError("root selection changed")
    positions = json.loads(position_raw)
    if len(positions) != config["positions"] or len({p["fen"] for p in positions}) != config["positions"]:
        raise ValueError("invalid frozen roots")
    weight_entry = next(c for c in fitted["candidates"] if c["id"] == "full")["weights"]
    weights_raw = authenticated_bytes(fit_path.parent, weight_entry)
    if sha(weights_raw) != config["weightsSha256"] or len(weights_raw) != N_FEATURES * 2:
        raise ValueError("full weights changed")
    binaries = {"reference": reference_path.read_bytes(), "fast": fast_path.read_bytes()}
    if sha(binaries["reference"]) != config["referenceNativeSha256"] or sha(binaries["reference"]) == sha(binaries["fast"]):
        raise ValueError("requires frozen reference and a genuinely new native candidate")
    build_raw = fast_receipt_path.read_bytes(); build = json.loads(build_raw)
    if sha(binaries["fast"]) != config["candidateNativeSha256"] or sha(build_raw) != config["candidateBuildReceiptSha256"]:
        raise ValueError("optimized candidate or build receipt changed after registration")
    # Receipt schema is owned by the independent native implementation stage.
    native = build.get("native", {})
    if native.get("sha256") != sha(binaries["fast"]) or native.get("bytes") != len(binaries["fast"]):
        raise ValueError("fast binary does not match its frozen build receipt")
    for path in ("experiments/wasm/src/engine.rs", "experiments/wasm/src/eval.rs", "experiments/wasm/src/search.rs"):
        if build.get("sourceHashes", {}).get(path) != packed["implementation"][path]:
            raise ValueError("cost candidate changed production source: " + path)
    if build.get("cfg") != "sparse_fast":
        raise ValueError("candidate was not the declared sparse_fast build")
    implementation = receipt(config_path)
    validation = load_role(packed_path, "validation", expected_manifest_sha=config["packedManifestSha256"])
    part = next(r for r in packed["roles"] if r["role"] == "validation")
    fens_raw = authenticated_bytes(packed_path.parent, part["files"]["fens.txt"])
    fens = fens_raw.decode().splitlines()
    if len(fens) != 100164:
        raise ValueError("complete frozen validation inventory required")
    for position in positions:
        index = position["validationIndex"]
        if position["fen"] != fens[index] or position["phase"] != int(validation["phase"][index]):
            raise ValueError("root is not its recorded validation position")
    weights = np.frombuffer(weights_raw, dtype="<i2")
    predicted = predict(validation["X"], validation["baseline"], weights)
    output.mkdir(parents=False, exist_ok=False)
    local_native = {}
    for name, raw in binaries.items():
        local_native[name] = output / (name + "-native")
        write(local_native[name], raw); local_native[name].chmod(0o500)
    model = output / "full.i16le"; write(model, weights_raw); model.chmod(0o400)
    write(output / "positions.json", position_raw)
    write(output / "config.json", config_raw)
    write(output / "fast-build.json", build_raw)
    plan = {"schema": "chessy.sparse-fast-runtime-plan.v1", "startedAt": datetime.now(timezone.utc).isoformat(),
            "researchOnly": True, "config": config, "configSha256": sha(config_raw), "implementation": implementation,
            "nativeSha256": {name: sha(raw) for name, raw in binaries.items()}, "fastBuildReceiptSha256": sha(build_raw),
            "weightsSha256": sha(weights_raw), "positionsSha256": sha(position_raw), "noHoldoutRoleFilesRead": True}
    write(output / "plan.json", encoded(plan))
    raw_files, parity, static, observations = [], [], [], []

    def invoke(runtime, arguments, payload, stem):
        result = subprocess.run([str(local_native[runtime]), *arguments], input=payload, capture_output=True)
        out = write(output / (stem + ".stdout"), result.stdout)
        error = write(output / (stem + ".stderr"), result.stderr)
        raw_files.append({"runtime": runtime, "arguments": arguments, "returncode": result.returncode, "stdout": out, "stderr": error})
        if result.returncode:
            write(output / "failure.json", encoded({"stage": stem, "returncode": result.returncode, "rawFiles": raw_files}))
            raise ValueError("native comparison failed; raw evidence retained")
        return result.stdout

    for runtime in ("reference", "fast"):
        raw = invoke(runtime, ["eval", str(model)], fens_raw, runtime + ".parity")
        parity.append(dict(validate_parity(raw, validation["baseline"], predicted), runtime=runtime))
    for replicate in range(config["replicates"]):
        ordered = positions if replicate == 0 else list(reversed(positions))
        runtimes = ("reference", "fast") if replicate == 0 else ("fast", "reference")
        payload = ("\n".join(p["fen"] for p in ordered) + "\n").encode()
        indices = [p["validationIndex"] for p in ordered]
        for runtime in runtimes:
            raw = invoke(runtime, ["bench", str(model), str(config["staticPasses"])], payload, f"{runtime}.static.{replicate}")
            static.append(dict(validate_static(raw, ordered, config["staticPasses"], validation["baseline"][indices], predicted[indices]),
                               runtime=runtime, replicate=replicate))
        for nodes in config["nodeBudgets"]:
            for runtime in runtimes:
                raw = invoke(runtime, ["search", str(model), str(nodes), str(config["maximumDepth"])], payload,
                             f"{runtime}.search.{nodes}.{replicate}")
                rows = validate_search(raw, ordered, nodes, "full", replicate)
                observations.extend(dict(row, runtime=runtime) for row in rows)
    if len(observations) != 384:
        raise ValueError("incomplete old/new search inventory")
    comparison = compare_search(observations)
    if comparison["signatureComparisons"] != 192:
        raise ValueError("incomplete old/new signature comparisons")
    static_pairs = []
    for replicate in range(2):
        old = next(row for row in static if row["runtime"] == "reference" and row["replicate"] == replicate)
        fast = next(row for row in static if row["runtime"] == "fast" and row["replicate"] == replicate)
        static_pairs.append(old["candidate_ns"] / fast["candidate_ns"])
    observation_id = write(output / "search-observations.jsonl", b"".join(encoded(row) for row in observations))
    pairs_id = write(output / "search-comparisons.jsonl", b"".join(encoded(row) for row in comparison["pairs"]))
    if (receipt(config_path) != implementation or sha(model.read_bytes()) != sha(weights_raw) or
            sha(previous_path.read_bytes()) != config["previousRuntimeResultsSha256"]):
        raise ValueError("retained code/model changed during comparison")
    if any(sha(path.read_bytes()) != sha(binaries[name]) for name, path in local_native.items()):
        raise ValueError("retained native binary changed during comparison")
    report = {"schema": "chessy.sparse-fast-runtime-results.v1", "status": "complete-research-only",
              "researchOnly": True, "productionFitAllowed": False, "plan": plan, "parity": parity,
              "static": static, "staticReferenceOverFastTimeGeometricMean": geometric_mean(static_pairs),
              "search": comparison["summary"], "signatureComparisons": 192, "signatureMismatches": 0,
              "observations": observation_id, "pairs": pairs_id, "rawFiles": raw_files,
              "previousRuntimeUnchanged": True, "noRefit": True, "noHoldoutRoleFilesRead": True,
              "limitations": ["new exact-cost candidate, same frozen fitted weights and same preregistered roots",
                              "finite-workload signatures do not prove universal search equivalence",
                              "native desktop timings do not establish WASM, phone, Elo or shipping admission"]}
    write(output / "results.json", encoded(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("packed_manifest", "fit_results", "previous_runtime", "reference_native", "fast_native", "fast_receipt", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--config", type=Path, default=ROOT / "eval/sparse-pesto-v1/RUNTIME-FAST-CONFIG.json")
    a = parser.parse_args()
    result = measure(a.packed_manifest, a.fit_results, a.previous_runtime, a.reference_native,
                     a.fast_native, a.fast_receipt, a.output, a.config)
    print(json.dumps({"complete": result["schema"], "signatureMismatches": result["signatureMismatches"]}))


if __name__ == "__main__":
    main()
