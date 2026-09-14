#!/usr/bin/env python3
"""Mechanically audit CLOSED natural-label artifacts; never evaluate a model.

Independent Python parsing reconstructs the frozen teacher admission from every
raw UCI conversation. Held-out rows may be parsed only for that mechanical
check. Neither reports nor errors contain teacher scores, WDL values, moves,
positions, model losses or model predictions. Use only after the runner has
closed and copied all artifacts. The output must be outside their directory.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import stat
import sys
import time

import chess

ROLES = ("shared-train", "hce-validation", "hce-test", "nnue-validation", "nnue-test")
EXPECTED_ROWS = 50000
EXPECTED_WORKERS = 8
IMPLEMENTATION = {"tools/training/natural-pilot-label.js", "assets/engine.js",
                  "test/training/label-stockfish.js", "test/training/corpus.js",
                  "test/training/prepare-lichess-evals.js", "test/eval/e4-protocol.js"}
HEX = re.compile(r"[a-f0-9]{64}\Z")
MOVE = re.compile(r"[a-h][1-8][a-h][1-8][qrbn]?\Z")


class AuditError(ValueError):
    """Messages are deliberately data-free to protect holdout labels."""


def require(condition, message):
    if not condition:
        raise AuditError(message)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(AuditError("nonfinite JSON number")))
    except AuditError:
        raise
    except Exception:
        raise AuditError("malformed JSON artifact") from None


def integer(value):
    return type(value) is int and abs(value) <= 9007199254740991


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def equal(left, right):
    """JSON has one number type, while booleans must never equal 0 or 1."""
    if type(left) in (int, float) and type(right) in (int, float):
        return finite(left) and finite(right) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equal(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


class Inputs:
    def __init__(self):
        self.files = {}

    def bind(self, path, expected=None):
        path = Path(path)
        before = path.lstat()
        require(stat.S_ISREG(before.st_mode), "artifact must be a regular nonsymlink file")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            opened = stream.fileno()
            import os
            inside = os.fstat(opened)
            require((before.st_dev, before.st_ino) == (inside.st_dev, inside.st_ino), "artifact replaced before read")
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
                size += len(block)
        after = path.lstat()
        signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
        require(signature(before) == signature(after) and size == before.st_size, "artifact changed during read")
        result = {"sha256": digest.hexdigest(), "bytes": size}
        if expected is not None:
            require(HEX.fullmatch(expected.get("sha256", "")) is not None, "missing authenticated file hash")
            require(result["sha256"] == expected["sha256"], "artifact hash mismatch")
            if "bytes" in expected:
                require(integer(expected["bytes"]) and result["bytes"] == expected["bytes"], "artifact byte count mismatch")
        self.files[path.resolve()] = result
        return result

    def json(self, path, expected=None):
        self.bind(path, expected)
        return strict_json(Path(path).read_bytes())

    def rows(self, path, expected):
        self.bind(path, expected)
        count = 0
        with Path(path).open("rb") as stream:
            for line in stream:
                require(line.endswith(b"\n") and line.strip(), "truncated or empty JSONL record")
                count += 1
                yield strict_json(line)
        require(integer(expected.get("rows")) and count == expected["rows"], "artifact row count mismatch")

    def recheck(self):
        previous = dict(self.files)
        for path, expected in previous.items():
            self.bind(path, expected)


def child(directory, name):
    require(isinstance(name, str) and name and Path(name).name == name and name not in (".", ".."), "artifact path is not a direct child")
    return directory / name


def number(token):
    try:
        return int(token) if re.fullmatch(r"[+-]?\d+", token) else float(token)
    except (ValueError, TypeError):
        return float("nan")


def parse_info(line):
    """Independent transcription of the frozen UCI score field semantics."""
    tokens, result, i = line.split(), {}, 1
    require(tokens and tokens[0] == "info", "invalid UCI info record")
    while i < len(tokens):
        token = tokens[i]
        if token in ("depth", "seldepth", "nodes"):
            result[token] = number(tokens[i + 1]) if i + 1 < len(tokens) else float("nan")
            i += 2
        elif token == "score" and i + 2 < len(tokens) and tokens[i + 1] in ("cp", "mate"):
            kind = tokens[i + 1]
            result[kind] = number(tokens[i + 2])
            i += 3
            if kind == "cp" and i < len(tokens) and tokens[i] in ("lowerbound", "upperbound"):
                result["bound"] = tokens[i]
                i += 1
        elif token == "wdl":
            result["wdl"] = [number(tokens[j]) if j < len(tokens) else float("nan") for j in range(i + 1, i + 4)]
            i += 4
        elif token == "pv":
            result["pv"] = tokens[i + 1:]
            break
        else:
            i += 1
    return result


def replay_source(row):
    board = chess.Board()
    try:
        for move in row["prefixUci"]:
            require(isinstance(move, str) and MOVE.fullmatch(move), "invalid source UCI syntax")
            board.push_uci(move)
    except AuditError:
        raise
    except Exception:
        raise AuditError("illegal source history") from None
    require(board.fen(en_passant="fen") == row["fen"], "source history/FEN mismatch")
    require(board.is_valid() and board.legal_moves.count() > 0, "invalid selected root")
    return board


def assess(info, terminal, bestmove, row, teacher, max_cp, board):
    def excluded(reason, scored=info):
        detail = {}
        if scored:
            if finite(scored.get("mate")):
                detail["mateSideToMove"] = scored["mate"]
            elif finite(scored.get("cp")):
                detail["cpSideToMove"] = scored["cp"]
            if scored.get("bound"):
                detail["scoreBound"] = scored["bound"]
            if finite(scored.get("nodes")):
                detail["scoreNodes"] = scored["nodes"]
        if terminal and finite(terminal.get("nodes")):
            detail["reportedNodes"] = terminal["nodes"]
        if bestmove:
            detail["bestMoveUci"] = bestmove
        return {"accepted": False, "reason": reason, "detail": detail, "attempted": True}

    if terminal and finite(terminal.get("mate")):
        return excluded("mate-score", terminal)
    if not info:
        return excluded("missing-score")
    if finite(info.get("mate")):
        return excluded("mate-score")
    if not integer(info.get("cp")):
        return excluded("missing-cp")
    if info.get("bound"):
        return excluded("bound-score")
    if not terminal or not integer(terminal.get("nodes")) or terminal["nodes"] < teacher["search"]["nodeLimit"]:
        return excluded("reported-nodes-under-budget")
    if not integer(info.get("nodes")) or info["nodes"] <= 0 or info["nodes"] > terminal["nodes"]:
        return excluded("invalid-score-nodes")
    if not isinstance(info.get("wdl"), list) or len(info["wdl"]) != 3:
        return excluded("missing-wdl")
    if any(not integer(value) or value < 0 for value in info["wdl"]) or sum(info["wdl"]) != 1000:
        return excluded("invalid-wdl")
    if not integer(info.get("depth")) or info["depth"] <= 0 or not integer(info.get("seldepth")) or info["seldepth"] < info["depth"]:
        return excluded("invalid-search-depth")
    if not info.get("pv") or info["pv"][0] != bestmove:
        return excluded("bestmove-pv-mismatch")
    white = row["fen"].split()[1] == "w"
    cp, wdl = info["cp"] * (1 if white else -1), info["wdl"] if white else info["wdl"][::-1]
    if abs(cp) > max_cp:
        return {"accepted": False, "reason": "outside-preregistered-cp-range", "detail": None, "attempted": True}
    pv_board = board.copy(stack=True)
    for move in info["pv"]:
        message = "invalid UCI move" if not isinstance(move, str) or not MOVE.fullmatch(move) else "illegal UCI move " + move
        try:
            require(isinstance(move, str) and MOVE.fullmatch(move), "invalid PV syntax")
            pv_board.push_uci(move)
        except Exception:
            return {"accepted": False, "reason": "illegal-pv", "detail": {"message": message}, "attempted": True}
    return {"accepted": True, "attempted": True, "teacher": {
        "scoreCp": cp, "wdl": wdl, "targetWhite": (wdl[0] + .5 * wdl[1]) / 1000,
        "depth": info["depth"], "seldepth": info["seldepth"], "nodes": terminal["nodes"],
        "scoreNodes": info["nodes"], "bestmove": bestmove, "pv": info["pv"]}}


def audit_row_conversation(events, row, teacher, max_cp):
    require(events and events[0] == "# row-start " + row["id"], "row-start marker mismatch")
    require(events[-1].startswith("# row-end "), "missing row-end marker")
    expected = ["> ucinewgame", "> setoption name Clear Hash", "> isready",
                "> position startpos moves " + " ".join(row["prefixUci"]), "> go nodes 100000"]
    require([event for event in events if event.startswith("> ")] == expected, "row UCI commands/prefix/budget mismatch")
    require(events[1:4] == expected[:3], "row reset ordering mismatch")
    ready = [index for index, line in enumerate(events) if line == "< readyok"]
    require(len(ready) == 1 and 3 < ready[0] < events.index(expected[3]), "row ready barrier mismatch")
    preparation = events[4:events.index(expected[3])]
    require(preparation and preparation[-1] == "< readyok" and all(line.startswith("< ") for line in preparation), "row preparation contains unbound records")
    require(events.index(expected[4]) == events.index(expected[3]) + 1, "position/search ordering mismatch")
    go = events.index(expected[4])
    score, exact, effort, bestmove = None, None, None, None
    for index, line in enumerate(events[go + 1:-1], go + 1):
        require(line.startswith("< "), "unexpected record during search")
        payload = line[2:]
        if payload.startswith("bestmove "):
            tokens = payload.split()
            require((len(tokens) == 2 or len(tokens) == 4 and tokens[2] == "ponder") and MOVE.fullmatch(tokens[1]), "invalid terminal bestmove syntax")
            require(bestmove is None and index == len(events) - 2, "missing/duplicate/nonterminal bestmove")
            bestmove = tokens[1]
        elif payload.startswith("info "):
            info = parse_info(payload)
            if integer(info.get("nodes")) and info["nodes"] >= 0 and (effort is None or info["nodes"] >= effort["nodes"]):
                effort = info
            if finite(info.get("cp")) or finite(info.get("mate")):
                score = info
                if finite(info.get("mate")):
                    exact = None
                elif not info.get("bound"):
                    exact = info
        else:
            require(bestmove is None, "unexpected output after terminal bestmove")
    require(bestmove is not None, "missing terminal bestmove")
    board = replay_source(row)
    try:
        legal = chess.Move.from_uci(bestmove) in board.legal_moves
    except Exception:
        legal = False
    require(legal, "terminal bestmove is illegal")
    info = score if score and finite(score.get("mate")) else exact
    result = assess(info, effort or score, bestmove, row, teacher, max_cp, board)
    disposition = "accepted" if result["accepted"] else result["reason"]
    require(events[-1] == "# row-end " + disposition, "raw transcript admission marker mismatch")
    return result


def audit_startup(events, teacher):
    commands = ["> uci"] + ["> setoption name " + name + " value " + str(teacher["uci"][name]).lower()
        for name in ("Threads", "Hash", "Ponder", "MultiPV", "SyzygyPath", "UCI_LimitStrength", "UCI_ShowWDL")]
    commands += ["> isready", "> export_net big.nnue small.nnue", "> isready"]
    require([line for line in events if line.startswith("> ")] == commands, "startup UCI configuration mismatch")
    require(events.count("< id name Stockfish 18") == 1 and events.count("< uciok") == 1 and events.count("< readyok") == 2, "startup engine identity/barriers missing")
    require(events[0] == "> uci" and events[-1] == "< readyok", "startup endpoint ordering mismatch")
    require(events.index("< uciok") < events.index(commands[1]), "UCI identity barrier ordering mismatch")
    ready = [i for i, line in enumerate(events) if line == "< readyok"]
    export = events.index("> export_net big.nnue small.nnue")
    require(events.index("> isready") < ready[0] < export < ready[1], "network export barrier ordering mismatch")
    uciok = events.index("< uciok")
    require(events[uciok + 1:uciok + 9] == commands[1:9], "startup option/ready command ordering mismatch")
    require(events[ready[0] + 1:ready[0] + 3] == commands[9:11], "export/ready command ordering mismatch")
    require(all(line.startswith(("> ", "< ")) for line in events), "unexpected startup failure marker")


def audit_worker(inputs, directory, worker, selected, results, teacher, rules):
    slot, width = worker["slot"], rules["labeling"]["workers"]
    assigned = list(range(slot, len(selected), width))
    network = [{name: item[name] for name in ("option", "sha256", "bytes")} for item in teacher["engine"]["networks"]]
    require(worker["status"] == "completed" and equal(worker["networks"], network), "worker completion/network identity mismatch")
    require(worker["partition"]["path"] == f"worker-{slot}.partition.jsonl" and worker["transcript"]["path"] == f"worker-{slot}.uci.jsonl", "worker artifact path mismatch")
    ledger = list(inputs.rows(child(directory, worker["partition"]["path"]), worker["partition"]))
    require(len(ledger) == len(assigned), "incomplete worker partition")
    for index, record in zip(assigned, ledger):
        expected = {"index": index, "id": selected[index]["id"], **results[index]}
        require(equal(record, expected), "worker partition differs from complete immutable output join")
    startup, active, position, completed, quit_seen = [], None, 0, 0, False
    for event in inputs.rows(child(directory, worker["transcript"]["path"]), worker["transcript"]):
        require(set(event) == {"rowId", "index", "line"} and isinstance(event["line"], str), "raw UCI record schema mismatch")
        line = event["line"]
        if event["rowId"] is None:
            require(event["index"] is None and active is None, "unbound raw record inside a row")
            if completed == 0:
                startup.append(line)
            else:
                require(completed == len(assigned) and line == "> quit" and not quit_seen, "worker shutdown not complete/unique")
                quit_seen = True
            continue
        require(not quit_seen and position < len(assigned), "extra raw row after completion")
        index = assigned[position]
        require(type(event["index"]) is int and event["index"] == index and event["rowId"] == selected[index]["id"], "raw row identity or worker assignment mismatch")
        if active is None:
            if position == 0:
                audit_startup(startup, teacher)
            require(line == "# row-start " + selected[index]["id"], "raw row has no start marker")
            active = []
        active.append(line)
        if line.startswith("# row-end "):
            recomputed = audit_row_conversation(active, selected[index], teacher, rules["teacher"]["maximumAbsCpForFit"])
            require(equal(recomputed, results[index]), "raw teacher admission/metadata differs from saved result")
            active = None
            completed += 1
            position += 1
    require(active is None and completed == len(assigned) and quit_seen, "worker raw transcript is incomplete")
    return {"slot": slot, "rows": completed, "partitionRows": len(ledger), "rawLines": worker["transcript"]["rows"],
            "sourcePrefixCommands": completed, "nodeBudgetCommands": completed, "terminalBestmoves": completed}


def audit(args):
    start = datetime.now(timezone.utc).isoformat()
    clock, inputs = time.monotonic(), Inputs()
    root, summary_path = args.repo_root.resolve(), args.summary.resolve()
    directory, selection_path = summary_path.parent, args.selection_manifest.resolve()
    require(directory not in args.output.resolve().parents and not args.output.exists(), "audit output must be new and outside label directory")
    summary = inputs.json(summary_path, {"sha256": args.summary_sha256})
    require(summary.get("schema") == "chessy.natural-pilot-label-summary.v1" and summary.get("status") == "completed", "closed successful label completion marker required")
    require(summary.get("formalPass") is False and summary.get("disposition") == "research-only-not-production-fit-eligible" and summary.get("failures") == [], "label run is failed or mislabeled production")
    provenance = summary["provenance"]
    selection = inputs.json(selection_path, {"sha256": provenance["selectionManifestSha256"]})
    require(selection["schema"] == "chessy.natural-pilot-selection.v1" and selection["status"] == "complete-research-only-selection" and selection["productionFitAllowed"] is False and selection["coverage"]["fullPilotReady"] is True, "selection prerequisites differ")
    configs = {}
    for name, entry, key in (("rules", "preregistration", "preregistrationSha256"),
                             ("fit", "fitPreregistration", "fitPreregistrationSha256"),
                             ("teacher", "teacherContract", "teacherManifestSha256")):
        binding = selection[entry]
        require(binding["sha256"] == provenance[key], "frozen contract identity mismatch")
        configs[name] = inputs.json(root / binding["path"], binding)
    rules, fit, teacher = configs["rules"], configs["fit"], configs["teacher"]
    require(equal(summary["teacher"], teacher), "summary teacher contract mismatch")
    require(rules["labeling"]["workers"] == EXPECTED_WORKERS and teacher["search"]["nodeLimit"] == 100000 and teacher["search"]["command"] == "go nodes 100000", "frozen worker/search contract mismatch")
    require(teacher["engine"]["name"] == "Stockfish 18" and teacher["engine"]["release"] == "sf_18", "teacher engine identity mismatch")
    require(teacher["uci"] == {"Threads": 1, "Hash": 64, "Ponder": False, "MultiPV": 1, "SyzygyPath": "<empty>", "UCI_LimitStrength": False, "UCI_ShowWDL": True, "ClearHashBeforeEveryPosition": True, "UciNewGameBeforeEveryPosition": True, "IsReadyBeforeEveryPosition": True}, "teacher option contract mismatch")
    require(teacher["labels"]["eligibility"]["boundScoresAllowed"] is False and teacher["labels"]["eligibility"]["wdlTotal"] == 1000 and fit["teacherAdmission"]["maxAbsCp"] == rules["teacher"]["maximumAbsCpForFit"] == 2000, "teacher admission contract mismatch")
    require(chess.__version__ == rules["dependencies"]["pythonChess"], "python-chess version differs")
    require(provenance["sourceSha256"] == selection["source"]["sha256"] == rules["source"]["sha256"] and provenance["sourceUncompressedSha256"] == selection["source"]["uncompressedSha256"], "source identity mismatch")
    execution = summary["execution"]
    require(execution["workers"] == EXPECTED_WORKERS and execution["assignment"] == "complete-role-order-index-mod-workers" and execution["positionCommand"] == "startpos-full-prefix" and execution["retry"] is False, "execution contract mismatch")
    require(set(provenance["implementation"]) == IMPLEMENTATION, "incomplete labeler implementation identity closure")
    runtime = provenance["runtime"]
    require(set(runtime) == {"node", "platform", "arch"} and re.fullmatch(r"v\d+\.\d+\.\d+", runtime["node"]) and runtime["platform"] == "linux" and runtime["arch"] == "x64", "labeler runtime metadata mismatch")
    for relative, expected in provenance["implementation"].items():
        require(not Path(relative).is_absolute() and ".." not in Path(relative).parts, "implementation path invalid")
        inputs.bind(root / relative, {"sha256": expected})
    inputs.bind(args.stockfish, {"sha256": teacher["engine"]["executable"]["sha256"]})
    inputs.bind(Path(__file__))

    selected, selected_roles = [], {}
    require(len(selection["selection"]["files"]) == len(ROLES), "selection role inventory differs")
    for role in ROLES:
        matches = [item for item in selection["selection"]["files"] if item["role"] == role]
        require(len(matches) == 1 and matches[0]["path"] == role + ".ndjson", "selection role shard mismatch")
        rows = list(inputs.rows(child(selection_path.parent, matches[0]["path"]), matches[0]))
        require(all(row["role"] == role and "teacher" not in row and "exclusion" not in row for row in rows), "invalid immutable selection role")
        selected.extend(rows)
        selected_roles[role] = rows
    require(len(selected) == selection["selection"]["rows"] == EXPECTED_ROWS, "complete 50000-row selection required")
    index = {row["id"]: i for i, row in enumerate(selected)}
    require(len(index) == len(selected) and len({row["sourceId"] for row in selected}) == len(selected), "duplicate immutable source row/game")
    output = summary["output"]
    require(all(integer(output.get(key)) and output[key] >= 0 for key in ("selectedRows", "acceptedRows", "excludedRows")), "noninteger result counts")
    require(output["selectedRows"] == len(selected) == output["acceptedRows"] + output["excludedRows"], "result partition totals differ")
    require(output["exclusionFraction"] == output["excludedRows"] / len(selected), "reported exclusion fraction differs")
    results, accepted_count, excluded_count = {}, 0, 0
    expected_names = {summary_path.name}
    require(len(output["files"]) == len(ROLES), "accepted role inventory differs")
    for role in ROLES:
        matches = [item for item in output["files"] if item["role"] == role]
        require(len(matches) == 1 and matches[0]["path"] == role + ".ndjson", "accepted role shard mismatch")
        binding = matches[0]
        expected_names.add(binding["path"])
        last = -1
        for row in inputs.rows(child(directory, binding["path"]), binding):
            require(row.get("id") in index, "accepted unknown source row")
            i = index[row["id"]]
            require(i not in results and i > last and row.get("role") == role, "duplicate/misordered accepted row or wrong role")
            require(equal({key: value for key, value in row.items() if key != "teacher"}, selected[i]), "accepted source row mutated")
            require(isinstance(row.get("teacher"), dict), "missing accepted teacher metadata")
            results[i] = {"accepted": True, "attempted": True, "teacher": row["teacher"]}
            accepted_count += 1
            last = i
    binding = output["exclusions"]
    require(binding["path"] == "excluded.ndjson", "exclusion shard path differs")
    expected_names.add(binding["path"])
    last = -1
    for row in inputs.rows(child(directory, binding["path"]), binding):
        require(row.get("id") in index, "excluded unknown source row")
        i = index[row["id"]]
        require(i not in results and i > last, "accepted/excluded intersection or duplicate exclusion")
        require(equal({key: value for key, value in row.items() if key != "exclusion"}, selected[i]), "excluded source row mutated")
        exclusion = row["exclusion"]
        require(set(exclusion) == {"reason", "detail", "attempted"} and exclusion["attempted"] is True, "incomplete or unattempted exclusion")
        results[i] = {"accepted": False, **exclusion}
        excluded_count += 1
        last = i
    require(len(results) == len(selected) and accepted_count == output["acceptedRows"] and excluded_count == output["excludedRows"], "incomplete accepted XOR excluded partition")
    workers = summary["workers"]
    require(len(workers) == EXPECTED_WORKERS and [worker["slot"] for worker in workers] == list(range(EXPECTED_WORKERS)), "missing/duplicate worker inventory")
    audited = []
    for worker in workers:
        expected_names.update((worker["partition"]["path"], worker["transcript"]["path"]))
        audited.append(audit_worker(inputs, directory, worker, selected, results, teacher, rules))
        print(json.dumps({"auditedWorker": worker["slot"], "rows": audited[-1]["rows"]}), file=sys.stderr, flush=True)
    require({path.name for path in directory.iterdir()} == expected_names, "unexpected or unaccounted label artifact")
    inputs.recheck()
    return {"schema": "chessy.natural-label-artifact-independent-audit.v1", "status": "PASS",
            "startedAtUtc": start, "completedAtUtc": datetime.now(timezone.utc).isoformat(), "elapsedSeconds": time.monotonic() - clock,
            "researchOnly": True, "productionFitAllowed": False, "modelEvaluationPerformed": False,
            "heldoutAccess": "mechanical source/partition/UCI/teacher-admission verification only; no model predictions, score summaries, losses, or tuning",
            "counts": {"selectedRows": len(selected), "acceptedRows": accepted_count, "excludedRows": excluded_count,
                       "workersCompleted": len(audited), "fullSourceHistoryReplays": len(selected), "rawAdmissionReconstructions": len(selected),
                       "acceptedFullPvLegalityChecks": accepted_count, "terminalBestmovesChecked": len(selected), "mismatches": 0},
            "workers": audited, "fitExclusionGateSatisfied": output["exclusionFraction"] <= rules["teacher"]["maximumExclusionFractionForFitting"],
            "files": {str(path): identity for path, identity in inputs.files.items()},
            "method": "independent Python UCI parser and admission reconstruction; exact immutable source-row/partition/worker joins; all actual named file hashes, bytes and JSONL counts; legal full-history and full accepted-PV replay",
            "limitations": ["Exported NNUE network bytes are not retained by the labeler; their saved per-worker verification attestations match the frozen contract.",
                            "Clean process exit is attested by the authenticated runner completion summary; UCI transcripts end with the consumed quit command.",
                            "Authenticates a closed trusted-runner result; does not certify hostile same-UID mutation resistance or production admission.",
                            "No HCE/NNUE model evaluation or Elo/time claim is performed."],
            "command": [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--summary-sha256", required=True)
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--stockfish", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as stream:
            json.dump(report, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
        print(json.dumps({"status": report["status"], "report": str(args.output.resolve()), "counts": report["counts"]}, sort_keys=True))
    except Exception as error:
        message = str(error) if isinstance(error, AuditError) else "artifact audit failed; malformed structure, missing file, or I/O error"
        print("audit-natural-labels: " + message, file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
