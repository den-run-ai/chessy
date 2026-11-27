#!/usr/bin/env python3
"""Freeze and label an independent-source, research-only OOD chess sample.

Selection consumes only source/game/family metadata and full legal histories.
All primary train, validation and holdout families are excluded before any
teacher runs. The teacher is the authenticated official Stockfish 18 executable
with its embedded NNUE weights, one thread, 16 MiB hash, fresh hash/history per
position and 100,000 requested nodes. This is diagnostic data, never a formal
strength or production-admission artifact.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import heapq
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time

import chess

SCHEMA = "chessy.sparse-ood.v1"
PHASE_QUOTAS = {"opening": 1366, "middlegame": 1365, "endgame": 1365}
RULES = {
    "id": SCHEMA,
    "selectedRows": 4096,
    "phaseQuotas": PHASE_QUOTAS,
    "priority": "lowest SHA256(chessy.sparse-ood.v1 NUL sourceGameId) within phase",
    "uniqueGameAndFamily": True,
    "exclusion": "every family and cluster from every primary role",
    "requestedNodes": 100000,
    "minimumDepth": 10,
    "maximumAbsCp": 2000,
    "requireQuietTeacherFirstMove": True,
    "scorePov": "white",
    "labelUse": "frozen-model independent-source diagnostic only; no fit or selection",
}
OPTIONS = {
    "Threads": "1", "Hash": "16", "MultiPV": "1", "Ponder": "false",
    "Skill Level": "20", "UCI_LimitStrength": "false", "UCI_ShowWDL": "true",
    "UCI_Chess960": "false", "SyzygyProbeLimit": "0",
}
OFFICIAL_ENGINE_SHA256 = "6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9"
OFFICIAL_RELEASE_SHA256 = "536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964"


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    with open(path, "xb") as stream:
        stream.write(encoded(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_manifest(path, schema, status):
    path = Path(path)
    raw = path.read_bytes()
    manifest = json.loads(raw)
    if manifest.get("schema") != schema or manifest.get("status") != status:
        raise ValueError("incomplete or unexpected input manifest")
    if manifest.get("researchOnly") is not True or manifest.get("productionFitAllowed") is not False:
        raise ValueError("research-only artifact classification missing")
    return manifest, {"path": str(path), "sha256": digest(raw), "bytes": len(raw)}


def verified_rows(directory, binding):
    """Hash precisely the retained bytes parsed; fail before returning completion."""
    relative = Path(binding["path"])
    if relative.name != str(relative) or relative.is_absolute():
        raise ValueError("input manifest contains a nonlocal path")
    path = Path(directory) / relative
    h, size, rows = hashlib.sha256(), 0, 0
    with open(path, "rb") as stream:
        identity = os.fstat(stream.fileno())
        for raw in stream:
            if not raw.endswith(b"\n"):
                raise ValueError("input has an incomplete JSON line")
            h.update(raw)
            size += len(raw)
            rows += 1
            yield json.loads(raw)
        current = os.fstat(stream.fileno())
        visible = os.stat(path)
        if (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns) != \
                (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) \
                or (visible.st_dev, visible.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("input changed during consumption")
    if (h.hexdigest(), size, rows) != (binding["sha256"], binding["bytes"], binding["rows"]):
        raise ValueError("input inventory mismatch")


def history_board(row):
    moves = row.get("prefixUci")
    if not isinstance(moves, list) or len(moves) != row.get("selectedPly"):
        raise ValueError("missing complete selected game prefix")
    board = chess.Board()
    for token in moves:
        move = chess.Move.from_uci(token)
        if move not in board.legal_moves:
            raise ValueError("illegal game prefix")
        board.push(move)
    if board.fen(en_passant="fen") != row["fen"]:
        raise ValueError("prefix does not reproduce the exact six-field FEN")
    if not board.is_valid() or board.is_check() or board.is_game_over(claim_draw=False):
        raise ValueError("invalid, checked or terminal selected root")
    return board


def select_rows(natural_manifest, primary_manifest, output):
    natural_path, primary_path, output = Path(natural_manifest), Path(primary_manifest), Path(output)
    natural, natural_id = load_manifest(natural_path, "chessy.sparse-natural-data.v1", "complete-unlabelled-research-only")
    primary, primary_id = load_manifest(primary_path, "chessy.sparse-eval-data.v1", "complete-research-only")
    audit_path = natural_path.parent / "independent-audit.json"
    audit_raw = audit_path.read_bytes()
    audit = json.loads(audit_raw)
    if audit.get("schema") != "chessy.sparse-pgn-independent-audit.v1" or audit.get("status") != "pass" \
            or audit.get("manifestSha256") != natural_id["sha256"] \
            or audit.get("rawGameInventoryJoinsVerified") != 697600 \
            or audit.get("selectedGameStrictTokenCountsVerified") != natural.get("uniqueSelectedGames") \
            or audit.get("sourceArchiveSha256") != natural["source"].get("sha256"):
        raise ValueError("independent raw-game/SAN inventory audit required")
    audit_id = {"path": str(audit_path), "sha256": digest(audit_raw), "bytes": len(audit_raw)}
    if natural["source"].get("sample") != "complete-archive" or natural["counts"].get("sourceGames") != 697600 \
            or natural["source"].get("sha256") != "f4e9efea9aeb608211a1e1b62aff00b92679eab6b70f957e77a1d7c4d8bfbbc8" \
            or natural["source"].get("license") != "CC0-1.0":
        raise ValueError("complete January 2014 source inventory required")
    roles = primary.get("files", [])
    if len(roles) != 3 or {entry.get("role") for entry in roles} != {"train", "validation", "holdout"}:
        raise ValueError("every primary role must be declared exactly once")
    natural_files = natural.get("files", [])
    if {entry.get("path") for entry in natural_files} != {"positions.jsonl", "inventory.jsonl"} or len(natural_files) != 2:
        raise ValueError("complete natural source and position inventories required")
    implementation = Path(__file__).read_bytes()
    primary_families, primary_clusters, primary_rows = set(), set(), 0
    for binding in roles:
        for row in verified_rows(primary_path.parent, binding):
            if row.get("role") != binding["role"]:
                raise ValueError("primary role mismatch")
            # Deliberately do not inspect cpWhite or other teacher outcomes.
            primary_families.add(row["family"])
            primary_clusters.add(row["cluster"])
            primary_rows += 1
    if primary_rows != primary["counts"].get("admitted"):
        raise ValueError("primary admitted inventory mismatch")
    inventory = next(entry for entry in natural_files if entry["path"] == "inventory.jsonl")
    inventory_count = sum(1 for _ in verified_rows(natural_path.parent, inventory))
    if inventory_count != 697600:
        raise ValueError("missing source games")
    positions = next(entry for entry in natural_files if entry["path"] == "positions.jsonl")
    heaps = {phase: [] for phase in PHASE_QUOTAS}
    selected = {phase: {} for phase in PHASE_QUOTAS}
    counts = Counter()
    for row in verified_rows(natural_path.parent, positions):
        counts["naturalRows"] += 1
        if row.get("role") != "unlabelled-natural" or row.get("cpWhite") is not None:
            raise ValueError("natural rows must be unlabelled")
        if row["family"] in primary_families or row["cluster"] in primary_clusters:
            counts["primaryOverlapExcluded"] += 1
            continue
        phase, family = row["phaseBucket"], row["family"]
        if phase not in PHASE_QUOTAS:
            raise ValueError("unknown natural phase")
        counts["eligibleRows"] += 1
        priority = int(digest((SCHEMA + "\0" + row["sourceGameId"]).encode()), 16)
        existing = selected[phase].get(family)
        if existing is not None and existing[0] <= priority:
            counts["inferiorPriorityWithinRetainedFamily"] += 1
            continue
        selected[phase][family] = (priority, row)
        heapq.heappush(heaps[phase], (-priority, family))
        while len(selected[phase]) > PHASE_QUOTAS[phase]:
            negative, worst_family = heapq.heappop(heaps[phase])
            current = selected[phase].get(worst_family)
            if current is not None and current[0] == -negative:
                del selected[phase][worst_family]
    chosen = []
    for phase in PHASE_QUOTAS:
        if len(selected[phase]) != PHASE_QUOTAS[phase]:
            raise ValueError("not enough independent OOD families for frozen phase quota")
        chosen.extend(sorted(selected[phase].values(), key=lambda entry: (entry[0], entry[1]["sourceGameId"])))
    chosen = [dict(row, oodPriority=f"{priority:064x}", oodIndex=index)
              for index, (priority, row) in enumerate(chosen)]
    if len({r["sourceGameId"] for r in chosen}) != len(chosen) or len({r["family"] for r in chosen}) != len(chosen):
        raise ValueError("OOD game/family duplication")
    for row in chosen:
        history_board(row)
    if digest(Path(__file__).read_bytes()) != digest(implementation):
        raise ValueError("selection implementation changed")
    # The directory itself is the exclusive no-replace publication reservation.
    output.mkdir(parents=False, exist_ok=False)
    payload = b"".join(encoded(row) + b"\n" for row in chosen)
    with open(output / "selection.jsonl", "xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    manifest = {"schema": SCHEMA + ".selection", "status": "complete-unlabelled-research-only",
                "researchOnly": True, "productionFitAllowed": False, "rules": RULES,
                "naturalManifest": natural_id, "naturalIndependentAudit": audit_id,
                "primaryManifest": primary_id,
                "primaryFamilyCount": len(primary_families), "primaryClusterCount": len(primary_clusters),
                "primaryFamiliesSha256": digest(encoded(sorted(primary_families))),
                "primaryClustersSha256": digest(encoded(sorted(primary_clusters))),
                "sourceGamesInventoried": inventory_count, "counts": dict(counts),
                "selectedFamilies": len(chosen), "selectedGames": len(chosen),
                "implementationSha256": digest(implementation),
                "files": [{"path": "selection.jsonl", "bytes": len(payload), "rows": len(chosen), "sha256": digest(payload)}],
                "limitations": ["source disjointness is archive-level; eval export has no game lineage",
                                "family/cluster exclusion is verified; shared players and deeper opening dependence are unknown"]}
    write_json(output / "manifest.json", manifest)
    return manifest


def parse_info(line):
    tokens = line.split()
    if not tokens or tokens[0] != "info" or "pv" not in tokens or "score" not in tokens:
        return None
    result = {}
    try:
        for name in ("depth", "seldepth", "nodes", "multipv", "time"):
            if name in tokens:
                result[name] = int(tokens[tokens.index(name) + 1])
        score = tokens.index("score")
        result["scoreType"], result["score"] = tokens[score + 1], int(tokens[score + 2])
        result["bound"] = "lowerbound" in tokens or "upperbound" in tokens
        result["pv"] = tokens[tokens.index("pv") + 1:]
        if "wdl" in tokens:
            offset = tokens.index("wdl")
            result["wdl"] = list(map(int, tokens[offset + 1:offset + 4]))
    except (ValueError, IndexError):
        return None
    return result


def admit_label(row, lines, rules=RULES):
    board = history_board(row)
    terminal = [line.split() for line in lines if line.startswith("bestmove ")]
    if len(terminal) != 1 or len(terminal[0]) < 2:
        return None, "missing-or-duplicate-bestmove"
    bestmove = terminal[0][1]
    reports = [info for info in map(parse_info, lines) if info and info.get("multipv", 1) == 1]
    if not reports:
        return None, "missing-final-score-pv"
    final = reports[-1]
    if final["bound"]:
        return None, "bounded-score"
    if final["scoreType"] == "mate":
        return None, "mate-score"
    if final["scoreType"] != "cp" or abs(final["score"]) > rules["maximumAbsCp"]:
        return None, "invalid-or-outside-cp-band"
    if final.get("nodes", 0) < rules["requestedNodes"]:
        return None, "below-node-budget"
    if final.get("depth", 0) < rules["minimumDepth"]:
        return None, "below-depth-floor"
    if not final["pv"] or final["pv"][0] != bestmove:
        return None, "bestmove-pv-mismatch"
    try:
        first = chess.Move.from_uci(bestmove)
        if first not in board.legal_moves:
            return None, "illegal-bestmove"
        if rules["requireQuietTeacherFirstMove"] and (board.is_capture(first) or first.promotion or board.gives_check(first)):
            return None, "tactical-teacher-first-move"
        for token in final["pv"]:
            move = chess.Move.from_uci(token)
            if move not in board.legal_moves:
                return None, "illegal-pv"
            board.push(move)
    except ValueError:
        return None, "illegal-pv"
    wdl = final.get("wdl")
    if not isinstance(wdl, list) or len(wdl) != 3 or any(n < 0 for n in wdl) or sum(wdl) != 1000:
        return None, "invalid-wdl"
    white_to_move = chess.Board(row["fen"]).turn == chess.WHITE
    return {"cpWhite": final["score"] if white_to_move else -final["score"],
            "wdlWhite": wdl if white_to_move else list(reversed(wdl)),
            "nodes": final["nodes"], "depth": final["depth"],
            "pv": final["pv"], "bestmove": bestmove}, None


class UCI:
    def __init__(self, engine, cwd):
        self.process = subprocess.Popen([str(engine)], cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1)
        self.queue = queue.Queue()
        def reader():
            try:
                for line in self.process.stdout:
                    self.queue.put(line.rstrip("\r\n"))
            finally:
                self.queue.put(None)
        self.reader = threading.Thread(target=reader, daemon=True)
        self.reader.start()
        self.events = []
        try:
            self.initialize()
        except BaseException:
            self.close()
            raise

    def initialize(self):
        self.send("uci")
        self.wait("uciok", 30)
        advertised = [event["line"] for event in self.events if event["direction"] == "out"]
        if "id name Stockfish 18" not in advertised:
            raise ValueError("teacher must identify as Stockfish 18")
        self.nets = [line for line in advertised if line.startswith("option name EvalFile")]
        if len(self.nets) != 2:
            raise ValueError("expected both embedded NNUE model declarations")
        for name, value in OPTIONS.items():
            self.send(f"setoption name {name} value {value}")
        self.send("isready")
        self.wait("readyok", 30)
        self.initialization = list(self.events)

    def send(self, line):
        self.events.append({"direction": "in", "line": line})
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def wait(self, prefix, timeout):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("UCI deadline exceeded")
            line = self.queue.get(timeout=remaining)
            if line is None:
                raise RuntimeError("teacher terminated before protocol completion")
            self.events.append({"direction": "out", "line": line})
            if line == prefix or line.startswith(prefix + " "):
                return

    def label(self, row):
        history_board(row)
        self.events = []
        self.send("ucinewgame")
        self.send("setoption name Clear Hash")
        self.send("isready")
        self.wait("readyok", 30)
        self.send("position startpos moves " + " ".join(row["prefixUci"]))
        self.send("go nodes " + str(RULES["requestedNodes"]))
        self.wait("bestmove", 30)
        lines = [e["line"] for e in self.events if e["direction"] == "out"]
        label, reason = admit_label(row, lines)
        return {"oodIndex": row["oodIndex"], "events": list(self.events),
                "label": label, "exclusion": reason}

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write("quit\n")
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
        self.reader.join(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()


def label_selection(selection_manifest, engine, output, workers=4):
    selection_path, engine, output = Path(selection_manifest), Path(engine), Path(output)
    selection, selection_id = load_manifest(selection_path, SCHEMA + ".selection", "complete-unlabelled-research-only")
    if selection.get("rules") != RULES or selection.get("selectedGames") != 4096 or selection.get("selectedFamilies") != 4096:
        raise ValueError("OOD frozen selection/rules mismatch")
    for name in ("naturalManifest", "naturalIndependentAudit", "primaryManifest"):
        binding = selection[name]
        payload = Path(binding["path"]).read_bytes()
        if digest(payload) != binding["sha256"] or len(payload) != binding["bytes"]:
            raise ValueError("upstream manifest binding changed")
    bindings = selection.get("files", [])
    if len(bindings) != 1 or bindings[0].get("path") != "selection.jsonl":
        raise ValueError("complete OOD selection inventory required")
    rows = list(verified_rows(selection_path.parent, bindings[0]))
    if len(rows) != 4096 or [row.get("oodIndex") for row in rows] != list(range(4096)):
        raise ValueError("selection coverage/order mismatch")
    if not 1 <= workers <= 4:
        raise ValueError("workers must be between one and four")
    # The authenticated bytes are the bytes copied into the private executable,
    # not a pathname authenticated and later reopened for execution.
    binary = engine.read_bytes()
    if digest(binary) != OFFICIAL_ENGINE_SHA256:
        raise ValueError("official Stockfish18 executable digest mismatch")
    implementation = Path(__file__).read_bytes()
    output.mkdir(parents=False, exist_ok=False)
    write_json(output / "plan.json", {"schema": SCHEMA + ".label-plan", "rules": RULES,
                                      "options": OPTIONS, "selectionManifest": selection_id,
                                      "engineSha256": digest(binary), "engineBytes": len(binary),
                                      "officialReleaseArchiveSha256": OFFICIAL_RELEASE_SHA256,
                                      "implementationSha256": digest(implementation),
                                      "networkBinding": "both NNUE networks embedded in authenticated executable",
                                      "workers": workers, "pythonChessVersion": chess.__version__,
                                      "startedAt": datetime.now(timezone.utc).isoformat()})
    counts, phases, result_hash = Counter(), {}, hashlib.sha256()
    for phase in PHASE_QUOTAS:
        phases[phase] = Counter()
    with tempfile.TemporaryDirectory(prefix="chessy-ood-engine-") as temporary:
        executable = Path(temporary) / "stockfish18"
        executable.write_bytes(binary)
        executable.chmod(0o555)
        os.chmod(temporary, 0o555)
        engines = []
        engine_lock = threading.Lock()
        local = threading.local()
        def run(row):
            if not hasattr(local, "engine"):
                local.engine = UCI(executable, temporary)
                with engine_lock:
                    engines.append(local.engine)
            return local.engine.label(row)
        start = time.monotonic()
        try:
            with open(output / "labels.jsonl", "xb") as labels, \
                    open(output / "traces.jsonl.gz", "xb") as trace_raw, \
                    gzip.GzipFile(fileobj=trace_raw, mode="wb", mtime=0) as traces, \
                    ThreadPoolExecutor(max_workers=workers) as pool:
                for row, result in zip(rows, pool.map(run, rows)):
                    raw_trace = encoded({"oodIndex": row["oodIndex"], "events": result["events"]}) + b"\n"
                    traces.write(raw_trace)
                    record = dict(row, teacher=result["label"], exclusion=result["exclusion"],
                                  traceSha256=digest(raw_trace), role="independent-source-ood")
                    payload = encoded(record) + b"\n"
                    labels.write(payload)
                    result_hash.update(payload)
                    status = result["exclusion"] or "accepted"
                    counts[status] += 1
                    phases[row["phaseBucket"]][status] += 1
                    if sum(counts.values()) % 256 == 0:
                        print(json.dumps({"stage": "ood-label", "rows": sum(counts.values()),
                                          "accepted": counts["accepted"], "seconds": time.monotonic() - start}), flush=True)
                labels.flush()
                os.fsync(labels.fileno())
                label_bytes = labels.tell()
            if sum(counts.values()) != 4096:
                raise ValueError("incomplete OOD teacher coverage")
            if digest(executable.read_bytes()) != digest(binary):
                raise ValueError("retained teacher executable changed")
            if digest(Path(__file__).read_bytes()) != digest(implementation):
                raise ValueError("label implementation changed")
            with open(output / "traces.jsonl.gz", "rb") as finished:
                trace_bytes = finished.read()
                os.fsync(finished.fileno())
            initialization = [engine.initialization for engine in engines]
            write_json(output / "initialization.json", initialization)
            initialization_bytes = (output / "initialization.json").read_bytes()
            manifest = {"schema": SCHEMA + ".labels", "status": "complete-research-only",
                        "researchOnly": True, "productionFitAllowed": False,
                        "rules": RULES, "options": OPTIONS, "selectionManifest": selection_id,
                        "engineSha256": digest(binary), "engineBytes": len(binary),
                        "officialReleaseArchiveSha256": OFFICIAL_RELEASE_SHA256,
                        "embeddedNetworks": sorted(set(line for engine in engines for line in engine.nets)),
                        "implementationSha256": digest(implementation), "counts": dict(counts),
                        "byPhase": {phase: dict(counter) for phase, counter in phases.items()},
                        "elapsedSeconds": time.monotonic() - start, "workers": workers,
                        "files": [{"path": "labels.jsonl", "rows": 4096, "bytes": label_bytes, "sha256": result_hash.hexdigest()},
                                  {"path": "traces.jsonl.gz", "rows": 4096, "bytes": len(trace_bytes), "sha256": digest(trace_bytes)},
                                  {"path": "initialization.json", "bytes": len(initialization_bytes), "sha256": digest(initialization_bytes)}],
                        "sourceLicense": "CC0-1.0", "teacherLicense": "GPL-3.0",
                        "limitations": ["100k-node teacher is an approximation, not ground truth",
                                        "quiet-first-PV and score/depth admission restrict the analyzed population",
                                        "source/family-disjoint prediction diagnostic is not an Elo or strength test"]}
            write_json(output / "manifest.json", manifest)
            return manifest
        finally:
            for instance in engines:
                instance.close()
            os.chmod(temporary, 0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("select")
    p.add_argument("natural_manifest", type=Path)
    p.add_argument("primary_manifest", type=Path)
    p.add_argument("output", type=Path)
    p = sub.add_parser("label")
    p.add_argument("selection_manifest", type=Path)
    p.add_argument("engine", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.command == "select":
        result = select_rows(args.natural_manifest, args.primary_manifest, args.output)
    else:
        result = label_selection(args.selection_manifest, args.engine, args.output, args.workers)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
