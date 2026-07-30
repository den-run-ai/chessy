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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator


PIECES = ("P", "N", "B", "R", "Q", "K")
ALLOWED_ROLES = {"shared-train", "nnue-validation"}
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


@dataclass
class Shard:
    path: Path
    role: str
    sha256: str
    rows: int
    sidecar_path: Path
    sidecar_sha256: str
    sidecar: dict[str, Any]
    observed_rows: int = 0


@dataclass(frozen=True)
class ValidatedInputs:
    train: tuple[Shard, ...]
    validation: tuple[Shard, ...]
    selection_manifest_sha256: str
    selection_contract_sha256: str
    source_snapshot_sha256: str


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


def validate_sidecar(
    filename: Path, expected_role: str, contracts: InputContracts
) -> Shard:
    suffix = contracts.config["data"]["trustBoundary"]["sidecarSuffix"]
    sidecar_path = Path(str(filename) + suffix)
    if not sidecar_path.is_file():
        raise ValueError(f"{filename}: required sidecar is missing: {sidecar_path}")
    sidecar_sha = sha256_file(sidecar_path)
    manifest = load_json(sidecar_path)
    label = str(sidecar_path)
    expected_state = contracts.config["data"]["trustBoundary"]["sidecarState"]
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("state") != expected_state
    ):
        raise ValueError(f"{label}: wrong sidecar schema/state")

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
    require_sha256(selection.get("sha256"), f"{label}.input.selectionManifest.sha256")
    require_sha256(
        selection.get("selectionContractSha256"),
        f"{label}.input.selectionManifest.selectionContractSha256",
    )
    if selection.get("certificationStatus") != "frozen":
        raise ValueError(
            f"{label}: pending/test-only certification selections are forbidden"
        )
    input_shard = require_object(source.get("shard"), f"{label}.input.shard")
    input_rows = require_nonnegative_int(
        input_shard.get("rows"), f"{label}.input.shard.rows"
    )
    require_sha256(input_shard.get("sha256"), f"{label}.input.shard.sha256")
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
        role=expected_role,
        sha256=actual_sha,
        rows=rows,
        sidecar_path=sidecar_path,
        sidecar_sha256=sidecar_sha,
        sidecar=manifest,
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
    if (
        source.get("dataset") != "lichess-evaluated-positions"
        or source.get("license") != "CC0-1.0"
    ):
        raise ValueError(f"{label}: source dataset/license is not allowed")
    snapshot_sha = require_sha256(
        source.get("snapshotSha256"), f"{label}.source.snapshotSha256"
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
    if record.get("role") != role_for_family(family):
        raise ValueError(f"{label}: recomputed role does not match")
    if record["role"] != shard.role:
        raise ValueError(
            f"{label}: role {record['role']!r}, "
            f"expected exact shard role {shard.role!r}"
        )
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
            yield record_id, record, shard
    shard.observed_rows = rows
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


def validate_inputs(
    train_values: Iterable[str],
    validation_values: Iterable[str],
    root: Path | None = None,
) -> ValidatedInputs:
    contracts = load_contracts(root)
    train_paths = resolve_input_files(train_values, "--train")
    validation_paths = resolve_input_files(validation_values, "--validation")
    overlap = set(train_paths).intersection(validation_paths)
    if overlap:
        raise ValueError(f"train/validation reuse the same shard: {sorted(overlap)[0]}")
    train = [
        validate_sidecar(filename, "shared-train", contracts)
        for filename in train_paths
    ]
    validation = [
        validate_sidecar(filename, "nnue-validation", contracts)
        for filename in validation_paths
    ]
    all_shards = train + validation
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
    if sum(shard.observed_rows for shard in train) == 0:
        raise ValueError("training role contained zero records")
    if sum(shard.observed_rows for shard in validation) == 0:
        raise ValueError("validation role contained zero records")
    return ValidatedInputs(
        train=tuple(train),
        validation=tuple(validation),
        selection_manifest_sha256=next(iter(selection_hashes)),
        selection_contract_sha256=next(iter(selection_contract_hashes)),
        source_snapshot_sha256=next(iter(source_snapshots)),
    )


def validation_report(
    validated: ValidatedInputs, contracts: InputContracts
) -> dict[str, Any]:
    def report_shard(shard: Shard) -> dict[str, Any]:
        return {
            "path": str(shard.path),
            "role": shard.role,
            "rows": shard.rows,
            "sha256": shard.sha256,
            "sidecar": {
                "path": str(shard.sidecar_path),
                "sha256": shard.sidecar_sha256,
            },
        }

    return {
        "status": "validated-pinned-teacher-inputs",
        "train": [report_shard(shard) for shard in validated.train],
        "validation": [report_shard(shard) for shard in validated.validation],
        "selectionManifestSha256": validated.selection_manifest_sha256,
        "selectionContractSha256": validated.selection_contract_sha256,
        "sourceSnapshotSha256": validated.source_snapshot_sha256,
        "contracts": {
            "teacherManifestSha256": contracts.teacher_sha256,
            "heldoutManifestSha256": contracts.heldout_sha256,
            "corpusContractSha256": contracts.corpus_sha256,
        },
    }


def assert_inputs_unchanged(validated: ValidatedInputs) -> None:
    for shard in validated.train + validated.validation:
        if sha256_file(shard.path) != shard.sha256:
            raise RuntimeError(f"input shard changed during training: {shard.path}")
        if sha256_file(shard.sidecar_path) != shard.sidecar_sha256:
            raise RuntimeError(
                f"input sidecar changed during training: {shard.sidecar_path}"
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
                if record.get("role") != expected_role:
                    raise ValueError(
                        f"{filename}:{number}: role {record.get('role')!r}, "
                        f"expected {expected_role!r}"
                    )
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


def train(args: argparse.Namespace) -> None:
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
    parser.add_argument("--features", help="print the frozen 768 feature indices")
    parser.add_argument("--perspective", choices=("w", "b"))
    parser.add_argument(
        "--validate-inputs",
        action="store_true",
        help="validate shard sidecars and records without importing PyTorch",
    )
    parser.add_argument("--train", action="extend", nargs="+", default=[])
    parser.add_argument("--validation", action="extend", nargs="+", default=[])
    parser.add_argument("--architecture")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
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
            validated = validate_inputs(args.train, args.validation, root)
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
