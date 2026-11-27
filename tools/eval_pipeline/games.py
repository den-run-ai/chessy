#!/usr/bin/env python3
"""Freeze, execute, and independently replay a complete equal-time campaign.

The runner uses Python chess rules; every complete history is also replayed by
the retained production JavaScript rules. The auditor replays the closed raw
ledger and PGNs without loading WASM or searching. No partial outcome summary,
resume, adjudication, resignation, or statistical retry is supported.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import queue
import shutil
import statistics
import subprocess
import sys
import threading
import time

import chess
import chess.pgn

try:
    from . import frontier
except ImportError:  # Retained standalone source snapshot.
    import frontier

SCHEMA = "chessy.eval-game-campaign.v1"
sha, require, decoded = frontier.sha, frontier.require, frontier.decoded


def encoded(value):
    return frontier.encoded(value) + b"\n"


def write(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"bytes": len(raw), "sha256": sha(raw)}


def retained(root, relative, raw):
    result = write(Path(root) / relative, raw)
    os.chmod(Path(root) / relative, 0o444)
    return {"path": relative, **result}


def bound(root, binding):
    relative = Path(binding["path"])
    require(not relative.is_absolute() and ".." not in relative.parts, "retained path escapes registration")
    path = Path(root) / relative
    require(path.resolve().is_relative_to(Path(root).resolve()) and not path.is_symlink(), "retained path is a symlink/escape")
    raw = path.read_bytes()
    require(len(raw) == binding["bytes"] and sha(raw) == binding["sha256"], "retained bytes differ: " + str(relative))
    return raw


def identity(path):
    path = Path(path).resolve()
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": sha(raw)}


def host_metadata():
    result = {"loadAverage": os.getloadavg(), "utc": datetime.now(timezone.utc).isoformat()}
    for name in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu.pressure", "/proc/cpuinfo"):
        result[name] = Path(name).read_text() if Path(name).exists() else None
    result["quotaObservation"] = "Absent cgroup files do not establish an unlimited CPU quota."
    return result


def ending(board, plies, cap):
    if board.is_checkmate():
        return {"result": "0-1" if board.turn else "1-0", "termination": "checkmate"}
    if board.is_stalemate():
        return {"result": "1/2-1/2", "termination": "stalemate"}
    if board.halfmove_clock >= 100:
        return {"result": "1/2-1/2", "termination": "fifty-move"}
    if board.is_insufficient_material():
        return {"result": "1/2-1/2", "termination": "insufficient-material"}
    if board.is_repetition(3):
        return {"result": "1/2-1/2", "termination": "current-threefold"}
    if plies >= cap:
        return {"result": "1/2-1/2", "termination": "ply-cap"}
    return None


def prefix_board(opening):
    moves = opening.get("prefixUci")
    require(isinstance(moves, list) and len(moves) == opening.get("selectedPly"), "complete opening prefix is required")
    board = chess.Board()
    history = [board.fen(en_passant="fen")]
    for token in moves:
        require(ending(board, 0, 1) is None, "opening continues a terminal position")
        move = chess.Move.from_uci(token)
        require(move in board.legal_moves, "illegal opening move")
        board.push(move)
        history.append(board.fen(en_passant="fen"))
    require(history[-1] == opening.get("fen") and board.is_valid(), "opening FEN/prefix mismatch")
    require(ending(board, 0, 1) is None, "terminal opening")
    return board, history


def select_openings(config, raw):
    rows = [decoded(line) for line in raw.splitlines() if line.strip()]
    selected = {}
    for row in rows:
        if "openingId" in row:
            key = row["openingId"]
        elif row.get("sourceGameId") in config["openingIds"]:
            key = row["sourceGameId"]
        else:
            key = str(row.get("index"))
        if key not in config["openingIds"]:
            continue
        require(key not in selected, "duplicate selected opening identity")
        require(isinstance(row.get("sourceGameId"), str) and bool(row["sourceGameId"]), "source-game identity required")
        prefix_board(row)
        selected[key] = dict(row, openingId=key)
    require(set(selected) == set(config["openingIds"]), "registered opening inventory is incomplete")
    require(len({row["sourceGameId"] for row in selected.values()}) == len(selected), "duplicate source game")
    return [selected[key] for key in config["openingIds"]]


def runtime_config(config):
    frontier.validate_config(config)
    result = {"rootSeed": config.get("rootSeed", 0),
              "timeoutPerRequestSeconds": config.get("timeoutPerRequestSeconds", 10),
              "timeoutWholeCampaignSeconds": config.get("timeoutWholeCampaignSeconds", 21600),
              "nodeArguments": config.get("nodeArguments", []),
              "warmup": config.get("warmup", {"cycles": 2, "nodeLimit": 10000, "timeMs": 0,
                                                "fens": [chess.STARTING_FEN]})}
    require(type(result["rootSeed"]) is int and result["rootSeed"] == 0, "campaign root seed must be zero")
    for name in ("timeoutPerRequestSeconds", "timeoutWholeCampaignSeconds"):
        require(type(result[name]) in (int, float) and math.isfinite(result[name]) and result[name] > 0,
                "invalid frozen watchdog")
    require(result["timeoutPerRequestSeconds"] * 1000 > max(config["timeControlsMs"]), "request watchdog does not cover time grid")
    require(result["nodeArguments"] in ([], ["--no-liftoff", "--no-wasm-lazy-compilation"]), "unsupported Node execution tier")
    warm = result["warmup"]
    require(isinstance(warm, dict) and type(warm.get("cycles")) is int and 1 <= warm["cycles"] <= 32
            and type(warm.get("nodeLimit")) is int and 1 <= warm["nodeLimit"] <= 1000000
            and type(warm.get("timeMs")) is int and warm["timeMs"] == 0
            and isinstance(warm.get("fens"), list) and 1 <= len(warm["fens"]) <= 32,
            "fixed identical node-bounded warmup required")
    for fen in warm["fens"]:
        board = chess.Board(fen)
        require(board.is_valid() and board.fen(en_passant="fen") == fen and ending(board, 0, 1) is None,
                "invalid warmup FEN")
    return result


def register(config_path, openings_path, base_wasm, candidate_wasm, host, loader, rules,
             node, output, sources=()):
    config_raw, openings_raw = Path(config_path).read_bytes(), Path(openings_path).read_bytes()
    config = decoded(config_raw)
    runtime = runtime_config(config)
    openings = select_openings(config, openings_raw)
    inputs = {"config.json": config_raw, "opening-source.jsonl": openings_raw,
              "openings.jsonl": b"".join(encoded(row) for row in openings),
              "backend/host.mjs": Path(host).read_bytes(),
              "backend/wasm-engine.cjs": Path(loader).read_bytes(),
              "backend/engine.cjs": Path(rules).read_bytes(),
              "backend/base.wasm": Path(base_wasm).read_bytes(),
              "backend/candidate.wasm": Path(candidate_wasm).read_bytes(),
              "source/games.py": Path(__file__).read_bytes(),
              "source/frontier.py": Path(frontier.__file__).read_bytes()}
    for side in ("base", "candidate"):
        require(sha(inputs["backend/" + side + ".wasm"]) == config[side]["sha256"], "WASM differs from configuration build identity")
    # Snapshot the rules implementation that the retained runner/auditor imports.
    for source in sorted(Path(chess.__file__).parent.glob("*.py")):
        inputs["source/chess/" + source.name] = source.read_bytes()
    for index, source in enumerate(sources):
        path = Path(source)
        require(path.is_file(), "additional source snapshot is not a file")
        inputs["provenance/" + str(index).zfill(3) + "-" + path.name] = path.read_bytes()
    node_identity = identity(node)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    files = {name: retained(output, name, raw) for name, raw in inputs.items()}
    affinity = sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None
    manifest = {"schema": SCHEMA + ".registration", "status": "frozen-before-games",
                "researchOnly": True, "productionAdmission": False, "config": config,
                "runtime": runtime, "schedule": frontier.schedule(config), "files": files,
                "nodeExecutable": node_identity, "pythonExecutable": identity(sys.executable),
                "pythonVersion": sys.version, "pythonChessVersion": chess.__version__,
                "platform": platform.platform(), "availableAffinity": affinity,
                "selectedCpu": affinity[0] if affinity else None,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "hostMetadata": host_metadata(),
                "scope": "development on the explicitly supplied opening source; no automatic formal or production admission"}
    receipt = retained(output, "registration.json", encoded(manifest))
    return {"directory": str(output), "registrationSha256": receipt["sha256"],
            "games": len(manifest["schedule"]), "runner": str(output / "source/games.py")}


def load_registration(root, expected_sha=None, check_runtime_source=False):
    root = Path(root)
    raw = (root / "registration.json").read_bytes()
    if expected_sha is not None:
        require(sha(raw) == expected_sha, "registration differs from external pre-game digest")
    registration = decoded(raw)
    require(registration.get("schema") == SCHEMA + ".registration"
            and registration.get("status") == "frozen-before-games", "unregistered game campaign")
    require(registration["runtime"] == runtime_config(registration["config"]), "runtime settings changed")
    require(registration["schedule"] == frontier.schedule(registration["config"]), "registered schedule changed")
    for binding in registration["files"].values():
        bound(root, binding)
    require(decoded(bound(root, registration["files"]["config.json"])) == registration["config"], "config bytes differ from registration")
    openings = [decoded(line) for line in bound(root, registration["files"]["openings.jsonl"]).splitlines()]
    require(openings == select_openings(registration["config"], bound(root, registration["files"]["opening-source.jsonl"])),
            "selected openings differ from authenticated input")
    for side in ("base", "candidate"):
        require(registration["files"]["backend/" + side + ".wasm"]["sha256"] == registration["config"][side]["sha256"],
                "registered module/config mismatch")
    if check_runtime_source:
        require(Path(__file__).resolve() == (root / "source/games.py").resolve(), "execute the retained source/games.py snapshot")
        require(sha(Path(__file__).read_bytes()) == registration["files"]["source/games.py"]["sha256"], "runner source changed")
        require(sha(Path(frontier.__file__).read_bytes()) == registration["files"]["source/frontier.py"]["sha256"], "statistics source changed")
        require(Path(chess.__file__).resolve() == (root / "source/chess/__init__.py").resolve(), "use the retained Python rules package")
    return registration, openings, sha(raw)


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.stream = self.path.open("xb")
        self.digest = hashlib.sha256()
        self.size = self.rows = 0

    def emit(self, value):
        raw = encoded(value)
        self.stream.write(raw)
        self.stream.flush()
        self.digest.update(raw)
        self.size += len(raw)
        self.rows += 1

    def close(self):
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        return {"path": self.path.name, "bytes": self.size, "rows": self.rows, "sha256": self.digest.hexdigest()}


class Backend:
    def __init__(self, registration, root):
        self.registration, self.root = registration, Path(root)
        binding = registration["nodeExecutable"]
        self.fd = os.open(binding["path"], os.O_RDONLY)
        with os.fdopen(os.dup(self.fd), "rb") as source:
            raw = source.read()
        require(sha(raw) == binding["sha256"] and len(raw) == binding["bytes"], "Node executable changed")
        self.stderr_path = self.root / "host.stderr"
        self.stderr = self.stderr_path.open("xb")
        self.queue = queue.Queue()
        self.closed = False
        executable = f"/proc/self/fd/{self.fd}" if Path("/proc/self/fd").is_dir() else binding["path"]
        args = [executable, *registration["runtime"]["nodeArguments"], str(self.root / "backend/host.mjs"),
                "--loader", str(self.root / "backend/wasm-engine.cjs"),
                "--rules", str(self.root / "backend/engine.cjs"),
                "--wasm", "base=" + str(self.root / "backend/base.wasm"),
                "--wasm", "candidate=" + str(self.root / "backend/candidate.wasm")]
        cpu = registration["selectedCpu"]
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
                                        pass_fds=(self.fd,), env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""},
                                        preexec_fn=(lambda: os.sched_setaffinity(0, {cpu})) if cpu is not None else None)
        def reader():
            while True:
                line = self.process.stdout.readline(1 << 22)
                self.queue.put(line)
                if not line:
                    return
        self.thread = threading.Thread(target=reader, daemon=True)
        self.thread.start()

    def request(self, request):
        raw_request = encoded(request)
        started = time.perf_counter_ns()
        self.process.stdin.write(raw_request)
        self.process.stdin.flush()
        try:
            raw = self.queue.get(timeout=self.registration["runtime"]["timeoutPerRequestSeconds"])
        except queue.Empty as error:
            raise TimeoutError("frozen request watchdog expired; no retry") from error
        wall_ns = time.perf_counter_ns() - started
        require(bool(raw) and raw.endswith(b"\n"), "missing or oversized host response")
        return raw, wall_ns

    def close(self):
        if self.closed:
            return self.process.returncode
        self.closed = True
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.stderr.flush()
        os.fsync(self.stderr.fileno())
        self.stderr.close()
        os.close(self.fd)
        return self.process.returncode


def response_result(request, response):
    require(isinstance(response, dict) and response.get("id") == request["id"] and response.get("ok") is True,
            "host response failure or identity mismatch")
    require(isinstance(response.get("result"), dict), "missing host result")
    return response["result"]


def info_contract(registration, request, response):
    result = response_result(request, response)
    require(result.get("abiVersion") == 2 and result.get("execArgv") == registration["runtime"]["nodeArguments"], "host ABI/tier mismatch")
    for name, key in (("loaderSha256", "backend/wasm-engine.cjs"), ("rulesSha256", "backend/engine.cjs")):
        require(result.get(name) == registration["files"][key]["sha256"], "host source identity mismatch")
    require(set(result.get("engines", {})) == {"base", "candidate"}, "host engine inventory mismatch")
    for side in ("base", "candidate"):
        binding = registration["files"]["backend/" + side + ".wasm"]
        actual = result["engines"][side]
        require(actual.get("sha256") == binding["sha256"] and actual.get("bytes") == binding["bytes"], "host module identity mismatch")
    if registration["config"].get("nodeVersion"):
        require(result.get("nodeVersion") == registration["config"]["nodeVersion"], "Node version differs from prospective configuration")
    return result


def search_contract(request, response, board):
    result = response_result(request, response)
    for key in ("depth", "nodes", "qnodes", "cutoffs", "researches"):
        require(type(result.get(key)) is int and result[key] >= 0, "invalid search counter: " + key)
    require(result["nodes"] >= 1 and result["qnodes"] <= result["nodes"] and result["depth"] <= request["maxDepth"], "inconsistent search counters")
    require(type(result.get("score")) is int and abs(result["score"]) <= 1000000 and result.get("scorePov") == "white", "invalid score/POV")
    attempted = result.get("attemptedDepth")
    require(attempted is None or (type(attempted) is int and result["depth"] < attempted <= request["maxDepth"]), "invalid interrupted depth")
    reason = result.get("stopReason")
    require(reason in ("max-depth", "time-limit", "node-limit", "mate", "unknown"), "invalid search stop reason")
    require(reason != "node-limit" or request["nodeLimit"] > 0, "unexpected node-limited timed search")
    require(reason != "time-limit" or request["timeMs"] > 0, "unexpected time-limited warmup")
    require(reason != "max-depth" or (result["depth"] == request["maxDepth"] and attempted is None), "incorrect depth completion")
    require(reason != "mate" or (result["depth"] > 0 and abs(result["score"]) >= 999000 and attempted is None), "incorrect mate completion")
    require(reason != "unknown" or (result.get("ttSaturated") is True and result["depth"] > 0), "unexplained stop")
    elapsed = result.get("engineCallMs")
    require(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed >= 0, "invalid measured engine time")
    legal = sorted(move.uci() for move in board.legal_moves)
    require(result.get("uci") in legal, "illegal selected move")
    move = result.get("move")
    require(isinstance(move, dict) and all(type(move.get(key)) is int and 0 <= move[key] < 64 for key in ("from", "to"))
            and move.get("promotion") in (None, "Q", "R", "B", "N"), "invalid production move fields")
    def square(index):
        return chess.square_name(chess.square(index % 8, 7 - index // 8))
    require(square(move["from"]) + square(move["to"]) + (move.get("promotion") or "").lower() == result["uci"],
            "production move fields disagree with UCI")
    rules = response.get("rules")
    require(isinstance(rules, dict) and rules.get("fen") == board.fen(en_passant="fen")
            and rules.get("legalUcis") == legal and rules.get("status", {}).get("over") is False,
            "independent current-position rules disagree")
    return result


def replay_contract(request, response, board, history, terminal):
    result = response_result(request, response)
    require(result.get("fen") == board.fen(en_passant="fen") and result.get("historyFens") == history,
            "independent complete-history replay mismatch")
    require(result.get("legalUcis") == sorted(move.uci() for move in board.legal_moves), "independent replay legal moves differ")
    status = result.get("status", {})
    if terminal["termination"] == "ply-cap":
        require(status.get("over") is False, "rules terminal must precede artificial cap")
    else:
        reasons = {"checkmate": "checkmate", "stalemate": "stalemate", "fifty-move": "fifty-move rule",
                   "insufficient-material": "insufficient material", "current-threefold": "threefold repetition"}
        require(status.get("over") is True and status.get("result") == terminal["result"]
                and status.get("reason") == reasons[terminal["termination"]], "independent final result differs")


def game_pgn(slot, opening, moves, terminal):
    game = chess.pgn.Game()
    game.headers.update({"Event": "Evaluator production pipeline development", "Site": "local offline WASM",
                         "Date": datetime.now(timezone.utc).strftime("%Y.%m.%d"), "Round": "?",
                         "White": slot["candidateId"] if slot["candidateColor"] == "white" else slot["baseId"],
                         "Black": slot["baseId"] if slot["candidateColor"] == "white" else slot["candidateId"],
                         "Result": terminal["result"], "Termination": terminal["termination"],
                         "ScheduleId": slot["scheduleId"], "OpeningId": slot["openingId"],
                         "SourceGameId": opening["sourceGameId"], "SearchLimit": str(slot["timeMs"]) + "ms/move"})
    cursor = game
    for token in moves:
        cursor = cursor.add_variation(chess.Move.from_uci(token))
    return (game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=False)) + "\n\n").encode()


def run(root, expected_sha):
    root = Path(root).resolve()
    registration, opening_rows, digest = load_registration(root, expected_sha, check_runtime_source=True)
    config, runtime = registration["config"], registration["runtime"]
    openings = {row["openingId"]: row for row in opening_rows}
    ledger = Ledger(root / "raw.jsonl")  # Exclusive: any previous attempt forbids a rerun.
    pgn = (root / "games.pgn").open("xb")
    records_file = (root / "games.jsonl").open("xb")
    started = time.monotonic()
    completed_games = completed_moves = 0
    backend = None
    ledger.emit({"type": "header", "schema": SCHEMA + ".raw", "registrationSha256": digest,
                 "scheduledGames": len(registration["schedule"]), "startedAt": datetime.now(timezone.utc).isoformat(),
                 "cpu": registration["selectedCpu"], "hostMetadata": host_metadata(), "resultsSealedUntilComplete": True})

    def exchange(request, metadata):
        require(time.monotonic() - started <= runtime["timeoutWholeCampaignSeconds"], "whole-campaign watchdog expired")
        raw, wall_ns = backend.request(request)
        ledger.emit({**metadata, "request": request, "requestSha256": sha(encoded(request)),
                     "response": raw.decode(), "responseSha256": sha(raw), "wallNs": wall_ns})
        return decoded(raw)

    try:
        backend = Backend(registration, root)
        request = {"id": "info", "op": "info"}
        info = info_contract(registration, request, exchange(request, {"type": "info"}))
        warm = runtime["warmup"]
        for cycle in range(warm["cycles"]):
            for index, fen in enumerate(warm["fens"]):
                for engine in (("base", "candidate") if cycle % 2 == 0 else ("candidate", "base")):
                    request = {"id": f"warmup-{cycle}-{index}-{engine}", "op": "search", "engine": engine,
                               "fen": fen, "historyFens": [fen], "maxDepth": config["maxDepth"],
                               "nodeLimit": warm["nodeLimit"], "timeMs": 0, "rootSeed": 0}
                    search_contract(request, exchange(request, {"type": "warmup"}), chess.Board(fen))
        for slot in registration["schedule"]:
            opening = openings[slot["openingId"]]
            board, history = prefix_board(opening)
            moves, plies = list(opening["prefixUci"]), 0
            ledger.emit({"type": "start", "slot": slot, "fen": history[-1], "sourceGameId": opening["sourceGameId"],
                         "prefixSha256": sha(encoded(moves))})
            while True:
                terminal = ending(board, plies, config["postOpeningPlyCap"])
                if terminal:
                    break
                engine = "candidate" if (board.turn == chess.WHITE) == (slot["candidateColor"] == "white") else "base"
                request = {"id": slot["scheduleId"] + "-" + str(plies), "op": "search", "engine": engine,
                           "fen": history[-1], "historyFens": history, "maxDepth": config["maxDepth"],
                           "nodeLimit": 0, "timeMs": slot["timeMs"], "rootSeed": 0}
                response = exchange(request, {"type": "move", "scheduleId": slot["scheduleId"], "ply": plies,
                                              "historySha256": sha(encoded(history))})
                result = search_contract(request, response, board)
                board.push_uci(result["uci"])
                moves.append(result["uci"])
                history.append(board.fen(en_passant="fen"))
                plies += 1
                completed_moves += 1
            request = {"id": slot["scheduleId"] + "-replay", "op": "replay", "moves": moves}
            replay_contract(request, exchange(request, {"type": "replay", "scheduleId": slot["scheduleId"]}), board, history, terminal)
            raw_pgn = game_pgn(slot, opening, moves, terminal)
            pgn.write(raw_pgn)
            pgn.flush()
            row = {**slot, **terminal, "postOpeningPlies": plies, "completed": True, "nodeLimit": 0,
                   "baseSha256": config["base"]["sha256"], "candidateSha256": config["candidate"]["sha256"],
                   "sourceGameId": opening["sourceGameId"], "fullMoves": moves, "finalFen": history[-1],
                   "historySha256": sha(encoded(history)), "pgnSha256": sha(raw_pgn), "pgnBytes": len(raw_pgn)}
            records_file.write(encoded(row))
            records_file.flush()
            ledger.emit({"type": "end", "record": row})
            completed_games += 1
            print(json.dumps({"stage": "games", "completed": completed_games, "total": len(registration["schedule"]),
                              "elapsedSeconds": round(time.monotonic() - started, 1)}), flush=True)
        returncode = backend.close()
        require(returncode == 0, "host exited unsuccessfully")
        load_registration(root, digest, check_runtime_source=True)
        ledger.emit({"type": "footer", "registrationSha256": digest, "completedGames": completed_games,
                     "completedMoves": completed_moves, "returncode": returncode,
                     "prefixSha256": ledger.digest.hexdigest(), "prefixBytes": ledger.size})
        raw_binding = ledger.close()
        for stream in (pgn, records_file):
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
        files = {"raw.jsonl": raw_binding}
        for name in ("games.pgn", "games.jsonl", "host.stderr"):
            raw = (root / name).read_bytes()
            files[name] = {"path": name, "bytes": len(raw), "sha256": sha(raw)}
        completion = {"schema": SCHEMA + ".completion", "status": "complete-sealed-before-audit",
                      "researchOnly": True, "formalPass": False, "productionAdmission": False,
                      "registrationSha256": digest, "games": completed_games, "moves": completed_moves,
                      "elapsedSeconds": time.monotonic() - started, "hostInfo": info, "files": files,
                      "hostMetadataAfter": host_metadata(),
                      "outcomeSummaryProduced": False}
        write(root / "completion.json", encoded(completion))
        return {"status": completion["status"], "games": completed_games, "moves": completed_moves}
    except BaseException as error:
        if not ledger.stream.closed:
            ledger.emit({"type": "failure", "completedGames": completed_games,
                         "error": type(error).__name__, "message": str(error)})
            ledger.close()
        for stream in (pgn, records_file):
            if not stream.closed:
                stream.flush()
                os.fsync(stream.fileno())
                stream.close()
        if backend is not None:
            backend.close()
        write(root / "failure.json", encoded({"schema": SCHEMA + ".failure", "status": "invalid-incomplete",
              "registrationSha256": digest, "error": type(error).__name__, "message": str(error), "retryAllowed": False}))
        raise


def audited_ending(board, plies, cap):
    """Independent raw-ledger oracle; does not call the runner's ending helper."""
    moves = list(board.legal_moves)
    if not moves:
        if board.is_check():
            return {"result": "0-1" if board.turn == chess.WHITE else "1-0", "termination": "checkmate"}
        return {"result": "1/2-1/2", "termination": "stalemate"}
    if board.halfmove_clock >= 100:
        reason = "fifty-move"
    elif board.is_insufficient_material():
        reason = "insufficient-material"
    elif board.is_repetition(count=3):
        reason = "current-threefold"
    elif plies == cap:
        reason = "ply-cap"
    else:
        require(plies < cap, "search continued after cap")
        return None
    return {"result": "1/2-1/2", "termination": reason}


