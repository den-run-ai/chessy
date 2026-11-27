"""Replay collected siblings, verify production WASM scores and inspect overlap."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

import chess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval.data import key_data


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(args):
    with gzip.open(args.rows, "rt") as stream:
        rows = [json.loads(line) for line in stream]
    match_groups = {json.loads(line)["sourceGameId"] for path in args.openings for line in path.read_text().splitlines()}
    static, clusters, groups, roots = [], {}, set(), set()
    for r in rows:
        if r["root"] in roots or r["group"] in match_groups:
            raise ValueError("duplicate root or match source game")
        roots.add(r["root"])
        groups.add(r["group"])
        board = chess.Board()
        for uci in r["prefixUci"]:
            board.push_uci(uci)
        if board.fen() != r["fen"] or len(r["children"]) < 2:
            raise ValueError("root mismatch")
        for position in (r, *r["children"]):
            cluster = key_data(position["fen"])["cluster"]
            clusters.setdefault(cluster, set()).add(r["group"])
        root_sign = 1 if board.turn == chess.WHITE else -1
        child_moves = [child["uci"] for child in r["children"]]
        if len(set(child_moves)) != len(child_moves) or r["played"] not in child_moves or r["teacherMove"] not in child_moves:
            raise ValueError("sibling choice mismatch")
        for child in r["children"]:
            move = chess.Move.from_uci(child["uci"])
            if (board.gives_check(move) != child["check"] or board.is_capture(move) != child["capture"] or
                bool(move.promotion or child["check"] or child["capture"]) != child["tactical"]):
                raise ValueError("tactical marker mismatch")
            board.push_uci(child["uci"])
            if board.fen() != child["fen"] or bool(board.outcome()) != bool(child["terminal"]):
                raise ValueError("child replay mismatch")
            board.pop()
            static.append(dict(fen=child["fen"], expected=[child[key] * root_sign for key in ("hce","full","noPawn")]))
    js = """
const fs = require('node:fs'), assert = require('node:assert/strict');
const [loader, ...paths] = process.argv.slice(1);
const engines = paths.map(p => require(loader).loadSync(fs.readFileSync(p)));
for (const {fen, expected} of JSON.parse(fs.readFileSync(0,'utf8'))) {
  assert.deepEqual(engines.map(e => e.evaluate(fen)), expected, fen);
}
"""
    subprocess.run(["node", "-e", js, ROOT/"assets/wasm-engine.js", *args.wasm],
                   input=json.dumps(static), text=True, check=True)
    overlap = {}
    for path in args.primary:
        # Inspect only stored cluster identities; ignore all positions' labels.
        matched = set()
        matched_new_train, matched_new_holdout = set(), set()
        number = 0
        with path.open("rb") as stream:
            for line in stream:
                hit = re.search(rb'"cluster":"([a-f0-9]{64})"', line)
                if hit is None:
                    raise ValueError("primary row has no cluster identity")
                tag = hit[1].decode()
                number += 1
                if tag in clusters:
                    matched.add(tag)
                    for group_id in clusters[tag]:
                        digest = hashlib.sha256(("eval-robustness-v1\0" + group_id).encode()).digest()
                        target = matched_new_holdout if int.from_bytes(digest[:8], "big") % 10 <= 2 else matched_new_train
                        target.add(tag)
        overlap[path.name] = dict(rows=number, matchedClusters=len(matched),
                                  newFitClusters=len(matched_new_train), newHeldoutClusters=len(matched_new_holdout))
    duplicate_clusters = {key:value for key,value in clusters.items() if len(value)>1}
    result = dict(roots=len(roots), groups=len(groups), children=len(static),
                  checkedWasmScores=len(static)*3, scoreMismatches=0, matchGameOverlap=0,
                  matchedOpeningGroups=len(match_groups), primaryOverlap=overlap,
                  distinctClusters=len(clusters), symmetryClustersSharedAcrossNewGroups=len(duplicate_clusters),
                  inputSha256=sha(args.rows), wasmSha256=[sha(path) for path in args.wasm])
    args.output.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=Path, required=True)
    parser.add_argument("--openings", type=Path, nargs="+", required=True)
    parser.add_argument("--wasm", type=Path, nargs=3, required=True, metavar=("HCE","FULL","NO_PAWN"))
    parser.add_argument("--primary", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    print(json.dumps(verify(parser.parse_args())))
