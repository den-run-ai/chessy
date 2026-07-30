#!/usr/bin/env python3
"""Scalable convex HCE R3 float fitter.

The fitter consumes preregistered CSR shards and emits research weights only.
It never reads hce-test, rounds/applies weights, or edits runtime files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
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


@dataclass
class Dataset:
    matrix: sparse.csr_matrix
    fixed_cp: np.ndarray
    target: np.ndarray
    role: str
    source_sha256: str
    row_ids: np.ndarray | None = None
    cluster_ids: np.ndarray | None = None
    position_family_ids: np.ndarray | None = None
    metadata: dict[str, str] | None = None

    @property
    def rows(self) -> int:
        return int(self.matrix.shape[0])


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scalar_string(archive: Any, name: str, filename: Path) -> str:
    value = archive[name]
    if value.shape != () or value.dtype.kind not in ("U", "S"):
        raise ValueError(f"{filename}: {name} must be one UTF-8 scalar")
    item = value.item()
    if isinstance(item, bytes):
        try:
            result = item.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"{filename}: {name} must be UTF-8") from error
    else:
        result = str(item)
    if not result:
        raise ValueError(f"{filename}: {name} cannot be empty")
    return result


def require_sha256(value: str, label: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")


def load_dataset(
    filename: Path,
    expected_role: str,
    parameters: int,
    expected: dict[str, str],
) -> Dataset:
    archive = np.load(filename, allow_pickle=False)
    required = {
        "indptr",
        "indices",
        "data",
        "shape",
        "fixed_cp",
        "target",
        "role",
        "row_id",
        "cluster_id",
        "position_family_id",
        "matrix_schema",
        "feature_order_sha256",
        "feature_manifest_sha256",
        "teacher_manifest_sha256",
        "selection_contract_sha256",
        "center_value_sha256",
        "scales_value_sha256",
        "score_denominator",
    }
    missing = sorted(required.difference(archive.files))
    if missing:
        raise ValueError(f"{filename}: missing arrays {', '.join(missing)}")
    if set(archive.files) != required:
        extra = sorted(set(archive.files).difference(required))
        raise ValueError(f"{filename}: undeclared arrays {', '.join(extra)}")
    if archive["shape"].dtype != np.dtype("int64") or archive["shape"].shape != (2,):
        raise ValueError(f"{filename}: shape must be int64[2]")
    shape = tuple(int(value) for value in archive["shape"].tolist())
    if shape[0] <= 0 or shape[1] != parameters:
        raise ValueError(
            f"{filename}: matrix has {shape[1]} parameters, expected {parameters}"
        )
    if archive["indptr"].dtype != np.dtype("int64"):
        raise ValueError(f"{filename}: indptr must be int64")
    if archive["indices"].dtype != np.dtype("uint16"):
        raise ValueError(f"{filename}: indices must be uint16")
    if archive["data"].dtype != np.dtype("float32"):
        raise ValueError(f"{filename}: data must be float32")
    if archive["fixed_cp"].dtype != np.dtype("float32"):
        raise ValueError(f"{filename}: fixed_cp must be float32")
    if archive["target"].dtype != np.dtype("float32"):
        raise ValueError(f"{filename}: target must be float32")
    indptr = archive["indptr"]
    indices = archive["indices"]
    data = archive["data"]
    if indptr.shape != (shape[0] + 1,) or indptr[0] != 0 or \
            np.any(indptr[1:] < indptr[:-1]) or indptr[-1] != len(indices):
        raise ValueError(f"{filename}: invalid CSR indptr")
    if data.shape != indices.shape or np.any(indices >= parameters):
        raise ValueError(f"{filename}: invalid CSR index/data arrays")
    for row in range(shape[0]):
        columns = indices[indptr[row]:indptr[row + 1]]
        if len(columns) > 1 and np.any(columns[1:] <= columns[:-1]):
            raise ValueError(
                f"{filename}: CSR columns must be strictly increasing per row"
            )
    matrix = sparse.csr_matrix(
        (
            data.astype(np.float64),
            indices.astype(np.int32),
            indptr,
        ),
        shape=shape,
    )
    fixed_cp = archive["fixed_cp"].astype(np.float64, copy=False)
    target = archive["target"].astype(np.float64, copy=False)
    role = scalar_string(archive, "role", filename)
    if role != expected_role:
        raise ValueError(f"{filename}: role {role!r}, expected {expected_role!r}")
    if fixed_cp.shape != (shape[0],) or target.shape != (shape[0],):
        raise ValueError(f"{filename}: row-vector shape mismatch")
    if not np.isfinite(matrix.data).all() or not np.isfinite(fixed_cp).all():
        raise ValueError(f"{filename}: non-finite feature or fixed score")
    if not np.isfinite(target).all() or np.any(target < 0) or np.any(target > 1):
        raise ValueError(f"{filename}: targets must be finite probabilities")
    row_vectors = {}
    for name in ("row_id", "cluster_id", "position_family_id"):
        values = archive[name]
        if values.shape != (shape[0],) or values.dtype != np.dtype("|S32"):
            raise ValueError(
                f"{filename}: {name} must be raw SHA-256 bytes S32[rows]"
            )
        row_vectors[name] = values
    row_ids = row_vectors["row_id"]
    if np.any(row_ids[1:] <= row_ids[:-1]):
        raise ValueError(f"{filename}: row_id must be unique and strictly sorted")

    metadata = {
        name: scalar_string(archive, name, filename)
        for name in (
            "matrix_schema",
            "feature_order_sha256",
            "feature_manifest_sha256",
            "teacher_manifest_sha256",
            "selection_contract_sha256",
            "center_value_sha256",
            "scales_value_sha256",
        )
    }
    for name, value in metadata.items():
        if name != "matrix_schema":
            require_sha256(value, f"{filename}: {name}")
    for name, wanted in expected.items():
        if metadata.get(name) != wanted:
            raise ValueError(
                f"{filename}: {name} {metadata.get(name)!r}, expected {wanted!r}"
            )
    denominator = archive["score_denominator"]
    if denominator.shape != () or denominator.dtype != np.dtype("int64") or \
            int(denominator.item()) != 24:
        raise ValueError(f"{filename}: score_denominator must be int64 scalar 24")
    return Dataset(
        matrix,
        fixed_cp,
        target,
        role,
        sha256_file(filename),
        row_ids,
        row_vectors["cluster_id"],
        row_vectors["position_family_id"],
        metadata,
    )


def assert_disjoint(train: Dataset, validation: Dataset) -> None:
    for field in ("row_ids", "cluster_ids", "position_family_ids"):
        left = getattr(train, field)
        right = getattr(validation, field)
        if left is None or right is None:
            raise ValueError(f"missing {field} for split-isolation check")
        validation_keys = set(right.tolist())
        overlap = next((item for item in left if item in validation_keys), None)
        if overlap is not None:
            raise ValueError(
                f"train/validation {field} overlap: {bytes(overlap).hex()}"
            )
    if train.metadata is None or validation.metadata is None:
        raise ValueError("missing matrix metadata")
    for field in (
        "matrix_schema",
        "feature_order_sha256",
        "feature_manifest_sha256",
        "teacher_manifest_sha256",
        "selection_contract_sha256",
        "center_value_sha256",
        "scales_value_sha256",
    ):
        if train.metadata[field] != validation.metadata[field]:
            raise ValueError(f"train/validation metadata mismatch: {field}")


def validate_matrix_sidecar(
    filename: Path,
    dataset: Dataset,
    expected_role: str,
    root: Path,
    feature_path: Path,
    fit_path: Path,
) -> dict[str, Any]:
    sidecar_path = filename.with_suffix(filename.suffix + ".manifest.json")
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    if sidecar.get("schemaVersion") != 1 or \
            sidecar.get("state") != "authenticated-hce-csr-v2" or \
            sidecar.get("role") != expected_role or \
            sidecar.get("rows") != dataset.rows or \
            sidecar.get("nonzeros") != int(dataset.matrix.nnz):
        raise ValueError(f"{sidecar_path}: matrix identity/count contract differs")
    output = sidecar.get("output")
    if not isinstance(output, dict) or output.get("path") != filename.name or \
            output.get("sha256") != dataset.source_sha256:
        raise ValueError(f"{sidecar_path}: output hash/path differs")
    contracts = sidecar.get("contracts")
    if not isinstance(contracts, dict) or dataset.metadata is None:
        raise ValueError(f"{sidecar_path}: contract block is missing")
    current = {
        "packerSha256": sha256_file(root / "tools/training/pack-hce.py"),
        "streamerSha256": sha256_file(
            root / "test/training/hce-r3-pack-stream.js"
        ),
        "linearExtractorSha256": sha256_file(
            root / "test/training/hce-r3-linear.js"
        ),
        "featureManifestSha256": sha256_file(feature_path),
        "fitContractSha256": sha256_file(fit_path),
        "teacherManifestSha256": dataset.metadata[
            "teacher_manifest_sha256"
        ],
        "selectionContractSha256": dataset.metadata[
            "selection_contract_sha256"
        ],
        "parameterOrderSha256": dataset.metadata[
            "feature_order_sha256"
        ],
        "centerValueSha256": dataset.metadata["center_value_sha256"],
        "scalesValueSha256": dataset.metadata["scales_value_sha256"],
        "numpy": np.__version__,
    }
    for name, value in current.items():
        if contracts.get(name) != value:
            raise ValueError(f"{sidecar_path}: {name} differs")
    inputs = sidecar.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ValueError(f"{sidecar_path}: authenticated input list is empty")
    for item in inputs:
        if not isinstance(item, dict):
            raise ValueError(f"{sidecar_path}: malformed input provenance")
        for name in ("sha256", "sidecarSha256"):
            require_sha256(
                str(item.get(name, "")), f"{sidecar_path}: input {name}"
            )
    return sidecar


def sigmoid(logits: np.ndarray) -> np.ndarray:
    return np.exp(-np.logaddexp(0.0, -logits))


def cross_entropy(logits: np.ndarray, target: np.ndarray) -> float:
    return float(np.mean(np.logaddexp(0.0, logits) - target * logits))


def fit_baseline_k(
    dataset: Dataset,
    center: np.ndarray,
    calibration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    contract = calibration or {
        "initialK": 1.0,
        "bounds": [0.05, 4.0],
        "solver": {
            "maxIterations": 100,
            "gradientTolerance": 1e-12,
            "functionTolerance": 1e-15,
        },
    }
    cp = dataset.fixed_cp + dataset.matrix @ center

    def objective(value: np.ndarray) -> tuple[float, np.ndarray]:
        k = float(value[0])
        logits = k * cp / 400.0
        probability = sigmoid(logits)
        loss = cross_entropy(logits, dataset.target)
        gradient = np.array(
            [np.mean((probability - dataset.target) * cp / 400.0)],
            dtype=np.float64,
        )
        return loss, gradient

    result = optimize.minimize(
        objective,
        np.array([float(contract["initialK"])]),
        jac=True,
        method="L-BFGS-B",
        bounds=[tuple(float(value) for value in contract["bounds"])],
        options={
            "maxiter": int(contract["solver"]["maxIterations"]),
            "gtol": float(contract["solver"]["gradientTolerance"]),
            "ftol": float(contract["solver"]["functionTolerance"]),
        },
    )
    if not result.success:
        raise RuntimeError("baseline K fit failed: " + result.message)
    return {
        "value": float(result.x[0]),
        "trainLoss": float(result.fun),
        "iterations": int(result.nit),
    }


def loss_gradient(
    weights: np.ndarray,
    dataset: Dataset,
    k: float,
    center: np.ndarray,
    scales: np.ndarray,
    regularization: float,
) -> tuple[float, np.ndarray]:
    cp = dataset.fixed_cp + dataset.matrix @ weights
    factor = k / 400.0
    logits = factor * cp
    probability = sigmoid(logits)
    data_loss = cross_entropy(logits, dataset.target)
    residual = probability - dataset.target
    gradient = factor * np.asarray(
        dataset.matrix.T @ residual / dataset.rows
    ).reshape(-1)
    delta = (weights - center) / scales
    penalty = 0.5 * regularization * float(np.mean(delta * delta))
    gradient += (
        regularization / weights.size * (weights - center) / (scales * scales)
    )
    return data_loss + penalty, gradient


def plain_loss(
    weights: np.ndarray, dataset: Dataset, k: float
) -> float:
    cp = dataset.fixed_cp + dataset.matrix @ weights
    return cross_entropy(k * cp / 400.0, dataset.target)


def fit_candidate(
    train: Dataset,
    validation: Dataset,
    center: np.ndarray,
    scales: np.ndarray,
    k: float,
    regularization: float,
    max_iterations: int,
    round_id: str = "R3.1",
    safe_mobility_indices: tuple[int, ...] = (),
    solver: dict[str, Any] | None = None,
) -> dict[str, Any]:
    solver_contract = solver or {
        "gradientTolerance": 1e-8,
        "functionTolerance": 1e-12,
        "maxLineSearchSteps": 40,
    }
    bounds: list[tuple[float | None, float | None]] | None = None
    if round_id == "R3.0":
        bounds = [(None, None)] * len(center)
        for index in safe_mobility_indices:
            if center[index] != 0:
                raise ValueError("R3.0 safe-mobility center must be zero")
            bounds[index] = (0.0, 0.0)
    elif round_id != "R3.1":
        raise ValueError("unknown HCE round " + round_id)
    result = optimize.minimize(
        loss_gradient,
        center.copy(),
        args=(train, k, center, scales, regularization),
        jac=True,
        method="L-BFGS-B",
        bounds=bounds,
        options={
            "maxiter": max_iterations,
            "gtol": float(solver_contract["gradientTolerance"]),
            "ftol": float(solver_contract["functionTolerance"]),
            "maxls": int(solver_contract["maxLineSearchSteps"]),
        },
    )
    return {
        "round": round_id,
        "lambda": regularization,
        "success": bool(result.success),
        "message": str(result.message),
        "iterations": int(result.nit),
        "objective": float(result.fun),
        "trainLoss": plain_loss(result.x, train, k),
        "validationLoss": plain_loss(result.x, validation, k),
        "gradientInfNorm": float(np.max(np.abs(result.jac))),
        "weights": result.x,
    }


def integer_vector_digest(values: np.ndarray) -> str:
    rounded = np.rint(values)
    if values.ndim != 1 or not np.isfinite(values).all() or \
            not np.array_equal(values, rounded):
        raise ValueError("center/scales must contain only finite integers")
    payload = json.dumps(
        [int(value) for value in rounded],
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_integer_vector(filename: Path, parameters: int, label: str) -> np.ndarray:
    value = json.loads(filename.read_text(encoding="utf-8"))
    if not isinstance(value, list) or len(value) != parameters:
        raise ValueError(f"{label} must be one JSON array of {parameters} integers")
    if any(isinstance(item, bool) or not isinstance(item, int) for item in value):
        raise ValueError(f"{label} must contain only JSON integers")
    return np.asarray(value, dtype=np.float64)


def self_test() -> None:
    rng = np.random.default_rng(137)
    rows, parameters = 1200, 7
    dense = rng.normal(0, 0.5, size=(rows, parameters))
    dense[rng.random(dense.shape) < 0.65] = 0
    matrix = sparse.csr_matrix(dense)
    truth = np.array([18, -11, 7, 0, 4, -6, 12], dtype=np.float64)
    logits = matrix @ truth / 40.0
    target = sigmoid(logits)
    dataset = Dataset(
        matrix=matrix,
        fixed_cp=np.zeros(rows),
        target=target,
        role="shared-train",
        source_sha256="synthetic",
    )
    center = np.zeros(parameters)
    scales = np.ones(parameters) * 20
    point = rng.normal(size=parameters)
    loss, gradient = loss_gradient(point, dataset, 10.0, center, scales, 0.02)
    finite = np.empty(parameters)
    epsilon = 1e-5
    for index in range(parameters):
        plus = point.copy()
        minus = point.copy()
        plus[index] += epsilon
        minus[index] -= epsilon
        finite[index] = (
            loss_gradient(plus, dataset, 10.0, center, scales, 0.02)[0]
            - loss_gradient(minus, dataset, 10.0, center, scales, 0.02)[0]
        ) / (2 * epsilon)
    if not math.isfinite(loss) or np.max(np.abs(gradient - finite)) > 1e-7:
        raise AssertionError("analytic gradient finite-difference check failed")
    fitted = fit_candidate(
        dataset, dataset, center, scales, 10.0, 0.0001, 500
    )
    if not fitted["success"]:
        raise AssertionError("synthetic convex recovery did not converge")
    if fitted["validationLoss"] >= plain_loss(center, dataset, 10.0) - 1e-4:
        raise AssertionError("synthetic candidate did not beat baseline")
    with tempfile.TemporaryDirectory(prefix="chessy-hce-self-test-") as temp:
        filename = Path(temp) / "matrix.npz"
        strings = np.asarray(
            [hashlib.sha256(f"row-{index}".encode()).digest()
             for index in range(rows)],
            dtype="|S32",
        )
        metadata = {
            "matrix_schema": "chessy.hce-csr.v2",
            "feature_order_sha256": "1" * 64,
            "feature_manifest_sha256": "2" * 64,
            "teacher_manifest_sha256": "3" * 64,
            "selection_contract_sha256": "4" * 64,
            "center_value_sha256": "5" * 64,
            "scales_value_sha256": "6" * 64,
        }
        order = np.argsort(strings)
        packed = matrix[order].tocsr()
        np.savez(
            filename,
            indptr=packed.indptr.astype(np.int64),
            indices=packed.indices.astype(np.uint16),
            data=packed.data.astype(np.float32),
            shape=np.asarray(packed.shape, dtype=np.int64),
            fixed_cp=np.zeros(rows, dtype=np.float32),
            target=target[order].astype(np.float32),
            role=np.asarray("shared-train"),
            row_id=strings[order],
            cluster_id=np.asarray(
                [hashlib.sha256(f"cluster-{index}".encode()).digest()
                 for index in order],
                dtype="|S32",
            ),
            position_family_id=np.asarray(
                [hashlib.sha256(f"family-{index}".encode()).digest()
                 for index in order],
                dtype="|S32",
            ),
            score_denominator=np.asarray(24, dtype=np.int64),
            **{name: np.asarray(value) for name, value in metadata.items()},
        )
        loaded = load_dataset(
            filename,
            "shared-train",
            parameters,
            {name: value for name, value in metadata.items()
             if name != "selection_contract_sha256"},
        )
        if loaded.rows != rows or loaded.metadata != metadata:
            raise AssertionError("strict CSR-v2 round trip failed")
    print("HCE convex self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--train")
    parser.add_argument("--validation")
    parser.add_argument("--center")
    parser.add_argument("--scales")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    required = ("train", "validation", "center", "scales", "output")
    missing = [name for name in required if not getattr(args, name)]
    if missing:
        parser.error("missing " + ", ".join("--" + name for name in missing))

    root = Path(__file__).resolve().parents[2]
    feature_path = root / "eval/training/hce-r3-features-v1.json"
    fit_path = root / "eval/training/hce-r3-fit-v1.json"
    features = json.loads(feature_path.read_text(encoding="utf-8"))
    fit_contract = json.loads(fit_path.read_text(encoding="utf-8"))
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise SystemExit(
            "pinned solver requires NumPy 2.3.5 and SciPy 1.17.0; got "
            f"NumPy {np.__version__}, SciPy {scipy.__version__}"
        )
    parameters = int(features["parameterCounts"]["total"])
    center_path = Path(args.center).resolve()
    scales_path = Path(args.scales).resolve()
    center = load_integer_vector(center_path, parameters, "center")
    scales = load_integer_vector(scales_path, parameters, "scales")
    center_digest = integer_vector_digest(center)
    scales_digest = integer_vector_digest(scales)
    if center_digest != fit_contract["objective"]["centerValueSha256"]:
        raise SystemExit("center does not match the frozen r69 Round-2 + zero-R3 vector")
    if scales_digest != fit_contract["objective"]["scalesValueSha256"]:
        raise SystemExit("scales do not match the frozen regularization vector")
    baseline_parameters = int(features["parameterCounts"]["baseline"])
    if np.any(center[baseline_parameters:] != 0):
        raise SystemExit("every new R3 regularization center must be zero")
    if np.any(scales <= 0):
        raise SystemExit("regularization scales must be positive")
    teacher_path = root / "eval/training/teacher-sf18-100kn-v1.json"
    expected_metadata = {
        "matrix_schema": fit_contract["matrix"]["format"],
        "feature_order_sha256": features["parameterOrder"]["sha256"],
        "feature_manifest_sha256": sha256_file(feature_path),
        "teacher_manifest_sha256": sha256_file(teacher_path),
        "center_value_sha256": center_digest,
        "scales_value_sha256": scales_digest,
    }
    train_path = Path(args.train).resolve()
    validation_path = Path(args.validation).resolve()
    train = load_dataset(
        train_path, "shared-train", parameters, expected_metadata
    )
    validation = load_dataset(
        validation_path, "hce-validation", parameters, expected_metadata
    )
    train_sidecar = validate_matrix_sidecar(
        train_path, train, "shared-train", root, feature_path, fit_path
    )
    validation_sidecar = validate_matrix_sidecar(
        validation_path,
        validation,
        "hce-validation",
        root,
        feature_path,
        fit_path,
    )
    assert_disjoint(train, validation)
    k_fit = fit_baseline_k(train, center, fit_contract["calibration"])
    k = float(k_fit["value"])

    baseline_validation = plain_loss(center, validation, k)
    candidates = []
    best: dict[str, Any] = {
        "kind": "baseline",
        "validationLoss": baseline_validation,
        "weights": center,
    }
    max_iterations = int(fit_contract["solver"]["maxIterations"])
    safe_family = next(
        family for family in features["families"]
        if family["id"] == "safe-mobility"
    )
    safe_indices = tuple(range(
        int(safe_family["startId"]),
        int(safe_family["startId"]) + int(safe_family["count"]),
    ))
    for round_id in ("R3.0", "R3.1"):
        for regularization in fit_contract["objective"]["lambdaGrid"]:
            if float(regularization) <= 0:
                raise SystemExit("lambda grid must exclude zero")
            candidate = fit_candidate(
                train,
                validation,
                center,
                scales,
                k,
                float(regularization),
                max_iterations,
                round_id,
                safe_indices,
                fit_contract["solver"],
            )
            candidate["eligible"] = bool(candidate["success"])
            if round_id == "R3.1":
                ablated = candidate["weights"].copy()
                ablated[list(safe_indices)] = 0
                ablated_loss = plain_loss(ablated, validation, k)
                full_gain = baseline_validation - candidate["validationLoss"]
                retained_gain = baseline_validation - ablated_loss
                retained_fraction = (
                    retained_gain / full_gain if full_gain > 0 else None
                )
                candidate["safeMobilityAblationValidationLoss"] = ablated_loss
                candidate["nonMobilityGainRetainedFraction"] = retained_fraction
                candidate["eligible"] = bool(
                    candidate["success"]
                    and candidate["validationLoss"] < baseline_validation
                    and ablated_loss < baseline_validation
                    and retained_fraction is not None
                    and retained_fraction >= 0.5
                )
            candidates.append(candidate)
            if candidate["eligible"] and \
                    candidate["validationLoss"] < best["validationLoss"]:
                best = candidate
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit("refusing to overwrite --output")
    payload = {
        "schemaVersion": 1,
        "status": "float-research-candidate-not-applied",
        "featureManifestSha256": sha256_file(feature_path),
        "fitContractSha256": sha256_file(fit_path),
        "inputs": {
            "train": {
                "path": str(train_path),
                "sha256": train.source_sha256,
                "rows": train.rows,
                "sidecarSha256": sha256_file(
                    train_path.with_suffix(
                        train_path.suffix + ".manifest.json"
                    )
                ),
            },
            "validation": {
                "path": str(validation_path),
                "sha256": validation.source_sha256,
                "rows": validation.rows,
                "sidecarSha256": sha256_file(
                    validation_path.with_suffix(
                        validation_path.suffix + ".manifest.json"
                    )
                ),
            },
            "centerFileSha256": sha256_file(center_path),
            "scalesFileSha256": sha256_file(scales_path),
            "centerValueSha256": center_digest,
            "scalesValueSha256": scales_digest,
            "selectionContractSha256": train.metadata[
                "selection_contract_sha256"
            ],
            "teacherManifestSha256": train.metadata[
                "teacher_manifest_sha256"
            ],
        },
        "frozenK": k_fit,
        "baselineValidationLoss": baseline_validation,
        "candidates": [
            {key: value for key, value in candidate.items() if key != "weights"}
            for candidate in candidates
        ],
        "selected": {
            "kind": best.get("kind", "regularized-fit"),
            "round": best.get("round"),
            "lambda": best.get("lambda"),
            "validationLoss": best["validationLoss"],
            "weights": [float(value) for value in best["weights"]],
        },
        "testOpened": false,
        "runtimeFilesChanged": false,
        "solver": {
            "implementationSha256": sha256_file(Path(__file__).resolve()),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "maxIterations": max_iterations,
            "threads": 1,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
