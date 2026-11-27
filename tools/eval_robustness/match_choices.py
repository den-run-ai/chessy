"""Score the two actual searches at each matched opening with a separate teacher."""
import argparse
import json
from pathlib import Path
from statistics import mean

import chess
import chess.engine

from tools.eval_pipeline import games
from .cross_teacher import label

SF11 = "835cca1bae51344ab86bb9443bd46e886a1c0d07011a377b6c50056be3e43718"


def compare(campaign, exe):
    if games.sha(exe.read_bytes()) != SF11:
        raise ValueError("unexpected Stockfish binary")
    audit = json.loads((campaign / "audit.json").read_bytes())
    config = json.loads((campaign / "config.json").read_bytes())
    sealed = json.loads((campaign / "completion.json").read_bytes())
    if (games.sha((campaign / "raw.jsonl").read_bytes()) != sealed["files"]["raw.jsonl"]["sha256"]
            or games.sha((campaign / "completion.json").read_bytes()) != audit["campaignAudit"]["completionSha256"]):
        raise ValueError("ledger differs from audited record")
    openings = {r["openingId"]: r for r in map(json.loads, (campaign / "openings.jsonl").read_bytes().splitlines())}
    slots = {s["scheduleId"]: s for s in games.frontier.schedule(config)}
    roots = {key: {} for key in openings}
    with (campaign / "raw.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            if row["type"] != "move" or row["ply"] != 0:
                continue
            slot = slots[row["scheduleId"]]
            root = openings[slot["openingId"]]
            board, history = games.prefix_board(root)
            request = row["request"]
            if request["historyFens"] != history or request["fen"] != root["fen"]:
                raise ValueError("timed choices must use the exact same history")
            expected = "candidate" if (board.turn == chess.WHITE) == (slot["candidateColor"] == "white") else "base"
            if request["engine"] != expected or expected in roots[slot["openingId"]]:
                raise ValueError("ambiguous root engine or duplicate sample")
            result = games.search_contract(request, json.loads(row["response"]), board)
            roots[slot["openingId"]][expected] = {k: result[k] for k in ("uci", "nodes", "depth", "engineCallMs")}

    samples = []
    with chess.engine.SimpleEngine.popen_uci(str(exe.resolve())) as engine:
        engine.configure({"Threads": 1, "Hash": 16})
        for key in config["openingIds"]:
            moves = roots[key]
            board, _ = games.prefix_board(openings[key])
            children = []
            for uci in sorted({moves[side]["uci"] for side in ("base", "candidate")}):
                board.push_uci(uci)
                children.append({"uci": uci, "fen": board.fen()})
                board.pop()
            gap, labels = 0, []
            if len(children) > 1:
                row = {"group": key, "root": key, "prefixUci": openings[key]["prefixUci"], "fen": board.fen(),
                       "children": children}
                labels = label(engine, row, nodes=100000)["children"]
                scores = {item["uci"]: max(-2000, min(2000, item["teacher"])) for item in labels}
                gap = scores[moves["candidate"]["uci"]] - scores[moves["base"]["uci"]]
            samples.append({"openingId": key, "firstMove": moves, "teacherLabels": labels, "candidateMinusHceCp": gap})
    return summarize(samples, [audit["campaignAudit"]["completionSha256"]])


def summarize(samples, seals):
    gap = [r["candidateMinusHceCp"] for r in samples]
    return {"scope": "Exploratory, post hoc first-root comparison. Fixed search time and game history. Only the two played moves are compared.",
            "nodesPerChild": 100000, "scoreClipCp": [-2000, 2000], "teacherSha256": SF11,
            "campaignSealsSha256": seals, "pairs": len(samples),
            "disagreements": sum(bool(r["teacherLabels"]) for r in samples), "candidatePreferred": sum(g > 0 for g in gap),
            "hcePreferred": sum(g < 0 for g in gap), "meanCandidateMinusHceCpIncludingAgreements": mean(gap),
            "meanRootNodes": {side: mean(r["firstMove"][side]["nodes"] for r in samples) for side in ("base", "candidate")},
            "meanCompletedRootDepth": {side: mean(r["firstMove"][side]["depth"] for r in samples) for side in ("base", "candidate")},
            "roots": samples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("campaign", type=Path)
    parser.add_argument("stockfish", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    if (args.campaign / "joint-registration.json").exists():
        shards = [compare(args.campaign / f"shard-{i}/campaign", args.stockfish) for i in range(4)]
        roots = [r for shard in shards for r in shard["roots"]]
        if len(roots) != 128 or len({r["openingId"] for r in roots}) != 128:
            raise ValueError("replication requires 128 matched roots")
        report = summarize(roots, [x for shard in shards for x in shard["campaignSealsSha256"]])
    else:
        report = compare(args.campaign, args.stockfish)
    with args.out.open("x") as file:
        json.dump(report, file, sort_keys=True, indent=2)
        file.write("\n")
