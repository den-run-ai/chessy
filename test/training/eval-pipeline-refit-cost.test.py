#!/usr/bin/env python3
"""Synthetic protocol and matched-work accounting checks; no performance gate."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("eval_pipeline_refit_cost_test", ROOT / "tools/eval_pipeline/refit_cost.py")
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)


class RefitCostContracts(unittest.TestCase):
    def setUp(self):
        self.roots = [{"id": phase + str(index), "fen": phase + str(index), "phase": phase}
                      for phase in screen.PHASES for index in range(12)]
        self.config = screen.protocol(self.roots, {"hce": "hce-simd", "full": "sparse-simd"})
        self.records = []
        times = dict(zip(screen.VARIANTS, (10, 12, 11, 10.98, 10, 9.8)))
        nodes = {"hce": 36000, "full": 36000, "no-pawn": 18000, "no-ray": 9000}
        for index, slot in enumerate(screen.schedule(self.config, self.roots)):
            family = screen.ARCHITECTURES[slot["variant"]]
            result = {"nodes": nodes[family], "qnodes": nodes[family] // 2,
                      "score": len(family), "scorePov": "white", "uci": "e2e4", "move": {"from": 52, "to": 36},
                      "stopReason": "node-limit" if nodes[family] == 36000 else "mate",
                      "engineCallMs": times[slot["variant"]]}
            response = {"ok": True, "id": index + 98, "result": result,
                        "rules": {"fen": slot["rootId"], "legalUcis": ["e2e4"]}}
            self.records.append({"index": index, **slot, "response": response,
                                 "hostRoundTripMs": result["engineCallMs"] + 1})
        self.registration = {"config": self.config, "node": {"version": "v22.14.0", "v8Version": "fixture"},
            "files": {"modules/" + name + ".wasm": {"sha256": str(index) * 64} for index, name in enumerate(screen.VARIANTS)}}
        for name in ("wasm-engine.cjs", "engine.cjs"):
            self.registration["files"]["runtime/" + name] = {"sha256": "f" * 64}
        self.info = {"id": 1, "ok": True, "result": {"abiVersion": 2, "execArgv": screen.FLAGS,
            "nodeVersion": "v22.14.0", "v8Version": "fixture",
            "engines": {name: {"sha256": str(index) * 64} for index, name in enumerate(screen.VARIANTS)},
            "loaderSha256": "f" * 64, "rulesSha256": "f" * 64}}
        self.wire = [{"request": {"op": "info", "id": 1}, "rawResponse": json.dumps(self.info), "hostRoundTripMs": 1}]
        for index, request in enumerate(screen.warmups(self.config), 2):
            response = {"id": index, "ok": True, "result": {"engineCallMs": 1}}
            self.wire.append({"request": dict(request, id=index), "rawResponse": json.dumps(response), "hostRoundTripMs": 2})
        for row in self.records:
            request = screen.request(row["variant"], row["rootId"], row["nodeBudget"], self.config)
            self.wire.append({"request": dict(request, id=row["response"]["id"]),
                              "rawResponse": json.dumps(row["response"]), "hostRoundTripMs": row["hostRoundTripMs"]})

    def report(self):
        return screen.summarize(self.config, self.roots, self.records)

    def audit(self):
        return screen.audit_protocol(self.registration, self.roots, self.records, self.wire, self.info)

    def test_complete_fixed_grid_and_unambiguous_diagnostic_scope(self):
        report = self.report()
        self.assertEqual(report["observations"], 648)
        self.assertEqual(report["selectedImplementationByRefit"], {"no-pawn": "no-pawn-scalar", "no-ray": "no-ray-simd"})
        self.assertFalse(report["productionAdmission"])
        self.assertFalse(report["gameAdmission"])
        self.assertFalse(report["gameResultsOpened"])
        self.assertEqual(report["referenceSelection"], self.config["referenceSelection"])

    def test_actual_nodes_prevent_conflating_less_work_with_faster_nps(self):
        result = self.report()["comparisons"]["no-pawn-scalar"]["full-reference"]
        self.assertAlmostEqual(result["overall"]["elapsedRatio"], 11 / 12)
        self.assertAlmostEqual(result["overall"]["actualNodeNpsRatio"], (18000 / 11) / (36000 / 12))
        self.assertEqual(result["overall"]["pairs"], 108)
        self.assertTrue(all(row["pairs"] == 36 for row in result["byPhase"].values()))

    def test_cross_architecture_searches_may_differ_but_same_model_must_match(self):
        self.assertTrue(self.report()["sameModelSignaturesPassed"])
        row = next(row for row in self.records if row["variant"] == "no-pawn-simd")
        row["response"]["result"]["qnodes"] += 1
        with self.assertRaisesRegex(ValueError, "same-model"):
            self.report()

    def test_missing_duplicate_and_changed_phase_are_rejected(self):
        good = copy.deepcopy(self.records)
        self.records.pop()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.report()
        self.records = good + [good[0]]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.report()
        self.records = good
        self.records[0]["phase"] = "endgame"
        with self.assertRaisesRegex(ValueError, "phase"):
            self.report()

    def test_invalid_budget_move_and_time_are_rejected(self):
        result = self.records[0]["response"]["result"]
        saved = copy.deepcopy(result)
        for key, value, message in (("nodes", 36001, "budget"), ("ttSaturated", True, "budget"),
                                    ("uci", "e2e5", "illegal"), ("engineCallMs", float("nan"), "finite"),
                                    ("engineCallMs", 0, "finite")):
            with self.subTest(key=key, value=value):
                result.clear(); result.update(saved); result[key] = value
                with self.assertRaisesRegex(ValueError, message):
                    self.report()

    def test_schedule_rotates_adjacent_matched_blocks_and_reverses_roots(self):
        slots = screen.schedule(self.config, self.roots)
        for start in range(0, len(slots), 6):
            block = slots[start:start + 6]
            self.assertEqual({row["variant"] for row in block}, set(screen.VARIANTS))
            self.assertEqual(len({(row["rootId"], row["replicate"]) for row in block}), 1)
        self.assertNotEqual([row["variant"] for row in slots[:6]], [row["variant"] for row in slots[6:12]])
        self.assertEqual(slots[216]["rootId"], self.roots[-1]["id"])
        self.assertEqual(slots[432]["rootId"], self.roots[0]["id"])

    def test_raw_protocol_contains_exactly_16_warmups_per_model(self):
        audit = self.audit()
        self.assertEqual(audit, {"hostInfoRequests": 1, "warmups": 96, "measuredRequests": 648,
                                 "rawRequests": 745, "completeProtocolPassed": True})
        warmups = screen.warmups(self.config)
        self.assertTrue(all(sum(row["engine"] == name for row in warmups) == 16 for name in screen.VARIANTS))

    def test_missing_warmup_reordered_requests_and_forged_response_are_rejected(self):
        saved = copy.deepcopy(self.wire)
        self.wire.pop(2)
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.audit()
        self.wire = copy.deepcopy(saved)
        self.wire[5]["request"]["fen"] = "changed"
        with self.assertRaisesRegex(ValueError, "order or identity"):
            self.audit()
        self.wire = saved
        self.records[0]["response"]["result"]["score"] += 1
        with self.assertRaisesRegex(ValueError, "raw response"):
            self.audit()

    def test_node_runtime_and_loaded_module_receipts_are_bound(self):
        self.info["result"]["nodeVersion"] = "v24.0.0"
        with self.assertRaisesRegex(ValueError, "execution profile"):
            screen.check_info(self.info, self.registration)
        self.info["result"]["nodeVersion"] = "v22.14.0"
        self.info["result"]["engines"]["no-ray-simd"]["sha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "module"):
            screen.check_info(self.info, self.registration)

    def test_timing_in_raw_protocol_cannot_exceed_round_trip(self):
        self.wire[-1]["hostRoundTripMs"] = .01
        with self.assertRaisesRegex(ValueError, "duration"):
            self.audit()

    def test_frozen_root_subset_is_first_12_in_each_phase(self):
        raw = (ROOT / "eval/sparse-pesto-v2/COST-ROOTS.json").read_bytes()
        selected = screen.select_roots(raw)
        full = json.loads(raw)
        self.assertEqual(len(selected), 36)
        for phase in screen.PHASES:
            self.assertEqual([r for r in selected if r["phase"] == phase], [r for r in full if r["phase"] == phase][:12])
        with self.assertRaisesRegex(ValueError, "frozen"):
            screen.select_roots(raw + b" ")

    def test_retained_files_authenticate_bytes_and_never_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact"
            item = screen.write(path, b"exact retained bytes")
            self.assertEqual(screen.read(path, item), b"exact retained bytes")
            with self.assertRaises(FileExistsError):
                screen.write(path, b"replacement")
            with self.assertRaisesRegex(ValueError, "identity"):
                screen.read(path, {"bytes": item["bytes"], "sha256": "0" * 64})


if __name__ == "__main__":
    unittest.main()
