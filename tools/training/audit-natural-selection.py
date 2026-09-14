#!/usr/bin/env python3
"""Audit a frozen natural-game selection without reading any teacher labels.

The complete archive, inventory and selection shards are authenticated. Every
selected history is replayed, and corpus keys are independently checked by the
existing JavaScript implementation. Quarantine reconstruction deliberately
shares the selector helper; this is disclosed in the report. A deterministic
128-game sample separately reparses PGN and checks quiet-candidate selection.
Outputs are external research evidence, never production admission artifacts.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import time

import chess
import chess.pgn
import zstandard


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load(path):
    return json.loads(path.read_text())


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def audit(args):
    started, clock = timestamp(), time.monotonic()
    root, directory = args.repo_root.resolve(), args.selection_manifest.resolve().parent
    manifest_path = args.selection_manifest.resolve()
    manifest = load(manifest_path)
    require(manifest.get("schema") == "chessy.natural-pilot-selection.v1", "selection schema required")
    require(manifest.get("status") == "complete-research-only-selection", "selection is incomplete")
    require(manifest.get("productionFitAllowed") is False, "research-only selection required")
    require(not args.output.exists(), "refusing to overwrite audit evidence")
    identities = {}

    def bind(path, expected=None):
        path = path.resolve()
        identity = {"sha256": digest(path), "bytes": path.stat().st_size}
        if expected:
            require(all(identity[k] == expected[k] for k in identity), "input identity mismatch: " + str(path))
        identities[path] = identity
        return identity

    bind(manifest_path)
    bind(Path(__file__))
    for binding in [manifest["preregistration"], manifest["teacherContract"],
                    manifest["fitPreregistration"], *manifest["implementation"]]:
        bind(root / binding["path"], binding)
    rules = load(root / manifest["preregistration"]["path"])
    require(chess.__version__ == rules["dependencies"]["pythonChess"], "python-chess dependency mismatch")
    require(zstandard.__version__ == rules["dependencies"]["zstandard"], "zstandard dependency mismatch")
    for filename, expected in (("preregistration.json", rules),
                               ("fit-preregistration.json", load(root / manifest["fitPreregistration"]["path"]))):
        bind(directory / filename)
        require(load(directory / filename) == expected, "selection snapshot differs: " + filename)
    for binding in manifest["quarantine"]["sourceFiles"]:
        bind(args.quarantine_root / binding["path"], binding)
    spec = importlib.util.spec_from_file_location("audit_selector", root / "test/training/natural-select.py")
    selector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(selector)
    boundary = selector.quarantine(args.quarantine_root, rules)
    require(boundary["manifest"] == manifest["quarantine"], "regenerated quarantine differs")

    bind(args.archive, manifest["source"])
    with args.archive.open("rb") as stream:
        with zstandard.ZstdDecompressor().stream_reader(stream) as decoded:
            raw = decoded.read()
    require(hashlib.sha256(raw).hexdigest() == manifest["source"]["uncompressedSha256"], "uncompressed archive differs")
    inventory_binding = manifest["selection"]["sourceInventory"]
    inventory_path = directory / inventory_binding["path"]
    bind(inventory_path, inventory_binding)
    inventory = [json.loads(line) for line in inventory_path.open()]
    require(len(inventory) == inventory_binding["rows"] == rules["source"]["games"], "source inventory count differs")
    offset = 0
    for index, item in enumerate(inventory):
        require(item["index"] == index and item["pgnByteStart"] == offset, "source framing is not contiguous")
        chunk = raw[offset:offset + item["pgnBytes"]]
        require(hashlib.sha256(chunk).hexdigest() == item["rawSha256"], "source inventory raw PGN hash differs")
        offset += item["pgnBytes"]
    require(offset == len(raw), "source inventory does not cover the complete archive")
    require(dict(Counter(item["reason"] for item in inventory)) == manifest["selection"]["sourceDispositions"], "source dispositions differ")

    rows, ids, sources, clusters = [], set(), set(), set()
    families, counts = Counter(), Counter()
    family_roles, phases = {}, defaultdict(Counter)
    config = rules["selection"]
    for binding in manifest["selection"]["files"]:
        path = directory / binding["path"]
        require(path.resolve().parent == directory and not path.is_symlink(), "selection shard must be a direct regular child")
        bind(path, binding)
        count = 0
        for line in path.open():
            row = json.loads(line)
            require("teacher" not in row, "teacher-bearing row prohibited in selection audit")
            require(row.get("schema") == "chessy.natural-pilot-row.v1", "unexpected selection row schema")
            role, sid, family, rid = row["role"], row["sourceId"], row["positionFamily"], row["id"]
            source = row["sourceGame"]
            cell = int(family[:12], 16) % 100
            low, high = config["roles"][role]
            require(role == binding["role"] and low <= cell < high, "family role differs")
            require(sid not in sources and rid not in ids and row["cluster"] not in clusters, "duplicate source, ID or cluster")
            require(sid not in boundary["sources"] and family not in boundary["families"] and row["cluster"] not in boundary["clusters"], "quarantine overlap")
            require(family not in family_roles or family_roles[family] == role, "cross-role family overlap")
            require(source["id"] == sid and source["selectedPly"] == len(row["prefixUci"]), "source prefix binding differs")
            require(config["minimumPly"] <= source["selectedPly"] <= config["maximumPly"], "selected ply outside range")
            identity = "\0".join((rules["id"], rules["source"]["sha256"], sid, str(source["selectedPly"])))
            require(hashlib.sha256(identity.encode()).hexdigest() == rid, "row identity differs")
            entry = inventory[source["index"]]
            require(entry["reason"] == "selected" and entry["candidateId"] == rid and entry["sourceId"] == sid, "selected inventory binding differs")
            require(all(entry[k] == source[k] for k in ("rawSha256", "pgnByteStart", "pgnBytes")), "source slice binding differs")
            require(row["fen4"] == " ".join(row["fen"].split()[:4]), "FEN4 differs")
            board = chess.Board()
            for move in row["prefixUci"]:
                board.push_uci(move)
            require(board.fen(en_passant="fen") == row["fen"], "full legal prefix does not reproduce FEN")
            require(board.is_valid() and not board.is_check() and not board.is_insufficient_material() and not board.is_repetition(3), "root quietness or validity differs")
            require(config["minimumHalfmoveClock"] <= board.halfmove_clock <= config["maximumHalfmoveClock"], "halfmove gate differs")
            sources.add(sid)
            ids.add(rid)
            clusters.add(row["cluster"])
            families[family] += 1
            family_roles[family] = role
            counts[role] += 1
            phases[role][row["phaseBucket"]] += 1
            rows.append(row)
            count += 1
        require(count == binding["rows"], "selection shard row count differs")
        print(json.dumps({"auditedRole": binding["role"], "rows": count}), file=sys.stderr, flush=True)
    require(max(families.values()) <= config["maximumRowsPerFamily"], "family cap exceeded")
    selection = manifest["selection"]
    require(len(rows) == len(ids) == selection["rows"], "selection row count differs")
    require(len(sources) == selection["uniqueSourceGames"] and len(clusters) == selection["uniqueClusters"] and len(families) == selection["uniqueFamilies"], "unique identity counts differ")
    require(dict(counts) == manifest["coverage"]["byRole"], "role coverage differs")
    require({role: dict(value) for role, value in phases.items()} == manifest["coverage"]["byRoleAndPhase"], "phase coverage differs")
    require(selector.coverage(rows, rules) == manifest["coverage"], "coverage gate report differs")
    script = "const C=require('./test/training/corpus');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{for(const f of JSON.parse(s))console.log(JSON.stringify({cluster:C.clusterKey(f),positionFamily:C.positionFamilyKey(f),phaseBucket:C.phaseBucket(f)}));});"
    result = subprocess.check_output(["node", "-e", script], cwd=root,
                                     input=json.dumps([row["fen"] for row in rows]).encode())
    keys = [json.loads(line) for line in result.splitlines()]
    require(len(keys) == len(rows), "JavaScript key count differs")
    for row, key in zip(rows, keys):
        require(all(row[name] == value for name, value in key.items()), "JavaScript corpus key differs")

    sampled = sorted(rows, key=lambda row: row["id"])[:128]
    for row in sampled:
        source = row["sourceGame"]
        chunk = raw[source["pgnByteStart"]:source["pgnByteStart"] + source["pgnBytes"]]
        game = chess.pgn.read_game(io.StringIO(chunk.decode()))
        require(game is not None and not game.errors, "sample source PGN is malformed")
        moves = list(game.mainline_moves())
        require(len(moves) == source["plies"], "sample source plies differ")
        require([move.uci() for move in moves[:source["selectedPly"]]] == row["prefixUci"], "sample source prefix differs")
        board, candidates = game.board(), []
        for ply, move in enumerate(moves):
            if (config["minimumPly"] <= ply <= config["maximumPly"]
                    and config["minimumHalfmoveClock"] <= board.halfmove_clock <= config["maximumHalfmoveClock"]
                    and not board.is_check() and not board.is_capture(move) and not move.promotion
                    and not board.gives_check(move) and not board.is_insufficient_material() and not board.is_repetition(3)):
                priority = hashlib.sha256("\0".join((config["seed"], row["sourceId"], str(ply))).encode()).hexdigest()
                candidates.append((priority, ply))
            board.push(move)
        require(min(candidates) == (row["selectionPriority"], source["selectedPly"]), "sample quiet-candidate priority differs")

    for path, identity in identities.items():
        require(digest(path) == identity["sha256"] and path.stat().st_size == identity["bytes"], "input changed during audit")
    return {"schema": "chessy.natural-selection-independent-audit.v1", "status": "PASS",
            "startedAtUtc": started, "completedAtUtc": timestamp(), "elapsedSeconds": time.monotonic() - clock,
            "researchOnly": True, "productionFitAllowed": False, "teacherLabelsRead": 0,
            "method": {"allSelectedRows": "legal full-prefix replay, identity/role/quarantine checks, JavaScript corpus-key parity",
                       "allSourceRecords": "contiguous raw PGN slices and SHA256 bindings to complete authenticated archive",
                       "quietnessSample": "first 128 sorted selected SHA256 row IDs; independent complete PGN replay and minimum-priority quiet-candidate recomputation",
                       "sharedCode": "selector quarantine and coverage helpers; python-chess parser"},
            "counts": {"selectedRows": len(rows), "sourceGames": len(sources), "clusters": len(clusters),
                       "families": len(families), "maximumRowsPerFamily": max(families.values()),
                       "familySizeHistogram": dict(sorted(Counter(families.values()).items())),
                       "sourceInventoryRowsAuthenticated": len(inventory), "fullLegalPrefixReplays": len(rows),
                       "javascriptCorpusKeyComparisons": len(rows), "completeQuietGameSamples": len(sampled),
                       "quarantineIntersections": 0, "crossRoleSourceOrFamilyOverlap": 0, "mismatches": 0},
            "coverage": manifest["coverage"], "inputs": {str(path): identity for path, identity in identities.items()},
            "command": [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]],
            "limitations": ["Recorded noncapturing/nonchecking human moves do not certify tactical quietness.",
                            "Unknown incident upstream game lineage is not recovered by this audit.",
                            "Family isolation does not prove independence of players or opening ideas.",
                            "Global ranking of all rejected candidate games is not recomputed.",
                            "No teacher-label eligibility, loss improvement, Elo/time, or shipping claim is made."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--quarantine-root", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = audit(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(report, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"report": str(args.output.resolve()), "sha256": digest(args.output),
                      "status": report["status"], "counts": report["counts"]}, sort_keys=True))


if __name__ == "__main__":
    main()
