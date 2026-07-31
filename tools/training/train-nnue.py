#!/usr/bin/env python3
"""MIT reference trainer for Chessy NNUE G0/G1.

This creates research checkpoints only. It deliberately has no quantizer,
runtime loader, Rust/WASM integration, or shipping path; those remain blocked
by issue #84 and the later #105 gates.
"""

from __future__ import annotations

import argparse
import heapq
import hashlib
import json
import math
import os
import random
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator


PIECES = ("P", "N", "B", "R", "Q", "K")
CORPUS_ROLES = (
    "shared-train",
    "hce-validation",
    "hce-test",
    "nnue-validation",
    "nnue-test",
)
ALLOWED_ROLES = {"shared-train", "nnue-validation"}
PRODUCTION_VALIDATION_CONTRACT = {
    "selectionState": "exploration-selection-only",
    "selectionFitAllowed": False,
    "certificationStatus": "frozen",
    "pendingCertificationAllowedForTestOnly": False,
    "selectionSourceId": "lichess-evaluations",
    "selectionSourceUrl": "https://database.lichess.org/",
    "selectionSourceFields": [
        "id",
        "url",
        "retrieved",
        "compressedSha256",
        "license",
    ],
    "recordSourceDataset": "lichess-evaluated-positions",
    "recordSourceFields": [
        "dataset",
        "snapshotSha256",
        "license",
    ],
}
SAMPLE_ONLY_VALIDATION_CONTRACT = {
    "sidecarState": "pinned-teacher-labels-sample-only",
    "fitAllowed": False,
    "selectionState": "mechanism-test-selection-only",
    "selectionFitAllowed": False,
    "certificationStatus": "awaiting-opening-freeze",
    "pendingCertificationAllowedForTestOnly": True,
    "selectionSourceId": "chessy-training-mechanism-fixture",
    "selectionSourceUrl": None,
    "selectionSourceFields": [
        "id",
        "url",
        "retrieved",
        "compressedSha256",
        "license",
        "mechanismFixture",
    ],
    "recordSourceDataset": "chessy-training-mechanism-fixture",
    "recordSourceFields": [
        "dataset",
        "snapshotSha256",
        "license",
        "mechanismFixture",
    ],
    "mechanismFixture": {
        "status": "sample-only-not-fit-eligible",
        "fitAllowed": False,
        "officialEvaluationSnapshot": False,
    },
}
TRANSFORMS = (
    "identity",
    "file-mirror",
    "color-rank",
    "color-rank-file-mirror",
)
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
FINAL_RECORD_FIELDS = frozenset(
    {
        "schema",
        "id",
        "fen",
        "canonicalFen",
        "cluster",
        "role",
        "positionFamily",
        "strata",
        "source",
        "teacher",
    }
)
TEACHER_RECORD_FIELDS = frozenset(
    {
        "id",
        "release",
        "commit",
        "manifestSha256",
        "nodes",
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
)


@dataclass(frozen=True)
class ParsedPosition:
    board: tuple[tuple[str | None, ...], ...]
    turn: str
    castling: str
    ep: str
    fen4: str


@dataclass(frozen=True)
class InputContracts:
    config_path: Path
    config: dict[str, Any]
    teacher_path: Path
    teacher_sha256: str
    teacher: dict[str, Any]
    heldout_path: Path
    heldout_sha256: str
    heldout: dict[str, Any]
    corpus_path: Path
    corpus_sha256: str


@dataclass(frozen=True)
class SelectionShard:
    path: Path
    rows: int
    sha256: str


@dataclass(frozen=True)
class SelectionBinding:
    path: Path
    sha256: str
    certification_path: Path
    certification_sha256: str
    selection_contract_sha256: str
    source_snapshot_sha256: str
    sample_only: bool
    shards: tuple[SelectionShard, ...]
    certification_clusters: frozenset[str]
    certification_families: frozenset[str]


@dataclass
class Shard:
    path: Path
    sha256: str
    rows: int
    sidecar_path: Path
    sidecar_sha256: str
    sidecar: dict[str, Any]
    selection: SelectionBinding
    selection_shard: SelectionShard
    observed_rows: int = 0
    role_rows: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ValidatedInputs:
    train: tuple[Shard, ...]
    validation: tuple[Shard, ...]
    selection_manifest_sha256: str
    selection_contract_sha256: str
    source_snapshot_sha256: str
    sample_only: bool


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_castling(value: str) -> str:
    if value == "-":
        return "-"
    if not value or any(char not in "KQkq" for char in value):
        raise ValueError(f"invalid castling field: {value}")
    return "".join(char for char in "KQkq" if char in set(value)) or "-"


def compress_rank(rank: Iterable[str | None]) -> str:
    result = ""
    empty = 0
    for piece in rank:
        if piece is None:
            empty += 1
        else:
            if empty:
                result += str(empty)
                empty = 0
            result += piece
    if empty:
        result += str(empty)
    return result


def parse_position(
    fen: str, *, validate_source_castling: bool = True
) -> ParsedPosition:
    if not isinstance(fen, str):
        raise ValueError("FEN must be a string")
    fields = fen.strip().split()
    if len(fields) not in (4, 6):
        raise ValueError("FEN must contain four or six fields")
    ranks = fields[0].split("/")
    if len(ranks) != 8:
        raise ValueError("FEN board must contain eight ranks")
    board: list[tuple[str | None, ...]] = []
    for rank_index, rank in enumerate(ranks):
        row: list[str | None] = []
        for char in rank:
            if "1" <= char <= "8":
                row.extend([None] * int(char))
            elif char in "PNBRQKpnbrqk":
                if char in "Pp" and rank_index in (0, 7):
                    raise ValueError("FEN cannot contain a pawn on rank 1 or rank 8")
                row.append(char)
            else:
                raise ValueError(f"invalid FEN board character: {char}")
        if len(row) != 8:
            raise ValueError("FEN rank does not contain eight squares")
        board.append(tuple(row))
    turn = fields[1]
    if turn not in ("w", "b"):
        raise ValueError(f"invalid side to move: {turn}")
    castling = normalize_castling(fields[2])
    ep = fields[3]
    if ep != "-" and not re.fullmatch(r"[a-h][36]", ep):
        raise ValueError(f"invalid en-passant field: {ep}")

    flat = tuple(piece for rank in board for piece in rank)
    if flat.count("K") != 1 or flat.count("k") != 1:
        raise ValueError("FEN must contain exactly one king of each color")
    white_king = flat.index("K")
    black_king = flat.index("k")
    if (
        abs(white_king // 8 - black_king // 8) <= 1
        and abs(white_king % 8 - black_king % 8) <= 1
    ):
        raise ValueError("FEN kings cannot occupy adjacent squares")
    castling_pieces = {
        "K": board[7][4] == "K" and board[7][7] == "R",
        "Q": board[7][4] == "K" and board[7][0] == "R",
        "k": board[0][4] == "k" and board[0][7] == "r",
        "q": board[0][4] == "k" and board[0][0] == "r",
    }
    if (
        validate_source_castling
        and castling != "-"
        and any(not castling_pieces[right] for right in castling)
    ):
        raise ValueError("FEN castling right lacks its king or rook")
    if ep != "-":
        file_index = ord(ep[0]) - ord("a")
        source_rank = 3 if turn == "w" else 4
        capturer = "P" if turn == "w" else "p"
        captured = "p" if turn == "w" else "P"
        adjacent = (
            file_index > 0 and board[source_rank][file_index - 1] == capturer
        ) or (
            file_index < 7 and board[source_rank][file_index + 1] == capturer
        )
        if not adjacent or board[source_rank][file_index] != captured:
            ep = "-"
    board_field = "/".join(compress_rank(rank) for rank in board)
    return ParsedPosition(
        board=tuple(board),
        turn=turn,
        castling=castling,
        ep=ep,
        fen4=f"{board_field} {turn} {castling} {ep}",
    )


def parse_fen4(fen: str) -> tuple[list[str | None], str]:
    parsed = parse_position(fen)
    return [piece for rank in parsed.board for piece in rank], parsed.turn


def feature_indices(fen: str, perspective: str) -> list[int]:
    """Match test/training/corpus.js encodeNnue768 exactly."""
    if perspective not in ("w", "b"):
        raise ValueError("perspective must be w or b")
    board, _ = parse_fen4(fen)
    result: list[int] = []
    for fen_square, piece in enumerate(board):
        if piece is None:
            continue
        fen_rank, file_index = divmod(fen_square, 8)
        native_square = fen_rank * 8 + file_index
        oriented = native_square if perspective == "w" else native_square ^ 56
        white_piece = piece.isupper()
        own = white_piece if perspective == "w" else not white_piece
        piece_index = PIECES.index(piece.upper())
        channel = piece_index if own else 6 + piece_index
        result.append(channel * 64 + oriented)
    return sorted(result)


def transform_fen4(fen: str, transform: str) -> str:
    if transform not in TRANSFORMS:
        raise ValueError(f"unknown transform: {transform}")
    # Symmetry transforms deliberately move orthodox king/rook start squares.
    # Validate the real source once in symmetry_fens(), then parse transformed
    # variants structurally without reapplying source castling-square rules.
    parsed = parse_position(fen, validate_source_castling=False)
    board = [list(rank) for rank in parsed.board]
    turn = parsed.turn
    castling = parsed.castling
    ep = parsed.ep
    if transform in ("file-mirror", "color-rank-file-mirror"):
        board = [list(reversed(rank)) for rank in board]
        castling_map = {"K": "Q", "Q": "K", "k": "q", "q": "k"}
        if castling != "-":
            castling = normalize_castling(
                "".join(castling_map[char] for char in castling)
            )
        if ep != "-":
            ep = chr(ord("h") - (ord(ep[0]) - ord("a"))) + ep[1]
    if transform in ("color-rank", "color-rank-file-mirror"):
        board = [
            [
                None
                if piece is None
                else piece.lower()
                if piece.isupper()
                else piece.upper()
                for piece in rank
            ]
            for rank in reversed(board)
        ]
        turn = "b" if turn == "w" else "w"
        castling_map = {"K": "k", "Q": "q", "k": "K", "q": "Q"}
        if castling != "-":
            castling = normalize_castling(
                "".join(castling_map[char] for char in castling)
            )
        if ep != "-":
            ep = ep[0] + str(9 - int(ep[1]))
    board_field = "/".join(compress_rank(rank) for rank in board)
    return f"{board_field} {turn} {castling} {ep}"


def symmetry_fens(fen: str) -> list[str]:
    source = parse_position(fen)
    return [
        transform_fen4(source.fen4, transform)
        for transform in TRANSFORMS
    ]


def canonical_fen4(fen: str) -> str:
    return min(symmetry_fens(fen))


def cluster_key(fen: str) -> str:
    model_board = min(variant.split()[0] for variant in symmetry_fens(fen))
    return sha256_text(model_board)


def position_family_key(fen: str) -> str:
    representations: list[str] = []
    material_keys = sorted("PNBRQpnbrq")
    for variant in symmetry_fens(fen):
        parsed = parse_position(variant, validate_source_castling=False)
        pawns: list[str] = []
        kings: list[str] = []
        material = {piece: 0 for piece in material_keys}
        for square, piece in enumerate(
            piece for rank in parsed.board for piece in rank
        ):
            if piece in ("P", "p"):
                pawns.append(piece + str(square))
            elif piece in ("K", "k"):
                kings.append(piece + str(square))
            elif piece is not None:
                material[piece] += 1
        representation = {
            "pawns": sorted(pawns),
            "kings": sorted(kings),
            "material": [[piece, material[piece]] for piece in material_keys],
        }
        representations.append(
            json.dumps(representation, separators=(",", ":"), ensure_ascii=False)
        )
    return sha256_text(min(representations))


def role_for_family(key: str) -> str:
    if not HEX_256.fullmatch(key):
        raise ValueError("position-family key must be SHA-256 hex")
    cell = int(key[:12], 16) % 390
    if cell < 210:
        return "shared-train"
    if cell < 255:
        return "hce-validation"
    if cell < 300:
        return "hce-test"
    if cell < 345:
        return "nnue-validation"
    return "nnue-test"


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_buffer(
    filename: Path, label: str
) -> tuple[dict[str, Any], str]:
    data = filename.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{label} is not UTF-8 JSON") from error
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is invalid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return value, digest


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not HEX_256.fullmatch(value):
        raise ValueError(f"{label} must be lowercase SHA-256 hex")
    return value


def require_nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a nonnegative integer")
    return value


def load_contracts(root: Path | None = None) -> InputContracts:
    repository = root or Path(__file__).resolve().parents[2]
    config_path = repository / "eval/training/nnue-v1-train.json"
    config = load_json(config_path)
    contract = require_object(
        config.get("data", {}).get("trustBoundary"), "trustBoundary"
    )
    if (
        contract.get("productionValidation")
        != PRODUCTION_VALIDATION_CONTRACT
    ):
        raise ValueError("production validation contract drifted")
    if (
        contract.get("sampleOnlyValidation")
        != SAMPLE_ONLY_VALIDATION_CONTRACT
    ):
        raise ValueError("sample-only validation contract drifted")

    def pinned_file(path_key: str, sha_key: str) -> tuple[Path, str, dict[str, Any]]:
        relative = contract.get(path_key)
        if not isinstance(relative, str) or not relative:
            raise ValueError(f"trustBoundary.{path_key} is missing")
        expected_sha = require_sha256(
            contract.get(sha_key), f"trustBoundary.{sha_key}"
        )
        filename = (repository / relative).resolve()
        if not filename.is_file():
            raise ValueError(f"pinned contract file is missing: {filename}")
        actual_sha = sha256_file(filename)
        if actual_sha != expected_sha:
            raise ValueError(
                f"{path_key} SHA-256 drifted: expected {expected_sha}, got {actual_sha}"
            )
        return filename, actual_sha, load_json(filename)

    teacher_path, teacher_sha, teacher = pinned_file(
        "teacherManifest", "teacherManifestSha256"
    )
    heldout_path, heldout_sha, heldout = pinned_file(
        "heldoutManifest", "heldoutManifestSha256"
    )
    corpus_relative = contract.get("corpusContract")
    if not isinstance(corpus_relative, str) or not corpus_relative:
        raise ValueError("trustBoundary.corpusContract is missing")
    corpus_path = (repository / corpus_relative).resolve()
    corpus_expected_sha = require_sha256(
        contract.get("corpusContractSha256"),
        "trustBoundary.corpusContractSha256",
    )
    corpus_sha = sha256_file(corpus_path)
    if corpus_sha != corpus_expected_sha:
        raise ValueError(
            "corpusContract SHA-256 drifted: "
            f"expected {corpus_expected_sha}, got {corpus_sha}"
        )

    if (
        teacher.get("status") != "teacher-identity-frozen"
        or teacher.get("id") != contract.get("teacherId")
        or teacher.get("search", {}).get("nodeLimit") != contract.get("teacherNodes")
    ):
        raise ValueError("pinned teacher manifest identity or node contract drifted")
    eligibility = teacher.get("labels", {}).get("eligibility", {})
    if (
        eligibility.get("scoreKind") != "exact-cp"
        or eligibility.get("boundScoresAllowed") is not False
        or eligibility.get("scoreSelection")
        != "latest-unbounded-exact-cp-info-before-bestmove"
        or eligibility.get("terminalBoundAllowedAsEffortEvidence") is not True
        or eligibility.get("scoreNodesMayBeBelowLimit") is not True
        or eligibility.get("mateInvalidatesEarlierExactCp") is not True
        or eligibility.get("wdlRequired") is not True
        or eligibility.get("wdlTotal") != 1000
        or eligibility.get("reportedNodesMustMeetOrExceedLimit") is not True
        or eligibility.get("bestMoveMustMatchPvHead") is not True
        or eligibility.get("depthAndSeldepthRequired") is not True
    ):
        raise ValueError("pinned teacher label eligibility contract drifted")
    heldout_cluster = cluster_key(heldout["incident"]["fen"])
    heldout_family = position_family_key(heldout["incident"]["fen"])
    if (
        heldout_cluster != heldout["symmetryPolicy"]["clusterSha256"]
        or heldout_family != heldout["symmetryPolicy"]["positionFamilySha256"]
    ):
        raise ValueError("held-out incident keys drifted")
    return InputContracts(
        config_path=config_path,
        config=config,
        teacher_path=teacher_path,
        teacher_sha256=teacher_sha,
        teacher=teacher,
        heldout_path=heldout_path,
        heldout_sha256=heldout_sha,
        heldout=heldout,
        corpus_path=corpus_path,
        corpus_sha256=corpus_sha,
    )


def expected_teacher_options(teacher: dict[str, Any]) -> dict[str, Any]:
    return dict(teacher["uci"])


def expected_teacher_networks(teacher: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "option": network["option"],
            "embeddedName": network["embeddedName"],
            "sha256": network["sha256"],
        }
        for network in teacher["engine"]["networks"]
    ]


def resolve_reference(value: Any, base: Path, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must name a file")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    resolved = candidate.resolve()
    if not resolved.is_file():
        raise ValueError(f"{label} is not a file: {resolved}")
    return resolved


def load_selection_binding(
    selection_path: Path,
    expected_sha256: str,
    contracts: InputContracts,
    *,
    sample_only: bool,
) -> SelectionBinding:
    label = str(selection_path)
    manifest, manifest_sha256 = load_json_buffer(selection_path, label)
    if manifest_sha256 != expected_sha256:
        raise ValueError(f"{label}: selection manifest SHA-256 does not match")
    trust = contracts.config["data"]["trustBoundary"]
    mode = (
        trust["sampleOnlyValidation"]
        if sample_only
        else trust["productionValidation"]
    )
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("state") != mode["selectionState"]
        or manifest.get("finalFitAllowed")
        is not mode["selectionFitAllowed"]
    ):
        raise ValueError(f"{label}: selection manifest has the wrong mode/state")
    marker = manifest.get("mechanismFixture")
    if sample_only:
        if marker != mode["mechanismFixture"]:
            raise ValueError(
                f"{label}: sample selection mechanismFixture marker is not exact"
            )
    elif "mechanismFixture" in manifest:
        raise ValueError(
            f"{label}: production selection carries a sample-only marker"
        )

    source = require_object(manifest.get("source"), f"{label}.source")
    if (
        set(source) != set(mode["selectionSourceFields"])
        or source.get("id") != mode["selectionSourceId"]
        or source.get("url") != mode["selectionSourceUrl"]
        or source.get("license") != "CC0-1.0"
        or not isinstance(source.get("retrieved"), str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}", source["retrieved"]) is None
    ):
        raise ValueError(f"{label}: selection source identity/license is invalid")
    if sample_only and source.get("mechanismFixture") != mode[
        "mechanismFixture"
    ]:
        raise ValueError(
            f"{label}: sample selection source marker is not exact"
        )
    source_snapshot_sha256 = require_sha256(
        source.get("compressedSha256"), f"{label}.source.compressedSha256"
    )
    adapter = require_object(manifest.get("adapter"), f"{label}.adapter")
    selection_contract_sha256 = require_sha256(
        adapter.get("selectionContractSha256"),
        f"{label}.adapter.selectionContractSha256",
    )
    exclusions = require_object(
        manifest.get("exclusions"), f"{label}.exclusions"
    )
    certification_status = exclusions.get("certificationStatus")
    if (
        certification_status != mode["certificationStatus"]
        or exclusions.get("pendingCertificationAllowedForTestOnly")
        is not mode["pendingCertificationAllowedForTestOnly"]
    ):
        raise ValueError(
            f"{label}: selection certification mode is not allowed"
        )
    certification_sha256 = require_sha256(
        exclusions.get("certificationManifestSha256"),
        f"{label}.exclusions.certificationManifestSha256",
    )
    repository = contracts.config_path.parents[2]
    certification_path = resolve_reference(
        exclusions.get("certificationManifest"),
        repository,
        f"{label}.exclusions.certificationManifest",
    )
    certification, actual_certification_sha256 = load_json_buffer(
        certification_path, str(certification_path)
    )
    if actual_certification_sha256 != certification_sha256:
        raise ValueError(
            f"{label}: certification manifest SHA-256 does not match"
        )
    if (
        certification.get("schema")
        != "chessy.e4.certification-manifest.v1"
        or certification.get("protocolId") != "E4-v1"
        or certification.get("kind") != "certification"
        or certification.get("status") != certification_status
    ):
        raise ValueError(
            f"{label}: certification manifest identity/status is invalid"
        )
    openings = certification.get("openingClusters")
    if not isinstance(openings, list):
        raise ValueError(
            f"{label}: certification openingClusters must be an array"
        )
    certification_clusters: set[str] = set()
    certification_families: set[str] = set()
    for index, opening in enumerate(openings):
        item = require_object(
            opening, f"{label}.certification.openingClusters[{index}]"
        )
        fen = item.get("fen")
        if not isinstance(fen, str):
            raise ValueError(
                f"{label}: certification opening {index} has no FEN"
            )
        certification_clusters.add(cluster_key(fen))
        certification_families.add(position_family_key(fen))
    cluster_count = require_nonnegative_int(
        exclusions.get("certificationClusterCount"),
        f"{label}.exclusions.certificationClusterCount",
    )
    family_count = require_nonnegative_int(
        exclusions.get("certificationPositionFamilyCount"),
        f"{label}.exclusions.certificationPositionFamilyCount",
    )
    if (
        cluster_count != len(certification_clusters)
        or family_count != len(certification_families)
    ):
        raise ValueError(
            f"{label}: certification holdout counts do not match"
        )
    if sample_only and (
        openings
        or certification.get("assignments") != []
        or cluster_count != 0
        or family_count != 0
    ):
        raise ValueError(
            f"{label}: pending sample certification must have zero holdout sets"
        )

    listed = manifest.get("shards")
    if not isinstance(listed, list) or not listed:
        raise ValueError(f"{label}: selection manifest has no shard inventory")
    shard_count = require_nonnegative_int(
        adapter.get("shardCount"), f"{label}.adapter.shardCount"
    )
    if shard_count != len(listed):
        raise ValueError(f"{label}: selection shard count does not match")
    selection_shards: list[SelectionShard] = []
    seen_paths: set[Path] = set()
    total_rows = 0
    for index, value in enumerate(listed):
        item = require_object(value, f"{label}.shards[{index}]")
        if set(item) != {"path", "rows", "canonicalNdjsonSha256"}:
            raise ValueError(
                f"{label}: selection shard {index} metadata is not exact"
            )
        expected_name = f"selection-{index:03d}.ndjson"
        if item.get("path") != expected_name:
            raise ValueError(
                f"{label}: selection shard {index} path is not canonical"
            )
        rows = require_nonnegative_int(
            item.get("rows"), f"{label}.shards[{index}].rows"
        )
        shard_sha256 = require_sha256(
            item.get("canonicalNdjsonSha256"),
            f"{label}.shards[{index}].canonicalNdjsonSha256",
        )
        shard_path = resolve_reference(
            item.get("path"),
            selection_path.parent,
            f"{label}.shards[{index}].path",
        )
        if shard_path in seen_paths:
            raise ValueError(f"{label}: duplicate selection shard path")
        seen_paths.add(shard_path)
        if sha256_file(shard_path) != shard_sha256:
            raise ValueError(
                f"{label}: selection shard {index} SHA-256 does not match"
            )
        selection_shards.append(
            SelectionShard(
                path=shard_path,
                rows=rows,
                sha256=shard_sha256,
            )
        )
        total_rows += rows
    counts = require_object(manifest.get("counts"), f"{label}.counts")
    if require_nonnegative_int(
        counts.get("selected"), f"{label}.counts.selected"
    ) != total_rows:
        raise ValueError(f"{label}: selected rows do not match shard inventory")
    return SelectionBinding(
        path=selection_path,
        sha256=manifest_sha256,
        certification_path=certification_path,
        certification_sha256=certification_sha256,
        selection_contract_sha256=selection_contract_sha256,
        source_snapshot_sha256=source_snapshot_sha256,
        sample_only=sample_only,
        shards=tuple(selection_shards),
        certification_clusters=frozenset(certification_clusters),
        certification_families=frozenset(certification_families),
    )


def validate_sidecar(
    filename: Path,
    contracts: InputContracts,
    *,
    sample_only: bool = False,
    selection_cache: dict[Path, SelectionBinding] | None = None,
) -> Shard:
    suffix = contracts.config["data"]["trustBoundary"]["sidecarSuffix"]
    sidecar_path = Path(str(filename) + suffix)
    if not sidecar_path.is_file():
        raise ValueError(f"{filename}: required sidecar is missing: {sidecar_path}")
    label = str(sidecar_path)
    manifest, sidecar_sha = load_json_buffer(sidecar_path, label)
    trust = contracts.config["data"]["trustBoundary"]
    sample_contract = require_object(
        trust.get("sampleOnlyValidation"),
        "trustBoundary.sampleOnlyValidation",
    )
    expected_state = (
        sample_contract.get("sidecarState")
        if sample_only
        else trust["sidecarState"]
    )
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("state") != expected_state
    ):
        raise ValueError(f"{label}: wrong sidecar schema/state")
    if sample_only:
        if manifest.get("fitAllowed") is not False:
            raise ValueError(f"{label}: sample-only sidecar must set fitAllowed=false")
        if manifest.get("mechanismFixture") != sample_contract.get(
            "mechanismFixture"
        ):
            raise ValueError(
                f"{label}: sample-only mechanismFixture marker is not exact"
            )
    elif "mechanismFixture" in manifest or "fitAllowed" in manifest:
        raise ValueError(f"{label}: sample-only markers are forbidden for fitting")

    output = require_object(manifest.get("output"), f"{label}.output")
    rows = require_nonnegative_int(output.get("rows"), f"{label}.output.rows")
    recorded_sha = require_sha256(output.get("sha256"), f"{label}.output.sha256")
    if Path(str(output.get("path", ""))).name != filename.name:
        raise ValueError(f"{label}: output.path does not identify {filename.name}")
    actual_sha = sha256_file(filename)
    if recorded_sha != actual_sha:
        raise ValueError(f"{filename}: SHA-256 does not match its sidecar")

    side_teacher = require_object(manifest.get("teacher"), f"{label}.teacher")
    teacher_manifest = require_object(
        side_teacher.get("manifest"), f"{label}.teacher.manifest"
    )
    if teacher_manifest.get("sha256") != contracts.teacher_sha256:
        raise ValueError(f"{label}: teacher manifest SHA-256 is not pinned")
    teacher = contracts.teacher
    expected_identity = {
        "id": teacher["id"],
        "release": teacher["engine"]["release"],
        "commit": teacher["engine"]["sourceCommit"],
        "executableSha256": teacher["engine"]["executable"]["sha256"],
        "license": teacher["engine"]["license"],
        "use": teacher["engine"]["integration"],
        "nodes": teacher["search"]["nodeLimit"],
        "scorePovFromEngine": teacher["labels"]["enginePov"],
        "storedScorePov": teacher["labels"]["storedPov"],
    }
    for field, expected in expected_identity.items():
        if side_teacher.get(field) != expected:
            raise ValueError(f"{label}: teacher.{field} does not match frozen teacher")
    if side_teacher.get("networks") != expected_teacher_networks(teacher):
        raise ValueError(f"{label}: teacher networks do not match frozen teacher")
    if side_teacher.get("options") != expected_teacher_options(teacher):
        raise ValueError(f"{label}: teacher options do not match frozen teacher")
    if side_teacher.get("watchdog") != teacher.get("watchdog"):
        raise ValueError(f"{label}: teacher watchdog does not match frozen teacher")

    source = require_object(manifest.get("input"), f"{label}.input")
    selection = require_object(
        source.get("selectionManifest"), f"{label}.input.selectionManifest"
    )
    declared_selection_sha256 = require_sha256(
        selection.get("sha256"), f"{label}.input.selectionManifest.sha256"
    )
    declared_selection_contract_sha256 = require_sha256(
        selection.get("selectionContractSha256"),
        f"{label}.input.selectionManifest.selectionContractSha256",
    )
    selection_path = resolve_reference(
        selection.get("path"),
        sidecar_path.parent,
        f"{label}.input.selectionManifest.path",
    )
    cache = selection_cache if selection_cache is not None else {}
    selection_binding = cache.get(selection_path)
    if selection_binding is None:
        selection_binding = load_selection_binding(
            selection_path,
            declared_selection_sha256,
            contracts,
            sample_only=sample_only,
        )
        cache[selection_path] = selection_binding
    elif (
        selection_binding.sha256 != declared_selection_sha256
        or selection_binding.sample_only is not sample_only
    ):
        raise ValueError(f"{label}: selection manifest binding is inconsistent")
    if (
        declared_selection_contract_sha256
        != selection_binding.selection_contract_sha256
    ):
        raise ValueError(
            f"{label}: selection contract SHA-256 does not match its manifest"
        )
    certification_status = selection.get("certificationStatus")
    if sample_only:
        if certification_status != sample_contract.get("certificationStatus"):
            raise ValueError(
                f"{label}: sample-only validation requires "
                "awaiting-opening-freeze certification"
            )
    elif certification_status != "frozen":
        raise ValueError(
            f"{label}: pending/test-only certification selections are forbidden"
        )
    input_shard = require_object(source.get("shard"), f"{label}.input.shard")
    input_rows = require_nonnegative_int(
        input_shard.get("rows"), f"{label}.input.shard.rows"
    )
    input_sha256 = require_sha256(
        input_shard.get("sha256"), f"{label}.input.shard.sha256"
    )
    input_path = resolve_reference(
        input_shard.get("path"),
        selection_path.parent,
        f"{label}.input.shard.path",
    )
    matches = [
        shard
        for shard in selection_binding.shards
        if shard.path == input_path
    ]
    if len(matches) != 1:
        raise ValueError(
            f"{label}: input shard is not uniquely listed by selection manifest"
        )
    selection_shard = matches[0]
    if (
        input_rows != selection_shard.rows
        or input_sha256 != selection_shard.sha256
    ):
        raise ValueError(
            f"{label}: input shard metadata does not match selection manifest"
        )
    exclusions = require_object(manifest.get("exclusions"), f"{label}.exclusions")
    exclusion_rows = require_nonnegative_int(
        exclusions.get("rows"), f"{label}.exclusions.rows"
    )
    require_sha256(exclusions.get("sha256"), f"{label}.exclusions.sha256")
    if input_rows != rows + exclusion_rows:
        raise ValueError(f"{label}: input/output/exclusion row counts do not balance")
    transcript = require_object(
        side_teacher.get("transcript"), f"{label}.teacher.transcript"
    )
    require_sha256(transcript.get("sha256"), f"{label}.teacher.transcript.sha256")
    return Shard(
        path=filename,
        sha256=actual_sha,
        rows=rows,
        sidecar_path=sidecar_path,
        sidecar_sha256=sidecar_sha,
        sidecar=manifest,
        selection=selection_binding,
        selection_shard=selection_shard,
    )


