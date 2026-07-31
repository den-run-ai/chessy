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
import re
import struct
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import numpy as np
import scipy
from scipy import optimize, sparse


PRODUCTION_INPUT_DISPOSITION = "authenticated-production-input"
STREAMER_CLOSURE_SCHEMA = "chessy.hce-streamer-closure.v1"
SNAPSHOT_PACKAGE_PATH = "package.json"
SNAPSHOT_PACKAGE_BYTES = b'{"private":true,"type":"commonjs"}\n'
STREAMER_CLOSURE_STATIC_PATHS = (
    "test/training/hce-r3-pack-stream.js",
    "test/training/corpus.js",
    "test/training/prepare-lichess-evals.js",
    "test/training/label-stockfish.js",
    "test/training/hce-r3-linear.js",
    "test/training/hce-r3-features.js",
    "test/training/hce-r3-baseline.js",
    "test/eval/e4-protocol.js",
    "experiments/wasm/src/eval.rs",
    "assets/chessy-ai-fast.wasm",
    "eval/training/hce-r3-features-v1.json",
    "eval/training/hce-r3-fit-v1.json",
    "eval/training/heldout-v1.json",
    "eval/training/source-manifest.json",
    "eval/training/teacher-sf18-100kn-v1.json",
)
STREAMER_CLOSURE_DYNAMIC_DIRECTORIES = ("eval/e4",)


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
    metadata: dict[str, str | int] | None = None

    @property
    def rows(self) -> int:
        return int(self.matrix.shape[0])


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_stream(stream: BinaryIO) -> str:
    position = stream.tell()
    digest = hashlib.sha256()
    try:
        stream.seek(0)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    finally:
        stream.seek(position)
    return digest.hexdigest()


@contextmanager
def authenticated_npz(
    filename: Path,
) -> Iterator[tuple[Any, str]]:
    with filename.open("rb") as source:
        source_sha256 = sha256_stream(source)
        source.seek(0)
        with np.load(source, allow_pickle=False) as archive:
            yield archive, source_sha256


def streamer_closure_paths(root: Path) -> tuple[Path, ...]:
    root = root.resolve()
    paths = [root / relative for relative in STREAMER_CLOSURE_STATIC_PATHS]
    for relative in STREAMER_CLOSURE_DYNAMIC_DIRECTORIES:
        directory = root / relative
        if not directory.is_dir():
            raise RuntimeError(
                f"HCE streamer closure directory is missing: {directory}"
            )
        for filename in directory.rglob("*"):
            if filename.is_symlink():
                raise RuntimeError(
                    f"HCE streamer closure cannot contain a symlink: {filename}"
                )
            if filename.is_file():
                paths.append(filename)
    if any(filename.is_symlink() for filename in paths):
        raise RuntimeError("HCE streamer closure cannot contain a symlink")
    missing = [filename for filename in paths if not filename.is_file()]
    if missing:
        raise RuntimeError(
            "HCE streamer closure file is missing: " + str(missing[0])
        )
    unique = {filename.resolve() for filename in paths}
    if len(unique) != len(paths):
        raise RuntimeError("HCE streamer closure contains duplicate files")
    return tuple(
        sorted(unique, key=lambda filename: filename.relative_to(root).as_posix())
    )


def capture_streamer_closure(
    root: Path,
) -> tuple[dict[Path, bytes], str]:
    root = root.resolve()
    captured = {
        filename: filename.read_bytes()
        for filename in streamer_closure_paths(root)
    }
    entries = [
        (filename.relative_to(root).as_posix(), data)
        for filename, data in captured.items()
    ]
    entries.append((SNAPSHOT_PACKAGE_PATH, SNAPSHOT_PACKAGE_BYTES))
    entries.sort(key=lambda item: item[0])
    if len({relative for relative, _ in entries}) != len(entries):
        raise RuntimeError("captured HCE streamer closure contains duplicates")
    digest = hashlib.sha256()
    digest.update(STREAMER_CLOSURE_SCHEMA.encode("utf-8") + b"\0")
    digest.update(struct.pack(">Q", len(entries)))
    for relative, data in entries:
        encoded_path = relative.encode("utf-8")
        digest.update(struct.pack(">I", len(encoded_path)))
        digest.update(encoded_path)
        digest.update(struct.pack(">Q", len(data)))
        digest.update(data)
    return captured, digest.hexdigest()


