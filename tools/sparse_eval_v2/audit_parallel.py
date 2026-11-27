#!/usr/bin/env python3
"""Independently audit the frozen parallel study, without loading an engine.

The reducer does not import the measured JavaScript implementation. It rebuilds
the complete job order and expected cost signatures, authenticates retained
bytes, and recomputes every published throughput/resource/latency statistic.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path, PurePosixPath


SIGNATURE = (
    "nodes", "qnodes", "depth", "attempted_depth", "score", "move",
    "stop_reason", "cutoffs", "researches", "tt_saturated",
)
COUNTS = (1, 2, 4)
FLAGS = ["--no-liftoff", "--no-wasm-lazy-compilation"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**53 - 1


def read_json(path, expected_sha=None):
    require(not path.is_symlink() and path.is_file(), f"not a regular input: {path}")
    data = path.read_bytes()
    if expected_sha is not None:
        require(sha(data) == expected_sha, f"input SHA mismatch: {path}")
    return json.loads(data), data


def read_inventory(root, inventory):
    result = {}
    for name, item in inventory.items():
        parts = PurePosixPath(name)
        require(name == str(parts) and not parts.is_absolute() and
                not any(p in (".", "..") for p in parts.parts) and
                "\\" not in name and name == item["path"], "unsafe inventory name")
        path = root / name
        require(not path.is_symlink() and path.is_file(), f"nonregular inventory file: {name}")
        data = path.read_bytes()
        require(len(data) == item["bytes"] and sha(data) == item["sha256"],
                f"inventory hash/size mismatch: {name}")
        result[name] = data
    return result


def compare(actual, expected, path="value"):
    """Exact inventory/text/integer comparison; tight tolerance only for floats."""
    if isinstance(expected, dict):
        require(isinstance(actual, dict) and actual.keys() == expected.keys(), f"keys differ: {path}")
        for key, value in expected.items():
            compare(actual[key], value, f"{path}.{key}")
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(actual) == len(expected), f"length differs: {path}")
        for i, value in enumerate(expected):
            compare(actual[i], value, f"{path}[{i}]")
    elif isinstance(expected, float):
        require(type(actual) in (int, float) and math.isfinite(actual) and
                math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9), f"numeric difference: {path}")
    else:
        require(type(actual) is type(expected) and actual == expected, f"value differs: {path}")


def signature(row):
    result = {key: row[key] for key in SIGNATURE}
    for key in ("nodes", "qnodes", "depth", "cutoffs", "researches"):
        require(integer(result[key]), f"invalid signature field: {key}")
    require(result["attempted_depth"] is None or integer(result["attempted_depth"]),
            "invalid attempted depth")
    require(type(result["score"]) is int and type(result["tt_saturated"]) is bool and
            not result["tt_saturated"], "invalid score or saturated TT")
    require(result["stop_reason"] in ("node_limit", "max_depth", "mate", "game_over", "time_limit"),
            "invalid stop reason")
    require(result["qnodes"] <= result["nodes"] and result["depth"] <= 30,
            "signature count/depth out of bounds")
    return result


def order(replicate):
    indices = list(range(72))
    return indices if replicate == 0 else indices[::-1] if replicate == 1 else indices[24:] + indices[:24]


def summarize(blocks):
    """Aggregate actual fixed work divided by total batch wall time, not mean NPS."""
    output = []
    for count in COUNTS:
        own = [b for b in blocks if b["workers"] == count]
        rows = [r for b in own for r in b["rows"]]
        durations = sorted(r["elapsed_ns"] for r in rows)
        elapsed = sum(b["wallElapsedNs"] for b in own)
        nodes = sum(r["nodes"] for r in rows)
        cpu = sum(w["cpuUsage"]["user"] + w["cpuUsage"]["system"] for b in own for w in b["workerResults"])
        row = {
            "workers": count, "blocks": len(own), "searches": len(rows), "distinctRoots": 72,
            "actualNodes": nodes, "totalBatchWallNs": elapsed,
            "actualNodesPerSecond": nodes * 1e9 / elapsed,
            "searchesPerSecond": len(rows) * 1e9 / elapsed,
            "searchCallLatencyNs": {
                "mean": sum(durations) / len(durations),
                # The frozen protocol uses nearest-rank quantiles, including the median.
                "median": durations[math.ceil(.5 * len(durations)) - 1],
                "p95": durations[math.ceil(.95 * len(durations)) - 1],
                "min": durations[0], "max": durations[-1],
            },
            "workerCpuTimeUs": cpu,
            "observedWorkerCpuSecondsPerBatchWallSecond": cpu * 1000 / elapsed,
            "maximumSumOfWorkerPeakRssBytes": max(sum(w["resources"]["maxRSS"] * 1024 for w in b["workerResults"]) for b in own),
            "maximumSumOfWorkerReadyRssBytes": max(sum(w["memoryReady"]["rss"] for w in b["workerResults"]) for b in own),
            "maximumSumOfWorkerEndRssBytes": max(sum(w["memoryEnd"]["rss"] for w in b["workerResults"]) for b in own),
            "fixedWasmLinearMemoryBytes": sum(w["info"]["memoryBytes"] for w in own[0]["workerResults"]),
            "blockActualNodesPerSecond": [sum(r["nodes"] for r in b["rows"]) * 1e9 / b["wallElapsedNs"] for b in own],
        }
        output.append(row)
    for row in output:
        row["throughputRatioToOneWorker"] = row["actualNodesPerSecond"] / output[0]["actualNodesPerSecond"]
        row["meanSearchLatencyRatioToOneWorker"] = row["searchCallLatencyNs"]["mean"] / output[0]["searchCallLatencyNs"]["mean"]
    return output


def audit(registration_path, registration_sha, results_path, results_sha):
    reg, reg_bytes = read_json(registration_path, registration_sha)
    result, result_bytes = read_json(results_path, results_sha)
    require(reg["schema"] == "chessy.sparse-v2-parallel-registration.v1" and
            reg["status"] == "frozen-before-observations", "invalid registration")
    require(result["schema"] == "chessy.sparse-v2-parallel-results.v1" and
            result["status"] == "complete-research-only", "incomplete parallel study")
    for obj in (reg, result):
        require(obj["researchOnly"] is True and obj["productionAdmission"] is False and
                obj["gameOutcomesRead"] is False and obj["teacherLabelsRead"] is False,
                "invalid research-only declaration")
    require(result["registrationSha256"] == registration_sha, "results bind another registration")
    files = read_inventory(registration_path.parent, reg["files"])
    config = reg["config"]
    compare(json.loads(files["config.json"]), config, "config mirror")
    for key, value in {"workerCounts": [1, 2, 4], "replicates": 3, "roots": 72, "nodes": 36000,
                       "maximumDepth": 30, "searchWarmupCycles": 4, "searchWarmupNodes": 10000,
                       "nodeFlags": FLAGS, "model": "full", "blockTimeoutMs": 120000}.items():
        compare(config[key], value, f"config.{key}")
    require(len(config["warmupFens"]) == len(set(config["warmupFens"])) == 4, "warmup root inventory changed")
    selection = reg["selection"]
    compare(result["selection"], selection, "selection")
    require(selection["target"] in ("wasm-scalar", "wasm-simd") and
            selection["variant"] in ("compact", "fused", "cached") and selection["model"] == "full", "unsupported selection")
    prior_reg = json.loads(files["cost-registration.json"])
    prior_result = json.loads(files["cost-results.json"])
    prior_audit = json.loads(files["cost-audit.json"])
    for filename, key in (("cost-registration.json", "costRegistrationSha256"),
                          ("cost-results.json", "costResultsSha256"), ("cost-audit.json", "costAuditSha256")):
        require(sha(files[filename]) == config[key], f"cost identity differs: {filename}")
    require(prior_audit["status"] == "pass" and
            prior_audit["registrationSha256"] == config["costRegistrationSha256"] and
            prior_audit["resultsSha256"] == config["costResultsSha256"] and
            prior_result["registrationSha256"] == config["costRegistrationSha256"] and
            prior_result["allExactSignaturesMatch"] is True, "cost provenance failed")
    for key in ("target", "variant"):
        require(selection[key] == prior_result["runtimeSelection"][key] == prior_audit["runtimeSelection"][key], "cost selection changed")
    for key in ("nodeFlags", "warmupFens", "searchWarmupCycles", "searchWarmupNodes", "maximumDepth"):
        compare(config[key], prior_reg["config"][key], f"cost contract {key}")
    source_map = {"module.wasm": prior_reg["binaries"][selection["target"] + "-narrow"],
                  "full.i16le": "models/full.i16le", "roots.json": "roots.json", "rules.js": "rules.js",
                  "wasm_runner.mjs": "source/tools/sparse_eval_v2/wasm_runner.mjs"}
    for name, old_name in source_map.items():
        require(sha(files[name]) == prior_reg["files"][old_name]["sha256"] and
                len(files[name]) == prior_reg["files"][old_name]["bytes"], f"runtime input changed: {name}")
    require(sha(files["full.i16le"]) == config["fullWeightsSha256"], "weights changed")
    require(sha(files["cost-search.jsonl"]) == prior_result["searchObservations"]["sha256"] and
            len(files["cost-search.jsonl"]) == prior_result["searchObservations"]["bytes"], "cost raw signature input differs")
    roots = json.loads(files["roots.json"])
    require(len(roots) == 72 and all(len({r[k] for r in roots}) == 72 for k in ("id", "fen", "family")), "root inventory differs")
    require(collections.Counter(r["phase"] for r in roots) == {"opening": 24, "middlegame": 24, "endgame": 24}, "phase inventory differs")
    root_ids = {r["id"] for r in roots}
    expected, seen = {}, set()
    cost_rows = [json.loads(line) for line in files["cost-search.jsonl"].splitlines()]
    require(len(cost_rows) == prior_result["fullSearchObservations"] + prior_result["pruningSearchObservations"], "cost row count differs")
    for row in cost_rows:
        if (row["stage"], row["model"], row["mode"], row["target"], row["variant"], row["requested_nodes"]) != (
                "full", "full", "candidate", selection["target"], selection["variant"], 36000):
            continue
        key = (row["root"], row["replicate"])
        require(key not in seen and key[0] in root_ids and type(key[1]) is int and key[1] in (0, 1, 2), "cost signatures missing/duplicated")
        seen.add(key)
        sig = signature(row)
        require(row["scorePov"] == "white" and row["nodes"] <= 36000, "invalid cost search semantics")
        if key[0] in expected:
            compare(sig, expected[key[0]], "cost replicate signature")
        expected[key[0]] = sig
    require(len(seen) == 216 and len(expected) == 72, "incomplete cost reference signatures")
    compare(json.loads(files["expected-signatures.json"]), expected, "registered cost signatures")
    block_order = [{"replicate": rep, "workers": count} for rep, counts in
                   enumerate(((1, 2, 4), (2, 4, 1), (4, 1, 2))) for count in counts]
    compare(reg["measuredBlockOrder"], block_order, "block order")
    require(reg["expectedJobsPerWorkerCount"] == 216 and result["fixedJobsPerWorkerCount"] == 216 and
            result["searchObservations"] == 648 and result["distinctRoots"] == 72 and
            result["independentProcessCounts"] == [1, 2, 4] and result["allExactSignaturesMatch"] is True, "results inventory declaration differs")
    inventory_names = {f"block-{i:02}.json" for i in range(9)} | {"search.jsonl"}
    require(set(result["inventory"]) == inventory_names, "results file inventory differs")
    require({p.name for p in results_path.parent.iterdir()} == inventory_names | {"results.json", "plan.json"}, "unexpected or failed block artifact present")
    measured = read_inventory(results_path.parent, result["inventory"])
    plan, plan_bytes = read_json(results_path.parent / "plan.json")
    require(plan["registrationSha256"] == registration_sha and
            plan["registeredImplementationSha256"] == sha(files["parallel.mjs"]) and
            plan["noRetries"] is True and plan["noGameOutcomesRead"] is True, "execution plan differs")
    for key in ("config", "selection", "workerCpus", "coordinatorCpu"):
        compare(plan[key], reg[key], f"plan {key}")
    compare(plan["blockOrder"], block_order, "plan block order")
    compare(plan["environmentBefore"], result["environmentBefore"], "execution environment")
    cpus = reg["workerCpus"]
    require(len(set(cpus)) == 4 and cpus == reg["environment"]["affinity"][:4] and
            reg["coordinatorCpu"] == reg["environment"]["affinity"][-1] and reg["coordinatorCpu"] not in cpus, "CPU assignment differs")
    compare(result["workerCpus"], cpus, "worker CPUs")
    compare(result["coordinatorCpu"], reg["coordinatorCpu"], "coordinator CPU")
    require(result["environmentAfter"]["affinity"] == [reg["coordinatorCpu"]], "coordinator pin not retained")
    blocks, flattened, warmup_signatures = [], [], {}
    process_count = 0
    for ordinal, spec in enumerate(block_order):
        block = json.loads(measured[f"block-{ordinal:02}.json"])
        require(block["ordinal"] == ordinal and all(block[k] == v for k, v in spec.items()), "block reassigned")
        require(integer(block["wallElapsedNs"], 1) and integer(block["preparationElapsedNs"], 1), "invalid block timing")
        require(len(block["rows"]) == 72 and len(block["workerResults"]) == spec["workers"], "incomplete block")
        for position, index in enumerate(order(spec["replicate"])):
            row = block["rows"][position]
            job = {"index": index, "root": roots[index]["id"], "phase": roots[index]["phase"],
                   "ordinal": position, "worker": position % spec["workers"], **spec}
            compare({k: row[k] for k in job}, job, "job inventory")
            require(row["requested_nodes"] == 36000 and row["scorePov"] == "white" and
                    integer(row["elapsed_ns"], 1), "invalid search timing/metadata")
            compare(signature(row), expected[row["root"]], "measured cost signature")
        for worker_id, worker in enumerate(block["workerResults"]):
            process_count += 1
            require(worker["worker"] == worker_id and worker["cpu"] == cpus[worker_id] and
                    worker["workers"] == spec["workers"] and worker["replicate"] == spec["replicate"], "worker assignment differs")
            own_rows = [r for r in block["rows"] if r["worker"] == worker_id]
            require(len(own_rows) == 72 // spec["workers"] and
                    collections.Counter(r["phase"] for r in own_rows) ==
                    {p: 24 // spec["workers"] for p in ("opening", "middlegame", "endgame")}, "worker phase balance differs")
            require(sum(r["elapsed_ns"] for r in own_rows) <= worker["workerComputeElapsedNs"] <= block["wallElapsedNs"], "search timers exceed containing interval")
            for obj, keys in ((worker["cpuUsage"], ("user", "system")), (worker["resources"], ("maxRSS",)),
                              (worker["memoryReady"], ("rss",)), (worker["memoryEnd"], ("rss",))):
                require(all(integer(obj[k]) for k in keys), "invalid resource accounting")
            info = worker["info"]
            for key, name in (("moduleSha256", "module.wasm"), ("weightsSha256", "full.i16le"), ("rulesSha256", "rules.js")):
                require(info[key] == sha(files[name]), "worker identity differs")
            require(info["nodeArguments"] == FLAGS and info["nodeVersion"] == reg["node"]["version"] and
                    info["variant"] == selection["variant"] and info["simdCompiled"] == (selection["target"] == "wasm-simd") and
                    info["scorePov"] == "white" and info["memoryBytes"] == 33554432, "worker runtime differs")
            require(worker["warmupRequests"] == len(worker["warmupResults"]) == 32, "warmup count differs")
            for i, warmup in enumerate(worker["warmupResults"]):
                key = (i // 8, (i // 2) % 4, "hce" if i % 2 == 0 else "candidate")
                require((warmup["cycle"], warmup["index"], warmup["mode"]) == key and
                        integer(warmup["elapsed_ns"], 1) and warmup["nodes"] <= 10000 and
                        warmup["scorePov"] == "white", "warmup inventory differs")
                sig = signature(warmup)
                if key in warmup_signatures:
                    compare(sig, warmup_signatures[key], "warmup signature")
                warmup_signatures[key] = sig
        blocks.append(block)
        flattened.extend(block["rows"])
    compare([json.loads(line) for line in measured["search.jsonl"].splitlines()], flattened, "raw search mirror")
    summary = summarize(blocks)
    compare(result["summary"], summary, "published summary")
    return {
        "schema": "chessy.sparse-v2-parallel-independent-audit.v1", "status": "pass",
        "researchOnly": True, "productionAdmission": False,
        "registrationSha256": sha(reg_bytes), "resultsSha256": sha(result_bytes),
        "executionPlanSha256": sha(plan_bytes), "implementationSha256": sha(Path(__file__).read_bytes()),
        "independentReducer": True, "engineCalls": 0, "benchmarkReruns": 0,
        "teacherLabelsRead": False, "gameOutcomesRead": False,
        "registeredFilesAuthenticated": len(files), "resultFilesAuthenticated": len(measured),
        "costReferenceRows": len(seen), "distinctRoots": 72, "blocks": len(blocks),
        "independentWorkerProcesses": process_count, "warmupObservations": process_count * 32,
        "searchObservations": len(flattened), "actualNodes": sum(r["nodes"] for r in flattened),
        "allExpectedJobsAppearExactlyOnce": True, "allExactCostSignaturesMatch": True,
        "allWorkerWarmupsAndRuntimeIdentitiesMatch": True, "allSummaryArithmeticMatches": True,
        "numericTolerance": {"relative": 1e-12, "absolute": 1e-9}, "summary": summary,
        "limitations": [
            "Independent-job throughput, not search-tree parallelism or one-move latency speedup.",
            "72 exposed cost roots repeated three times per worker count; no new playing-strength evidence.",
            "Nearest-rank latency quantiles; sums of per-process peak RSS are upper bounds, not simultaneous RSS.",
            "One host and one complete campaign. Missing cgroup quota/throttle counters leave CPU entitlement unknown.",
            "Audit checks retained identities, inventory and arithmetic; it does not independently observe historical CPU scheduling.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registration", type=Path, required=True)
    parser.add_argument("--registration-sha256", required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--results-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.registration, args.registration_sha256, args.results, args.results_sha256)
    args.output.mkdir(parents=False, exist_ok=False)
    source = Path(__file__).read_bytes()
    require(sha(source) == report["implementationSha256"], "audit source changed during execution")
    (args.output / "audit_parallel.py").write_bytes(source)
    report_bytes = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    (args.output / "audit.json").write_bytes(report_bytes)
    for path in args.output.iterdir():
        path.chmod(0o444)
    args.output.chmod(0o555)
    print(json.dumps({"status": report["status"], "path": str(args.output / "audit.json"),
                      "sha256": sha(report_bytes), "searchObservations": report["searchObservations"]}))


if __name__ == "__main__":
    main()
