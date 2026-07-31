#!/usr/bin/env python3
"""Stream authenticated teacher shards into one memory-bounded HCE CSR-v2 NPZ."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import BinaryIO

import numpy as np


PARAMETERS = 965
MATRIX_SCHEMA = "chessy.hce-csr.v2"
PRODUCTION_INPUT_DISPOSITION = "authenticated-production-input"
ALLOWED_ROLES = {"shared-train", "hce-validation", "hce-test"}


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def integer_vector(filename: Path, length: int, label: str) -> tuple[np.ndarray, str]:
    values = json.loads(filename.read_text(encoding="utf-8"))
    if not isinstance(values, list) or len(values) != length or any(
        isinstance(value, bool) or not isinstance(value, int) for value in values
    ):
        raise ValueError(f"{label} must contain exactly {length} JSON integers")
    encoded = json.dumps(values, separators=(",", ":")).encode("utf-8")
    return np.asarray(values, dtype=np.float64), hashlib.sha256(encoded).hexdigest()


def require_sha256(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(char not in "0123456789abcdef" for char in value)
    ):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")
    return value


def float32_number(
    value: object, label: str, *, probability: bool = False, nonzero: bool = False
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    try:
        number = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"{label} must be finite") from error
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    if probability and not 0 <= number <= 1:
        raise ValueError(f"{label} must be a probability")
    if nonzero and number == 0:
        raise ValueError(f"{label} must be nonzero")
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        packed = np.float32(number)
    if not np.isfinite(packed):
        raise ValueError(f"{label} is not representable as finite float32")
    if number != 0 and packed == 0:
        raise ValueError(f"{label} underflows to zero in float32")
    return float(packed)


def strict_row(value: object, role: str, previous_id: bytes | None) -> tuple:
    if not isinstance(value, dict) or set(value) != {
        "id",
        "cluster",
        "positionFamily",
        "role",
        "fixedCp",
        "target",
        "indices",
        "data",
    }:
        raise ValueError("feature stream row has undeclared or missing fields")
    if value["role"] != role:
        raise ValueError("feature stream role differs")
    digests = []
    for name in ("id", "cluster", "positionFamily"):
        text = value[name]
        if not isinstance(text, str) or len(text) != 64 or any(
            char not in "0123456789abcdef" for char in text
        ):
            raise ValueError(f"feature stream {name} is not SHA-256")
        digests.append(bytes.fromhex(text))
    if previous_id is not None and digests[0] <= previous_id:
        raise ValueError("feature stream IDs are not strictly sorted")
    fixed_cp = float32_number(value["fixedCp"], "fixedCp")
    target = float32_number(value["target"], "target", probability=True)
    indices = value["indices"]
    data = value["data"]
    if not isinstance(indices, list) or not isinstance(data, list) or (
        len(indices) != len(data)
    ):
        raise ValueError("sparse index/data lengths differ")
    if any(
        isinstance(index, bool) or not isinstance(index, int) or not (
            0 <= index < PARAMETERS
        )
        for index in indices
    ):
        raise ValueError("sparse feature index is invalid")
    if any(indices[index] >= indices[index + 1] for index in range(len(indices) - 1)):
        raise ValueError("sparse feature indices are not strictly sorted")
    packed_data = np.asarray(
        [
            float32_number(item, "sparse feature value", nonzero=True)
            for item in data
        ],
        dtype="<f4",
    )
    return (
        digests,
        fixed_cp,
        target,
        np.asarray(indices, dtype="<u2"),
        packed_data,
    )


def append_int64(stream: BinaryIO, value: int) -> None:
    stream.write(struct.pack("<q", value))


def require_production_disposition(summary: object) -> str:
    if (
        not isinstance(summary, dict)
        or summary.get("status") != PRODUCTION_INPUT_DISPOSITION
        or summary.get("mode") != "production"
        or summary.get("sampleOnly") is not False
        or "fitAllowed" in summary
    ):
        raise ValueError(
            "feature stream is not an authenticated production input"
        )
    return PRODUCTION_INPUT_DISPOSITION


def self_test() -> None:
    row = {
        "id": "0" * 64,
        "cluster": "1" * 64,
        "positionFamily": "2" * 64,
        "role": "shared-train",
        "fixedCp": 12.5,
        "target": 0.65,
        "indices": [0, PARAMETERS - 1],
        "data": [-1.0, 0.5],
    }
    strict_row(row, "shared-train", None)
    cases = (
        ("fixedCp", True),
        ("fixedCp", 1e100),
        ("target", True),
        ("target", 1.1),
        ("data", [True]),
        ("data", [1e100]),
        ("data", [1e-100]),
    )
    for field, replacement in cases:
        invalid = dict(row)
        invalid[field] = replacement
        if field == "data":
            invalid["indices"] = [0]
        try:
            strict_row(invalid, "shared-train", None)
        except ValueError:
            continue
        raise AssertionError(f"strict_row accepted invalid {field}: {replacement!r}")
    require_production_disposition(
        {
            "status": PRODUCTION_INPUT_DISPOSITION,
            "mode": "production",
            "sampleOnly": False,
        }
    )
    for disposition in (
        {
            "status": "sample-only-not-fit-eligible",
            "mode": "sample-only",
            "sampleOnly": True,
            "fitAllowed": False,
        },
        {
            "status": PRODUCTION_INPUT_DISPOSITION,
            "mode": "production",
            "sampleOnly": False,
            "fitAllowed": True,
        },
    ):
        try:
            require_production_disposition(disposition)
        except ValueError:
            continue
        raise AssertionError("packer accepted a non-production disposition")
    print("HCE packer self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--role", choices=sorted(ALLOWED_ROLES))
    parser.add_argument("--center")
    parser.add_argument("--scales")
    parser.add_argument("--output")
    args = parser.parse_args()
    if np.__version__ != "2.3.5":
        raise SystemExit(
            "pinned matrix packer requires NumPy 2.3.5; got " + np.__version__
        )
    if args.self_test:
        self_test()
        return
    missing = [
        name
        for name, value in {
            "--input": args.input,
            "--role": args.role,
            "--center": args.center,
            "--scales": args.scales,
            "--output": args.output,
        }.items()
        if not value
    ]
    if missing:
        parser.error("missing " + ", ".join(missing))

    root = Path(__file__).resolve().parents[2]
    feature_path = root / "eval/training/hce-r3-features-v1.json"
    fit_path = root / "eval/training/hce-r3-fit-v1.json"
    teacher_path = root / "eval/training/teacher-sf18-100kn-v1.json"
    feature = json.loads(feature_path.read_text(encoding="utf-8"))
    fit = json.loads(fit_path.read_text(encoding="utf-8"))
    if (
        fit.get("matrix", {}).get("requiredInputDisposition")
        != PRODUCTION_INPUT_DISPOSITION
    ):
        raise SystemExit(
            "fit contract does not require production input disposition"
        )
    center_path = Path(args.center).resolve()
    scales_path = Path(args.scales).resolve()
    center, center_digest = integer_vector(center_path, PARAMETERS, "center")
    scales, scales_digest = integer_vector(scales_path, PARAMETERS, "scales")
    if center_digest != fit["objective"]["centerValueSha256"] or np.any(
        center[753:] != 0
    ):
        raise SystemExit("center is not the frozen r69 + zero-R3 vector")
    if scales_digest != fit["objective"]["scalesValueSha256"] or np.any(
        scales <= 0
    ):
        raise SystemExit("scales are not the frozen R3 vector")

    inputs = [Path(item).resolve() for item in args.input]
    if len(set(inputs)) != len(inputs) or any(not item.is_file() for item in inputs):
        raise SystemExit("--input paths must be unique existing files")
    output = Path(args.output).resolve()
    sidecar = output.with_suffix(output.suffix + ".manifest.json")
    if output.suffix != ".npz":
        raise SystemExit("--output must end in .npz")
    if output.exists() or sidecar.exists():
        raise SystemExit("refusing to overwrite output or sidecar")
    output.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "node",
        str(root / "test/training/hce-r3-pack-stream.js"),
        "--role",
        args.role,
    ]
    for filename in inputs:
        command.extend(("--input", str(filename)))

    with tempfile.TemporaryDirectory(
        prefix=".chessy-hce-pack-", dir=output.parent
    ) as temporary:
        temp = Path(temporary)
        files = {
            name: (temp / f"{name}.bin").open("wb")
            for name in (
                "indptr",
                "indices",
                "data",
                "fixed_cp",
                "target",
                "row_id",
                "cluster_id",
                "position_family_id",
            )
        }
        append_int64(files["indptr"], 0)
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        assert process.stdout is not None
        rows = 0
        nonzeros = 0
        previous_id: bytes | None = None
        try:
            for number, line in enumerate(process.stdout, 1):
                if not line.strip():
                    raise ValueError(
                        f"feature stream line {number}: blank rows are forbidden"
                    )
                try:
                    row = strict_row(json.loads(line), args.role, previous_id)
                except Exception as error:
                    raise ValueError(f"feature stream line {number}: {error}") from error
                digests, fixed_cp, target, indices, data = row
                previous_id = digests[0]
                files["row_id"].write(digests[0])
                files["cluster_id"].write(digests[1])
                files["position_family_id"].write(digests[2])
                files["fixed_cp"].write(struct.pack("<f", fixed_cp))
                files["target"].write(struct.pack("<f", target))
                files["indices"].write(indices.tobytes())
                files["data"].write(data.tobytes())
                rows += 1
                nonzeros += len(indices)
                append_int64(files["indptr"], nonzeros)
        except BaseException:
            process.kill()
            process.wait()
            if process.stderr is not None:
                process.stderr.close()
            raise
        finally:
            for stream in files.values():
                stream.close()
        stderr = process.stderr.read() if process.stderr is not None else ""
        code = process.wait()
        if code != 0:
            raise SystemExit(
                "feature stream failed with status "
                + str(code)
                + (": " + stderr.strip() if stderr.strip() else "")
            )
        if rows == 0:
            raise SystemExit("selected role produced zero HCE rows")
        summary_lines = [line for line in stderr.splitlines() if line.strip()]
        try:
            summary = json.loads(summary_lines[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise SystemExit("feature stream did not emit its provenance summary") from error
        if summary.get("rows") != rows or summary.get("role") != args.role:
            raise SystemExit("feature-stream summary row/role mismatch")
        try:
            input_disposition = require_production_disposition(summary)
            teacher_sha = require_sha256(
                summary.get("teacherManifestSha256"),
                "feature-stream teacherManifestSha256",
            )
            selection_manifest_sha = require_sha256(
                summary.get("selectionManifestSha256"),
                "feature-stream selectionManifestSha256",
            )
            selection_contract_sha = require_sha256(
                summary.get("selectionContractSha256"),
                "feature-stream selectionContractSha256",
            )
            source_snapshot_sha = require_sha256(
                summary.get("sourceSnapshotSha256"),
                "feature-stream sourceSnapshotSha256",
            )
            input_hashes = summary.get("inputSha256")
            sidecar_hashes = summary.get("inputSidecarSha256")
            if (
                not isinstance(input_hashes, list)
                or not isinstance(sidecar_hashes, list)
                or len(input_hashes) != len(inputs)
                or len(sidecar_hashes) != len(inputs)
            ):
                raise ValueError("feature-stream input hash vectors differ")
            input_hashes = [
                require_sha256(value, f"feature-stream inputSha256[{index}]")
                for index, value in enumerate(input_hashes)
            ]
            sidecar_hashes = [
                require_sha256(
                    value, f"feature-stream inputSidecarSha256[{index}]"
                )
                for index, value in enumerate(sidecar_hashes)
            ]
            inventory = summary.get("providedShardInventory")
            if not isinstance(inventory, list) or len(inventory) != len(inputs):
                raise ValueError(
                    "feature-stream provided shard inventory differs"
                )
            inventory_fields = {
                "index",
                "teacherPath",
                "teacherRows",
                "teacherSha256",
                "teacherSidecarPath",
                "teacherSidecarSha256",
                "selectionShardPath",
                "selectionShardIndex",
                "selectionShardRows",
                "selectionShardSha256",
            }
            for index, item in enumerate(inventory):
                if not isinstance(item, dict) or set(item) != inventory_fields:
                    raise ValueError(
                        f"feature-stream shard inventory[{index}] is malformed"
                    )
                if item["index"] != index:
                    raise ValueError(
                        f"feature-stream shard inventory[{index}] index differs"
                    )
                for name in (
                    "teacherRows",
                    "selectionShardIndex",
                    "selectionShardRows",
                ):
                    value = item[name]
                    if (
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value < 0
                    ):
                        raise ValueError(
                            f"feature-stream shard inventory[{index}].{name} "
                            "must be a nonnegative integer"
                        )
                for name in (
                    "teacherPath",
                    "teacherSidecarPath",
                    "selectionShardPath",
                ):
                    if not isinstance(item[name], str) or not item[name]:
                        raise ValueError(
                            f"feature-stream shard inventory[{index}].{name} "
                            "must be a path"
                        )
                for name in (
                    "teacherSha256",
                    "teacherSidecarSha256",
                    "selectionShardSha256",
                ):
                    item[name] = require_sha256(
                        item[name],
                        f"feature-stream shard inventory[{index}].{name}",
                    )
                expected_sidecar = Path(
                    str(inputs[index]) + ".manifest.json"
                ).resolve()
                if (
                    Path(item["teacherPath"]).resolve() != inputs[index]
                    or Path(item["teacherSidecarPath"]).resolve()
                    != expected_sidecar
                    or item["teacherSha256"] != input_hashes[index]
                    or item["teacherSidecarSha256"] != sidecar_hashes[index]
                ):
                    raise ValueError(
                        f"feature-stream shard inventory[{index}] "
                        "does not match --input"
                    )
        except (TypeError, ValueError) as error:
            raise SystemExit(f"invalid feature-stream provenance: {error}") from error
        if teacher_sha != sha256_file(teacher_path):
            raise SystemExit("feature-stream teacher manifest hash is not current")
        for index, filename in enumerate(inputs):
            if sha256_file(filename) != input_hashes[index]:
                raise SystemExit(f"{filename}: input changed while packing")
            adjacent = Path(str(filename) + ".manifest.json")
            if (
                not adjacent.is_file()
                or sha256_file(adjacent) != sidecar_hashes[index]
            ):
                raise SystemExit(f"{filename}: sidecar changed while packing")

        arrays = {
            "indptr": np.memmap(
                temp / "indptr.bin", mode="r", dtype="<i8", shape=(rows + 1,)
            ),
            "indices": np.memmap(
                temp / "indices.bin", mode="r", dtype="<u2", shape=(nonzeros,)
            ),
            "data": np.memmap(
                temp / "data.bin", mode="r", dtype="<f4", shape=(nonzeros,)
            ),
            "fixed_cp": np.memmap(
                temp / "fixed_cp.bin", mode="r", dtype="<f4", shape=(rows,)
            ),
            "target": np.memmap(
                temp / "target.bin", mode="r", dtype="<f4", shape=(rows,)
            ),
            "row_id": np.memmap(
                temp / "row_id.bin", mode="r", dtype="|S32", shape=(rows,)
            ),
            "cluster_id": np.memmap(
                temp / "cluster_id.bin", mode="r", dtype="|S32", shape=(rows,)
            ),
            "position_family_id": np.memmap(
                temp / "position_family_id.bin",
                mode="r",
                dtype="|S32",
                shape=(rows,),
            ),
        }
        temporary_npz = temp / "matrix.npz"
        with temporary_npz.open("wb") as stream:
            np.savez(
                stream,
                **arrays,
                shape=np.asarray([rows, PARAMETERS], dtype=np.int64),
                role=np.asarray(args.role),
                matrix_schema=np.asarray(MATRIX_SCHEMA),
                feature_order_sha256=np.asarray(
                    feature["parameterOrder"]["sha256"]
                ),
                feature_manifest_sha256=np.asarray(sha256_file(feature_path)),
                teacher_manifest_sha256=np.asarray(
                    teacher_sha
                ),
                selection_contract_sha256=np.asarray(
                    selection_contract_sha
                ),
                selection_manifest_sha256=np.asarray(
                    selection_manifest_sha
                ),
                source_snapshot_sha256=np.asarray(source_snapshot_sha),
                input_disposition=np.asarray(input_disposition),
                center_value_sha256=np.asarray(center_digest),
                scales_value_sha256=np.asarray(scales_digest),
                score_denominator=np.asarray(24, dtype=np.int64),
            )
        manifest = {
            "schemaVersion": 1,
            "state": "authenticated-hce-csr-v2",
            "role": args.role,
            "rows": rows,
            "nonzeros": nonzeros,
            "inputDisposition": input_disposition,
            "output": {
                "path": output.name,
                "sha256": sha256_file(temporary_npz),
            },
            "inputInventoryScope": "provided-teacher-shards-only",
            "inputs": [
                {
                    "path": str(filename),
                    "rows": inventory[index]["teacherRows"],
                    "sha256": input_hashes[index],
                    "sidecarPath": inventory[index]["teacherSidecarPath"],
                    "sidecarSha256": sidecar_hashes[index],
                    "selectionShard": {
                        "path": inventory[index]["selectionShardPath"],
                        "index": inventory[index]["selectionShardIndex"],
                        "rows": inventory[index]["selectionShardRows"],
                        "sha256": inventory[index]["selectionShardSha256"],
                    },
                }
                for index, filename in enumerate(inputs)
            ],
            "contracts": {
                "packerSha256": sha256_file(Path(__file__).resolve()),
                "streamerSha256": sha256_file(
                    root / "test/training/hce-r3-pack-stream.js"
                ),
                "linearExtractorSha256": sha256_file(
                    root / "test/training/hce-r3-linear.js"
                ),
                "featureManifestSha256": sha256_file(feature_path),
                "fitContractSha256": sha256_file(fit_path),
                "teacherManifestSha256": teacher_sha,
                "selectionManifestSha256": selection_manifest_sha,
                "selectionContractSha256": selection_contract_sha,
                "sourceSnapshotSha256": source_snapshot_sha,
                "inputDisposition": input_disposition,
                "parameterOrderSha256": feature["parameterOrder"]["sha256"],
                "centerValueSha256": center_digest,
                "scalesValueSha256": scales_digest,
                "numpy": np.__version__,
            },
        }
        temporary_sidecar = temp / "matrix.npz.manifest.json"
        temporary_sidecar.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_npz, output)
        os.replace(temporary_sidecar, sidecar)
    print(f"packed {rows} {args.role} rows / {nonzeros} nonzeros")
    print("output SHA-256 " + manifest["output"]["sha256"])


if __name__ == "__main__":
    main()
