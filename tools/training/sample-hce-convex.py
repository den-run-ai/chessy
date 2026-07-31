#!/usr/bin/env python3
"""Bounded sample-only HCE packing and convex-solver diagnostic.

This path deliberately cannot consume authenticated production inputs and
cannot emit weights or a candidate.  It exercises the frozen center, scales,
lambda grid, and convex solver math on the immutable 40-row preliminary
mechanism fixture produced by generate-training-sample.js.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import numpy as np
import scipy
from scipy import sparse


STATUS = "sample-only-not-fit-eligible"
REPORT_STATUS = "sample-only-preliminary-convex-diagnostic"
PROFILE = "preliminary"
SELECTION_ROLE_COUNTS = {
    "shared-train": 18,
    "hce-validation": 4,
    "hce-test": 9,
    "nnue-validation": 2,
    "nnue-test": 7,
}
LABELLED_ROLE_COUNTS = {
    "shared-train": 17,
    "hce-validation": 4,
    "hce-test": 9,
    "nnue-validation": 2,
    "nnue-test": 7,
}
MAX_SELECTED_ROWS = sum(SELECTION_ROLE_COUNTS.values())
LABELLED_ROWS = sum(LABELLED_ROLE_COUNTS.values())
EXCLUSION_REASONS = {"bestmove-pv-mismatch": 1}
ROW_FIELDS = {
    "id",
    "cluster",
    "positionFamily",
    "role",
    "fixedCp",
    "target",
    "indices",
    "data",
}
HEX = frozenset("0123456789abcdef")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON member: {key}")
        value[key] = item
    return value


def parse_json_bytes(value: bytes, label: str) -> Any:
    try:
        return json.loads(
            value.decode("utf-8"),
            object_pairs_hook=strict_object,
            parse_constant=lambda item: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON number: {item}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{label}: invalid strict JSON: {error}") from error


def require_sha256(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(char not in HEX for char in value)
    ):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")
    return value


def require_false(value: object, label: str) -> None:
    if value is not False:
        raise ValueError(f"{label} must be exactly false")


def resolve_sample_path(sample_dir: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a nonempty relative path")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"{label} must stay inside the sample directory")
    resolved = (sample_dir / relative).resolve()
    if not resolved.is_relative_to(sample_dir):
        raise ValueError(f"{label} escapes the sample directory")
    if not resolved.is_file():
        raise ValueError(f"{label} does not name an existing file")
    return resolved


def load_solver(root: Path) -> tuple[Any, str]:
    filename = root / "tools/training/hce-fit.py"
    source = filename.read_bytes()
    digest = sha256_bytes(source)
    name = "chessy_sample_hce_solver"
    module = types.ModuleType(name)
    module.__file__ = str(filename)
    module.__package__ = None
    sys.modules[name] = module
    exec(compile(source, str(filename), "exec"), module.__dict__)
    return module, digest


def exact_preliminary_manifest(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("sample manifest must be an object")
    if (
        value.get("schema") != "chessy.training-sample.v1"
        or value.get("status") != STATUS
        or value.get("profile") != PROFILE
    ):
        raise ValueError(
            "only the immutable preliminary sample profile is accepted"
        )
    require_false(value.get("fitAllowed"), "sample manifest fitAllowed")
    require_false(
        value.get("publishableArtifact"),
        "sample manifest publishableArtifact",
    )
    source = value.get("sourceFixture")
    if not isinstance(source, dict):
        raise ValueError("sample source fixture is missing")
    require_false(
        source.get("officialEvaluationSnapshot"),
        "source officialEvaluationSnapshot",
    )
    certification = value.get("certificationBoundary")
    if (
        not isinstance(certification, dict)
        or certification.get("status") != "awaiting-opening-freeze"
    ):
        raise ValueError("sample certification boundary is not pending")
    require_false(
        certification.get("productionFreeze"),
        "certification productionFreeze",
    )
    selection = value.get("selection")
    if (
        not isinstance(selection, dict)
        or selection.get("state") != "mechanism-test-selection-only"
        or selection.get("rows") != MAX_SELECTED_ROWS
        or selection.get("byRole") != SELECTION_ROLE_COUNTS
    ):
        raise ValueError("sample selection is not the preliminary inventory")
    require_false(selection.get("fitAllowed"), "selection fitAllowed")
    teacher = value.get("teacher")
    if (
        not isinstance(teacher, dict)
        or teacher.get("state") != "pinned-teacher-labels-sample-only"
        or teacher.get("rows") != LABELLED_ROWS
        or teacher.get("excludedRows") != 1
        or teacher.get("byRole") != LABELLED_ROLE_COUNTS
    ):
        raise ValueError("sample teacher inventory differs")
    require_false(teacher.get("fitAllowed"), "teacher fitAllowed")
    exclusion_reasons = teacher.get("exclusionReasons")
    if exclusion_reasons != EXCLUSION_REASONS:
        raise ValueError("sample teacher exclusion inventory differs")
    require_sha256(teacher.get("exclusionSha256"), "teacher exclusionSha256")
    nnue = value.get("nnue")
    if (
        not isinstance(nnue, dict)
        or nnue.get("status")
        != "validated-sample-only-pinned-teacher-inputs"
    ):
        raise ValueError("sample NNUE validation marker differs")
    require_false(nnue.get("fitAllowed"), "NNUE fitAllowed")
    hce = value.get("hce")
    if not isinstance(hce, dict):
        raise ValueError("sample HCE inventory is missing")
    for name, role in (
        ("sharedTrain", "shared-train"),
        ("validation", "hce-validation"),
    ):
        item = hce.get(name)
        if (
            not isinstance(item, dict)
            or item.get("status") != STATUS
            or item.get("rows") != LABELLED_ROLE_COUNTS[role]
        ):
            raise ValueError(f"sample HCE {name} inventory differs")
        require_false(item.get("fitAllowed"), f"HCE {name} fitAllowed")
    return value


def strict_feature_row(
    value: object,
    role: str,
    parameters: int,
    previous_id: bytes | None,
) -> tuple[bytes, bytes, bytes, float, float, list[int], list[float]]:
    if not isinstance(value, dict) or set(value) != ROW_FIELDS:
        raise ValueError("feature row has undeclared or missing fields")
    if value["role"] != role:
        raise ValueError("feature row role differs")
    digests = [
        bytes.fromhex(require_sha256(value[name], f"feature row {name}"))
        for name in ("id", "cluster", "positionFamily")
    ]
    if previous_id is not None and digests[0] <= previous_id:
        raise ValueError("feature row IDs are not unique and strictly sorted")
    fixed_cp = value["fixedCp"]
    target = value["target"]
    if (
        isinstance(fixed_cp, bool)
        or not isinstance(fixed_cp, (int, float))
        or not math.isfinite(float(fixed_cp))
    ):
        raise ValueError("fixedCp must be finite")
    if (
        isinstance(target, bool)
        or not isinstance(target, (int, float))
        or not math.isfinite(float(target))
        or not 0 <= float(target) <= 1
    ):
        raise ValueError("target must be a finite probability")
    indices = value["indices"]
    data = value["data"]
    if (
        not isinstance(indices, list)
        or not isinstance(data, list)
        or len(indices) != len(data)
    ):
        raise ValueError("sparse feature vectors differ in length")
    if any(
        isinstance(index, bool)
        or not isinstance(index, int)
        or not 0 <= index < parameters
        for index in indices
    ):
        raise ValueError("sparse feature index is invalid")
    if any(
        indices[index] >= indices[index + 1]
        for index in range(len(indices) - 1)
    ):
        raise ValueError("sparse feature indices are not strictly sorted")
    packed_data: list[float] = []
    for item in data:
        if (
            isinstance(item, bool)
            or not isinstance(item, (int, float))
            or not math.isfinite(float(item))
            or float(item) == 0
        ):
            raise ValueError("sparse feature values must be finite and nonzero")
        packed_data.append(float(item))
    return (
        digests[0],
        digests[1],
        digests[2],
        float(fixed_cp),
        float(target),
        indices,
        packed_data,
    )


def load_split(
    sample_dir: Path,
    sample: dict[str, Any],
    name: str,
    role: str,
    parameters: int,
    solver: Any,
) -> tuple[Any, dict[Path, str], dict[str, str]]:
    entry = sample["hce"][name]
    feature_path = resolve_sample_path(
        sample_dir, entry.get("path"), f"HCE {name} path"
    )
    sidecar_path = resolve_sample_path(
        sample_dir, entry.get("manifest"), f"HCE {name} manifest"
    )
    feature_bytes = feature_path.read_bytes()
    sidecar_bytes = sidecar_path.read_bytes()
    feature_sha256 = sha256_bytes(feature_bytes)
    sidecar_sha256 = sha256_bytes(sidecar_bytes)
    if (
        feature_sha256
        != require_sha256(entry.get("sha256"), f"HCE {name} sha256")
        or sidecar_sha256
        != require_sha256(
            entry.get("manifestSha256"), f"HCE {name} manifestSha256"
        )
        or len(feature_bytes) != entry.get("bytes")
    ):
        raise ValueError(f"HCE {name} sample hash/size binding failed")
    sidecar = parse_json_bytes(sidecar_bytes, str(sidecar_path))
    if (
        not isinstance(sidecar, dict)
        or sidecar.get("schemaVersion") != 1
        or sidecar.get("status") != STATUS
        or sidecar.get("role") != role
    ):
        raise ValueError(f"HCE {name} sidecar sample marker differs")
    require_false(sidecar.get("fitAllowed"), f"HCE {name} sidecar fitAllowed")
    output = sidecar.get("output")
    if (
        not isinstance(output, dict)
        or output.get("path") != feature_path.name
        or output.get("sha256") != feature_sha256
        or output.get("bytes") != len(feature_bytes)
        or output.get("rows") != LABELLED_ROLE_COUNTS[role]
    ):
        raise ValueError(f"HCE {name} sidecar output binding failed")
    provenance = sidecar.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("role") != role
        or provenance.get("rows") != LABELLED_ROLE_COUNTS[role]
        or provenance.get("selectionManifestSha256")
        != sample["selection"]["manifestSha256"]
        or provenance.get("sourceSnapshotSha256")
        != sample["sourceFixture"]["sha256"]
        or provenance.get("inputSidecarSha256")
        != [sample["teacher"]["manifestSha256"]]
    ):
        raise ValueError(f"HCE {name} provenance binding failed")
    contract_hashes = {
        key: require_sha256(provenance.get(key), f"HCE {name} {key}")
        for key in (
            "teacherManifestSha256",
            "selectionManifestSha256",
            "selectionContractSha256",
            "sourceSnapshotSha256",
        )
    }
    lines = feature_bytes.decode("utf-8").splitlines()
    if (
        len(lines) != LABELLED_ROLE_COUNTS[role]
        or not feature_bytes.endswith(b"\n")
    ):
        raise ValueError(f"HCE {name} row count or final newline differs")
    indptr = [0]
    indices: list[int] = []
    data: list[float] = []
    fixed_cp: list[float] = []
    targets: list[float] = []
    row_ids: list[bytes] = []
    cluster_ids: list[bytes] = []
    family_ids: list[bytes] = []
    previous_id: bytes | None = None
    for number, line in enumerate(lines, 1):
        row = strict_feature_row(
            parse_json_bytes(line.encode("utf-8"), f"{feature_path}:{number}"),
            role,
            parameters,
            previous_id,
        )
        row_id, cluster_id, family_id, cp, target, columns, values = row
        previous_id = row_id
        row_ids.append(row_id)
        cluster_ids.append(cluster_id)
        family_ids.append(family_id)
        fixed_cp.append(cp)
        targets.append(target)
        indices.extend(columns)
        data.extend(values)
        indptr.append(len(indices))
    matrix = sparse.csr_matrix(
        (
            np.asarray(data, dtype=np.float64),
            np.asarray(indices, dtype=np.int32),
            np.asarray(indptr, dtype=np.int64),
        ),
        shape=(len(lines), parameters),
    )
    dataset = solver.Dataset(
        matrix=matrix,
        fixed_cp=np.asarray(fixed_cp, dtype=np.float64),
        target=np.asarray(targets, dtype=np.float64),
        role=role,
        source_sha256=feature_sha256,
        row_ids=np.asarray(row_ids, dtype="|S32"),
        cluster_ids=np.asarray(cluster_ids, dtype="|S32"),
        position_family_ids=np.asarray(family_ids, dtype="|S32"),
        metadata={
            "input_disposition": STATUS,
            **{
                key.removesuffix("Sha256")
                .replace("Manifest", "_manifest")
                .replace("Contract", "_contract")
                .replace("Snapshot", "_snapshot")
                .lower()
                + "_sha256": value
                for key, value in contract_hashes.items()
            },
        },
    )
    return (
        dataset,
        {
            feature_path: feature_sha256,
            sidecar_path: sidecar_sha256,
        },
        contract_hashes,
    )


def assert_disjoint_sample(train: Any, validation: Any) -> None:
    for label, left, right in (
        ("row ID", train.row_ids, validation.row_ids),
        ("cluster", train.cluster_ids, validation.cluster_ids),
        (
            "position family",
            train.position_family_ids,
            validation.position_family_ids,
        ),
    ):
        overlap = set(left.tolist()).intersection(right.tolist())
        if overlap:
            item = bytes(next(iter(overlap))).hex()
            raise ValueError(f"sample train/validation {label} overlap: {item}")


def contains_key(value: Any, forbidden: str) -> bool:
    if isinstance(value, dict):
        return forbidden in value or any(
            contains_key(item, forbidden) for item in value.values()
        )
    if isinstance(value, list):
        return any(contains_key(item, forbidden) for item in value)
    return False


def run_diagnostic(
    sample_manifest_path: Path,
    center_path: Path,
    scales_path: Path,
    output: Path,
) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2]
    sample_manifest_path = sample_manifest_path.resolve()
    center_path = center_path.resolve()
    scales_path = scales_path.resolve()
    output = output.resolve()
    if output.is_relative_to(root):
        raise ValueError("sample diagnostic output must stay outside the Git tree")
    if output.exists():
        raise FileExistsError("refusing to overwrite --output")
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise ValueError(
            "sample diagnostic requires NumPy 2.3.5 and SciPy 1.17.0; got "
            f"NumPy {np.__version__}, SciPy {scipy.__version__}"
        )
    solver, solver_sha256 = load_solver(root)
    feature_path = root / "eval/training/hce-r3-features-v1.json"
    fit_path = root / "eval/training/hce-r3-fit-v1.json"
    teacher_path = root / "eval/training/teacher-sf18-100kn-v1.json"
    feature_bytes = feature_path.read_bytes()
    fit_bytes = fit_path.read_bytes()
    teacher_bytes = teacher_path.read_bytes()
    teacher_sha256 = sha256_bytes(teacher_bytes)
    features = parse_json_bytes(feature_bytes, str(feature_path))
    fit = parse_json_bytes(fit_bytes, str(fit_path))
    if (
        fit["matrix"].get("requiredInputDisposition")
        != solver.PRODUCTION_INPUT_DISPOSITION
    ):
        raise ValueError("production fitter disposition contract drifted")
    parameters = int(features["parameterCounts"]["total"])
    sample_bytes = sample_manifest_path.read_bytes()
    sample = exact_preliminary_manifest(
        parse_json_bytes(sample_bytes, str(sample_manifest_path))
    )
    sample_dir = sample_manifest_path.parent.resolve()
    train, train_hashes, train_contracts = load_split(
        sample_dir,
        sample,
        "sharedTrain",
        "shared-train",
        parameters,
        solver,
    )
    validation, validation_hashes, validation_contracts = load_split(
        sample_dir,
        sample,
        "validation",
        "hce-validation",
        parameters,
        solver,
    )
    if train.rows + validation.rows > MAX_SELECTED_ROWS:
        raise ValueError("sample diagnostic exceeded its immutable row bound")
    if train_contracts != validation_contracts:
        raise ValueError("sample train/validation provenance contracts differ")
    if train_contracts["teacherManifestSha256"] != teacher_sha256:
        raise ValueError(
            "sample feature provenance does not bind the frozen teacher manifest"
        )
    assert_disjoint_sample(train, validation)
    center_sha256 = sha256_file(center_path)
    scales_sha256 = sha256_file(scales_path)
    center = solver.load_integer_vector(center_path, parameters, "center")
    scales = solver.load_integer_vector(scales_path, parameters, "scales")
    center_digest = solver.integer_vector_digest(center)
    scales_digest = solver.integer_vector_digest(scales)
    if center_digest != fit["objective"]["centerValueSha256"]:
        raise ValueError("center is not the frozen r71 + zero-R3 vector")
    if scales_digest != fit["objective"]["scalesValueSha256"]:
        raise ValueError("scales are not the frozen R3 vector")
    baseline_parameters = int(features["parameterCounts"]["baseline"])
    if np.any(center[baseline_parameters:] != 0) or np.any(scales <= 0):
        raise ValueError("sample center/scales contract differs")
    k_fit = solver.fit_baseline_k(train, center, fit["calibration"])
    k = float(k_fit["value"])
    baseline_validation = solver.plain_loss(center, validation, k)
    safe_family = next(
        family
        for family in features["families"]
        if family["id"] == "safe-mobility"
    )
    safe_indices = tuple(
        range(
            int(safe_family["startId"]),
            int(safe_family["startId"]) + int(safe_family["count"]),
        )
    )
    diagnostics: list[dict[str, Any]] = []
    lowest: dict[str, Any] | None = None
    for round_id in ("R3.0", "R3.1"):
        for regularization_value in fit["objective"]["lambdaGrid"]:
            regularization = float(regularization_value)
            if regularization <= 0:
                raise ValueError("frozen sample lambda grid includes zero")
            fitted = solver.fit_candidate(
                train,
                validation,
                center,
                scales,
                k,
                regularization,
                int(fit["solver"]["maxIterations"]),
                round_id,
                safe_indices,
                fit["solver"],
            )
            diagnostic = {
                key: value
                for key, value in fitted.items()
                if key != "weights"
            }
            diagnostic["baselineValidationLoss"] = baseline_validation
            diagnostic["validationLossChange"] = (
                fitted["validationLoss"] - baseline_validation
            )
            if round_id == "R3.1":
                ablated = fitted["weights"].copy()
                ablated[list(safe_indices)] = 0
                diagnostic["safeMobilityAblationValidationLoss"] = (
                    solver.plain_loss(ablated, validation, k)
                )
            diagnostics.append(diagnostic)
            if fitted["success"] and (
                lowest is None
                or fitted["validationLoss"] < lowest["validationLoss"]
            ):
                lowest = {
                    "round": round_id,
                    "lambda": regularization,
                    "validationLoss": fitted["validationLoss"],
                    "validationLossChange": (
                        fitted["validationLoss"] - baseline_validation
                    ),
                }
    implementation_paths = (
        Path(__file__).resolve(),
        root / "tools/training/hce-fit.py",
        root / "test/training/hce-r3-pack-stream.js",
        root / "test/training/hce-r3-linear.js",
        root / "test/training/hce-r3-baseline.js",
        root / "experiments/wasm/src/eval.rs",
        root / "assets/chessy-ai-fast.wasm",
        feature_path,
        fit_path,
        teacher_path,
    )
    implementation_hashes = {
        filename: sha256_file(filename) for filename in implementation_paths
    }
    implementation_hashes[root / "tools/training/hce-fit.py"] = solver_sha256
    implementation_hashes[feature_path] = sha256_bytes(feature_bytes)
    implementation_hashes[fit_path] = sha256_bytes(fit_bytes)
    implementation_hashes[teacher_path] = teacher_sha256
    sample_sha256 = sha256_bytes(sample_bytes)
    payload = {
        "schemaVersion": 1,
        "status": REPORT_STATUS,
        "sampleOnly": True,
        "preliminary": True,
        "fitAllowed": False,
        "publishableArtifact": False,
        "candidateProduced": False,
        "weightsEmitted": False,
        "qualityClaimAllowed": False,
        "profile": PROFILE,
        "inputs": {
            "sampleManifestSha256": sample_sha256,
            "sourceFixtureSha256": sample["sourceFixture"]["sha256"],
            "selectionManifestSha256": sample["selection"]["manifestSha256"],
            "teacherShardSha256": sample["teacher"]["outputSha256"],
            "teacherSidecarSha256": sample["teacher"]["manifestSha256"],
            "teacherExclusionSha256": sample["teacher"]["exclusionSha256"],
            "trainFeatureSha256": train.source_sha256,
            "validationFeatureSha256": validation.source_sha256,
            "frozenTeacherManifestSha256": train_contracts[
                "teacherManifestSha256"
            ],
            "centerFileSha256": center_sha256,
            "scalesFileSha256": scales_sha256,
            "centerValueSha256": center_digest,
            "scalesValueSha256": scales_digest,
            "inputDisposition": STATUS,
        },
        "rows": {
            "selected": MAX_SELECTED_ROWS,
            "labelled": LABELLED_ROWS,
            "excluded": 1,
            "exclusionReasons": sample["teacher"]["exclusionReasons"],
            "sharedTrain": train.rows,
            "hceValidation": validation.rows,
            "hceTestOpened": 0,
        },
        "isolation": {
            "rowIdsDisjoint": True,
            "clustersDisjoint": True,
            "positionFamiliesDisjoint": True,
        },
        "baseline": {
            "frozenK": k_fit,
            "validationLoss": baseline_validation,
        },
        "lambdaGrid": [
            float(value) for value in fit["objective"]["lambdaGrid"]
        ],
        "diagnostics": diagnostics,
        "lambdaSelected": False,
        "roundSelected": False,
        "numericallyLowestDiagnosticNoSelection": lowest,
        "testOpened": False,
        "runtimeFilesChanged": False,
        "productionPackerInvoked": False,
        "productionFitterCliInvoked": False,
        "solver": {
            "mathImplementationSha256": implementation_hashes[
                root / "tools/training/hce-fit.py"
            ],
            "diagnosticImplementationSha256": implementation_hashes[
                Path(__file__).resolve()
            ],
            "featureManifestSha256": implementation_hashes[feature_path],
            "fitContractSha256": implementation_hashes[fit_path],
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "maxIterations": int(fit["solver"]["maxIterations"]),
            "threads": 1,
        },
        "limitations": [
            "The 40 rows are a checked-in CC0 opening fixture, not an official Lichess evaluation snapshot.",
            "The train and validation counts are far below those preregistered for HCE R3.",
            "Validation metrics are mechanism diagnostics only and cannot select a lambda, round, or candidate.",
            "No hce-test row was read and no weights are present in this report.",
        ],
    }
    if (
        payload["candidateProduced"] is not False
        or payload["weightsEmitted"] is not False
        or contains_key(payload, "weights")
    ):
        raise RuntimeError("sample diagnostic attempted to emit a candidate")
    publication_inputs = {
        sample_manifest_path: sample_sha256,
        center_path: center_sha256,
        scales_path: scales_sha256,
        **train_hashes,
        **validation_hashes,
        **implementation_hashes,
    }
    solver.publish_json_no_replace(output, payload, publication_inputs)
    return payload


def write_test_sample(directory: Path, status: str = STATUS) -> Path:
    rows_by_role: dict[str, list[dict[str, Any]]] = {}
    for role, count in (
        ("shared-train", LABELLED_ROLE_COUNTS["shared-train"]),
        ("hce-validation", LABELLED_ROLE_COUNTS["hce-validation"]),
    ):
        rows = []
        offset = 0 if role == "shared-train" else 100
        for index in range(count):
            number = offset + index
            rows.append(
                {
                    "id": hashlib.sha256(f"id-{number}".encode()).hexdigest(),
                    "cluster": hashlib.sha256(
                        f"cluster-{number}".encode()
                    ).hexdigest(),
                    "positionFamily": hashlib.sha256(
                        f"family-{number}".encode()
                    ).hexdigest(),
                    "role": role,
                    "fixedCp": number - 20,
                    "target": (index + 1) / (count + 1),
                    "indices": [number % 3],
                    "data": [1],
                }
            )
        rows_by_role[role] = sorted(rows, key=lambda item: item["id"])
    hce: dict[str, Any] = {}
    common_contracts = {
        "teacherManifestSha256": "1" * 64,
        "selectionManifestSha256": "2" * 64,
        "selectionContractSha256": "3" * 64,
        "sourceSnapshotSha256": "4" * 64,
    }
    teacher_sidecar_sha = "5" * 64
    for name, role in (
        ("sharedTrain", "shared-train"),
        ("validation", "hce-validation"),
    ):
        filename = directory / f"{role}.features.ndjson"
        encoded = (
            "\n".join(
                json.dumps(row, separators=(",", ":"), sort_keys=True)
                for row in rows_by_role[role]
            )
            + "\n"
        ).encode()
        filename.write_bytes(encoded)
        feature_sha = sha256_bytes(encoded)
        sidecar = {
            "schemaVersion": 1,
            "status": status,
            "fitAllowed": False,
            "role": role,
            "output": {
                "path": filename.name,
                "rows": len(rows_by_role[role]),
                "bytes": len(encoded),
                "sha256": feature_sha,
            },
            "provenance": {
                "role": role,
                "rows": len(rows_by_role[role]),
                "inputSidecarSha256": [teacher_sidecar_sha],
                **common_contracts,
            },
        }
        sidecar_path = Path(str(filename) + ".manifest.json")
        sidecar_bytes = (
            json.dumps(sidecar, separators=(",", ":"), sort_keys=True) + "\n"
        ).encode()
        sidecar_path.write_bytes(sidecar_bytes)
        hce[name] = {
            "status": status,
            "fitAllowed": False,
            "path": filename.name,
            "sha256": feature_sha,
            "bytes": len(encoded),
            "rows": len(rows_by_role[role]),
            "manifest": sidecar_path.name,
            "manifestSha256": sha256_bytes(sidecar_bytes),
        }
    manifest = {
        "schema": "chessy.training-sample.v1",
        "status": status,
        "fitAllowed": False,
        "publishableArtifact": False,
        "profile": PROFILE,
        "sourceFixture": {
            "sha256": common_contracts["sourceSnapshotSha256"],
            "officialEvaluationSnapshot": False,
        },
        "certificationBoundary": {
            "status": "awaiting-opening-freeze",
            "productionFreeze": False,
        },
        "selection": {
            "state": "mechanism-test-selection-only",
            "fitAllowed": False,
            "rows": MAX_SELECTED_ROWS,
            "byRole": SELECTION_ROLE_COUNTS,
            "manifestSha256": common_contracts["selectionManifestSha256"],
        },
        "teacher": {
            "state": "pinned-teacher-labels-sample-only",
            "fitAllowed": False,
            "rows": LABELLED_ROWS,
            "excludedRows": 1,
            "byRole": LABELLED_ROLE_COUNTS,
            "manifestSha256": teacher_sidecar_sha,
            "outputSha256": "6" * 64,
            "exclusionSha256": "7" * 64,
            "exclusionReasons": EXCLUSION_REASONS,
        },
        "nnue": {
            "status": "validated-sample-only-pinned-teacher-inputs",
            "fitAllowed": False,
        },
        "hce": hce,
    }
    filename = directory / "sample-manifest.json"
    filename.write_text(
        json.dumps(manifest, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return filename


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="chessy-sample-convex-test-") as temp:
        directory = Path(temp)
        manifest_path = write_test_sample(directory)
        sample = exact_preliminary_manifest(
            parse_json_bytes(manifest_path.read_bytes(), str(manifest_path))
        )
        class TestSolver:
            Dataset = load_solver(
                Path(__file__).resolve().parents[2]
            )[0].Dataset

        train, _, contracts = load_split(
            directory,
            sample,
            "sharedTrain",
            "shared-train",
            3,
            TestSolver,
        )
        validation, _, validation_contracts = load_split(
            directory,
            sample,
            "validation",
            "hce-validation",
            3,
            TestSolver,
        )
        assert_disjoint_sample(train, validation)
        if train.rows != 17 or validation.rows != 4:
            raise AssertionError("preliminary sample row bound differs")
        if contracts != validation_contracts:
            raise AssertionError("sample split contracts differ")

        production = parse_json_bytes(
            manifest_path.read_bytes(), str(manifest_path)
        )
        production["status"] = "authenticated-production-input"
        try:
            exact_preliminary_manifest(production)
        except ValueError:
            pass
        else:
            raise AssertionError("sample diagnostic accepted production input")

        tampered = parse_json_bytes(
            manifest_path.read_bytes(), str(manifest_path)
        )
        tampered["fitAllowed"] = True
        try:
            exact_preliminary_manifest(tampered)
        except ValueError:
            pass
        else:
            raise AssertionError("sample diagnostic accepted fitAllowed=true")

        sidecar_path = directory / "shared-train.features.ndjson.manifest.json"
        sidecar = parse_json_bytes(sidecar_path.read_bytes(), str(sidecar_path))
        sidecar["status"] = "authenticated-production-input"
        encoded = (
            json.dumps(sidecar, separators=(",", ":"), sort_keys=True) + "\n"
        ).encode()
        sidecar_path.write_bytes(encoded)
        sample["hce"]["sharedTrain"]["manifestSha256"] = sha256_bytes(encoded)
        try:
            load_split(
                directory,
                sample,
                "sharedTrain",
                "shared-train",
                3,
                TestSolver,
            )
        except ValueError:
            pass
        else:
            raise AssertionError(
                "sample diagnostic accepted a production sidecar marker"
            )
    print("sample-only HCE convex diagnostic self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--sample-manifest")
    parser.add_argument("--center")
    parser.add_argument("--scales")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.self_test:
        if any(
            getattr(args, name)
            for name in ("sample_manifest", "center", "scales", "output")
        ):
            parser.error("--self-test cannot be combined with run arguments")
        self_test()
        return
    missing = [
        name
        for name in ("sample_manifest", "center", "scales", "output")
        if not getattr(args, name)
    ]
    if missing:
        parser.error(
            "missing "
            + ", ".join("--" + name.replace("_", "-") for name in missing)
        )
    payload = run_diagnostic(
        Path(args.sample_manifest),
        Path(args.center),
        Path(args.scales),
        Path(args.output),
    )
    print(
        f"completed {len(payload['diagnostics'])} bounded convex diagnostics "
        f"on {payload['rows']['sharedTrain']} train and "
        f"{payload['rows']['hceValidation']} validation rows"
    )
    print(f"status: {payload['status']}")
    print("candidate produced: false")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"sample-hce-convex: {error}") from error