def assert_artifacts_unchanged(expected: dict[Path, str]) -> None:
    for filename, wanted in expected.items():
        if sha256_file(filename) != wanted:
            raise RuntimeError(
                f"validated fit input changed during fitting: {filename}"
            )


def publish_json_no_replace(
    filename: Path,
    payload: Any,
    expected_inputs: dict[Path, str],
) -> None:
    encoded = (
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f".{filename.name}.",
            suffix=".tmp",
            dir=filename.parent,
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        assert_artifacts_unchanged(expected_inputs)
        os.link(temporary, filename)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


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


def require_node_version(value: str, label: str) -> None:
    if not re.fullmatch(
        r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", value
    ):
        raise ValueError(f"{label} must be an exact Node version")


def load_dataset(
    filename: Path,
    expected_role: str,
    parameters: int,
    expected: dict[str, str | int],
) -> Dataset:
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
        "selection_manifest_sha256",
        "selection_contract_sha256",
        "source_snapshot_sha256",
        "input_disposition",
        "streamer_closure_sha256",
        "node_executable_sha256",
        "node_executable_bytes",
        "node_version",
        "center_value_sha256",
        "scales_value_sha256",
        "score_denominator",
    }
    with authenticated_npz(filename) as (source_archive, initial_sha256):
        archive_files = tuple(source_archive.files)
        if len(set(archive_files)) != len(archive_files):
            raise ValueError(f"{filename}: duplicate NPZ array names")
        missing = sorted(required.difference(archive_files))
        if missing:
            raise ValueError(f"{filename}: missing arrays {', '.join(missing)}")
        if set(archive_files) != required:
            extra = sorted(set(archive_files).difference(required))
            raise ValueError(
                f"{filename}: undeclared arrays {', '.join(extra)}"
            )
        archive = {
            name: source_archive[name]
            for name in archive_files
        }
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
            "selection_manifest_sha256",
            "selection_contract_sha256",
            "source_snapshot_sha256",
            "input_disposition",
            "streamer_closure_sha256",
            "node_executable_sha256",
            "node_version",
            "center_value_sha256",
            "scales_value_sha256",
        )
    }
    node_bytes = archive["node_executable_bytes"]
    if (
        node_bytes.shape != ()
        or node_bytes.dtype != np.dtype("int64")
        or int(node_bytes.item()) <= 0
    ):
        raise ValueError(
            f"{filename}: node_executable_bytes must be a positive int64 scalar"
        )
    metadata["node_executable_bytes"] = int(node_bytes.item())
    require_node_version(
        str(metadata["node_version"]), f"{filename}: node_version"
    )
    for name, value in metadata.items():
        if name.endswith("_sha256"):
            require_sha256(str(value), f"{filename}: {name}")
    for name, wanted in expected.items():
        if metadata.get(name) != wanted:
            raise ValueError(
                f"{filename}: {name} {metadata.get(name)!r}, expected {wanted!r}"
            )
    denominator = archive["score_denominator"]
    if denominator.shape != () or denominator.dtype != np.dtype("int64") or \
            int(denominator.item()) != 24:
        raise ValueError(f"{filename}: score_denominator must be int64 scalar 24")
    assert_artifacts_unchanged({filename: initial_sha256})
    return Dataset(
        matrix,
        fixed_cp,
        target,
        role,
        initial_sha256,
        row_ids,
        row_vectors["cluster_id"],
        row_vectors["position_family_id"],
        metadata,
    )


