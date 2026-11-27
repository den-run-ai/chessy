#!/usr/bin/env python3
"""A fresh, label-blind development bank for sparse-v2 paired games.

This reads earlier role files solely for authenticated family/cluster metadata.
It never reads their teacher values into a decision or opens a model outcome.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import heapq
import json
import os
from pathlib import Path

import chess

from tools.sparse_eval.data import key_data, load_quarantine

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "chessy.sparse-game-bank.v2"
SALT = "chessy.sparse-game-bank.v2.20261127"
EXPECTED = {
    "primary": "16676c7aca9ea410b8c0518594fb78527668d00f6b3f343fe6c5c6f70883723e",
    "natural": "8053024c4c6b70bd66fc4463b4f8e7c4b24f380f201f946618e2ef1c6a030ab4",
    "ood": "3180d17d7958f10b7ebd9830db3d64633fe706868b6323d6846489d4a654e1d2",
}
RULES = {
    "selectedRoots": 64, "minimumPly": 16, "maximumPly": 32, "minimumPhase": 18,
    "priority": "SHA256(salt NUL opaque sourceGameId), ascending; first eligible representative",
    "salt": SALT, "rankingWindow": 4096,
    "uniqueKeys": ["sourceGameId", "rootFamily", "rootCluster", "ply8Family"],
    "quarantine": "all prior primary role families/clusters, all 4096 OOD root families/clusters/games, historical fixtures",
    "rootRequirements": "full legal standard-start replay, no check, no current terminal/threefold/fifty-move draw",
    "teacherFiltering": False, "gameResultFiltering": False,
    "uncertaintyGrouping": "opening pair; secondary cluster by the structural family after four recorded plies",
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def write(path, raw):
    with open(path, "xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": Path(path).name, "bytes": len(raw), "sha256": sha(raw)}


def read_manifest(path, expected):
    path = Path(path)
    raw = path.read_bytes()
    if sha(raw) != expected:
        raise ValueError("wrong frozen source manifest: " + str(path))
    return json.loads(raw), {"path": str(path), "sha256": sha(raw), "bytes": len(raw)}


def rows(directory, binding):
    """Hash and parse the same retained input descriptor, then verify inventory."""
    relative = binding.get("path")
    if not isinstance(relative, str) or Path(relative).name != relative:
        raise ValueError("source row path must be a local filename")
    path = Path(directory) / relative
    if path.is_symlink():
        raise ValueError("source rows may not be symlinks")
    digest = hashlib.sha256()
    count = size = 0
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        for raw in stream:
            if not raw.endswith(b"\n"):
                raise ValueError("truncated source row")
            digest.update(raw)
            count += 1
            size += len(raw)
            yield count, json.loads(raw)
        after = os.fstat(stream.fileno())
        visible = path.stat()
    identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
    if identity(before) != identity(after) or identity(visible) != identity(after):
        raise ValueError("source rows changed during consumption")
    if (digest.hexdigest(), size, count) != (binding["sha256"], binding["bytes"], binding["rows"]):
        raise ValueError("incomplete or altered source inventory")


def replay(row):
    moves = row.get("prefixUci")
    if not isinstance(moves, list) or len(moves) != row.get("selectedPly"):
        raise ValueError("missing complete source-game prefix")
    board = chess.Board()
    groups = {}
    for index, token in enumerate(moves, 1):
        move = chess.Move.from_uci(token)
        if move not in board.legal_moves:
            raise ValueError("illegal source-game history")
        board.push(move)
        if index in (4, 8):
            groups[index] = key_data(board.fen(en_passant="fen"))["family"]
    if board.fen(en_passant="fen") != row["fen"]:
        raise ValueError("opening history/FEN mismatch")
    if not board.is_valid() or board.is_check() or board.is_game_over(claim_draw=False) \
            or board.is_repetition(3) or board.halfmove_clock >= 100:
        raise ValueError("inadmissible game root")
    keys = key_data(row["fen"])
    if any(keys[key] != row[key] for key in ("family", "cluster", "phase")):
        raise ValueError("source grouping metadata does not reproduce")
    return groups


def choose(ranked, count=64, quarantine=None):
    """Greedy unique-group selection; sorted input is the complete rank prefix."""
    groups_seen = {key: set() for key in RULES["uniqueKeys"]}
    selected, rejected = [], Counter()
    for priority, source_index, row in ranked:
        groups = replay(row)
        keys = {"sourceGameId": row["sourceGameId"], "rootFamily": row["family"],
                "rootCluster": row["cluster"], "ply8Family": groups[8]}
        if quarantine and (keys["rootFamily"] in quarantine["families"] or
                           keys["rootCluster"] in quarantine["clusters"]):
            rejected["historicalQuarantine"] += 1
            continue
        duplicate = next((key for key, value in keys.items() if value in groups_seen[key]), None)
        if duplicate:
            rejected["duplicate:" + duplicate] += 1
            continue
        for key, value in keys.items():
            groups_seen[key].add(value)
        selected.append({"index": len(selected), "priority": f"{priority:064x}",
                         "sourcePositionIndex": source_index, "sourceId": row["sourceId"],
                         "sourceGameId": row["sourceGameId"], "fen": row["fen"],
                         "prefixUci": row["prefixUci"], "selectedPly": row["selectedPly"],
                         "phase": row["phase"], "rootFamily": row["family"],
                         "rootCluster": row["cluster"], "ply8Family": groups[8],
                         "ply4Family": groups[4], "rootSeed": 0})
        if len(selected) == count:
            return selected, dict(rejected)
    raise ValueError("frozen ranking window cannot supply complete unique opening bank")


def select(data_root, output):
    data_root, output = Path(data_root), Path(output)
    manifests, identities = {}, {}
    folders = {"primary": data_root / "eval-v1", "natural": data_root / "pgn-v1",
               "ood": data_root / "ood-selection-v1"}
    for key in folders:
        manifests[key], identities[key] = read_manifest(folders[key] / "manifest.json", EXPECTED[key])
    primary, natural, ood = (manifests[key] for key in ("primary", "natural", "ood"))
    bindings = primary.get("files", [])
    if len(bindings) != 3 or {x.get("role") for x in bindings} != {"train", "validation", "holdout"}:
        raise ValueError("all prior primary roles required for exclusion metadata")
    if len(ood.get("files", [])) != 1 or ood.get("selectedGames") != 4096:
        raise ValueError("complete earlier OOD selection required")
    if len(natural.get("files", [])) != 2 or {x["path"] for x in natural["files"]} != {"positions.jsonl", "inventory.jsonl"}:
        raise ValueError("complete declared natural source inventory required")
    audit_raw = (folders["natural"] / "independent-audit.json").read_bytes()
    audit = json.loads(audit_raw)
    if audit.get("status") != "pass" or audit.get("manifestSha256") != EXPECTED["natural"] \
            or audit.get("rawGameInventoryJoinsVerified") != 697600 \
            or audit.get("selectedGameStrictTokenCountsVerified") != 407732:
        raise ValueError("complete raw-game and strict SAN audit required")
    code = {"tools/sparse_eval_v2/openings.py": sha(Path(__file__).read_bytes()),
            "tools/sparse_eval/data.py": sha((ROOT / "tools/sparse_eval/data.py").read_bytes())}
    quarantine = load_quarantine(ROOT)
    output.mkdir(parents=True, exist_ok=False)
    write(output / "plan.json", encoded({"schema": SCHEMA + ".plan", "rules": RULES,
          "inputs": identities, "implementation": code, "quarantine": quarantine["manifest"]}))
    families, clusters, games = set(), set(), set()
    counts = Counter()
    for binding in bindings:
        for _, row in rows(folders["primary"], binding):
            if row["role"] != binding["role"]:
                raise ValueError("primary role identity mismatch")
            families.add(row["family"])
            clusters.add(row["cluster"])
            counts["primaryMetadataRows"] += 1
            # cpWhite and teacher values intentionally never accessed.
    for binding in ood["files"]:
        for _, row in rows(folders["ood"], binding):
            families.add(row["family"])
            clusters.add(row["cluster"])
            games.add(row["sourceGameId"])
            counts["priorOODRows"] += 1
    if counts["primaryMetadataRows"] != 1000000 or counts["priorOODRows"] != 4096:
        raise ValueError("prior exposure inventory incomplete")
    for _, _row in rows(folders["natural"], next(x for x in natural["files"] if x["path"] == "inventory.jsonl")):
        counts["sourceGamesInventoried"] += 1
    if counts["sourceGamesInventoried"] != 697600:
        raise ValueError("complete source-game inventory required")
    heap = []
    position_binding = next(x for x in natural["files"] if x["path"] == "positions.jsonl")
    for source_index, row in rows(folders["natural"], position_binding):
        counts["naturalRows"] += 1
        if row.get("role") != "unlabelled-natural" or row.get("cpWhite") is not None:
            raise ValueError("source bank must remain unlabelled")
        if not RULES["minimumPly"] <= row["selectedPly"] <= RULES["maximumPly"]:
            counts["excluded:Ply"] += 1
            continue
        if row["phase"] < RULES["minimumPhase"]:
            counts["excluded:Phase"] += 1
            continue
        if row["family"] in families or row["cluster"] in clusters or row["sourceGameId"] in games:
            counts["excluded:PriorExposure"] += 1
            continue
        counts["eligibleBeforeUniqueGrouping"] += 1
        priority = int(sha((SALT + "\0" + row["sourceGameId"]).encode()), 16)
        item = (-priority, source_index, row)
        if len(heap) < RULES["rankingWindow"]:
            heapq.heappush(heap, item)
        elif item[0] > heap[0][0]:
            heapq.heapreplace(heap, item)
    ranked = sorted((-priority, index, row) for priority, index, row in heap)
    selected, rejected = choose(ranked, RULES["selectedRoots"], quarantine)
    if any(x["rootFamily"] in families or x["rootCluster"] in clusters or x["sourceGameId"] in games for x in selected):
        raise ValueError("exposure leaked into the selected opening bank")
    for relative, digest in code.items():
        if sha((ROOT / relative).read_bytes()) != digest:
            raise ValueError("selector implementation changed")
    for binding in quarantine["manifest"]["files"]:
        if sha((ROOT / binding["path"]).read_bytes()) != binding["sha256"]:
            raise ValueError("historical quarantine source changed")
    raw = b"".join(encoded(row) for row in selected)
    binding = write(output / "openings.jsonl", raw)
    binding["rows"] = len(selected)
    result = {"schema": SCHEMA, "status": "complete-unlabelled-development-only", "researchOnly": True,
              "formalPass": False, "productionFitAllowed": False, "license": "CC0-1.0",
              "rules": RULES, "inputs": identities, "naturalIndependentAuditSha256": sha(audit_raw),
              "quarantine": quarantine["manifest"], "implementation": code, "counts": dict(counts),
              "rankedPrefixRejected": rejected, "selectedRoots": len(selected),
              "distinctPly4Families": len({x["ply4Family"] for x in selected}),
              "exclusions": {"familyCount": len(families), "clusterCount": len(clusters), "sourceGameCount": len(games),
                             "familiesSha256": sha(encoded(sorted(families))),
                             "clustersSha256": sha(encoded(sorted(clusters))),
                             "sourceGamesSha256": sha(encoded(sorted(games)))},
              "files": [binding], "teacherValuesUsed": False, "candidateOutcomesUsed": False,
              "limitations": ["primary evaluation export has no game IDs; source-game isolation from it is unknowable",
                              "unique structural and early-prefix families do not establish independence of all chess openings",
                              "natural source was previously inventoried; these selected games/endpoints were not previously labelled or measured",
                              "this is a fresh development screen, not an untouched formal admission bank"]}
    write(output / "manifest.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = select(args.data_root, args.output)
    print(json.dumps({"status": result["status"], "selectedRoots": result["selectedRoots"],
                      "counts": result["counts"], "distinctPly4Families": result["distinctPly4Families"]}, sort_keys=True))


if __name__ == "__main__":
    main()
