#!/usr/bin/env python3
"""Small synthetic evidence fixture; no engine, producer reducer or real timing."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval_v2.audit_cost import audit


def raw(value):
    return (json.dumps(value, sort_keys=True) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def put(directory, name, value):
    data = value if isinstance(value, bytes) else raw(value)
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": name, "bytes": len(data), "sha256": sha(data)}


def fixture(directory):
    registration, output = directory / "registration", directory / "results"
    registration.mkdir(); output.mkdir()
    cfg = {"schema": "chessy.sparse-v2-cost.v1", "researchOnly": True, "rootsPerPhase": 1,
           "targets": ["native-scalar", "wasm-scalar"], "variants": ["compact", "fused"], "replicates": 2,
           "nodeBudgets": [100], "maximumDepth": 30, "staticPasses": 2, "staticWarmupPasses": 128,
           "searchWarmupCycles": 4, "warmupFens": ["warm-a", "warm-b", "warm-c", "warm-d"], "nodeFlags": ["--no-liftoff"],
           "pruningCost": {"rootsPerPhase": 1, "replicates": 2, "nodeBudgets": [100], "minimumNpsRatioToFull": 1.05}}
    roots = [dict(id=f"root-{i}", fen=f"synthetic-{i}", family=i, phase=phase) for i, phase in enumerate(("opening", "middlegame", "endgame"))]
    models = [dict(id=name, validationCe=ce, qualityGuard={"passed": True}, wide=False) for name, ce in (("full", .67), ("trim", .671))]
    files, screen, expected = {}, [], {}
    for model in models:
        name = model["id"]
        weights = put(registration, f"models/{name}.i16le", ("synthetic-weights:" + name).encode())
        files[weights["path"]] = weights
        screen.append(dict(id=name, metrics={"overall": {"ce": model["validationCe"]}}, qualityGuard=model["qualityGuard"], weights=weights))
        expected[name] = {r["id"]: {"hce": hce, "candidate": candidate} for r, hce, candidate in
                          zip(roots, (-17, 12, -3), (-10, 4, -1) if name == "full" else (-9, 5, -1))}
    cfg["fullWeightsSha256"] = files["models/full.i16le"]["sha256"]
    for name, value in (("config.json", cfg), ("roots.json", roots), ("pruning-roots.json", roots),
                        ("expected-scores.json", expected), ("pruning-results.json", {"candidates": screen}),
                        ("rules.js", b"synthetic-rules"), ("source/runtime.rs", b"synthetic-source")):
        files[name] = put(registration, name, value)
    binaries, builds = {}, {}
    for kind in ("native", "wasm"):
        for width in ("narrow", "wide"):
            receipt = {"wideFused": width == "wide", "sourceHashes": {"runtime.rs": files["source/runtime.rs"]["sha256"]}}
            entries = {}
            for target in ("scalar", "simd"):
                key = f"{kind}-{target}-{width}"
                name = "binaries/" + key + (".wasm" if kind == "wasm" else "")
                files[name] = put(registration, name, key.encode())
                binaries[key] = name
                entries[target] = files[name]
            if kind == "native": receipt["native"] = entries
            else: receipt["builds"] = [{"target": "scalar" if k == "scalar" else "simd128", "artifacts": {"module": v}} for k, v in entries.items()]
            key = f"{kind}-{width}"
            name = f"builds/{key}.json"
            files[name] = put(registration, name, receipt)
            builds[key] = files[name]["sha256"]
    reg = {"schema": "chessy.sparse-v2-cost-registration.v1", "status": "frozen-before-observations",
           "rootSelectionUsedTeacherLabels": False, "gameOutcomesUsed": False, "config": cfg,
           "files": files, "models": models, "binaries": binaries, "buildReceipts": builds,
           "node": {"path": "/synthetic/node", "version": "v22.synthetic"}}
    anchor = put(registration, "manifest.json", reg)["sha256"]
    put(output, "registration.json", (registration / "manifest.json").read_bytes())
    inventory, search_rows, static_rows = [], [], []
    times = {("native-scalar", "compact"): 1300, ("native-scalar", "fused"): 1200,
             ("wasm-scalar", "compact"): 1100, ("wasm-scalar", "fused"): 1000}

    def block(target, variant, model, rep, stage, nodes):
        ordered = roots[::-1] if rep % 2 else roots
        modes = ["candidate", "hce"] if rep % 2 else ["hce", "candidate"]
        native = target.startswith("native")
        binary = registration / binaries[target + "-narrow"]
        weight = registration / f"models/{model['id']}.i16le"
        action = "static" if nodes is None else "search"
        job = f"{stage}-{target}-{variant}-{model['id']}-r{rep}-{action}-{nodes or 0}"
        common = dict(target=target, variant=variant, model=model["id"], replicate=rep, stage=stage, requested_nodes=nodes)
        for static_mode in (modes if native and nodes is None else [None]):
            identifier = job + ("-" + static_mode if static_mode else "")
            values = []
            if native:
                command = [str(binary), "bench" if nodes is None else "search", str(weight), variant if static_mode != "hce" else "hce"]
                command += ["2", "128"] if nodes is None else ["100", "30", str(rep), "4"]
                stdin = ("\n".join(r["fen"] for r in ordered) + "\n").encode()
            else:
                command = [reg["node"]["path"], *cfg["nodeFlags"], str(registration / "source/tools/sparse_eval_v2/cost_target.mjs"),
                           str(binary), str(weight), variant, str(registration / "rules.js"),
                           str(registration / ("roots.json" if stage == "full" else "pruning-roots.json")),
                           str(registration / "config.json"), action, str(nodes or 0), str(rep)]
                stdin = b""
                values.append(dict(kind="metadata", moduleSha256=files[binaries[target + "-narrow"]]["sha256"],
                    weightsSha256=files[f"models/{model['id']}.i16le"]["sha256"], rulesSha256=files["rules.js"]["sha256"],
                    nodeArguments=cfg["nodeFlags"], nodeVersion=reg["node"]["version"], variant=variant, simdCompiled=False))
            if nodes is None:
                for mode in ([static_mode] if native else modes):
                    code = (1 if variant == "compact" else 2) if mode == "candidate" else 0
                    checksum = sum(expected[model["id"]][r["id"]][mode] for r in ordered) * 2
                    row = dict(positions=3, passes=2, checksum=checksum if native else str(checksum), elapsed_ns=3000)
                    row.update(dict(warmup_passes=128, variant=code) if native else dict(kind="static", mode=mode, replicate=rep, variantCode=code))
                    values.append(row)
                    static_rows.append({**row, "kind": "static", "mode": mode, **common})
            else:
                for index, root in enumerate(ordered):
                    for mode in (["candidate", "hce"] if (index + rep) % 2 else ["hce", "candidate"]):
                        elapsed = 2000 if mode == "hce" else (800 if model["id"] == "trim" else times[(target, variant)])
                        row = dict(move="e2e4", score=expected[model["id"]][root["id"]][mode], scorePov="white", depth=4,
                            attempted_depth=5, nodes=100, qnodes=50, cutoffs=20, researches=1, stop_reason="node_limit",
                            tt_saturated=False, elapsed_ns=elapsed, requested_nodes=100)
                        row.update(dict(row=index, candidate=mode == "candidate", order_offset=rep, warmup_requests=32) if native
                                   else dict(kind="search", root=root["id"], phase=root["phase"], mode=mode, replicate=rep))
                        values.append(row)
                        search_rows.append({**row, "kind": "search", "root": root["id"], "phase": root["phase"], "mode": mode, **common})
            inventory.append(dict(id=identifier, command=command, stdinSha256=sha(stdin), returncode=0,
                stdout=put(output, identifier + ".stdout", b"".join(raw(value) for value in values)),
                stderr=put(output, identifier + ".stderr", b"")))

    combinations = [(target, variant) for target in cfg["targets"] for variant in cfg["variants"]]
    for rep in range(2):
        schedule = combinations[rep:] + combinations[:rep]  # 5*rep modulo4 for these two replicates.
        for target, variant in (schedule[::-1] if rep else schedule):
            block(target, variant, models[0], rep, "full", None)
            block(target, variant, models[0], rep, "full", 100)
    for rep in range(2):
        schedule = models[rep:] + models[:rep]
        for model in (schedule[::-1] if rep else schedule): block("wasm-scalar", "fused", model, rep, "pruning", 100)
    def choice(target):
        return {"target": target, "variant": "fused", "geometricMeanElapsedNs": float(times[(target, "fused")]),
                "scores": [dict(target=target, variant=v, geometricMeanElapsedNs=float(times[(target, v)])) for v in cfg["variants"]]}
    def closed_form(model, target, variant, elapsed):
        return dict(model=model, target=target, variant=variant, requestedNodes=100, pairs=6,
                    candidateNps=100 * 1e9 / elapsed, npsRatioToHce=2000.0 / elapsed,
                    geometricMeanElapsedNs=float(elapsed), cacheHitFraction=None)
    report = dict(schema="chessy.sparse-v2-cost-results.v1", status="complete-research-only", registrationSha256=anchor,
        fullSearchObservations=48, pruningSearchObservations=24, staticObservations=16, exactSearchSignatureGroups=9,
        allExactSignaturesMatch=True, gameOutcomesUsed=False, productionAdmission=False, environmentBefore={"affinity": [0]},
        runtimeSelection=choice("wasm-scalar"), nativeWinner=choice("native-scalar"),
        full=[closed_form("full", t, v, times[(t, v)]) for t, v in combinations],
        pruning=[closed_form("full", "wasm-scalar", "fused", 1000), closed_form("trim", "wasm-scalar", "fused", 800)],
        pruningSelection={"selected": "trim", "models": [dict(m, pairedNpsRatioToFull=1.0 if m["id"] == "full" else 1.25,
                           pairs=6, speedEligible=m["id"] != "full") for m in models]})
    for key, name, value in (("rawInventory", "raw-inventory.json", raw(inventory)),
                            ("searchObservations", "search.jsonl", b"".join(raw(r) for r in search_rows)),
                            ("staticObservationsFile", "static.jsonl", b"".join(raw(r) for r in static_rows))):
        report[key] = put(output, name, value)
    put(output, "runtime-selection.json", dict(choice("wasm-scalar"), status="frozen-before-pruning-cost-and-games"))
    put(output, "environment-before.json", report["environmentBefore"])
    put(output, "results.json", report)
    return registration / "manifest.json", anchor, output / "results.json"


class IndependentCostAudit(unittest.TestCase):
    def test_complete_fixture_passes_and_mutations_fail_closed(self):
        mutations = ("missing-block", "signature", "checksum", "forged-runtime", "forged-pruning", "canonical-row", "stderr", "anchor")
        with tempfile.TemporaryDirectory() as temporary:
            baseline = Path(temporary) / "good"; baseline.mkdir()
            args = fixture(baseline)
            receipt = audit(*args)
            self.assertEqual((receipt["fullSearchObservations"], receipt["pruningSearchObservations"]), (48, 24))
            self.assertEqual(receipt["pruningSelection"]["selected"], "trim")
            for mutation in mutations:
                with self.subTest(mutation=mutation):
                    folder = Path(temporary) / mutation; folder.mkdir()
                    registration, anchor, result = fixture(folder)
                    output = result.parent
                    report = json.loads(result.read_bytes())
                    inventory = json.loads((output / "raw-inventory.json").read_bytes())
                    if mutation == "missing-block": inventory.pop()
                    elif mutation in ("signature", "checksum"):
                        entry = next(item for item in inventory if ("-search-" if mutation == "signature" else "-static-") in item["id"])
                        values = [json.loads(line) for line in (output / entry["stdout"]["path"]).read_bytes().splitlines()]
                        values[0]["score" if mutation == "signature" else "checksum"] *= -1
                        entry["stdout"] = put(output, entry["stdout"]["path"], b"".join(raw(value) for value in values))
                    elif mutation == "forged-runtime": report["runtimeSelection"]["variant"] = "compact"
                    elif mutation == "forged-pruning": report["pruningSelection"]["models"][1]["pairedNpsRatioToFull"] = 99.0
                    elif mutation == "canonical-row":
                        rows = (output / "search.jsonl").read_bytes().splitlines()
                        report["searchObservations"] = put(output, "search.jsonl", b"\n".join(rows[:-1]) + b"\n")
                    elif mutation == "stderr": (output / inventory[0]["stderr"]["path"]).write_bytes(b"changed")
                    elif mutation == "anchor": anchor = "0" * 64
                    report["rawInventory"] = put(output, "raw-inventory.json", inventory)
                    put(output, "results.json", report)
                    with self.assertRaises(ValueError): audit(registration, anchor, result)


if __name__ == "__main__":
    unittest.main()
