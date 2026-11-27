#!/usr/bin/env python3
"""Cost selection, independent-root grouping, and raw evidence fail-closed checks."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.sparse_eval_v2.cost import (bound, choose_pruned, choose_runtime, encoded,
                                      select_roots, sha, validate_rows)


class Cost(unittest.TestCase):
    def test_family_unique_label_blind_selection_and_old_root_exclusion(self):
        fens = [f"root-{i}" for i in range(18)]
        phases = [20] * 6 + [12] * 6 + [3] * 6
        families = [i // 2 for i in range(18)]
        roots = select_roots(fens, phases, families, {"root-0"}, "salt", 2)
        self.assertEqual(len(roots), 6)
        self.assertEqual(len({r["family"] for r in roots}), 6)
        self.assertNotIn("root-0", [r["fen"] for r in roots])
        self.assertEqual(roots, select_roots(fens, phases, families, {"root-0"}, "salt", 2))
        with self.assertRaises(ValueError):
            select_roots(fens, phases, [0] * 18, set(), "salt", 2)

    def test_runtime_ties_prefer_scalar_and_no_hce_time_selection(self):
        rows = []
        for target, variant, elapsed in [("wasm-simd", "cached", 1000),
                                          ("wasm-scalar", "cached", 1004),
                                          ("wasm-simd", "fused", 1200),
                                          ("wasm-scalar", "fused", 1300)]:
            rows.append(dict(target=target, variant=variant, elapsed_ns=elapsed, mode="candidate"))
            rows.append(dict(target=target, variant=variant, elapsed_ns=1, mode="hce"))
        winner = choose_runtime(rows, ["wasm-scalar", "wasm-simd"], ["fused", "cached"])
        self.assertEqual((winner["target"], winner["variant"]), ("wasm-scalar", "cached"))

    def test_pruning_requires_real_nps_gain_and_quality_then_ce_tiebreak(self):
        models = [{"id": name, "validationCe": ce, "qualityGuard": {"passed": quality}}
                  for name, ce, quality in [("full", .67, True), ("short-mate", .67, True),
                                            ("better-ce", .671, True), ("fast", .672, True),
                                            ("bad-quality", .70, False)]]
        rows = [{"model": name, "root": "r", "replicate": 0, "requested_nodes": 10000,
                 "mode": "candidate", "nodes": nodes, "elapsed_ns": ns}
                for name, nodes, ns in [("full", 10000, 10000), ("short-mate", 5000, 5000),
                                         ("better-ce", 10000, 9100), ("fast", 10000, 9080),
                                         ("bad-quality", 10000, 1000)]]
        result = choose_pruned(rows, models)
        self.assertEqual(result["selected"], "better-ce")
        self.assertEqual(result["models"][1]["pairedNpsRatioToFull"], 1.)
        self.assertFalse(result["models"][1]["speedEligible"])

    def test_complete_root_budget_and_order_are_required(self):
        root = {"id": "r", "phase": "opening"}
        row = {"root": "r", "phase": "opening", "nodes": 10000, "qnodes": 4000,
               "elapsed_ns": 100, "depth": 4, "attempted_depth": 5, "cutoffs": 30,
               "researches": 2, "score": 22, "stop_reason": "node_limit", "tt_saturated": False,
               "move": "e2e4"}
        rows = [dict(row, mode="hce"), dict(row, mode="candidate")]
        validate_rows(rows, [root], 0, 10000)
        for altered in (rows[:1], rows[::-1], [dict(rows[0], nodes=9999), rows[1]],
                        [dict(rows[0], tt_saturated=True), rows[1]]):
            with self.assertRaises(ValueError): validate_rows(altered, [root], 0, 10000)

    def test_retained_bytes_and_path_are_authenticated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); raw = encoded({"a": 1})
            (root / "x").write_bytes(raw)
            item = {"path": "x", "bytes": len(raw), "sha256": sha(raw)}
            self.assertEqual(bound(root, item), raw)
            (root / "x").write_bytes(encoded({"a": 2}))
            with self.assertRaises(ValueError): bound(root, item)
            with self.assertRaises(ValueError): bound(root, dict(item, path="../x"))


if __name__ == "__main__":
    unittest.main()