def validate_record(
    record: Any,
    shard: Shard,
    line_number: int,
    contracts: InputContracts,
) -> dict[str, Any]:
    label = f"{shard.path}:{line_number}"
    if not isinstance(record, dict):
        raise ValueError(f"{label}: record must be an object")
    if "explorationLabel" in record or "sourceExplorationLabel" in record:
        raise ValueError(f"{label}: mixed upstream label fields are forbidden")
    if set(record) != FINAL_RECORD_FIELDS:
        raise ValueError(f"{label}: record has undeclared or missing fields")
    if record.get("schema") != contracts.config["data"]["schema"]:
        raise ValueError(f"{label}: wrong schema")
    record_id = require_sha256(record.get("id"), f"{label}.id")
    fen = record.get("fen")
    if not isinstance(fen, str):
        raise ValueError(f"{label}: FEN is missing")
    parsed = parse_position(fen)
    if parsed.fen4 != fen:
        raise ValueError(f"{label}: FEN is not normalized four-field form")
    source = require_object(record.get("source"), f"{label}.source")
    trust = contracts.config["data"]["trustBoundary"]
    mode = (
        trust["sampleOnlyValidation"]
        if shard.selection.sample_only
        else trust["productionValidation"]
    )
    if (
        set(source) != set(mode["recordSourceFields"])
        or source.get("dataset") != mode["recordSourceDataset"]
        or source.get("license") != "CC0-1.0"
    ):
        raise ValueError(f"{label}: source fields/dataset/license are not allowed")
    if shard.selection.sample_only:
        if source.get("mechanismFixture") != mode["mechanismFixture"]:
            raise ValueError(
                f"{label}: sample record mechanismFixture marker is not exact"
            )
    snapshot_sha = require_sha256(
        source.get("snapshotSha256"), f"{label}.source.snapshotSha256"
    )
    if snapshot_sha != shard.selection.source_snapshot_sha256:
        raise ValueError(
            f"{label}: source snapshot does not match selection manifest"
        )
    cluster = cluster_key(fen)
    family = position_family_key(fen)
    recomputed = {
        "id": sha256_text(snapshot_sha + "\n" + fen),
        "canonicalFen": canonical_fen4(fen),
        "cluster": cluster,
        "positionFamily": family,
    }
    for field, expected in recomputed.items():
        if record.get(field) != expected:
            raise ValueError(f"{label}: recomputed {field} does not match")
    heldout = contracts.heldout["symmetryPolicy"]
    if (
        cluster == heldout["clusterSha256"]
        or family == heldout["positionFamilySha256"]
    ):
        raise ValueError(f"{label}: held-out incident cluster/family is forbidden")
    if (
        cluster in shard.selection.certification_clusters
        or family in shard.selection.certification_families
    ):
        raise ValueError(
            f"{label}: certification cluster/family is forbidden"
        )
    if record.get("role") != role_for_family(family):
        raise ValueError(f"{label}: recomputed role does not match")
    teacher = require_object(record.get("teacher"), f"{label}.teacher")
    if set(teacher) != TEACHER_RECORD_FIELDS:
        raise ValueError(f"{label}: teacher has undeclared or missing fields")
    expected_teacher = contracts.teacher
    expected_fields = {
        "id": expected_teacher["id"],
        "release": expected_teacher["engine"]["release"],
        "commit": expected_teacher["engine"]["sourceCommit"],
        "manifestSha256": contracts.teacher_sha256,
        "nodes": expected_teacher["search"]["nodeLimit"],
    }
    for field, expected in expected_fields.items():
        if teacher.get(field) != expected:
            raise ValueError(f"{label}: teacher.{field} does not match frozen teacher")
    target = teacher.get("targetWhite")
    cp_white = teacher.get("cpWhite")
    if isinstance(cp_white, bool) or not isinstance(cp_white, int):
        raise ValueError(f"{label}: teacher.cpWhite must be an exact integer")
    if (
        isinstance(target, bool)
        or not isinstance(target, (int, float))
        or not math.isfinite(float(target))
        or float(target) < 0.0
        or float(target) > 1.0
    ):
        raise ValueError(f"{label}: teacher.targetWhite must be in [0,1]")
    wdl = teacher.get("wdlWhite")
    if (
        not isinstance(wdl, list)
        or len(wdl) != 3
        or any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for value in wdl
        )
        or sum(wdl) != expected_teacher["labels"]["eligibility"]["wdlTotal"]
    ):
        raise ValueError(f"{label}: teacher.wdlWhite does not match frozen contract")
    expected_target = (float(wdl[0]) + 0.5 * float(wdl[1])) / sum(
        float(value) for value in wdl
    )
    if not math.isclose(float(target), expected_target, rel_tol=0.0, abs_tol=1e-12):
        raise ValueError(f"{label}: teacher.targetWhite does not match WDL")
    score_nodes = teacher.get("scoreNodes")
    reported_nodes = teacher.get("reportedNodes")
    node_limit = expected_teacher["search"]["nodeLimit"]
    if (
        isinstance(score_nodes, bool)
        or not isinstance(score_nodes, int)
        or score_nodes <= 0
        or isinstance(reported_nodes, bool)
        or not isinstance(reported_nodes, int)
        or reported_nodes < node_limit
        or score_nodes > reported_nodes
    ):
        raise ValueError(
            f"{label}: teacher score/terminal node evidence is invalid"
        )
    depth = teacher.get("depth")
    seldepth = teacher.get("seldepth")
    if (
        isinstance(depth, bool)
        or not isinstance(depth, int)
        or depth <= 0
        or isinstance(seldepth, bool)
        or not isinstance(seldepth, int)
        or seldepth < depth
    ):
        raise ValueError(f"{label}: teacher depth/seldepth contract is invalid")
    best_move = teacher.get("bestMoveUci")
    pv = teacher.get("pvUci")
    if (
        not isinstance(best_move, str)
        or not best_move
        or not isinstance(pv, list)
        or not pv
        or any(not isinstance(move, str) or not move for move in pv)
        or pv[0] != best_move
    ):
        raise ValueError(f"{label}: teacher best move/PV contract is invalid")
    return record


