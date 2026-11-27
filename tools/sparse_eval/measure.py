#!/usr/bin/env python3
"""Predeclared native parity and cost experiment, with no holdout reads.

The five fitted variants are all measured once, independent of quality.
Run from a retained read-only implementation snapshot after other experiments
have finished. Raw native observations are retained before interpretation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys

import chess
import numpy as np

from tools.sparse_eval.features import N_FEATURES
from tools.sparse_eval.fit import predict
from tools.sparse_eval.pipeline import authenticated_bytes, load_role

ROOT = Path(__file__).resolve().parents[2]
MODELS = ("pst", "king", "full", "full-ridge", "full-sparse")
PHASES = ("opening", "middlegame", "endgame")


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def write(path, raw):
    with open(path, "xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": Path(path).name, "bytes": len(raw), "sha256": sha(raw)}


def phase_name(phase):
    return "opening" if phase >= 18 else "middlegame" if phase >= 7 else "endgame"


def validate_config(config):
    expected = {
        "schema": "chessy.sparse-runtime-config.v1", "researchOnly": True,
        "models": list(MODELS), "selectionRole": "validation", "phaseOrder": list(PHASES),
        "positionsPerPhase": 8, "staticPasses": 6000,
        "staticGroups": ["all", *PHASES], "nodeBudgets": [10000, 36000],
        "searchReplicates": 2, "searchMaximumDepth": 64, "modelSelectionByTiming": False,
    }
    for key, value in expected.items():
        if config.get(key) != value:
            raise ValueError("frozen runtime config differs: " + key)


def select_positions(fens, phases, quota=8):
    if len(fens) != len(phases) or len(set(fens)) != len(fens):
        raise ValueError("invalid validation FEN inventory")
    groups = {name: [] for name in PHASES}
    for index, (fen, phase) in enumerate(zip(fens, phases)):
        if not isinstance(fen, str) or not fen or not 0 <= int(phase) <= 24:
            raise ValueError("invalid position or phase")
        name = phase_name(int(phase))
        groups[name].append({"validationIndex": index, "fen": fen, "fenSha256": sha(fen.encode()),
                             "phase": int(phase), "phaseBucket": name})
    result = []
    for name in PHASES:
        if len(groups[name]) < quota:
            raise ValueError("phase selection shortfall")
        selected = sorted(groups[name], key=lambda row: (row["fenSha256"], row["fen"]))[:quota]
        result.extend(selected)
    return [dict(row, positionIndex=i) for i, row in enumerate(result)]


def validate_parity(raw, baseline, candidate):
    lines = raw.decode().splitlines()
    if len(lines) != len(baseline):
        raise ValueError("native parity row count differs")
    outputs = np.array([list(map(int, line.split())) for line in lines], dtype=np.int64)
    if outputs.shape != (len(baseline), 3):
        raise ValueError("native parity shape differs")
    bad_base = int(np.count_nonzero(outputs[:, 0] != baseline))
    bad_candidate = int(np.count_nonzero(outputs[:, 1] != candidate))
    bad_sum = int(np.count_nonzero(outputs[:, 1] - outputs[:, 0] != outputs[:, 2]))
    if bad_base or bad_candidate or bad_sum:
        raise ValueError(f"native parity failed: baseline={bad_base}, candidate={bad_candidate}, arithmetic={bad_sum}")
    return {"rows": len(baseline), "baselineMismatches": 0, "candidateMismatches": 0, "arithmeticMismatches": 0}


def validate_static(raw, positions, passes, baseline, candidate):
    value = json.loads(raw)
    if (value.get("positions") != len(positions) or value.get("passes") != passes or
            value.get("baseline_checksum") != int(np.sum(baseline)) * passes or
            value.get("candidate_checksum") != int(np.sum(candidate)) * passes):
        raise ValueError("native static benchmark inventory/checksum differs")
    if any(type(value.get(key)) is not int or value[key] <= 0 for key in ("baseline_ns", "candidate_ns")):
        raise ValueError("invalid static timing")
    value["evaluationsPerVariant"] = len(positions) * passes
    value["baselineOverCandidateTime"] = value["baseline_ns"] / value["candidate_ns"]
    return value


def validate_search(raw, positions, nodes, model, replicate):
    lines = raw.decode().splitlines()
    if len(lines) != 2 * len(positions):
        raise ValueError("native search observation count differs")
    seen, rows = set(), []
    for line in lines:
        value = json.loads(line)
        if type(value.get("row")) is not int or not 0 <= value["row"] < len(positions) or type(value.get("candidate")) is not bool:
            raise ValueError("invalid native row/variant identity")
        key = (value["row"], value["candidate"])
        if key in seen:
            raise ValueError("duplicate native search observation")
        seen.add(key)
        for name in ("nodes", "qnodes", "depth", "score", "elapsed_ns", "requested_nodes"):
            if type(value.get(name)) is not int:
                raise ValueError("noninteger search evidence")
        if (value["requested_nodes"] != nodes or not 0 <= value["nodes"] <= nodes or
                not 0 <= value["qnodes"] <= value["nodes"] or not 0 <= value["depth"] <= 64 or value["elapsed_ns"] <= 0):
            raise ValueError("invalid search budget/timing evidence")
        position = positions[value["row"]]
        board = chess.Board(position["fen"])
        try:
            move = chess.Move.from_uci(value["move"])
        except (ValueError, KeyError) as error:
            raise ValueError("invalid move encoding") from error
        if move not in board.legal_moves:
            raise ValueError("search returned an illegal move")
        rows.append(dict(value, model=model, replicate=replicate, positionIndex=position["positionIndex"],
                         phaseBucket=position["phaseBucket"], fenSha256=position["fenSha256"],
                         consumedRequestedNodes=value["nodes"] == nodes))
    expected = {(row, variant) for row in range(len(positions)) for variant in (False, True)}
    if seen != expected:
        raise ValueError("incomplete search pairing")
    return rows


def geometric_mean(values):
    values = list(values)
    if not values:
        return None
    if any(not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError("invalid ratio")
    return math.exp(sum(math.log(value) for value in values) / len(values))


def summarize_search(rows):
    grouped = {}
    for row in rows:
        key = (row["model"], row["requested_nodes"], row["replicate"], row["positionIndex"])
        pair = grouped.setdefault(key, {})
        if row["candidate"] in pair:
            raise ValueError("duplicate paired summary row")
        pair[row["candidate"]] = row
    pairs = []
    for key, values in grouped.items():
        if set(values) != {False, True}:
            raise ValueError("missing paired summary row")
        base, candidate = values[False], values[True]
        if base["phaseBucket"] != candidate["phaseBucket"] or base["fenSha256"] != candidate["fenSha256"]:
            raise ValueError("paired identities differ")
        time_ratio = base["elapsed_ns"] / candidate["elapsed_ns"]
        nps_ratio = candidate["nodes"] / base["nodes"] * time_ratio if base["nodes"] and candidate["nodes"] else None
        pairs.append({"model": key[0], "requestedNodes": key[1], "replicate": key[2], "positionIndex": key[3],
                      "phaseBucket": base["phaseBucket"], "timeRatio": time_ratio, "npsRatio": nps_ratio,
                      "bothConsumedRequestedNodes": base["consumedRequestedNodes"] and candidate["consumedRequestedNodes"],
                      "sameMove": base["move"] == candidate["move"], "sameDepth": base["depth"] == candidate["depth"],
                      "sameScore": base["score"] == candidate["score"]})
    summary = []
    for model in MODELS:
        for nodes in (10000, 36000):
            for phase in ("all", *PHASES):
                selection = [p for p in pairs if p["model"] == model and p["requestedNodes"] == nodes and
                             (phase == "all" or p["phaseBucket"] == phase)]
                if not selection:
                    continue
                full = [p for p in selection if p["bothConsumedRequestedNodes"]]
                summary.append({"model": model, "requestedNodes": nodes, "phaseBucket": phase,
                                "pairs": len(selection), "bothConsumedRequestedNodes": len(full),
                                "timeRatioGeometricMean": geometric_mean(p["timeRatio"] for p in selection),
                                "npsRatioGeometricMean": geometric_mean(p["npsRatio"] for p in selection if p["npsRatio"] is not None),
                                "fullBudgetTimeRatioGeometricMean": geometric_mean(p["timeRatio"] for p in full),
                                "sameMovePairs": sum(p["sameMove"] for p in selection),
                                "sameDepthPairs": sum(p["sameDepth"] for p in selection),
                                "sameScorePairs": sum(p["sameScore"] for p in selection)})
    return {"pairs": pairs, "summary": summary}


def implementation_receipt(config_path):
    paths = (Path(__file__), ROOT / "tools/sparse_eval/pipeline.py", ROOT / "tools/sparse_eval/fit.py",
             ROOT / "tools/sparse_eval/features.py", Path(config_path))
    return {str(path): sha(path.read_bytes()) for path in paths}


def measure(packed_manifest, fit_result, runtime, output, config_path):
    packed_manifest, fit_result, runtime, output, config_path = map(Path, (packed_manifest, fit_result, runtime, output, config_path))
    config_raw = config_path.read_bytes(); config = json.loads(config_raw); validate_config(config)
    packed_raw = packed_manifest.read_bytes(); packed = json.loads(packed_raw); packed_sha = sha(packed_raw)
    fit_raw = fit_result.read_bytes(); fitted = json.loads(fit_raw)
    if (fitted.get("schema") != "chessy.sparse-study.v1" or fitted.get("status") != "complete-research-only" or
            fitted.get("sourceManifestSha256") != packed_sha or fitted.get("researchOnly") is not True or
            fitted.get("productionFitAllowed") is not False):
        raise ValueError("requires completed matching research fits")
    candidates = fitted.get("candidates", [])
    if len(candidates) != 5 or [c["id"] for c in candidates] != list(MODELS):
        raise ValueError("complete predeclared model inventory required")
    runtime_bytes = runtime.read_bytes()
    if sha(runtime_bytes) != packed.get("nativeSha256"):
        raise ValueError("runtime differs from the authenticated feature packer")
    implementation = implementation_receipt(config_path)
    validation = load_role(packed_manifest, "validation", expected_manifest_sha=packed_sha)
    part = next(role for role in packed["roles"] if role["role"] == "validation")
    fen_raw = authenticated_bytes(packed_manifest.parent, part["files"]["fens.txt"])
    fens = fen_raw.decode().splitlines()
    if len(fens) != part["rows"]:
        raise ValueError("validation FEN count differs")
    positions = select_positions(fens, validation["phase"], config["positionsPerPhase"])
    retained_models = {}
    for candidate in candidates:
        raw = authenticated_bytes(fit_result.parent, candidate["weights"])
        if len(raw) != N_FEATURES * 2:
            raise ValueError("wrong integer model size")
        retained_models[candidate["id"]] = raw
    output.mkdir(parents=False, exist_ok=False)
    native = output / "native-extractor"
    write(native, runtime_bytes); native.chmod(0o500)
    model_paths = {}
    for name, raw in retained_models.items():
        model_paths[name] = output / (name + ".i16le")
        write(model_paths[name], raw); model_paths[name].chmod(0o400)
    write(output / "validation-fens.txt", fen_raw)
    selection_receipt = write(output / "positions.json", encoded(positions))
    write(output / "config.json", config_raw)
    plan = {"schema": "chessy.sparse-runtime-plan.v1", "researchOnly": True,
            "startedAt": datetime.now(timezone.utc).isoformat(), "packedManifestSha256": packed_sha,
            "fitResultsSha256": sha(fit_raw), "configSha256": sha(config_raw), "implementation": implementation,
            "nativeSha256": sha(runtime_bytes), "weightsSha256": {name: sha(raw) for name, raw in retained_models.items()},
            "selectedPositions": selection_receipt, "selectionUsesTeacherOrModelScores": False,
            "validationRows": part["rows"], "noHoldoutRoleFilesRead": True,
            "environment": {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(),
                            "numpy": np.__version__, "logicalCPUs": os.cpu_count()},
            "config": config}
    write(output / "plan.json", encoded(plan))
    observations, static, parities, raw_files = [], [], [], []

    def invoke(arguments, payload, stem):
        result = subprocess.run([str(native), *arguments], input=payload, capture_output=True)
        stdout = write(output / (stem + ".stdout"), result.stdout)
        stderr = write(output / (stem + ".stderr"), result.stderr)
        raw_files.append({"command": arguments, "returncode": result.returncode, "stdout": stdout, "stderr": stderr})
        if result.returncode:
            write(output / "failure.json", encoded({"stage": stem, "returncode": result.returncode, "rawFiles": raw_files}))
            raise ValueError("native measurement command failed; raw output retained")
        return result.stdout

    # Parity is a correctness gate, checked on every validation position before
    # timing any model. Teacher scores affect neither selection nor measurement;
    # no holdout role file is read. load_role authenticates validation labels as
    # part of its complete inventory, but this routine never uses their values.
    predictions = {}
    for name in MODELS:
        weights = np.frombuffer(retained_models[name], dtype="<i2")
        expected = predict(validation["X"], validation["baseline"], weights)
        raw = invoke(["eval", str(model_paths[name])], fen_raw, name + ".parity")
        parity = validate_parity(raw, validation["baseline"], expected)
        parities.append(dict(parity, model=name))
        predictions[name] = expected
    for name in MODELS:
        for group in config["staticGroups"]:
            selected = positions if group == "all" else [p for p in positions if p["phaseBucket"] == group]
            payload = ("\n".join(p["fen"] for p in selected) + "\n").encode()
            indices = [p["validationIndex"] for p in selected]
            raw = invoke(["bench", str(model_paths[name]), str(config["staticPasses"])], payload, f"{name}.static.{group}")
            record = validate_static(raw, selected, config["staticPasses"], validation["baseline"][indices], predictions[name][indices])
            static.append(dict(record, model=name, phaseBucket=group))
        for nodes in config["nodeBudgets"]:
            for replicate in range(config["searchReplicates"]):
                ordered = positions if replicate == 0 else list(reversed(positions))
                payload = ("\n".join(p["fen"] for p in ordered) + "\n").encode()
                raw = invoke(["search", str(model_paths[name]), str(nodes), str(config["searchMaximumDepth"])], payload,
                             f"{name}.search.{nodes}.{replicate}")
                observations.extend(validate_search(raw, ordered, nodes, name, replicate))
        print(json.dumps({"measured": name, "staticGroups": 4, "searchObservations": 192}), flush=True)
    expected_observations = len(MODELS) * len(config["nodeBudgets"]) * config["searchReplicates"] * len(positions) * 2
    if len(observations) != expected_observations:
        raise ValueError("incomplete complete-model search inventory")
    summarized = summarize_search(observations)
    observations_id = write(output / "search-observations.jsonl", b"".join(encoded(row) for row in observations))
    pairs_id = write(output / "search-pairs.jsonl", b"".join(encoded(row) for row in summarized["pairs"]))
    if implementation_receipt(config_path) != implementation or sha(native.read_bytes()) != sha(runtime_bytes):
        raise ValueError("retained implementation changed during measurement")
    for name, path in model_paths.items():
        if sha(path.read_bytes()) != sha(retained_models[name]):
            raise ValueError("retained model changed during measurement")
    report = {"schema": "chessy.sparse-runtime-results.v1", "status": "complete-research-only", "researchOnly": True,
              "plan": plan, "parity": parities, "static": static, "search": summarized["summary"],
              "observations": observations_id, "pairs": pairs_id, "rawFiles": raw_files,
              "searchObservationCount": len(observations), "searchPairCount": len(summarized["pairs"]),
              "modelSelectionByTiming": False, "noHoldoutRoleFilesRead": True,
              "limitations": ["native desktop development measurements, not WASM/browser/phone evidence",
                              "search trees can differ; NPS is not pure evaluation speed",
                              "early-terminating searches retain actual node counts and are separately counted",
                              "two deterministic timing replicates are not independent games or Elo evidence"]}
    write(output / "results.json", encoded(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packed_manifest", type=Path)
    parser.add_argument("fit_results", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--config", type=Path, default=ROOT / "eval/sparse-pesto-v1/RUNTIME-CONFIG.json")
    a = parser.parse_args()
    result = measure(a.packed_manifest, a.fit_results, a.runtime, a.output, a.config)
    print(json.dumps({"complete": result["schema"], "observations": result["searchObservationCount"]}))


if __name__ == "__main__":
    main()
