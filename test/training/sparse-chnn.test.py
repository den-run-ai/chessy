#!/usr/bin/env python3
"""Authored CHNN format, orientation, arithmetic and patch integrity tests."""
import copy
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval.chnn import Activations, FrozenCHNN


def net(*, kb=1, hidden=2, ob=1, qa=10, qb=2, scale=3):
    header = struct.pack("<4sIIIIiii", b"CHNN", 1, kb, hidden, ob, qa, qb, scale)
    ft = np.zeros((kb*768, hidden), dtype="<i2")
    bias = np.arange(1, hidden+1, dtype="<i2")
    out = np.tile(np.array([2, -3, 4, -1], dtype="<i2"), ob)
    output_bias = np.arange(ob, dtype="<i4")-2
    return header+ft.tobytes()+bias.tobytes()+out.tobytes()+output_bias.tobytes()


class CHNNTests(unittest.TestCase):
    def test_manual_king_bucket_and_mirror_indices(self):
        m = FrozenCHNN(net(kb=16))
        fen = "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"
        # White king e1 mirrors to d1 -> bucket3. Pawn a2 -> h2=15.
        self.assertIn(3*768+15, m.feature_indices(fen, 0))
        # Black king e8 flips to e1, mirrors d1. Opponent pawn a2 -> h7=55.
        self.assertIn(3*768+384+55, m.feature_indices(fen, 1))
        self.assertIn(3*768+5*64+3, m.feature_indices(fen, 0))
        self.assertIn(3*768+5*64+3, m.feature_indices(fen, 1))
        with self.assertRaises(ValueError):
            m.feature_indices(fen, True)

    def test_known_accumulators_and_negative_rust_truncation(self):
        m = FrozenCHNN(net())
        batch = m.activations(["4k3/8/8/8/8/8/8/4K3 w - - 0 1",
                               "4k3/8/8/8/8/8/8/4K3 b - - 0 1"])
        np.testing.assert_array_equal(batch.squared, [[1, 4, 1, 4], [1, 4, 1, 4]])
        # dot=2-12+4-4=-10; trunc(-10/10)-2=-3; trunc(-9/20)=0.
        np.testing.assert_array_equal(m.predict(batch), [0, 0])
        np.testing.assert_allclose(m.predict(batch, integer=False), [-.45, .45])
        np.testing.assert_allclose(m.design(batch).toarray(), [[.015, .06, .015, .06], [-.015, -.06, -.015, -.06]])

    def test_feature_transformer_wrap_is_preserved(self):
        payload = bytearray(net())
        # Both own/opposing kings hit channel0 with32767; sum65534+bias1 wraps−1.
        for idx in (5*64+4, 11*64+60):
            struct.pack_into("<h", payload, 32+idx*2*2, 32767)
        m = FrozenCHNN(payload)
        batch = m.activations(["4k3/8/8/8/8/8/8/4K3 w - - 0 1"])
        self.assertEqual(batch.squared[0, 0], 0)

    def test_material_output_buckets_and_affine_head(self):
        m = FrozenCHNN(net(ob=8))
        fens = ["4k3/8/8/8/8/8/8/4K3 w - - 0 1",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"]
        batch = m.activations(fens)
        np.testing.assert_array_equal(batch.bucket, [0, 7])
        delta = np.zeros(m.weight_count)
        delta[0], delta[-1] = .5, -1.25
        before = m.predict(batch, integer=False)
        after = m.predict(batch, integer=False, delta=delta)
        np.testing.assert_allclose(after-before, m.design(batch)@delta, atol=1e-12)

    def test_patch_roundtrip_and_payload_immutability(self):
        source = net()
        m = FrozenCHNN(source)
        delta = np.array([1, -1, 0, 2])
        patch, changed = m.patch(delta)
        self.assertEqual(m.payload, source)
        self.assertEqual(changed[:m.output_offset], source[:m.output_offset])
        self.assertEqual(changed[-4:], source[-4:])
        self.assertEqual(m.apply_patch(patch), changed)
        self.assertEqual(len(patch["changes"]), 3)
        batch = m.activations(["4k3/8/8/8/8/8/8/4K3 w - - 0 1"])
        n = FrozenCHNN(changed)
        new_batch = n.activations(["4k3/8/8/8/8/8/8/4K3 w - - 0 1"])
        np.testing.assert_array_equal(m.predict(batch, delta=delta), n.predict(new_batch))
        with self.assertRaises(ValueError):
            n.predict(batch)
        with self.assertRaises(ValueError):
            m.patch(delta+.1)
        with self.assertRaises(ValueError):
            m.patch([4000, 0, 0, 0])

    def test_patch_tampering_is_rejected(self):
        m = FrozenCHNN(net())
        patch, _ = m.patch([1, 0, 0, 0])
        bads = []
        p = copy.deepcopy(patch); p["sourceSha256"] = "0"*64; bads.append(p)
        p = copy.deepcopy(patch); p["resultSha256"] = "0"*64; bads.append(p)
        p = copy.deepcopy(patch); p["changes"] *= 2; bads.append(p)
        p = copy.deepcopy(patch); p["changes"][0]["old"] += 1; bads.append(p)
        p = copy.deepcopy(patch); p["changes"][0]["index"] = -1; bads.append(p)
        p = copy.deepcopy(patch); p["changes"][0]["index"] = False; bads.append(p)
        p = copy.deepcopy(patch); p["extra"] = 1; bads.append(p)
        for p in bads:
            with self.assertRaises(ValueError):
                m.apply_patch(p)

    def test_bad_headers_lengths_and_hash_are_rejected(self):
        source = net()
        for p in (source[:-1], source+b"x", source[:30], b"BAD!"+source[4:]):
            with self.assertRaises(ValueError):
                FrozenCHNN(p)
        for offset, value in ((4, 2), (8, 4), (12, 0), (16, 0), (20, 0), (20, 256), (24, 0), (28, 0)):
            p = bytearray(source); struct.pack_into("<i", p, offset, value)
            with self.assertRaises(ValueError):
                FrozenCHNN(p)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"synthetic.nnue"
            path.write_bytes(source)
            m = FrozenCHNN.from_file(path, expected_sha256=hashlib.sha256(source).hexdigest())
            self.assertEqual(m.payload, source)
            with self.assertRaises(ValueError):
                FrozenCHNN.from_file(path, expected_sha256="0"*64)

    def test_invalid_activation_batch(self):
        m = FrozenCHNN(net())
        invalid = Activations(np.zeros((1, 4), dtype=np.int64), np.array([9]), np.array([1]), m.source_sha256)
        with self.assertRaises(ValueError):
            m.design(invalid)


if __name__ == "__main__":
    unittest.main()