def iter_validated_shard(
    shard: Shard, contracts: InputContracts
) -> Iterator[tuple[str, dict[str, Any], Shard]]:
    previous_id: str | None = None
    rows = 0
    role_rows = {role: 0 for role in CORPUS_ROLES}
    with shard.path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                raise ValueError(
                    f"{shard.path}:{line_number}: blank rows are forbidden"
                )
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"{shard.path}:{line_number}: invalid JSON: {error.msg}"
                ) from error
            record = validate_record(parsed, shard, line_number, contracts)
            record_id = record["id"]
            if previous_id is not None and record_id <= previous_id:
                reason = "duplicate" if record_id == previous_id else "unsorted"
                raise ValueError(
                    f"{shard.path}:{line_number}: {reason} record ID {record_id}"
                )
            previous_id = record_id
            rows += 1
            role_rows[record["role"]] += 1
            yield record_id, record, shard
    shard.observed_rows = rows
    shard.role_rows = role_rows
    if rows != shard.rows:
        raise ValueError(
            f"{shard.path}: sidecar rows={shard.rows}, observed rows={rows}"
        )


def resolve_input_files(values: Iterable[str], label: str) -> list[Path]:
    resolved = [Path(value).resolve() for value in values]
    if not resolved:
        raise ValueError(f"{label} requires at least one shard")
    if len(set(resolved)) != len(resolved):
        raise ValueError(f"{label} contains a duplicate shard path")
    for filename in resolved:
        if not filename.is_file():
            raise ValueError(f"input shard not found: {filename}")
    return sorted(resolved, key=lambda item: str(item))


