#!/usr/bin/env python3
"""Independent raw-ledger, PGN, JavaScript-rules, and paired-outcome audit.

This imports no producer code, never loads WASM, and never reruns a search.
Its statistics are produced only after every scheduled game passes replay.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import io
import json
import math
import os
from pathlib import Path
import statistics
import subprocess

import chess.pgn
import numpy as np
from scipy.stats import t as student_t


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError("duplicate JSON key in evidence")
        value[key] = item
    return value


def decoded(raw):
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite evidence")))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def bound(root, binding):
    name = Path(binding["path"])
    require(not name.is_absolute() and ".." not in name.parts, "bound path escape")
    raw = (Path(root) / name).read_bytes()
    require(len(raw) == binding["bytes"] and sha(raw) == binding["sha256"], "retained file hash/size mismatch")
    return raw


def intervals(values, groups):
    """Endpoint-weighted pair interval and coarser cluster-robust sensitivity."""
    values = np.asarray(values, dtype=np.float64)
    n = len(values)
    require(n >= 2 and len(groups) == n and np.all((0 <= values) & (values <= 1)), "invalid paired scores")
    mean = float(np.mean(values))
    se = float(np.std(values, ddof=1) / math.sqrt(n))
    radius = float(student_t.ppf(.975, n - 1)) * se
    totals = defaultdict(float)
    counts = Counter(groups)
    for value, group in zip(values, groups):
        totals[group] += float(value) - mean
    g = len(totals)
    sensitivity = {"groups": g, "largestGroup": max(counts.values()), "mean": mean,
                   "standardError": None, "interval95": None}
    if g > 1:
        cluster_se = math.sqrt(g / (g - 1) * sum(value * value for value in totals.values()) / (n * n))
        cluster_radius = float(student_t.ppf(.975, g - 1)) * cluster_se
        sensitivity.update(standardError=cluster_se,
                           interval95=[max(0., mean - cluster_radius), min(1., mean + cluster_radius)])
    return {"pairs": n, "mean": mean, "standardError": se,
            "interval95": [max(0., mean - radius), min(1., mean + radius)],
            "coarseOpeningSensitivity": sensitivity, "formalAdmission": False,
            "scope": "descriptive development intervals; structural grouping does not prove statistical independence"}


def telemetry(rows):
    require(bool(rows), "missing engine telemetry")
    elapsed = np.array([row["elapsed_ns"] / 1e6 for row in rows])
    wall = np.array([row["wallNs"] / 1e6 for row in rows])
    return {"searches": len(rows), "nodes": sum(row["nodes"] for row in rows),
            "qnodes": sum(row["qnodes"] for row in rows),
            "meanDepth": statistics.mean(row["depth"] for row in rows),
            "medianDepth": statistics.median(row["depth"] for row in rows),
            "wasmSearchSeconds": float(elapsed.sum() / 1000), "requestWallSeconds": float(wall.sum() / 1000),
            "medianSearchMs": float(np.median(elapsed)), "p99SearchMs": float(np.quantile(elapsed, .99)),
            "medianRequestWallMs": float(np.median(wall)), "p99RequestWallMs": float(np.quantile(wall, .99)),
            "stopReasons": dict(Counter(row["stop_reason"] for row in rows))}


def search_contract(response, profile, max_depth):
    # Independent validation, deliberately not importing the runner's reducer.
    for name in ("nodes", "qnodes", "cutoffs", "researches", "depth", "score", "elapsed_ns"):
        require(type(response.get(name)) is int, "noninteger search field: " + name)
    require(0 < response["nodes"] < 2 ** 53 and 0 <= response["qnodes"] <= response["nodes"], "bad search node accounting")
    require(0 <= response["depth"] <= max_depth and response["elapsed_ns"] > 0, "bad search depth/time")
    require(response.get("scorePov") == "white" and response.get("verifiedFen") is True, "unverified FEN/POV")
    require(response.get("tt_saturated") is not True, "saturated search")
    reason = response["stop_reason"]
    require(reason in ("max_depth", "mate", "node_limit" if profile["nodeLimit"] else "time_limit"), "wrong stop reason")
    if profile["nodeLimit"]:
        require(response["nodes"] <= profile["nodeLimit"], "node limit exceeded")
        if reason == "node_limit":
            require(response["nodes"] == profile["nodeLimit"], "node-limit stop does not consume budget")
    attempted = response.get("attempted_depth")
    require(attempted is None or type(attempted) is int and response["depth"] < attempted <= max_depth, "bad attempted depth")
    if reason in ("max_depth", "mate"):
        require(attempted is None, "completed search has incomplete iteration")
    if reason == "max_depth":
        require(response["depth"] == max_depth, "maximum depth was not reached")
    if reason == "mate":
        require(response["depth"] > 0 and 999000 <= abs(response["score"]) <= 1000000, "invalid mate stop")


def audit(registration_path, expected_sha, campaign_path, output):
    registration_path, campaign_path, output = map(Path, (registration_path, campaign_path, output))
    root, campaign = registration_path.parent, campaign_path.parent
    registration_raw, completion_raw = registration_path.read_bytes(), campaign_path.read_bytes()
    require(sha(registration_raw) == expected_sha, "external registration hash differs")
    registration, completion = decoded(registration_raw), decoded(completion_raw)
    require(registration["status"] == "frozen-before-games" and completion["status"] == "complete-sealed-before-audit", "incomplete campaign")
    require(completion["registrationSha256"] == expected_sha, "completion registration differs")
    for binding in registration["files"].values():
        bound(root, binding)
    require(sha(Path(__file__).read_bytes()) == registration["files"]["implementation/audit_games.py"]["sha256"], "auditor code changed")
    require(sha((campaign / "registration.json").read_bytes()) == expected_sha, "campaign's retained registration differs")
    openings = [decoded(line) for line in bound(root, registration["files"]["openings.jsonl"]).splitlines()]
    config, schedule = registration["config"], registration["schedule"]
    require(registration.get("nodeArguments") == ["--no-liftoff", "--no-wasm-lazy-compilation"], "game runtime tier differs from cost selection")
    require(len(openings) == 64 and len(schedule) in (256, 384), "partial bank/schedule")
    declared_profiles = config["mandatoryProfiles"] + ([config["optionalProfile"]] if "pruned" in registration["models"] else [])
    reconstructed = []
    for profile in declared_profiles:
        for opening in openings:
            colors = ["white", "black"] if opening["index"] % 2 == 0 else ["black", "white"]
            for color in colors:
                reconstructed.append(dict(profile, index=len(reconstructed), openingIndex=opening["index"],
                                          candidateColor=color, rootSeed=0,
                                          gameId=f"{profile['id']}-{opening['index']:03d}-{color}"))
    require(schedule == reconstructed and completion["games"] == len(schedule), "schedule not complete or order changed")
    require(completion.get("returncodes") == {model: 0 for model in registration["models"]}, "unsuccessful backend exit")
    require(set(completion.get("stderr", {})) == set(registration["models"]), "missing backend stderr inventory")
    for model, binding in completion["stderr"].items():
        stderr_path = Path(binding["path"])
        require(stderr_path.resolve() == (campaign / (model + ".stderr")).resolve(), "unexpected stderr path")
        stderr_raw = stderr_path.read_bytes()
        require(len(stderr_raw) == binding["bytes"] and sha(stderr_raw) == binding["sha256"], "stderr binding differs")
    raw = bound(campaign, completion["raw"])
    pgn_raw = bound(campaign, completion["pgn"])
    require(raw.endswith(b"\n"), "truncated raw ledger")
    digest = hashlib.sha256()
    prefix_bytes = 0
    warmups, ready = defaultdict(list), {}
    game_rows, current, history = [], None, None
    telemetry_rows = defaultdict(lambda: defaultdict(list))
    raw_rows = move_rows = 0
    for line in raw.splitlines(keepends=True):
        row = decoded(line)
        require(encoded(row) == line, "noncanonical raw row")
        kind = row.get("type")
        if raw_rows == 0:
            require(kind == "header" and row["registrationSha256"] == expected_sha and row["scheduledGames"] == len(schedule), "bad ledger header")
        elif kind == "footer":
            require(row["prefixSha256"] == digest.hexdigest() and row["prefixBytes"] == prefix_bytes, "ledger prefix authentication failed")
            require(row["completedGames"] == len(schedule) and row["completedMoves"] == move_rows, "footer counts differ")
            require(row["registrationSha256"] == expected_sha and current is None, "footer not after complete games")
            require(row.get("returncodes") == completion["returncodes"], "footer process exits differ")
            require(prefix_bytes + len(line) == len(raw), "trailing rows after completion")
        elif kind in ("ready", "warmup", "move"):
            request, response_raw = row["request"], row["response"].encode()
            require(row["requestSha256"] == sha(request.encode() + b"\n") and row["responseSha256"] == sha(response_raw), "raw exchange digest differs")
            require(type(row["wallNs"]) is int and row["wallNs"] > 0, "invalid request wall time")
            response = decoded(response_raw)
            require(response["id"] == row["requestId"], "response/request identity mismatch")
            model = row["model"]
            require(model in registration["models"], "unknown response model")
            if kind == "ready":
                require(not game_rows and current is None and model not in ready, "late or duplicate ready handshake")
                require(request == "INFO\t" + row["requestId"], "wrong readiness request")
                for key, expected in (("mode", "ready"), ("moduleSha256", registration["files"][f"backend/{model}.wasm"]["sha256"]),
                                      ("weightsSha256", registration["files"][f"backend/{model}.i16le"]["sha256"]),
                                      ("rulesSha256", registration["files"]["backend/rules.js"]["sha256"]),
                                      ("variant", registration["modelSettings"][model]["variant"]),
                                      ("nodeArguments", registration["nodeArguments"])):
                    require(response.get(key) == expected, "ready handshake content differs")
                ready[model] = response
            elif kind == "warmup":
                require(not game_rows and current is None and model in ready, "warmup after games or before ready")
                fields = request.split("\t")
                require(len(fields) == 10 and fields[:2] == ["SEARCH", row["requestId"]], "malformed warmup")
                require(fields[3:7] == ["10000", "0", "30", "0"] and fields[7] == fields[8] == row["fen"] and fields[9] == "", "warmup budget/history differs")
                search_contract(response, {"nodeLimit": 10000, "timeMs": 0}, 30)
                warmups[model].append((row["requestId"], row["mode"], row["fen"]))
            else:
                require(current is not None and row["gameId"] == current["entry"]["gameId"] and row["model"] == current["entry"]["model"], "move outside its scheduled game")
                require(row["ply"] == len(current["moves"]), "missing or repeated move")
                entry = current["entry"]
                expected_fields = ["SEARCH", row["requestId"], row["mode"], str(entry["nodeLimit"]), str(entry["timeMs"]),
                                   str(config["maxDepth"]), "0", chess.STARTING_FEN, row["fen"], " ".join(history)]
                require(request.split("\t") == expected_fields and row["historySha256"] == sha(encoded(history)), "full move history/budget mismatch")
                require(row["requestId"] == f"{entry['gameId']}-{row['ply']}", "noncanonical game request ID")
                search_contract(response, entry, config["maxDepth"])
                current["moves"].append({"fen": row["fen"], "move": response["move"], "mode": row["mode"]})
                history.append(response["move"])
                telemetry_rows[entry["id"]][row["mode"]].append(dict(response, wallNs=row["wallNs"]))
                move_rows += 1
        elif kind == "start":
            require(current is None and len(game_rows) < len(schedule), "overlapping or extra game")
            entry = schedule[len(game_rows)]
            opening = openings[entry["openingIndex"]]
            require(row["game"] == entry and row["fen"] == opening["fen"] and row["sourceGameId"] == opening["sourceGameId"], "game start identity differs")
            history = list(opening["prefixUci"])
            require(row["prefixSha256"] == sha(encoded(history)), "opening history hash differs")
            current = {"entry": entry, "moves": []}
        elif kind == "end":
            require(current is not None and row["gameId"] == current["entry"]["gameId"], "ending outside game")
            require(row["plies"] == len(current["moves"]) and row["fullHistorySha256"] == sha(encoded(history)), "ending history/count differs")
            current.update(ending=row, fullHistory=list(history))
            game_rows.append(current)
            current = None
        else:
            raise ValueError("unexpected/failure raw record: " + str(kind))
        digest.update(line)
        prefix_bytes += len(line)
        raw_rows += 1
    require(current is None and len(game_rows) == len(schedule) and raw_rows == completion["raw"]["rows"], "incomplete games/ledger")
    require(decoded(raw.splitlines()[-1])["type"] == "footer", "completion footer missing")
    require(move_rows == completion["moves"], "completion move count differs")
    for model in registration["models"]:
        expected_warmups = []
        for cycle in range(4):
            modes = ["hce", "candidate"] if cycle % 2 == 0 else ["candidate", "hce"]
            for index, fen in enumerate(config["warmup"]["fens"]):
                for mode in modes:
                    expected_warmups.append((f"{model}-warmup-{cycle}-{index}-{mode}", mode, fen))
        require(warmups[model] == expected_warmups and model in ready, "complete prescribed warmup missing")
    # Check exported PGNs independently of the producer's exporter and ledger.
    stream = io.StringIO(pgn_raw.decode())
    offset = 0
    for game in game_rows:
        ending = game["ending"]
        chunk = pgn_raw[offset:offset + ending["pgnBytes"]]
        require(sha(chunk) == ending["pgnSha256"], "per-game PGN byte binding differs")
        offset += len(chunk)
        parsed = chess.pgn.read_game(stream)
        require(parsed is not None and not parsed.errors, "missing or invalid PGN")
        require([move.uci() for move in parsed.mainline_moves()] == game["fullHistory"], "PGN move history differs")
        require(parsed.headers["Result"] == ending["result"] and parsed.headers["GameId"] == game["entry"]["gameId"], "PGN ending/identity differs")
    require(offset == len(pgn_raw) and chess.pgn.read_game(stream) is None, "extra PGN games or bytes")
    # Second chess implementation: JavaScript rules replay, never engine search.
    rules_binding = registration["files"]["backend/rules.js"]
    replay_input = []
    for game in game_rows:
        entry, opening = game["entry"], openings[game["entry"]["openingIndex"]]
        replay_input.append({"gameId": entry["gameId"], "initialFen": chess.STARTING_FEN,
                             "prefixUci": opening["prefixUci"], "rootFen": opening["fen"],
                             "candidateColor": entry["candidateColor"], "cap": config["postOpeningPlyCap"],
                             "moves": game["moves"]})
    executable = registration["executable"]
    executable_fd = os.open(executable["path"], os.O_RDONLY)
    try:
        with os.fdopen(os.dup(executable_fd), "rb") as retained_executable:
            executable_bytes = retained_executable.read()
        require(sha(executable_bytes) == executable["sha256"] and len(executable_bytes) == executable["bytes"], "Node identity changed before replay")
        command = [f"/proc/self/fd/{executable_fd}", str(root / "implementation/audit_rules.js"),
                   str(root / rules_binding["path"]), rules_binding["sha256"]]
        replay = subprocess.run(command, input=b"".join(encoded(row) for row in replay_input), capture_output=True,
                                pass_fds=(executable_fd,), env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""}, timeout=300)
    finally:
        os.close(executable_fd)
    require(replay.returncode == 0, "independent JavaScript replay failed: " + replay.stderr.decode()[:1000])
    replay_rows = [decoded(line) for line in replay.stdout.splitlines()]
    require(len(replay_rows) == len(game_rows), "independent replay inventory differs")
    points_by_profile, records = defaultdict(list), []
    for game, replayed in zip(game_rows, replay_rows):
        ending = game["ending"]
        require(all(replayed[key] == ending[key] for key in ("gameId", "plies", "fen", "result", "reason")), "independently reconstructed outcome differs")
        entry = game["entry"]
        points = .5 if replayed["result"] == "1/2-1/2" else float((replayed["result"] == "1-0") == (entry["candidateColor"] == "white"))
        record = {**entry, "candidatePoints": points, "result": replayed["result"], "reason": replayed["reason"], "plies": replayed["plies"]}
        records.append(record)
        points_by_profile[entry["id"]].append(record)
    summaries = []
    for profile in declared_profiles:
        games = points_by_profile[profile["id"]]
        require(len(games) == 128, "partial comparison profile")
        by_opening = defaultdict(list)
        for game in games:
            by_opening[game["openingIndex"]].append(game)
        require(sorted(by_opening) == list(range(64)), "missing opening pair")
        means = []
        for index in range(64):
            pair = by_opening[index]
            require(len(pair) == 2 and {game["candidateColor"] for game in pair} == {"white", "black"}, "incomplete color reversal")
            means.append(sum(game["candidatePoints"] for game in pair) / 2)
        uncertainty = intervals(means, [row["ply4Family"] for row in openings])
        summary = {**profile, "games": 128, "openings": 64,
                   "wins": sum(game["candidatePoints"] == 1 for game in games),
                   "draws": sum(game["candidatePoints"] == .5 for game in games),
                   "losses": sum(game["candidatePoints"] == 0 for game in games),
                   "points": sum(game["candidatePoints"] for game in games),
                   "pairScoreHistogram": {str(value): means.count(value) for value in (0., .25, .5, .75, 1.)},
                   "uncertainty": uncertainty, "terminationCounts": dict(Counter(game["reason"] for game in games)),
                   "meanSearchedPlies": statistics.mean(game["plies"] for game in games),
                   "telemetry": {mode: telemetry(telemetry_rows[profile["id"]][mode]) for mode in ("hce", "candidate")}}
        if profile["timeMs"]:
            timings = {}
            for mode in ("hce", "candidate"):
                values = [row["elapsed_ns"] / 1e6 for row in telemetry_rows[profile["id"]][mode] if row["stop_reason"] == "time_limit"]
                timings[mode] = {"timeLimitStops": len(values), "medianMs": float(np.median(values)) if values else None,
                                 "p99Ms": float(np.quantile(values, .99)) if values else None}
            ratio = timings["candidate"]["medianMs"] / timings["hce"]["medianMs"] if all(timings[mode]["timeLimitStops"] for mode in timings) else None
            clean = ratio is not None and .9 <= ratio <= 1.1 and all(value["p99Ms"] <= 2 * profile["timeMs"] for value in timings.values())
            summary["timeBudgetAudit"] = {"requestedMs": profile["timeMs"], "timeLimitStops": timings,
                                          "medianCandidateOverHce": ratio, "cleanRealizedEqualTime": bool(clean),
                                          "noTimingRetry": True}
        summaries.append(summary)
    output.mkdir(parents=True, exist_ok=False)
    def save(name, raw):
        with (output / name).open("xb") as target:
            target.write(raw); target.flush(); os.fsync(target.fileno())
        return {"path": name, "sha256": sha(raw), "bytes": len(raw)}
    record_binding = save("games.jsonl", b"".join(encoded(row) for row in records))
    replay_binding = save("independent-rules-replay.jsonl", replay.stdout)
    result = {"schema": "chessy.sparse-games.v2.audit", "status": "pass", "researchOnly": True, "formalPass": False,
              "registrationSha256": expected_sha, "completionManifestSha256": sha(completion_raw),
              "auditorSha256": sha(Path(__file__).read_bytes()),
              "independentRulesAuditSha256": registration["files"]["implementation/audit_rules.js"]["sha256"],
              "rulesSha256": rules_binding["sha256"], "allGamesReplayed": len(game_rows), "allMovesVerified": move_rows,
              "allPGNsVerified": len(game_rows), "searchesRerun": 0, "warmupRequestsPerModel": 32,
              "profiles": summaries, "gameRecords": record_binding, "independentRulesReplay": replay_binding,
              "limitations": ["development screen; no formal promotion or Elo estimate",
                              "unique structural families do not prove independence of named opening systems",
                              "same requested deadline is qualified by the reported realized-time audit",
                              "WASM in Node on this host, not browser/device thermal or battery evidence",
                              "wall-time search decisions are not deterministic despite fixed legacy root order"]}
    save("results.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser()
    for key in ("registration", "registration-sha256", "campaign", "output"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    result = audit(args.registration, args.registration_sha256, args.campaign, args.output)
    print(json.dumps({"status": result["status"], "games": result["allGamesReplayed"], "profiles": result["profiles"]}, sort_keys=True))


if __name__ == "__main__":
    main()
