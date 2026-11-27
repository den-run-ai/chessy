"""Repeat frozen sibling labels with one fresh pinned teacher process per position."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import sys

import chess
import chess.engine

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.eval_robustness import fit
from tools.eval_robustness.collect import NODES, TEACHER


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, obj):
    raw = (json.dumps(obj, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()
    with path.open("xb") as stream:
        stream.write(raw)
    return raw


def query(board, root_color, teacher):
    with chess.engine.SimpleEngine.popen_uci(str(teacher)) as engine:
        engine.configure({"Hash": 16, "Threads": 1})
        info = engine.analyse(board, chess.engine.Limit(nodes=NODES), game=object())
    if not info.get("pv") or info.get("lowerbound") or info.get("upperbound"):
        raise ValueError(f"teacher returned a bounded or incomplete score at {board.fen()}")
    score = info["score"].pov(root_color)
    return {"teacher": max(-3000, min(3000, score.score(mate_score=3000))), "mate": score.mate(),
            "teacherDepth": info["depth"], "teacherNodes": info["nodes"],
            "pvFirst": info["pv"][0].uci()}


def relabel(row, teacher):
    board = chess.Board()
    for token in row["prefixUci"]:
        board.push_uci(token)
    if board.fen() != row["fen"]:
        raise ValueError("parent replay mismatch")
    mover = board.turn
    parent = query(board, mover, teacher)
    children = []
    for old in row["children"]:
        board.push_uci(old["uci"])
        if board.fen() != old["fen"]:
            raise ValueError("child replay mismatch")
        # Keep exactly the previous terminal policy and candidate set.
        child = dict(old)
        if old["terminal"]:
            outcome = board.outcome()
            if outcome is None or old["terminal"] != outcome.termination.name:
                raise ValueError("terminal child no longer agrees with rules")
        else:
            if board.outcome() is not None:
                raise ValueError("nonterminal child is terminal")
            child.update(query(board, mover, teacher))
        children.append(child)
        board.pop()
    return dict(row, children=children, teacherMove=parent["pvFirst"], parentIsolatedSearch=parent,
                originalTeacherMove=row["teacherMove"])


def top_moves(row):
    best = max(child["teacher"] for child in row["children"])
    return {child["uci"] for child in row["children"] if child["teacher"] == best}


def run(args):
    teacher = args.teacher.resolve()
    source = args.collection.read_bytes()
    old_exclusions = json.loads(args.exclusions.read_bytes())
    if sha(teacher.read_bytes()) != TEACHER or sha(source) != old_exclusions["collectionSha256"]:
        raise ValueError("unknown teacher or source collection")
    rows = list(map(json.loads, gzip.decompress(source).splitlines()))
    args.output.mkdir(parents=True, exist_ok=False)
    with ThreadPoolExecutor(max_workers=args.workers) as workers:
        isolated = []
        for row in workers.map(lambda row: relabel(row, teacher), rows):
            isolated.append(row)
            if len(isolated) % 50 == 0 or len(isolated) == len(rows):
                print(f"Labelled {len(isolated)}/{len(rows)} roots", file=sys.stderr, flush=True)
        # Choose the repeated roots by ID alone. Every replay uses a fresh process
        # and a second independent invocation for all its nonterminal children.
        sample = sorted(range(len(rows)), key=lambda i: sha(("audit:" + rows[i]["root"]).encode()))[:32]
        repeated = list(workers.map(lambda i: relabel(rows[i], teacher), sample))
    # Expose every label in the exact order used for the common optimizer.
    payload = gzip.compress(b"".join((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode()
                                     for row in isolated), mtime=0)
    with (args.output / "isolated-collection.jsonl.gz").open("xb") as file:
        file.write(payload)
    exclusions = write_json(args.output / "isolated-exclusions.json",
                            dict(old_exclusions, collectionSha256=sha(payload)))
    results = fit.analyze(payload, args.protocol.read_bytes(), exclusions)
    write_json(args.output / "isolated-fit.json", results)
    children = [(a, b) for orig, new in zip(rows, isolated, strict=True)
                for a, b in zip(orig["children"], new["children"], strict=True) if not a["terminal"]]
    parent_diffs = [row for row in isolated if row["teacherMove"] != row["originalTeacherMove"]]
    repeats = [(isolated[i], rerun) for i, rerun in zip(sample, repeated, strict=True)]
    differences = [{"root": a["root"], "uci": c["uci"], "first": c, "second": d}
                   for a, b in repeats for c, d in zip(a["children"], b["children"], strict=True) if c != d]
    output = {"schema": "chessy.isolated-teacher-labels.v1", "originalCollectionSha256": sha(source),
              "isolatedCollectionSha256": sha(payload), "teacherSha256": TEACHER, "nodeRequest": NODES,
              "isolation": "One new Chatarunga process per parent or nonterminal child, one thread, 16 MiB hash, complete game history, no prior search in that process.",
              "groups": len({r["group"] for r in rows}), "roots": len(rows),
              "children": sum(len(row["children"]) for row in rows), "nonterminalChildren": len(children),
              "changedChildScores": sum(a["teacher"] != b["teacher"] for a, b in children),
              "changedChildNodeCounts": sum(a["teacherNodes"] != b["teacherNodes"] for a, b in children),
              "maxAbsoluteChildScoreChange": max(abs(a["teacher"] - b["teacher"]) for a, b in children),
              "changedParentChoices": len(parent_diffs),
              "newParentChoiceOutsideFrozenSet": sum(row["teacherMove"] not in {c["uci"] for c in row["children"]}
                                                     for row in parent_diffs),
              "changedTopChildSets": sum(top_moves(before) != top_moves(after)
                                         for before, after in zip(rows, isolated, strict=True)),
              "repeatRoots": len(repeats),
              "repeatNonterminalChildren": sum(not c["terminal"] for r, _ in repeats for c in r["children"]),
              "changedRepeatParentSearches": sum(a["parentIsolatedSearch"] != b["parentIsolatedSearch"] for a, b in repeats),
              "changedRepeatChildren": differences,
              "repeatedRootsSample": "Lowest 32 SHA-256('audit:' + root ID), selected independently of scores."}
    write_json(args.output / "isolated-audit.json", output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("collection", "teacher", "protocol", "exclusions", "output"):
        parser.add_argument(key, type=Path)
    parser.add_argument("--workers", type=int, choices=[1, 2], default=1)
    run(parser.parse_args())
