#!/usr/bin/env python3
"""Retain, run, and audit a matched-root ABI-v2 development cost screen.

Fixed nodes diagnose runtime cost and exactness. They do not select an evaluator
for play; the separately registered complete-game time frontier does that work.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import queue
import subprocess
import sys
import threading
import time

VARIANTS = ("baseline", "baseline-memory", "hce-scalar", "hce-simd", "sparse-scalar", "sparse-simd")
SIGNATURE = ("move", "score", "scorePov", "depth", "attemptedDepth", "nodes", "qnodes", "cutoffs",
             "researches", "stopReason", "ttSaturated")
FLAGS = ["--no-liftoff", "--no-wasm-lazy-compilation"]


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return {"path": path.name, "bytes": len(raw), "sha256": sha(raw)}


def binding(root, item):
    name = Path(item["path"])
    if name.is_absolute() or ".." in name.parts or (root / name).is_symlink():
        raise ValueError("unsafe retained path")
    raw = (root / name).read_bytes()
    if len(raw) != item["bytes"] or sha(raw) != item["sha256"]:
        raise ValueError("retained bytes differ: " + str(name))
    return raw


def identity(path):
    path = Path(path).resolve()
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": sha(raw)}


def metadata():
    result = {"utc": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(),
              "python": sys.version, "affinity": sorted(os.sched_getaffinity(0))}
    for name in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu.pressure", "/proc/cpuinfo"):
        result[name] = Path(name).read_text() if Path(name).exists() else None
    result["quotaObservation"] = "Missing cgroup files do not establish an unlimited CPU quota."
    return result


def register(args):
    build_raw = args.build.read_bytes()
    build = json.loads(build_raw)
    if build.get("schema") != "chessy.eval-pipeline-build.v1" or not build.get("controlReproducedExactly"):
        raise ValueError("complete ABI-v2 build with reproduced control required")
    if set(build["modules"]) != set(VARIANTS):
        raise ValueError("complete six-variant build required")
    roots_raw = args.roots.read_bytes()
    roots = json.loads(roots_raw)
    if len(roots) != 72 or len({r["id"] for r in roots}) != 72 or len({r["fen"] for r in roots}) != 72:
        raise ValueError("complete 72-root matched development grid required")
    if any(sum(r["phase"] == phase for r in roots) != 24 for phase in ("opening", "middlegame", "endgame")):
        raise ValueError("equal material-phase coverage required")
    retained = {"build.json": build_raw, "roots.json": roots_raw,
                "source/cost.py": Path(__file__).read_bytes(), "source/host.mjs": args.host.read_bytes(),
                "runtime/wasm-engine.cjs": args.loader.read_bytes(), "runtime/engine.cjs": args.rules.read_bytes()}
    for name in VARIANTS:
        retained["modules/" + name + ".wasm"] = binding(args.build.parent, build["modules"][name])
    prepared = args.build.parent / "PREPARED.json"
    prepared_raw = prepared.read_bytes()
    if sha(prepared_raw) != build["preparedSha256"]:
        raise ValueError("build preparation identity differs")
    retained["prepared.json"] = prepared_raw
    # Retain the complete build source inventory, excluding replaceable compiler output.
    prepared_files = json.loads(prepared_raw)["files"]
    for kind, suffix in (("wasm-engine", "wasm-engine"), ("engine", "engine")):
        if sha(retained["runtime/" + kind + ".cjs"]) != prepared_files["runtime/" + suffix + ".js"]["sha256"]:
            raise ValueError("loader/rules differ from retained production base")
    for name, item in prepared_files.items():
        retained["build-source/" + name] = binding(args.build.parent, dict(item, path=name))
    if build["modules"]["baseline"]["memoryBytes"] != 26542080 or any(
            build["modules"][name]["memoryBytes"] != 26607616 for name in VARIANTS[1:]):
        raise ValueError("explicit identical candidate memory allocation required")
    config = {"schema": "chessy.eval-pipeline-cost.v1", "researchOnly": True, "productionAdmission": False,
              "variants": list(VARIANTS), "nodeBudgets": [10000, 36000], "replicates": 3,
              "maxDepth": 30, "rootSeed": 0, "nodeArguments": FLAGS, "nodeVersion": "v22.23.2",
              "cpu": min(os.sched_getaffinity(0)), "expectedSearches": 72 * 2 * 3 * len(VARIANTS),
              "warmupCycles": 4, "warmupNodes": 10000,
              "warmupFens": [roots[0]["fen"], roots[24]["fen"], roots[48]["fen"],
                             "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
              "order": "For each replicate/budget/root rotate variants by their ordinal sum; reverse odd sums. Reverse roots on odd replicates.",
              "selection": "Minimum geometric mean engine-call time per evaluator; within 0.5% prefer original then scalar then SIMD. Equal-time strength remains unproven.",
              "cpuPolicy": "One measured host, pinned CPU; no concurrent fitting, builds, or other measured workloads."}
    retained["config.json"] = encoded(config)
    args.output.mkdir(parents=True, exist_ok=False)
    files = {}
    for name, raw in retained.items():
        files[name] = dict(write(args.output / name, raw), path=name)
        (args.output / name).chmod(0o444)
    registration = {"schema": "chessy.eval-pipeline-cost-registration.v1", "status": "frozen-before-observations",
                    "files": files, "node": identity(args.node), "metadata": metadata(), "config": config}
    write(args.output / "REGISTERED.json", encoded(registration))
    return {"registered": str(args.output), "searches": config["expectedSearches"]}


class Host:
    def __init__(self, command, stderr, cpu, transcript):
        def pin():
            os.sched_setaffinity(0, {cpu})
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=stderr, text=True, bufsize=1, preexec_fn=pin,
                                        env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""})
        self.lines = queue.Queue()
        def reader():
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put(None)
        threading.Thread(target=reader, daemon=True).start()
        self.counter = 0
        self.transcript = transcript

    def call(self, request):
        self.counter += 1
        request = dict(request, id=self.counter)
        started = time.perf_counter_ns()
        self.process.stdin.write(encoded(request).decode())
        self.process.stdin.flush()
        try:
            line = self.lines.get(timeout=15)
        except queue.Empty as error:
            raise RuntimeError("host request timed out; campaign is not retried") from error
        elapsed = (time.perf_counter_ns() - started) / 1e6
        self.transcript.write(encoded({"request": request, "rawResponse": line, "hostRoundTripMs": elapsed}))
        self.transcript.flush()
        if line is None:
            raise RuntimeError("host exited early")
        response = json.loads(line)
        if response.get("id") != request["id"] or response.get("ok") is not True:
            raise ValueError("host rejected request: " + line)
        return response, elapsed

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.returncode != 0:
            raise RuntimeError("host exit code " + str(self.process.returncode))


def verify_registration(root):
    registration = json.loads((root / "REGISTERED.json").read_bytes())
    for item in registration["files"].values():
        binding(root, item)
    if sha(Path(__file__).read_bytes()) != registration["files"]["source/cost.py"]["sha256"]:
        raise ValueError("runner differs from registered source")
    if Path(__file__).resolve() != (root / "source/cost.py").resolve():
        raise ValueError("run and audit must execute the retained source/cost.py")
    if identity(registration["node"]["path"]) != registration["node"]:
        raise ValueError("Node executable differs from registration")
    if registration["config"] != json.loads((root / "config.json").read_bytes()):
        raise ValueError("registration and retained configuration differ")
    return registration


def signature(result):
    return {key: result.get(key) for key in SIGNATURE}


def schedule(config, roots):
    slots = []
    for rep in range(config["replicates"]):
        ordered = roots if rep % 2 == 0 else list(reversed(roots))
        for budget_index, budget in enumerate(config["nodeBudgets"]):
            for index, row in enumerate(ordered):
                offset = (rep + budget_index + index) % len(VARIANTS)
                variants = VARIANTS[offset:] + VARIANTS[:offset]
                if (rep + budget_index + index) % 2:
                    variants = tuple(reversed(variants))
                for name in variants:
                    slots.append({"variant": name, "rootId": row["id"], "phase": row["phase"],
                                  "replicate": rep, "nodeBudget": budget})
    return slots


def run(root):
    registration = verify_registration(root)
    config = registration["config"]
    roots = json.loads((root / "roots.json").read_bytes())
    write(root / "STARTED.json", encoded(metadata()))
    command = [registration["node"]["path"], *config["nodeArguments"], str(root / "source/host.mjs"),
               "--loader", str(root / "runtime/wasm-engine.cjs"), "--rules", str(root / "runtime/engine.cjs")]
    for name in VARIANTS:
        command += ["--wasm", name + "=" + str(root / "modules" / (name + ".wasm"))]
    count = 0
    with (root / "host.stderr").open("x") as error_stream, (root / "searches.jsonl").open("xb") as ledger, \
            (root / "protocol.jsonl").open("xb") as transcript:
        host = Host(command, error_stream, config["cpu"], transcript)
        try:
            info, _ = host.call({"op": "info"})
            if (info["result"]["execArgv"] != config["nodeArguments"] or info["result"]["abiVersion"] != 2
                    or info["result"]["nodeVersion"] != config["nodeVersion"]):
                raise ValueError("host runtime configuration differs")
            for kind, name in (("loader", "wasm-engine.cjs"), ("rules", "engine.cjs")):
                if info["result"][kind + "Sha256"] != registration["files"]["runtime/" + name]["sha256"]:
                    raise ValueError("host runtime source differs")
            for name in VARIANTS:
                if info["result"]["engines"][name]["sha256"] != registration["files"]["modules/" + name + ".wasm"]["sha256"]:
                    raise ValueError("host loaded a different module")
            write(root / "HOST.json", encoded(info))
            for _ in range(config["warmupCycles"]):
                for fen in config["warmupFens"]:
                    for name in VARIANTS:
                        host.call({"op": "search", "engine": name, "fen": fen, "historyFens": [fen],
                                   "maxDepth": 30, "nodeLimit": config["warmupNodes"], "timeMs": 0, "rootSeed": 0})
            for rep in range(config["replicates"]):
                ordered = roots if rep % 2 == 0 else list(reversed(roots))
                for budget_index, budget in enumerate(config["nodeBudgets"]):
                    for index, row in enumerate(ordered):
                        offset = (rep + budget_index + index) % len(VARIANTS)
                        variants = VARIANTS[offset:] + VARIANTS[:offset]
                        if (rep + budget_index + index) % 2:
                            variants = tuple(reversed(variants))
                        for name in variants:
                            response, elapsed = host.call({"op": "search", "engine": name, "fen": row["fen"],
                                "historyFens": [row["fen"]], "maxDepth": config["maxDepth"],
                                "nodeLimit": budget, "timeMs": 0, "rootSeed": config["rootSeed"]})
                            ledger.write(encoded({"index": count, "variant": name, "rootId": row["id"],
                                "phase": row["phase"], "replicate": rep, "nodeBudget": budget,
                                "hostRoundTripMs": elapsed, "response": response}))
                            ledger.flush()
                            count += 1
                    print(json.dumps({"completedCostBlock": [rep, budget], "searches": count}), flush=True)
        finally:
            host.close()
        os.fsync(ledger.fileno())
    if count != config["expectedSearches"]:
        raise ValueError("incomplete cost campaign")
    verify_registration(root)
    completion = {"schema": "chessy.eval-pipeline-cost-completion.v1", "status": "complete",
                  "searches": count, "ledger": identity(root / "searches.jsonl"),
                  "protocol": identity(root / "protocol.jsonl"), "metadata": metadata()}
    write(root / "COMPLETE.json", encoded(completion))
    return completion


def gm(values):
    values = list(values)
    if not values or any(not math.isfinite(x) or x <= 0 for x in values):
        raise ValueError("positive finite timings required")
    return math.exp(math.fsum(math.log(x) for x in values) / len(values))


def summarize(config, roots, records):
    expected = {(name, r["id"], rep, nodes) for name in VARIANTS for r in roots
                for rep in range(config["replicates"]) for nodes in config["nodeBudgets"]}
    seen, times, by_phase, signatures = set(), defaultdict(list), defaultdict(lambda: defaultdict(list)), {}
    per_key = {}
    root_by_id = {r["id"]: r for r in roots}
    for row in records:
        key = row["variant"], row["rootId"], row["replicate"], row["nodeBudget"]
        if key not in expected or key in seen:
            raise ValueError("duplicate or unregistered cost observation")
        seen.add(key)
        result = row["response"]["result"]
        if row["response"].get("ok") is not True or result["nodes"] <= 0 or result["engineCallMs"] <= 0:
            raise ValueError("failed cost observation")
        if (type(result["nodes"]) is not int or result["nodes"] > row["nodeBudget"]
                or result.get("ttSaturated")
                or result.get("stopReason") not in ("node-limit", "mate", "max-depth")
                or result["stopReason"] == "node-limit" and result["nodes"] != row["nodeBudget"]):
            raise ValueError("cost observation violated registered node budget")
        if row["response"]["rules"]["fen"] != root_by_id[row["rootId"]]["fen"]:
            raise ValueError("root position mismatch")
        if row["phase"] != root_by_id[row["rootId"]]["phase"]:
            raise ValueError("root material phase mismatch")
        if result["uci"] not in row["response"]["rules"]["legalUcis"]:
            raise ValueError("illegal selected move")
        family = "full" if row["variant"].startswith("sparse-") else "hce"
        sig_key = family, row["rootId"], row["nodeBudget"]
        sig = signature(result)
        if sig_key in signatures and signatures[sig_key] != sig:
            raise ValueError("exact fixed-node search signature differs")
        signatures[sig_key] = sig
        times[row["variant"]].append(result["engineCallMs"])
        by_phase[row["variant"]][row["phase"]].append(result["engineCallMs"])
        per_key[key] = result
    if seen != expected:
        raise ValueError("missing cost observations")
    elapsed = {name: gm(values) for name, values in times.items()}
    def choose(options):
        best = min(elapsed[name] for name in options)
        return next(name for name in options if elapsed[name] <= best * 1.005)
    hce = choose(("baseline-memory", "hce-scalar", "hce-simd"))
    full = choose(("sparse-scalar", "sparse-simd"))
    def ratio(a, b, nps=False, phase=None):
        ratios = []
        for r in roots:
            if phase and r["phase"] != phase:
                continue
            for rep in range(config["replicates"]):
                for budget in config["nodeBudgets"]:
                    x, y = per_key[a, r["id"], rep, budget], per_key[b, r["id"], rep, budget]
                    ratios.append((x["nodes"] / x["engineCallMs"]) / (y["nodes"] / y["engineCallMs"]) if nps
                                  else y["engineCallMs"] / x["engineCallMs"])
        return gm(ratios)
    return {"schema": "chessy.eval-pipeline-cost-results.v1", "researchOnly": True,
            "productionAdmission": False, "observations": len(seen), "exactSearchSignaturesPassed": True,
            "selectedHce": hce, "selectedFull": full, "geometricMeanEngineCallMs": elapsed,
            "hceSpeedupOverOriginal": ratio(hce, "baseline-memory"),
            "fullNpsRelativeToSelectedHce": ratio(full, hce, True),
            "byPhaseFullNpsRelativeToSelectedHce": {p: ratio(full, hce, True, p) for p in ("opening", "middlegame", "endgame")},
            "elapsedSpeedupOverMemoryMatchedHce": {name: ratio(name, "baseline-memory") for name in VARIANTS},
            "limitations": ["Descriptive runtime selection on an exposed development grid, without uncertainty-based winner claims.",
                            "Fixed-node cost does not establish equal-time strength.",
                            "Optimized desktop Node/V8 is not browser or mobile latency."]}


def audit(root):
    registration = verify_registration(root)
    complete = json.loads((root / "COMPLETE.json").read_bytes())
    if identity(root / "searches.jsonl") != complete["ledger"]:
        raise ValueError("completed ledger changed")
    if identity(root / "protocol.jsonl") != complete["protocol"]:
        raise ValueError("completed protocol changed")
    records = [json.loads(line) for line in (root / "searches.jsonl").read_bytes().splitlines()]
    if [r["index"] for r in records] != list(range(len(records))):
        raise ValueError("ledger order is not complete")
    config = registration["config"]
    roots = json.loads((root / "roots.json").read_bytes())
    root_by_id = {row["id"]: row for row in roots}
    slots = schedule(config, roots)
    if len(slots) != len(records) or any(any(row.get(key) != value for key, value in slot.items())
                                        for row, slot in zip(records, slots)):
        raise ValueError("cost execution order differs from registered schedule")
    protocol = [json.loads(line) for line in (root / "protocol.jsonl").read_bytes().splitlines()]
    warmup_count = config["warmupCycles"] * len(config["warmupFens"]) * len(VARIANTS)
    if len(protocol) != len(records) + warmup_count + 1:
        raise ValueError("unexpected host request inventory")
    for index, raw in enumerate(protocol, 1):
        response = json.loads(raw["rawResponse"])
        if (raw["request"].get("id") != index or response.get("id") != index
                or response.get("ok") is not True or not math.isfinite(raw["hostRoundTripMs"])
                or raw["hostRoundTripMs"] <= 0):
            raise ValueError("invalid sequential protocol or transport timing")
        if "engineCallMs" in response["result"]:
            elapsed = response["result"]["engineCallMs"]
            if not math.isfinite(elapsed) or elapsed <= 0 or elapsed > raw["hostRoundTripMs"] + .01:
                raise ValueError("engine duration is inconsistent with complete request timing")
    info = json.loads(protocol[0]["rawResponse"])
    if protocol[0]["request"] != {"id": 1, "op": "info"} or info != json.loads((root / "HOST.json").read_bytes()):
        raise ValueError("host identity receipt differs from raw protocol")
    if (info["result"]["abiVersion"] != 2 or info["result"]["execArgv"] != config["nodeArguments"]
            or info["result"]["nodeVersion"] != config["nodeVersion"]):
        raise ValueError("host ABI or runtime tier differs from registration")
    for name in VARIANTS:
        if info["result"]["engines"][name]["sha256"] != registration["files"]["modules/" + name + ".wasm"]["sha256"]:
            raise ValueError("host module differs from registration")
    for kind, name in (("loader", "wasm-engine.cjs"), ("rules", "engine.cjs")):
        if info["result"][kind + "Sha256"] != registration["files"]["runtime/" + name]["sha256"]:
            raise ValueError("host source differs from registration")
    warmup_index = 1
    for _ in range(config["warmupCycles"]):
        for fen in config["warmupFens"]:
            for name in VARIANTS:
                request = {"id": warmup_index + 1, "op": "search", "engine": name, "fen": fen,
                           "historyFens": [fen], "maxDepth": 30, "nodeLimit": config["warmupNodes"],
                           "timeMs": 0, "rootSeed": 0}
                if protocol[warmup_index]["request"] != request:
                    raise ValueError("warmup differs from registered request order")
                warmup_index += 1
    for row, raw in zip(records, protocol[warmup_count + 1:]):
        fen = root_by_id[row["rootId"]]["fen"]
        request = {"op": "search", "engine": row["variant"], "fen": fen, "historyFens": [fen],
                   "maxDepth": config["maxDepth"], "nodeLimit": row["nodeBudget"],
                   "timeMs": 0, "rootSeed": config["rootSeed"], "id": row["response"]["id"]}
        if (raw["request"] != request or json.loads(raw["rawResponse"]) != row["response"]
                or raw["hostRoundTripMs"] != row["hostRoundTripMs"]):
            raise ValueError("raw protocol does not match cost request/response")
    result = summarize(config, roots, records)
    result["registrationSha256"] = sha((root / "REGISTERED.json").read_bytes())
    result["ledgerSha256"] = complete["ledger"]["sha256"]
    write(root / "RESULTS.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("register")
    for name in ("build", "roots", "host", "loader", "rules", "node", "output"):
        p.add_argument("--" + name, type=Path, required=True)
    for name in ("run", "audit"):
        p = sub.add_parser(name)
        p.add_argument("root", type=Path)
    args = parser.parse_args()
    result = register(args) if args.command == "register" else globals()[args.command](args.root.resolve())
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
