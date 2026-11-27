#!/usr/bin/env python3
"""Input/admission tests independent of real OOD labels and source outcomes."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import chess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import label_ood as o


def row(moves=()):
    board = chess.Board()
    for move in moves:
        board.push_uci(move)
    return {"fen": board.fen(en_passant="fen"), "prefixUci": list(moves), "selectedPly": len(moves),
            "sourceGameId": "0" * 64, "oodIndex": 0}


def trace(score="cp 25", move="e2e4", pv="e2e4 e7e5", nodes=100002, depth=16,
          wdl="430 400 170", extra=""):
    return [f"info depth {depth} seldepth 20 multipv 1 score {score} {extra} wdl {wdl} nodes {nodes} time 50 pv {pv}",
            f"bestmove {move}"]


class Admission(unittest.TestCase):
    def test_valid_white_and_black_pov(self):
        label, reason = o.admit_label(row(), trace())
        self.assertIsNone(reason)
        self.assertEqual(label["cpWhite"], 25)
        self.assertEqual(label["wdlWhite"], [430, 400, 170])
        label, reason = o.admit_label(row(["e2e4"]), trace(move="e7e5", pv="e7e5 g1f3"))
        self.assertIsNone(reason)
        self.assertEqual(label["cpWhite"], -25)
        self.assertEqual(label["wdlWhite"], [170, 400, 430])

    def test_teacher_exclusions_are_explicit(self):
        cases = [
            (trace(score="mate 3"), "mate-score"),
            (trace(score="cp 2001"), "invalid-or-outside-cp-band"),
            (trace(nodes=99999), "below-node-budget"),
            (trace(depth=9), "below-depth-floor"),
            (trace(extra="lowerbound"), "bounded-score"),
            (trace(extra="upperbound"), "bounded-score"),
            (trace(move="d2d4"), "bestmove-pv-mismatch"),
            (trace(pv="e2e4 e7e5 e1e8"), "illegal-pv"),
            (trace(wdl="500 500 500"), "invalid-wdl"),
            (trace(wdl="-1 500 501"), "invalid-wdl"),
            (["bestmove e2e4"], "missing-final-score-pv"),
            (trace() + ["bestmove e2e4"], "missing-or-duplicate-bestmove"),
        ]
        for lines, expected in cases:
            label, reason = o.admit_label(row(), lines)
            self.assertIsNone(label)
            self.assertEqual(reason, expected)

    def test_tactical_bestmove_excluded(self):
        root = row(["e2e4", "d7d5"])
        label, reason = o.admit_label(root, trace(move="e4d5", pv="e4d5 d8d5"))
        self.assertIsNone(label)
        self.assertEqual(reason, "tactical-teacher-first-move")

    def test_last_pv_is_authoritative_and_multipv_filtered(self):
        lines = trace(score="cp 12")[:-1] + trace(score="cp 30")
        label, reason = o.admit_label(row(), lines)
        self.assertIsNone(reason)
        self.assertEqual(label["cpWhite"], 30)
        lines.insert(-1, trace(score="cp 900")[0].replace("multipv 1", "multipv 2"))
        label, reason = o.admit_label(row(), lines)
        self.assertIsNone(reason)
        self.assertEqual(label["cpWhite"], 30)

    def test_full_history_must_reproduce_exact_fen(self):
        original = row(["e2e4", "e7e5", "g1f3"])
        self.assertEqual(o.history_board(original).fullmove_number, 2)
        for mutation in (
                dict(original, selectedPly=2),
                dict(original, prefixUci=["e2e5", "e7e5", "g1f3"]),
                dict(original, fen=original["fen"].replace(" 1 2", " 2 2"))):
            with self.assertRaises(ValueError):
                o.history_board(mutation)

    def test_input_bytes_and_complete_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = b'{"a":1}\n{"a":2}\n'
            (root / "rows.jsonl").write_bytes(payload)
            binding = {"path": "rows.jsonl", "bytes": len(payload), "rows": 2,
                       "sha256": hashlib.sha256(payload).hexdigest()}
            self.assertEqual(list(o.verified_rows(root, binding)), [{"a": 1}, {"a": 2}])
            for mutated in (dict(binding, rows=3), dict(binding, bytes=0),
                            dict(binding, sha256="0" * 64), dict(binding, path="../rows.jsonl")):
                with self.assertRaises(ValueError):
                    list(o.verified_rows(root, mutated))
            iterator = o.verified_rows(root, binding)
            self.assertEqual(next(iterator), {"a": 1})
            (root / "replacement").write_bytes(payload)
            os.replace(root / "replacement", root / "rows.jsonl")
            with self.assertRaises(ValueError):
                list(iterator)

    def test_missing_completion_never_admitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "manifest.json"
            manifest = {"schema": "x", "status": "complete", "researchOnly": True,
                        "productionFitAllowed": False}
            path.write_text(json.dumps(manifest))
            got, identity = o.load_manifest(path, "x", "complete")
            self.assertEqual(got, manifest)
            for mutation in (dict(manifest, status="partial"), dict(manifest, productionFitAllowed=True),
                             dict(manifest, researchOnly=False)):
                path.write_text(json.dumps(mutation))
                with self.assertRaises(ValueError):
                    o.load_manifest(path, "x", "complete")


class RealTeacher(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("SPARSE_OOD_STOCKFISH"), "explicit real-teacher smoke only")
    def test_real_protocol_with_authored_position(self):
        engine = Path(os.environ["SPARSE_OOD_STOCKFISH"])
        self.assertEqual(hashlib.sha256(engine.read_bytes()).hexdigest(), o.OFFICIAL_ENGINE_SHA256)
        with tempfile.TemporaryDirectory() as temporary:
            process = o.UCI(engine, temporary)
            try:
                result = process.label(row(["e2e4", "e7e5", "g1f3", "b8c6"]))
                self.assertEqual(result["oodIndex"], 0)
                self.assertEqual(sum(event["line"].startswith("bestmove ") for event in result["events"]), 1)
                self.assertIn(result["exclusion"], (None, "tactical-teacher-first-move", "bestmove-pv-mismatch", "bounded-score"))
                if result["label"]:
                    self.assertGreaterEqual(result["label"]["nodes"], 100000)
            finally:
                process.close()


if __name__ == "__main__":
    unittest.main()
