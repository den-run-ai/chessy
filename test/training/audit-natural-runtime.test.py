#!/usr/bin/env python3
"""Synthetic replay checks only: no runtime searches or live result reads."""
import copy
from collections import Counter
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import chess

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("natural_runtime_audit", ROOT / "tools/training/audit-natural-runtime.py")
A = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(A)
MODULES = {"baseline": {"sha256": "b" * 64}, "candidate": {"sha256": "c" * 64}}


def task(prefix=None, color="w", max_plies=4, index=0, budget=50):
    return {"taskId": f"b{budget}-o{index}-{color}", "openingIndex": index, "openingName": "Synthetic " + str(index),
            "prefixUci": list(prefix or []), "timeMs": budget, "candidateColor": color,
            "maxPlies": max_plies, "maxDepth": 30}


def game_fixture(item, moves, modules=None):
    modules = modules or MODULES
    board = chess.Board()
    positions = Counter({A.position_key(board): 1})
    for move in item["prefixUci"]:
        A.push(board, positions, move)
    rows = [{"schema": "chessy.natural-runtime-game-header.v1", **copy.deepcopy(item), "modules": copy.deepcopy(modules)}]
    for ply, move in enumerate(moves):
        color = "w" if board.turn else "b"
        module_id = "candidate" if color == item["candidateColor"] else "baseline"
        record = {"schema": "chessy.natural-runtime-move.v1", "taskId": item["taskId"], "ply": ply,
                  "color": color, "moduleId": module_id, "moduleSha256": modules[module_id]["sha256"],
                  "fenBefore": board.fen(en_passant="fen"), "positions": dict(positions),
                  "requested": {"timeMs": item["timeMs"], "maxDepth": item["maxDepth"], "nodeLimit": 0, "quiesce": True},
                  "result": {"moveUci": move, "score": 20, "scorePov": "white", "nodes": 100,
                             "qnodes": 30, "depth": 3, "attemptedDepth": 4, "stopReason": "time-limit",
                             "cutoffs": 20, "researches": 2}, "elapsedMs": float(item["timeMs"]) + .1}
        parsed = chess.Move.from_uci(move)
        square = lambda value: (7 - chess.square_rank(value)) * 8 + chess.square_file(value)
        record["result"]["move"] = {"from": square(parsed.from_square), "to": square(parsed.to_square),
                                    "promotion": chess.piece_symbol(parsed.promotion).upper() if parsed.promotion else None}
        A.push(board, positions, move)
        record["fenAfter"] = board.fen(en_passant="fen")
        rows.append(record)
    result, reason = A.terminal(board, positions) or ("1/2-1/2", "ply-cap")
    score = .5 if result == "1/2-1/2" else float((result == "1-0") == (item["candidateColor"] == "w"))
    rows.append({"schema": "chessy.natural-runtime-game-result.v1", "taskId": item["taskId"], "searchedPlies": len(moves),
                 "finalFen": board.fen(en_passant="fen"), "result": result, "reason": reason, "candidateScore": score})
    return rows