def assert_shards_unchanged(
    shards: Iterable[Shard],
    exception: type[Exception] = RuntimeError,
    phase: str = "validation",
) -> None:
    unique = {shard.path: shard for shard in shards}
    selections = {shard.selection.path: shard.selection for shard in unique.values()}
    selection_shards = {
        selected.path: selected
        for binding in selections.values()
        for selected in binding.shards
    }
    for shard in unique.values():
        if sha256_file(shard.path) != shard.sha256:
            raise exception(f"input shard changed during {phase}: {shard.path}")
        if sha256_file(shard.sidecar_path) != shard.sidecar_sha256:
            raise exception(
                f"input sidecar changed during {phase}: {shard.sidecar_path}"
            )
    for binding in selections.values():
        if sha256_file(binding.path) != binding.sha256:
            raise exception(
                f"selection manifest changed during {phase}: {binding.path}"
            )
        if (
            sha256_file(binding.certification_path)
            != binding.certification_sha256
        ):
            raise exception(
                f"certification manifest changed during {phase}: "
                f"{binding.certification_path}"
            )
    for selected in selection_shards.values():
        if sha256_file(selected.path) != selected.sha256:
            raise exception(
                f"selection shard changed during {phase}: {selected.path}"
            )


def validate_inputs(
    train_values: Iterable[str],
    validation_values: Iterable[str],
    root: Path | None = None,
    *,
    sample_only: bool = False,
) -> ValidatedInputs:
    contracts = load_contracts(root)
    train_paths = resolve_input_files(train_values, "--train")
    validation_paths = resolve_input_files(validation_values, "--validation")
    # Teacher shards preserve the ID order of their selected input shards, so
    # they normally contain all five deterministic corpus roles. A physical
    # shard may therefore back both trainer streams. Authenticate and validate
    # each physical file exactly once, then select records by their recomputed
    # role; sharing a file does not share a record between the streams.
    all_paths = sorted(
        set(train_paths).union(validation_paths), key=lambda item: str(item)
    )
    selection_cache: dict[Path, SelectionBinding] = {}
    by_path = {
        filename: validate_sidecar(
            filename,
            contracts,
            sample_only=sample_only,
            selection_cache=selection_cache,
        )
        for filename in all_paths
    }
    train = [by_path[filename] for filename in train_paths]
    validation = [by_path[filename] for filename in validation_paths]
    all_shards = [by_path[filename] for filename in all_paths]
    selection_paths = {shard.selection.path for shard in all_shards}
    if len(selection_paths) != 1:
        raise ValueError("all shards must reference one selection manifest file")
    selection_binding = all_shards[0].selection
    selection_hashes = {
        shard.sidecar["input"]["selectionManifest"]["sha256"]
        for shard in all_shards
    }
    if len(selection_hashes) != 1:
        raise ValueError("all shards must bind the same selection manifest SHA-256")
    selection_contract_hashes = {
        shard.sidecar["input"]["selectionManifest"]["selectionContractSha256"]
        for shard in all_shards
    }
    if len(selection_contract_hashes) != 1:
        raise ValueError("all shards must bind the same selection contract SHA-256")
    provided_selection_paths = [
        shard.selection_shard.path
        for shard in all_shards
    ]
    if len(set(provided_selection_paths)) != len(provided_selection_paths):
        raise ValueError(
            "multiple teacher shards bind the same selection input shard"
        )
    expected_selection_paths = {
        shard.path for shard in selection_binding.shards
    }
    if set(provided_selection_paths) != expected_selection_paths:
        missing = sorted(
            str(path)
            for path in expected_selection_paths.difference(
                provided_selection_paths
            )
        )
        raise ValueError(
            "teacher inputs do not cover the complete selection shard "
            f"inventory; missing={missing}"
        )

    iterators = [
        iter_validated_shard(shard, contracts)
        for shard in all_shards
    ]
    previous_id: str | None = None
    source_snapshots: set[str] = set()
    for record_id, record, shard in heapq.merge(
        *iterators, key=lambda item: item[0]
    ):
        if record_id == previous_id:
            raise ValueError(f"duplicate record ID across shards: {record_id}")
        previous_id = record_id
        source_snapshots.add(record["source"]["snapshotSha256"])
        if len(source_snapshots) > 1:
            raise ValueError("all shards must use one source snapshot SHA-256")
    if source_snapshots != {selection_binding.source_snapshot_sha256}:
        raise ValueError(
            "record source snapshot does not match authenticated selection"
        )
    if sum(shard.role_rows["shared-train"] for shard in train) == 0:
        raise ValueError("training role contained zero records")
    if sum(shard.role_rows["nnue-validation"] for shard in validation) == 0:
        raise ValueError("validation role contained zero records")
    assert_shards_unchanged(all_shards, ValueError)
    return ValidatedInputs(
        train=tuple(train),
        validation=tuple(validation),
        selection_manifest_sha256=next(iter(selection_hashes)),
        selection_contract_sha256=next(iter(selection_contract_hashes)),
        source_snapshot_sha256=next(iter(source_snapshots)),
        sample_only=sample_only,
    )


