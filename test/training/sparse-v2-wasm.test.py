#!/usr/bin/env python3
"""Independent numeric and complete-history contracts for the research WASM ABI."""
import hashlib
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
sys.path.insert(0, str(ROOT))
from tools.sparse_eval import features
from tools.sparse_eval_v2.build_wasm import build

spec = importlib.util.spec_from_file_location("wasm_v2_fixtures", Path(__file__).with_name("sparse-features.test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class WasmContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rustc = os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc")
        opt = os.environ.get("SPARSE_EVAL_WASM_OPT") or shutil.which("wasm-opt")
        dis = os.environ.get("SPARSE_EVAL_WASM_DIS") or shutil.which("wasm-dis")
        cls.node = shutil.which("node")
        if not all((rustc, opt, dis, cls.node)):
            raise unittest.SkipTest("pinned Rust/WASM/Binaryen/Node tools required; CI must provide them")
        target = subprocess.check_output([rustc, "--print", "target-libdir", "--target", "wasm32-unknown-unknown"], text=True).strip()
        if not list(Path(target).glob("libcore-*.rlib")):
            raise unittest.SkipTest("WASM standard target is not installed")
        cls.temp = tempfile.TemporaryDirectory()
        cls.work = Path(cls.temp.name)
        cls.narrow = cls.work / "narrow"
        cls.wide = cls.work / "wide"
        build(ROOT, cls.narrow, rustc, opt, dis)
        build(ROOT, cls.wide, rustc, opt, dis, wide_fused=True)
        cls.host = (ROOT / "tools/sparse_eval_v2/wasm_runner.mjs").as_uri()
        cls.rules = str(ROOT / "assets/engine.js")
        cls.full = str(ROOT / "eval/sparse-pesto-v1/fit/full.i16le")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "temp"):
            cls.temp.cleanup()

    def node_script(self, source, data):
        script = self.work / "contract.mjs"
        script.write_text("import assert from 'node:assert/strict';\n"
                          "import fs from 'node:fs/promises';\n"
                          f"import {{WasmEvaluator}} from {json.dumps(self.host)};\n"
                          "const data = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));\n" + source)
        fixture = self.work / "contract.json"
        fixture.write_text(json.dumps(data))
        result = subprocess.run([self.node, "--no-liftoff", "--no-wasm-lazy-compilation", str(script), str(fixture)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_optimized_cli_startup_and_symlink_entry_produce_readiness(self):
        link = self.work / "host-link.mjs"
        link.symlink_to(ROOT / "tools/sparse_eval_v2/wasm_runner.mjs")
        flags = ["--no-liftoff", "--no-wasm-lazy-compilation"]
        command = [self.node, *flags, str(link), "info", str(self.narrow / "simd128.wasm"),
                   self.full, "fused", self.rules]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertEqual(info["nodeArguments"], flags)
        self.assertEqual(info["mode"], "ready")
        self.assertEqual(info["weightsSha256"], "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304")
        command[4] = "serve"
        response = subprocess.run(command, input="INFO\tready\n", capture_output=True, text=True, timeout=10)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(response.stdout)["id"], "ready")

    def test_scalar_simd_all_variants_match_independent_python(self):
        fens = fixtures.AUTHORED + fixtures.generated()
        fens += [fixtures.mirrored(fen) for fen in fens]
        baseline = [features.baseline_score(fen) for fen in fens]
        original = Path(self.full).read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304")
        recipes = {"full": list(struct.unpack("<" + "h" * features.N_FEATURES, original)),
                   "zero": [0] * features.N_FEATURES,
                   "distinct": [(index * 17 + 3) % 19 - 9 for index in range(features.N_FEATURES)]}
        for family, (start, end) in features.FAMILIES.items():
            weights = [0] * features.N_FEATURES
            for offset in (0, features.BASE_FEATURES):
                for index in range(start, end):
                    weights[offset + index] = (index * 7 + offset) % 13 - 6
            recipes[family] = weights
        cases = []
        for name, weights in recipes.items():
            path = self.work / (name + ".i16le")
            path.write_bytes(struct.pack("<" + "h" * features.N_FEATURES, *weights))
            expected = [base + features.correction(fen, weights, integer=True) for fen, base in zip(fens, baseline)]
            cases.append({"name": name, "weights": str(path), "scores": expected})
        self.node_script("""
for (const [index, module] of data.modules.entries()) {
  for (const test of data.cases) {
    const evaluator = await WasmEvaluator.open(module, test.weights, 'fused', data.rules);
    assert.equal(evaluator.info().simdCompiled, index === 1);
    assert.equal(evaluator.info().coefficientPayloadBytes, 16712);
    evaluator.loadPositions(data.fens);
    assert.deepEqual(evaluator.evaluate(0), data.baseline);
    for (const variant of [1, 2, 3]) {
      evaluator.clearCache();
      assert.deepEqual(evaluator.evaluate(variant), test.scores, test.name + ':' + variant);
      evaluator.clearCache();
      const result = evaluator.benchmark(3, variant);
      assert.equal(BigInt(result.checksum), 3n * test.scores.reduce((s, n) => s + BigInt(n), 0n));
    }
  }
}
""", {"modules": [str(self.narrow / "scalar.wasm"), str(self.narrow / "simd128.wasm")],
        "rules": self.rules, "fens": fens, "baseline": baseline, "cases": cases})

    def test_width_rejection_and_failed_loads_cannot_serve_stale_candidate(self):
        king = str(ROOT / "eval/sparse-pesto-v1/fit/king.i16le")
        self.node_script("""
await assert.rejects(WasmEvaluator.open(data.narrow, data.king, 'fused', data.rules), /load_model/);
const wide = await WasmEvaluator.open(data.wide, data.king, 'fused', data.rules);
assert.equal(wide.info().coefficientPayloadBytes, 22856);
wide.loadPositions([data.fen]);
assert.deepEqual(wide.evaluate(), [data.kingScore]);
const evaluator = await WasmEvaluator.open(data.narrow, data.full, 'fused', data.rules);
evaluator.loadPositions([data.fen]);
assert.equal(evaluator.e.load_model(evaluator.e.input_capacity() + 1), -2);
assert.equal(evaluator.e.eval_positions(1), -5);
const weights = await fs.readFile(data.full);
evaluator.writeInput(weights);
assert.equal(evaluator.e.load_model(weights.length), 0);
evaluator.writeInput(new Uint8Array([1, 2]));
assert.equal(evaluator.e.load_model(2), -3);
assert.equal(evaluator.e.eval_positions(2), -5);
evaluator.writeInput(new TextEncoder().encode('not a FEN'));
assert.equal(evaluator.e.load_positions(9), -4);
assert.equal(evaluator.e.positions_count(), 0);
assert.equal(evaluator.e.eval_positions(0), -4);
assert.throws(() => evaluator.writeInput(new Uint8Array(evaluator.e.input_capacity() + 1)), /capacity/);
assert.throws(() => evaluator.e.memory.grow(1));
""", {"narrow": str(self.narrow / "scalar.wasm"), "wide": str(self.wide / "simd128.wasm"),
        "king": king, "full": self.full, "rules": self.rules, "fen": fixtures.AUTHORED[0],
        "kingScore": features.baseline_score(fixtures.AUTHORED[0]) + features.correction(fixtures.AUTHORED[0],
            list(struct.unpack("<" + "h" * features.N_FEATURES, Path(king).read_bytes())), integer=True)})

    def test_server_history_replay_repetition_and_input_rejection(self):
        import chess
        cases = []
        sequences = [
            (chess.STARTING_FEN, ["e2e4", "e7e5", "g1f3"]),
            ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["e1g1", "e8c8"]),
            ("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", ["e5d6"]),
            ("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7a8q"]),
            (chess.STARTING_FEN, ["g1f3", "g8f6", "f3g1", "f6g8"] * 2),
        ]
        for initial, moves in sequences:
            board = chess.Board(initial)
            for uci in moves:
                move = chess.Move.from_uci(uci)
                self.assertIn(move, board.legal_moves)
                board.push(move)
            cases.append({"initial": initial, "moves": " ".join(moves), "final": board.fen(en_passant="fen")})
        output = self.node_script("""
const evaluator = await WasmEvaluator.open(data.module, data.full, 'cached', data.rules);
const ready = evaluator.request('INFO\\tready');
assert.equal(ready.mode, 'ready');
assert.equal(ready.id, 'ready');
assert.equal(ready.weightsSha256.length, 64);
const results = [];
for (const [index, test] of data.cases.entries()) {
  const line = ['SEARCH', 'case' + index, 'candidate', '128', '0', '4', '0', test.initial, test.final, test.moves].join('\\t');
  const result = evaluator.request(line);
  assert.equal(result.verifiedFen, true);
  assert.equal(result.historyOccurrences, test.moves.split(' ').length + 1);
  results.push(result);
}
assert.equal(results.at(-1).move, null);
assert.equal(results.at(-1).stop_reason, 'game_over');
assert.equal(results.at(-1).nodes, 0);
const first = data.cases[0];
assert.throws(() => evaluator.request(['SEARCH','bad','candidate','128','0','4','1',first.initial,first.final,first.moves].join('\\t')), /root seed/);
assert.throws(() => evaluator.request(['SEARCH','bad','candidate','128','0','4','0',first.initial,first.initial,first.moves].join('\\t')), /final FEN/);
assert.throws(() => evaluator.request(['SEARCH','bad','candidate','128','0','4','0',first.initial,first.final,'e2e5'].join('\\t')), /legal/);
console.log(JSON.stringify(results));
""", {"module": str(self.narrow / "simd128.wasm"), "full": self.full, "rules": self.rules, "cases": cases})
        results = json.loads(output)
        for case, result in zip(cases, results):
            if result["move"] is not None:
                self.assertIn(chess.Move.from_uci(result["move"]), chess.Board(case["final"]).legal_moves)


if __name__ == "__main__":
    unittest.main()
