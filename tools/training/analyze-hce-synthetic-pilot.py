#!/usr/bin/env python3
"""Fit bounded HCE surfaces to the research-only real-Stockfish pilot.

The input positions are legal deterministic continuations of Chessy's checked-
in MIT/CC0 corpus, not the authenticated production selection.  Consequently
this program emits compact comparative metrics and weight-delta hashes only;
it cannot emit a production candidate, touch the runtime evaluator, or support
a release-strength claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import numpy as np
import scipy
from scipy import optimize, sparse


SCHEMA = "chessy.hce-synthetic-pilot-analysis.v1"
ROW_SCHEMA = "chessy.hce-synthetic-pilot-row.v1"
SUMMARY_SCHEMA = "chessy.hce-synthetic-pilot-label-summary.v1"
STATUS = "research-only-synthetic-positions-real-teacher"
PARAMETERS = 965
BASELINE_PARAMETERS = 753
PHASES = ("opening", "middlegame", "endgame")
SPLITS = ("train", "validation", "test")
HEX = frozenset("0123456789abcdef")
EXPECTED_SOURCE_ARCHIVE_SHA256 = (
    "2deeca8664333eb98103fcb2019b898879255cba7e1a9f8940e7c09a8aad2038"
)
EXPECTED_EXECUTABLE_SHA256 = (
    "ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319"
)
EXPECTED_NETWORK_SHA256 = {
    "EvalFile": "c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7",
    "EvalFileSmall": "37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d",
}


@dataclass(frozen=True)
class Dataset:
    matrix: sparse.csr_matrix
    fixed_cp: np.ndarray
    target: np.ndarray
    teacher_cp: np.ndarray
    phase: np.ndarray
    family: np.ndarray
    row_id: np.ndarray

    @property
    def rows(self) -> int:
        return int(self.matrix.shape[0])


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json_ints(values: np.ndarray) -> str:
    payload = json.dumps(
        [int(value) for value in values], separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def require_hash(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(char not in HEX for char in value)
    ):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")
    return value


def strict_json(line: bytes, label: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"{label}: duplicate JSON member {key}")
            result[key] = value
        return result

    try:
        return json.loads(
            line.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_constant=lambda item: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON value {item}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}: invalid JSON: {error}") from error


def load_metadata(root: Path) -> dict[str, Any]:
    generator = root / "tools/training/hce-synthetic-pilot-data.js"
    result = subprocess.run(
        ["node", str(generator), "--metadata"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    metadata = strict_json(result.stdout, "generator metadata")
    if (
        not isinstance(metadata, dict)
        or metadata.get("parameters") != PARAMETERS
        or metadata.get("baselineParameters") != BASELINE_PARAMETERS
        or metadata.get("qualityClaimAllowed") is not False
    ):
        raise ValueError("generator metadata contract differs")
    if len(metadata.get("center", [])) != PARAMETERS or len(
        metadata.get("scales", [])
    ) != PARAMETERS:
        raise ValueError("generator center/scales dimensions differ")
    return metadata


def load_summary(filename: Path, stream_filename: Path) -> dict[str, Any]:
    summary_bytes = filename.read_bytes()
    summary = strict_json(summary_bytes, str(filename))
    if (
        not isinstance(summary, dict)
        or summary.get("schema") != SUMMARY_SCHEMA
        or summary.get("status") != STATUS
        or summary.get("fitAllowed") is not False
        or summary.get("publishableArtifact") is not False
    ):
        raise ValueError("label summary is not the research-only pilot contract")
    expected = require_hash(
        summary.get("provenance", {}).get("labelledStreamSha256"),
        "labelled stream SHA-256",
    )
    if sha256_file(stream_filename) != expected:
        raise ValueError("labelled stream SHA-256 differs from its summary")
    networks = summary.get("teacher", {}).get("networks", {})
    if not all(
        isinstance(networks.get(name), dict)
        and networks[name].get("verified") is True
        and isinstance(networks[name].get("bytes"), int)
        and networks[name]["bytes"] > 0
        for name in ("EvalFile", "EvalFileSmall")
    ):
        raise ValueError("main pilot did not verify both embedded teacher networks")
    teacher = summary["teacher"]
    generator = summary.get("generator", {})
    expected_uci = {
        "Threads": 1,
        "Hash": 16,
        "Ponder": False,
        "MultiPV": 1,
        "SyzygyPath": "<empty>",
        "UCI_LimitStrength": False,
        "UCI_ShowWDL": True,
        "ClearHashBeforeEveryPosition": True,
        "UciNewGameBeforeEveryPosition": True,
        "IsReadyBeforeEveryPosition": True,
    }
    if (
        generator.get("rows") != 12000
        or generator.get("seed") != 1370914
        or generator.get("familyCap") != 4
        or teacher.get("name") != "Stockfish 18"
        or teacher.get("release") != "sf_18"
        or teacher.get("executableSha256") != EXPECTED_EXECUTABLE_SHA256
        or teacher.get("uci") != expected_uci
        or teacher.get("search")
        != {"command": "go nodes 25000", "nodeLimit": 25000}
    ):
        raise ValueError("label summary differs from the fixed pilot profile")
    for name, expected_hash in EXPECTED_NETWORK_SHA256.items():
        if networks[name].get("sha256") != expected_hash:
            raise ValueError(f"{name} SHA-256 differs from the fixed pilot")
    identity = teacher.get("identityLines")
    if (
        not isinstance(identity, list)
        or "id name Stockfish 18" not in identity
        or not any("option name EvalFile type" in line for line in identity)
        or not any("option name EvalFileSmall type" in line for line in identity)
    ):
        raise ValueError("Stockfish identity/embedded-network option lines are missing")
    output = summary.get("output", {})
    reasons = output.get("exclusionReasons")
    if (
        not isinstance(output.get("labelledRows"), int)
        or not isinstance(output.get("excludedRows"), int)
        or not isinstance(reasons, dict)
        or any(not isinstance(value, int) or value < 0 for value in reasons.values())
        or output["labelledRows"] + output["excludedRows"] != generator["rows"]
        or sum(reasons.values()) != output["excludedRows"]
    ):
        raise ValueError("label summary output accounting differs")
    provenance = summary.get("provenance", {})
    for name in (
        "generatedInputSha256",
        "labelledStreamSha256",
        "generatorScriptSha256",
        "labelerScriptSha256",
    ):
        require_hash(provenance.get(name), f"label summary {name}")
    source = provenance.get("sourceCorpus")
    if (
        not isinstance(source, dict)
        or source.get("path") != "eval/corpus/eval-v1.ndjson"
    ):
        raise ValueError("label summary source-corpus binding differs")
    require_hash(source.get("sha256"), "label summary source corpus SHA-256")
    return summary


def validate_row(value: object, number: int) -> dict[str, Any]:
    expected_fields = {
        "schema",
        "id",
        "fen",
        "cluster",
        "positionFamily",
        "split",
        "phase",
        "fixedCp",
        "indices",
        "data",
        "sourceSeed",
        "teacher",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected_fields
        or value.get("schema") != ROW_SCHEMA
    ):
        raise ValueError(f"row {number}: wrong schema")
    for name in ("id", "cluster", "positionFamily"):
        require_hash(value.get(name), f"row {number} {name}")
    if value.get("split") not in SPLITS or value.get("phase") not in PHASES:
        raise ValueError(f"row {number}: invalid split or phase")
    fen = value.get("fen")
    if not isinstance(fen, str) or len(fen.split()) != 4:
        raise ValueError(f"row {number}: FEN must contain four fields")
    fixed_cp = value.get("fixedCp")
    if isinstance(fixed_cp, bool) or not isinstance(fixed_cp, (int, float)) or not math.isfinite(fixed_cp):
        raise ValueError(f"row {number}: fixedCp must be finite")
    indices = value.get("indices")
    data = value.get("data")
    if not isinstance(indices, list) or not isinstance(data, list) or len(indices) != len(data):
        raise ValueError(f"row {number}: sparse vector dimensions differ")
    if any(
        isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= PARAMETERS
        for index in indices
    ) or any(indices[index] >= indices[index + 1] for index in range(len(indices) - 1)):
        raise ValueError(f"row {number}: sparse indices are invalid")
    if any(
        isinstance(item, bool)
        or not isinstance(item, (int, float))
        or not math.isfinite(item)
        or item == 0
        for item in data
    ):
        raise ValueError(f"row {number}: sparse data are invalid")
    teacher = value.get("teacher")
    expected_teacher_fields = {
        "cpWhite",
        "wdlWhite",
        "targetWhite",
        "bestMoveUci",
        "pvUci",
        "depth",
        "seldepth",
        "scoreNodes",
        "reportedNodes",
    }
    if not isinstance(teacher, dict) or set(teacher) != expected_teacher_fields:
        raise ValueError(f"row {number}: teacher is missing")
    cp = teacher.get("cpWhite")
    target = teacher.get("targetWhite")
    wdl = teacher.get("wdlWhite")
    if (
        isinstance(cp, bool)
        or not isinstance(cp, int)
        or isinstance(target, bool)
        or not isinstance(target, (int, float))
        or not math.isfinite(target)
        or target < 0
        or target > 1
        or not isinstance(wdl, list)
        or len(wdl) != 3
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in wdl)
        or sum(wdl) != 1000
        or target != (wdl[0] + 0.5 * wdl[1]) / 1000
    ):
        raise ValueError(f"row {number}: teacher CP/WDL target is invalid")
    if (
        not isinstance(teacher["depth"], int)
        or teacher["depth"] <= 0
        or not isinstance(teacher["seldepth"], int)
        or teacher["seldepth"] < teacher["depth"]
        or not isinstance(teacher["scoreNodes"], int)
        or teacher["scoreNodes"] <= 0
        or not isinstance(teacher["reportedNodes"], int)
        or teacher["reportedNodes"] < 25000
        or teacher["scoreNodes"] > teacher["reportedNodes"]
        or not isinstance(teacher["bestMoveUci"], str)
        or not isinstance(teacher["pvUci"], list)
        or not teacher["pvUci"]
        or teacher["pvUci"][0] != teacher["bestMoveUci"]
        or any(not isinstance(move, str) or not move for move in teacher["pvUci"])
    ):
        raise ValueError(f"row {number}: teacher search evidence is invalid")
    source = value.get("sourceSeed")
    if not isinstance(source, dict) or set(source) != {
        "id",
        "license",
        "sourceSha256",
    }:
        raise ValueError(f"row {number}: source seed binding differs")
    if not isinstance(source["id"], str) or not source["id"]:
        raise ValueError(f"row {number}: source seed ID is missing")
    if source["license"] not in ("MIT", "CC0-1.0"):
        raise ValueError(f"row {number}: source seed license is not allowed")
    require_hash(source["sourceSha256"], f"row {number} source seed SHA-256")
    return value


def phase_from_fen(fen: str) -> str:
    board = fen.split()[0]
    phase = sum({"n": 1, "b": 1, "r": 2, "q": 4}.get(piece.lower(), 0) for piece in board)
    phase = min(phase, 24)
    if phase >= 18:
        return "opening"
    if phase >= 7:
        return "middlegame"
    return "endgame"


def split_from_family(family: str) -> str:
    cell = int(family[:12], 16) % 20
    if cell < 14:
        return "train"
    if cell < 17:
        return "validation"
    return "test"


def load_rows(filename: Path, summary: dict[str, Any]) -> tuple[dict[str, Dataset], dict[str, Any]]:
    records: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    seen_rows: set[str] = set()
    seen_clusters: set[str] = set()
    family_split: dict[str, str] = {}
    family_counts: dict[str, int] = {}
    seed_counts: dict[str, int] = {}
    seed_splits: dict[str, set[str]] = {}
    observed_counts = {
        split: {phase: 0 for phase in PHASES} for split in SPLITS
    }
    out_of_range = {split: 0 for split in SPLITS}
    source_licenses: dict[str, int] = {}
    with filename.open("rb") as stream:
        for number, line in enumerate(stream, 1):
            value = validate_row(strict_json(line, f"{filename}:{number}"), number)
            row_id = value["id"]
            cluster = value["cluster"]
            family = value["positionFamily"]
            split = value["split"]
            if row_id in seen_rows or cluster in seen_clusters:
                raise ValueError(f"row {number}: duplicate row or model cluster")
            seen_rows.add(row_id)
            seen_clusters.add(cluster)
            prior = family_split.setdefault(family, split)
            if prior != split:
                raise ValueError(f"row {number}: position family crosses splits")
            family_counts[family] = family_counts.get(family, 0) + 1
            if family_counts[family] > summary["generator"]["familyCap"]:
                raise ValueError(f"row {number}: position family exceeds its cap")
            if split_from_family(family) != split:
                raise ValueError(f"row {number}: position family hashes to another split")
            if phase_from_fen(value["fen"]) != value["phase"]:
                raise ValueError(f"row {number}: phase differs from FEN material")
            observed_counts[split][value["phase"]] += 1
            source_id = value["sourceSeed"]["id"]
            seed_counts[source_id] = seed_counts.get(source_id, 0) + 1
            seed_splits.setdefault(source_id, set()).add(split)
            license_name = value.get("sourceSeed", {}).get("license")
            if not isinstance(license_name, str) or not license_name:
                raise ValueError(f"row {number}: source seed license is missing")
            source_licenses[license_name] = source_licenses.get(license_name, 0) + 1
            if abs(value["teacher"]["cpWhite"]) > 2000:
                out_of_range[split] += 1
                continue
            records[split].append(value)
    if len(seen_rows) != summary["output"]["labelledRows"]:
        raise ValueError("label summary row count differs")
    if observed_counts != summary["output"]["labelledCounts"]:
        raise ValueError("label summary split/phase counts differ")

    datasets: dict[str, Dataset] = {}
    for split, rows in records.items():
        indptr = [0]
        indices: list[int] = []
        values: list[float] = []
        for row in rows:
            indices.extend(row["indices"])
            values.extend(row["data"])
            indptr.append(len(indices))
        matrix = sparse.csr_matrix(
            (
                np.asarray(values, dtype=np.float64),
                np.asarray(indices, dtype=np.int32),
                np.asarray(indptr, dtype=np.int64),
            ),
            shape=(len(rows), PARAMETERS),
        )
        datasets[split] = Dataset(
            matrix=matrix,
            fixed_cp=np.asarray([row["fixedCp"] for row in rows], dtype=np.float64),
            target=np.asarray([row["teacher"]["targetWhite"] for row in rows], dtype=np.float64),
            teacher_cp=np.asarray([row["teacher"]["cpWhite"] for row in rows], dtype=np.float64),
            phase=np.asarray([row["phase"] for row in rows]),
            family=np.asarray([row["positionFamily"] for row in rows]),
            row_id=np.asarray([row["id"] for row in rows]),
        )
    inventory = {
        "teacherEligibleRows": len(seen_rows),
        "fitEligibleRows": sum(dataset.rows for dataset in datasets.values()),
        "excludedAbsCpAbove2000": out_of_range,
        "fitRows": {split: datasets[split].rows for split in SPLITS},
        "sourceSeedLicenses": source_licenses,
        "uniqueModelClusters": len(seen_clusters),
        "uniquePositionFamilies": len(family_split),
        "positionFamiliesCrossSplits": 0,
        "uniqueSourceSeeds": len(seed_counts),
        "sourceSeedsCrossSplits": sum(len(splits) > 1 for splits in seed_splits.values()),
        "maxRowsPerSourceSeed": max(seed_counts.values()),
    }
    if datasets["train"].rows < 7000 or sum(item.rows for item in datasets.values()) < 10000:
        raise ValueError("pilot retained too few rows for the preregistered mechanism screen")
    return datasets, inventory


def sigmoid(logits: np.ndarray) -> np.ndarray:
    return np.exp(-np.logaddexp(0.0, -logits))


def row_losses(cp: np.ndarray, target: np.ndarray, k: float) -> np.ndarray:
    logits = k * cp / 400.0
    return np.logaddexp(0.0, logits) - target * logits


def calibration_k(dataset: Dataset, center: np.ndarray) -> dict[str, Any]:
    cp = dataset.fixed_cp + dataset.matrix @ center

    def objective(point: np.ndarray) -> tuple[float, np.ndarray]:
        value = float(point[0])
        logits = value * cp / 400.0
        residual = sigmoid(logits) - dataset.target
        loss = float(np.mean(np.logaddexp(0.0, logits) - dataset.target * logits))
        gradient = np.asarray([np.mean(residual * cp / 400.0)], dtype=np.float64)
        return loss, gradient

    result = optimize.minimize(
        objective,
        np.asarray([1.0]),
        jac=True,
        method="L-BFGS-B",
        bounds=[(0.05, 4.0)],
        options={"maxiter": 100, "gtol": 1e-12, "ftol": 1e-15},
    )
    if not result.success:
        raise RuntimeError("baseline calibration failed: " + str(result.message))
    return {"value": float(result.x[0]), "trainLoss": float(result.fun), "iterations": int(result.nit)}


def full_bounds(center: np.ndarray) -> list[tuple[float, float]]:
    bounds: list[tuple[float, float]] = [(-256.0, 256.0)] * PARAMETERS
    for index in range(4):
        bounds[index] = (0.0, 16.0)
    bounds[4] = bounds[5] = (0.0, 64.0)
    bounds[6] = (0.0, 32.0)
    # Disjoint intervals conservatively guarantee monotone passed-pawn ladders
    # while retaining the shipped vector as a feasible point.
    for index, pair in enumerate(
        ((0, 10), (10, 20), (20, 35), (35, 60), (60, 240)), start=7
    ):
        bounds[index] = pair
    for index, pair in enumerate(
        ((0, 30), (30, 50), (50, 80), (80, 130), (130, 300)), start=12
    ):
        bounds[index] = pair
    for index in range(753, 759):
        bounds[index] = (0.0, 96.0)
    for index in range(759, 767):
        bounds[index] = (0.0, 24.0)
    for index in range(767, 773):
        bounds[index] = (0.0, 48.0)
    for index in range(773, 965):
        bounds[index] = (-96.0, 96.0)
    if any(not low <= center[index] <= high for index, (low, high) in enumerate(bounds)):
        raise ValueError("shipped center lies outside pilot bounds")
    return bounds


def surfaces() -> dict[str, np.ndarray]:
    baseline = np.arange(0, 753, dtype=np.int32)
    direct = np.arange(753, 759, dtype=np.int32)
    bucket = np.arange(773, 965, dtype=np.int32)
    return {
        "baseline-retune": baseline,
        "baseline-plus-pawn-attacks": np.concatenate((baseline, direct)),
        "baseline-plus-king-bucket-pawn-pst": np.concatenate((baseline, bucket)),
        "cheap-r3-combined": np.concatenate((baseline, direct, bucket)),
        "full-r3": np.arange(0, 965, dtype=np.int32),
    }


def fit_surface(
    name: str,
    active: np.ndarray,
    datasets: dict[str, Dataset],
    center: np.ndarray,
    scales: np.ndarray,
    k: float,
    regularization: float,
    bounds: list[tuple[float, float]],
) -> dict[str, Any]:
    train = datasets["train"]
    active_matrix = train.matrix[:, active].tocsr()
    active_center = center[active].copy()
    active_scales = scales[active]
    base_cp = train.fixed_cp + train.matrix @ center
    factor = k / 400.0

    def objective(weights: np.ndarray) -> tuple[float, np.ndarray]:
        cp = base_cp + active_matrix @ (weights - active_center)
        logits = factor * cp
        probability = sigmoid(logits)
        data_loss = float(np.mean(np.logaddexp(0.0, logits) - train.target * logits))
        residual = probability - train.target
        gradient = factor * np.asarray(active_matrix.T @ residual / train.rows).reshape(-1)
        delta = (weights - active_center) / active_scales
        penalty = 0.5 * regularization * float(np.sum(delta * delta) / PARAMETERS)
        gradient += regularization * (weights - active_center) / (
            PARAMETERS * active_scales * active_scales
        )
        return data_loss + penalty, gradient

    result = optimize.minimize(
        objective,
        active_center,
        jac=True,
        method="L-BFGS-B",
        bounds=[bounds[index] for index in active],
        options={"maxiter": 350, "gtol": 1e-8, "ftol": 1e-12, "maxls": 40},
    )
    weights = center.copy()
    weights[active] = result.x
    return {
        "surface": name,
        "lambda": regularization,
        "success": bool(result.success),
        "message": str(result.message),
        "iterations": int(result.nit),
        "objective": float(result.fun),
        "gradientInfNorm": float(np.max(np.abs(result.jac))),
        "weights": weights,
    }


def predictions(dataset: Dataset, weights: np.ndarray) -> np.ndarray:
    return dataset.fixed_cp + dataset.matrix @ weights


def metrics(dataset: Dataset, weights: np.ndarray, k: float) -> dict[str, Any]:
    cp = predictions(dataset, weights)
    losses = row_losses(cp, dataset.target, k)
    residual = cp - dataset.teacher_cp
    by_phase: dict[str, Any] = {}
    for phase in PHASES:
        mask = dataset.phase == phase
        by_phase[phase] = {
            "rows": int(np.sum(mask)),
            "crossEntropy": float(np.mean(losses[mask])),
            "teacherCpRmse": float(np.sqrt(np.mean(residual[mask] ** 2))),
        }
    return {
        "rows": dataset.rows,
        "crossEntropy": float(np.mean(losses)),
        "teacherCpRmse": float(np.sqrt(np.mean(residual * residual))),
        "teacherCpMae": float(np.mean(np.abs(residual))),
        "byPhase": by_phase,
    }


def feature_coverage(dataset: Dataset) -> dict[str, Any]:
    nonzero_rows = np.asarray(dataset.matrix.getnnz(axis=0)).reshape(-1)
    groups = {
        "baselineAux": (0, 17),
        "baselinePst": (17, 753),
        "pawnAttacks": (753, 759),
        "safeMobility": (759, 767),
        "advancedPawnCramp": (767, 773),
        "kingBucketPawnPst": (773, 965),
    }
    output: dict[str, Any] = {}
    for name, (first, last) in groups.items():
        values = nonzero_rows[first:last]
        output[name] = {
            "parameters": last - first,
            "zeroColumns": int(np.sum(values == 0)),
            "nonzeroRowsMin": int(np.min(values)),
            "nonzeroRowsMedian": float(np.median(values)),
            "nonzeroRowsMax": int(np.max(values)),
        }
        if last - first <= 20:
            output[name]["nonzeroRowsByParameter"] = [
                int(value) for value in values
            ]
    return output


def paired_family_bootstrap(
    dataset: Dataset,
    baseline: np.ndarray,
    candidate: np.ndarray,
    k: float,
    seed: int,
    iterations: int = 2000,
) -> dict[str, Any]:
    difference = row_losses(candidate, dataset.target, k) - row_losses(
        baseline, dataset.target, k
    )
    families, inverse = np.unique(dataset.family, return_inverse=True)
    sums = np.bincount(inverse, weights=difference)
    counts = np.bincount(inverse)
    family_means = sums / counts
    rng = np.random.default_rng(seed)
    draws = np.empty(iterations, dtype=np.float64)
    chunk = 200
    for start in range(0, iterations, chunk):
        count = min(chunk, iterations - start)
        indices = rng.integers(0, len(families), size=(count, len(families)))
        draws[start : start + count] = np.mean(family_means[indices], axis=1)
    return {
        "unit": "position-family mean",
        "families": int(len(families)),
        "iterations": iterations,
        "seed": seed,
        "candidateMinusBaselineMean": float(np.mean(family_means)),
        "ci95": [float(value) for value in np.quantile(draws, [0.025, 0.975])],
    }


def weight_summary(weights: np.ndarray, center: np.ndarray, names: list[str]) -> dict[str, Any]:
    rounded = np.rint(weights).astype(np.int64)
    shipped = np.rint(center).astype(np.int64)
    delta = rounded - shipped

    def group(first: int, last: int) -> dict[str, Any]:
        values = delta[first:last]
        fitted = rounded[first:last]
        return {
            "parameters": last - first,
            "changed": int(np.count_nonzero(values)),
            "deltaL1": int(np.sum(np.abs(values))),
            "deltaLInf": int(np.max(np.abs(values))) if len(values) else 0,
            "fittedMin": int(np.min(fitted)) if len(fitted) else 0,
            "fittedMax": int(np.max(fitted)) if len(fitted) else 0,
        }

    return {
        "roundedVectorSha256": sha256_json_ints(rounded),
        "candidateEmitted": False,
        "changedParameters": int(np.count_nonzero(delta)),
        "deltaL1": int(np.sum(np.abs(delta))),
        "deltaLInf": int(np.max(np.abs(delta))),
        "groups": {
            "baselineAux": group(0, 17),
            "baselinePst": group(17, 753),
            "pawnAttacks": group(753, 759),
            "safeMobility": group(759, 767),
            "advancedPawnCramp": group(767, 773),
            "kingBucketPawnPst": group(773, 965),
        },
        "smallFamilies": {
            names[index]: int(rounded[index])
            for index in list(range(0, 17)) + list(range(753, 773))
        },
    }


def compact_fit_result(
    fit: dict[str, Any],
    datasets: dict[str, Dataset],
    center: np.ndarray,
    names: list[str],
    k: float,
    bounds: list[tuple[float, float]],
    active: np.ndarray,
) -> dict[str, Any]:
    weights = fit["weights"]
    rounded = np.rint(weights)
    active_bounds = sum(
        math.isclose(weights[index], pair[0], abs_tol=1e-7)
        or math.isclose(weights[index], pair[1], abs_tol=1e-7)
        for index in active
        for pair in (bounds[int(index)],)
        if not math.isclose(pair[0], pair[1])
    )
    return {
        key: value for key, value in fit.items() if key != "weights"
    } | {
        "float": {
            split: metrics(datasets[split], weights, k) for split in SPLITS
        },
        "rounded": {
            split: metrics(datasets[split], rounded, k) for split in SPLITS
        },
        "weights": weight_summary(weights, center, names),
        "activeParameters": int(len(active)),
        "parametersAtConstraintBoundary": int(active_bounds),
    }


def analyze(
    input_path: Path,
    label_summary_path: Path,
    output_path: Path,
    source_archive_sha256: str,
) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2]
    if output_path.exists():
        raise FileExistsError("refusing to overwrite --output")
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise ValueError(
            "pilot requires NumPy 2.3.5 and SciPy 1.17.0; got "
            f"{np.__version__} and {scipy.__version__}"
        )
    if source_archive_sha256 != EXPECTED_SOURCE_ARCHIVE_SHA256:
        raise ValueError("Stockfish source archive differs from the fixed pilot")
    summary = load_summary(label_summary_path, input_path)
    metadata = load_metadata(root)
    if metadata["corpus"]["sha256"] != summary["provenance"]["sourceCorpus"]["sha256"]:
        raise ValueError("source-corpus SHA-256 differs between generator and labeler")
    datasets, inventory = load_rows(input_path, summary)
    center = np.asarray(metadata["center"], dtype=np.float64)
    scales = np.asarray(metadata["scales"], dtype=np.float64)
    names = list(metadata["parameterNames"])
    k_fit = calibration_k(datasets["train"], center)
    k = float(k_fit["value"])
    bounds = full_bounds(center)
    lambda_grid = [0.02, 0.05, 0.1, 0.2, 0.5, 1.0]
    baseline_predictions = {
        split: predictions(datasets[split], center) for split in SPLITS
    }
    baseline = {
        split: metrics(datasets[split], center, k) for split in SPLITS
    }
    fitted_surfaces: list[dict[str, Any]] = []
    selected_weights: dict[str, np.ndarray] = {}
    for surface_name, active in surfaces().items():
        attempts = []
        for regularization in lambda_grid:
            attempt = fit_surface(
                surface_name,
                active,
                datasets,
                center,
                scales,
                k,
                regularization,
                bounds,
            )
            attempt["validationLoss"] = metrics(
                datasets["validation"], attempt["weights"], k
            )["crossEntropy"]
            attempts.append(attempt)
        eligible = [attempt for attempt in attempts if attempt["success"]]
        if not eligible:
            raise RuntimeError(f"all convex fits failed for {surface_name}")
        selected = min(eligible, key=lambda item: (item["validationLoss"], item["lambda"]))
        selected_weights[surface_name] = selected["weights"]
        compact = compact_fit_result(
            selected, datasets, center, names, k, bounds, active
        )
        compact["lambdaDiagnostics"] = [
            {
                key: value
                for key, value in attempt.items()
                if key not in ("weights",)
            }
            for attempt in attempts
        ]
        compact["pairedFamilyBootstrapVsFrozen"] = {
            split: paired_family_bootstrap(
                datasets[split],
                baseline_predictions[split],
                predictions(datasets[split], selected["weights"]),
                k,
                13700 + index * 100 + list(surfaces()).index(surface_name),
            )
            for index, split in enumerate(("validation", "test"))
        }
        fitted_surfaces.append(compact)

    cheap = selected_weights["cheap-r3-combined"]
    cheap_ablations = {}
    for name, first, last in (
        ("zero-pawn-attacks", 753, 759),
        ("zero-king-bucket-pawn-pst", 773, 965),
    ):
        ablated = cheap.copy()
        ablated[first:last] = center[first:last]
        cheap_ablations[name] = {
            split: metrics(datasets[split], ablated, k) for split in ("validation", "test")
        }

    pairwise_surface_bootstrap = {}
    for comparison_index, (comparison, baseline_name, candidate_name) in enumerate((
        ("pawn-attacks-minus-baseline-retune", "baseline-retune", "baseline-plus-pawn-attacks"),
        (
            "king-bucket-minus-baseline-retune",
            "baseline-retune",
            "baseline-plus-king-bucket-pawn-pst",
        ),
        ("cheap-combined-minus-pawn-attacks", "baseline-plus-pawn-attacks", "cheap-r3-combined"),
        ("full-r3-minus-cheap-combined", "cheap-r3-combined", "full-r3"),
    )):
        pairwise_surface_bootstrap[comparison] = {
            split: paired_family_bootstrap(
                datasets[split],
                predictions(datasets[split], selected_weights[baseline_name]),
                predictions(datasets[split], selected_weights[candidate_name]),
                k,
                24680 + comparison_index * 100 + split_index,
            )
            for split_index, split in enumerate(("validation", "test"))
        }

    best = min(
        fitted_surfaces,
        key=lambda item: item["float"]["validation"]["crossEntropy"],
    )
    coverage = feature_coverage(datasets["train"])
    surface_by_name = {item["surface"]: item for item in fitted_surfaces}
    full_weights = selected_weights["full-r3"]
    rounded_full = np.rint(full_weights).astype(np.int64)
    zeroed_mobility = [
        names[index]
        for index in range(4)
        if rounded_full[index] == 0 and center[index] != 0
    ]
    saturated_attacks = [
        names[index]
        for index in range(753, 759)
        if math.isclose(full_weights[index], bounds[index][1], abs_tol=1e-6)
    ]
    full_metrics = surface_by_name["full-r3"]["float"]
    cheap_metrics = surface_by_name["cheap-r3-combined"]["float"]
    pathology_stop_signals = {
        "allSurfacesSelectedLowestLambda": all(
            item["lambda"] == min(lambda_grid) for item in fitted_surfaces
        ),
        "fullR3ZeroedShippedMobilityWeights": zeroed_mobility,
        "fullR3PawnAttackWeightsAtUpperBound": saturated_attacks,
        "fullR3ChangedBaselinePstParameters": surface_by_name["full-r3"][
            "weights"
        ]["groups"]["baselinePst"]["changed"],
        "fullR3TestCpRmseMinusFrozen": (
            full_metrics["test"]["teacherCpRmse"]
            - baseline["test"]["teacherCpRmse"]
        ),
        "fullR3ValidationCeMinusCheapCombined": (
            full_metrics["validation"]["crossEntropy"]
            - cheap_metrics["validation"]["crossEntropy"]
        ),
        "fullR3TestCeMinusCheapCombined": (
            full_metrics["test"]["crossEntropy"]
            - cheap_metrics["test"]["crossEntropy"]
        ),
        "kingBucketColumnsUnseenInTrain": coverage["kingBucketPawnPst"][
            "zeroColumns"
        ],
        "sourceSeedsCrossSplits": inventory["sourceSeedsCrossSplits"],
        "decision": "stop-no-runtime-candidate",
        "reason": (
            "The random-continuation distribution induces boundary saturation "
            "and implausible removal of established terms; a quieter natural-game "
            "teacher corpus is required before any runtime candidate."
        ),
    }
    implementation_paths = [
        Path(__file__).resolve(),
        root / "tools/training/hce-synthetic-pilot-data.js",
        root / "tools/training/hce-synthetic-pilot-label.js",
        root / "test/training/hce-r3-linear.js",
        root / "test/training/hce-r3-features.js",
        root / "test/training/hce-r3-baseline.js",
        root / "eval/training/hce-r3-features-v1.json",
        root / "eval/training/hce-r3-fit-v1.json",
        root / "experiments/wasm/src/eval.rs",
    ]
    report = {
        "schemaVersion": 1,
        "schema": SCHEMA,
        "status": STATUS,
        "fitAllowed": False,
        "publishableArtifact": False,
        "candidateProduced": False,
        "weightsEmitted": False,
        "runtimeFilesChanged": False,
        "qualityClaimAllowed": False,
        "strengthClaimAllowed": False,
        "teacherTransferEvidence": True,
        "scope": (
            "Exploratory comparison on deterministic engine-legal continuations of "
            "the checked-in MIT/CC0 corpus, labelled by Stockfish 18."
        ),
        "inventory": inventory,
        "trainFeatureCoverage": coverage,
        "teacher": summary["teacher"] | {
            "sourceArchiveSha256": source_archive_sha256,
            "sourceTag": "sf_18",
            "sourceCommit": "cb3d4ee9b47d0c5aae855b12379378ea1439675c",
        },
        "labelRun": summary["output"],
        "calibration": k_fit,
        "constraints": {
            "kind": "convex box-constrained logistic cross-entropy plus L2",
            "mobilityNonnegative": True,
            "pawnPenaltiesNonnegativeBecauseFeatureSignEncodesPenalty": True,
            "passedPawnLaddersMonotoneByDisjointIntervals": True,
            "pstBoundsCp": [-256, 256],
            "newInteractionBoundsDocumentedInImplementation": True,
        },
        "lambdaGrid": lambda_grid,
        "frozenBaseline": baseline,
        "surfaces": fitted_surfaces,
        "cheapR3CombinedAblations": cheap_ablations,
        "pairedSurfaceBootstrap": pairwise_surface_bootstrap,
        "pathologyStopSignals": pathology_stop_signals,
        "numericallyBestValidationSurfaceNoCandidateSelection": {
            "surface": best["surface"],
            "lambda": best["lambda"],
            "validationCrossEntropy": best["float"]["validation"]["crossEntropy"],
            "testCrossEntropy": best["float"]["test"]["crossEntropy"],
        },
        "tinyNnScreen": {
            "status": "not-run",
            "reason": (
                "The HCE fit already exposes severe random-position distribution "
                "bias. A separate nonconvex H4/H8 implementation would measure "
                "that bias more efficiently, not establish a useful runtime model; "
                "wait for quieter natural-game, family-isolated teacher data."
            ),
        },
        "provenance": {
            "labelSummarySha256": sha256_file(label_summary_path),
            "labelledStreamSha256": sha256_file(input_path),
            "generatedInputSha256": summary["provenance"]["generatedInputSha256"],
            "labelRunImplementationSha256": {
                "generator": summary["provenance"]["generatorScriptSha256"],
                "labeler": summary["provenance"]["labelerScriptSha256"],
            },
            "sourceCorpus": metadata["corpus"],
            "implementationSha256": {
                str(path.relative_to(root)): sha256_file(path)
                for path in implementation_paths
            },
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "threads": 1,
        },
        "limitations": [
            "The positions are generated engine-legal continuations, not the frozen official Lichess selection.",
            "The 25,000-node exploratory labels are shallower than the frozen 100,000-node production teacher contract.",
            "Position families are isolated across splits, but source-game lineage is unavailable for generated continuations.",
            "The locked incident and final E4-v2 match manifest were not opened or used.",
            "Validation/test loss can screen feature surfaces; it cannot certify playing strength, Elo, device speed, or runtime size.",
            "No fitted vector in this report is a shipping candidate; only hashes and compact deltas are retained.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n"
    with output_path.open("x", encoding="utf-8") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    return report


def self_test() -> None:
    root = Path(__file__).resolve().parents[2]
    metadata = load_metadata(root)
    center = np.asarray(metadata["center"], dtype=np.float64)
    scales = np.asarray(metadata["scales"], dtype=np.float64)
    bounds = full_bounds(center)
    if not all(
        bounds[index][1] <= bounds[index + 1][0]
        for first in (7, 12)
        for index in range(first, first + 4)
    ):
        raise AssertionError("passed-pawn intervals do not imply monotonicity")

    rng = np.random.default_rng(137105)
    truth = center.copy()
    truth[:4] = np.asarray([8.0, 7.0, 5.0, 3.0])

    def synthetic(rows: int, serial: int) -> Dataset:
        dense = np.zeros((rows, PARAMETERS), dtype=np.float64)
        dense[:, :4] = rng.integers(-20, 21, size=(rows, 4))
        matrix = sparse.csr_matrix(dense)
        teacher_cp = np.asarray(matrix @ truth).reshape(-1)
        target = sigmoid(1.3 * teacher_cp / 400.0)
        return Dataset(
            matrix=matrix,
            fixed_cp=np.zeros(rows, dtype=np.float64),
            target=target,
            teacher_cp=teacher_cp,
            phase=np.asarray([PHASES[index % 3] for index in range(rows)]),
            family=np.asarray(
                [f"family-{serial}-{index // 2}" for index in range(rows)]
            ),
            row_id=np.asarray([f"row-{serial}-{index}" for index in range(rows)]),
        )

    datasets = {
        "train": synthetic(600, 0),
        "validation": synthetic(240, 1),
        "test": synthetic(240, 2),
    }
    before = metrics(datasets["validation"], center, 1.3)["crossEntropy"]
    fitted = fit_surface(
        "self-test",
        np.arange(0, 4, dtype=np.int32),
        datasets,
        center,
        scales,
        1.3,
        0.02,
        bounds,
    )
    after = metrics(
        datasets["validation"], fitted["weights"], 1.3
    )["crossEntropy"]
    if not fitted["success"] or not after < before - 1e-4:
        raise AssertionError("bounded convex fit did not recover synthetic signal")
    if any(
        not bounds[index][0] <= fitted["weights"][index] <= bounds[index][1]
        for index in range(PARAMETERS)
    ):
        raise AssertionError("bounded convex fit escaped a constraint")
    bootstrap = paired_family_bootstrap(
        datasets["validation"],
        predictions(datasets["validation"], center),
        predictions(datasets["validation"], fitted["weights"]),
        1.3,
        137,
        200,
    )
    if bootstrap["candidateMinusBaselineMean"] >= 0:
        raise AssertionError("paired bootstrap has the wrong loss orientation")
    try:
        strict_json(b'{"a":1,"a":2}', "duplicate self-test")
    except ValueError:
        pass
    else:
        raise AssertionError("strict JSON accepted a duplicate member")
    if phase_from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - -") != "opening":
        raise AssertionError("phase parser drifted")
    if split_from_family("0" * 64) != "train":
        raise AssertionError("family split parser drifted")
    print("analyze-hce-synthetic-pilot self-test: 12 checks passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--label-summary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stockfish-source-archive-sha256")
    args = parser.parse_args()
    required = (
        args.input,
        args.label_summary,
        args.output,
        args.stockfish_source_archive_sha256,
    )
    if args.self_test:
        if any(value is not None for value in required):
            parser.error("--self-test cannot be combined with pilot inputs")
    elif any(value is None for value in required):
        parser.error(
            "--input, --label-summary, --output, and "
            "--stockfish-source-archive-sha256 are required"
        )
    return args


def main() -> None:
    args = parse_args()
    if args.self_test:
        self_test()
        return
    source_hash = require_hash(
        args.stockfish_source_archive_sha256,
        "Stockfish source archive SHA-256",
    )
    report = analyze(
        args.input.resolve(),
        args.label_summary.resolve(),
        args.output.resolve(),
        source_hash,
    )
    print(
        "analyze-hce-synthetic-pilot: "
        f"{report['inventory']['fitEligibleRows']} fit rows; best validation "
        f"{report['numericallyBestValidationSurfaceNoCandidateSelection']['surface']}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"analyze-hce-synthetic-pilot: {error}", file=sys.stderr)
        raise SystemExit(1)
