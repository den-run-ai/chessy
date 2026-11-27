#!/usr/bin/env python3
"""Generate a development-only opening bank for prototype screening.

Source: the CC0 lichess-org/chess-openings catalog (a.tsv .. e.tsv), fetched
outside Git with recorded SHA-256s. The bank is deliberately disjoint from the
repository's frozen quarantine boundary (scorecard corpus, puzzle sources,
incident fixtures, the 100-opening v1 bank and every prefix of the 400-endpoint
v2 formal holdout): a line is rejected if the exact/model-symmetry cluster of
its endpoint is inside that boundary, or if its endpoint's static
pawn/king/material family equals the family of any v2 endpoint. Every prefix
position of every selected line is then added to the training quarantine by
tools/nnue/build-dataset.py, so the bank is also family-disjoint from the
training data.

Selection is deterministic: lines of 6..12 plies, endpoint |shipped HCE static
eval| <= BALANCE_CP, one line per endpoint cluster, ordered by SHA-256 of
"eco|name" and stratified by ECO volume.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parents[2]
BALANCE_CP = 120
MIN_PLIES = 6
MAX_PLIES = 12


def load_module(name: str, relative: str):
    path = ROOT / relative
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fen4(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-dir", required=True, help="directory with a.tsv..e.tsv")
    parser.add_argument("--per-volume", type=int, default=60)
    parser.add_argument("--output", required=True)
    parser.add_argument("--base-wasm", default=str(ROOT / "assets/chessy-ai-fast.wasm"))
    args = parser.parse_args()

    ns = load_module("natural_select", "test/training/natural-select.py")
    rules = json.loads((ROOT / "eval/training/natural-pilot-v1.json").read_text())
    boundary = ns.quarantine(ROOT, rules)
    v2 = json.loads((ROOT / "eval/match-v2/openings.json").read_text())
    v2_endpoint_families = {ns.key_data(entry["fen"])["positionFamily"] for entry in v2["openings"]}
    v1 = subprocess.check_output(["node", "-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))",
                                  str(ROOT / "test/ai-match-openings.js")], text=True)
    v1_endpoints = set()
    for _name, sans in json.loads(v1):
        board = chess.Board()
        for san in sans.split():
            board.push_san(san)
        v1_endpoints.add(fen4(board))

    catalog = Path(args.catalog_dir)
    sources = []
    candidates = []
    for volume in "abcde":
        path = catalog / f"{volume}.tsv"
        sources.append({"file": path.name, "sha256": sha256_file(path), "bytes": path.stat().st_size})
        for line in path.read_text().splitlines()[1:]:
            eco, name, pgn = line.split("\t")
            board = chess.Board()
            sans = [token for token in pgn.split() if not token[0].isdigit()]
            ok = True
            for san in sans:
                try:
                    board.push_san(san)
                except ValueError:
                    ok = False
                    break
            if not ok or not MIN_PLIES <= len(sans) <= MAX_PLIES or board.is_game_over():
                continue
            candidates.append({"eco": eco, "name": name, "volume": volume.upper(), "sans": sans,
                               "uci": [m.uci() for m in board.move_stack], "fen": board.fen(), "fen4": fen4(board),
                               "priority": hashlib.sha256(f"{eco}|{name}".encode()).hexdigest()})
    candidates.sort(key=lambda c: c["priority"])

    # Static balance through the shipped module (both engines play both colours).
    fens = "\n".join(c["fen"] for c in candidates) + "\n"
    evals = subprocess.run(["node", str(ROOT / "tools/nnue/hce-eval.js"), "--wasm", args.base_wasm], input=fens,
                           capture_output=True, text=True, check=True).stdout.split()
    assert len(evals) == len(candidates)

    selected = []
    seen_clusters = set()
    counts = {"catalog": len(candidates), "unbalanced": 0, "boundaryCluster": 0, "v2EndpointFamily": 0, "v1Endpoint": 0,
              "duplicateCluster": 0, "selected": 0}
    per_volume = {v: 0 for v in "ABCDE"}
    for candidate, hce in zip(candidates, evals):
        if per_volume[candidate["volume"]] >= args.per_volume:
            continue
        if abs(int(hce)) > BALANCE_CP:
            counts["unbalanced"] += 1
            continue
        keys = ns.key_data(candidate["fen4"])
        if keys["cluster"] in boundary["clusters"]:
            counts["boundaryCluster"] += 1
            continue
        if keys["positionFamily"] in v2_endpoint_families:
            counts["v2EndpointFamily"] += 1
            continue
        if candidate["fen4"] in v1_endpoints:
            counts["v1Endpoint"] += 1
            continue
        if keys["cluster"] in seen_clusters:
            counts["duplicateCluster"] += 1
            continue
        seen_clusters.add(keys["cluster"])
        per_volume[candidate["volume"]] += 1
        selected.append({"index": len(selected), "eco": candidate["eco"], "name": candidate["name"], "volume": candidate["volume"],
                         "san": " ".join(candidate["sans"]), "uci": candidate["uci"], "plies": len(candidate["sans"]),
                         "fen": candidate["fen"], "hceStaticCp": int(hce), "cluster": keys["cluster"], "positionFamily": keys["positionFamily"]})
    counts["selected"] = len(selected)

    # Every prefix position (start included) becomes training quarantine input.
    quarantine_fens = []
    for entry in selected:
        board = chess.Board()
        quarantine_fens.append(fen4(board))
        for uci in entry["uci"]:
            board.push_uci(uci)
            quarantine_fens.append(fen4(board))
    quarantine_fens = sorted(set(quarantine_fens))

    output = {
        "schema": "chessy.nnue-proto-dev-openings.v1",
        "purpose": "development-only screening bank for NNUE prototype matches; never a formal holdout",
        "source": {"repository": "https://github.com/lichess-org/chess-openings", "license": "CC0-1.0",
                   "retrievedUtc": (catalog / "RETRIEVED").read_text().strip() if (catalog / "RETRIEVED").exists() else None,
                   "files": sources},
        "rules": {"plies": [MIN_PLIES, MAX_PLIES], "balanceCp": BALANCE_CP, "perVolume": args.per_volume,
                  "order": "sha256(eco|name)", "disjointFrom": ["natural-pilot-v1 quarantine clusters (incl. every v2 prefix)",
                                                                 "v2 endpoint structural families", "v1 endpoints"],
                  "trainingQuarantine": "cluster and family of every prefix position of every selected line"},
        "boundary": {k: v for k, v in boundary["manifest"].items() if k != "sourceFiles"},
        "counts": counts,
        "perVolume": per_volume,
        "openings": selected,
        "quarantineFens": quarantine_fens,
    }
    Path(args.output).write_text(json.dumps(output, indent=1) + "\n")
    print(json.dumps({"counts": counts, "perVolume": per_volume, "quarantineFens": len(quarantine_fens)}))


if __name__ == "__main__":
    main()
