#!/usr/bin/env python3
"""The new cost protocol cannot admit changed scores or incomplete signatures."""
from pathlib import Path
import copy
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval.measure_fast import validate_config, compare_search, SIGNATURE


class FastProtocolTests(unittest.TestCase):
    def test_frozen_new_protocol(self):
        config = json.loads((ROOT / "eval/sparse-pesto-v1/RUNTIME-FAST-CONFIG.json").read_text())
        validate_config(config)
        for key, value in (("replicates", 1), ("model", "full-sparse"), ("positions", 20),
                           ("changeClass", "changed-evaluation"), ("weightsSha256", "missing")):
            with self.assertRaises(ValueError):
                validate_config(dict(config, **{key: value}))

    @staticmethod
    def rows():
        result = []
        for runtime in ("reference", "fast"):
            for candidate in (False, True):
                result.append({"runtime": runtime, "requested_nodes": 10000, "replicate": 0,
                               "positionIndex": 3, "candidate": candidate, "phaseBucket": "opening",
                               "fenSha256": "same-position", "nodes": 10000, "qnodes": 2000,
                               "depth": 5, "score": 10 if candidate else 0, "move": "e2e4",
                               "elapsed_ns": 100 if not candidate else 300 if runtime == "reference" else 200,
                               "consumedRequestedNodes": True})
        return result

    def test_equal_signatures_preserve_direct_and_hce_relative_ratios(self):
        result = compare_search(self.rows())
        self.assertEqual(result["signatureComparisons"], 2)
        overall = next(r for r in result["summary"] if r["phaseBucket"] == "all")
        self.assertAlmostEqual(overall["referenceOverFastTimeGeometricMean"], 1.5)
        self.assertAlmostEqual(overall["referenceCandidateOverHceNpsGeometricMean"], 1/3)
        self.assertAlmostEqual(overall["fastCandidateOverHceNpsGeometricMean"], 1/2)

    def test_every_search_signature_field_is_enforced(self):
        for field in SIGNATURE:
            rows = self.rows()
            rows[-1][field] = "d2d4" if field == "move" else rows[-1][field] + 1
            with self.assertRaisesRegex(ValueError, "signature mismatch"):
                compare_search(rows)

    def test_identity_missing_duplicate_or_hce_pair_is_rejected(self):
        rows = self.rows()
        changed = copy.deepcopy(rows); changed[-1]["fenSha256"] = "another"
        for wrong in (rows[:-1], rows + rows[:1], changed, [r for r in rows if r["candidate"]]):
            with self.assertRaises(ValueError):
                compare_search(wrong)

    def test_early_termination_retains_actual_node_counts(self):
        rows = self.rows()
        for row in rows:
            if row["candidate"]:
                row["nodes"] = 5000
                row["consumedRequestedNodes"] = False
        result = compare_search(rows)
        overall = next(r for r in result["summary"] if r["phaseBucket"] == "all")
        self.assertEqual(overall["bothConsumedRequestedNodes"], 0)
        self.assertAlmostEqual(overall["referenceOverFastTimeGeometricMean"], 1.5)
        self.assertAlmostEqual(overall["fastCandidateOverHceNpsGeometricMean"], .25)


if __name__ == "__main__":
    unittest.main()
