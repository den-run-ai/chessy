#!/usr/bin/env python3
"""The v1 bug must fail even when Python/JS arithmetic parity passes."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
from h4_ablation import require_explicit_mop_up, mop_up_reference


class AblationSemantics(unittest.TestCase):
    def test_retired_v1_and_wrong_feature_fail_closed(self):
        contract = json.loads((ROOT / "eval/training/natural-nnue-h4-v1.json").read_text())
        with self.assertRaisesRegex(ValueError, "fixedCp includes material"):
            require_explicit_mop_up(contract)
        contract["model"]["additiveFeature"] = "fixedCp"
        with self.assertRaises(ValueError):
            require_explicit_mop_up(contract)
        contract["model"]["additiveFeature"] = "mopUpCp"
        require_explicit_mop_up(contract)

    def test_material_is_not_mop_up(self):
        pawn, queen = mop_up_reference([
            "4k3/7p/8/8/8/8/PP6/4K3 w - - 0 1",
            "4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1",
        ])
        self.assertEqual(pawn["mopUpCp"], 0)
        self.assertEqual(pawn["fixedCp"], 94)
        self.assertEqual(queen["mopUpCp"], 38)
        self.assertGreater(queen["fixedTaperCp"], 900)
        self.assertNotEqual(queen["fixedCp"], queen["mopUpCp"])


if __name__ == "__main__":
    unittest.main()
