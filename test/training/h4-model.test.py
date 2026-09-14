#!/usr/bin/env python3
"""Synthetic-only H4 math, orientation, serialization, and independent parity."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from scipy import sparse
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("h4_model", ROOT / "tools/training/h4_model.py")
h4 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = h4
spec.loader.exec_module(h4)

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
EMPTY = "8/8/8/8/8/8/8/8 w - - 0 1"
FENS = [
    START,
    START.replace(" w ", " b "),
    "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 7 24",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 18",
    "Q3k3/8/8/8/8/8/8/4K3 b - - 0 80",
    "4k3/8/8/8/8/8/8/4K3 w - - 100 100",
    "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1",
]


def js_scores(model, fens):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        (root / "model.bin").write_bytes(model.to_bytes())
        (root / "model.json").write_text(json.dumps(model.metadata()))
        result = subprocess.run(
            ["node", str(ROOT / "test/training/h4-reference.js"), str(root / "model.bin"), str(root / "model.json")],
            input="".join(json.dumps({"id": str(i), "fen": fen}) + "\n" for i, fen in enumerate(fens)),
            text=True, capture_output=True, check=True)
        return [json.loads(line)["cpWhite"] for line in result.stdout.splitlines()]


class H4Tests(unittest.TestCase):
    def test_piece_square_orientation_uses_a8_zero_and_black_color_rank_flip(self):
        fen = "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1"
        white, black, turn = h4.features_from_fens([fen])
        # Hardcoded independent square/channel values: black knight b8=1,
        # black king e8=4, black pawn d5=27, white pawn e4=36,
        # white king e1=60, white knight g1=62.
        self.assertEqual(set(white.indices), {7 * 64 + 1, 11 * 64 + 4, 6 * 64 + 27, 36, 5 * 64 + 60, 64 + 62})
        self.assertEqual(set(black.indices), {64 + 57, 5 * 64 + 60, 35, 6 * 64 + 28, 11 * 64 + 4, 7 * 64 + 6})
        self.assertEqual(turn.tolist(), [1])
        self.assertTrue(white.has_canonical_format)
        self.assertTrue(black.has_canonical_format)

    def test_color_rank_mirror_exchanges_inputs_and_negates_white_score(self):
        original = "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1"
        mirrored = "4k1n1/8/8/4p3/3P4/8/8/1N2K3 b - - 0 1"
        white, black, turn = h4.features_from_fens([original, mirrored])
        np.testing.assert_array_equal(white[0].toarray(), black[1].toarray())
        np.testing.assert_array_equal(black[0].toarray(), white[1].toarray())
        params = h4.initialize(753)
        floating = h4.predict_cp(params, white, black, turn)
        self.assertEqual(floating[0], -floating[1])
        integer = h4.quantize(params).predict_cp(white, black, turn)
        self.assertEqual(integer[0], -integer[1])

    def test_stm_hidden_order_and_white_sign_are_separate(self):
        params = np.zeros(h4.N_PARAMS)
        weights, bias, output, _ = h4.unpack(params)
        # a8 white pawn activates white unit zero; its black-perspective feature
        # does not. Other units and all biases remain zero.
        weights[0, 0] = 0.25
        output[0] = 1
        output[4] = 3
        fen = "P7/8/8/8/8/8/8/8 w - - 0 1"
        white, black, turn = h4.features_from_fens([fen, fen.replace(" w ", " b ")])
        self.assertEqual(h4.predict_cp(params, white, black, turn).tolist(), [100, -300])
        model = h4.quantize(params)
        self.assertEqual(model.predict_cp(white, black, turn).tolist(), [100, -300])
        self.assertEqual(js_scores(model, [fen, fen.replace(" w ", " b ")]), [100, -300])

    def test_analytic_gradient_matches_finite_differences_including_clamped_units(self):
        white, black, turn = h4.features_from_fens(FENS)
        params = h4.initialize(421)
        params[3072] = -4  # Lower-clamped unit.
        params[3073] = 4   # Upper-clamped unit.
        targets = np.asarray([0.5, 0.5, 0.43, 0.63, 0.96, 0.5, 0.61])
        _, analytic = h4.loss_and_grad(params, white, black, turn, targets)
        active = sorted(set(white.indices) | set(black.indices))
        indices = [feature * 4 + unit for feature in active for unit in range(4)] + list(range(3072, h4.N_PARAMS))
        # Include unobserved features to check the mean-scaled L2 derivative.
        indices += [11 * 4 + 2, 600 * 4 + 3]
        epsilon = 1e-6
        for index in indices:
            plus, minus = params.copy(), params.copy()
            plus[index] += epsilon
            minus[index] -= epsilon
            numeric = (h4.loss_and_grad(plus, white, black, turn, targets)[0] -
                       h4.loss_and_grad(minus, white, black, turn, targets)[0]) / (2 * epsilon)
            self.assertAlmostEqual(analytic[index], numeric, delta=3e-9, msg=f"parameter {index}")

    def test_bce_scale_regularizer_and_deterministic_training(self):
        white, black, turn = h4.features_from_fens(FENS)
        params = h4.initialize(421)
        np.testing.assert_array_equal(params, h4.initialize(421))
        self.assertFalse(np.array_equal(params, h4.initialize(422)))
        targets = np.asarray([0.5, 0.5, 0.43, 0.63, 0.96, 0.5, 0.61])
        logits = 4 * h4.predict_cp(params, white, black, turn) / 400
        expected = np.mean(np.logaddexp(0, logits) - targets * logits) + 0.5e-5 * np.mean(params ** 2)
        self.assertAlmostEqual(h4.loss_and_grad(params, white, black, turn, targets)[0], expected)
        result = minimize(h4.loss_and_grad, params, args=(white, black, turn, targets), jac=True,
                          method="L-BFGS-B", options={"maxiter": 15, "ftol": 1e-10})
        self.assertLess(result.fun, expected - 0.01)

    def test_quantization_ties_even_and_largest_safe_output_scale(self):
        params = np.zeros(h4.N_PARAMS)
        params[:4] = np.asarray([0.5, 1.5, -0.5, -1.5]) / 1024
        params[3076] = 8
        model = h4.quantize(params)
        self.assertEqual(model.q2, 2048)
        self.assertEqual(model.input_weights[0].tolist(), [0, 2, 0, -2])
        params[3076] = -8
        self.assertEqual(h4.quantize(params).q2, 4096)

    def test_negative_half_rounding_then_white_sign(self):
        # Q2=1 and numerator=-32 gives -12.5cp: floor(-12.5+0.5)=-12.
        # Conversion to white perspective occurs after that rounding.
        model = h4.QuantizedModel(np.zeros((768, 4)), np.zeros(4), np.zeros(8), -32, 1)
        fens = [EMPTY, EMPTY.replace(" w ", " b ")]
        self.assertEqual(model.predict_cp(*h4.features_from_fens(fens)).tolist(), [-12, 12])
        self.assertEqual(js_scores(model, fens), [-12, 12])
        positive = h4.QuantizedModel(np.zeros((768, 4)), np.zeros(4), np.zeros(8), 32, 1)
        self.assertEqual(positive.predict_cp(*h4.features_from_fens(fens)).tolist(), [13, -13])
        self.assertEqual(js_scores(positive, fens), [13, -13])

    def test_exact_binary_size_roundtrip_and_js_parity_on_special_fens(self):
        # Different seeds include positive/negative outputs, promoted material,
        # en passant, castling, endgames, and both side-to-move orders.
        for seed in [0, 4, 98765]:
            model = h4.quantize(h4.initialize(seed))
            payload = model.to_bytes()
            self.assertEqual(len(payload), 6180)
            restored = h4.QuantizedModel.from_bytes(payload, model.q2)
            self.assertEqual(restored.to_bytes(), payload)
            expected = model.predict_cp(*h4.features_from_fens(FENS)).tolist()
            self.assertEqual(js_scores(restored, FENS), expected)
        with self.assertRaisesRegex(ValueError, "exactly 6180"):
            h4.QuantizedModel.from_bytes(payload[:-1], model.q2)

    def test_rejects_saturation_and_theoretical_accumulator_overflow(self):
        for index, value in [(0, 33.0), (3072, 3e6), (3076, 40000.0), (3084, 1000.0)]:
            params = np.zeros(h4.N_PARAMS)
            params[index] = value
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, "saturat"):
                h4.quantize(params)
        with self.assertRaisesRegex(ValueError, "accumulator overflow"):
            h4.QuantizedModel(np.ones((768, 4)), np.full(4, 2147483647), np.zeros(8), 0, 1)
        for q2 in [0, 3, 8192, 1.0, True]:
            with self.subTest(q2=q2), self.assertRaisesRegex(ValueError, "power of two"):
                h4.QuantizedModel(np.zeros((768, 4)), np.zeros(4), np.zeros(8), 0, q2)

    def test_integer_inference_rejects_nonbinary_duplicate_and_excess_piece_inputs(self):
        model = h4.quantize(h4.initialize(1))
        white, black, turn = h4.features_from_fens([START])
        white.data[0] = 0.5
        with self.assertRaisesRegex(ValueError, "binary"):
            model.predict_cp(white, black, turn)
        excess = sparse.csr_matrix((np.ones(33), np.arange(33), [0, 33]), shape=(1, 768))
        with self.assertRaisesRegex(ValueError, "32-piece"):
            model.predict_cp(excess, excess, turn)
        duplicate = sparse.csr_matrix((np.ones(2), [0, 0], [0, 2]), shape=(1, 768))
        with self.assertRaisesRegex(ValueError, "binary"):
            model.predict_cp(duplicate, duplicate, turn)

    def test_rejects_malformed_fen_and_nonfinite_parameters(self):
        for fen in ["8/8/8/8/8/8/8 w - - 0 1", "9/8/8/8/8/8/8/8 w - - 0 1",
                    EMPTY.replace(" w ", " x "), "PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP/P7/8/8/8 w - - 0 1"]:
            with self.subTest(fen=fen), self.assertRaises(ValueError):
                h4.features_from_fens([fen])
        params = h4.initialize(3)
        params[0] = np.nan
        with self.assertRaisesRegex(ValueError, "finite parameters"):
            h4.quantize(params)


if __name__ == "__main__":
    unittest.main()
