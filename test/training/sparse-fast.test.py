#!/usr/bin/env python3
"""Differential contracts for the cost-only adjacent-occupied-pair evaluator."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import features
import export as codec

spec = importlib.util.spec_from_file_location("sparse_reference_fixtures", Path(__file__).with_name("sparse-features.test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def pair_boards():
    """Every realizable piece-code pair, all four axes, with occupied gaps."""
    result = []
    for first, second in ((8, 12), (9, 41), (9, 36), (12, 33)):
        for a in range(1, 13):
            for b in range(1, 13):
                if a == b and a in (6, 12):
                    continue  # Two same-color kings are not representable roots.
                board = [0] * 64
                if a != 6 and b != 6:
                    board[7] = 6
                if a != 12 and b != 12:
                    board[56] = 12
                board[first], board[second] = a, b
                result.append(fixtures.board_fen(board))
    return result


class FastEvaluator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc")
        if not compiler:
            raise unittest.SkipTest("native Rust unavailable; CI must use pinned compiler")
        cls.directory = tempfile.TemporaryDirectory()
        cls.binaries = {}
        for name, extra in (("reference", []), ("fast", ["--cfg", "sparse_fast"])):
            binary = str(Path(cls.directory.name) / name)
            subprocess.run([compiler, "--edition=2021", "-O", *extra,
                            str(ROOT / "tools/sparse_eval/runtime.rs"), "-o", binary],
                           check=True, capture_output=True)
            cls.binaries[name] = binary
        cls.rows = fixtures.AUTHORED + fixtures.generated() + pair_boards()
        cls.rows += [fixtures.mirrored(fen) for fen in cls.rows]

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "directory"):
            cls.directory.cleanup()

    def run_model(self, name, weights, command="eval", rows=None, compact=False):
        model = Path(self.directory.name) / (name + ".weights")
        model.write_bytes(codec.encode(weights) if compact else struct.pack("<" + "h" * features.N_FEATURES, *weights))
        args = [self.binaries[name], command, str(model)]
        if command == "search":
            args.append("1024")
        result = subprocess.run(args, input="\n".join(self.rows if rows is None else rows) + "\n",
                                capture_output=True, text=True, check=True)
        return result.stdout

    def test_all_families_piece_pairs_color_orientation_and_extremes(self):
        zero = [0] * features.N_FEATURES
        recipes = {"zero": zero,
                   "distinct": [((i * 15427 + 17) % 401) - 200 for i in range(features.N_FEATURES)],
                   "extreme": [-32768 if i % 2 else 32767 for i in range(features.N_FEATURES)]}
        for family, (start, end) in features.FAMILIES.items():
            weights = list(zero)
            for offset in (0, features.BASE_FEATURES):
                for index in range(start, end):
                    weights[index + offset] = ((index * 1147 + offset) % 53) - 26
            recipes[family] = weights
        for name, weights in recipes.items():
            with self.subTest(model=name):
                expected = self.run_model("reference", weights)
                actual = self.run_model("fast", weights)
                self.assertEqual(actual, expected)
                self.assertEqual(len(actual.splitlines()), len(self.rows))
        # Independent Python arithmetic on authored moves and negative ties.
        weights = recipes["distinct"]
        for fen, line in zip(fixtures.AUTHORED, self.run_model("fast", weights, rows=fixtures.AUTHORED).splitlines()):
            baseline, score, correction = map(int, line.split())
            self.assertEqual(baseline, features.baseline_score(fen))
            self.assertEqual(correction, features.correction(fen, weights, integer=True))
            self.assertEqual(score, baseline + correction)

    def test_compact_weights_preserve_fast_scores(self):
        weights = [((i * 7) % 31) - 15 if i % 5 == 0 else 0 for i in range(features.N_FEATURES)]
        self.assertEqual(self.run_model("fast", weights), self.run_model("fast", weights, compact=True))

    def test_search_signatures_preserved_for_authored_roots(self):
        weights = [((i * 1531) % 71) - 35 if i % 3 == 0 else 0 for i in range(features.N_FEATURES)]
        rows = fixtures.AUTHORED[:2] + fixtures.AUTHORED[4:11] + fixtures.AUTHORED[12:14]
        def signatures(text):
            return sorted((r["row"], r["candidate"], r["nodes"], r["qnodes"], r["depth"], r["score"], r["move"])
                          for r in map(json.loads, text.splitlines()))
        self.assertEqual(signatures(self.run_model("fast", weights, "search", rows)),
                         signatures(self.run_model("reference", weights, "search", rows)))


if __name__ == "__main__":
    unittest.main()
