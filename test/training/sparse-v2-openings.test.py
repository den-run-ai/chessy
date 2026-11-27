#!/usr/bin/env python3
"""Authored label-free contracts for the fresh paired-game selector."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import chess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval_v2 import openings as o

LINES = [
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8",
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 d2d3 e8g8",
    "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8 g1f3 h7h6 g5h4 b7b6 f1d3 c8b7",
]


def row(index):
    moves = LINES[index].split()
    board = chess.Board()
    for token in moves:
        board.push_uci(token)
    fen = board.fen(en_passant="fen")
    return dict(o.key_data(fen), fen=fen, prefixUci=moves, selectedPly=len(moves),
                sourceGameId=hashlib.sha256(str(index).encode()).hexdigest(), sourceId="authored-fixture")


class OpeningContracts(unittest.TestCase):
    def test_full_history_and_fen_replay(self):
        groups = o.replay(row(0))
        self.assertEqual(set(groups), {4, 8})
        for mutate in (lambda r: r["prefixUci"].__setitem__(0, "e2e5"),
                       lambda r: r.__setitem__("fen", r["fen"].replace(" 4 ", " 5 ")),
                       lambda r: r.__setitem__("family", "0" * 64)):
            candidate = row(0)
            mutate(candidate)
            if candidate != row(0):
                with self.assertRaises(ValueError):
                    o.replay(candidate)

    def test_early_family_prevents_related_root_pseudoreplication(self):
        selected, rejected = o.choose([(index, index + 1, row(index)) for index in range(3)], count=2)
        self.assertEqual([item["sourceGameId"] for item in selected], [row(0)["sourceGameId"], row(2)["sourceGameId"]])
        self.assertEqual(rejected, {"duplicate:ply8Family": 1})
        self.assertEqual(len({item["rootFamily"] for item in selected}), 2)

    def test_all_rows_required_and_teacher_fields_do_not_rank(self):
        ranked = [(index, index + 1, dict(row(index), cpWhite=1000000 * (-1) ** index)) for index in range(3)]
        chosen, _ = o.choose(ranked, count=2)
        self.assertEqual(chosen[0]["sourceGameId"], row(0)["sourceGameId"])
        with self.assertRaises(ValueError):
            o.choose(ranked[:2], count=2)

    def test_historical_root_family_is_excluded(self):
        quarantine = {"families": {row(0)["family"]}, "clusters": set()}
        chosen, _ = o.choose([(0, 1, row(0)), (1, 3, row(2))], count=1, quarantine=quarantine)
        self.assertEqual(chosen[0]["sourceGameId"], row(2)["sourceGameId"])

    def test_same_bytes_inventory_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.jsonl"
            payload = o.encoded({"a": 1}) + o.encoded({"a": 2})
            path.write_bytes(payload)
            binding = {"path": path.name, "bytes": len(payload), "rows": 2, "sha256": o.sha(payload)}
            self.assertEqual([record for _, record in o.rows(directory, binding)], [{"a": 1}, {"a": 2}])
            for key, value in (("rows", 1), ("sha256", "0" * 64), ("path", "../rows.jsonl")):
                with self.assertRaises(ValueError):
                    list(o.rows(directory, dict(binding, **{key: value})))

    def test_missing_history_is_not_reconstructed_from_fen(self):
        candidate = row(0)
        candidate["prefixUci"] = []
        with self.assertRaises(ValueError):
            o.replay(candidate)


if __name__ == "__main__":
    unittest.main()