def validation_report(
    validated: ValidatedInputs, contracts: InputContracts
) -> dict[str, Any]:
    assert_shards_unchanged(
        validated.train + validated.validation,
        ValueError,
    )

    def report_shard(shard: Shard, selected_role: str) -> dict[str, Any]:
        return {
            "path": str(shard.path),
            "role": selected_role,
            "rows": shard.rows,
            "selectedRows": shard.role_rows[selected_role],
            "roleRows": {
                role: shard.role_rows[role]
                for role in CORPUS_ROLES
            },
            "sha256": shard.sha256,
            "sidecar": {
                "path": str(shard.sidecar_path),
                "sha256": shard.sidecar_sha256,
            },
        }

    report = {
        "status": (
            "validated-sample-only-pinned-teacher-inputs"
            if validated.sample_only
            else "validated-pinned-teacher-inputs"
        ),
        "train": [
            report_shard(shard, "shared-train")
            for shard in validated.train
        ],
        "validation": [
            report_shard(shard, "nnue-validation")
            for shard in validated.validation
        ],
        "selectionManifestSha256": validated.selection_manifest_sha256,
        "selectionContractSha256": validated.selection_contract_sha256,
        "sourceSnapshotSha256": validated.source_snapshot_sha256,
        "contracts": {
            "teacherManifestSha256": contracts.teacher_sha256,
            "heldoutManifestSha256": contracts.heldout_sha256,
            "corpusContractSha256": contracts.corpus_sha256,
        },
    }
    if validated.sample_only:
        report["fitAllowed"] = False
    return report


def assert_inputs_unchanged(validated: ValidatedInputs) -> None:
    assert_shards_unchanged(
        validated.train + validated.validation,
        RuntimeError,
        "training",
    )


