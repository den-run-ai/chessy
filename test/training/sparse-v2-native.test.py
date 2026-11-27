#!/usr/bin/env python3
"""Exact compact/fused/cache contracts; no training/holdout labels or timing gate."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import features
import export


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixtures = module("sparse_fixtures_v2", Path(__file__).with_name("sparse-features.test.py"))
fast_fixtures = module("sparse_pair_fixtures_v2", Path(__file__).with_name("sparse-fast.test.py"))
constants = module("sparse_hce_generation_v2", ROOT / "tools/sparse_eval_v2/generate_hce_constants.py")


class NativeV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc")
        if not compiler:
            raise unittest.SkipTest("pinned native Rust required in CI")
        cls.directory = tempfile.TemporaryDirectory()
        cls.path = Path(cls.directory.name)
        cls.binaries = {}
        for name, source, extra in (
            ("v1", "tools/sparse_eval/runtime.rs", ["--cfg", "sparse_fast"]),
            ("scalar", "tools/sparse_eval_v2/runtime.rs", []),
            ("simd", "tools/sparse_eval_v2/runtime.rs", ["--cfg", "v2_simd"]),
            ("wide", "tools/sparse_eval_v2/runtime.rs", ["--cfg", "v2_wide_fused"]),
            ("unit", "tools/sparse_eval_v2/runtime.rs", ["--test"]),
        ):
            binary = cls.path / name
            subprocess.run([compiler, "--edition=2021", "-O", *extra, str(ROOT / source), "-o", str(binary)],
                           capture_output=True, check=True)
            cls.binaries[name] = binary
        cls.rows = fixtures.AUTHORED + fixtures.generated() + fast_fixtures.pair_boards()
        cls.rows += [fixtures.mirrored(fen) for fen in cls.rows]
        cls.full = ROOT / "eval/sparse-pesto-v1/fit/full.i16le"
        if not cls.full.exists():
            raise AssertionError("committed frozen full model is required")
        cls.zero = cls.path / "zero.i16le"
        cls.zero.write_bytes(bytes(features.N_FEATURES * 2))

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "directory"):
            cls.directory.cleanup()

    def invoke(self, binary, command, model=None, variant="fused", rows=None, extra=()):
        args = [str(self.binaries[binary]), command]
        if command not in ("metadata", "baseline"):
            args.append(str(self.full if model is None else model))
            if binary != "v1":
                args.append(variant)
        args += list(extra)
        return subprocess.run(args, input="\n".join(self.rows if rows is None else rows) + "\n",
                              capture_output=True, text=True, check=True).stdout

    def request(self, initial, moves=(), mode="candidate", nodes=2048, time_ms=0, depth=30, seed=0, expected=None, id="test"):
        import chess
        board = chess.Board(initial)
        for move in moves:
            board.push_uci(move)
        expected = board.fen(en_passant="fen") if expected is None else expected
        return "\t".join(map(str, ("SEARCH", id, mode, nodes, time_ms, depth, seed, initial, expected, " ".join(moves))))

    def serve(self, requests, variant="fused", model=None):
        return [json.loads(line) for line in self.invoke("scalar", "serve", model, variant, requests).splitlines()]

    def test_generated_constants_are_bound_to_pinned_hce(self):
        self.assertEqual((ROOT / "tools/sparse_eval_v2/hce_constants.rs").read_text(), constants.generated())

    def test_full_and_family_models_match_original_and_python(self):
        recipes = [("full", self.full), ("zero", self.zero)]
        for family, (start, end) in features.FAMILIES.items():
            weights = [0] * features.N_FEATURES
            for stage in (0, features.BASE_FEATURES):
                for index in range(start, end):
                    weights[stage + index] = (index * 137 + stage) % 63 - 31
            path = self.path / (family + ".spv")
            path.write_bytes(export.encode(weights))
            recipes.append((family, path))
        for name, path in recipes:
            expected = self.invoke("v1", "eval", path)
            for binary in ("scalar", "simd"):
                for variant in ("compact", "fused", "cached"):
                    with self.subTest(model=name, binary=binary, variant=variant):
                        actual = self.invoke(binary, "eval", path, variant)
                        self.assertEqual(actual, expected)
                        self.assertEqual(len(actual.splitlines()), len(self.rows))
                self.assertEqual(self.invoke(binary, "parts", path), expected)
        weights = struct.unpack("<17280h", self.full.read_bytes())
        lines = self.invoke("scalar", "parts", rows=fixtures.AUTHORED).splitlines()
        for fen, line in zip(fixtures.AUTHORED, lines):
            baseline, score, correction = map(int, line.split())
            self.assertEqual(baseline, features.baseline_score(fen))
            self.assertEqual(correction, features.correction(fen, weights, integer=True))
            self.assertEqual(score, baseline + correction)

    def test_fixed_node_search_signatures_preserve_moves_and_work(self):
        rows = fixtures.AUTHORED[:2] + fixtures.AUTHORED[4:11] + fixtures.AUTHORED[12:14]
        def signature(raw):
            return sorted((row["row"], row["candidate"], row["nodes"], row["qnodes"], row["depth"], row["score"], row["move"])
                          for row in map(json.loads, raw.splitlines()))
        expected = signature(self.invoke("v1", "search", rows=rows, extra=("2048", "30")))
        for binary in ("scalar", "simd"):
            for variant in ("compact", "fused", "cached"):
                self.assertEqual(signature(self.invoke(binary, "search", variant=variant, rows=rows, extra=("2048", "30"))), expected)

    def test_wide_fused_storage_preserves_king_model_without_clipping(self):
        king = ROOT / "eval/sparse-pesto-v1/fit/king.i16le"
        expected = self.invoke("v1", "eval", model=king)
        for variant in ("compact", "fused", "cached"):
            self.assertEqual(self.invoke("wide", "eval", model=king, variant=variant), expected)
        metadata = json.loads(self.invoke("wide", "metadata", rows=[]))
        self.assertEqual(metadata["coefficientPayloadBytes"], 22856)
        self.assertTrue(metadata["wideFused"])
        rejected = subprocess.run([str(self.binaries["scalar"]), "eval", str(king), "fused"], capture_output=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(b"v2_wide_fused", rejected.stderr)

    def test_complete_history_distinguishes_twofold_and_threefold(self):
        cycle = ["g1f3", "g8f6", "f3g1", "f6g8"]
        requests = [self.request(fixtures.START, cycle, id="twofold"),
                    self.request(fixtures.START, cycle * 2, id="threefold"),
                    self.request(fixtures.START, id="fresh")]
        for variant in ("compact", "fused", "cached"):
            twofold, threefold, fresh = self.serve(requests, variant)
            self.assertGreater(twofold["nodes"], 0)
            self.assertEqual(twofold["history_occurrences"], 5)
            self.assertEqual(threefold["stop_reason"], "game_over")
            self.assertEqual(threefold["nodes"], 0)
            self.assertEqual(threefold["move"], "0000")
            self.assertEqual(threefold["history_occurrences"], 9)
            self.assertGreater(fresh["nodes"], 0)

    def test_history_replay_special_moves_and_zero_model_search_parity(self):
        cases = [(fixtures.AUTHORED[4], ["e1g1"]), (fixtures.AUTHORED[6], ["e5d6"]),
                 (fixtures.AUTHORED[8], ["a7a8q"]), (fixtures.AUTHORED[8], ["a7a8n"]),
                 (fixtures.START, ["e2e4", "d7d5", "e4d5"])]
        requests = [self.request(initial, moves, mode=mode, id=str(index))
                    for index, (initial, moves) in enumerate(cases) for mode in ("hce", "candidate")]
        rows = self.serve(requests, "cached", self.zero)
        for index in range(0, len(rows), 2):
            left, right = rows[index:index + 2]
            self.assertTrue(left["verifiedFen"])
            self.assertEqual(left["scorePov"], "white")
            self.assertEqual({key: left[key] for key in ("move", "score", "nodes", "qnodes", "depth", "stop_reason")},
                             {key: right[key] for key in ("move", "score", "nodes", "qnodes", "depth", "stop_reason")})

    def test_invalid_requests_fail_closed_and_do_not_poison_next_request(self):
        requests = [self.request(fixtures.START, seed=1),
                    self.request(fixtures.START, ["e2e4"], expected=fixtures.START),
                    self.request(fixtures.START) + "a1a8",
                    self.request(fixtures.START, nodes=0, time_ms=0),
                    "SEARCH\tbroken",
                    self.request(fixtures.START, id="valid")]
        rows = self.serve(requests)
        self.assertTrue(all("error" in row for row in rows[:-1]))
        self.assertEqual(rows[-1]["id"], "valid")
        self.assertGreater(rows[-1]["nodes"], 0)

    def test_time_limit_uses_search_clock_and_reports_stop_reason(self):
        row = self.serve([self.request(fixtures.START, nodes=0, time_ms=1, depth=100)])[0]
        self.assertEqual(row["stop_reason"], "time_limit")
        self.assertGreater(row["nodes"], 0)
        self.assertGreater(row["elapsed_ns"], 0)
        self.assertGreater(row["replay_ns"], 0)

    def test_cache_collision_generation_and_lossless_range_unit_contracts(self):
        subprocess.run([str(self.binaries["unit"]), "model::tests::", "--test-threads=1"], capture_output=True, check=True)
        metadata = json.loads(self.invoke("scalar", "metadata", rows=[]))
        self.assertEqual(metadata["coefficientPayloadBytes"], 16712)
        self.assertEqual(metadata["cacheSlots"], 1024)
        self.assertLess(metadata["modelBytes"], 17000)

    def test_timing_warmup_and_order_controls_preserve_measured_outputs(self):
        config = json.loads((ROOT / "eval/sparse-pesto-v2/COST-CONFIG.json").read_bytes())
        source = (ROOT / "tools/sparse_eval_v2/runtime.rs").read_text()
        authored = re.search(r"const WARMUP_FENS: \[&str; 4\] = \[(.*?)\];", source, re.S).group(1)
        self.assertEqual(re.findall(r'"([^"]+)"', authored), config["warmupFens"])
        self.assertIn(f'const WARMUP_NODES: u32 = {config["searchWarmupNodes"]};', source)
        self.assertIn(f'const WARMUP_DEPTH: u32 = {config["maximumDepth"]};', source)
        rows = fixtures.AUTHORED[:2]
        baseline = list(map(json.loads, self.invoke("scalar", "search", rows=rows, extra=("1024", "30")).splitlines()))
        warmed = list(map(json.loads, self.invoke("scalar", "search", rows=rows,
            extra=("1024", "30", "1", str(config["searchWarmupCycles"]))).splitlines()))
        self.assertEqual(len(warmed), len(rows) * 2)
        self.assertEqual([row["candidate"] for row in baseline], [False, True, True, False])
        self.assertEqual([row["candidate"] for row in warmed], [True, False, False, True])
        self.assertTrue(all(row["warmup_requests"] == 0 and row["order_offset"] == 0 for row in baseline))
        self.assertTrue(all(row["warmup_requests"] == 32 and row["order_offset"] == 1 for row in warmed))
        fields = ("row", "candidate", "move", "score", "nodes", "qnodes", "depth", "attempted_depth",
                  "cutoffs", "researches", "stop_reason", "tt_saturated")
        self.assertEqual(sorted(tuple(row[key] for key in fields) for row in baseline),
                         sorted(tuple(row[key] for key in fields) for row in warmed))
        scores = self.invoke("scalar", "eval", rows=rows).splitlines()
        expected = sum(int(line.split()[1]) for line in scores) * 2
        default = json.loads(self.invoke("scalar", "bench", rows=rows, extra=("2",)))
        warmed = json.loads(self.invoke("scalar", "bench", rows=rows, extra=("2", str(config["staticWarmupPasses"]))))
        self.assertEqual(default["warmup_passes"], 1)
        self.assertEqual(warmed["warmup_passes"], 128)
        self.assertEqual(default["checksum"], expected)
        self.assertEqual(warmed["checksum"], expected)
        self.assertEqual(warmed["passes"], 2)


if __name__ == "__main__":
    unittest.main()
