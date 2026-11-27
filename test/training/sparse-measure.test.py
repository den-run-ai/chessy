#!/usr/bin/env python3
"""Deterministic measurement selection, pairing, arithmetic and failure tests."""
from pathlib import Path
import copy
import json
import sys
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval.measure import (validate_config, select_positions, validate_parity,
                                     validate_static, validate_search, summarize_search, geometric_mean)


class SelectionTests(unittest.TestCase):
    def test_frozen_config_rejects_changed_budget_or_selected_models(self):
        config = json.loads((ROOT / "eval/sparse-pesto-v1/RUNTIME-CONFIG.json").read_text())
        validate_config(config)
        for key, value in (("models", ["full"]), ("nodeBudgets", [10000]), ("positionsPerPhase", 7)):
            changed = dict(config, **{key: value})
            with self.assertRaises(ValueError):
                validate_config(changed)

    def test_selection_is_order_independent_and_stratified(self):
        fens = [f"fixture-{i}" for i in range(60)]
        phases = [20] * 20 + [10] * 20 + [0] * 20
        left = select_positions(fens, phases)
        right = select_positions(list(reversed(fens)), list(reversed(phases)))
        self.assertEqual([r["fen"] for r in left], [r["fen"] for r in right])
        self.assertEqual([r["phaseBucket"] for r in left], ["opening"] * 8 + ["middlegame"] * 8 + ["endgame"] * 8)
        for phase in ("opening", "middlegame", "endgame"):
            keys = [r["fenSha256"] for r in left if r["phaseBucket"] == phase]
            self.assertEqual(keys, sorted(keys))

    def test_shortfall_duplicate_and_phase_mismatch_rejected(self):
        for fens, phases in ((["a"], [24]), (["a", "a"], [24, 0]), (["a"], []), (["a"], [25])):
            with self.assertRaises(ValueError):
                select_positions(fens, phases)


class EvidenceTests(unittest.TestCase):
    def test_full_integer_parity_and_mutations(self):
        raw = b"10 12 2\n-10 -11 -1\n"
        report = validate_parity(raw, np.array([10, -10]), np.array([12, -11]))
        self.assertEqual(report["rows"], 2)
        for bad in (b"10 13 3\n-10 -11 -1\n", b"10 12 1\n-10 -11 -1\n", b"10 12 2\n"):
            with self.assertRaises(ValueError):
                validate_parity(bad, np.array([10, -10]), np.array([12, -11]))

    def test_static_checksum_pass_count_and_timing(self):
        value = {"positions": 2, "passes": 6000, "baseline_checksum": 18000, "candidate_checksum": 30000,
                 "baseline_ns": 100, "candidate_ns": 200}
        report = validate_static(json.dumps(value), [0, 1], 6000, np.array([1, 2]), np.array([2, 3]))
        self.assertEqual(report["baselineOverCandidateTime"], .5)
        for key, bad in (("candidate_checksum", 30001), ("passes", 5999), ("baseline_ns", 0)):
            with self.assertRaises(ValueError):
                validate_static(json.dumps(dict(value, **{key: bad})), [0, 1], 6000, np.array([1, 2]), np.array([2, 3]))

    @staticmethod
    def positions():
        return [{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                 "positionIndex": 7, "phaseBucket": "opening", "fenSha256": "fixture"}]

    @staticmethod
    def search_raw(early=False):
        values = []
        for candidate in (False, True):
            values.append({"row": 0, "candidate": candidate, "requested_nodes": 10000,
                           "nodes": 5000 if early and candidate else 10000, "qnodes": 1000,
                           "depth": 5, "score": 12, "move": "e2e4", "elapsed_ns": 200 if candidate else 100})
        return values

    def test_search_preserves_early_termination_and_distinguishes_nps(self):
        raw = b"\n".join(json.dumps(v).encode() for v in self.search_raw(early=True))
        rows = validate_search(raw, self.positions(), 10000, "pst", 0)
        summary = summarize_search(rows)["summary"][0]
        self.assertEqual(summary["pairs"], 1)
        self.assertEqual(summary["bothConsumedRequestedNodes"], 0)
        self.assertAlmostEqual(summary["timeRatioGeometricMean"], .5)
        self.assertAlmostEqual(summary["npsRatioGeometricMean"], .25)
        self.assertIsNone(summary["fullBudgetTimeRatioGeometricMean"])

    def test_missing_duplicate_illegal_or_wrong_budget_rows_rejected(self):
        cases = []
        original = self.search_raw()
        cases.append(original[:1])
        cases.append([original[0], original[0]])
        for key, value in (("move", "e2e5"), ("requested_nodes", 36000), ("nodes", 10001), ("elapsed_ns", 0), ("candidate", 1)):
            bad = copy.deepcopy(original)
            bad[1][key] = value
            cases.append(bad)
        for case in cases:
            with self.assertRaises(ValueError):
                validate_search(b"\n".join(json.dumps(v).encode() for v in case), self.positions(), 10000, "pst", 0)

    def test_summary_requires_same_position_and_complete_pair(self):
        raw = b"\n".join(json.dumps(v).encode() for v in self.search_raw())
        rows = validate_search(raw, self.positions(), 10000, "pst", 0)
        with self.assertRaises(ValueError):
            summarize_search(rows[:1])
        rows[1]["fenSha256"] = "another"
        with self.assertRaises(ValueError):
            summarize_search(rows)

    def test_geometric_mean_is_paired_not_arithmetic(self):
        self.assertAlmostEqual(geometric_mean([.5, 2]), 1)
        self.assertIsNone(geometric_mean([]))
        with self.assertRaises(ValueError):
            geometric_mean([0])


if __name__ == "__main__":
    unittest.main()