def iter_records(filenames: list[Path], expected_role: str) -> Iterator[dict]:
    if expected_role not in ALLOWED_ROLES:
        raise ValueError(f"trainer is not allowed to read role {expected_role}")
    for filename in filenames:
        with filename.open("r", encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                if not line.strip():
                    raise ValueError(f"{filename}:{number}: blank rows are forbidden")
                record = json.loads(line)
                if record.get("schema") != "chessy.teacher-position.v1":
                    raise ValueError(f"{filename}:{number}: wrong schema")
                role = record.get("role")
                if role not in CORPUS_ROLES:
                    raise ValueError(
                        f"{filename}:{number}: unknown corpus role {role!r}"
                    )
                if role != expected_role:
                    continue
                teacher = record.get("teacher")
                target = (
                    teacher.get("targetWhite")
                    if isinstance(teacher, dict)
                    else None
                )
                if (
                    isinstance(target, bool)
                    or not isinstance(target, (int, float))
                    or not math.isfinite(float(target))
                    or float(target) < 0.0
                    or float(target) > 1.0
                ):
                    raise ValueError(
                        f"{filename}:{number}: pinned teacher target must be in [0,1]"
                    )
                yield record


def shuffled(
    records: Iterable[dict], seed: int, capacity: int
) -> Iterator[dict]:
    """Bounded deterministic shuffle; input file order and seed are frozen."""
    if capacity <= 0:
        raise ValueError("shuffle capacity must be positive")
    rng = random.Random(seed)
    buffer: list[dict] = []
    for record in records:
        if len(buffer) < capacity:
            buffer.append(record)
            continue
        index = rng.randrange(len(buffer))
        yield buffer[index]
        buffer[index] = record
    while buffer:
        yield buffer.pop(rng.randrange(len(buffer)))


def batches(records: Iterable[dict], batch_size: int) -> Iterator[list[dict]]:
    if batch_size <= 0:
        raise ValueError("batch size must be positive")
    batch: list[dict] = []
    for record in records:
        batch.append(record)
        if len(batch) == batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def load_json(filename: Path) -> dict:
    with filename.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def self_test() -> None:
    """Exercise the PyTorch-free trainer and its production trust boundary."""
    checks = 0

    def check(condition: bool, label: str) -> None:
        nonlocal checks
        if not condition:
            raise AssertionError(label)
        checks += 1

    def equal(actual: Any, expected: Any, label: str) -> None:
        check(actual == expected, f"{label}: expected {expected!r}, got {actual!r}")

    def rejects(
        exception: type[BaseException],
        message: str,
        action: Any,
        label: str,
    ) -> None:
        nonlocal checks
        try:
            action()
        except exception as error:
            if message not in str(error):
                raise AssertionError(
                    f"{label}: wrong error {error!r}; expected {message!r}"
                ) from error
        else:
            raise AssertionError(f"{label}: expected {exception.__name__}")
        checks += 1

    root = Path(__file__).resolve().parents[2]
    contracts = load_contracts(root)
    equal(contracts.teacher["id"], "sf18-100kn-v1", "teacher identity")
    equal(
        contracts.teacher["search"]["nodeLimit"],
        100000,
        "teacher node limit",
    )
    equal(
        contracts.heldout["symmetryPolicy"]["clusterSha256"],
        cluster_key(contracts.heldout["incident"]["fen"]),
        "held-out cluster digest",
    )
    equal(
        contracts.heldout["symmetryPolicy"]["positionFamilySha256"],
        position_family_key(contracts.heldout["incident"]["fen"]),
        "held-out family digest",
    )

    feature_fen = "4k3/8/8/8/8/8/P6q/4K3 w - -"
    equal(
        feature_indices(feature_fen, "w"),
        [48, 380, 695, 708],
        "white-perspective feature indices",
    )
    equal(
        feature_indices(feature_fen, "b"),
        [271, 380, 392, 708],
        "black-perspective feature indices",
    )
    equal(
        len(feature_indices(feature_fen, "w")),
        4,
        "one active feature per piece",
    )
    rejects(
        ValueError,
        "perspective must be w or b",
        lambda: feature_indices(feature_fen, "x"),
        "invalid feature perspective",
    )

    castling_fen = "r3k2r/8/8/8/8/8/8/R3K2R w qKkQ -"
    equal(
        parse_position(castling_fen).fen4,
        "r3k2r/8/8/8/8/8/8/R3K2R w KQkq -",
        "castling normalization",
    )
    rejects(
        ValueError,
        "castling right lacks its king or rook",
        lambda: parse_position("4k3/8/8/8/8/8/8/4K3 w K -"),
        "source castling validation",
    )
    rejects(
        ValueError,
        "pawn on rank 1 or rank 8",
        lambda: parse_position("P3k3/8/8/8/8/8/8/4K3 w - -"),
        "back-rank pawn validation",
    )
    rejects(
        ValueError,
        "kings cannot occupy adjacent squares",
        lambda: parse_position("8/8/8/8/8/8/4k3/4K3 w - -"),
        "adjacent king validation",
    )

    source_fen = "r3k2r/p7/8/8/8/8/7P/R3K2R w - -"
    variants = symmetry_fens(source_fen)
    equal(len(variants), 4, "four declared symmetry transforms")
    equal(
        {canonical_fen4(variant) for variant in variants},
        {canonical_fen4(source_fen)},
        "canonical FEN symmetry invariance",
    )
    equal(
        {cluster_key(variant) for variant in variants},
        {cluster_key(source_fen)},
        "cluster symmetry invariance",
    )
    equal(
        {position_family_key(variant) for variant in variants},
        {position_family_key(source_fen)},
        "position-family symmetry invariance",
    )
    equal(
        [
            role_for_family(f"{cell:012x}" + "0" * 52)
            for cell in (209, 210, 255, 300, 345)
        ],
        [
            "shared-train",
            "hce-validation",
            "hce-test",
            "nnue-validation",
            "nnue-test",
        ],
        "role boundaries",
    )

    records = [{"id": number} for number in range(8)]
    shuffled_once = list(shuffled(records, 17, 3))
    equal(
        [record["id"] for record in shuffled_once],
        [2, 1, 4, 5, 6, 0, 3, 7],
        "bounded shuffle contract",
    )
    equal(
        list(shuffled(records, 17, 3)),
        shuffled_once,
        "bounded shuffle determinism",
    )
    equal(
        sorted(record["id"] for record in shuffled_once),
        list(range(8)),
        "bounded shuffle is a permutation",
    )
    rejects(
        ValueError,
        "shuffle capacity must be positive",
        lambda: list(shuffled(records, 17, 0)),
        "zero shuffle capacity",
    )
    equal(
        [[record["id"] for record in batch] for batch in batches(records, 3)],
        [[0, 1, 2], [3, 4, 5], [6, 7]],
        "batch boundaries",
    )
    rejects(
        ValueError,
        "batch size must be positive",
        lambda: list(batches(records, 0)),
        "zero batch size",
    )

    def find_role_fen(role: str) -> str:
        for white_file in range(8):
            for black_file in range(8):
                rank7 = ["1"] * 8
                rank2 = ["1"] * 8
                rank7[black_file] = "p"
                rank2[white_file] = "P"

                def board_rank(squares: list[str]) -> str:
                    result = ""
                    empty = 0
                    for square in squares:
                        if square == "1":
                            empty += 1
                        else:
                            if empty:
                                result += str(empty)
                                empty = 0
                            result += square
                    if empty:
                        result += str(empty)
                    return result

                fen = (
                    "4k3/"
                    + board_rank(rank7)
                    + "/8/8/8/8/"
                    + board_rank(rank2)
                    + "/4K3 w - -"
                )
                if role_for_family(position_family_key(fen)) == role:
                    return fen
        raise AssertionError(f"could not construct a {role} self-test FEN")

    def teacher_record(
        fen: str,
        role: str,
        snapshot_sha: str,
        *,
        sample_only: bool = False,
    ) -> dict[str, Any]:
        family = position_family_key(fen)
        teacher = contracts.teacher
        source = {
            "dataset": (
                "chessy-training-mechanism-fixture"
                if sample_only
                else "lichess-evaluated-positions"
            ),
            "license": "CC0-1.0",
            "snapshotSha256": snapshot_sha,
        }
        if sample_only:
            source["mechanismFixture"] = dict(
                SAMPLE_ONLY_VALIDATION_CONTRACT["mechanismFixture"]
            )
        return {
            "schema": contracts.config["data"]["schema"],
            "id": sha256_text(snapshot_sha + "\n" + fen),
            "fen": fen,
            "canonicalFen": canonical_fen4(fen),
            "cluster": cluster_key(fen),
            "role": role,
            "positionFamily": family,
            "strata": {},
            "source": source,
            "teacher": {
                "id": teacher["id"],
                "release": teacher["engine"]["release"],
                "commit": teacher["engine"]["sourceCommit"],
                "manifestSha256": contracts.teacher_sha256,
                "nodes": teacher["search"]["nodeLimit"],
                "cpWhite": 0,
                "wdlWhite": [250, 500, 250],
                "targetWhite": 0.5,
                "bestMoveUci": "e1d1",
                "pvUci": ["e1d1"],
                "depth": 10,
                "seldepth": 12,
                "scoreNodes": teacher["search"]["nodeLimit"],
                "reportedNodes": teacher["search"]["nodeLimit"],
            },
        }

    def write_selection_fixture(
        directory: Path,
        filename: Path,
        rows: int,
        snapshot_sha: str,
        selection_contract_sha: str,
        *,
        sample_only: bool = False,
        certification_fens: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        mode = (
            SAMPLE_ONLY_VALIDATION_CONTRACT
            if sample_only
            else PRODUCTION_VALIDATION_CONTRACT
        )
        selection_directory = directory / f"{filename.stem}-selection"
        selection_directory.mkdir()
        selection_shard = selection_directory / "selection-000.ndjson"
        selection_shard.write_bytes(filename.read_bytes())
        selection_shard_sha = sha256_file(selection_shard)

        certification = {
            "schema": "chessy.e4.certification-manifest.v1",
            "protocolId": "E4-v1",
            "kind": "certification",
            "status": mode["certificationStatus"],
            "openingClusters": [
                {"fen": fen} for fen in certification_fens
            ],
            "assignments": [],
        }
        certification_path = directory / f"{filename.stem}-certification.json"
        certification_path.write_text(
            json.dumps(certification, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        certification_clusters = {
            cluster_key(fen) for fen in certification_fens
        }
        certification_families = {
            position_family_key(fen) for fen in certification_fens
        }
        selection_manifest = {
            "schemaVersion": 1,
            "state": mode["selectionState"],
            "finalFitAllowed": mode["selectionFitAllowed"],
            "source": {
                "id": mode["selectionSourceId"],
                "url": mode["selectionSourceUrl"],
                "retrieved": "2026-07-31",
                "compressedSha256": snapshot_sha,
                "license": "CC0-1.0",
            },
            "adapter": {
                "selectionContractSha256": selection_contract_sha,
                "shardCount": 1,
            },
            "exclusions": {
                "certificationManifest": str(certification_path),
                "certificationManifestSha256": sha256_file(
                    certification_path
                ),
                "certificationStatus": mode["certificationStatus"],
                "certificationClusterCount": len(certification_clusters),
                "certificationPositionFamilyCount": len(
                    certification_families
                ),
                "pendingCertificationAllowedForTestOnly": mode[
                    "pendingCertificationAllowedForTestOnly"
                ],
            },
            "counts": {"selected": rows},
            "shards": [
                {
                    "path": selection_shard.name,
                    "rows": rows,
                    "canonicalNdjsonSha256": selection_shard_sha,
                }
            ],
        }
        if sample_only:
            selection_manifest["mechanismFixture"] = mode[
                "mechanismFixture"
            ]
            selection_manifest["source"]["mechanismFixture"] = mode[
                "mechanismFixture"
            ]
        selection_path = selection_directory / "manifest.json"
        selection_path.write_text(
            json.dumps(selection_manifest, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return {
            "path": selection_path,
            "sha256": sha256_file(selection_path),
            "selectionContractSha256": selection_contract_sha,
            "certificationStatus": mode["certificationStatus"],
            "shardPath": selection_shard,
            "shardRows": rows,
            "shardSha256": selection_shard_sha,
        }

    def write_sidecar(
        filename: Path,
        rows: int,
        selection: dict[str, Any],
        *,
        sample_only: bool = False,
    ) -> Path:
        teacher = contracts.teacher
        trust = contracts.config["data"]["trustBoundary"]
        sample_contract = trust["sampleOnlyValidation"]
        manifest = {
            "schemaVersion": 1,
            "state": (
                sample_contract["sidecarState"]
                if sample_only
                else trust["sidecarState"]
            ),
            "output": {
                "path": filename.name,
                "rows": rows,
                "sha256": sha256_file(filename),
            },
            "input": {
                "selectionManifest": {
                    "path": str(selection["path"]),
                    "sha256": selection["sha256"],
                    "selectionContractSha256": selection[
                        "selectionContractSha256"
                    ],
                    "certificationStatus": selection[
                        "certificationStatus"
                    ],
                },
                "shard": {
                    "path": str(selection["shardPath"]),
                    "rows": selection["shardRows"],
                    "sha256": selection["shardSha256"],
                },
            },
            "exclusions": {"rows": 0, "sha256": "4" * 64},
            "teacher": {
                "manifest": {"sha256": contracts.teacher_sha256},
                "id": teacher["id"],
                "release": teacher["engine"]["release"],
                "commit": teacher["engine"]["sourceCommit"],
                "executableSha256": teacher["engine"]["executable"]["sha256"],
                "license": teacher["engine"]["license"],
                "use": teacher["engine"]["integration"],
                "nodes": teacher["search"]["nodeLimit"],
                "scorePovFromEngine": teacher["labels"]["enginePov"],
                "storedScorePov": teacher["labels"]["storedPov"],
                "networks": expected_teacher_networks(teacher),
                "options": expected_teacher_options(teacher),
                "watchdog": teacher["watchdog"],
                "transcript": {"sha256": "5" * 64},
            },
        }
        if sample_only:
            manifest["fitAllowed"] = False
            manifest["mechanismFixture"] = sample_contract["mechanismFixture"]
        sidecar = Path(
            str(filename)
            + contracts.config["data"]["trustBoundary"]["sidecarSuffix"]
        )
        sidecar.write_text(
            json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8"
        )
        return sidecar

    with tempfile.TemporaryDirectory(prefix="chessy-nnue-self-test-") as temporary:
        directory = Path(temporary)
        snapshot_sha = "0" * 64
        selection_contract_sha = "2" * 64
        teacher_file = directory / "teacher-000.ndjson"
        train_record = teacher_record(
            find_role_fen("shared-train"), "shared-train", snapshot_sha
        )
        validation_record = teacher_record(
            find_role_fen("nnue-validation"),
            "nnue-validation",
            snapshot_sha,
        )
        mixed_records = sorted(
            (train_record, validation_record), key=lambda record: record["id"]
        )
        teacher_file.write_text(
            "".join(
                json.dumps(record, sort_keys=True) + "\n"
                for record in mixed_records
            ),
            encoding="utf-8",
        )
        selection = write_selection_fixture(
            directory,
            teacher_file,
            2,
            snapshot_sha,
            selection_contract_sha,
        )
        write_sidecar(teacher_file, 2, selection)
        validated = validate_inputs(
            [str(teacher_file)], [str(teacher_file)], root
        )
        report = validation_report(validated, contracts)
        equal(
            report["status"],
            "validated-pinned-teacher-inputs",
            "full trust-boundary validation",
        )
        equal(
            report["selectionManifestSha256"],
            selection["sha256"],
            "selection provenance propagation",
        )
        equal(
            report["sourceSnapshotSha256"],
            snapshot_sha,
            "source provenance propagation",
        )
        equal(
            report["train"][0]["selectedRows"],
            1,
            "mixed-shard training partition",
        )
        equal(
            report["validation"][0]["selectedRows"],
            1,
            "mixed-shard validation partition",
        )
        equal(
            [record["id"] for record in iter_records(
                [teacher_file], "shared-train"
            )],
            [train_record["id"]],
            "mixed-shard streaming role filter",
        )
        sample_file = directory / "teacher-sample-000.ndjson"
        sample_records = sorted(
            (
                teacher_record(
                    train_record["fen"],
                    "shared-train",
                    snapshot_sha,
                    sample_only=True,
                ),
                teacher_record(
                    validation_record["fen"],
                    "nnue-validation",
                    snapshot_sha,
                    sample_only=True,
                ),
            ),
            key=lambda record: record["id"],
        )
        sample_file.write_text(
            "".join(
                json.dumps(record, sort_keys=True) + "\n"
                for record in sample_records
            ),
            encoding="utf-8",
        )
        sample_selection = write_selection_fixture(
            directory,
            sample_file,
            2,
            snapshot_sha,
            selection_contract_sha,
            sample_only=True,
        )
        write_sidecar(
            sample_file,
            2,
            sample_selection,
            sample_only=True,
        )
        rejects(
            ValueError,
            "wrong sidecar schema/state",
            lambda: validate_inputs(
                [str(sample_file)], [str(sample_file)], root
            ),
            "sample sidecar rejected by fit-eligible validation",
        )
        rejects(
            ValueError,
            "wrong sidecar schema/state",
            lambda: validate_inputs(
                [str(teacher_file)],
                [str(teacher_file)],
                root,
                sample_only=True,
            ),
            "fit-eligible sidecar rejected by sample-only validation",
        )
        sample_validated = validate_inputs(
            [str(sample_file)],
            [str(sample_file)],
            root,
            sample_only=True,
        )
        sample_report = validation_report(sample_validated, contracts)
        equal(
            sample_report["status"],
            "validated-sample-only-pinned-teacher-inputs",
            "sample-only validation status",
        )
        equal(
            sample_report["fitAllowed"],
            False,
            "sample-only validation cannot authorize fitting",
        )
        escaped_file = directory / "teacher-sample-escape-000.ndjson"
        escaped_file.write_bytes(sample_file.read_bytes())
        escaped_sidecar = write_sidecar(
            escaped_file,
            2,
            sample_selection,
            sample_only=True,
        )
        escaped_manifest = load_json(escaped_sidecar)
        escaped_manifest["state"] = contracts.config["data"][
            "trustBoundary"
        ]["sidecarState"]
        escaped_manifest.pop("fitAllowed")
        escaped_manifest.pop("mechanismFixture")
        escaped_manifest["input"]["selectionManifest"][
            "certificationStatus"
        ] = "frozen"
        escaped_sidecar.write_text(
            json.dumps(escaped_manifest, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        rejects(
            ValueError,
            "selection manifest has the wrong mode/state",
            lambda: validate_inputs(
                [str(escaped_file)], [str(escaped_file)], root
            ),
            "editing only the sample sidecar cannot authorize production",
        )
        certification_file = directory / "teacher-certification-000.ndjson"
        certification_file.write_bytes(teacher_file.read_bytes())
        certification_selection = write_selection_fixture(
            directory,
            certification_file,
            2,
            snapshot_sha,
            selection_contract_sha,
            certification_fens=(train_record["fen"],),
        )
        write_sidecar(
            certification_file,
            2,
            certification_selection,
        )
        rejects(
            ValueError,
            "certification cluster/family is forbidden",
            lambda: validate_inputs(
                [str(certification_file)],
                [str(certification_file)],
                root,
            ),
            "certification opening holdout rejection",
        )
        assert_inputs_unchanged(validated)
        checks += 1
        teacher_file.write_text(
            json.dumps(train_record, sort_keys=True) + "\n ",
            encoding="utf-8",
        )
        rejects(
            RuntimeError,
            "input shard changed during training",
            lambda: assert_inputs_unchanged(validated),
            "post-validation input mutation",
        )
        rejects(
            ValueError,
            "trainer is not allowed to read role nnue-test",
            lambda: list(iter_records([teacher_file], "nnue-test")),
            "test-role refusal",
        )

    print(f"{checks} PyTorch-free NNUE trainer self-test checks passed")


def train(args: argparse.Namespace) -> None:
    if getattr(args, "sample_only", False):
        raise SystemExit("sample-only inputs are validation-only and cannot train")
    root = Path(__file__).resolve().parents[2]
    validated = validate_inputs(args.train, args.validation, root)
    contracts = load_contracts(root)
    report = validation_report(validated, contracts)
    train_files = [shard.path for shard in validated.train]
    validation_files = [shard.path for shard in validated.validation]

    try:
        import torch
        from torch import nn
    except ImportError as error:
        raise SystemExit(
            "PyTorch is required for training; install the pinned BSD-3-Clause "
            "development dependency from nnue-v1-train.json"
        ) from error

    architecture_path = root / "eval/training/nnue-v1-architecture.json"
    architecture = load_json(architecture_path)
    config = contracts.config
    config_path = contracts.config_path
    torch_version = torch.__version__.split("+", 1)[0]
    if torch_version != "2.7.1":
        raise SystemExit(
            "pinned trainer requires PyTorch 2.7.1; got " + torch.__version__
        )
    candidates = {item["id"]: item for item in architecture["candidates"]}
    if args.architecture not in candidates:
        raise SystemExit(
            f"unknown architecture {args.architecture}; choose "
            + ", ".join(sorted(candidates))
        )
    candidate = candidates[args.architecture]
    if args.seed not in architecture["trainingSeeds"]:
        raise SystemExit("seed is not one of the three preregistered seeds")
    output = Path(args.output).resolve()
    card_path = output.with_suffix(output.suffix + ".model-card.json")
    if output.exists() or card_path.exists():
        raise SystemExit("refusing to overwrite checkpoint or model card")

    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    device = torch.device(args.device)
    hidden = int(candidate["hidden"])
    activation_name = candidate["activation"]

    class ChessyNnue(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.input = nn.Linear(768, hidden)
            self.output = nn.Linear(hidden * 2, 1)

        def activate(self, value):  # type: ignore[no-untyped-def]
            clipped = torch.clamp(value, 0.0, 1.0)
            return clipped.square() if activation_name == "SCReLU" else clipped

        def forward(self, stm, nstm):  # type: ignore[no-untyped-def]
            first = self.activate(self.input(stm))
            second = self.activate(self.input(nstm))
            return self.output(torch.cat((first, second), dim=1)).squeeze(1)

    model = ChessyNnue().to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(config["optimizer"]["learningRate"]),
        weight_decay=float(config["optimizer"]["weightDecay"]),
    )
    loss_function = nn.BCEWithLogitsLoss()
    batch_size = int(config["optimizer"]["batchSize"])
    shuffle_capacity = int(config["optimizer"]["shuffleBufferRecords"])
    epochs = int(config["optimizer"]["epochs"])
    clip_norm = float(config["optimizer"]["gradientClipNorm"])

    def tensors(batch: list[dict]):
        stm = torch.zeros((len(batch), 768), dtype=torch.float32)
        nstm = torch.zeros((len(batch), 768), dtype=torch.float32)
        target = torch.empty(len(batch), dtype=torch.float32)
        for row, record in enumerate(batch):
            _, turn = parse_fen4(record["fen"])
            other = "b" if turn == "w" else "w"
            stm[row, feature_indices(record["fen"], turn)] = 1.0
            nstm[row, feature_indices(record["fen"], other)] = 1.0
            white_target = float(record["teacher"]["targetWhite"])
            target[row] = white_target if turn == "w" else 1.0 - white_target
        return stm.to(device), nstm.to(device), target.to(device)

    history: list[dict] = []
    for epoch in range(epochs):
        model.train()
        total_loss = 0.0
        total_rows = 0
        source = iter_records(train_files, "shared-train")
        source = shuffled(source, args.seed * 1000 + epoch, shuffle_capacity)
        for batch in batches(source, batch_size):
            stm, nstm, target = tensors(batch)
            optimizer.zero_grad(set_to_none=True)
            logits = model(stm, nstm)
            loss = loss_function(logits, target)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), clip_norm)
            optimizer.step()
            total_loss += float(loss.detach()) * len(batch)
            total_rows += len(batch)
        if total_rows == 0:
            raise SystemExit("training role contained zero records")

        model.eval()
        validation_loss = 0.0
        validation_rows = 0
        with torch.no_grad():
            validation_source = iter_records(validation_files, "nnue-validation")
            for batch in batches(validation_source, batch_size):
                stm, nstm, target = tensors(batch)
                loss = loss_function(model(stm, nstm), target)
                validation_loss += float(loss) * len(batch)
                validation_rows += len(batch)
        if validation_rows == 0:
            raise SystemExit("validation role contained zero records")
        epoch_result = {
            "epoch": epoch + 1,
            "trainLoss": total_loss / total_rows,
            "trainRows": total_rows,
            "validationLoss": validation_loss / validation_rows,
            "validationRows": validation_rows,
        }
        history.append(epoch_result)
        print(json.dumps(epoch_result, sort_keys=True), flush=True)

    assert_inputs_unchanged(validated)
    checkpoint = {
        "schema": "chessy-nnue-research-checkpoint-v1",
        "architecture": args.architecture,
        "seed": args.seed,
        "inputStateDict": model.state_dict(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f".tmp-{os.getpid()}")
    torch.save(checkpoint, temporary)
    temporary.replace(output)

    model_card = {
        "schemaVersion": 1,
        "status": "research-only-no-runtime-path",
        "architecture": args.architecture,
        "seed": args.seed,
        "history": history,
        "checkpoint": {
            "path": output.name,
            "sha256": sha256_file(output),
        },
        "inputs": report,
        "contracts": {
            "architectureSha256": sha256_file(architecture_path),
            "trainingConfigSha256": sha256_file(config_path),
            "teacherManifestSha256": contracts.teacher_sha256,
            "heldoutManifestSha256": contracts.heldout_sha256,
            "corpusContractSha256": contracts.corpus_sha256,
            "torchVersion": torch.__version__,
            "pythonVersion": sys.version.split()[0],
            "device": str(device),
        },
    }
    card_path.write_text(
        json.dumps(model_card, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run the PyTorch-free trainer contract self-test",
    )
    parser.add_argument("--features", help="print the frozen 768 feature indices")
    parser.add_argument("--perspective", choices=("w", "b"))
    parser.add_argument(
        "--validate-inputs",
        action="store_true",
        help="validate shard sidecars and records without importing PyTorch",
    )
    parser.add_argument(
        "--sample-only",
        action="store_true",
        help=(
            "validate explicitly non-fit sample sidecars; requires "
            "--validate-inputs"
        ),
    )
    parser.add_argument("--train", action="extend", nargs="+", default=[])
    parser.add_argument("--validation", action="extend", nargs="+", default=[])
    parser.add_argument("--architecture")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.sample_only and not args.validate_inputs:
        parser.error(
            "--sample-only requires --validate-inputs and cannot be used for training"
        )
    if args.self_test:
        self_test()
        return
    if args.features is not None:
        if args.perspective is None:
            parser.error("--features requires --perspective")
        print(json.dumps(feature_indices(args.features, args.perspective)))
        return
    if args.validate_inputs:
        if not args.train or not args.validation:
            parser.error("--validate-inputs requires --train and --validation")
        try:
            root = Path(__file__).resolve().parents[2]
            validated = validate_inputs(
                args.train,
                args.validation,
                root,
                sample_only=args.sample_only,
            )
            contracts = load_contracts(root)
        except (OSError, ValueError, KeyError, TypeError) as error:
            parser.error(str(error))
        print(json.dumps(validation_report(validated, contracts), sort_keys=True))
        return
    required = {
        "--train": args.train,
        "--validation": args.validation,
        "--architecture": args.architecture,
        "--seed": args.seed,
        "--output": args.output,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        parser.error("training requires " + ", ".join(missing))
    train(args)


if __name__ == "__main__":
    main()