def write(path, value, rows=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = b"".join((json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n").encode()
                   for item in (value if rows else [value]))
    path.write_bytes(raw)
    return {"path": str(path), "sha256": A.digest(raw), "bytes": len(raw), "rows": len(value) if rows else 1}


def make_bundle(directory):
    match_dir = directory / "matches"
    match_dir.mkdir()
    modules = {}
    for module_id in ("baseline", "candidate"):
        path = directory / (module_id + ".synthetic-wasm")
        raw = (module_id + " synthetic placeholder, never executed").encode()
        path.write_bytes(raw)
        modules[module_id] = {"path": str(path), "sha256": A.digest(raw), "rawBytes": len(raw), "brotliBytes": 30}
    sources = {}
    for relative in A.IMPLEMENTATION:
        path = directory / "synthetic-repo" / relative
        sources[relative] = write(path, {"syntheticSource": relative})
    train = write(directory / "shared-train.jsonl", [{"syntheticFrozenSelectionAttestation": True}], True)
    priority = lambda index: A.digest(("natural-runtime-v1|" + str(index)).encode())
    indices = sorted(range(100), key=priority)[:20]
    openings = []
    for index, move in zip(indices, list(chess.Board().legal_moves)):
        board = chess.Board()
        san = board.san(move)
        board.push(move)
        openings.append({"index": index, "name": f"Synthetic {index}", "prefixUci": [move.uci()], "san": san,
                         "fen": board.fen(en_passant="fen"), "priority": priority(index)})
    bench_positions = []
    for phase in A.PHASES:
        for index in range(32):
            source = openings[index % len(openings)]
            bench_positions.append({"id": A.digest(f"fixture-{phase}-{index}".encode()), "fen": source["fen"],
                                    "phase": phase, "prefixUci": source["prefixUci"], "sourceId": f"fixture-{phase}-{index}"})
    bench_positions.sort(key=lambda item: (A.PHASES.index(item["phase"]), item["id"]))
    registration = {"schema": "chessy.natural-runtime-registration-data.v1", "openings": openings, "benchPositions": bench_positions,
                    "inputs": {key: {field: binding[field] for field in ("sha256", "bytes")} for key, binding in (
                        ("acceptedSharedTrain", train), ("engine", sources["assets/engine.js"]),
                        ("historicalOpeningFile", sources["test/ai-match-openings.js"]))},
                    "formalHoldoutAccessAllowed": False, "incidentAccessAllowed": False}
    reg = write(directory / "registration.json", registration)
    contract = {"schema": "chessy.natural-runtime-private-contract.v1", "researchOnly": True,
                "productionIntegrationAllowed": False, "shippingOrEloClaimAllowed": False, "frozenBeforeRuntimeMeasurements": True,
                "registrationData": reg, "baseline": {"wasmSha256": modules["baseline"]["sha256"],
                                                      "rawBytes": modules["baseline"]["rawBytes"], "brotliBytes": 30},
                "candidate": {"frozenSelectionSha256": "a" * 64, "weightsSha256": "e" * 64, "testReportSha256": "d" * 64},
                "matches": {"timeBudgetsMs": [50, 200], "bothColors": True, "historicalOpeningPairs": 20,
                            "totalGames": 80, "maxDepth": 30, "maxSearchedPlies": 4, "quiesce": True,
                            "analysis": {"bootstrapReplicates": 2000, "bootstrapSeed": 1370915}},
                "microbench": {"nodeBudgets": [10000, 100000], "positions": 96, "perPhase": 32, "warmupPairsPerPositionBudget": 1,
                               "measuredPairsPerPositionBudget": 3, "maxDepth": 30, "quiesce": True, "concurrency": 1,
                               "gateAppliesToEachBudget": True, "minimumMedianPairedNpsRatio": .95, "minimumAggregateNpsRatio": .95},
                "toolchain": {"node": "22.23.2"},
                "parity": {"minimumNaturalRows": 42498}, "privateSizeGate": {"maximumRawBytes": 100, "maximumBrotliBytes": 50}}
    con = write(directory / "contract.json", contract)
    evidence = write(directory / "synthetic-build-evidence.json", {"synthetic": True})
    receipt = {"schema": "chessy.natural-runtime-build-parity.v1", "status": "PASS", "researchOnly": True,
               "contractSha256": con["sha256"], **contract["candidate"],
               "gates": {"baselineRebuildByteIdentical": True, "sizePass": True, "parityMismatches": 0, "parityRows": 42498,
                         "authoredFixtureRows": 6, "authoredFixtureMismatches": 0},
               "modules": modules, "evidence": [evidence, train], "rowEvidence": evidence, "implementation": evidence}
    rec = write(directory / "build.json", receipt)
    hashes = {module_id: {"sha256": module["sha256"]} for module_id, module in modules.items()}
    bench_rows = []
    for node_limit in contract["microbench"]["nodeBudgets"]:
        for position_index, item in enumerate(bench_positions):
            board = chess.Board()
            for move in item["prefixUci"]:
                board.push_uci(move)
            first = min(board.legal_moves, key=lambda move: move.uci()).uci()
            record = game_fixture(task(item["prefixUci"], max_plies=1), [first], hashes)[1]
            for key in ("taskId", "ply", "color", "fenAfter"):
                del record[key]
            record.update(schema="chessy.natural-runtime-bench-record.v1", positionId=item["id"], positionIndex=position_index,
                          phase=item["phase"], prefixUci=item["prefixUci"], elapsedMs=node_limit / 1000)
            record["result"].update(nodes=node_limit, stopReason="node-limit")
            record["requested"].update(timeMs=0, nodeLimit=node_limit)
            for repeat in range(4):
                order = ("candidate", "baseline") if (position_index + repeat) % 2 else ("baseline", "candidate")
                for module_id in order:
                    row = copy.deepcopy(record)
                    row.update(repeat=repeat, warmup=repeat == 0, moduleId=module_id, moduleSha256=modules[module_id]["sha256"])
                    bench_rows.append(row)
    records = write(directory / "bench-records.jsonl", bench_rows, True)
    records["path"] = Path(records["path"]).name
    bench = {"schema": "chessy.natural-runtime-bench-summary.v1", "status": "completed", "costGatePassed": True,
             "contract": con, "registration": reg, "buildReceipt": rec, "modules": modules, "records": records,
             "environment": {"node": "22.23.2"},
             "inputs": {binding["path"]: binding["sha256"] for binding in (con, reg, rec, *modules.values(), *sources.values())},
             "byBudget": {str(budget): {"pairs": 288, "medianPairedNpsRatio": 1, "aggregateNpsRatio": 1, "pass": True,
                                       **{module_id: {"totalNodes": 288 * budget, "totalElapsedMs": 288 * budget / 1000,
                                                      "p90ElapsedMs": budget / 1000} for module_id in modules}}
                          for budget in contract["microbench"]["nodeBudgets"]}}
    ben = write(directory / "bench-summary.json", bench)
    summary = {"schema": "chessy.natural-runtime-match-summary.v1", "status": "completed", "researchOnly": True,
               "shippingOrEloClaimAllowed": False, "failures": [], "contract": con, "contractSha256": con["sha256"],
               "registration": reg, "registrationSha256": reg["sha256"], "buildReceipt": rec, "modules": modules,
               "benchSummary": ben, "inputs": {**bench["inputs"], ben["path"]: ben["sha256"],
                                                 str(directory / "bench-records.jsonl"): records["sha256"]},
               "environment": {"node": "22.23.2"},
               "games": [], "outcomes": [], "searchedMoves": 0,
               "timing": {module_id: {"moves": 0, "totalNodes": 0, "totalElapsedMs": 0.0} for module_id in modules}}
    for item in A.expected_tasks(contract, registration):
        board = chess.Board()
        for uci in item["prefixUci"]:
            board.push_uci(uci)
        moves = []
        for _ in range(4):
            move = min(board.legal_moves, key=lambda value: value.uci())
            moves.append(move.uci())
            board.push(move)
        hashes = {module_id: {"sha256": module["sha256"]} for module_id, module in modules.items()}
        rows = game_fixture(item, moves, hashes)
        binding = write(match_dir / (item["taskId"] + ".jsonl"), rows, True)
        binding["path"] = Path(binding["path"]).name
        summary["games"].append({"taskId": item["taskId"], **binding})
        summary["outcomes"].append(rows[-1])
        for row in rows[1:-1]:
            summary["searchedMoves"] += 1
            timing = summary["timing"][row["moduleId"]]
            timing["moves"] += 1
            timing["totalNodes"] += row["result"]["nodes"]
            timing["totalElapsedMs"] += row["elapsedMs"]
    summary["outcomes"].sort(key=lambda value: value["taskId"])
    binding = write(match_dir / "summary.json", summary)
    args = SimpleNamespace(contract=Path(con["path"]), contract_sha256=con["sha256"], summary=Path(binding["path"]),
                           summary_sha256=binding["sha256"], output=directory / "audit.json")
    return args, summary


class GameReplayTest(unittest.TestCase):
    def test_full_prefix_and_raw_ep_fens_replay_to_checkmate(self):
        item = task(["f2f3", "e7e5"], max_plies=180)
        rows = game_fixture(item, ["g2g4", "d8h4"])
        self.assertIn(" e6 ", rows[1]["fenBefore"])
        report = A.audit_game(rows, item, MODULES)
        self.assertEqual(report["reason"], "checkmate")
        self.assertEqual(report["candidateScore"], 0)

    def test_current_threefold_and_prospective_claim_are_distinguished(self):
        moves = ["g1f3", "g8f6", "f3g1", "f6g8"] * 2
        item = task(max_plies=180)
        rows = game_fixture(item, moves)
        report = A.audit_game(rows, item, MODULES)
        self.assertEqual(report["reason"], "threefold repetition")
        short_item = task(max_plies=7)
        short = game_fixture(short_item, moves[:7])
        self.assertEqual(A.audit_game(short, short_item, MODULES)["reason"], "ply-cap")
        short[-1]["reason"] = "threefold repetition"
        with self.assertRaisesRegex(A.AuditError, "footer outcome"):
            A.audit_game(short, short_item, MODULES)

    def test_legal_ep_identity_handles_legal_absent_and_pinned_ep(self):
        fixtures = [
            ("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", "-"),
            ("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "d6"),
            ("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "-")]
        for fen, expected in fixtures:
            with self.subTest(fen=fen):
                self.assertEqual(A.position_key(chess.Board(fen)).split()[3], expected)

    def test_fifty_move_uses_current_clock_and_checkmate_has_priority(self):
        for clock, expected in ((99, None), (100, ("1/2-1/2", "fifty-move rule"))):
            board = chess.Board(f"4k3/8/8/8/8/8/8/R3K3 w - - {clock} 200")
            self.assertEqual(A.terminal(board, Counter({A.position_key(board): 1})), expected)
        mate = chess.Board("7k/6Q1/5K2/8/8/8/8/8 b - - 100 200")
        self.assertEqual(A.terminal(mate, Counter()), ("1-0", "checkmate"))
        stalemate = chess.Board("7k/5K2/6Q1/8/8/8/8/8 b - - 0 200")
        self.assertEqual(A.terminal(stalemate, Counter()), ("1/2-1/2", "stalemate"))
        kings = chess.Board("7k/8/8/8/8/8/8/K7 w - - 0 200")
        self.assertEqual(A.terminal(kings, Counter()), ("1/2-1/2", "insufficient material"))

    def test_corrupt_record_fen_history_color_requests_and_moves_fail(self):
        item = task()
        original = game_fixture(item, ["e2e4", "e7e5", "g1f3", "b8c6"])
        mutations = [
            lambda row: row.update(fenBefore=row["fenBefore"].replace(" 0 1", " 1 1")),
            lambda row: row["positions"].clear(),
            lambda row: row["positions"].update({next(iter(row["positions"])): True}),
            lambda row: row.update(moduleId="baseline"),
            lambda row: row.update(moduleSha256="d" * 64),
            lambda row: row.update(ply=True),
            lambda row: row["requested"].update(nodeLimit=1),
            lambda row: row["requested"].update(quiesce=1),
            lambda row: row["result"].update(moveUci="e2e5"),
            lambda row: row["result"]["move"].update(to=28),
            lambda row: row.update(fenAfter=row["fenBefore"]),
            lambda row: row.update(elapsedMs=float("nan"))]
        for mutate in mutations:
            rows = copy.deepcopy(original)
            mutate(rows[1])
            with self.subTest(mutation=mutate), self.assertRaises(A.AuditError):
                A.audit_game(rows, item, MODULES)

    def test_incomplete_game_and_moves_after_terminal_fail(self):
        item = task(max_plies=180)
        rows = game_fixture(item, ["e2e4", "e7e5"])
        with self.assertRaisesRegex(A.AuditError, "stopped before"):
            A.audit_game(rows, item, MODULES)
        repetitions = game_fixture(item, ["g1f3", "g8f6", "f3g1", "f6g8"] * 2 + ["g1f3"])
        with self.assertRaisesRegex(A.AuditError, "follows terminal"):
            A.audit_game(repetitions, item, MODULES)

    def test_invalid_abi_counters_and_stop_reasons_fail(self):
        result = game_fixture(task(), ["e2e4"])[1]["result"]
        mutations = ({"nodes": 0}, {"nodes": True}, {"nodes": 2 ** 53}, {"qnodes": 101}, {"cutoffs": 101},
                     {"scorePov": "black"}, {"score": 2 ** 31}, {"depth": 31}, {"attemptedDepth": 5},
                     {"stopReason": "node-limit"}, {"stopReason": "unknown"}, {"stopReason": "game-over"},
                     {"stopReason": "mate"}, {"stopReason": "max-depth"}, {"researches": -1})
        for change in mutations:
            with self.subTest(change=change), self.assertRaises(A.AuditError):
                A.validate_result({**result, **change}, 30)
        for change in ({"depth": 30, "attemptedDepth": None, "stopReason": "max-depth"},
                       {"depth": 3, "attemptedDepth": None, "stopReason": "time-limit"},
                       {"depth": 0, "attemptedDepth": 1},
                       {"score": 999990, "attemptedDepth": None, "stopReason": "mate"}):
            A.validate_result({**result, **change}, 30)

    def test_malformed_json_boolean_outcome_and_rehashed_footer_fail(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{'):
            with self.assertRaises(A.AuditError):
                A.strict_json(raw)
        item = task(["f2f3", "e7e5"], max_plies=180)
        rows = game_fixture(item, ["g2g4", "d8h4"])
        rows[-1]["candidateScore"] = False
        with self.assertRaisesRegex(A.AuditError, "footer outcome"):
            A.audit_game(rows, item, MODULES)


class CompleteBatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-runtime-replay-")
        self.addCleanup(self.temp.cleanup)
        self.args, self.summary = make_bundle(Path(self.temp.name))

    def rewrite(self):
        self.args.summary_sha256 = write(self.args.summary, self.summary)["sha256"]

    def mutate_benchmark(self, change):
        path = Path(self.summary["benchSummary"]["path"])
        bench = json.loads(path.read_text())
        raw_path = path.parent / bench["records"]["path"]
        rows = [json.loads(line) for line in raw_path.read_text().splitlines()]
        change(rows, bench)
        binding = write(raw_path, rows, True)
        bench["records"].update({key: binding[key] for key in ("sha256", "bytes", "rows")})
        self.summary["inputs"][str(raw_path)] = binding["sha256"]
        changed = write(path, bench)
        self.summary["benchSummary"].update(changed)
        self.summary["inputs"][str(path)] = changed["sha256"]
        self.rewrite()

    def test_complete_80_game_audit_statistics_and_exclusive_publication(self):
        report = A.audit(self.args)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["counts"]["games"], 80)
        self.assertEqual(report["counts"]["searchedPlies"], 320)
        self.assertEqual(report["verifiedFixedNodeBenchmark"]["records"], 1536)
        self.assertTrue(report["verifiedFixedNodeBenchmark"]["costGatePassed"])
        self.assertFalse(report["shippingOrEloClaimAllowed"])
        for group in report["diagnosticStatistics"]:
            self.assertEqual((group["wins"], group["draws"], group["losses"]), (0, 40, 0))
            self.assertEqual(group["openingPairBootstrap95PercentileInterval"], [.5, .5])
            self.assertEqual(len(group["openingPairs"]), 20)
        A.publish(self.args, report)
        self.assertEqual(json.loads(self.args.output.read_text())["status"], "PASS")
        with self.assertRaises(FileExistsError):
            A.publish(self.args, report)
        with self.assertRaisesRegex(A.AuditError, "output already exists"):
            A.audit(self.args)

    def test_missing_duplicate_and_failed_games_never_become_losses(self):
        original = copy.deepcopy(self.summary)
        mutations = [lambda value: value["games"].pop(),
                     lambda value: value["games"].__setitem__(1, value["games"][0]),
                     lambda value: value.update(status="failed"),
                     lambda value: value.update(failures=[{"taskId": "failure", "error": "timeout"}]),
                     lambda value: value.update(integrityFailure="changed"),
                     lambda value: value.update(searchedMoves=319)]
        for mutate in mutations:
            self.summary = copy.deepcopy(original)
            mutate(self.summary)
            self.rewrite()
            with self.subTest(mutation=mutate), self.assertRaises(A.AuditError):
                A.audit(self.args)
            self.assertFalse(self.args.output.exists())

    def test_actual_artifact_hash_and_rehashed_forged_footer_fail(self):
        binding = self.summary["games"][0]
        path = self.args.summary.parent / binding["path"]
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        with self.assertRaisesRegex(A.AuditError, "hash mismatch"):
            A.audit(self.args)
        rows = [json.loads(line) for line in original.splitlines()]
        rows[-1].update(result="1-0", reason="checkmate", candidateScore=1)
        changed = write(path, rows, True)
        binding.update({key: changed[key] for key in ("sha256", "bytes", "rows")})
        self.rewrite()
        with self.assertRaisesRegex(A.AuditError, "footer outcome"):
            A.audit(self.args)

    def test_rechecks_inputs_before_publication_and_rejects_symlinks(self):
        report = A.audit(self.args)
        binding = self.summary["games"][0]
        path = self.args.summary.parent / binding["path"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(A.AuditError, "hash mismatch"):
            A.publish(self.args, report)
        self.assertFalse(self.args.output.exists())
        target = path.with_suffix(".saved")
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(A.AuditError, "regular nonsymlink"):
            A.audit(self.args)

    def test_wrong_build_identity_or_registration_or_cost_gate_fail(self):
        receipt_path = Path(self.summary["buildReceipt"]["path"])
        receipt = json.loads(receipt_path.read_text())
        receipt["weightsSha256"] = "f" * 64
        identity = write(receipt_path, receipt)
        self.summary["buildReceipt"].update(identity)
        self.rewrite()
        with self.assertRaisesRegex(A.AuditError, "frozen identity"):
            A.audit(self.args)

    def test_incomplete_warmup_and_corrupt_benchmark_records_fail_after_rehash(self):
        original_summary = copy.deepcopy(self.summary)
        bench_path = Path(self.summary["benchSummary"]["path"])
        original_bench = bench_path.read_bytes()
        raw_path = bench_path.parent / json.loads(original_bench)["records"]["path"]
        original_rows = raw_path.read_bytes()
        mutations = [lambda rows, bench: rows.pop(),
                     lambda rows, bench: rows[0].update(warmup=False),
                     lambda rows, bench: rows[0]["positions"].clear(),
                     lambda rows, bench: rows[0]["requested"].update(timeMs=50),
                     lambda rows, bench: rows[0]["result"].update(stopReason="time-limit"),
                     lambda rows, bench: rows[0]["result"].update(nodes=10001),
                     lambda rows, bench: rows.__setitem__(1, rows[0])]
        for mutate in mutations:
            self.summary = copy.deepcopy(original_summary)
            bench_path.write_bytes(original_bench)
            raw_path.write_bytes(original_rows)
            self.mutate_benchmark(mutate)
            with self.subTest(mutation=mutate), self.assertRaises(A.AuditError):
                A.audit(self.args)
            self.assertFalse(self.args.output.exists())

    def test_forged_pass_cannot_hide_slow_candidate_in_complete_raw_benchmark(self):
        def slower(rows, bench):
            for row in rows:
                if row["moduleId"] == "candidate":
                    row["elapsedMs"] *= 2
            for values in bench["byBudget"].values():
                values.update({"medianPairedNpsRatio": .5, "aggregateNpsRatio": .5, "pass": False})
                values["candidate"]["totalElapsedMs"] *= 2
                values["candidate"]["p90ElapsedMs"] *= 2
            bench["costGatePassed"] = True
        self.mutate_benchmark(slower)
        with self.assertRaisesRegex(A.AuditError, "recomputed fixed-node cost gate failed"):
            A.audit(self.args)

    def test_mandatory_source_closure_cannot_be_removed_or_substituted(self):
        original = copy.deepcopy(self.summary)
        for path in list(self.summary["inputs"]):
            if "/synthetic-repo/" in path:
                del self.summary["inputs"][path]
        self.rewrite()
        with self.assertRaisesRegex(A.AuditError, "required runner implementation"):
            A.audit(self.args)
        self.summary = original
        engine_path = next(Path(path) for path in self.summary["inputs"] if path.endswith("/assets/engine.js"))
        raw = b"changed source, even though all producer hashes are resigned\n"
        engine_path.write_bytes(raw)
        self.summary["inputs"][str(engine_path)] = A.digest(raw)
        self.mutate_benchmark(lambda rows, bench: bench["inputs"].update({str(engine_path): A.digest(raw)}))
        with self.assertRaisesRegex(A.AuditError, "registered source"):
            A.audit(self.args)


if __name__ == "__main__":
    unittest.main()
