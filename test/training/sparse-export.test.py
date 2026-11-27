#!/usr/bin/env python3
"""Exact coefficient/score equivalence and malformed sparse-artifact rejection."""
import os
from pathlib import Path
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import export as codec
import features

FENS = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "4k3/8/8/5p2/4N3/3P4/8/4K3 w - - 0 1",
    "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1",
    "8/8/8/8/8/8/3k4/R3K3 w - - 0 1",
]


def malformed():
    header = lambda count: b"SPV1" + struct.pack("<I", count)
    record = lambda index, value: struct.pack("<Hh", index, value)
    return [b"", b"SPV1", b"BAD!" + b"\0" * 4,
            header(1), header(0) + b"x", header(17281),
            header(1) + record(17280, 1), header(1) + record(65535, 1),
            header(1) + record(10, 0),
            header(2) + record(10, 1) + record(10, 2),
            header(2) + record(11, 1) + record(10, 2),
            header(1) + record(1, 2) + b"x"]


class Codec(unittest.TestCase):
    def test_frozen_layout_and_zero_roundtrip(self):
        self.assertEqual(codec.DIMENSION, features.N_FEATURES)
        zero = [0] * codec.DIMENSION
        encoded = codec.encode(zero)
        self.assertEqual(encoded, b"SPV1\0\0\0\0")
        self.assertEqual(list(codec.decode(encoded)), zero)
        weights = list(zero)
        weights[0], weights[17279] = -32768, 32767
        encoded = codec.encode(weights)
        self.assertEqual(encoded, b"SPV1" + struct.pack("<I", 2)
                         + struct.pack("<HhHh", 0, -32768, 17279, 32767))
        self.assertEqual(list(codec.decode(encoded)), weights)

    def test_sparse_storage_and_random_roundtrip(self):
        rng = random.Random(20261127)
        weights = [0] * codec.DIMENSION
        for index in rng.sample(range(codec.DIMENSION), 2621):
            weights[index] = rng.choice([-17, -3, 2, 29])
        encoded = codec.encode(weights)
        self.assertEqual(len(encoded), 10492)
        self.assertEqual(list(codec.decode(encoded)), weights)
        self.assertEqual(codec.encode(codec.decode(encoded)), encoded)

    def test_invalid_types_dimensions_and_ranges(self):
        for bad in (None, "0", b"0", {}, iter([0] * codec.DIMENSION)):
            with self.assertRaises(TypeError):
                codec.encode(bad)
        for bad in ([], [0] * 17279, [0] * 17281):
            with self.assertRaises(ValueError):
                codec.encode(bad)
        for value in (True, 0.0, 1.25, float("nan"), float("inf"), "3", None):
            weights = [0] * codec.DIMENSION
            weights[4] = value
            with self.assertRaises(TypeError):
                codec.encode(weights)
        for value in (-32769, 32768):
            weights = [0] * codec.DIMENSION
            weights[4] = value
            with self.assertRaises(ValueError):
                codec.encode(weights)
        for bad in (None, 8, [1, 2], "SPV1"):
            with self.assertRaises(TypeError):
                codec.decode(bad)

    def test_malformed_payloads_fail_closed(self):
        for payload in malformed():
            with self.assertRaises(ValueError):
                codec.decode(payload)


class Native(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc")
        if not compiler:
            raise unittest.SkipTest("native Rust unavailable; CI must use pinned compiler")
        cls.directory = tempfile.TemporaryDirectory()
        cls.binary = str(Path(cls.directory.name) / "sparse-eval")
        subprocess.run([compiler, "--edition=2021", "-O", str(ROOT / "tools/sparse_eval/runtime.rs"),
                        "-o", cls.binary], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "directory"):
            cls.directory.cleanup()

    def run_native(self, payload, command="eval", *extra, check=True):
        path = Path(self.directory.name) / "model.bin"
        path.write_bytes(payload)
        return subprocess.run([self.binary, command, str(path), *map(str, extra)],
                              input="\n".join(FENS) + "\n", text=True,
                              capture_output=True, check=check)

    def test_dense_and_sparse_give_exact_scores(self):
        weights = [((index * 7919) % 401) - 200 if index % 7 == 0 else 0
                   for index in range(codec.DIMENSION)]
        dense = struct.pack("<" + "h" * codec.DIMENSION, *weights)
        compact = codec.encode(weights)
        self.assertEqual(self.run_native(dense).stdout, self.run_native(compact).stdout)
        zero_dense = bytes(codec.DIMENSION * 2)
        zero_compact = codec.encode([0] * codec.DIMENSION)
        self.assertEqual(self.run_native(zero_dense).stdout, self.run_native(zero_compact).stdout)
        for fen, line in zip(FENS, self.run_native(compact).stdout.splitlines()):
            baseline, score, correction = map(int, line.split())
            self.assertEqual(baseline, features.baseline_score(fen))
            self.assertEqual(correction, features.correction(fen, weights, integer=True))
            self.assertEqual(score, baseline + correction)

    def test_zero_model_search_parity(self):
        import json
        dense = self.run_native(bytes(codec.DIMENSION * 2), "search", 1024)
        sparse = self.run_native(codec.encode([0] * codec.DIMENSION), "search", 1024)
        def signatures(output):
            return sorted((row["row"], row["candidate"], row["nodes"], row["qnodes"],
                           row["depth"], row["score"], row["move"])
                          for row in map(json.loads, output.splitlines()))
        self.assertEqual(signatures(dense.stdout), signatures(sparse.stdout))

    def test_native_rejects_every_malformed_payload(self):
        for payload in malformed():
            result = self.run_native(payload, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
