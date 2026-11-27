#!/usr/bin/env python3
"""Register and execute one complete, sealed sparse-v2 paired WASM screen.

No summary is computed here. Independent replay and statistics run only after
the complete append-only ledger and PGNs have been closed and authenticated.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import re
import subprocess
import sys
import threading
import time

import chess
import chess.pgn

SCHEMA = "chessy.sparse-games.v2"
NODE_ARGUMENTS = ["--no-liftoff", "--no-wasm-lazy-compilation"]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def unique_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def write(path, raw):
    path = Path(path)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": path.name, "sha256": sha(raw), "bytes": len(raw)}


def bound(root, binding):
    name = binding["path"]
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("binding escapes retained directory")
    path = Path(root) / relative
    if path.is_symlink():
        raise ValueError("retained binding cannot be a symlink")
    raw = path.read_bytes()
    if len(raw) != binding["bytes"] or sha(raw) != binding["sha256"]:
        raise ValueError("retained bytes differ: " + name)
    return raw


def identity(path):
    path = Path(path).resolve()
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": sha(raw)}


def validate_config(config):
    expected = {"schema": "chessy.sparse-game-config.v2", "researchOnly": True,
                "formalPass": False, "openingPairs": 64, "candidateColors": ["white", "black"],
                "maxDepth": 30, "postOpeningPlyCap": 180, "rootSeed": 0,
                "scoreAdjudication": False, "resignation": False,
                "completeHistoryRequired": True, "resultsSealedUntilComplete": True,
                "timeoutPerRequestSeconds": 10, "timeoutWholeCampaignSeconds": 3600,
                "mandatoryProfiles": [{"id": "full-time", "model": "full", "timeMs": 25, "nodeLimit": 0},
                                      {"id": "full-nodes", "model": "full", "timeMs": 0, "nodeLimit": 10000}],
                "optionalProfile": {"id": "pruned-time", "model": "pruned", "timeMs": 25, "nodeLimit": 0}}
    if any(config.get(key) != value for key, value in expected.items()):
        raise ValueError("game configuration differs from the prospectively declared protocol")
    warmup = config.get("warmup", {})
    if warmup.get("cycles") != 4 or warmup.get("nodeLimit") != 10000 or warmup.get("timeMs") != 0 \
            or warmup.get("modes") != ["hce", "candidate"] or len(warmup.get("fens", [])) != 4 \
            or warmup.get("requestsPerModelProcess") != 32:
        raise ValueError("fixed identical warmup required")
    for fen in warmup["fens"]:
        board = chess.Board(fen)
        if not board.is_valid() or terminal(board, 0, 180):
            raise ValueError("illegal or terminal warmup position")


def terminal(board, plies, cap):
    """Current-position rules, with real endings taking precedence at the cap."""
    if board.is_checkmate():
        return {"result": "0-1" if board.turn else "1-0", "reason": "checkmate"}
    if board.is_stalemate():
        return {"result": "1/2-1/2", "reason": "stalemate"}
    if board.halfmove_clock >= 100:
        return {"result": "1/2-1/2", "reason": "current-fifty-move"}
    if board.is_insufficient_material():
        return {"result": "1/2-1/2", "reason": "insufficient-material"}
    if board.is_repetition(3):
        return {"result": "1/2-1/2", "reason": "current-threefold"}
    if plies >= cap:
        return {"result": "1/2-1/2", "reason": "ply-cap"}
    return None


def initial_board(opening):
    board = chess.Board()
    moves = opening["prefixUci"]
    if not isinstance(moves, list) or len(moves) != opening["selectedPly"]:
        raise ValueError("incomplete opening prefix")
    for token in moves:
        move = chess.Move.from_uci(token)
        if move not in board.legal_moves:
            raise ValueError("illegal opening prefix")
        board.push(move)
    if board.fen(en_passant="fen") != opening["fen"] or not board.is_valid() or terminal(board, 0, 180):
        raise ValueError("opening root mismatch or terminal state")
    return board


def schedule(config, openings, model_ids):
    if model_ids not in (["full"], ["full", "pruned"]):
        raise ValueError("only full and one prospectively selected pruned model are allowed")
    profiles = list(config["mandatoryProfiles"])
    if "pruned" in model_ids:
        profiles.append(config["optionalProfile"])
    output = []
    for profile in profiles:
        for opening in openings:
            colors = ["white", "black"] if opening["index"] % 2 == 0 else ["black", "white"]
            for color in colors:
                index = len(output)
                output.append(dict(profile, index=index, openingIndex=opening["index"],
                                   candidateColor=color, rootSeed=0,
                                   gameId=f"{profile['id']}-{opening['index']:03d}-{color}"))
    return output


def register(bank_path, backend_path, config_path, output):
    bank_path, backend_path, config_path, output = map(Path, (bank_path, backend_path, config_path, output))
    bank_raw, backend_raw, config_raw = bank_path.read_bytes(), backend_path.read_bytes(), config_path.read_bytes()
    bank, backend, config = decode(bank_raw), decode(backend_raw), decode(config_raw)
    validate_config(config)
    if bank.get("schema") != "chessy.sparse-game-bank.v2" or bank.get("status") != "complete-unlabelled-development-only" \
            or bank.get("selectedRoots") != 64 or len(bank.get("files", [])) != 1:
        raise ValueError("complete fresh opening bank required")
    opening_raw = bound(bank_path.parent, bank["files"][0])
    openings = [decode(line) for line in opening_raw.splitlines()]
    if len(openings) != 64 or [row["index"] for row in openings] != list(range(64)):
        raise ValueError("complete ordered 64-opening bank required")
    for key in ("sourceGameId", "rootFamily", "rootCluster", "ply8Family"):
        if len({row[key] for row in openings}) != 64:
            raise ValueError("duplicate opening grouping key: " + key)
    for row in openings:
        initial_board(row)
    if backend.get("kind") != "wasm" or backend.get("variant") not in ("compact", "fused", "cached"):
        raise ValueError("frozen research WASM implementation required")
    if backend.get("nodeArguments") != NODE_ARGUMENTS:
        raise ValueError("cost-selection and game runtime must use the same frozen optimized Node tier")
    model_ids = [row["id"] for row in backend["models"]]
    games = schedule(config, openings, model_ids)
    if len(games) not in (256, 384):
        raise ValueError("incomplete scheduled comparison")
    # Materialize the exact bytes before writing the exclusive registration.
    retained = {"backend/wasm_runner.mjs": Path(backend["adapter"]).read_bytes(),
                "backend/rules.js": Path(backend["rules"]).read_bytes(),
                "build-receipt.json": Path(backend["buildReceipt"]).read_bytes(),
                "selection-receipt.json": Path(backend["selectionReceipt"]).read_bytes(),
                "bank-manifest.json": bank_raw, "openings.jsonl": opening_raw,
                "backend-request.json": backend_raw, "config.json": config_raw}
    model_settings = {}
    for model in backend["models"]:
        raw = Path(model["weights"]).read_bytes()
        if len(raw) != 17280 * 2:
            raise ValueError("dense frozen 17280-coefficient model required")
        retained["backend/" + model["id"] + ".i16le"] = raw
        retained["backend/" + model["id"] + ".wasm"] = Path(model.get("module", backend.get("module"))).read_bytes()
        variant = model.get("variant", backend["variant"])
        if variant != backend["variant"]:
            raise ValueError("optional model must use the frozen full-model runtime variant")
        model_settings[model["id"]] = {"variant": variant}
    for name in ("games.py", "audit_games.py", "audit_rules.js"):
        retained["implementation/" + name] = Path(__file__).with_name(name).read_bytes()
    selection = decode(retained["selection-receipt.json"])
    if selection.get("status") != "frozen-before-games" or selection.get("gameOutcomesUsed") is not False:
        raise ValueError("candidate and implementation selection must be sealed before games")
    if selection.get("modelIds") != model_ids or set(selection.get("models", {})) != set(model_ids):
        raise ValueError("candidate list differs from selection receipt")
    for model in model_ids:
        expected_model = {"moduleSha256": sha(retained["backend/" + model + ".wasm"]),
                          "weightsSha256": sha(retained["backend/" + model + ".i16le"]),
                          "variant": model_settings[model]["variant"]}
        if any(selection["models"][model].get(key) != value for key, value in expected_model.items()):
            raise ValueError("selected model module/weights/variant differ")
    executable = identity(backend["executable"])
    if not os.access(executable["path"], os.X_OK):
        raise ValueError("Node executable is not executable")
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for name, raw in retained.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        binding = write(target, raw)
        binding["path"] = name
        files[name] = binding
        target.chmod(0o444)
    registration = {"schema": SCHEMA + ".registration", "status": "frozen-before-games", "researchOnly": True,
                    "formalPass": False, "createdAt": datetime.now(timezone.utc).isoformat(),
                    "config": config, "configSha256": sha(config_raw), "bankManifestSha256": sha(bank_raw),
                    "models": model_ids, "modelSettings": model_settings, "variant": backend["variant"], "kind": "wasm",
                    "nodeArguments": list(NODE_ARGUMENTS),
                    "schedule": games, "files": files, "executable": executable,
                    "python": sys.version, "pythonExecutable": identity(sys.executable),
                    "pythonChess": chess.__version__,
                    "pythonChessSources": [identity(chess.__file__), identity(chess.pgn.__file__)],
                    "platform": platform.platform(), "machine": platform.machine(),
                    "cpuAffinityAvailable": sorted(os.sched_getaffinity(0)),
                    "selectedCpu": min(os.sched_getaffinity(0)),
                    "resultAccess": "no outcome aggregation until all declared profiles and games complete"}
    raw = encoded(registration)
    write(output / "manifest.json", raw)
    for directory in (output / "backend", output / "implementation", output):
        directory.chmod(0o555)
    return {"registrationSha256": sha(raw), "scheduledGames": len(games), "models": model_ids,
            "manifest": str(output / "manifest.json")}


def integer(value, minimum, maximum, name):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("invalid search field: " + name)


def validate_response(response, request_id, nodes, time_ms, max_depth):
    if response.get("id") != request_id or response.get("verifiedFen") is not True or response.get("scorePov") != "white":
        raise ValueError("request/FEN/score perspective mismatch")
    for key in ("nodes", "qnodes", "cutoffs", "researches"):
        integer(response.get(key), 0, (1 << 53) - 1, key)
    integer(response["depth"], 0, max_depth, "depth")
    integer(response["score"], -(1 << 31), (1 << 31) - 1, "score")
    integer(response["elapsed_ns"], 1, (1 << 53) - 1, "elapsed_ns")
    if response["nodes"] <= 0 or response["qnodes"] > response["nodes"] or response.get("tt_saturated") is True:
        raise ValueError("invalid node accounting or saturated TT")
    if not isinstance(response.get("move"), str) or not re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", response["move"]):
        raise ValueError("search did not return a UCI move")
    reason = response.get("stop_reason")
    allowed = {"max_depth", "mate", "node_limit" if nodes else "time_limit"}
    if reason not in allowed:
        raise ValueError("invalid stop reason for declared budget")
    if nodes and (response["nodes"] > nodes or reason == "node_limit" and response["nodes"] != nodes):
        raise ValueError("node budget violated")
    attempted = response.get("attempted_depth")
    if attempted is not None:
        integer(attempted, response["depth"] + 1, max_depth, "attempted_depth")
    if reason in ("mate", "max_depth") and attempted is not None:
        raise ValueError("completed search has interrupted depth")
    if reason == "max_depth" and response["depth"] != max_depth:
        raise ValueError("depth ceiling not actually reached")
    if reason == "mate" and not (response["depth"] > 0 and 999000 <= abs(response["score"]) <= 1000000):
        raise ValueError("mate stop lacks a completed mate score")
    return response


def request_text(request_id, mode, nodes, time_ms, depth, initial_fen, final_fen, history):
    fields = ["SEARCH", request_id, mode, str(nodes), str(time_ms), str(depth), "0",
              initial_fen, final_fen, " ".join(history)]
    if any("\t" in value or "\n" in value or "\r" in value for value in fields):
        raise ValueError("request delimiter in field")
    return "\t".join(fields)


class Backend:
    def __init__(self, registration, root, model, output):
        self.registration = registration
        self.root, self.model = Path(root), model
        self.queue = queue.Queue()
        self.closed = False
        executable = registration["executable"]
        self.fd = os.open(executable["path"], os.O_RDONLY)
        raw = b""
        with os.fdopen(os.dup(self.fd), "rb") as retained:
            raw = retained.read()
        if sha(raw) != executable["sha256"] or len(raw) != executable["bytes"]:
            os.close(self.fd)
            raise ValueError("Node executable changed after registration")
        if registration.get("nodeArguments") != NODE_ARGUMENTS:
            raise ValueError("registered Node execution tier differs")
        args = [f"/proc/self/fd/{self.fd}", *registration["nodeArguments"], str(self.root / "backend/wasm_runner.mjs"), "serve",
                str(self.root / f"backend/{model}.wasm"), str(self.root / f"backend/{model}.i16le"),
                registration["modelSettings"][model]["variant"], str(self.root / "backend/rules.js")]
        self.stderr_path = Path(output) / (model + ".stderr")
        self.stderr = self.stderr_path.open("xb")
        cpu = registration["selectedCpu"]
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, pass_fds=(self.fd,),
                                        preexec_fn=lambda: os.sched_setaffinity(0, {cpu}),
                                        env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""})

        def reader():
            while True:
                line = self.process.stdout.readline(1 << 20)
                self.queue.put(line)
                if not line:
                    return
        self.thread = threading.Thread(target=reader, daemon=True)
        self.thread.start()

    def request(self, text):
        started = time.perf_counter_ns()
        self.process.stdin.write(text.encode() + b"\n")
        self.process.stdin.flush()
        try:
            raw = self.queue.get(timeout=self.registration["config"]["timeoutPerRequestSeconds"])
        except queue.Empty as error:
            raise TimeoutError("persistent WASM request exceeded frozen watchdog") from error
        elapsed = time.perf_counter_ns() - started
        if not raw or not raw.endswith(b"\n"):
            raise ValueError("missing or oversized WASM response")
        return raw, elapsed

    def close(self):
        if self.closed:
            return self.process.returncode
        self.closed = True
        if self.process.stdin and not self.process.stdin.closed:
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

    def sync(self):
        os.fsync(self.stream.fileno())

    def close(self):
        self.sync()
        self.stream.close()
        return {"path": self.path.name, "bytes": self.size, "rows": self.rows, "sha256": self.digest.hexdigest()}


def pgn_bytes(entry, opening, history, ending, date):
    game = chess.pgn.Game()
    game.headers.update({"Event": "Sparse PeSTO v2 development", "Site": "local research WASM",
                         "Date": date, "Round": str(entry["index"] + 1),
                         "White": entry["model"] if entry["candidateColor"] == "white" else "HCE",
                         "Black": entry["model"] if entry["candidateColor"] == "black" else "HCE",
                         "Result": ending["result"], "Termination": ending["reason"],
                         "OpeningId": str(opening["index"]), "SourceGameId": opening["sourceGameId"],
                         "GameId": entry["gameId"], "RootSeed": "0", "TimeControl": "?",
                         "SearchLimit": f"{entry['timeMs']}ms/move" if entry["timeMs"] else f"{entry['nodeLimit']}nodes/move"})
    node = game
    for token in history:
        node = node.add_variation(chess.Move.from_uci(token))
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
    return (game.accept(exporter) + "\n\n").encode()


def run(registration_path, expected_sha, output):
    registration_path, output = Path(registration_path), Path(output)
    root = registration_path.parent
    registration_raw = registration_path.read_bytes()
    if sha(registration_raw) != expected_sha:
        raise ValueError("registration differs from external pre-game digest")
    registration = decode(registration_raw)
    if registration.get("schema") != SCHEMA + ".registration" or registration.get("status") != "frozen-before-games":
        raise ValueError("unregistered game campaign")
    config = registration["config"]
    validate_config(config)
    for binding in registration["files"].values():
        bound(root, binding)
    if sha(Path(__file__).read_bytes()) != registration["files"]["implementation/games.py"]["sha256"]:
        raise ValueError("runner differs from immutable registered implementation")
    for binding in registration["pythonChessSources"]:
        raw = Path(binding["path"]).read_bytes()
        if len(raw) != binding["bytes"] or sha(raw) != binding["sha256"]:
            raise ValueError("Python rules implementation changed")
    openings = [decode(line) for line in bound(root, registration["files"]["openings.jsonl"]).splitlines()]
    expected_schedule = schedule(config, openings, registration["models"])
    if registration["schedule"] != expected_schedule:
        raise ValueError("registration schedule is incomplete or altered")
    output.mkdir(parents=True, exist_ok=False)
    write(output / "registration.json", registration_raw)
    ledger = Ledger(output / "raw.jsonl")
    pgn = (output / "games.pgn").open("xb")
    pgn_hash, pgn_size = hashlib.sha256(), 0
    processes, returncodes = {}, {}
    started = time.monotonic()
    games_completed = moves_completed = 0
    ledger.emit({"type": "header", "schema": SCHEMA + ".raw", "registrationSha256": expected_sha,
                 "startedAt": datetime.now(timezone.utc).isoformat(), "cpu": registration["selectedCpu"],
                 "affinity": sorted(os.sched_getaffinity(0)), "loadAverage": os.getloadavg(),
                 "scheduledGames": len(expected_schedule), "resultsSealedUntilComplete": True})

    def exchange(model, request, metadata, budget=None):
        if time.monotonic() - started > config["timeoutWholeCampaignSeconds"]:
            raise TimeoutError("whole campaign exceeded preregistered ceiling")
        raw, wall_ns = processes[model].request(request)
        ledger.emit({**metadata, "model": model, "request": request, "requestSha256": sha(request.encode() + b"\n"),
                     "response": raw.decode(), "responseSha256": sha(raw), "wallNs": wall_ns})
        response = decode(raw)
        if budget:
            validate_response(response, metadata["requestId"], *budget)
        return response

    try:
        for model in registration["models"]:
            processes[model] = Backend(registration, root, model, output)
            request_id = model + "-ready"
            response = exchange(model, "INFO\t" + request_id, {"type": "ready", "requestId": request_id})
            required = {"id": request_id, "moduleSha256": registration["files"][f"backend/{model}.wasm"]["sha256"],
                        "weightsSha256": registration["files"][f"backend/{model}.i16le"]["sha256"],
                        "rulesSha256": registration["files"]["backend/rules.js"]["sha256"],
                        "variant": registration["modelSettings"][model]["variant"], "mode": "ready",
                        "nodeArguments": registration["nodeArguments"]}
            if any(response.get(key) != value for key, value in required.items()):
                raise ValueError("WASM ready handshake differs from retained inputs")
            warmup = config["warmup"]
            for cycle in range(warmup["cycles"]):
                modes = warmup["modes"] if cycle % 2 == 0 else list(reversed(warmup["modes"]))
                for index, fen in enumerate(warmup["fens"]):
                    for mode in modes:
                        request_id = f"{model}-warmup-{cycle}-{index}-{mode}"
                        request = request_text(request_id, mode, 10000, 0, config["maxDepth"], fen, fen, [])
                        response = exchange(model, request, {"type": "warmup", "requestId": request_id,
                                            "mode": mode, "fen": fen}, (10000, 0, config["maxDepth"]))
                        if chess.Move.from_uci(response["move"]) not in chess.Board(fen).legal_moves:
                            raise ValueError("illegal warmup response")
        ledger.sync()
        for entry in expected_schedule:
            opening = openings[entry["openingIndex"]]
            board = initial_board(opening)
            history = list(opening["prefixUci"])
            ply = 0
            ledger.emit({"type": "start", "game": entry, "fen": board.fen(en_passant="fen"),
                         "prefixSha256": sha(encoded(history)), "sourceGameId": opening["sourceGameId"]})
            while True:
                ending = terminal(board, ply, config["postOpeningPlyCap"])
                if ending:
                    break
                candidate = (board.turn == chess.WHITE) == (entry["candidateColor"] == "white")
                mode = "candidate" if candidate else "hce"
                request_id = f"{entry['gameId']}-{ply}"
                fen = board.fen(en_passant="fen")
                request = request_text(request_id, mode, entry["nodeLimit"], entry["timeMs"],
                                       config["maxDepth"], chess.STARTING_FEN, fen, history)
                response = exchange(entry["model"], request, {"type": "move", "requestId": request_id,
                                    "gameId": entry["gameId"], "ply": ply, "mode": mode, "fen": fen,
                                    "historySha256": sha(encoded(history))},
                                    (entry["nodeLimit"], entry["timeMs"], config["maxDepth"]))
                move = chess.Move.from_uci(response["move"])
                if move not in board.legal_moves:
                    raise ValueError("illegal game response; entire campaign invalid")
                board.push(move)
                history.append(move.uci())
                ply += 1
                moves_completed += 1
            game_pgn = pgn_bytes(entry, opening, history, ending, datetime.now(timezone.utc).strftime("%Y.%m.%d"))
            pgn.write(game_pgn)
            pgn.flush()
            os.fsync(pgn.fileno())
            pgn_hash.update(game_pgn)
            pgn_size += len(game_pgn)
            ledger.emit({"type": "end", "gameId": entry["gameId"], "plies": ply, **ending,
                         "fen": board.fen(en_passant="fen"), "fullHistorySha256": sha(encoded(history)),
                         "pgnSha256": sha(game_pgn), "pgnBytes": len(game_pgn)})
            ledger.sync()
            games_completed += 1
            # Progress intentionally omits all moves, scores, WDL and model comparison.
            print(json.dumps({"stage": "games", "completed": games_completed, "total": len(expected_schedule),
                              "elapsedSeconds": round(time.monotonic() - started, 1)}), flush=True)
        for model, process in processes.items():
            returncodes[model] = process.close()
        processes.clear()
        if any(returncodes.values()):
            raise ValueError("backend exited unsuccessfully")
        for binding in registration["files"].values():
            bound(root, binding)
        if sha(registration_path.read_bytes()) != expected_sha:
            raise ValueError("registration changed during games")
        ledger.emit({"type": "footer", "completedGames": games_completed, "completedMoves": moves_completed,
                     "prefixSha256": ledger.digest.hexdigest(), "prefixBytes": ledger.size,
                     "registrationSha256": expected_sha, "returncodes": returncodes})
        raw_binding = ledger.close()
        pgn.close()
        result = {"schema": SCHEMA + ".completion", "status": "complete-sealed-before-audit", "researchOnly": True,
                  "formalPass": False, "registrationSha256": expected_sha, "games": games_completed,
                  "moves": moves_completed, "elapsedSeconds": time.monotonic() - started,
                  "completedAt": datetime.now(timezone.utc).isoformat(), "loadAverage": os.getloadavg(),
                  "raw": raw_binding, "pgn": {"path": "games.pgn", "bytes": pgn_size, "sha256": pgn_hash.hexdigest()},
                  "stderr": {model: identity(output / (model + ".stderr")) for model in registration["models"]},
                  "returncodes": returncodes, "outcomeSummaryProduced": False}
        write(output / "manifest.json", encoded(result))
        return {"status": result["status"], "games": games_completed, "moves": moves_completed,
                "manifest": str(output / "manifest.json")}
    except BaseException as error:
        try:
            ledger.emit({"type": "failure", "completedGames": games_completed,
                         "error": type(error).__name__, "message": str(error)})
            ledger.close()
            pgn.flush()
            os.fsync(pgn.fileno())
            pgn.close()
            write(output / "failure.json", encoded({"schema": SCHEMA + ".failure", "status": "invalid-incomplete",
                  "registrationSha256": expected_sha, "completedGames": games_completed,
                  "error": type(error).__name__, "message": str(error), "retryAllowed": False}))
        finally:
            for process in processes.values():
                process.close()
        raise


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    register_parser = commands.add_parser("register")
    for name in ("bank", "backend", "config", "output"):
        register_parser.add_argument("--" + name, required=True)
    run_parser = commands.add_parser("run")
    for name in ("registration", "registration-sha256", "output"):
        run_parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.command == "register":
        result = register(args.bank, args.backend, args.config, args.output)
    else:
        result = run(args.registration, args.registration_sha256, args.output)
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