def timing_summary(samples, time_ms):
    output = {}
    for side in ("base", "candidate"):
        rows = samples[side]
        require(bool(rows), "missing side telemetry")
        calls = [row["result"]["engineCallMs"] for row in rows]
        walls = [row["wallNs"] / 1e6 for row in rows]
        limited = [row["result"]["engineCallMs"] for row in rows if row["result"]["stopReason"] == "time-limit"]
        nodes = sum(row["result"]["nodes"] for row in rows)
        output[side] = {"searches": len(rows), "nodes": nodes, "meanNodes": nodes / len(rows),
                        "engineCallSeconds": sum(calls) / 1000, "requestWallSeconds": sum(walls) / 1000,
                        "nodesPerEngineCallSecond": nodes * 1000 / sum(calls) if sum(calls) > 0 else None,
                        "qnodes": sum(row["result"]["qnodes"] for row in rows),
                        "meanDepth": statistics.mean(row["result"]["depth"] for row in rows),
                        "medianDepth": statistics.median(row["result"]["depth"] for row in rows),
                        "meanEngineCallMs": statistics.mean(calls), "medianEngineCallMs": statistics.median(calls),
                        "p95EngineCallMs": frontier.quantile(calls, .95), "p99EngineCallMs": frontier.quantile(calls, .99),
                        "meanRequestWallMs": statistics.mean(walls), "p99RequestWallMs": frontier.quantile(walls, .99),
                        "stopReasons": dict(Counter(row["result"]["stopReason"] for row in rows)),
                        "timeLimitStops": len(limited), "timeLimitFraction": len(limited) / len(rows),
                        "timeLimitMedianMs": statistics.median(limited) if limited else None,
                        "timeLimitP99Ms": frontier.quantile(limited, .99) if limited else None}
    ratio = (output["candidate"]["timeLimitMedianMs"] / output["base"]["timeLimitMedianMs"]
             if output["base"]["timeLimitMedianMs"] and output["candidate"]["timeLimitMedianMs"] is not None else None)
    clean = (ratio is not None and .9 <= ratio <= 1.1
             and all(output[side]["timeLimitP99Ms"] is not None and output[side]["timeLimitP99Ms"] <= 2 * time_ms
                     for side in output))
    return {"timeMs": time_ms, "telemetry": output, "cleanRealizedEqualTime": clean,
            "timeLimitMedianCandidateOverBase": ratio, "medianRatioRange": [.9, 1.1], "p99LimitMultiplier": 2,
            "scope": "loader/WASM call duration and full request wall time; not browser UI or CPU-time equality"}


