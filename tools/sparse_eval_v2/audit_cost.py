#!/usr/bin/env python3
"""Independent, read-only audit of the complete registered cost experiment.

No producer imports, engine execution, benchmark reruns, or teacher-label reads.
The expected invocation sequence is reconstructed from the externally anchored
registration. Statistics and selections are recomputed from authenticated raw
child output, then compared with every published observation and summary.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys

PHASES = ("opening", "middlegame", "endgame")
SEARCH_FIELDS = ("nodes", "qnodes", "depth", "attempted_depth", "score", "move",
                 "stop_reason", "cutoffs", "researches", "tt_saturated")
VARIANT_CODE = {"compact": 1, "fused": 2, "cached": 3}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key: " + key)
            result[key] = value
        return result
    def bad_constant(value):
        raise ValueError("nonfinite JSON constant: " + value)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad_constant)


def lines(raw):
    return [decode(line) for line in raw.splitlines()]


def authenticated(directory, record):
    relative = Path(record["path"])
    require(not relative.is_absolute() and relative.parts and ".." not in relative.parts,
            "unsafe artifact path")
    path = Path(directory)
    for part in relative.parts:
        path /= part
        require(not path.is_symlink(), "symlink in artifact path")
    raw = path.read_bytes()
    require(type(record["bytes"]) is int and len(raw) == record["bytes"]
            and digest(raw) == record["sha256"], "artifact digest/length mismatch: " + str(relative))
    return raw


def geometric(values):
    values = tuple(values)
    require(values and all(math.isfinite(value) and value > 0 for value in values), "invalid geometric mean")
    # Independently use base-two logarithms and statistics.fmean, rather than
    # the producer's natural-log/fSum reducer. Compare floating summaries with
    # a tight tolerance; all inventories, signatures and checksums stay exact.
    return 2.0 ** statistics.fmean(math.log2(value) for value in values)


def equivalent(actual, expected, context):
    if isinstance(expected, dict):
        require(isinstance(actual, dict) and actual.keys() == expected.keys(), context + ": object fields differ")
        for key in expected:
            equivalent(actual[key], expected[key], context + "/" + key)
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(actual) == len(expected), context + ": list length differs")
        for index, (left, right) in enumerate(zip(actual, expected)):
            equivalent(left, right, f"{context}/{index}")
    elif type(expected) is float:
        require(type(actual) in (int, float) and math.isfinite(actual)
                and math.isclose(actual, expected, rel_tol=1e-11, abs_tol=1e-10), context + ": numeric summary differs")
    else:
        require(type(actual) is type(expected) and actual == expected, context + ": value differs")


def signed_integer(value):
    require(type(value) is int or (type(value) is str and re.fullmatch(r"-?(0|[1-9][0-9]*)", value)),
            "checksum is not a signed integer")
    return int(value)


def runtime_choice(records, targets, variants):
    candidates = defaultdict(list)
    for row in records:
        if row["mode"] == "candidate" and row["target"] in targets:
            candidates[(row["target"], row["variant"])].append(row["elapsed_ns"])
    estimates = {(target, variant): geometric(candidates[(target, variant)])
                 for target in targets for variant in variants}
    threshold = min(estimates.values()) * 1.005
    tie = sorted((pair for pair in estimates if estimates[pair] <= threshold),
                 key=lambda pair: (not pair[0].endswith("-scalar"), variants.index(pair[1]), pair[0]))[0]
    return {"target": tie[0], "variant": tie[1], "geometricMeanElapsedNs": estimates[tie],
            "scores": [{"target": target, "variant": variant, "geometricMeanElapsedNs": estimates[(target, variant)]}
                       for target in targets for variant in variants]}


def summary(records):
    paired, groups = {}, defaultdict(list)
    for row in records:
        identity = tuple(row[k] for k in ("model", "target", "variant", "replicate", "requested_nodes", "root"))
        key = identity + (row["mode"],)
        require(key not in paired, "duplicate summary observation")
        paired[key] = row
        if row["mode"] == "candidate":
            groups[(row["model"], row["target"], row["variant"], row["requested_nodes"])].append((identity, row))
    answer = {}
    for key, members in groups.items():
        nps, ratio, elapsed = [], [], []
        hits = misses = 0
        for identity, row in members:
            hce = paired[identity + ("hce",)]
            nps.append(row["nodes"] * 1e9 / row["elapsed_ns"])
            ratio.append(row["nodes"] * hce["elapsed_ns"] / (hce["nodes"] * row["elapsed_ns"]))
            elapsed.append(row["elapsed_ns"])
            hits += row.get("cacheHits", 0)
            misses += row.get("cacheMisses", 0)
        answer[key] = {"model": key[0], "target": key[1], "variant": key[2], "requestedNodes": key[3],
                       "pairs": len(members), "candidateNps": geometric(nps), "npsRatioToHce": geometric(ratio),
                       "geometricMeanElapsedNs": geometric(elapsed),
                       "cacheHitFraction": hits / (hits + misses) if hits + misses else None}
    return answer


def pruning_choice(records, models, minimum):
    candidates = {tuple(row[k] for k in ("model", "root", "replicate", "requested_nodes")): row
                  for row in records if row["mode"] == "candidate"}
    result = []
    for model in models:
        rates = []
        for identity, row in candidates.items():
            if identity[0] != model["id"]:
                continue
            full = candidates[("full", *identity[1:])]
            rates.append(row["nodes"] * full["elapsed_ns"] / (full["nodes"] * row["elapsed_ns"]))
        rate = geometric(rates)
        result.append(dict(model, pairedNpsRatioToFull=rate, pairs=len(rates),
                           speedEligible=model["id"] != "full" and rate >= minimum))
    eligible = [row for row in result if row["speedEligible"] and row["qualityGuard"]["passed"]]
    winner = None
    if eligible:
        ceiling = max(row["pairedNpsRatioToFull"] for row in eligible)
        tie = [row for row in eligible if ceiling / row["pairedNpsRatioToFull"] <= 1.005]
        winner = min(tie, key=lambda row: (row["validationCe"], row["id"]))["id"]
    return {"selected": winner, "models": result}


class CostAudit:
    def __init__(self, registration_path, external_sha256, results_path):
        self.registration_path, self.results_path = Path(registration_path), Path(results_path)
        registration_raw = self.registration_path.read_bytes()
        require(digest(registration_raw) == external_sha256, "external registration SHA256 differs")
        self.registration_sha = external_sha256
        self.reg = decode(registration_raw)
        require(self.reg["schema"] == "chessy.sparse-v2-cost-registration.v1"
                and self.reg["status"] == "frozen-before-observations", "incomplete or wrong registration")
        require(self.reg["rootSelectionUsedTeacherLabels"] is False and self.reg["gameOutcomesUsed"] is False,
                "registration selection boundary differs")
        self.inputs = {name: authenticated(self.registration_path.parent, record)
                       for name, record in self.reg["files"].items()}
        require(all(name == record["path"] for name, record in self.reg["files"].items()), "registration file aliases differ")
        self.config = self.reg["config"]
        require(self.config == decode(self.inputs["config.json"]), "embedded/retained config differs")
        require(self.config["schema"] == "chessy.sparse-v2-cost.v1" and self.config["researchOnly"] is True,
                "wrong cost policy")
        for key in ("targets", "variants", "nodeBudgets"):
            require(self.config[key] and len(self.config[key]) == len(set(self.config[key])), "duplicate/empty config axis")
        require(set(self.config["targets"]) <= {"native-scalar", "native-simd", "wasm-scalar", "wasm-simd"}
                and set(self.config["variants"]) <= VARIANT_CODE.keys(), "unknown cost axis")
        self.roots = decode(self.inputs["roots.json"])
        self.prune_roots = decode(self.inputs["pruning-roots.json"])
        self.expected = decode(self.inputs["expected-scores.json"])
        self.models = self.reg["models"]
        self._check_registration_inventories()
        self.directory = self.results_path.parent
        report_raw = self.results_path.read_bytes()
        self.report_sha = digest(report_raw)
        self.report = decode(report_raw)
        require(self.report["schema"] == "chessy.sparse-v2-cost-results.v1"
                and self.report["status"] == "complete-research-only"
                and self.report["registrationSha256"] == external_sha256, "missing/mismatched completion report")
        require((self.directory / "registration.json").read_bytes() == registration_raw, "executed registration copy differs")
        self.inventory = decode(authenticated(self.directory, self.report["rawInventory"]))
        self.published_search = lines(authenticated(self.directory, self.report["searchObservations"]))
        self.published_static = lines(authenticated(self.directory, self.report["staticObservationsFile"]))
        self.cursor = 0
        self.executed_root = None
        self.search, self.static, self.signatures = [], [], {}
        self.stderr_nonempty = 0

    def _check_registration_inventories(self):
        cfg = self.config
        require(len(self.roots) == 3 * cfg["rootsPerPhase"], "root quota differs")
        for key in ("id", "fen", "family"):
            require(len({row[key] for row in self.roots}) == len(self.roots), "duplicate root " + key)
        wanted_subset = []
        for phase in PHASES:
            rows = [row for row in self.roots if row["phase"] == phase]
            require(len(rows) == cfg["rootsPerPhase"], "phase quota differs")
            wanted_subset += rows[:cfg["pruningCost"]["rootsPerPhase"]]
        require(self.prune_roots == wanted_subset, "pruning subset/order differs")
        require(self.models and self.models[0]["id"] == "full"
                and len({row["id"] for row in self.models}) == len(self.models), "invalid model inventory")
        screen = decode(self.inputs["pruning-results.json"])
        admitted = [item for item in screen["candidates"] if item["qualityGuard"]["passed"]]
        expected_models = [{"id": item["id"], "validationCe": item["metrics"]["overall"]["ce"],
                            "qualityGuard": item["qualityGuard"], "wide": item["id"] == "king-original"} for item in admitted]
        require(self.models == expected_models, "cost models differ from complete frozen quality admission")
        for item in admitted:
            raw = self.inputs[f"models/{item['id']}.i16le"]
            require(digest(raw) == item["weights"]["sha256"] and len(raw) == item["weights"]["bytes"], "model identity differs")
            require(set(self.expected[item["id"]]) == {row["id"] for row in self.roots}, "expected-score inventory differs")
            for score in self.expected[item["id"]].values():
                require(set(score) == {"hce", "candidate"} and all(type(value) is int for value in score.values()), "invalid signed expected score")
        require(digest(self.inputs["models/full.i16le"]) == cfg["fullWeightsSha256"], "full model differs")
        for key, sha256 in self.reg["buildReceipts"].items():
            raw = self.inputs[f"builds/{key}.json"]
            require(digest(raw) == sha256, "build receipt identity differs")
            receipt = decode(raw)
            for name, expected in receipt["sourceHashes"].items():
                require(digest(self.inputs["source/" + name]) == expected, "build source identity differs")
            kind, width = key.split("-")
            require(receipt["wideFused"] == (width == "wide"), "build precision differs")
            for target in ("scalar", "simd"):
                if kind == "native":
                    entry = receipt["native"][target]
                else:
                    target_name = "scalar" if target == "scalar" else "simd128"
                    entry = next(row for row in receipt["builds"] if row["target"] == target_name)["artifacts"]["module"]
                binary = self.inputs[self.reg["binaries"][f"{kind}-{target}-{width}"]]
                require(digest(binary) == entry["sha256"] and len(binary) == entry["bytes"], "binary/build binding differs")

    def _path(self, observed, relative):
        path, suffix = Path(observed), Path(relative)
        require(path.is_absolute() and ".." not in path.parts and path.parts[-len(suffix.parts):] == suffix.parts,
                "recorded command path differs")
        parent = path
        for _ in suffix.parts:
            parent = parent.parent
        if self.executed_root is None:
            self.executed_root = parent
        require(parent == self.executed_root, "commands use mixed registration directories")
        return str(parent / suffix)

    def _consume(self, target, variant, model, replicate, stage, nodes, native_static_mode=None):
        cfg = self.config
        roots = self.roots if stage == "full" else self.prune_roots
        ordered = list(reversed(roots)) if replicate % 2 else roots
        static = nodes is None
        action = "static" if static else "search"
        identity = f"{stage}-{target}-{variant}-{model['id']}-r{replicate}-{action}-{nodes or 0}"
        native = target.startswith("native-")
        if native and static:
            identity += "-" + native_static_mode
        require(self.cursor < len(self.inventory), "missing raw invocation: " + identity)
        item = self.inventory[self.cursor]
        self.cursor += 1
        require(item["id"] == identity and type(item["returncode"]) is int and item["returncode"] == 0,
                "raw invocation order/id/success differs: " + identity)
        require(item["stdout"]["path"] == identity + ".stdout" and item["stderr"]["path"] == identity + ".stderr",
                "raw file names differ")
        stdout = authenticated(self.directory, item["stdout"])
        stderr = authenticated(self.directory, item["stderr"])
        self.stderr_nonempty += bool(stderr)
        rows = lines(stdout)
        binary_name = self.reg["binaries"][target + ("-wide" if model["wide"] else "-narrow")]
        weight_name = f"models/{model['id']}.i16le"
        command = item["command"]
        require(isinstance(command, list) and all(type(value) is str for value in command), "invalid command inventory")
        if native:
            binary = self._path(command[0], binary_name)
            weight = self._path(command[2], weight_name)
            if static:
                chosen = variant if native_static_mode == "candidate" else "hce"
                expected_command = [binary, "bench", weight, chosen, str(cfg["staticPasses"]), str(cfg["staticWarmupPasses"])]
            else:
                expected_command = [binary, "search", weight, variant, str(nodes), str(cfg["maximumDepth"]),
                                    str(replicate), str(cfg["searchWarmupCycles"])]
            require(command == expected_command, "native command/budget/order/warmup differs")
            fen_bytes = ("\n".join(row["fen"] for row in ordered) + "\n").encode()
            require(item["stdinSha256"] == digest(fen_bytes), "native input root sequence differs")
        else:
            offset = 1 + len(cfg["nodeFlags"])
            script = self._path(command[offset], "source/tools/sparse_eval_v2/cost_target.mjs")
            binary = self._path(command[offset + 1], binary_name)
            weight = self._path(command[offset + 2], weight_name)
            rules = self._path(command[offset + 4], "rules.js")
            selected_roots = self._path(command[offset + 5], "roots.json" if stage == "full" else "pruning-roots.json")
            config_path = self._path(command[offset + 6], "config.json")
            expected_command = [self.reg["node"]["path"], *cfg["nodeFlags"], script, binary, weight, variant,
                                rules, selected_roots, config_path, action, str(nodes or 0), str(replicate)]
            require(command == expected_command and item["stdinSha256"] == digest(b""), "WASM command/input differs")
            require(rows, "empty WASM output")
            info, rows = rows[0], rows[1:]
            require(info["kind"] == "metadata" and info["moduleSha256"] == digest(self.inputs[binary_name])
                    and info["weightsSha256"] == digest(self.inputs[weight_name])
                    and info["rulesSha256"] == digest(self.inputs["rules.js"])
                    and info["nodeArguments"] == cfg["nodeFlags"] and info["nodeVersion"] == self.reg["node"]["version"]
                    and info["variant"] == variant and info["simdCompiled"] is target.endswith("-simd"),
                    "WASM runtime/module/model identity differs")
        common = dict(target=target, variant=variant, model=model["id"], replicate=replicate, stage=stage, requested_nodes=nodes)
        if static:
            modes = [native_static_mode] if native else (["candidate", "hce"] if replicate % 2 else ["hce", "candidate"])
            require(len(rows) == len(modes), "incomplete static block")
            for row, mode in zip(rows, modes):
                if native:
                    require(row["warmup_passes"] == cfg["staticWarmupPasses"], "native static warmup differs")
                    require(row["variant"] == (VARIANT_CODE[variant] if mode == "candidate" else 0), "native static mode differs")
                else:
                    require(row["kind"] == "static" and row["mode"] == mode and row["replicate"] == replicate,
                            "WASM static order differs")
                    require(row["variantCode"] == (VARIANT_CODE[variant] if mode == "candidate" else 0), "WASM static mode differs")
                expected_sum = sum(self.expected[model["id"]][root["id"]][mode] for root in roots) * cfg["staticPasses"]
                require(signed_integer(row["checksum"]) == expected_sum and row["positions"] == len(roots)
                        and row["passes"] == cfg["staticPasses"] and type(row["elapsed_ns"]) is int and row["elapsed_ns"] > 0,
                        "static signed checksum/count/time differs")
                self.static.append({**row, "kind": "static", "mode": mode, **common})
        else:
            require(len(rows) == 2 * len(ordered), "incomplete search block")
            for index, row in enumerate(rows):
                ordinal, half = divmod(index, 2)
                root = ordered[ordinal]
                mode = "candidate" if (ordinal + replicate + half) % 2 else "hce"
                if native:
                    require(type(row["row"]) is int and row["row"] == ordinal
                            and type(row["candidate"]) is bool and row["candidate"] == (mode == "candidate")
                            and row["order_offset"] == replicate
                            and row["warmup_requests"] == cfg["searchWarmupCycles"] * len(cfg["warmupFens"]) * 2,
                            "native search row/order/warmup differs")
                else:
                    require(row["kind"] == "search" and row["root"] == root["id"] and row["phase"] == root["phase"]
                            and row["mode"] == mode and row["replicate"] == replicate, "WASM root/order differs")
                require(row["requested_nodes"] == nodes and row["scorePov"] == "white", "search budget/POV differs")
                for field in ("nodes", "qnodes", "depth", "cutoffs", "researches", "score", "elapsed_ns"):
                    require(type(row[field]) is int, "noninteger search field: " + field)
                require(0 < row["nodes"] <= nodes and 0 <= row["qnodes"] <= row["nodes"] and row["elapsed_ns"] > 0
                        and 0 <= row["depth"] <= cfg["maximumDepth"] and row["cutoffs"] >= 0 and row["researches"] >= 0,
                        "invalid search accounting")
                require(row["attempted_depth"] is None or (type(row["attempted_depth"]) is int
                        and 1 <= row["attempted_depth"] <= cfg["maximumDepth"]), "invalid attempted depth")
                require(row["stop_reason"] in ("node_limit", "max_depth", "mate", "game_over")
                        and row["tt_saturated"] is False, "invalid stop/saturation")
                require(row["stop_reason"] != "node_limit" or row["nodes"] == nodes, "node-limit consumption differs")
                normalized_move = None if row["move"] == "0000" else row["move"]
                require(normalized_move is None or re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", normalized_move), "invalid UCI move")
                signature = tuple(normalized_move if field == "move" else row[field] for field in SEARCH_FIELDS)
                key = (model["id"] if mode == "candidate" else "HCE", nodes, root["id"])
                require(key not in self.signatures or self.signatures[key] == signature, "cross-target/model-mode search signature differs")
                self.signatures[key] = signature
                self.search.append({**row, "kind": "search", "root": root["id"], "phase": root["phase"], "mode": mode, **common})

    def _block(self, target, variant, model, replicate, stage, nodes):
        if nodes is None and target.startswith("native-"):
            for mode in (["candidate", "hce"] if replicate % 2 else ["hce", "candidate"]):
                self._consume(target, variant, model, replicate, stage, nodes, mode)
        else:
            self._consume(target, variant, model, replicate, stage, nodes)

    def run(self):
        cfg = self.config
        combinations = list(itertools.product(cfg["targets"], cfg["variants"]))
        for replicate in range(cfg["replicates"]):
            rotation = 5 * replicate % len(combinations)
            schedule = combinations[rotation:] + combinations[:rotation]
            for target, variant in (list(reversed(schedule)) if replicate % 2 else schedule):
                for nodes in [None, *cfg["nodeBudgets"]]:
                    self._block(target, variant, self.models[0], replicate, "full", nodes)
        full = list(self.search)
        selected = runtime_choice(full, [target for target in cfg["targets"] if target.startswith("wasm-")], cfg["variants"])
        native = runtime_choice(full, [target for target in cfg["targets"] if target.startswith("native-")], cfg["variants"])
        equivalent(self.report["runtimeSelection"], selected, "runtime selection")
        equivalent(self.report["nativeWinner"], native, "native selection")
        runtime_raw = (self.directory / "runtime-selection.json").read_bytes()
        equivalent(decode(runtime_raw), dict(selected, status="frozen-before-pruning-cost-and-games"), "intermediate selection receipt")
        for replicate in range(cfg["pruningCost"]["replicates"]):
            rotation = replicate % len(self.models)
            schedule = self.models[rotation:] + self.models[:rotation]
            for model in (list(reversed(schedule)) if replicate % 2 else schedule):
                for nodes in cfg["pruningCost"]["nodeBudgets"]:
                    self._block(selected["target"], selected["variant"], model, replicate, "pruning", nodes)
        require(self.cursor == len(self.inventory), "extra raw invocations outside registered grid")
        require(self.search == self.published_search and self.static == self.published_static,
                "published observations differ from raw output reconstruction")
        pruned = self.search[len(full):]
        selected_pruning = pruning_choice(pruned, self.models, cfg["pruningCost"]["minimumNpsRatioToFull"])
        equivalent(self.report["pruningSelection"], selected_pruning, "pruning selection")
        for name, rows in (("full", full), ("pruning", pruned)):
            published = {}
            for item in self.report[name]:
                key = tuple(item[field] for field in ("model", "target", "variant", "requestedNodes"))
                require(key not in published, "duplicate published summary")
                published[key] = item
            recomputed = summary(rows)
            require(published.keys() == recomputed.keys(), "incomplete published summary")
            for key in recomputed:
                equivalent(published[key], recomputed[key], name + "/" + str(key))
        require(self.report["fullSearchObservations"] == len(full)
                and self.report["pruningSearchObservations"] == len(pruned)
                and self.report["staticObservations"] == len(self.static)
                and self.report["exactSearchSignatureGroups"] == len(self.signatures)
                and self.report["allExactSignaturesMatch"] is True
                and self.report["gameOutcomesUsed"] is False and self.report["productionAdmission"] is False,
                "completion counts/boundaries differ")
        require(decode((self.directory / "environment-before.json").read_bytes()) == self.report["environmentBefore"],
                "environment-before artifact differs")
        return {"schema": "chessy.sparse-v2-cost-independent-audit.v1", "status": "pass",
                "registrationSha256": self.registration_sha, "resultsSha256": self.report_sha,
                "rawInvocations": self.cursor, "fullSearchObservations": len(full), "pruningSearchObservations": len(pruned),
                "staticObservations": len(self.static), "exactSearchSignatureGroups": len(self.signatures),
                "rawStderrNonempty": self.stderr_nonempty, "runtimeSelectionSha256": digest(runtime_raw),
                "runtimeSelection": selected, "nativeWinner": native, "pruningSelection": selected_pruning,
                "executedRegistrationDirectory": str(self.executed_root),
                "numericTolerance": {"relative": 1e-11, "absolute": 1e-10},
                "engineCalls": 0, "benchmarkReruns": 0, "teacherLabelsRead": False,
                "independentReducer": True, "productionAdmission": False}


def audit(registration, external_sha256, results):
    return CostAudit(registration, external_sha256, results).run()


def save_exclusive(path, raw):
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registration", type=Path)
    parser.add_argument("registration_sha256")
    parser.add_argument("results", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    implementation = Path(__file__).read_bytes()
    args.output.mkdir(parents=True, exist_ok=False)
    save_exclusive(args.output / "audit_cost.py", implementation)
    try:
        receipt = audit(args.registration, args.registration_sha256, args.results)
        require(Path(__file__).read_bytes() == implementation, "audit implementation changed while running")
    except Exception as error:
        failure = {"schema": "chessy.sparse-v2-cost-independent-audit.v1", "status": "fail",
                   "registrationSha256": args.registration_sha256, "error": str(error),
                   "implementationSha256": digest(implementation)}
        save_exclusive(args.output / "failure.json", (json.dumps(failure, sort_keys=True) + "\n").encode())
        raise
    receipt["implementationSha256"] = digest(implementation)
    raw = (json.dumps(receipt, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    save_exclusive(args.output / "audit.json", raw)
    print(json.dumps({"status": "pass", "audit": str(args.output / "audit.json"), "sha256": digest(raw)}))


if __name__ == "__main__":
    main()
