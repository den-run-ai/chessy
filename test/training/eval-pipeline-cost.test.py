#!/usr/bin/env python3
"""Reject incomplete or changed cost evidence; no timing thresholds in CI."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.eval_pipeline import cost


class CostTests(unittest.TestCase):
    def setUp(self):
        self.roots = [{"id": name, "fen": name, "phase": name} for name in ("opening", "middlegame", "endgame")]
        self.config = {"replicates": 2, "nodeBudgets": [100, 200]}
        self.records = []
        for name in cost.VARIANTS:
            for root in self.roots:
                for rep in range(2):
                    for budget in (100, 200):
                        self.records.append({"variant": name, "rootId": root["id"], "phase": root["phase"],
                            "replicate": rep, "nodeBudget": budget, "response": {"ok": True,
                            "result": {"nodes": budget, "qnodes": budget // 2, "score": 12,
                                       "uci": "e2e4", "stopReason": "node-limit",
                                       "engineCallMs": 2 if name.startswith('sparse-') else 1},
                            "rules": {"fen": root["fen"], "legalUcis": ["e2e4"]}}})

    def report(self):
        return cost.summarize(self.config, self.roots, self.records)

    def test_complete_matched_grid_and_tie_rule(self):
        result = self.report()
        self.assertEqual(result["selectedHce"], "baseline-memory")
        self.assertEqual(result["selectedFull"], "sparse-scalar")
        self.assertAlmostEqual(result["fullNpsRelativeToSelectedHce"], .5)
        self.assertFalse(result["productionAdmission"])

    def test_missing_and_duplicate_are_not_averaged_away(self):
        good = copy.deepcopy(self.records)
        self.records.pop()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.report()
        self.records = good + [good[0]]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.report()

    def test_exact_search_mismatch_blocks_selection(self):
        self.records[0]["response"]["result"]["qnodes"] += 1
        with self.assertRaisesRegex(ValueError, "signature"):
            self.report()

    def test_changed_position_and_illegal_move_block_selection(self):
        self.records[0]["response"]["rules"]["fen"] = "other"
        with self.assertRaisesRegex(ValueError, "position"):
            self.report()
        self.records[0]["response"]["rules"]["fen"] = "opening"
        self.records[0]["response"]["result"]["uci"] = "e2e5"
        with self.assertRaisesRegex(ValueError, "illegal"):
            self.report()

    def test_nonfinite_or_zero_time_rejected(self):
        self.records[0]["response"]["result"]["engineCallMs"] = float('nan')
        with self.assertRaisesRegex(ValueError, "finite"):
            self.report()
        self.records[0]["response"]["result"]["engineCallMs"] = 0
        with self.assertRaisesRegex(ValueError, "failed"):
            self.report()

    def test_changed_phase_rejected_and_order_is_balanced(self):
        slots = cost.schedule(self.config, self.roots)
        self.assertEqual(len(slots), len(self.records))
        self.assertEqual({s['variant'] for s in slots[:6]}, set(cost.VARIANTS))
        self.assertNotEqual([s['variant'] for s in slots[:6]], [s['variant'] for s in slots[6:12]])
        self.records[0]['phase'] = 'endgame'
        with self.assertRaisesRegex(ValueError, "material phase"):
            self.report()

    def test_over_budget_and_false_node_limit_rejected(self):
        self.records[0]['response']['result']['nodes'] += 1
        with self.assertRaisesRegex(ValueError, "node budget"):
            self.report()
        self.records[0]['response']['result']['nodes'] -= 2
        with self.assertRaisesRegex(ValueError, "node budget"):
            self.report()


if __name__ == '__main__':
    unittest.main()
