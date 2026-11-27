#!/usr/bin/env python3
"""Semantic tests for the standalone sparse PeSTO research implementation.

The tests do not read corpus labels or historical match/test outcomes. Native
parity is required when SPARSE_EVAL_RUSTC or rustc is available; CI should set
SPARSE_EVAL_RUSTC to its already pinned compiler.
"""
import array
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import features as f

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AUTHORED = [
    START,
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "4k3/8/8/8/3N4/8/8/4K3 w - - 0 1",
    "4k3/8/8/5p2/4N3/3P4/8/4K3 w - - 0 1",
    "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",  # castled
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",   # EP available
    "4k3/8/3P4/8/8/8/8/4K3 b - - 0 2",    # EP applied
    "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",     # promotion edge
    "N3k3/8/8/8/8/8/8/4K3 b - - 0 1",     # knight promotion
    "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1",     # queen promotion
    "8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1",
    "8/8/8/8/8/8/3k4/R3K3 w - - 0 1",
    "8/8/8/8/8/8/4K3/r3k3 b - - 0 1",
    "3k4/PPPPPPPP/QQQQQQQQ/NNNNNNNN/8/8/8/3K4 w - - 0 1",  # capped phase
]


def board_fen(board, turn=0):
    rows = []
    for rank in range(7, -1, -1):
        row = ""
        empty = 0
        for file in range(8):
            piece = board[rank * 8 + file]
            if not piece:
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += f.PIECE_CHARS[piece]
        if empty:
            row += str(empty)
        rows.append(row)
    return "/".join(rows) + (" b" if turn else " w") + " - - 0 1"


def mirrored(fen):
    position = f.parse_fen(fen)
    board = [0] * 64
    for square, piece in enumerate(position.board):
        if piece:
            board[square ^ 56] = piece + 6 if piece <= 6 else piece - 6
    return board_fen(board, 1 - position.turn)


def generated():
    rng = random.Random(20261127)
    rows = []
    for _ in range(192):
        board = [0] * 64
        occupied = rng.sample(range(64), rng.randint(2, 32))
        board[occupied[0]] = 6
        board[occupied[1]] = 12
        for square in occupied[2:]:
            board[square] = rng.choice([1, 2, 3, 4, 5, 7, 8, 9, 10, 11])
        rows.append(board_fen(board, rng.randrange(2)))
    return rows


class FeatureSemantics(unittest.TestCase):
    def test_capacity_and_frozen_ids(self):
        self.assertEqual(f.N_FEATURES, 17280)
        self.assertGreaterEqual(f.N_FEATURES, 9650)
        self.assertEqual(f.king_bucket(0), 0)
        self.assertEqual(f.king_bucket(4), 2)
        self.assertEqual(f.king_bucket(60), 6)
        raw, phase = f.extract_raw(AUTHORED[2])
        self.assertEqual(phase, 1)
        # Manual board geometry: White Nd4, kings e1/e8 cancel exactly.
        self.assertEqual(raw, {91: 1, 1243: 1, 5851: 1, 6619: 1})

    def test_pawn_support_and_threat_are_distinct_bits(self):
        raw, _ = f.extract_raw(AUTHORED[3])
        # Ne4 is supported by Pd3 and attacked by pf5: context 3, PSQT index 92.
        self.assertEqual(raw[6528 + 3 * 384 + 92], 1)
        # Pf5 itself is neither supported by a black pawn nor attacked by white.
        self.assertEqual(raw[6528 + (37 ^ 56)], -1)

    def test_direction_is_piece_relative_and_first_blocker_only(self):
        fen = "4k3/8/8/8/2p5/2P5/2R5/4K3 w - - 0 1"
        raw, _ = f.extract_raw(fen, ["ray"])
        # White rook c2 sees own pawn c3 north; the black c4 pawn is screened.
        north_rook_own_pawn = 8064 + (((3 * 6) * 2) * 8)
        north_rook_enemy_pawn = north_rook_own_pawn + 8
        self.assertEqual(raw[north_rook_own_pawn], 1)
        self.assertNotIn(north_rook_enemy_pawn, raw)

    def test_taper_and_mirror_negation(self):
        for fen in AUTHORED + generated():
            raw, phase = f.extract_raw(fen)
            reverse, other_phase = f.extract_raw(mirrored(fen))
            self.assertEqual(other_phase, phase)
            self.assertEqual(reverse, {index: -count for index, count in raw.items()})
            ids, values = f.extract(fen)
            self.assertEqual(ids, sorted(set(ids)))
            self.assertTrue(all(0 <= index < 17280 for index in ids))
            self.assertTrue(all(value != 0 for value in values))
        self.assertEqual(f.extract_raw(AUTHORED[-1])[1], 24)
        ids, _ = f.extract(AUTHORED[-1])
        self.assertTrue(all(index < f.BASE_FEATURES for index in ids))

    def test_distinct_weights_and_exact_symmetric_rounding(self):
        weights = [0] * f.N_FEATURES
        weights[91] = 12
        # One MG phase /24 turns 12cp into a positive half tie.
        self.assertEqual(f.correction(AUTHORED[2], weights, integer=True), 1)
        self.assertEqual(f.correction(mirrored(AUTHORED[2]), weights, integer=True), -1)
        self.assertEqual(f.correction(AUTHORED[2], weights), 0.5)
        weights[91] = 0.25
        with self.assertRaises(ValueError):
            f.correction(AUTHORED[2], weights, integer=True)

    def test_hce_known_golden_scores(self):
        expected = [(AUTHORED[0], 0), (AUTHORED[1], 57), (AUTHORED[11], -76),
                    (AUTHORED[12], 519), (AUTHORED[13], -562)]
        for fen, score in expected:
            self.assertEqual(f.baseline_score(fen), score)

    def test_bad_inputs_and_unknown_families(self):
        for fen in ["", "8/8/8/8/8/8/8/8 w - - 0 1",
                    "4k3/8/8/8/8/8/8/4KK2 w - - 0 1",
                    START.replace("KQkq", "KK"), START.replace(" - ", " e4 ")]:
            with self.assertRaises(ValueError):
                f.parse_fen(fen)
        with self.assertRaises(ValueError):
            f.extract(START, ["unknown"])


class NativeParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rustc = os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc")
        if not rustc:
            raise unittest.SkipTest("native Rust unavailable; CI must run with pinned SPARSE_EVAL_RUSTC")
        cls.temporary = tempfile.TemporaryDirectory()
        cls.binary = str(Path(cls.temporary.name) / "sparse-eval")
        subprocess.run([rustc, "--edition=2021", "-O", str(ROOT / "tools/sparse_eval/runtime.rs"),
                        "-o", cls.binary], check=True, capture_output=True, text=True)
        cls.rows = AUTHORED + generated()
        cls.rows += [mirrored(fen) for fen in cls.rows]

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "temporary"):
            cls.temporary.cleanup()

    def native(self, command, *arguments, rows=None):
        run = subprocess.run([self.binary, command, *map(str, arguments)],
                             input="\n".join(self.rows if rows is None else rows) + "\n",
                             capture_output=True, text=True, check=True)
        return run.stdout.splitlines()

    def weights_file(self, weights, name):
        path = Path(self.temporary.name) / name
        packed = array.array("h", weights)
        if sys.byteorder != "little":
            packed.byteswap()
        path.write_bytes(packed.tobytes())
        return path

    def test_every_raw_feature_and_baseline_agrees(self):
        lines = self.native("features")
        self.assertEqual(len(lines), len(self.rows))
        for fen, line in zip(self.rows, lines):
            fields = line.split()
            self.assertEqual(int(fields[0]), f.baseline_score(fen))
            raw = {int(item.split(":")[0]): int(item.split(":")[1]) for item in fields[2:]}
            self.assertEqual((raw, int(fields[1])), f.extract_raw(fen))

    def test_zero_and_perturbed_integer_models(self):
        recipes = {"zero": [0] * f.N_FEATURES,
                   "distinct": [((i * 15427 + 17) % 401) - 200 for i in range(f.N_FEATURES)],
                   "half-tie": [12 if i == 91 else 0 for i in range(f.N_FEATURES)]}
        for name, weights in recipes.items():
            lines = self.native("eval", self.weights_file(weights, name + ".bin"))
            for fen, line in zip(self.rows, lines):
                baseline, candidate, correction = map(int, line.split())
                self.assertEqual(baseline, f.baseline_score(fen))
                self.assertEqual(correction, f.correction(fen, weights, integer=True))
                self.assertEqual(candidate, baseline + correction)

    def test_static_benchmark_and_zero_search_parity(self):
        weights = self.weights_file([0] * f.N_FEATURES, "search-zero.bin")
        bench = json.loads(self.native("bench", weights, 3, rows=AUTHORED[:2])[0])
        self.assertEqual(bench["positions"], 2)
        self.assertEqual(bench["baseline_checksum"], bench["candidate_checksum"])
        results = [json.loads(line) for line in self.native("search", weights, 1024, rows=AUTHORED[:2])]
        for row in range(2):
            pair = [result for result in results if result["row"] == row]
            self.assertEqual(len(pair), 2)
            for key in ("nodes", "qnodes", "depth", "score", "move"):
                self.assertEqual(pair[0][key], pair[1][key])

    def test_truncated_model_and_missing_king_rejected(self):
        path = Path(self.temporary.name) / "bad.bin"
        path.write_bytes(b"\0\0")
        result = subprocess.run([self.binary, "eval", str(path)], input=START + "\n",
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run([self.binary, "features"], input="8/8/8/8/8/8/8/8 w - - 0 1\n",
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