def audit(root, expected_sha=None, publish=True):
    """Replay every closed raw record and PGN, without host startup or searches."""
    root = Path(root)
    registration, openings_list, digest = load_registration(root, expected_sha)
    config = registration["config"]
    require(not (root / "failure.json").exists(), "failed campaign cannot be summarized")
    completion_raw = (root / "completion.json").read_bytes()
    completion = decoded(completion_raw)
    require(completion.get("schema") == SCHEMA + ".completion" and completion.get("status") == "complete-sealed-before-audit"
            and completion.get("registrationSha256") == digest and completion.get("outcomeSummaryProduced") is False,
            "campaign is not completely sealed")
    require(set(completion["files"]) == {"raw.jsonl", "games.pgn", "games.jsonl", "host.stderr"}, "completion file inventory differs")
    payloads = {name: bound(root, binding) for name, binding in completion["files"].items()}
    raw_lines = payloads["raw.jsonl"].splitlines(keepends=True)
    ledger = [decoded(line) for line in raw_lines]
    require(len(ledger) >= 3 and all(encoded(row) == raw for row, raw in zip(ledger, raw_lines)), "raw ledger is not canonical")
    header, footer = ledger[0], ledger[-1]
    require(header.get("type") == "header" and header.get("registrationSha256") == digest
            and header.get("scheduledGames") == len(registration["schedule"]), "raw header mismatch")
    require(footer.get("type") == "footer" and footer.get("registrationSha256") == digest and footer.get("returncode") == 0,
            "raw footer missing/failed")
    prefix = b"".join(raw_lines[:-1])
    require(footer.get("prefixSha256") == sha(prefix) and footer.get("prefixBytes") == len(prefix), "raw footer seal mismatch")
    index = 1

    def take(kind):
        nonlocal index
        require(index < len(ledger) - 1 and ledger[index].get("type") == kind, "missing or reordered raw event: " + kind)
        row = ledger[index]
        index += 1
        return row

    def exchange(row, expected_request):
        require(row.get("request") == expected_request and row.get("requestSha256") == sha(encoded(expected_request)),
                "raw request/history differs from independently reconstructed request")
        raw = row.get("response", "").encode()
        require(row.get("responseSha256") == sha(raw), "raw response identity mismatch")
        require(type(row.get("wallNs")) is int and row["wallNs"] >= 0, "invalid request wall time")
        return decoded(raw)

    request = {"id": "info", "op": "info"}
    info = info_contract(registration, request, exchange(take("info"), request))
    require(info == completion.get("hostInfo"), "host identity/completion mismatch")
    warm = registration["runtime"]["warmup"]
    for cycle in range(warm["cycles"]):
        for number, fen in enumerate(warm["fens"]):
            for side in (("base", "candidate") if cycle % 2 == 0 else ("candidate", "base")):
                request = {"id": f"warmup-{cycle}-{number}-{side}", "op": "search", "engine": side,
                           "fen": fen, "historyFens": [fen], "maxDepth": config["maxDepth"],
                           "nodeLimit": warm["nodeLimit"], "timeMs": 0, "rootSeed": 0}
                search_contract(request, exchange(take("warmup"), request), chess.Board(fen))
    openings = {row["openingId"]: row for row in openings_list}
    records = []
    telemetry = {t: {"base": [], "candidate": []} for t in config["timeControlsMs"]}
    total_moves = pgn_offset = 0
    for slot in registration["schedule"]:
        opening = openings[slot["openingId"]]
        # Reconstruct independently from the initial position, not producer state.
        board = chess.Board()
        history, full_moves = [board.fen(en_passant="fen")], []
        for token in opening["prefixUci"]:
            require(audited_ending(board, 0, 1) is None, "terminal opening prefix")
            move = chess.Move.from_uci(token)
            require(move in board.legal_moves, "illegal opening prefix in audit")
            board.push(move)
            full_moves.append(token)
            history.append(board.fen(en_passant="fen"))
        require(history[-1] == opening["fen"], "audited opening FEN mismatch")
        start = take("start")
        require(start.get("slot") == slot and start.get("fen") == history[-1]
                and start.get("sourceGameId") == opening["sourceGameId"]
                and start.get("prefixSha256") == sha(encoded(full_moves)), "raw game start differs")
        plies = 0
        while True:
            terminal = audited_ending(board, plies, config["postOpeningPlyCap"])
            if terminal is not None:
                break
            side = "candidate" if (board.turn == chess.WHITE) == (slot["candidateColor"] == "white") else "base"
            request = {"id": slot["scheduleId"] + "-" + str(plies), "op": "search", "engine": side,
                       "fen": history[-1], "historyFens": list(history), "maxDepth": config["maxDepth"],
                       "nodeLimit": 0, "timeMs": slot["timeMs"], "rootSeed": 0}
            row = take("move")
            require(row.get("scheduleId") == slot["scheduleId"] and row.get("ply") == plies
                    and row.get("historySha256") == sha(encoded(history)), "raw move identity/history mismatch")
            result = search_contract(request, exchange(row, request), board)
            require(result["engineCallMs"] * 1e6 <= row["wallNs"] + 1000000, "engine duration exceeds request wall time")
            telemetry[slot["timeMs"]][side].append({"result": result, "wallNs": row["wallNs"]})
            board.push_uci(result["uci"])
            full_moves.append(result["uci"])
            history.append(board.fen(en_passant="fen"))
            plies += 1
        request = {"id": slot["scheduleId"] + "-replay", "op": "replay", "moves": full_moves}
        row = take("replay")
        require(row.get("scheduleId") == slot["scheduleId"], "replay game identity mismatch")
        replay_contract(request, exchange(row, request), board, history, terminal)
        finished = take("end").get("record")
        require(isinstance(finished, dict) and all(finished.get(key) == value for key, value in {**slot, **terminal}.items()),
                "recorded outcome differs from independent replay")
        require(finished.get("postOpeningPlies") == plies and finished.get("fullMoves") == full_moves
                and finished.get("historySha256") == sha(encoded(history)) and finished.get("finalFen") == history[-1]
                and finished.get("sourceGameId") == opening["sourceGameId"], "finished game evidence differs")
        size = finished.get("pgnBytes")
        require(type(size) is int and size > 0, "missing PGN byte count")
        game_raw = payloads["games.pgn"][pgn_offset:pgn_offset + size]
        pgn_offset += size
        require(sha(game_raw) == finished.get("pgnSha256"), "per-game PGN identity mismatch")
        stream = io.StringIO(game_raw.decode())
        game = chess.pgn.read_game(stream)
        require(game is not None and not game.errors and chess.pgn.read_game(stream) is None, "invalid or extra PGN game")
        require([move.uci() for move in game.mainline_moves()] == full_moves
                and game.headers.get("Result") == terminal["result"] and game.headers.get("Termination") == terminal["termination"]
                and game.headers.get("ScheduleId") == slot["scheduleId"] and game.headers.get("OpeningId") == slot["openingId"],
                "PGN does not match raw replay")
        records.append(finished)
        total_moves += plies
    require(index == len(ledger) - 1 and pgn_offset == len(payloads["games.pgn"]), "extra raw/PGN events")
    require(payloads["games.jsonl"] == b"".join(encoded(row) for row in records), "normalized record inventory differs from raw evidence")
    require(footer.get("completedGames") == completion.get("games") == len(records)
            and footer.get("completedMoves") == completion.get("moves") == total_moves, "completion counts differ")
    report = frontier.analyze(config, records)
    report["campaignAudit"] = {"schema": SCHEMA + ".audit", "status": "pass", "gamesReplayed": len(records),
                                "movesReplayed": total_moves, "pgnsVerified": len(records), "searchesRerun": 0,
                                "registrationSha256": digest, "completionSha256": sha(completion_raw),
                                "auditorSha256": sha(Path(__file__).read_bytes()), "fullHistoryVerified": True,
                                "javascriptRulesReplayVerified": True, "hostInfo": info}
    report["timing"] = [timing_summary(telemetry[t], t) for t in config["timeControlsMs"]]
    failed_times = [row["timeMs"] for row in report["timing"] if not row["cleanRealizedEqualTime"]]
    report["policy"]["timingAuditFailedTimesMs"] = failed_times
    report["policy"]["candidateConfirmationTimesMs"] = [t for t in report["policy"]["candidateConfirmationTimesMs"] if t not in failed_times]
    if failed_times:
        report["limitations"].insert(0, "Measured equal-time audit failed at " + str(failed_times) + " ms; retain outcomes but do not select these settings.")
        if not report["policy"]["candidateConfirmationTimesMs"]:
            report["policy"]["nextStep"] = "No setting has both a qualifying score interval and a passing measured-time audit; retain HCE and resolve the recorded limits before a new registered comparison."
    if publish:
        write(root / "audit.json", encoded(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    registration = commands.add_parser("register")
    for name in ("config", "openings", "base-wasm", "candidate-wasm", "host", "loader", "rules", "node", "output"):
        registration.add_argument("--" + name, required=True, type=Path)
    registration.add_argument("--source", action="append", default=[], type=Path)
    for name in ("run", "audit"):
        command = commands.add_parser(name)
        command.add_argument("directory", type=Path)
        command.add_argument("--registration-sha256", required=(name == "run"))
    args = parser.parse_args()
    if args.command == "register":
        result = register(args.config, args.openings, args.base_wasm, args.candidate_wasm, args.host,
                          args.loader, args.rules, args.node, args.output, args.source)
    elif args.command == "run":
        result = run(args.directory, args.registration_sha256)
    else:
        report = audit(args.directory, args.registration_sha256)
        result = {"status": report["status"], "games": report["games"], "policy": report["policy"]}
    print(json.dumps(result, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
