#!/usr/bin/env python3
"""Preregister a separate matched-root runtime screen for both fitted ablations.

This screen retains both refits and the already-selected full/HCE references.
It selects only scalar versus SIMD within a refit architecture. Fixed-node
timings never admit a model to games or production. No game results are opened.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

if __name__ == "__main__" and "_EXECUTED_BYTES" not in globals():
    _source = Path(__file__).read_bytes()
    exec(compile(_source, __file__, "exec"), {
        "__name__": "__main__", "__file__": __file__, "_EXECUTED_BYTES": _source,
    })
    raise SystemExit(0)

VARIANTS = ("hce-reference", "full-reference", "no-pawn-scalar", "no-pawn-simd", "no-ray-scalar", "no-ray-simd")
ARCHITECTURES = {name: name.rsplit("-", 1)[0] for name in VARIANTS}
PHASES = ("opening", "middlegame", "endgame")
ROOTS_SHA = "2d20138bf4751c2a9185a55baa2935bf496eddc1a8bcadb235a717562cf775fe"
FLAGS = ["--no-liftoff", "--no-wasm-lazy-compilation"]
SIGNATURE = ("move", "score", "scorePov", "depth", "attemptedDepth", "nodes", "qnodes", "cutoffs",
             "researches", "stopReason", "ttSaturated")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(raw):
    return {"bytes": len(raw), "sha256": sha(raw)}


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def relative(name):
    if (not isinstance(name, str) or not name or Path(name).is_absolute()
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError("unsafe retained path")
    return name


def read(path, expected=None):
    path = Path(path)
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("symlink input is not allowed")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read()
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("input changed while read")
    if expected is not None and identity(raw) != {key: expected[key] for key in ("bytes", "sha256")}:
        raise ValueError("retained identity mismatch: " + str(path))
    return raw


def bound(root, name, inventory):
    return read(Path(root) / relative(name), inventory[name])


def write(path, raw, executable=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o555 if executable else 0o444)
    return identity(raw)


def cost_api(raw, path):
    namespace = {"__name__": "retained_eval_pipeline_cost", "__file__": str(path)}
    exec(compile(raw, str(path), "exec"), namespace)
    if tuple(namespace["SIGNATURE"]) != SIGNATURE or namespace["FLAGS"] != FLAGS:
        raise ValueError("retained host/signature contract changed")
    return namespace


def protocol(roots, reference_selection):
    return {"schema": "chessy.eval-pipeline-refit-cost.v1", "researchOnly": True,
        "productionAdmission": False, "gameAdmission": False, "gameResultsOpened": False,
        "variants": list(VARIANTS), "architectures": ARCHITECTURES,
        "referenceSelection": reference_selection, "sourceRootsSha256": ROOTS_SHA,
        "rootSelection": "first 12 roots in each phase of the frozen 72-root cost inventory",
        "nodeBudget": 36000, "replicates": 3, "expectedSearches": 648,
        "maxDepth": 30, "rootSeed": 0, "cpu": 0, "nodeMajor": 22, "nodeArguments": FLAGS,
        "warmupCycles": 4, "warmupNodes": 10000, "warmupFens": [roots[0]["fen"], roots[12]["fen"], roots[24]["fen"],
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
        "expectedWarmups": 96,
        "order": "reverse roots on odd replicates; rotate models by replicate+root ordinal, reverse odd sums; six models adjacent per root block",
        "selection": "minimum geometric mean engine-call time within each refit; scalar preferred within 0.5%; full and HCE references frozen by prior main cost result",
        "signatures": "exact across replicates and scalar/SIMD only within the same architecture; different architectures may search differently",
        "ratios": "paired-root geometric mean elapsed(candidate)/elapsed(reference), and actual-node NPS(candidate)/NPS(reference)",
        "cpuPolicy": "one measured Node host pinned to CPU 0; no concurrent games, fitting, builds, browsers, or other measured workloads",
        "interpretation": "validation-qualified refits; fixed-node diagnostic runtime only; no automatic game or production admission"}


def select_roots(raw):
    if sha(raw) != ROOTS_SHA:
        raise ValueError("requires the frozen original COST-ROOTS.json")
    roots = json.loads(raw)
    if len(roots) != 72 or any(sum(r["phase"] == p for r in roots) != 24 for p in PHASES):
        raise ValueError("complete 72-root phase inventory required")
    return [row for phase in PHASES for row in [r for r in roots if r["phase"] == phase][:12]]


def capture_build(path, recipe):
    path = Path(path)
    raw = read(path); build = json.loads(raw)
    if (build.get("schema") != "chessy.eval-pipeline-build.v1" or build.get("controlReproducedExactly") is not True
            or build.get("abiVersion") != 2 or build.get("candidateMemoryBytes") != 26607616):
        raise ValueError("completed, memory-matched ABI-v2 build required")
    prepared_raw = read(path.parent / "PREPARED.json")
    if sha(prepared_raw) != build["preparedSha256"]:
        raise ValueError("prepared source identity differs")
    prepared = json.loads(prepared_raw)
    refit = prepared.get("refit", {})
    if (prepared.get("schema") != "chessy.eval-pipeline-prepared.v1" or refit.get("recipe") != recipe
            or refit.get("qualityEligible") is not True or refit.get("runtimeExportEligible") is not True
            or refit.get("playingStrengthAdmission") is not False):
        raise ValueError("completed validation-qualified refit preparation required")
    captured = {"BUILT.json": raw, "PREPARED.json": prepared_raw}
    for name in prepared["files"]:
        captured[name] = bound(path.parent, name, prepared["files"])
    for name, item in build["modules"].items():
        captured["modules/" + name + ".wasm"] = read(path.parent / relative(item["path"]), item)
    for name in ("sparse-scalar", "sparse-simd"):
        if build["modules"][name]["memoryBytes"] != 26607616:
            raise ValueError("refit memory differs from references")
    return captured, build, prepared


def register(main_results, no_pawn_build, no_ray_build, output):
    main_results, output = Path(main_results), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("fresh exclusive output required")
    main = main_results.parent
    result_raw = read(main_results); result = json.loads(result_raw)
    registration_raw = read(main / "REGISTERED.json"); registration = json.loads(registration_raw)
    complete_raw = read(main / "COMPLETE.json"); complete = json.loads(complete_raw)
    if (result.get("schema") != "chessy.eval-pipeline-cost-results.v1"
            or result.get("productionAdmission") is not False or result.get("exactSearchSignaturesPassed") is not True
            or result.get("registrationSha256") != sha(registration_raw)
            or complete.get("status") != "complete"):
        raise ValueError("completed audited main cost result required")
    main_files = {name: bound(main, name, registration["files"]) for name in registration["files"]}
    ledger = read(main / "searches.jsonl", complete["ledger"])
    transcript = read(main / "protocol.jsonl", complete["protocol"])
    if result.get("ledgerSha256") != sha(ledger):
        raise ValueError("main result is not bound to the complete ledger")
    api = cost_api(main_files["source/cost.py"], main / "source/cost.py")
    roots = select_roots(main_files["roots.json"])
    all_roots = json.loads(main_files["roots.json"])
    records = [json.loads(line) for line in ledger.splitlines()]
    summary = api["summarize"](registration["config"], all_roots, records)
    if any(result.get(key) != value for key, value in summary.items()):
        raise ValueError("main reference selection differs from retained observations")
    if len(records) != complete["searches"] or len(records) != registration["config"]["expectedSearches"]:
        raise ValueError("incomplete main cost grid")
    references = {"hce": result["selectedHce"], "full": result["selectedFull"]}
    if references["hce"] not in ("baseline-memory", "hce-scalar", "hce-simd") or references["full"] not in ("sparse-scalar", "sparse-simd"):
        raise ValueError("unknown selected reference implementation")
    main_host = json.loads(read(main / "HOST.json"))
    if not main_host["result"]["nodeVersion"].startswith("v22.") or main_host["result"]["execArgv"] != FLAGS:
        raise ValueError("main cost did not use the frozen Node 22 execution profile")
    captured = {"provenance/main/" + name: raw for name, raw in main_files.items()}
    captured.update({"provenance/main/RESULTS.json": result_raw, "provenance/main/REGISTERED.json": registration_raw,
        "provenance/main/COMPLETE.json": complete_raw, "provenance/main/searches.jsonl": ledger,
        "provenance/main/protocol.jsonl": transcript, "provenance/main/HOST.json": encoded(main_host),
        "source/cost.py": main_files["source/cost.py"], "source/host.mjs": main_files["source/host.mjs"],
        "runtime/wasm-engine.cjs": main_files["runtime/wasm-engine.cjs"],
        "runtime/engine.cjs": main_files["runtime/engine.cjs"], "roots.json": encoded(roots)})
    own_source = read(Path(__file__))
    if "_EXECUTED_BYTES" in globals() and own_source != globals()["_EXECUTED_BYTES"]:
        raise ValueError("executed source changed before capture")
    captured["source/refit_cost.py"] = own_source
    for label, selected in references.items():
        captured["modules/" + label + "-reference.wasm"] = main_files["modules/" + selected + ".wasm"]
    refit_identity = None
    main_prepared = json.loads(main_files["prepared.json"])
    model_bindings = {label + "-reference": {"implementation": selected,
                      "model": main_prepared["model"] if label == "full" else {"id": "production-hce"}}
                      for label, selected in references.items()}
    for short, path in (("no-pawn", no_pawn_build), ("no-ray", no_ray_build)):
        files, build, prepared = capture_build(path, "refit-" + short)
        if build["baseCommit"] != main_prepared["baseCommit"]:
            raise ValueError("refit production base differs from references")
        current_refit = prepared["refit"]["manifest"]
        if refit_identity is not None and current_refit != refit_identity:
            raise ValueError("refits came from different complete registered studies")
        refit_identity = current_refit
        for name, raw in files.items():
            captured["provenance/" + short + "/" + name] = raw
        for implementation in ("scalar", "simd"):
            name = short + "-" + implementation
            captured["modules/" + name + ".wasm"] = files["modules/sparse-" + implementation + ".wasm"]
            model_bindings[name] = {"implementation": implementation, "model": prepared["model"],
                                   "refit": prepared["refit"], "build": identity(files["BUILT.json"])}
        for name, target in (("runtime/engine.js", "runtime/engine.cjs"), ("runtime/wasm-engine.js", "runtime/wasm-engine.cjs")):
            if files[name] != captured[target]:
                raise ValueError("refit loader/rules differ from references")
    if 0 not in os.sched_getaffinity(0):
        raise ValueError("registered CPU 0 is unavailable")
    node = read(Path(registration["node"]["path"]), registration["node"])
    captured["tools/node"] = node
    config = protocol(roots, references)
    captured["config.json"] = encoded(config)
    output.mkdir(parents=True, exist_ok=False)
    inventory = {name: write(output / name, raw, name == "tools/node") for name, raw in captured.items()}
    node_version = subprocess.check_output([str(output / "tools/node"), "--version"], text=True).strip()
    if node_version != main_host["result"]["nodeVersion"]:
        raise ValueError("retained Node executable cannot reproduce the selected runtime version")
    receipt = {"schema": "chessy.eval-pipeline-refit-cost-registration.v1", "status": "frozen-before-observations",
        "config": config, "files": inventory, "modelBindings": model_bindings,
        "mainCostResult": identity(result_raw), "refitResults": refit_identity,
        "node": {**identity(node), "version": main_host["result"]["nodeVersion"], "v8Version": main_host["result"]["v8Version"]},
        "metadata": api["metadata"](), "gameResultsOpened": False}
    write(output / "REGISTERED.json", encoded(receipt))
    return {"registered": str(output), "expectedSearches": 648, "expectedWarmups": 96}


def verify(root):
    root = Path(root).resolve()
    registration_raw = read(root / "REGISTERED.json"); registration = json.loads(registration_raw)
    if registration.get("schema") != "chessy.eval-pipeline-refit-cost-registration.v1":
        raise ValueError("invalid refit cost registration")
    for name in registration["files"]:
        bound(root, name, registration["files"])
    own = bound(root, "source/refit_cost.py", registration["files"])
    if (Path(__file__).resolve() != root / "source/refit_cost.py" or own != read(Path(__file__))
            or "_EXECUTED_BYTES" in globals() and own != globals()["_EXECUTED_BYTES"]):
        raise ValueError("run and audit must execute the retained source snapshot")
    roots = json.loads(bound(root, "roots.json", registration["files"]))
    if roots != select_roots(bound(root, "provenance/main/roots.json", registration["files"])):
        raise ValueError("root selection changed")
    config = registration["config"]
    if config != protocol(roots, config["referenceSelection"]) or config != json.loads(bound(root, "config.json", registration["files"])):
        raise ValueError("registered protocol changed")
    api = cost_api(bound(root, "source/cost.py", registration["files"]), root / "source/cost.py")
    return registration, registration_raw, roots, api


def schedule(config, roots):
    slots = []
    for replicate in range(config["replicates"]):
        ordered = roots if replicate % 2 == 0 else list(reversed(roots))
        for ordinal, row in enumerate(ordered):
            offset = (replicate + ordinal) % len(VARIANTS)
            variants = VARIANTS[offset:] + VARIANTS[:offset]
            if (replicate + ordinal) % 2:
                variants = tuple(reversed(variants))
            for name in variants:
                slots.append({"variant": name, "rootId": row["id"], "phase": row["phase"],
                              "replicate": replicate, "nodeBudget": config["nodeBudget"]})
    return slots


def request(name, fen, nodes, config):
    return {"op": "search", "engine": name, "fen": fen, "historyFens": [fen], "maxDepth": config["maxDepth"],
            "nodeLimit": nodes, "timeMs": 0, "rootSeed": config["rootSeed"]}


def warmups(config):
    return [request(name, fen, config["warmupNodes"], config) for _ in range(config["warmupCycles"])
            for fen in config["warmupFens"] for name in VARIANTS]


def check_info(info, registration):
    result = info["result"]
    config = registration["config"]
    if (info.get("ok") is not True or result.get("abiVersion") != 2 or result.get("execArgv") != config["nodeArguments"]
            or result.get("nodeVersion") != registration["node"]["version"]
            or result.get("v8Version") != registration["node"]["v8Version"]
            or set(result["engines"]) != set(VARIANTS)):
        raise ValueError("host execution profile differs from registration")
    for name in VARIANTS:
        if result["engines"][name]["sha256"] != registration["files"]["modules/" + name + ".wasm"]["sha256"]:
            raise ValueError("host module differs from registration")
    for kind, name in (("loader", "wasm-engine.cjs"), ("rules", "engine.cjs")):
        if result[kind + "Sha256"] != registration["files"]["runtime/" + name]["sha256"]:
            raise ValueError("host loader/rules differ from registration")


def run(root):
    registration, _, roots, api = verify(root)
    config = registration["config"]
    if os.environ.get("NODE_OPTIONS") or 0 not in os.sched_getaffinity(0):
        raise ValueError("Node options or CPU affinity differ from the registered host")
    write(root / "STARTED.json", encoded(api["metadata"]()))
    command = [str(root / "tools/node"), *config["nodeArguments"], str(root / "source/host.mjs"),
               "--loader", str(root / "runtime/wasm-engine.cjs"), "--rules", str(root / "runtime/engine.cjs")]
    for name in VARIANTS:
        command += ["--wasm", name + "=" + str(root / "modules" / (name + ".wasm"))]
    root_by_id = {row["id"]: row for row in roots}
    slots = schedule(config, roots)
    with (root / "host.stderr").open("x") as errors, (root / "searches.jsonl").open("xb") as ledger, \
            (root / "protocol.jsonl").open("xb") as transcript:
        host = api["Host"](command, errors, config["cpu"], transcript)
        try:
            info, _ = host.call({"op": "info"})
            check_info(info, registration)
            write(root / "HOST.json", encoded(info))
            for item in warmups(config):
                host.call(item)
            for index, slot in enumerate(slots):
                response, elapsed = host.call(request(slot["variant"], root_by_id[slot["rootId"]]["fen"], slot["nodeBudget"], config))
                ledger.write(encoded({"index": index, **slot, "hostRoundTripMs": elapsed, "response": response}))
                ledger.flush()
                if (index + 1) % (len(roots) * len(VARIANTS)) == 0:
                    print(json.dumps({"completedReplicate": slot["replicate"], "searches": index + 1}), flush=True)
        finally:
            host.close()
        os.fsync(ledger.fileno()); os.fsync(transcript.fileno())
    if len(slots) != config["expectedSearches"]:
        raise ValueError("incomplete registered schedule")
    verify(root)
    completion = {"schema": "chessy.eval-pipeline-refit-cost-completion.v1", "status": "complete",
        "searches": len(slots), "warmups": len(warmups(config)), "ledger": identity(read(root / "searches.jsonl")),
        "protocol": identity(read(root / "protocol.jsonl")), "metadata": api["metadata"]()}
    write(root / "COMPLETE.json", encoded(completion))
    return completion


def gm(values):
    values = list(values)
    if not values or any(type(x) not in (int, float) or not math.isfinite(x) or x <= 0 for x in values):
        raise ValueError("positive finite timings or ratios required")
    return math.exp(math.fsum(math.log(x) for x in values) / len(values))


def summarize(config, roots, records):
    expected = {(name, row["id"], rep) for name in VARIANTS for row in roots for rep in range(config["replicates"])}
    seen, signatures, per_key = set(), {}, {}
    root_by_id = {row["id"]: row for row in roots}
    for row in records:
        key = row["variant"], row["rootId"], row["replicate"]
        if key not in expected or key in seen:
            raise ValueError("duplicate or unregistered observation")
        seen.add(key)
        result = row["response"]["result"]
        if row["response"].get("ok") is not True or row["phase"] != root_by_id[row["rootId"]]["phase"]:
            raise ValueError("failed observation or changed material phase")
        if (row["nodeBudget"] != config["nodeBudget"] or type(result.get("nodes")) is not int
                or not 0 < result["nodes"] <= config["nodeBudget"] or result.get("ttSaturated")
                or result.get("stopReason") not in ("node-limit", "mate", "max-depth")
                or result["stopReason"] == "node-limit" and result["nodes"] != config["nodeBudget"]):
            raise ValueError("registered node budget violated")
        gm([result["engineCallMs"]])
        if row["response"]["rules"]["fen"] != root_by_id[row["rootId"]]["fen"]:
            raise ValueError("changed root position")
        if result["uci"] not in row["response"]["rules"]["legalUcis"]:
            raise ValueError("illegal selected move")
        signature = {name: result.get(name) for name in SIGNATURE}
        signature_key = ARCHITECTURES[row["variant"]], row["rootId"]
        if signature_key in signatures and signatures[signature_key] != signature:
            raise ValueError("same-model scalar/SIMD/replicate signature differs")
        signatures[signature_key] = signature
        per_key[key] = result
    if seen != expected:
        raise ValueError("missing cost observations")
    elapsed = {name: gm(result["engineCallMs"] for (variant, _, _), result in per_key.items() if variant == name) for name in VARIANTS}
    selected = {}
    for family in ("no-pawn", "no-ray"):
        options = (family + "-scalar", family + "-simd")
        best = min(elapsed[name] for name in options)
        selected[family] = next(name for name in options if elapsed[name] <= best * 1.005)

    def comparison(candidate, reference, phase=None):
        ratios, nps = [], []
        for row in roots:
            if phase is not None and row["phase"] != phase:
                continue
            for rep in range(config["replicates"]):
                x, y = per_key[candidate, row["id"], rep], per_key[reference, row["id"], rep]
                ratios.append(x["engineCallMs"] / y["engineCallMs"])
                nps.append((x["nodes"] / x["engineCallMs"]) / (y["nodes"] / y["engineCallMs"]))
        return {"pairs": len(ratios), "elapsedRatio": gm(ratios), "actualNodeNpsRatio": gm(nps)}

    return {"schema": "chessy.eval-pipeline-refit-cost-results.v1", "researchOnly": True,
        "productionAdmission": False, "gameAdmission": False, "gameResultsOpened": False,
        "observations": len(seen), "sameModelSignaturesPassed": True,
        "selectedImplementationByRefit": selected, "referenceSelection": config["referenceSelection"],
        "geometricMeanEngineCallMs": elapsed,
        "totalActualNodes": {name: sum(row["nodes"] for (variant, _, _), row in per_key.items() if variant == name) for name in VARIANTS},
        "comparisons": {name: {reference: {"overall": comparison(name, reference),
            "byPhase": {phase: comparison(name, reference, phase) for phase in PHASES}}
            for reference in ("full-reference", "hce-reference")} for name in VARIANTS},
        "limitations": ["Fixed-node timings diagnose runtime cost; models can visit different trees and actual work.",
            "Implementation selection is descriptive on exposed development roots, with no uncertainty-based winner claim.",
            "Validation qualification and this screen provide no equal-time playing-strength evidence.",
            "Node/V8 CPU-0 measurements do not establish browser or mobile performance."]}


def audit_protocol(registration, roots, records, wire, host_info):
    config = registration["config"]
    slots = schedule(config, roots)
    if len(records) != len(slots) or any(row.get("index") != index or any(row.get(key) != value for key, value in slot.items())
                                       for index, (row, slot) in enumerate(zip(records, slots))):
        raise ValueError("ledger order differs from registered schedule")
    warmup = warmups(config)
    if len(warmup) != config["expectedWarmups"] or len(wire) != 1 + len(warmup) + len(slots):
        raise ValueError("raw request inventory differs")
    root_by_id = {row["id"]: row for row in roots}
    expected_requests = [{"op": "info"}, *warmup,
        *(request(row["variant"], root_by_id[row["rootId"]]["fen"], row["nodeBudget"], config) for row in slots)]
    for index, (raw, expected) in enumerate(zip(wire, expected_requests), 1):
        response = json.loads(raw["rawResponse"])
        if raw["request"] != dict(expected, id=index) or response.get("id") != index or response.get("ok") is not True:
            raise ValueError("raw request/response order or identity differs")
        gm([raw["hostRoundTripMs"]])
        if "engineCallMs" in response["result"]:
            gm([response["result"]["engineCallMs"]])
            if response["result"]["engineCallMs"] > raw["hostRoundTripMs"] + .01:
                raise ValueError("engine duration exceeds complete request timing")
    info = json.loads(wire[0]["rawResponse"])
    if info != host_info:
        raise ValueError("host receipt differs from raw protocol")
    check_info(info, registration)
    for row, raw in zip(records, wire[len(warmup) + 1:]):
        if json.loads(raw["rawResponse"]) != row["response"] or raw["hostRoundTripMs"] != row["hostRoundTripMs"]:
            raise ValueError("raw response differs from ledger")
    return {"hostInfoRequests": 1, "warmups": len(warmup), "measuredRequests": len(records),
            "rawRequests": len(wire), "completeProtocolPassed": True}


def audit(root):
    registration, registration_raw, roots, _ = verify(root)
    complete = json.loads(read(root / "COMPLETE.json"))
    if (complete.get("schema") != "chessy.eval-pipeline-refit-cost-completion.v1" or complete.get("status") != "complete"
            or complete.get("searches") != 648 or complete.get("warmups") != 96):
        raise ValueError("complete fixed refit cost inventory required")
    ledger = read(root / "searches.jsonl", complete["ledger"])
    transcript = read(root / "protocol.jsonl", complete["protocol"])
    records = [json.loads(line) for line in ledger.splitlines()]
    wire = [json.loads(line) for line in transcript.splitlines()]
    protocol_audit = audit_protocol(registration, roots, records, wire, json.loads(read(root / "HOST.json")))
    result = summarize(registration["config"], roots, records)
    result.update({"registrationSha256": sha(registration_raw), "ledgerSha256": sha(ledger),
                   "protocolSha256": sha(transcript), "protocolAudit": protocol_audit,
                   "modelBindings": registration["modelBindings"], "mainCostResult": registration["mainCostResult"],
                   "refitResults": registration["refitResults"]})
    write(root / "RESULTS.json", encoded(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("register")
    for name in ("main-results", "no-pawn-build", "no-ray-build", "output"):
        p.add_argument("--" + name, type=Path, required=True)
    for command in ("run", "audit"):
        p = sub.add_parser(command); p.add_argument("root", type=Path)
    args = parser.parse_args()
    if args.command == "register":
        result = register(args.main_results, args.no_pawn_build, args.no_ray_build, args.output)
    else:
        result = globals()[args.command](args.root.resolve())
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
