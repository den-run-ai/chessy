#!/usr/bin/env python3
"""Independently replay closed private runtime matches; never run an engine.

Only a complete, authenticated diagnostic batch can pass. No missing game,
invalid move, malformed result or I/O failure is converted into a loss or draw.
The rules implementation is python-chess 1.11.2, independent of the JS runner.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import stat
import sys

import chess

HEX = re.compile(r"[0-9a-f]{64}\Z")
MOVE = re.compile(r"[a-h][1-8][a-h][1-8][qrbn]?\Z")
SAFE_INTEGER = 9007199254740991
EXPECTED_GAMES = 80
PHASES = ("opening", "middlegame", "endgame")
IMPLEMENTATION = ("tools/training/natural-runtime-run.js", "assets/engine.js", "assets/wasm-engine.js",
                  "test/ai-match-openings.js", "test/ai-match-protocol.js")


class AuditError(ValueError):
    """A completed result did not satisfy the authenticated audit contract."""


def require(condition, message):
    if not condition:
        raise AuditError(message)


def integer(value):
    return type(value) is int and abs(value) <= SAFE_INTEGER


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def equal(left, right):
    if type(left) in (int, float) and type(right) in (int, float):
        return finite(left) and finite(right) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equal(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


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


def digest(value):
    return hashlib.sha256(value).hexdigest()


class Inputs:
    """Read each verified byte snapshot once and rehash all inputs before PASS."""
    def __init__(self):
        self.files = {}

    def read(self, path, expected):
        path = Path(path).absolute()
        require(isinstance(expected, dict) and isinstance(expected.get("sha256"), str)
                and HEX.fullmatch(expected["sha256"]), "missing authenticated artifact hash")
        before = path.lstat()
        require(stat.S_ISREG(before.st_mode), "artifact must be a regular nonsymlink file")
        with path.open("rb") as stream:
            inside = os.fstat(stream.fileno())
            require((before.st_dev, before.st_ino) == (inside.st_dev, inside.st_ino), "artifact replaced before read")
            raw = stream.read()
        after = path.lstat()
        signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
        require(signature(before) == signature(after) and len(raw) == before.st_size, "artifact changed during read")
        identity = {"sha256": digest(raw), "bytes": len(raw)}
        require(identity["sha256"] == expected["sha256"], "artifact hash mismatch")
        if "bytes" in expected:
            require(integer(expected["bytes"]) and expected["bytes"] == len(raw), "artifact byte count mismatch")
        if path in self.files:
            require(equal(self.files[path], identity), "artifact changed between reads")
        self.files[path] = identity
        return raw

    def json(self, path, expected):
        value = strict_json(self.read(path, expected))
        require(isinstance(value, dict), "JSON artifact must be an object")
        return value

    def rows(self, path, expected):
        raw = self.read(path, expected)
        require(raw.endswith(b"\n"), "truncated JSONL artifact")
        lines = raw.splitlines(keepends=True)
        require(integer(expected.get("rows")) and len(lines) == expected["rows"], "artifact row count mismatch")
        require(all(line.endswith(b"\n") and line.strip() for line in lines), "empty or truncated JSONL record")
        rows = [strict_json(line) for line in lines]
        require(all(isinstance(row, dict) for row in rows), "JSONL record must be an object")
        return rows

    def recheck(self):
        for path, identity in list(self.files.items()):
            self.read(path, identity)


def child(directory, name):
    require(isinstance(name, str) and name and Path(name).name == name
            and name not in (".", ".."), "game artifact path is not a direct child")
    return directory / name


def position_key(board):
    return " ".join(board.fen(en_passant="legal").split()[:4])


def terminal(board, positions):
    """Production automatic current-position draw policy, with mate priority."""
    if not any(board.legal_moves):
        if board.is_check():
            return ("0-1" if board.turn == chess.WHITE else "1-0", "checkmate")
        return ("1/2-1/2", "stalemate")
    if board.halfmove_clock >= 100:
        return ("1/2-1/2", "fifty-move rule")
    if board.is_insufficient_material():
        return ("1/2-1/2", "insufficient material")
    if positions.get(position_key(board), 0) >= 3:
        return ("1/2-1/2", "threefold repetition")
    return None


def push(board, positions, uci):
    require(isinstance(uci, str) and MOVE.fullmatch(uci), "invalid UCI syntax")
    try:
        move = chess.Move.from_uci(uci)
        require(move in board.legal_moves, "illegal recorded move")
        board.push(move)
    except AuditError:
        raise
    except Exception:
        raise AuditError("illegal recorded move") from None
    positions[position_key(board)] += 1


def validate_result(result, max_depth, node_limit=0):
    require(isinstance(result, dict), "missing search result")
    require(set(result) == {"move", "moveUci", "score", "scorePov", "nodes", "qnodes", "depth",
                            "attemptedDepth", "stopReason", "cutoffs", "researches"}, "search result fields differ")
    require(isinstance(result["moveUci"], str) and MOVE.fullmatch(result["moveUci"]), "invalid result move UCI")
    move = chess.Move.from_uci(result["moveUci"])
    square = lambda value: (7 - chess.square_rank(value)) * 8 + chess.square_file(value)
    require(equal(result["move"], {"from": square(move.from_square), "to": square(move.to_square),
                                    "promotion": chess.piece_symbol(move.promotion).upper() if move.promotion else None}),
            "ABI move object/UCI mismatch")
    require(integer(result["score"]) and -(2 ** 31) <= result["score"] < 2 ** 31
            and result["scorePov"] == "white", "invalid search score or point of view")
    for key in ("nodes", "qnodes", "cutoffs", "researches"):
        require(integer(result[key]) and result[key] >= 0, "invalid search counter")
    require(result["nodes"] > 0 and result["qnodes"] <= result["nodes"], "incoherent search node counts")
    require(result["cutoffs"] <= result["nodes"], "incoherent search cutoff count")
    depth, attempted, reason = result["depth"], result["attemptedDepth"], result["stopReason"]
    require(integer(depth) and 0 <= depth <= max_depth, "invalid completed search depth")
    require(attempted is None or (integer(attempted) and 1 <= attempted <= max_depth
                                 and attempted == depth + 1), "invalid attempted search depth")
    require(reason in (("node-limit", "max-depth", "mate") if node_limit else ("time-limit", "max-depth", "mate")),
            "invalid budgeted-search stop reason")
    if node_limit:
        require(result["nodes"] <= node_limit and (reason != "node-limit" or result["nodes"] == node_limit),
                "fixed-node result violates requested budget")
    if reason == "max-depth":
        require(depth == max_depth and attempted is None, "inconsistent max-depth result")
    elif reason == "mate":
        require(depth >= 1 and attempted is None and abs(result["score"]) >= 999000,
                "inconsistent mate result")
    else:
        require(depth < max_depth and (depth >= 1 or attempted == 1), "inconsistent budget-stop result")


def audit_game(rows, task, modules):
    require(len(rows) >= 2, "incomplete game records")
    header, footer = rows[0], rows[-1]
    require(header.get("schema") == "chessy.natural-runtime-game-header.v1", "missing game header")
    for key in ("taskId", "openingIndex", "openingName", "prefixUci", "timeMs", "candidateColor", "maxPlies", "maxDepth"):
        require(equal(header.get(key), task[key]), "game header/task mismatch: " + key)
    require(equal(header.get("modules"), modules), "game header module mismatch")
    board, positions = chess.Board(), Counter()
    positions[position_key(board)] = 1
    for uci in task["prefixUci"]:
        require(terminal(board, positions) is None, "opening continues after terminal position")
        push(board, positions, uci)
    require(terminal(board, positions) is None, "opening root is terminal")
    searched = rows[1:-1]
    require(len(searched) <= task["maxPlies"], "game exceeds searched-ply cap")
    elapsed = {"baseline": 0.0, "candidate": 0.0}
    nodes = {"baseline": 0, "candidate": 0}
    move_counts = {"baseline": 0, "candidate": 0}
    for ply, record in enumerate(searched):
        require(record.get("schema") == "chessy.natural-runtime-move.v1", "unexpected game record")
        require(record.get("taskId") == task["taskId"] and integer(record.get("ply"))
                and record["ply"] == ply, "move task or ply sequence mismatch")
        require(terminal(board, positions) is None, "searched move follows terminal position")
        color = "w" if board.turn == chess.WHITE else "b"
        module_id = "candidate" if color == task["candidateColor"] else "baseline"
        require(record.get("color") == color and record.get("moduleId") == module_id
                and record.get("moduleSha256") == modules[module_id]["sha256"], "move module/color mismatch")
        require(record.get("fenBefore") == board.fen(en_passant="fen"), "move FEN-before mismatch")
        require(equal(record.get("positions"), dict(positions)), "full legal-EP repetition map mismatch")
        require(equal(record.get("requested"), {"timeMs": task["timeMs"], "maxDepth": task["maxDepth"],
                                                "nodeLimit": 0, "quiesce": True}), "move search request mismatch")
        validate_result(record.get("result"), task["maxDepth"])
        require(finite(record.get("elapsedMs")) and record["elapsedMs"] > 0, "invalid elapsed milliseconds")
        push(board, positions, record["result"]["moveUci"])
        require(record.get("fenAfter") == board.fen(en_passant="fen"), "move FEN-after mismatch")
        elapsed[module_id] += record["elapsedMs"]
        nodes[module_id] += record["result"]["nodes"]
        move_counts[module_id] += 1
    outcome = terminal(board, positions)
    if outcome is None:
        require(len(searched) == task["maxPlies"], "game stopped before terminal or ply cap")
        outcome = ("1/2-1/2", "ply-cap")
    result, reason = outcome
    candidate_score = .5 if result == "1/2-1/2" else float((result == "1-0") == (task["candidateColor"] == "w"))
    require(footer.get("schema") == "chessy.natural-runtime-game-result.v1", "missing game result footer")
    require(footer.get("taskId") == task["taskId"] and integer(footer.get("searchedPlies"))
            and footer["searchedPlies"] == len(searched), "footer task or searched-ply mismatch")
    require(footer.get("finalFen") == board.fen(en_passant="fen"), "footer final FEN mismatch")
    require(footer.get("result") == result and footer.get("reason") == reason
            and equal(footer.get("candidateScore"), candidate_score), "footer outcome differs from independent replay")
    return {"taskId": task["taskId"], "openingIndex": task["openingIndex"], "timeMs": task["timeMs"],
            "candidateColor": task["candidateColor"], "searchedPlies": len(searched), "result": result,
            "reason": reason, "candidateScore": candidate_score, "elapsedMs": elapsed, "nodes": nodes,
            "searchedMoves": move_counts}


def expected_tasks(contract, registration):
    require(contract.get("schema") == "chessy.natural-runtime-private-contract.v1"
            and contract.get("researchOnly") is True and contract.get("productionIntegrationAllowed") is False
            and contract.get("shippingOrEloClaimAllowed") is False
            and contract.get("frozenBeforeRuntimeMeasurements") is True, "invalid frozen private runtime contract")
    require(registration.get("schema") == "chessy.natural-runtime-registration-data.v1"
            and registration.get("formalHoldoutAccessAllowed") is False
            and registration.get("incidentAccessAllowed") is False, "invalid runtime registration")
    match = contract["matches"]
    require(equal(match.get("timeBudgetsMs"), [50, 200]) and match.get("bothColors") is True
            and integer(match.get("historicalOpeningPairs")) and match["historicalOpeningPairs"] == 20
            and integer(match.get("totalGames")) and match["totalGames"] == EXPECTED_GAMES
            and match.get("quiesce") is True, "frozen match dimensions differ")
    require(integer(match.get("maxDepth")) and 1 <= match["maxDepth"] <= 111
            and integer(match.get("maxSearchedPlies")) and 1 <= match["maxSearchedPlies"] <= 180,
            "invalid frozen search bounds")
    openings = registration.get("openings")
    require(isinstance(openings, list) and len(openings) == 20, "incomplete registered opening inventory")
    priority = lambda index: digest(("natural-runtime-v1|" + str(index)).encode())
    indices = sorted(range(100), key=priority)[:20]
    require(equal([opening.get("index") for opening in openings], indices), "registered SHA-ranked opening inventory differs")
    for opening in openings:
        require(opening.get("priority") == priority(opening["index"]), "registered opening priority differs")
        require(isinstance(opening.get("name"), str) and opening["name"], "missing opening name")
        require(isinstance(opening.get("prefixUci"), list) and opening["prefixUci"], "missing full opening prefix")
        require(isinstance(opening.get("san"), str) and opening["san"], "missing opening SAN")
        board, san_board = chess.Board(), chess.Board()
        positions = Counter({position_key(board): 1})
        for uci in opening["prefixUci"]:
            require(terminal(board, positions) is None, "opening continues after terminal position")
            push(board, positions, uci)
        try:
            san_uci = []
            for san in opening["san"].split():
                move = san_board.parse_san(san)
                san_uci.append(move.uci())
                san_board.push(move)
        except Exception:
            raise AuditError("invalid registered opening SAN") from None
        require(equal(san_uci, opening["prefixUci"]), "registered opening SAN/full-prefix mismatch")
        require(board.fen(en_passant="fen") == opening.get("fen") and terminal(board, positions) is None,
                "registered opening FEN/terminal mismatch")
    return [{"taskId": f"b{budget}-o{opening['index']}-{color}", "openingIndex": opening["index"],
             "openingName": opening["name"], "prefixUci": opening["prefixUci"], "timeMs": budget,
             "candidateColor": color, "maxPlies": match["maxSearchedPlies"], "maxDepth": match["maxDepth"]}
            for budget in match["timeBudgetsMs"] for opening in openings for color in ("w", "b")]


def referenced(directory, binding):
    require(isinstance(binding, dict) and isinstance(binding.get("path"), str) and binding["path"],
            "missing referenced artifact path")
    path = Path(binding["path"])
    return path if path.is_absolute() else directory / path


def implementation_closure(directory, bindings):
    require(isinstance(bindings, dict) and bindings, "missing runner input hash closure")
    paths = {str(referenced(directory, {"path": path}).absolute()): value for path, value in bindings.items()}
    sources, roots = {}, set()
    for relative in IMPLEMENTATION:
        matches = [path for path in paths if path.endswith("/" + relative)]
        require(len(matches) == 1, "required runner implementation hash missing or ambiguous: " + relative)
        path = matches[0]
        sources[relative] = {"path": path, "sha256": paths[path]}
        roots.add(path[:-(len(relative) + 1)])
    require(len(roots) == 1, "runner implementation paths span multiple checkouts")
    return paths, sources


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def audit_bench(rows, registration, modules, contract, summary):
    config = contract["microbench"]
    require(equal(config.get("nodeBudgets"), [10000, 100000]) and config.get("positions") == 96
            and config.get("perPhase") == 32 and config.get("warmupPairsPerPositionBudget") == 1
            and config.get("measuredPairsPerPositionBudget") == 3 and config.get("maxDepth") == 30
            and config.get("quiesce") is True and config.get("concurrency") == 1
            and config.get("gateAppliesToEachBudget") is True
            and config.get("minimumMedianPairedNpsRatio") == .95
            and config.get("minimumAggregateNpsRatio") == .95, "frozen microbenchmark dimensions differ")
    positions = registration.get("benchPositions")
    require(isinstance(positions, list) and len(positions) == 96, "incomplete registered benchmark inventory")
    require(len({item.get("id") for item in positions}) == 96, "duplicate registered benchmark position")
    require(len(rows) == 1536, "incomplete 1536-record benchmark inventory")
    boards, histories = [], []
    for phase in PHASES:
        group = [item for item in positions if item.get("phase") == phase]
        require(len(group) == 32 and all(isinstance(item.get("id"), str) and HEX.fullmatch(item["id"]) for item in group)
                and [item["id"] for item in group] == sorted(item["id"] for item in group), "registered benchmark phase/id order differs")
    for item in positions:
        require(isinstance(item.get("prefixUci"), list) and item["prefixUci"], "benchmark full prefix missing")
        board = chess.Board()
        history = Counter({position_key(board): 1})
        for uci in item["prefixUci"]:
            # Authentic source-game histories may contain an unclaimed draw.
            # The frozen benchmark only requires a nonterminal endpoint.
            push(board, history, uci)
        require(board.fen(en_passant="fen") == item.get("fen") and terminal(board, history) is None,
                "registered benchmark root FEN/terminal differs")
        boards.append(board)
        histories.append(dict(history))
    offset = 0
    measured = {budget: [] for budget in config["nodeBudgets"]}
    for node_limit in config["nodeBudgets"]:
        for position_index, item in enumerate(positions):
            for repeat in range(4):
                order = ("candidate", "baseline") if (position_index + repeat) % 2 else ("baseline", "candidate")
                for module_id in order:
                    row = rows[offset]
                    offset += 1
                    require(row.get("schema") == "chessy.natural-runtime-bench-record.v1", "invalid benchmark record schema")
                    require(row.get("positionId") == item["id"] and equal(row.get("positionIndex"), position_index)
                            and row.get("phase") == item["phase"] and equal(row.get("prefixUci"), item["prefixUci"])
                            and equal(row.get("repeat"), repeat) and row.get("warmup") is (repeat == 0),
                            "benchmark record inventory/order differs")
                    require(row.get("moduleId") == module_id and row.get("moduleSha256") == modules[module_id]["sha256"],
                            "benchmark module/order differs")
                    require(row.get("fenBefore") == item["fen"] and equal(row.get("positions"), histories[position_index]),
                            "benchmark FEN/full repetition history differs")
                    require(equal(row.get("requested"), {"maxDepth": 30, "timeMs": 0, "nodeLimit": node_limit, "quiesce": True}),
                            "benchmark search request differs")
                    validate_result(row.get("result"), 30, node_limit)
                    require(chess.Move.from_uci(row["result"]["moveUci"]) in boards[position_index].legal_moves,
                            "illegal benchmark result move")
                    require(finite(row.get("elapsedMs")) and row["elapsedMs"] > 0, "invalid benchmark elapsed time")
                    if repeat:
                        measured[node_limit].append(row)
    require(isinstance(summary.get("byBudget"), dict) and set(summary["byBudget"]) == {"10000", "100000"},
            "benchmark summary budget inventory differs")
    by_budget = {}
    for node_limit, group in measured.items():
        pairs = {}
        sides = {module_id: {"nodes": 0, "ms": 0.0, "times": []} for module_id in modules}
        for row in group:
            pair = pairs.setdefault((row["positionId"], row["repeat"]), {})
            require(row["moduleId"] not in pair, "duplicate measured benchmark pair")
            pair[row["moduleId"]] = row
            side = sides[row["moduleId"]]
            side["nodes"] += row["result"]["nodes"]
            side["ms"] += row["elapsedMs"]
            side["times"].append(row["elapsedMs"])
        ratios = [(pair["candidate"]["result"]["nodes"] / pair["candidate"]["elapsedMs"]) /
                  (pair["baseline"]["result"]["nodes"] / pair["baseline"]["elapsedMs"]) for pair in pairs.values()]
        median = percentile(ratios, .5)
        combined = (sides["candidate"]["nodes"] / sides["candidate"]["ms"]) / (sides["baseline"]["nodes"] / sides["baseline"]["ms"])
        passed = median >= config["minimumMedianPairedNpsRatio"] and combined >= config["minimumAggregateNpsRatio"]
        computed = {"pairs": len(ratios), "medianPairedNpsRatio": median, "aggregateNpsRatio": combined, "pass": passed}
        for module_id, side in sides.items():
            computed[module_id] = {"totalNodes": side["nodes"], "totalElapsedMs": side["ms"], "p90ElapsedMs": percentile(side["times"], .9)}
        saved = summary["byBudget"][str(node_limit)]
        require(integer(saved.get("pairs")) and saved["pairs"] == computed["pairs"] and saved.get("pass") is passed,
                "benchmark summary pair count/verdict differs")
        for key in ("medianPairedNpsRatio", "aggregateNpsRatio"):
            require(finite(saved.get(key)) and math.isclose(saved[key], computed[key], rel_tol=1e-12, abs_tol=1e-12),
                    "benchmark summary NPS statistic differs")
        for module_id in modules:
            require(integer(saved[module_id].get("totalNodes")) and saved[module_id]["totalNodes"] == computed[module_id]["totalNodes"],
                    "benchmark summary node total differs")
            for key in ("totalElapsedMs", "p90ElapsedMs"):
                require(finite(saved[module_id].get(key)) and math.isclose(saved[module_id][key], computed[module_id][key], rel_tol=1e-12, abs_tol=1e-6),
                        "benchmark summary timing differs")
        require(passed, "independently recomputed fixed-node cost gate failed")
        by_budget[str(node_limit)] = computed
    require(summary.get("costGatePassed") is True, "benchmark overall gate differs")
    return {"records": len(rows), "registeredPositions": len(positions), "byBudget": by_budget, "costGatePassed": True}


def aggregate(games, analysis):
    require(integer(analysis.get("bootstrapReplicates")) and analysis["bootstrapReplicates"] == 2000
            and integer(analysis.get("bootstrapSeed")) and analysis["bootstrapSeed"] == 1370915,
            "frozen bootstrap settings differ")
    results = []
    for budget in sorted({game["timeMs"] for game in games}):
        group = [game for game in games if game["timeMs"] == budget]
        scores = Counter(game["candidateScore"] for game in group)
        pairs = []
        for index in sorted({game["openingIndex"] for game in group}):
            pair = [game for game in group if game["openingIndex"] == index]
            require(len(pair) == 2 and {game["candidateColor"] for game in pair} == {"w", "b"},
                    "incomplete opening/color pair")
            pairs.append({"openingIndex": index, "candidateMeanPoints": sum(game["candidateScore"] for game in pair) / 2})
        require(len(pairs) == 20, "incomplete diagnostic opening pairs")
        values = [pair["candidateMeanPoints"] for pair in pairs]
        rng = random.Random(analysis["bootstrapSeed"])
        resamples = [sum(values[rng.randrange(len(values))] for _ in values) / len(values)
                     for _ in range(analysis["bootstrapReplicates"])]
        timing = {}
        for module in ("baseline", "candidate"):
            elapsed = sum(game["elapsedMs"][module] for game in group)
            moves = sum(game["searchedMoves"][module] for game in group)
            timing[module] = {"moves": moves, "totalElapsedMs": elapsed, "meanElapsedMs": elapsed / moves if moves else None,
                              "totalRequestedMs": moves * budget, "totalNodes": sum(game["nodes"][module] for game in group)}
        results.append({"timeMs": budget, "games": len(group), "wins": scores[1], "draws": scores[.5],
                        "losses": scores[0], "candidateMeanPoints": sum(game["candidateScore"] for game in group) / len(group),
                        "openingPairs": pairs, "openingPairBootstrap95PercentileInterval": [percentile(resamples, .025), percentile(resamples, .975)],
                        "bootstrap": {"replicates": analysis["bootstrapReplicates"], "seed": analysis["bootstrapSeed"],
                                      "rng": "Python random.Random (MT19937), reset per budget; ascending opening-index order",
                                      "percentile": "linear interpolation at (replicates-1)*p", "unit": "historical opening pair; not proven independent family"},
                        "terminalReasons": dict(sorted(Counter(game["reason"] for game in group).items())),
                        "plyCapDraws": sum(game["reason"] == "ply-cap" for game in group), "timing": timing,
                        "candidateToBaselineMeanElapsedRatio": timing["candidate"]["meanElapsedMs"] / timing["baseline"]["meanElapsedMs"]
                        if timing["candidate"]["meanElapsedMs"] and timing["baseline"]["meanElapsedMs"] else None})
    return results


def audit(args):
    require(chess.__version__ == "1.11.2", "independent replay requires python-chess 1.11.2")
    require(not args.output.exists() and not args.output.is_symlink(), "audit output already exists")
    inputs = Inputs()
    started = datetime.now(timezone.utc).isoformat()
    contract_path, summary_path = Path(args.contract).absolute(), Path(args.summary).absolute()
    contract = inputs.json(contract_path, {"sha256": args.contract_sha256})
    summary = inputs.json(summary_path, {"sha256": args.summary_sha256})
    directory = summary_path.parent
    require(summary.get("schema") == "chessy.natural-runtime-match-summary.v1" and summary.get("status") == "completed"
            and summary.get("researchOnly") is True and summary.get("shippingOrEloClaimAllowed") is False,
            "complete private diagnostic match summary required")
    require(equal(summary.get("failures"), []) and not summary.get("integrityFailure"), "failed or incomplete match batch")
    require(summary.get("contractSha256") == args.contract_sha256
            and summary["contract"]["sha256"] == args.contract_sha256, "summary contract binding differs")
    inputs.json(referenced(directory, summary["contract"]), {"sha256": args.contract_sha256})
    registration_binding = summary["registration"]
    require(registration_binding["sha256"] == contract["registrationData"]["sha256"]
            and summary.get("registrationSha256") == registration_binding["sha256"], "frozen registration hash differs")
    registration = inputs.json(referenced(directory, registration_binding), contract["registrationData"])
    tasks = expected_tasks(contract, registration)
    receipt_binding = summary["buildReceipt"]
    receipt = inputs.json(referenced(directory, receipt_binding), receipt_binding)
    require(receipt.get("schema") == "chessy.natural-runtime-build-parity.v1"
            and receipt.get("status") == "PASS" and receipt.get("researchOnly") is True, "private build receipt must PASS")
    for key, expected in (("contractSha256", args.contract_sha256),
                          ("frozenSelectionSha256", contract["candidate"]["frozenSelectionSha256"]),
                          ("weightsSha256", contract["candidate"]["weightsSha256"]),
                          ("testReportSha256", contract["candidate"]["testReportSha256"])):
        require(isinstance(expected, str) and HEX.fullmatch(expected) and receipt.get(key) == expected,
                "build receipt frozen identity differs: " + key)
    require(isinstance(receipt.get("evidence"), list) and receipt["evidence"], "missing build evidence hash closure")
    evidence_paths = set()
    for binding in receipt["evidence"]:
        path = referenced(directory, binding).absolute()
        require(path not in evidence_paths and integer(binding.get("bytes")) and binding["bytes"] >= 0,
                "duplicate build evidence or missing byte count")
        inputs.read(path, binding)
        evidence_paths.add(path)
    for key in ("rowEvidence", "implementation"):
        inputs.read(referenced(directory, receipt[key]), receipt[key])
    gates = receipt["gates"]
    require(gates.get("baselineRebuildByteIdentical") is True and gates.get("sizePass") is True
            and integer(gates.get("parityMismatches")) and gates["parityMismatches"] == 0
            and integer(gates.get("parityRows")) and gates["parityRows"] >= contract["parity"]["minimumNaturalRows"]
            and integer(gates.get("authoredFixtureRows")) and gates["authoredFixtureRows"] > 0
            and integer(gates.get("authoredFixtureMismatches")) and gates["authoredFixtureMismatches"] == 0,
            "required build/parity/size gates missing")
    modules = summary["modules"]
    require(isinstance(modules, dict) and set(modules) == {"baseline", "candidate"}, "module inventory differs")
    for module_id, module in modules.items():
        require(equal(module, receipt["modules"].get(module_id)), "module/build receipt identity differs")
        require(integer(module.get("rawBytes")) and module["rawBytes"] > 0
                and integer(module.get("brotliBytes")) and module["brotliBytes"] > 0, "invalid module sizes")
        inputs.read(referenced(directory, module), {"sha256": module["sha256"], "bytes": module["rawBytes"]})
    require(modules["baseline"]["sha256"] == contract["baseline"]["wasmSha256"]
            and modules["baseline"]["rawBytes"] == contract["baseline"]["rawBytes"]
            and modules["baseline"]["brotliBytes"] == contract["baseline"]["brotliBytes"], "baseline module differs from frozen contract")
    require(modules["candidate"]["sha256"] != modules["baseline"]["sha256"]
            and modules["candidate"]["rawBytes"] <= contract["privateSizeGate"]["maximumRawBytes"]
            and modules["candidate"]["brotliBytes"] <= contract["privateSizeGate"]["maximumBrotliBytes"], "candidate identity or private size gate differs")
    bench_binding = summary["benchSummary"]
    bench_path = referenced(directory, bench_binding)
    bench = inputs.json(bench_path, bench_binding)
    require(bench.get("schema") == "chessy.natural-runtime-bench-summary.v1" and bench.get("status") == "completed"
            and bench.get("costGatePassed") is True and not bench.get("failure") and not bench.get("integrityFailure"),
            "completed frozen fixed-node gate required")
    for key, expected in (("contract", args.contract_sha256), ("registration", registration_binding["sha256"]),
                          ("buildReceipt", receipt_binding["sha256"])):
        require(bench[key]["sha256"] == expected, "fixed-node gate input binding differs")
    require(equal(bench.get("modules"), modules), "fixed-node gate module binding differs")
    bench_rows = inputs.rows(child(bench_path.parent, bench["records"]["path"]), bench["records"])
    closure, source_bindings = implementation_closure(directory, summary.get("inputs"))
    for path, expected in summary["inputs"].items():
        inputs.read(referenced(directory, {"path": path}), {"sha256": expected})
    bench_closure, bench_sources = implementation_closure(bench_path.parent, bench.get("inputs"))
    require(equal(source_bindings, bench_sources), "benchmark/match runner implementation differs")
    for path, expected in bench_closure.items():
        require(closure.get(path) == expected, "benchmark source/input omitted or changed in match hash closure")
        inputs.read(Path(path), {"sha256": expected})
    for binding in (summary["contract"], registration_binding, receipt_binding, bench_binding, *modules.values(),
                    {**bench["records"], "path": str(child(bench_path.parent, bench["records"]["path"]))}):
        require(closure.get(str(referenced(directory, binding).absolute())) == binding["sha256"], "runner input hash closure omits required artifact")
    require(isinstance(registration.get("inputs"), dict)
            and set(registration["inputs"]) == {"acceptedSharedTrain", "engine", "historicalOpeningFile"}, "registered source inventory differs")
    for key, binding in registration["inputs"].items():
        require(integer(binding.get("bytes")) and any(equal(identity, {"sha256": binding.get("sha256"), "bytes": binding["bytes"]})
                                                       for identity in inputs.files.values()), "registered source has no verified actual hash/bytes: " + key)
    for key, relative in (("engine", "assets/engine.js"), ("historicalOpeningFile", "test/ai-match-openings.js")):
        require(source_bindings[relative]["sha256"] == registration["inputs"][key]["sha256"], "runner source differs from frozen registration")
    require(summary["environment"].get("node") == contract["toolchain"]["node"]
            and bench["environment"].get("node") == contract["toolchain"]["node"], "runtime Node version differs from frozen toolchain")
    verified_bench = audit_bench(bench_rows, registration, modules, contract, bench)
    inventory = summary.get("games")
    require(isinstance(inventory, list) and len(inventory) == len(tasks) == EXPECTED_GAMES, "incomplete 80-game inventory")
    require(equal([binding.get("taskId") for binding in inventory], [task["taskId"] for task in tasks]),
            "missing, duplicate or misordered registered game task")
    require(len({binding.get("path") for binding in inventory}) == EXPECTED_GAMES, "duplicate game artifact path")
    module_hashes = {module_id: {"sha256": value["sha256"]} for module_id, value in modules.items()}
    games, footers = [], []
    for binding, task in zip(inventory, tasks):
        require(binding.get("path") == task["taskId"] + ".jsonl", "game artifact task filename differs")
        rows = inputs.rows(child(directory, binding["path"]), binding)
        games.append(audit_game(rows, task, module_hashes))
        footers.append(rows[-1])
    require(equal(summary.get("outcomes"), sorted(footers, key=lambda item: item["taskId"])), "summary outcomes differ from replayed footers")
    total_moves = sum(game["searchedPlies"] for game in games)
    require(integer(summary.get("searchedMoves")) and summary["searchedMoves"] == total_moves, "summary searched-move total differs")
    for module_id in ("baseline", "candidate"):
        recorded = summary["timing"][module_id]
        require(integer(recorded.get("moves")) and recorded["moves"] == sum(game["searchedMoves"][module_id] for game in games)
                and integer(recorded.get("totalNodes")) and recorded["totalNodes"] == sum(game["nodes"][module_id] for game in games),
                "summary per-module move/node totals differ")
        require(finite(recorded.get("totalElapsedMs")) and math.isclose(recorded["totalElapsedMs"],
                sum(game["elapsedMs"][module_id] for game in games), rel_tol=1e-12, abs_tol=1e-6), "summary elapsed total differs")
    # Numerical summaries are inaccessible until the complete inventory passes.
    inputs.recheck()
    statistics = aggregate(games, contract["matches"]["analysis"])
    inputs.recheck()
    return {"schema": "chessy.natural-runtime-independent-audit.v1", "status": "PASS", "researchOnly": True,
            "shippingOrEloClaimAllowed": False, "productionIntegrationAllowed": False,
            "startedAtUtc": started, "completedAtUtc": datetime.now(timezone.utc).isoformat(),
            "contractSha256": args.contract_sha256, "summarySha256": args.summary_sha256,
            "registrationSha256": registration_binding["sha256"], "buildReceiptSha256": receipt_binding["sha256"],
            "independentReplay": {"implementation": "python-chess", "version": chess.__version__, "python": sys.version.split()[0]},
            "counts": {"games": len(games), "openingPairsPerBudget": 20, "searchedPlies": total_moves,
                       "fullOpeningHistoryReplays": len(games), "fullRepetitionMapChecks": total_moves,
                       "legalMoveChecks": total_moves, "terminalChecks": len(games), "mismatches": 0},
            "verifiedFixedNodeBenchmark": verified_bench, "diagnosticStatistics": statistics, "games": games,
            "files": {str(path): identity for path, identity in inputs.files.items()},
            "limitations": ["Historical exposed opening pairs are diagnostic clusters, not proven independent position families.",
                            "Python replays moves and authenticates recorded search metadata; it does not rerun or certify engine searches.",
                            "Build, parity and compressed sizes are authenticated producer attestations; the fixed-node gate is independently recomputed.",
                            "Frozen registration selects benchmark rows; source artifacts are rehashed, without repeating the prior independent selection audit.",
                            "Search time is requested per move; actual side costs and imbalance are reported without exact wall-time equality.",
                            "No production admission or Elo claim follows from this completed diagnostic batch."]}


def publish(args, report):
    inputs = Inputs()
    for path, identity in report["files"].items():
        inputs.read(Path(path), identity)
    raw = (json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as stream:
        stream.write(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--contract-sha256", required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--summary-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args)
        publish(args, report)
        print(json.dumps({"status": report["status"], "output": str(args.output.absolute()), "counts": report["counts"]}, sort_keys=True))
    except Exception as error:
        message = str(error) if isinstance(error, AuditError) else "malformed structure, missing file or audit I/O error"
        print("audit-natural-runtime: " + message, file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