def assert_disjoint(train: Dataset, validation: Dataset) -> None:
    if train.metadata is None or validation.metadata is None:
        raise ValueError("missing matrix metadata")
    for field in (
        "matrix_schema",
        "feature_order_sha256",
        "feature_manifest_sha256",
        "teacher_manifest_sha256",
        "selection_manifest_sha256",
        "selection_contract_sha256",
        "source_snapshot_sha256",
        "input_disposition",
        "streamer_closure_sha256",
        "node_executable_sha256",
        "node_executable_bytes",
        "node_version",
        "center_value_sha256",
        "scales_value_sha256",
    ):
        if train.metadata[field] != validation.metadata[field]:
            raise ValueError(f"train/validation metadata mismatch: {field}")
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


def validate_matrix_sidecar(
    filename: Path,
    dataset: Dataset,
    expected_role: str,
    root: Path,
    feature_path: Path,
    fit_path: Path,
    streamer_closure_sha256: str,
) -> tuple[dict[str, Any], str]:
    sidecar_path = filename.with_suffix(filename.suffix + ".manifest.json")
    sidecar_bytes = sidecar_path.read_bytes()
    sidecar_sha256 = hashlib.sha256(sidecar_bytes).hexdigest()
    sidecar = json.loads(sidecar_bytes.decode("utf-8"))
    if (
        sidecar.get("schemaVersion") != 1
        or sidecar.get("state") != "authenticated-hce-csr-v2"
        or sidecar.get("role") != expected_role
        or sidecar.get("inputDisposition") != PRODUCTION_INPUT_DISPOSITION
        or sidecar.get("rows") != dataset.rows
        or sidecar.get("nonzeros") != int(dataset.matrix.nnz)
    ):
        raise ValueError(f"{sidecar_path}: matrix identity/count contract differs")
    output = sidecar.get("output")
    if not isinstance(output, dict) or output.get("path") != filename.name or \
            output.get("sha256") != dataset.source_sha256:
        raise ValueError(f"{sidecar_path}: output hash/path differs")
    contracts = sidecar.get("contracts")
    if not isinstance(contracts, dict) or dataset.metadata is None:
        raise ValueError(f"{sidecar_path}: contract block is missing")
    if (
        not isinstance(contracts.get("nodeExecutableSha256"), str)
        or type(contracts.get("nodeExecutableBytes")) is not int
        or contracts["nodeExecutableBytes"] <= 0
        or not isinstance(contracts.get("nodeVersion"), str)
    ):
        raise ValueError(
            f"{sidecar_path}: Node runtime provenance is malformed"
        )
    current = {
        "packerSha256": sha256_file(root / "tools/training/pack-hce.py"),
        "streamerSha256": sha256_file(
            root / "test/training/hce-r3-pack-stream.js"
        ),
        "linearExtractorSha256": sha256_file(
            root / "test/training/hce-r3-linear.js"
        ),
        "baselineExtractorSha256": sha256_file(
            root / "test/training/hce-r3-baseline.js"
        ),
        "rustEvaluatorSourceSha256": sha256_file(
            root / "experiments/wasm/src/eval.rs"
        ),
        "shippedWasmSha256": sha256_file(
            root / "assets/chessy-ai-fast.wasm"
        ),
        "featureManifestSha256": sha256_file(feature_path),
        "fitContractSha256": sha256_file(fit_path),
        "teacherManifestSha256": dataset.metadata[
            "teacher_manifest_sha256"
        ],
        "selectionManifestSha256": dataset.metadata[
            "selection_manifest_sha256"
        ],
        "selectionContractSha256": dataset.metadata[
            "selection_contract_sha256"
        ],
        "sourceSnapshotSha256": dataset.metadata[
            "source_snapshot_sha256"
        ],
        "inputDisposition": dataset.metadata["input_disposition"],
        "streamerClosureSha256": streamer_closure_sha256,
        "nodeExecutableSha256": dataset.metadata[
            "node_executable_sha256"
        ],
        "nodeExecutableBytes": dataset.metadata[
            "node_executable_bytes"
        ],
        "nodeVersion": dataset.metadata["node_version"],
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
    if sidecar.get("inputInventoryScope") != (
        "complete-selection-shard-inventory"
    ):
        raise ValueError(
            f"{sidecar_path}: input inventory is not selection-complete"
        )
    inputs = sidecar.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ValueError(f"{sidecar_path}: authenticated input list is empty")
    provided_selection: dict[int, dict] = {}
    for index, item in enumerate(inputs):
        if not isinstance(item, dict):
            raise ValueError(f"{sidecar_path}: malformed input provenance")
        if (
            not isinstance(item.get("path"), str)
            or not item["path"]
            or not isinstance(item.get("sidecarPath"), str)
            or not item["sidecarPath"]
            or isinstance(item.get("rows"), bool)
            or not isinstance(item.get("rows"), int)
            or item["rows"] < 0
        ):
            raise ValueError(
                f"{sidecar_path}: malformed input inventory[{index}]"
            )
        for name in ("sha256", "sidecarSha256"):
            require_sha256(
                str(item.get(name, "")), f"{sidecar_path}: input {name}"
            )
        selection_shard = item.get("selectionShard")
        if (
            not isinstance(selection_shard, dict)
            or not isinstance(selection_shard.get("path"), str)
            or not selection_shard["path"]
            or isinstance(selection_shard.get("index"), bool)
            or not isinstance(selection_shard.get("index"), int)
            or selection_shard["index"] < 0
            or isinstance(selection_shard.get("rows"), bool)
            or not isinstance(selection_shard.get("rows"), int)
            or selection_shard["rows"] < 0
        ):
            raise ValueError(
                f"{sidecar_path}: malformed selection shard inventory[{index}]"
            )
        require_sha256(
            str(selection_shard.get("sha256", "")),
            f"{sidecar_path}: selection shard sha256",
        )
        if selection_shard["index"] in provided_selection:
            raise ValueError(
                f"{sidecar_path}: duplicate selection shard index"
            )
        provided_selection[selection_shard["index"]] = selection_shard
    declared = sidecar.get("declaredSelectionShards")
    if not isinstance(declared, list) or len(declared) != len(inputs):
        raise ValueError(
            f"{sidecar_path}: declared selection inventory is incomplete"
        )
    for index, item in enumerate(declared):
        if (
            not isinstance(item, dict)
            or set(item) != {"index", "path", "rows", "sha256"}
            or item.get("index") != index
            or not isinstance(item.get("path"), str)
            or not item["path"]
            or isinstance(item.get("rows"), bool)
            or not isinstance(item.get("rows"), int)
            or item["rows"] < 0
        ):
            raise ValueError(
                f"{sidecar_path}: malformed declared selection shard[{index}]"
            )
        require_sha256(
            str(item.get("sha256", "")),
            f"{sidecar_path}: declared selection shard sha256",
        )
        provided = provided_selection.get(index)
        if (
            provided is None
            or Path(provided["path"]).resolve() != Path(item["path"]).resolve()
            or provided["rows"] != item["rows"]
            or provided["sha256"] != item["sha256"]
        ):
            raise ValueError(
                f"{sidecar_path}: declared/provided selection shard differs"
            )
    return sidecar, sidecar_sha256


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
            "selection_manifest_sha256": "4" * 64,
            "selection_contract_sha256": "5" * 64,
            "source_snapshot_sha256": "6" * 64,
            "input_disposition": PRODUCTION_INPUT_DISPOSITION,
            "streamer_closure_sha256": "9" * 64,
            "node_executable_sha256": "c" * 64,
            "node_executable_bytes": 123456,
            "node_version": "v99.0.0",
            "center_value_sha256": "7" * 64,
            "scales_value_sha256": "8" * 64,
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

        replacement_filename = Path(temp) / "replacement-matrix.npz"
        with np.load(filename, allow_pickle=False) as fixture_archive:
            replacement_arrays = {
                name: fixture_archive[name]
                for name in fixture_archive.files
            }
        authenticated_target = replacement_arrays["target"].copy()
        replacement_target = np.zeros_like(
            replacement_arrays["target"]
        )
        if np.array_equal(
            replacement_target, replacement_arrays["target"]
        ):
            replacement_target = np.ones_like(
                replacement_arrays["target"]
            )
        replacement_arrays["target"] = replacement_target
        np.savez(replacement_filename, **replacement_arrays)
        original_filename = Path(temp) / "authenticated-matrix-A.npz"
        authenticated_sha256 = sha256_file(filename)
        blocked_transient_output = (
            Path(temp) / "blocked-transient-candidate.json"
        )
        with authenticated_npz(
            filename
        ) as (retained_archive, retained_sha256):
            filename.replace(original_filename)
            replacement_filename.replace(filename)
            try:
                retained_target = retained_archive["target"].copy()
                if np.array_equal(retained_target, replacement_target):
                    raise AssertionError(
                        "retained NPZ descriptor exposed replacement rows"
                    )
                try:
                    publish_json_no_replace(
                        blocked_transient_output,
                        {"status": "must-not-publish-from-replacement-B"},
                        {filename: retained_sha256},
                    )
                except RuntimeError:
                    pass
                else:
                    raise AssertionError(
                        "replacement NPZ admitted a candidate publication"
                    )
            finally:
                filename.unlink(missing_ok=True)
                original_filename.replace(filename)
        if (
            retained_sha256 != authenticated_sha256
            or not np.array_equal(
                retained_target, authenticated_target
            )
            or blocked_transient_output.exists()
            or sha256_file(filename) != authenticated_sha256
        ):
            raise AssertionError(
                "atomic NPZ replace/restore changed authenticated arrays "
                "or exposed a candidate"
            )

        for field, replacement in (
            ("selection_manifest_sha256", "9" * 64),
            ("source_snapshot_sha256", "a" * 64),
            ("streamer_closure_sha256", "b" * 64),
            ("node_executable_sha256", "d" * 64),
            ("node_executable_bytes", 123457),
            ("node_version", "v99.0.1"),
            ("input_disposition", "sample-only-not-fit-eligible"),
        ):
            mismatched_metadata = dict(metadata)
            mismatched_metadata[field] = replacement
            validation = Dataset(
                matrix=loaded.matrix,
                fixed_cp=loaded.fixed_cp,
                target=loaded.target,
                role="hce-validation",
                source_sha256=loaded.source_sha256,
                row_ids=loaded.row_ids,
                cluster_ids=loaded.cluster_ids,
                position_family_ids=loaded.position_family_ids,
                metadata=mismatched_metadata,
            )
            try:
                assert_disjoint(loaded, validation)
            except ValueError as error:
                if field not in str(error):
                    raise AssertionError(
                        f"wrong mismatch rejection for {field}: {error}"
                    ) from error
            else:
                raise AssertionError(
                    f"train/validation accepted different {field}"
                )
        guarded_names = (
            "guard-train.npz",
            "guard-train.npz.manifest.json",
            "guard-validation.npz",
            "guard-validation.npz.manifest.json",
        )
        guarded_artifacts = {}
        for name in guarded_names:
            guarded = Path(temp) / name
            guarded.write_bytes(("initial " + name).encode("utf-8"))
            guarded_artifacts[guarded] = sha256_file(guarded)
        assert_artifacts_unchanged(guarded_artifacts)
        replaced = Path(temp) / "guard-validation.npz.manifest.json"
        preserved_sha256 = guarded_artifacts[replaced]
        replaced.write_bytes(b"replacement sidecar bytes")
        try:
            assert_artifacts_unchanged(guarded_artifacts)
        except RuntimeError as error:
            if (
                "changed during fitting" not in str(error)
                or str(replaced) not in str(error)
                or guarded_artifacts[replaced] != preserved_sha256
            ):
                raise AssertionError(
                    f"wrong changed-input rejection: {error}"
                ) from error
        else:
            raise AssertionError("fitter accepted a replaced validated input")
        blocked_output = Path(temp) / "blocked-candidate.json"
        try:
            publish_json_no_replace(
                blocked_output,
                {"status": "must-not-publish"},
                guarded_artifacts,
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("changed input did not block publication")
        if blocked_output.exists():
            raise AssertionError("failed rehash left a final output artifact")

        invalid_output = Path(temp) / "invalid-candidate.json"
        try:
            publish_json_no_replace(
                invalid_output,
                {"nonFinite": math.nan},
                {},
            )
        except ValueError:
            pass
        else:
            raise AssertionError("non-finite candidate serialized")
        if invalid_output.exists():
            raise AssertionError(
                "failed serialization left a final output artifact"
            )

        stable_input = Path(temp) / "stable-input.bin"
        stable_input.write_bytes(b"stable authenticated input")
        stable_inputs = {stable_input: sha256_file(stable_input)}
        published = Path(temp) / "published-candidate.json"
        publish_json_no_replace(
            published,
            {"status": "float-research-candidate-not-applied"},
            stable_inputs,
        )
        if json.loads(published.read_text(encoding="utf-8")) != {
            "status": "float-research-candidate-not-applied"
        }:
            raise AssertionError("exclusive candidate publication differs")
        preserved = published.read_bytes()
        try:
            publish_json_no_replace(
                published,
                {"status": "replacement"},
                stable_inputs,
            )
        except FileExistsError:
            pass
        else:
            raise AssertionError("candidate publication replaced an output")
        if published.read_bytes() != preserved:
            raise AssertionError("no-replace failure changed the output")
        leftovers = list(Path(temp).glob(".*.tmp"))
        if leftovers:
            raise AssertionError("candidate publication left temporary files")
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
    teacher_path = root / "eval/training/teacher-sf18-100kn-v1.json"
    streamer_closure, streamer_closure_sha256 = capture_streamer_closure(root)
    implementation_paths = (
        Path(__file__).resolve(),
        root / "tools/training/pack-hce.py",
    )
    implementation_hashes = {
        filename: sha256_file(filename) for filename in implementation_paths
    }
    implementation_hashes.update(
        {
            filename: hashlib.sha256(data).hexdigest()
            for filename, data in streamer_closure.items()
        }
    )
    features = json.loads(streamer_closure[feature_path].decode("utf-8"))
    fit_contract = json.loads(streamer_closure[fit_path].decode("utf-8"))
    contract_disposition = fit_contract["matrix"].get(
        "requiredInputDisposition"
    )
    if contract_disposition != PRODUCTION_INPUT_DISPOSITION:
        raise SystemExit("fit contract does not require production input disposition")
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise SystemExit(
            "pinned solver requires NumPy 2.3.5 and SciPy 1.17.0; got "
            f"NumPy {np.__version__}, SciPy {scipy.__version__}"
        )
    parameters = int(features["parameterCounts"]["total"])
    center_path = Path(args.center).resolve()
    scales_path = Path(args.scales).resolve()
    center_file_sha256 = sha256_file(center_path)
    scales_file_sha256 = sha256_file(scales_path)
    center = load_integer_vector(center_path, parameters, "center")
    scales = load_integer_vector(scales_path, parameters, "scales")
    center_digest = integer_vector_digest(center)
    scales_digest = integer_vector_digest(scales)
    if center_digest != fit_contract["objective"]["centerValueSha256"]:
        raise SystemExit(
            "center does not match the frozen r71 baseline Round-2 + zero-R3 vector"
        )
    if scales_digest != fit_contract["objective"]["scalesValueSha256"]:
        raise SystemExit("scales do not match the frozen regularization vector")
    baseline_parameters = int(features["parameterCounts"]["baseline"])
    if np.any(center[baseline_parameters:] != 0):
        raise SystemExit("every new R3 regularization center must be zero")
    if np.any(scales <= 0):
        raise SystemExit("regularization scales must be positive")
    expected_metadata = {
        "matrix_schema": fit_contract["matrix"]["format"],
        "feature_order_sha256": features["parameterOrder"]["sha256"],
        "feature_manifest_sha256": implementation_hashes[feature_path],
        "teacher_manifest_sha256": implementation_hashes[teacher_path],
        "input_disposition": contract_disposition,
        "streamer_closure_sha256": streamer_closure_sha256,
        "center_value_sha256": center_digest,
        "scales_value_sha256": scales_digest,
    }
    train_path = Path(args.train).resolve()
    validation_path = Path(args.validation).resolve()
    train_sidecar_path = train_path.with_suffix(
        train_path.suffix + ".manifest.json"
    )
    validation_sidecar_path = validation_path.with_suffix(
        validation_path.suffix + ".manifest.json"
    )
    train = load_dataset(
        train_path, "shared-train", parameters, expected_metadata
    )
    validation = load_dataset(
        validation_path, "hce-validation", parameters, expected_metadata
    )
    _, train_sidecar_sha256 = validate_matrix_sidecar(
        train_path,
        train,
        "shared-train",
        root,
        feature_path,
        fit_path,
        streamer_closure_sha256,
    )
    _, validation_sidecar_sha256 = validate_matrix_sidecar(
        validation_path,
        validation,
        "hce-validation",
        root,
        feature_path,
        fit_path,
        streamer_closure_sha256,
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
        "featureManifestSha256": implementation_hashes[feature_path],
        "fitContractSha256": implementation_hashes[fit_path],
        "inputs": {
            "train": {
                "path": str(train_path),
                "sha256": train.source_sha256,
                "rows": train.rows,
                "sidecarSha256": train_sidecar_sha256,
            },
            "validation": {
                "path": str(validation_path),
                "sha256": validation.source_sha256,
                "rows": validation.rows,
                "sidecarSha256": validation_sidecar_sha256,
            },
            "centerFileSha256": center_file_sha256,
            "scalesFileSha256": scales_file_sha256,
            "centerValueSha256": center_digest,
            "scalesValueSha256": scales_digest,
            "selectionContractSha256": train.metadata[
                "selection_contract_sha256"
            ],
            "selectionManifestSha256": train.metadata[
                "selection_manifest_sha256"
            ],
            "sourceSnapshotSha256": train.metadata[
                "source_snapshot_sha256"
            ],
            "inputDisposition": train.metadata["input_disposition"],
            "streamerClosureSha256": train.metadata[
                "streamer_closure_sha256"
            ],
            "nodeExecutableSha256": train.metadata[
                "node_executable_sha256"
            ],
            "nodeExecutableBytes": train.metadata[
                "node_executable_bytes"
            ],
            "nodeVersion": train.metadata["node_version"],
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
        "testOpened": False,
        "runtimeFilesChanged": False,
        "solver": {
            "implementationSha256": implementation_hashes[
                Path(__file__).resolve()
            ],
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "maxIterations": max_iterations,
            "threads": 1,
        },
    }
    publication_inputs = {
        **implementation_hashes,
        center_path: center_file_sha256,
        scales_path: scales_file_sha256,
        train_path: train.source_sha256,
        validation_path: validation.source_sha256,
        train_sidecar_path: train_sidecar_sha256,
        validation_sidecar_path: validation_sidecar_sha256,
    }
    try:
        publish_json_no_replace(output, payload, publication_inputs)
    except FileExistsError as error:
        raise SystemExit("refusing to overwrite --output") from error


if __name__ == "__main__":
    main()
