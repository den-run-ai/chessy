#!/usr/bin/env python3
"""Stream authenticated teacher shards into one memory-bounded HCE CSR-v2 NPZ."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import stat
import struct
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator

import numpy as np

from _artifact_publication import (
    acquire_output_prefix_lock,
    publish_pair_no_replace,
    refuse_existing_pair,
    release_output_prefix_lock,
    self_test_pair_publication,
)


PARAMETERS = 965
MATRIX_SCHEMA = "chessy.hce-csr.v2"
PRODUCTION_INPUT_DISPOSITION = "authenticated-production-input"
ALLOWED_ROLES = {"shared-train", "hce-validation", "hce-test"}
STREAMER_CLOSURE_SCHEMA = "chessy.hce-streamer-closure.v1"
STREAMER_ENTRYPOINT = "test/training/hce-r3-pack-stream.js"
SNAPSHOT_PACKAGE_PATH = "package.json"
SNAPSHOT_PACKAGE_BYTES = b'{"private":true,"type":"commonjs"}\n'
STREAMER_CLOSURE_STATIC_PATHS = (
    STREAMER_ENTRYPOINT,
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
STREAMER_CLOSURE_LABELS = {
    STREAMER_ENTRYPOINT: "HCE feature streamer",
    "test/training/hce-r3-linear.js": "HCE linear extractor",
    "test/training/hce-r3-baseline.js": "HCE baseline extractor",
    "experiments/wasm/src/eval.rs": "Rust evaluator source",
    "assets/chessy-ai-fast.wasm": "shipped Rust/WASM evaluator",
    "eval/training/hce-r3-features-v1.json": "HCE feature manifest",
    "eval/training/hce-r3-fit-v1.json": "HCE fit contract",
    "eval/training/teacher-sf18-100kn-v1.json": "Stockfish teacher manifest",
}


@dataclass(frozen=True)
class CapturedFile:
    path: Path
    label: str
    data: bytes
    sha256: str


@dataclass(frozen=True)
class CapturedExecutable:
    path: Path
    descriptor: int
    device: int
    inode: int
    bytes: int
    sha256: str
    version: str

    @property
    def execution_path(self) -> str:
        for directory in ("/proc/self/fd", "/dev/fd"):
            candidate = f"{directory}/{self.descriptor}"
            if os.path.exists(candidate):
                return candidate
        raise RuntimeError(
            "retained Node execution requires /proc/self/fd or /dev/fd"
        )


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_descriptor(descriptor: int) -> tuple[str, int]:
    position = os.lseek(descriptor, 0, os.SEEK_CUR)
    digest = hashlib.sha256()
    total = 0
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    finally:
        os.lseek(descriptor, position, os.SEEK_SET)
    return digest.hexdigest(), total


def resolve_node_executable(search_path: str | None = None) -> Path:
    selected = shutil.which("node", path=search_path)
    if selected is None:
        raise RuntimeError("Node executable is unavailable on PATH")
    resolved = Path(selected).resolve(strict=True)
    if resolved.is_symlink() or not resolved.is_file():
        raise RuntimeError(f"Node executable is not a regular file: {resolved}")
    return resolved


def capture_node_executable(filename: Path) -> CapturedExecutable:
    resolved = filename.resolve(strict=True)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(resolved, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o111:
            raise RuntimeError(
                f"Node executable is not an executable regular file: {resolved}"
            )
        sha256, byte_count = sha256_descriptor(descriptor)
        after = os.fstat(descriptor)
        if (
            (before.st_dev, before.st_ino, before.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
            or byte_count != after.st_size
        ):
            raise RuntimeError("Node executable changed while being captured")
        provisional = CapturedExecutable(
            path=resolved,
            descriptor=descriptor,
            device=after.st_dev,
            inode=after.st_ino,
            bytes=byte_count,
            sha256=sha256,
            version="",
        )
        completed = subprocess.run(
            [provisional.execution_path, "--version"],
            pass_fds=(descriptor,),
            env={},
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        version = completed.stdout.strip()
        if (
            completed.stderr
            or not re.fullmatch(
                r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?",
                version,
            )
        ):
            raise RuntimeError("Node executable emitted an invalid version")
        return CapturedExecutable(
            path=resolved,
            descriptor=descriptor,
            device=after.st_dev,
            inode=after.st_ino,
            bytes=byte_count,
            sha256=sha256,
            version=version,
        )
    except BaseException:
        os.close(descriptor)
        raise


@contextmanager
def retained_node_executable(
    filename: Path | None = None,
) -> Iterator[CapturedExecutable]:
    captured = capture_node_executable(
        filename if filename is not None else resolve_node_executable()
    )
    try:
        yield captured
    finally:
        os.close(captured.descriptor)


def assert_captured_executable_unchanged(
    captured: CapturedExecutable,
) -> None:
    retained = os.fstat(captured.descriptor)
    retained_sha256, retained_bytes = sha256_descriptor(
        captured.descriptor
    )
    if (
        (retained.st_dev, retained.st_ino)
        != (captured.device, captured.inode)
        or retained_bytes != captured.bytes
        or retained_sha256 != captured.sha256
    ):
        raise RuntimeError(
            "retained Node executable changed during HCE packing"
        )
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        current_descriptor = os.open(captured.path, flags)
    except OSError as error:
        raise RuntimeError(
            f"selected Node executable became unreadable: {captured.path}"
        ) from error
    try:
        current = os.fstat(current_descriptor)
        current_sha256, current_bytes = sha256_descriptor(
            current_descriptor
        )
    finally:
        os.close(current_descriptor)
    if (
        (current.st_dev, current.st_ino)
        != (captured.device, captured.inode)
        or current_bytes != captured.bytes
        or current_sha256 != captured.sha256
    ):
        raise RuntimeError(
            f"selected Node executable changed during HCE packing: "
            f"{captured.path}"
        )


def capture_files(
    files: Iterable[tuple[Path, str]],
) -> tuple[CapturedFile, ...]:
    captured = []
    for filename, label in files:
        resolved = filename.resolve()
        data = resolved.read_bytes()
        captured.append(
            CapturedFile(
                path=resolved,
                label=label,
                data=data,
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    return tuple(captured)


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


def capture_streamer_closure(root: Path) -> tuple[CapturedFile, ...]:
    root = root.resolve()
    return capture_files(
        (
            (
                filename,
                STREAMER_CLOSURE_LABELS.get(
                    filename.relative_to(root).as_posix(),
                    "HCE streamer closure file "
                    + filename.relative_to(root).as_posix(),
                ),
            )
            for filename in streamer_closure_paths(root)
        )
    )


def captured_closure_sha256(
    root: Path, captured: Iterable[CapturedFile]
) -> str:
    root = root.resolve()
    entries = []
    for captured_file in captured:
        try:
            relative = captured_file.path.relative_to(root).as_posix()
        except ValueError as error:
            raise RuntimeError(
                "captured HCE streamer closure file is outside the repository: "
                + str(captured_file.path)
            ) from error
        entries.append((relative, captured_file.data))
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
    return digest.hexdigest()


def materialize_captured_tree(
    root: Path,
    captured: Iterable[CapturedFile],
    destination: Path,
) -> Path:
    root = root.resolve()
    destination.mkdir(mode=0o700)
    destination.chmod(0o700)
    package_path = destination / SNAPSHOT_PACKAGE_PATH
    with package_path.open("xb") as stream:
        stream.write(SNAPSHOT_PACKAGE_BYTES)
    package_path.chmod(0o400)
    for captured_file in captured:
        try:
            relative = captured_file.path.relative_to(root)
        except ValueError as error:
            raise RuntimeError(
                "cannot materialize an HCE streamer closure file outside "
                f"the repository: {captured_file.path}"
            ) from error
        target = destination / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.parent.chmod(0o700)
        with target.open("xb") as stream:
            stream.write(captured_file.data)
        target.chmod(0o400)
    entrypoint = destination / STREAMER_ENTRYPOINT
    if not entrypoint.is_file():
        raise RuntimeError("captured HCE streamer entrypoint is missing")
    return entrypoint


def assert_captured_files_unchanged(
    captured: Iterable[CapturedFile],
) -> None:
    for captured_file in captured:
        try:
            current = captured_file.path.read_bytes()
        except OSError as error:
            raise RuntimeError(
                f"{captured_file.label} became unreadable during HCE packing: "
                f"{captured_file.path}"
            ) from error
        if current != captured_file.data:
            actual_sha256 = hashlib.sha256(current).hexdigest()
            raise RuntimeError(
                f"{captured_file.label} changed during HCE packing: "
                f"{captured_file.path}; expected={captured_file.sha256}; "
                f"actual={actual_sha256}"
            )


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


def validate_complete_selection_inventory(
    summary: dict, provided: list[dict]
) -> list[dict]:
    if summary.get("selectionInventoryScope") != (
        "complete-selection-shard-inventory"
    ):
        raise ValueError(
            "feature stream did not authenticate the complete selection "
            "shard inventory"
        )
    declared = summary.get("declaredSelectionShardInventory")
    if not isinstance(declared, list) or not declared:
        raise ValueError("declared selection shard inventory is missing")
    if len(declared) != len(provided):
        raise ValueError(
            "teacher inputs do not cover the complete selection shard inventory"
        )
    declared_fields = {"index", "path", "rows", "sha256"}
    expected_by_index: dict[int, dict] = {}
    for position, item in enumerate(declared):
        if not isinstance(item, dict) or set(item) != declared_fields:
            raise ValueError(
                f"declared selection shard inventory[{position}] is malformed"
            )
        index = item["index"]
        rows = item["rows"]
        shard_path = item["path"]
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index != position
            or isinstance(rows, bool)
            or not isinstance(rows, int)
            or rows < 0
            or not isinstance(shard_path, str)
            or not shard_path
            or not Path(shard_path).is_absolute()
        ):
            raise ValueError(
                f"declared selection shard inventory[{position}] is malformed"
            )
        item["sha256"] = require_sha256(
            item["sha256"],
            f"declared selection shard inventory[{position}].sha256",
        )
        expected_by_index[index] = item

    provided_by_index: dict[int, dict] = {}
    for position, item in enumerate(provided):
        index = item["selectionShardIndex"]
        if index in provided_by_index:
            raise ValueError(
                "multiple teacher shards bind the same selection input shard"
            )
        provided_by_index[index] = item
    if set(provided_by_index) != set(expected_by_index):
        raise ValueError(
            "teacher inputs do not cover the complete selection shard inventory"
        )
    for index, expected in expected_by_index.items():
        item = provided_by_index[index]
        if (
            Path(item["selectionShardPath"]).resolve()
            != Path(expected["path"])
            or item["selectionShardRows"] != expected["rows"]
            or item["selectionShardSha256"] != expected["sha256"]
        ):
            raise ValueError(
                "teacher input does not match its declared selection shard"
            )
    return declared


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
    declared = [
        {
            "index": index,
            "path": f"/selection/selection-{index:03d}.ndjson",
            "rows": index + 1,
            "sha256": str(index + 1) * 64,
        }
        for index in range(2)
    ]
    provided = [
        {
            "selectionShardIndex": item["index"],
            "selectionShardPath": item["path"],
            "selectionShardRows": item["rows"],
            "selectionShardSha256": item["sha256"],
        }
        for item in reversed(declared)
    ]
    complete_summary = {
        "selectionInventoryScope": "complete-selection-shard-inventory",
        "declaredSelectionShardInventory": declared,
    }
    validate_complete_selection_inventory(complete_summary, provided)
    inventory_attacks = (
        (complete_summary, provided[:1]),
        (
            complete_summary,
            [
                provided[0],
                dict(
                    provided[1],
                    selectionShardIndex=provided[0]["selectionShardIndex"],
                ),
            ],
        ),
        (
            {
                **complete_summary,
                "declaredSelectionShardInventory": [
                    declared[0],
                    {**declared[1], "path": "/selection/replaced.ndjson"},
                ],
            },
            provided,
        ),
        (
            {
                **complete_summary,
                "selectionInventoryScope": "provided-teacher-shards-only",
            },
            provided,
        ),
    )
    for attack_summary, attack_provided in inventory_attacks:
        try:
            validate_complete_selection_inventory(
                attack_summary, attack_provided
            )
        except ValueError:
            continue
        raise AssertionError(
            "packer accepted an incomplete or mismatched selection inventory"
        )
    with tempfile.TemporaryDirectory(
        prefix="chessy-hce-implementation-self-test-"
    ) as temporary:
        directory = Path(temporary)
        fixture_paths = (
            directory / "pack-hce.py",
            directory / "hce-r3-pack-stream.js",
            directory / "hce-r3-linear.js",
            directory / "hce-r3-baseline.js",
            directory / "eval.rs",
            directory / "chessy-ai-fast.wasm",
            directory / "hce-r3-features-v1.json",
            directory / "hce-r3-fit-v1.json",
            directory / "teacher-sf18-100kn-v1.json",
        )
        fixture_labels = (
            "fixture packer",
            "fixture streamer",
            "fixture linear extractor",
            "fixture baseline extractor",
            "fixture Rust evaluator",
            "fixture shipped WASM",
            "fixture feature manifest",
            "fixture fit contract",
            "fixture teacher manifest",
        )
        for index, filename in enumerate(fixture_paths):
            filename.write_text(
                f"'use strict'; // fixture {index}\n", encoding="utf-8"
            )
        captured = capture_files(
            zip(fixture_paths, fixture_labels)
        )
        for captured_file in captured:
            captured_file.path.write_bytes(
                captured_file.data + b"// mutation during packing\n"
            )
            try:
                assert_captured_files_unchanged(captured)
            except RuntimeError as error:
                if captured_file.label not in str(error):
                    raise AssertionError(
                        "captured-file mutation named the wrong source"
                    ) from error
            else:
                raise AssertionError(
                    "captured-file mutation during packing was accepted"
                )
            captured_file.path.write_bytes(captured_file.data)
            assert_captured_files_unchanged(captured)

        selected_bin = directory / "selected-bin"
        replacement_bin = directory / "replacement-bin"
        selected_bin.mkdir()
        replacement_bin.mkdir()
        selected_node = selected_bin / "node"
        replacement_node = replacement_bin / "node"
        selected_path_replacement = directory / "selected-path-node"
        selected_node.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"--version\" ]; then\n"
            "  echo v99.0.0\n"
            "else\n"
            "  echo retained-node-A\n"
            "fi\n",
            encoding="utf-8",
        )
        replacement_node.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"--version\" ]; then\n"
            "  echo v99.0.1\n"
            "else\n"
            "  echo replacement-node-B\n"
            "fi\n",
            encoding="utf-8",
        )
        selected_path_replacement.write_bytes(replacement_node.read_bytes())
        selected_node.chmod(0o700)
        replacement_node.chmod(0o700)
        selected_path_replacement.chmod(0o700)
        resolved_node = resolve_node_executable(str(selected_bin))
        with retained_node_executable(resolved_node) as retained_node:
            original_node = directory / "original-node"
            selected_node.replace(original_node)
            selected_path_replacement.replace(selected_node)
            original_path = os.environ.get("PATH")
            os.environ["PATH"] = str(replacement_bin)
            try:
                completed = subprocess.run(
                    [retained_node.execution_path, "--fixture"],
                    pass_fds=(retained_node.descriptor,),
                    env={},
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                )
                try:
                    assert_captured_executable_unchanged(retained_node)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError(
                        "replaced Node source path passed final revalidation"
                    )
            finally:
                if original_path is None:
                    os.environ.pop("PATH", None)
                else:
                    os.environ["PATH"] = original_path
                selected_node.unlink(missing_ok=True)
                original_node.replace(selected_node)
            if (
                completed.stdout.strip() != "retained-node-A"
                or retained_node.version != "v99.0.0"
            ):
                raise AssertionError(
                    "PATH replacement changed the retained Node executable"
                )
            assert_captured_executable_unchanged(retained_node)

        live_root = directory / "live-repository"
        live_training = live_root / "test/training"
        live_training.mkdir(parents=True)
        live_streamer = live_training / "hce-r3-pack-stream.js"
        live_dependency = live_training / "snapshot-dependency.js"
        live_streamer.write_text(
            "'use strict';\n"
            "const path = require('path');\n"
            "const dependency = require('./snapshot-dependency');\n"
            "process.stdout.write(JSON.stringify({\n"
            "  row: dependency.row,\n"
            "  input: path.resolve(process.argv[2])\n"
            "}) + '\\n');\n",
            encoding="utf-8",
        )
        live_dependency.write_text(
            "'use strict'; module.exports = { row: 'captured-A' };\n",
            encoding="utf-8",
        )
        snapshot_capture = capture_files(
            (
                (live_streamer, "snapshot-test streamer"),
                (live_dependency, "snapshot-test dependency"),
            )
        )
        captured_digest = captured_closure_sha256(
            live_root, snapshot_capture
        )
        teacher_input = directory / "original-teacher-input.ndjson"
        teacher_input.write_text('{"fixture":true}\n', encoding="utf-8")
        preload_marker = directory / "node-options-preload-ran"
        preload = directory / "node-options-preload.js"
        preload.write_text(
            "'use strict'; require('fs').writeFileSync("
            + json.dumps(str(preload_marker))
            + ", 'preloaded');\n",
            encoding="utf-8",
        )
        snapshot_temporary_path: Path | None = None
        with (
            retained_node_executable() as retained_node,
            tempfile.TemporaryDirectory(
                prefix="private-streamer-snapshot-", dir=directory
            ) as snapshot_temporary,
        ):
            snapshot_temporary_path = Path(snapshot_temporary)
            snapshot_streamer = materialize_captured_tree(
                live_root,
                snapshot_capture,
                snapshot_temporary_path / "repository",
            )
            replacement_streamer = directory / "replacement-streamer.js"
            replacement_dependency = directory / "replacement-dependency.js"
            replacement_streamer.write_text(
                "'use strict'; process.stdout.write("
                "JSON.stringify({row:'replacement-B',input:'replacement'})"
                " + '\\n');\n",
                encoding="utf-8",
            )
            replacement_dependency.write_text(
                "'use strict'; module.exports = { row: 'replacement-B' };\n",
                encoding="utf-8",
            )
            original_streamer = directory / "original-streamer.js"
            original_dependency = directory / "original-dependency.js"
            live_streamer.replace(original_streamer)
            live_dependency.replace(original_dependency)
            replacement_streamer.replace(live_streamer)
            replacement_dependency.replace(live_dependency)
            original_node_options = os.environ.get("NODE_OPTIONS")
            os.environ["NODE_OPTIONS"] = "--require=" + str(preload)
            try:
                replacement_capture = capture_files(
                    (
                        (live_streamer, "replacement streamer"),
                        (live_dependency, "replacement dependency"),
                    )
                )
                if (
                    captured_closure_sha256(
                        live_root, replacement_capture
                    )
                    == captured_digest
                ):
                    raise AssertionError(
                        "replacement closure retained captured provenance"
                    )
                completed = subprocess.run(
                    [
                        retained_node.execution_path,
                        str(snapshot_streamer),
                        str(teacher_input.resolve()),
                    ],
                    pass_fds=(retained_node.descriptor,),
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    cwd=snapshot_temporary_path / "repository",
                    env={},
                )
            finally:
                if original_node_options is None:
                    os.environ.pop("NODE_OPTIONS", None)
                else:
                    os.environ["NODE_OPTIONS"] = original_node_options
                live_streamer.unlink(missing_ok=True)
                live_dependency.unlink(missing_ok=True)
                original_streamer.replace(live_streamer)
                original_dependency.replace(live_dependency)
            emitted = json.loads(completed.stdout)
            if emitted != {
                "row": "captured-A",
                "input": str(teacher_input.resolve()),
            }:
                raise AssertionError(
                    "private streamer snapshot emitted replacement bytes "
                    "or changed the absolute teacher input path"
                )
            if captured_closure_sha256(
                live_root, snapshot_capture
            ) != captured_digest:
                raise AssertionError(
                    "captured streamer provenance changed after live-tree "
                    "replace/restore"
                )
            assert_captured_files_unchanged(snapshot_capture)
            assert_captured_executable_unchanged(retained_node)
            if preload_marker.exists():
                raise AssertionError(
                    "NODE_OPTIONS injected code into the private streamer"
                )
        if (
            snapshot_temporary_path is None
            or snapshot_temporary_path.exists()
        ):
            raise AssertionError(
                "private streamer snapshot leaked after execution"
            )

        staged_output = directory / "staged-matrix.npz"
        staged_sidecar = directory / "staged-matrix.npz.manifest.json"
        staged_output.write_bytes(b"staged matrix\n")
        staged_sidecar.write_text(
            json.dumps(
                {
                    captured_file.label: captured_file.sha256
                    for captured_file in captured
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        published_output = directory / "matrix.npz"
        published_sidecar = directory / "matrix.npz.manifest.json"
        lock_path = directory / "matrix.npz.lock"
        descriptor = acquire_output_prefix_lock(
            lock_path, "HCE implementation mutation self-test"
        )
        try:
            refuse_existing_pair(
                (published_output, published_sidecar), "output or sidecar"
            )
            captured[-1].path.write_bytes(
                captured[-1].data + b"// mutation under publication lock\n"
            )
            try:
                assert_captured_files_unchanged(captured)
            except RuntimeError:
                pass
            else:
                publish_pair_no_replace(
                    staged_output,
                    staged_sidecar,
                    published_output,
                    published_sidecar,
                    "output or sidecar",
                )
                raise AssertionError(
                    "publication admitted changed implementation bytes"
                )
        finally:
            captured[-1].path.write_bytes(captured[-1].data)
            release_output_prefix_lock(descriptor, lock_path)
        if published_output.exists() or published_sidecar.exists():
            raise AssertionError(
                "implementation mutation exposed an HCE artifact pair"
            )
        if lock_path.exists():
            raise AssertionError(
                "implementation mutation left the publication lock behind"
            )
    with tempfile.TemporaryDirectory(
        prefix="chessy-hce-publication-self-test-"
    ) as temporary:
        self_test_pair_publication(
            Path(temporary),
            "matrix.npz",
            ".manifest.json",
            "HCE matrix/sidecar pair",
        )
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
    packer_path = Path(__file__).resolve()
    (packer_capture,) = capture_files(
        ((packer_path, "HCE packer source"),)
    )
    streamer_closure = capture_streamer_closure(root)
    closure_by_relative = {
        captured_file.path.relative_to(root).as_posix(): captured_file
        for captured_file in streamer_closure
    }
    streamer_capture = closure_by_relative[STREAMER_ENTRYPOINT]
    linear_extractor_capture = closure_by_relative[
        "test/training/hce-r3-linear.js"
    ]
    baseline_extractor_capture = closure_by_relative[
        "test/training/hce-r3-baseline.js"
    ]
    rust_evaluator_capture = closure_by_relative[
        "experiments/wasm/src/eval.rs"
    ]
    shipped_wasm_capture = closure_by_relative[
        "assets/chessy-ai-fast.wasm"
    ]
    feature_capture = closure_by_relative[
        "eval/training/hce-r3-features-v1.json"
    ]
    fit_capture = closure_by_relative[
        "eval/training/hce-r3-fit-v1.json"
    ]
    teacher_capture = closure_by_relative[
        "eval/training/teacher-sf18-100kn-v1.json"
    ]
    streamer_closure_digest = captured_closure_sha256(
        root, streamer_closure
    )
    captured_provenance_files = (packer_capture, *streamer_closure)
    feature = json.loads(feature_capture.data.decode("utf-8"))
    fit = json.loads(fit_capture.data.decode("utf-8"))
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
        raise SystemExit("center is not the frozen r71 baseline + zero-R3 vector")
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

    with (
        retained_node_executable() as node_executable,
        tempfile.TemporaryDirectory(
            prefix=".chessy-hce-pack-", dir=output.parent
        ) as temporary,
    ):
        temp = Path(temporary)
        snapshot_streamer = materialize_captured_tree(
            root, streamer_closure, temp / "streamer-snapshot"
        )
        command = [
            node_executable.execution_path,
            str(snapshot_streamer),
            "--role",
            args.role,
        ]
        for filename in inputs:
            command.extend(("--input", str(filename)))
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
            cwd=temp / "streamer-snapshot",
            env={},
            pass_fds=(node_executable.descriptor,),
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
            declared_inventory = validate_complete_selection_inventory(
                summary, inventory
            )
        except (TypeError, ValueError) as error:
            raise SystemExit(f"invalid feature-stream provenance: {error}") from error
        if teacher_sha != teacher_capture.sha256:
            raise SystemExit(
                "feature-stream teacher manifest hash differs from the "
                "pre-spawn capture"
            )
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
                feature_manifest_sha256=np.asarray(feature_capture.sha256),
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
                streamer_closure_sha256=np.asarray(
                    streamer_closure_digest
                ),
                node_executable_sha256=np.asarray(
                    node_executable.sha256
                ),
                node_executable_bytes=np.asarray(
                    node_executable.bytes, dtype=np.int64
                ),
                node_version=np.asarray(node_executable.version),
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
            "inputInventoryScope": "complete-selection-shard-inventory",
            "declaredSelectionShards": declared_inventory,
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
                "packerSha256": packer_capture.sha256,
                "streamerSha256": streamer_capture.sha256,
                "linearExtractorSha256": linear_extractor_capture.sha256,
                "baselineExtractorSha256": baseline_extractor_capture.sha256,
                "rustEvaluatorSourceSha256": rust_evaluator_capture.sha256,
                "shippedWasmSha256": shipped_wasm_capture.sha256,
                "featureManifestSha256": feature_capture.sha256,
                "fitContractSha256": fit_capture.sha256,
                "teacherManifestSha256": teacher_capture.sha256,
                "selectionManifestSha256": selection_manifest_sha,
                "selectionContractSha256": selection_contract_sha,
                "sourceSnapshotSha256": source_snapshot_sha,
                "inputDisposition": input_disposition,
                "streamerClosureSha256": streamer_closure_digest,
                "nodeExecutableSha256": node_executable.sha256,
                "nodeExecutableBytes": node_executable.bytes,
                "nodeVersion": node_executable.version,
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
        lock_path = output.with_name(output.name + ".lock")
        try:
            lock_descriptor = acquire_output_prefix_lock(
                lock_path, "HCE matrix/sidecar pair"
            )
        except FileExistsError as error:
            raise SystemExit(str(error)) from error
        try:
            refuse_existing_pair((output, sidecar), "output or sidecar")
            assert_captured_files_unchanged(captured_provenance_files)
            assert_captured_executable_unchanged(node_executable)
            publish_pair_no_replace(
                temporary_npz,
                temporary_sidecar,
                output,
                sidecar,
                "output or sidecar",
            )
        except FileExistsError as error:
            raise SystemExit(str(error)) from error
        finally:
            release_output_prefix_lock(lock_descriptor, lock_path)
    print(f"packed {rows} {args.role} rows / {nonzeros} nonzeros")
    print("output SHA-256 " + manifest["output"]["sha256"])


if __name__ == "__main__":
    main()
