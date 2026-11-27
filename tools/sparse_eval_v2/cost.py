#!/usr/bin/env python3
"""One frozen native/WASM cost grid, followed by the declared pruning screen.

Preparation reads validation FENs/grouping and already frozen prediction bytes,
never teacher labels. Execution uses exclusively retained sources and binaries.
Raw child output is persisted before validation; completion is published last.
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
import shutil
import struct
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PHASES = ("opening", "middlegame", "endgame")
SIGNATURE = ("nodes", "qnodes", "depth", "attempted_depth", "score", "move",
             "stop_reason", "cutoffs", "researches", "tt_saturated")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def write(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": path.name, "bytes": len(raw), "sha256": sha(raw)}


def bound(root, item):
    path = Path(item["path"])
    if path.is_absolute() or ".." in path.parts or (Path(root) / path).is_symlink():
        raise ValueError("unsafe retained path")
    raw = (Path(root) / path).read_bytes()
    if len(raw) != item["bytes"] or sha(raw) != item["sha256"]:
        raise ValueError("retained bytes differ: " + str(path))
    return raw


def bucket(phase):
    return "opening" if phase >= 18 else "middlegame" if phase >= 7 else "endgame"


def select_roots(fens, phases, families, excluded, salt, quota):
    if len(fens) != len(phases) or len(fens) != len(families) or len(fens) != len(set(fens)):
        raise ValueError("invalid validation root inventory")
    groups = {p: [] for p in PHASES}
    for i, (fen, phase, family) in enumerate(zip(fens, phases, families)):
        if not 0 <= phase <= 24 or not fen or fen in excluded:
            continue
        digest = sha((salt + "\0" + fen).encode())
        groups[bucket(phase)].append({"validationIndex": i, "fen": fen, "phase": bucket(phase),
                                     "materialPhase": phase, "family": family, "rankSha256": digest})
    selected, used = [], set()
    for phase in PHASES:
        count = 0
        for item in sorted(groups[phase], key=lambda x: (x["rankSha256"], x["fen"])):
            if item["family"] in used:
                continue
            used.add(item["family"])
            selected.append(dict(item, id=f"root-{len(selected):03d}"))
            count += 1
            if count == quota:
                break
        if count != quota:
            raise ValueError("unique-family phase quota shortfall")
    return selected


def gm(values):
    values = list(values)
    if not values or any(not math.isfinite(x) or x <= 0 for x in values):
        raise ValueError("invalid geometric-mean input")
    return math.exp(math.fsum(map(math.log, values)) / len(values))


def metadata():
    result = {"time": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(),
              "python": sys.version, "affinity": sorted(os.sched_getaffinity(0))}
    for key, path in (("cpuMax", "/sys/fs/cgroup/cpu.max"), ("cpuStat", "/sys/fs/cgroup/cpu.stat"),
                      ("cpuPressure", "/sys/fs/cgroup/cpu.pressure"), ("cpuInfo", "/proc/cpuinfo")):
        if Path(path).exists():
            result[key] = Path(path).read_text()
        else:
            result[key] = None
    result["quotaObservation"] = "cgroup metadata recorded when exposed; absent files do not establish an unlimited quota"
    return result


def prepare(args):
    config_raw = args.config.read_bytes()
    config = json.loads(config_raw)
    if config["schema"] != "chessy.sparse-v2-cost.v1":
        raise ValueError("wrong cost configuration")
    packed_raw = args.packed.read_bytes()
    if sha(packed_raw) != config["packedManifestSha256"]:
        raise ValueError("wrong packed manifest")
    packed = json.loads(packed_raw)
    part = next(p for p in packed["roles"] if p["role"] == "validation")
    inputs = {name: bound(args.packed.parent, part["files"][name])
              for name in ("fens.txt", "phase.u8", "family.u32", "baseline.i32")}
    fens = inputs["fens.txt"].decode().splitlines()
    phases = list(inputs["phase.u8"])
    families = [x[0] for x in struct.iter_unpack("<I", inputs["family.u32"])]
    if len(fens) != part["rows"]:
        raise ValueError("validation rows differ")
    previous_raw = args.previous_roots.read_bytes()
    if sha(previous_raw) != "31de3c9558e860f0944a8b860633a7050330af666dede4ab902ea55fd7bd3400":
        raise ValueError("wrong old timing-root inventory")
    previous = json.loads(previous_raw)
    if len(previous) != 24:
        raise ValueError("old root count differs")
    roots = select_roots(fens, phases, families, {p["fen"] for p in previous},
                         config["rootSalt"], config["rootsPerPhase"])
    subset = [r for p in PHASES for r in [x for x in roots if x["phase"] == p][:config["pruningCost"]["rootsPerPhase"]]]
    pruning_raw = args.pruning.read_bytes()
    pruning = json.loads(pruning_raw)
    if pruning["status"] != "complete-research-only" or pruning["configSha256"] != sha((ROOT / "eval/sparse-pesto-v2/PRUNING-CONFIG.json").read_bytes()):
        raise ValueError("unbound pruning screen")
    models = [m for m in pruning["candidates"] if m["qualityGuard"]["passed"]]
    if not models or models[0]["id"] != "full" or models[0]["weights"]["sha256"] != config["fullWeightsSha256"]:
        raise ValueError("full model missing or changed")
    retained = {"config.json": config_raw, "packed-manifest.json": packed_raw,
                "previous-roots.json": previous_raw, "pruning-results.json": pruning_raw,
                "roots.json": encoded(roots), "pruning-roots.json": encoded(subset),
                "rules.js": (ROOT / "assets/engine.js").read_bytes()}
    retained.update({"validation/" + name: value for name, value in inputs.items()})
    expected = {}
    baseline = [x[0] for x in struct.iter_unpack("<i", inputs["baseline.i32"])]
    for item in models:
        name = item["id"]
        raw = bound(args.pruning.parent, item["weights"])
        retained["models/" + name + ".i16le"] = raw
        scores_raw = bound(args.pruning.parent, item["scores"])
        scores = [x[0] for x in struct.iter_unpack("<i", scores_raw)]
        if len(scores) != len(fens):
            raise ValueError("wrong frozen prediction count")
        expected[name] = {r["id"]: {"hce": baseline[r["validationIndex"]],
                                    "candidate": scores[r["validationIndex"]]} for r in roots}
    retained["expected-scores.json"] = encoded(expected)
    binaries, receipts = {}, {}
    for width, native_path, wasm_path in (("narrow", args.native, args.wasm),
                                           ("wide", args.native_wide, args.wasm_wide)):
        for kind, path in (("native", native_path), ("wasm", wasm_path)):
            raw = path.read_bytes()
            receipt = json.loads(raw)
            receipts[kind + "-" + width] = sha(raw)
            retained[f"builds/{kind}-{width}.json"] = raw
            if receipt["wideFused"] != (width == "wide"):
                raise ValueError("wrong build width")
            for name, digest in receipt["sourceHashes"].items():
                payload = (ROOT / name).read_bytes()
                if sha(payload) != digest:
                    raise ValueError("current source differs from frozen build: " + name)
                retained["source/" + name] = payload
            for target in ("scalar", "simd"):
                if kind == "native":
                    entry = receipt["native"][target]
                    payload = Path(entry["path"]).read_bytes()
                else:
                    entry = next(x for x in receipt["builds"] if x["target"] == ("scalar" if target == "scalar" else "simd128"))["artifacts"]["module"]
                    payload = bound(path.parent, entry)
                if sha(payload) != entry["sha256"] or len(payload) != entry["bytes"]:
                    raise ValueError("build binary identity differs")
                key = kind + "-" + target
                name = f"binaries/{key}-{width}" + (".wasm" if kind == "wasm" else "")
                retained[name] = payload
                binaries[key + "-" + width] = name
    for name in ("cost.py", "cost_target.mjs", "wasm_runner.mjs"):
        retained["source/tools/sparse_eval_v2/" + name] = (ROOT / "tools/sparse_eval_v2" / name).read_bytes()
    node = Path(shutil.which("node")).resolve()
    node_raw = node.read_bytes()
    args.output.mkdir(parents=True, exist_ok=False)
    files = {}
    for name, raw in retained.items():
        item = write(args.output / name, raw)
        item["path"] = name
        files[name] = item
        (args.output / name).chmod(0o555 if name.startswith("binaries/native") else 0o444)
    registration = {"schema": "chessy.sparse-v2-cost-registration.v1", "status": "frozen-before-observations",
                    "config": config, "files": files, "binaries": binaries, "buildReceipts": receipts,
                    "models": [{"id": m["id"], "validationCe": m["metrics"]["overall"]["ce"],
                                "qualityGuard": m["qualityGuard"], "wide": m["id"] == "king-original"} for m in models],
                    "node": {"path": str(node), "sha256": sha(node_raw), "bytes": len(node_raw),
                             "version": subprocess.check_output([str(node), "--version"], text=True).strip()},
                    "selectedCpu": min(os.sched_getaffinity(0)), "environment": metadata(),
                    "rootSelectionUsedTeacherLabels": False, "gameOutcomesUsed": False}
    item = write(args.output / "manifest.json", encoded(registration))
    for directory in sorted((p for p in args.output.rglob("*") if p.is_dir()), reverse=True):
        directory.chmod(0o555)
    args.output.chmod(0o555)
    return {"manifest": str(args.output / "manifest.json"), "sha256": item["sha256"],
            "roots": len(roots), "pruningRoots": len(subset), "eligibleModels": [m["id"] for m in models]}


def signature(row):
    value = {key: row[key] for key in SIGNATURE}
    if value["move"] == "0000":
        value["move"] = None
    return value


def validate_rows(rows, roots, replicate, nodes):
    ordered = roots[::-1] if replicate % 2 else roots
    expected = [(r, mode) for i, r in enumerate(ordered)
                for mode in (["candidate", "hce"] if (i + replicate) % 2 else ["hce", "candidate"])]
    if len(rows) != len(expected):
        raise ValueError("incomplete search block")
    for row, (root, mode) in zip(rows, expected):
        if row["root"] != root["id"] or row["mode"] != mode or row["phase"] != root["phase"]:
            raise ValueError("search order or root differs")
        for key in ("nodes", "qnodes", "elapsed_ns", "depth", "cutoffs", "researches", "score"):
            if type(row.get(key)) is not int:
                raise ValueError("noninteger search result")
        if not 0 < row["nodes"] <= nodes or not 0 <= row["qnodes"] <= row["nodes"] or row["elapsed_ns"] <= 0:
            raise ValueError("invalid budget/accounting/time")
        if row["stop_reason"] not in ("node_limit", "max_depth", "mate", "game_over") or row["tt_saturated"]:
            raise ValueError("invalid stop or saturated search")
        if row["stop_reason"] == "node_limit" and row["nodes"] != nodes:
            raise ValueError("node-limit mismatch")
        signature(row)


def choose_runtime(searches, targets, variants):
    scores = {(target, variant): gm(r["elapsed_ns"] for r in searches
              if r["target"] == target and r["variant"] == variant and r["mode"] == "candidate")
              for target in targets for variant in variants}
    best = min(scores.values())
    eligible = [key for key, score in scores.items() if score <= best * 1.005]
    selected = min(eligible, key=lambda key: ("simd" in key[0], variants.index(key[1]), key[0]))
    return {"target": selected[0], "variant": selected[1], "geometricMeanElapsedNs": scores[selected],
            "scores": [{"target": key[0], "variant": key[1], "geometricMeanElapsedNs": score}
                       for key, score in scores.items()]}


def search_summary(rows):
    groups = defaultdict(list)
    indexed = {(r["model"], r["target"], r["variant"], r["replicate"], r["requested_nodes"], r["root"], r["mode"]): r for r in rows}
    for row in rows:
        if row["mode"] != "candidate":
            continue
        key = (row["model"], row["target"], row["variant"], row["requested_nodes"])
        groups[key].append(row)
    result = []
    for key, candidates in groups.items():
        ratios = []
        for r in candidates:
            h = indexed[(r["model"], r["target"], r["variant"], r["replicate"], r["requested_nodes"], r["root"], "hce")]
            ratios.append((r["nodes"] / r["elapsed_ns"]) / (h["nodes"] / h["elapsed_ns"]))
        hits = sum(r.get("cacheHits", 0) for r in candidates)
        misses = sum(r.get("cacheMisses", 0) for r in candidates)
        result.append({"model": key[0], "target": key[1], "variant": key[2], "requestedNodes": key[3],
                       "pairs": len(candidates), "candidateNps": gm(r["nodes"] * 1e9 / r["elapsed_ns"] for r in candidates),
                       "npsRatioToHce": gm(ratios), "geometricMeanElapsedNs": gm(r["elapsed_ns"] for r in candidates),
                       "cacheHitFraction": hits / (hits + misses) if hits + misses else None})
    return result


def choose_pruned(rows, models, minimum=1.05):
    full = {(r["root"], r["replicate"], r["requested_nodes"]): r for r in rows if r["model"] == "full" and r["mode"] == "candidate"}
    results = []
    for model in models:
        ratios = []
        for row in rows:
            if row["model"] != model["id"] or row["mode"] != "candidate":
                continue
            base = full[(row["root"], row["replicate"], row["requested_nodes"])]
            ratios.append((row["nodes"] / row["elapsed_ns"]) / (base["nodes"] / base["elapsed_ns"]))
        ratio = gm(ratios)
        results.append({**model, "pairedNpsRatioToFull": ratio, "pairs": len(ratios),
                        "speedEligible": model["id"] != "full" and ratio >= minimum})
    allowed = [r for r in results if r["speedEligible"] and r["qualityGuard"]["passed"]]
    winner = None
    if allowed:
        best = max(r["pairedNpsRatioToFull"] for r in allowed)
        winner = min((r for r in allowed if r["pairedNpsRatioToFull"] >= best / 1.005),
                     key=lambda r: (r["validationCe"], r["id"]))["id"]
    return {"selected": winner, "models": results}


def run(args):
    root = args.registration.parent
    registration_raw = args.registration.read_bytes()
    if sha(registration_raw) != args.sha256:
        raise ValueError("external registration digest differs")
    registration = json.loads(registration_raw)
    if registration["status"] != "frozen-before-observations":
        raise ValueError("not registered before observations")
    for item in registration["files"].values():
        bound(root, item)
    if sha(Path(__file__).read_bytes()) != registration["files"]["source/tools/sparse_eval_v2/cost.py"]["sha256"]:
        raise ValueError("cost implementation differs")
    config = registration["config"]
    roots = json.loads(bound(root, registration["files"]["roots.json"]))
    prune_roots = json.loads(bound(root, registration["files"]["pruning-roots.json"]))
    expected_scores = json.loads(bound(root, registration["files"]["expected-scores.json"]))
    args.output.mkdir(parents=True, exist_ok=False)
    write(args.output / "registration.json", registration_raw)
    start = metadata()
    write(args.output / "environment-before.json", encoded(start))
    raw_inventory, search_rows, static_rows = [], [], []
    signatures = {}
    cpu = registration["selectedCpu"]

    def invoke(command, name, stdin=b"", executable_binding=None):
        fd = os.open(command[0], os.O_RDONLY)
        try:
            with os.fdopen(os.dup(fd), "rb") as stream:
                executable_raw = stream.read()
            if executable_binding and (sha(executable_raw) != executable_binding["sha256"] or len(executable_raw) != executable_binding["bytes"]):
                raise ValueError("executable changed before launch")
            result = subprocess.run([f"/proc/self/fd/{fd}", *command[1:]], input=stdin, capture_output=True,
                pass_fds=(fd,), preexec_fn=lambda: os.sched_setaffinity(0, {cpu}), timeout=180,
                env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": "", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"})
        finally:
            os.close(fd)
        out = write(args.output / (name + ".stdout"), result.stdout)
        err = write(args.output / (name + ".stderr"), result.stderr)
        raw_inventory.append({"id": name, "command": command, "stdinSha256": sha(stdin),
                              "returncode": result.returncode, "stdout": out, "stderr": err})
        if result.returncode:
            raise ValueError("cost child failed: " + name)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def block(target, variant, model, replicate, selected, stage, nodes=None):
        wide = model["wide"]
        binary_name = registration["binaries"][target + ("-wide" if wide else "-narrow")]
        binary = root / binary_name
        weights = root / ("models/" + model["id"] + ".i16le")
        action = "static" if nodes is None else "search"
        job = f"{stage}-{target}-{variant}-{model['id']}-r{replicate}-{action}-{nodes or 0}"
        order = selected[::-1] if replicate % 2 else selected
        fen_bytes = ("\n".join(r["fen"] for r in order) + "\n").encode()
        common = {"target": target, "variant": variant, "model": model["id"], "replicate": replicate,
                  "stage": stage, "requested_nodes": nodes}
        if target.startswith("native"):
            if nodes is None:
                observations = []
                for mode in (["candidate", "hce"] if replicate % 2 else ["hce", "candidate"]):
                    values = invoke([str(binary), "bench", str(weights), variant if mode == "candidate" else "hce",
                                     str(config["staticPasses"]), str(config["staticWarmupPasses"])], job + "-" + mode,
                                    fen_bytes, registration["files"][binary_name])
                    if len(values) != 1:
                        raise ValueError("wrong native benchmark row count")
                    if values[0].get("warmup_passes") != config["staticWarmupPasses"]:
                        raise ValueError("wrong native static warmup")
                    observations.append({**values[0], "kind": "static", "mode": mode})
            else:
                values = invoke([str(binary), "search", str(weights), variant, str(nodes), str(config["maximumDepth"]),
                                 str(replicate), str(config["searchWarmupCycles"])], job, fen_bytes,
                                registration["files"][binary_name])
                if any(r.get("order_offset") != replicate or r.get("warmup_requests") != config["searchWarmupCycles"] * 8 for r in values):
                    raise ValueError("wrong native search order/warmup")
                observations = [{**r, "kind": "search", "root": order[r["row"]]["id"],
                                 "phase": order[r["row"]]["phase"], "mode": "candidate" if r["candidate"] else "hce"}
                                for r in values]
        else:
            values = invoke([registration["node"]["path"], *config["nodeFlags"],
                             str(root / "source/tools/sparse_eval_v2/cost_target.mjs"), str(binary), str(weights), variant,
                             str(root / "rules.js"), str(root / ("roots.json" if stage == "full" else "pruning-roots.json")),
                             str(root / "config.json"), action, str(nodes or 0), str(replicate)], job,
                            executable_binding=registration["node"])
            info, observations = values[0], values[1:]
            if (info.get("kind") != "metadata" or info["moduleSha256"] != registration["files"][binary_name]["sha256"]
                    or info["weightsSha256"] != registration["files"][f"models/{model['id']}.i16le"]["sha256"]
                    or info["rulesSha256"] != registration["files"]["rules.js"]["sha256"]
                    or info["nodeArguments"] != config["nodeFlags"] or info["variant"] != variant
                    or info["simdCompiled"] != target.endswith("simd")):
                raise ValueError("WASM child binding differs")
        observations = [{**r, **common} for r in observations]
        if nodes is None:
            if len(observations) != 2 or {r["mode"] for r in observations} != {"hce", "candidate"}:
                raise ValueError("incomplete static pair")
            for r in observations:
                wanted = sum(expected_scores[model["id"]][p["id"]][r["mode"]] for p in selected) * config["staticPasses"]
                if int(r["checksum"]) != wanted or r["positions"] != len(selected) or r["passes"] != config["staticPasses"] or r["elapsed_ns"] <= 0:
                    raise ValueError("static checksum, count or time mismatch")
            static_rows.extend(observations)
        else:
            validate_rows(observations, selected, replicate, nodes)
            for r in observations:
                key = (r["model"] if r["mode"] == "candidate" else "HCE", nodes, r["root"])
                value = signature(r)
                if key in signatures and signatures[key] != value:
                    raise ValueError("cross-target/variant/replicate exact search mismatch: " + str(key))
                signatures[key] = value
            search_rows.extend(observations)
        print(json.dumps({"completedCostBlock": job, "searchRows": len(search_rows)}), flush=True)

    full = registration["models"][0]
    combinations = [(t, v) for t in config["targets"] for v in config["variants"]]
    for replicate in range(config["replicates"]):
        offset = replicate * 5 % len(combinations)
        ordered = combinations[offset:] + combinations[:offset]
        if replicate % 2:
            ordered.reverse()
        for target, variant in ordered:
            block(target, variant, full, replicate, roots, "full")
            for nodes in config["nodeBudgets"]:
                block(target, variant, full, replicate, roots, "full", nodes)
    full_rows = list(search_rows)
    winner = choose_runtime(full_rows, [t for t in config["targets"] if t.startswith("wasm")], config["variants"])
    native = choose_runtime(full_rows, [t for t in config["targets"] if t.startswith("native")], config["variants"])
    write(args.output / "runtime-selection.json", encoded({"status": "frozen-before-pruning-cost-and-games", **winner}))
    prune_start = len(search_rows)
    for replicate in range(config["pruningCost"]["replicates"]):
        ordered = registration["models"]
        offset = replicate % len(ordered)
        ordered = ordered[offset:] + ordered[:offset]
        if replicate % 2:
            ordered.reverse()
        for model in ordered:
            for nodes in config["pruningCost"]["nodeBudgets"]:
                block(winner["target"], winner["variant"], model, replicate, prune_roots, "pruning", nodes)
    pruning_rows = search_rows[prune_start:]
    pruning = choose_pruned(pruning_rows, registration["models"], config["pruningCost"]["minimumNpsRatioToFull"])
    expected_full = len(config["targets"]) * len(config["variants"]) * config["replicates"] * len(config["nodeBudgets"]) * len(roots) * 2
    expected_pruning = len(registration["models"]) * config["pruningCost"]["replicates"] * len(config["pruningCost"]["nodeBudgets"]) * len(prune_roots) * 2
    if len(full_rows) != expected_full or len(pruning_rows) != expected_pruning:
        raise ValueError("incomplete declared search grid")
    for item in registration["files"].values():
        bound(root, item)
    observations = write(args.output / "search.jsonl", b"".join(encoded(r) for r in search_rows))
    static = write(args.output / "static.jsonl", b"".join(encoded(r) for r in static_rows))
    inventory = write(args.output / "raw-inventory.json", encoded(raw_inventory))
    report = {"schema": "chessy.sparse-v2-cost-results.v1", "status": "complete-research-only",
              "registrationSha256": args.sha256, "environmentBefore": start, "environmentAfter": metadata(),
              "fullSearchObservations": len(full_rows), "pruningSearchObservations": len(pruning_rows),
              "staticObservations": len(static_rows), "exactSearchSignatureGroups": len(signatures),
              "allExactSignaturesMatch": True, "rawInventory": inventory, "searchObservations": observations,
              "staticObservationsFile": static, "full": search_summary(full_rows),
              "pruning": search_summary(pruning_rows), "runtimeSelection": winner, "nativeWinner": native,
              "pruningSelection": pruning, "gameOutcomesUsed": False, "productionAdmission": False,
              "limitations": ["single desktop CPU and Node/V8 execution host", "validation cost roots are development data",
                              "warm-cache static numbers are not cold evaluator latency", "one complete grid; no selective retries"]}
    write(args.output / "results.json", encoded(report))
    return {"status": report["status"], "runtime": winner, "prunedModel": pruning["selected"],
            "fullSearchObservations": len(full_rows), "pruningSearchObservations": len(pruning_rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    for name in ("config", "packed", "previous-roots", "pruning", "native", "native-wide", "wasm", "wasm-wide", "output"):
        prep.add_argument("--" + name, type=Path, required=True)
    execute = sub.add_parser("run")
    execute.add_argument("registration", type=Path)
    execute.add_argument("sha256")
    execute.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args) if args.command == "prepare" else run(args)), flush=True)


if __name__ == "__main__":
    main()
