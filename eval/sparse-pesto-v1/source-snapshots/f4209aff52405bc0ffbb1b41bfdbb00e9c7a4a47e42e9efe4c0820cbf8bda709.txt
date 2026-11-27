#!/usr/bin/env python3
"""Frozen, sparse, linear-in-weights chess features for research only.

The 17,280 coefficients are residuals over the unmodified shipped HCE.  IDs are
stable and contain no learned routing: feature selection, king buckets, pawn
contacts and first-blocker ray geometry depend only on the board.  A position
activates a small fraction of the table.  This is not an NNUE implementation.

Squares use a1=0.  Black pieces and both kings are vertically reflected into
the Black piece's perspective.  The eight ray directions are N, NE, E, SE, S,
SW, W, NW in that perspective.  A ray feature records the first occupied
square regardless of whether the source piece could legally attack it.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
from typing import Iterable, Mapping, Sequence

SCHEMA = "chessy-sparse-pesto-v1"
BASE_FEATURES = 8640
N_FEATURES = BASE_FEATURES * 2
PHASE_MAX = 24
PHASE_WEIGHTS = (0, 1, 1, 2, 4, 0)
FAMILIES = {
    "pst": (0, 384),
    "own_king": (384, 3456),
    "enemy_king": (3456, 6528),
    "pawn_context": (6528, 8064),
    "ray": (8064, 8640),
}
DIRECTIONS = ((1, 0), (1, 1), (0, 1), (-1, 1),
              (-1, 0), (-1, -1), (0, -1), (1, -1))
KNIGHTS = ((2, 1), (2, -1), (-2, 1), (-2, -1),
           (1, 2), (1, -2), (-1, 2), (-1, -2))
PIECE_CHARS = ".PNBRQKpnbrqk"
_PIECES = {char: index for index, char in enumerate(PIECE_CHARS) if index}


@dataclass(frozen=True)
class Position:
    board: tuple[int, ...]
    turn: int
    kings: tuple[int, int]


def parse_fen(fen: str) -> Position:
    """Parse structure, not full chess legality; dataset admission owns legality."""
    if not isinstance(fen, str):
        raise ValueError("FEN must be a string")
    fields = fen.split()
    if len(fields) not in (4, 6) or fields[1] not in ("w", "b"):
        raise ValueError("expected a four- or six-field FEN")
    board = [0] * 64
    kings = [-1, -1]
    rows = fields[0].split("/")
    if len(rows) != 8:
        raise ValueError("FEN must contain eight ranks")
    for rank_from_top, row in enumerate(rows):
        file = 0
        for char in row:
            if char in "12345678":
                file += int(char)
            elif char in _PIECES and file < 8:
                piece = _PIECES[char]
                square = (7 - rank_from_top) * 8 + file
                board[square] = piece
                if (piece - 1) % 6 == 5:
                    color = (piece - 1) // 6
                    if kings[color] != -1:
                        raise ValueError("duplicate king")
                    kings[color] = square
                file += 1
            else:
                raise ValueError("invalid FEN piece or rank width")
            if file > 8:
                raise ValueError("invalid FEN rank width")
        if file != 8:
            raise ValueError("invalid FEN rank width")
    if min(kings) < 0:
        raise ValueError("both kings are required")
    if fields[2] != "-" and (any(c not in "KQkq" for c in fields[2])
                              or len(set(fields[2])) != len(fields[2])):
        raise ValueError("invalid castling field")
    if fields[3] != "-" and not re.fullmatch(r"[a-h][36]", fields[3]):
        raise ValueError("invalid en passant field")
    if len(fields) == 6 and (not fields[4].isdigit() or not fields[5].isdigit()
                              or int(fields[5]) < 1):
        raise ValueError("invalid move counters")
    return Position(tuple(board), int(fields[1] == "b"), tuple(kings))


def _position(value: str | Position) -> Position:
    return parse_fen(value) if isinstance(value, str) else value


def king_bucket(square: int) -> int:
    return (square // 32) * 4 + (square % 8) // 2


def _pawn_attacks(board: Sequence[int]) -> tuple[int, int]:
    attacked = [0, 0]
    for square, piece in enumerate(board):
        if piece not in (1, 7):
            continue
        color = int(piece == 7)
        rank, file = divmod(square, 8)
        next_rank = rank + (1 if color == 0 else -1)
        if not 0 <= next_rank < 8:
            continue
        if file > 0:
            attacked[color] |= 1 << (next_rank * 8 + file - 1)
        if file < 7:
            attacked[color] |= 1 << (next_rank * 8 + file + 1)
    return tuple(attacked)


def extract_raw(value: str | Position, families: Iterable[str] | None = None
                ) -> tuple[dict[int, int], int]:
    """Return nonzero integer counts and material phase, before MG/EG tapering."""
    pos = _position(value)
    enabled = set(FAMILIES) if families is None else set(families)
    if enabled - FAMILIES.keys():
        raise ValueError("unknown feature family")
    counts: dict[int, int] = {}
    phase = 0
    pawn_attacks = _pawn_attacks(pos.board) if "pawn_context" in enabled else (0, 0)

    def add(index: int, sign: int) -> None:
        counts[index] = counts.get(index, 0) + sign

    for square, piece in enumerate(pos.board):
        if not piece:
            continue
        color, kind = divmod(piece - 1, 6)
        sign = 1 if color == 0 else -1
        oriented = square ^ (56 if color else 0)
        piece_square = kind * 64 + oriented
        phase += PHASE_WEIGHTS[kind]
        if "pst" in enabled:
            add(piece_square, sign)
        if "own_king" in enabled:
            bucket = king_bucket(pos.kings[color] ^ (56 if color else 0))
            add(384 + bucket * 384 + piece_square, sign)
        if "enemy_king" in enabled:
            bucket = king_bucket(pos.kings[1 - color] ^ (56 if color else 0))
            add(3456 + bucket * 384 + piece_square, sign)
        if "pawn_context" in enabled:
            state = ((pawn_attacks[color] >> square) & 1)
            state |= ((pawn_attacks[1 - color] >> square) & 1) << 1
            add(6528 + state * 384 + piece_square, sign)
        if "ray" in enabled:
            rank, file = divmod(square, 8)
            for direction, (oriented_dr, df) in enumerate(DIRECTIONS):
                dr = oriented_dr if color == 0 else -oriented_dr
                r, f = rank + dr, file + df
                while 0 <= r < 8 and 0 <= f < 8:
                    target = pos.board[r * 8 + f]
                    if target:
                        target_color, target_kind = divmod(target - 1, 6)
                        enemy = int(target_color != color)
                        relation = (((kind * 6 + target_kind) * 2 + enemy) * 8
                                    + direction)
                        add(8064 + relation, sign)
                        break
                    r += dr
                    f += df
    return {index: count for index, count in counts.items() if count}, min(24, phase)


def extract(value: str | Position, families: Iterable[str] | None = None
            ) -> tuple[list[int], list[float]]:
    """Return sorted CSR-ready feature IDs and phase-weighted White-POV counts."""
    raw, phase = extract_raw(value, families)
    ordered = sorted(raw)
    ids: list[int] = []
    values: list[float] = []
    for offset, factor in ((0, phase / 24), (BASE_FEATURES, (24 - phase) / 24)):
        if factor:
            ids.extend(index + offset for index in ordered)
            values.extend(raw[index] * factor for index in ordered)
    return ids, values


def correction(value: str | Position, weights: Sequence[float], *,
               integer: bool = False, families: Iterable[str] | None = None) -> float | int:
    """Evaluate a correction, with optional exact round-half-away-from-zero.

    The correction uses symmetric integer rounding so color reversal is exact.
    Shipped HCE rounding is preserved separately; its historical negative-half
    ties mean the *total* score can differ by one cp under color reversal.
    """
    if len(weights) != N_FEATURES:
        raise ValueError(f"expected {N_FEATURES} coefficients")
    raw, phase = extract_raw(value, families)
    numerator = sum(count * (weights[index] * phase
                            + weights[index + BASE_FEATURES] * (24 - phase))
                    for index, count in raw.items())
    if integer:
        if any(int(weight) != weight for weight in weights):
            raise ValueError("integer evaluator requires integer coefficients")
        rounded = (abs(int(numerator)) + 12) // 24
        return rounded if numerator >= 0 else -rounded
    return numerator / 24


@lru_cache(maxsize=1)
def baseline_constants() -> dict:
    """Consume the exact source bytes once; expose their hash in the schema."""
    source = Path(__file__).resolve().parents[2] / "experiments/wasm/src/eval.rs"
    payload = source.read_bytes()
    text = payload.decode("utf-8")
    result = {"source_sha256": hashlib.sha256(payload).hexdigest()}
    for name in ("VALUES_MG", "VALUES_EG", "PST_MG", "PST_EG", "MOBILITY",
                 "PASSED_MG", "PASSED_EG"):
        match = re.search(r"const " + name + r":.*?=\s*(\[.*?\]);", text, re.S)
        if not match:
            raise ValueError(f"shipped baseline constant missing: {name}")
        result[name] = json.loads(match.group(1).replace(",\n]", "\n]")
                                  .replace(",\n    ]", "\n    ]"))
    for name in ("DOUBLED", "ISOLATED", "SHIELD"):
        match = re.search(r"const " + name + r": i32 = (\d+);", text)
        if not match:
            raise ValueError(f"shipped baseline constant missing: {name}")
        result[name] = int(match.group(1))
    return result


def _mobility(board: Sequence[int], square: int, color: int, kind: int) -> int:
    rank, file = divmod(square, 8)
    if kind == 1:
        return sum(1 for dr, df in KNIGHTS
                   if 0 <= rank + dr < 8 and 0 <= file + df < 8
                   and (not board[(rank + dr) * 8 + file + df]
                        or (board[(rank + dr) * 8 + file + df] - 1) // 6 != color))
    directions = DIRECTIONS[1::2] if kind == 2 else DIRECTIONS[0::2] if kind == 3 else DIRECTIONS
    count = 0
    for dr, df in directions:
        r, f = rank + dr, file + df
        while 0 <= r < 8 and 0 <= f < 8:
            occupant = board[r * 8 + f]
            if occupant:
                count += int((occupant - 1) // 6 != color)
                break
            count += 1
            r += dr
            f += df
    return count


def baseline_score(value: str | Position) -> int:
    """Independent Python port of the shipped evaluator, including its rounding."""
    pos = _position(value)
    c = baseline_constants()
    mg = eg = phase = 0
    pawn_files = [[0] * 8 for _ in range(2)]
    pawns: list[list[int]] = [[], []]
    force = [0, 0]
    pieces = [0, 0]
    for square, piece in enumerate(pos.board):
        if not piece:
            continue
        color, kind = divmod(piece - 1, 6)
        sign = 1 if not color else -1
        table_square = square ^ (56 if not color else 0)
        phase += PHASE_WEIGHTS[kind]
        pmg = c["VALUES_MG"][kind] + c["PST_MG"][kind][table_square]
        peg = c["VALUES_EG"][kind] + c["PST_EG"][kind][table_square]
        if kind != 5:
            force[color] += 1
        if kind == 0:
            pawn_files[color][square % 8] += 1
            pawns[color].append(square)
        elif kind != 5:
            pieces[color] += 1
            mob = _mobility(pos.board, square, color, kind) * c["MOBILITY"][kind]
            pmg += mob
            peg += mob
        mg += sign * pmg
        eg += sign * peg
    for color in (0, 1):
        sign = 1 if color == 0 else -1
        penalty = sum(max(0, count - 1) * c["DOUBLED"] for count in pawn_files[color])
        mg -= sign * penalty
        eg -= sign * penalty
        for square in pawns[color]:
            rank, file = divmod(square, 8)
            isolated = not ((file > 0 and pawn_files[color][file - 1])
                            or (file < 7 and pawn_files[color][file + 1]))
            if isolated:
                mg -= sign * c["ISOLATED"]
                eg -= sign * c["ISOLATED"]
            passed = not any(abs(enemy % 8 - file) <= 1
                             and ((enemy // 8 > rank) if color == 0 else (enemy // 8 < rank))
                             for enemy in pawns[1 - color])
            if passed:
                relative_rank = max(0, min(6, rank - 1 if color == 0 else 6 - rank))
                mg += sign * c["PASSED_MG"][relative_rank]
                eg += sign * c["PASSED_EG"][relative_rank]
        king_rank, king_file = divmod(pos.kings[color], 8)
        shield_rank = king_rank + (1 if color == 0 else -1)
        if 0 <= shield_rank < 8:
            for file in range(max(0, king_file - 1), min(8, king_file + 2)):
                if pos.board[shield_rank * 8 + file] == 1 + color * 6:
                    mg += sign * c["SHIELD"]
    phase = min(24, phase)
    score = (mg * phase + eg * (24 - phase) + 12) // 24
    for color in (0, 1):
        if pieces[color] and force[1 - color] == 0:
            loser_rank, loser_file = divmod(pos.kings[1 - color], 8)
            winner_rank, winner_file = divmod(pos.kings[color], 8)
            center = max(3 - loser_file, loser_file - 4) + max(3 - loser_rank, loser_rank - 4)
            distance = abs(loser_rank - winner_rank) + abs(loser_file - winner_file)
            score += (1 if color == 0 else -1) * (8 * center + 2 * (14 - distance))
            break
    return score


def schema() -> dict:
    return {"schema": SCHEMA, "coefficients": N_FEATURES, "base_features": BASE_FEATURES,
            "phase_max": PHASE_MAX, "score_pov": "white", "square_zero": "a1",
            "black_orientation": "vertical-rank-flip", "families": FAMILIES,
            "ray_directions": DIRECTIONS, "phase_weights": PHASE_WEIGHTS,
            "baseline_source_sha256": baseline_constants()["source_sha256"],
            "rounding": "HCE unchanged; residual round-half-away-from-zero"}


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 2 and sys.argv[1] == "--schema":
        print(json.dumps(schema(), sort_keys=True, indent=2))
    else:
        for line in sys.stdin:
            fen = line.strip()
            if fen:
                ids, values = extract(fen)
                print(json.dumps({"baseline": baseline_score(fen), "ids": ids, "values": values}))
