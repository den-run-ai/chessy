#!/usr/bin/env python3
"""Admission and leakage-control tests for the fresh large sparse pilot."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import chess
import zstandard

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/sparse_eval"))
import data


def record(fen=chess.STARTING_FEN, cp=42, line="g1f3 g8f6"):
    return {"fen": fen, "evals": [{"depth": 22, "knodes": 200, "pvs": [{"cp": cp, "line": line}]}]}


class AdmissionTests(unittest.TestCase):
    def test_white_pov_is_not_flipped_for_black_to_move(self):
        b = chess.Board()
        b.push_uci("e2e4")
        row, reason = data.adapt_eval(record(b.fen(), cp=73, line="g8f6 g1f3"))
        self.assertIsNone(reason)
        self.assertEqual(row["cpWhite"], 73)

    def test_deepest_mate_is_excluded_not_replaced_by_weaker_cp(self):
        value = record()
        value["evals"].append({"depth": 30, "knodes": 500, "pvs": [{"mate": 5, "line": "g1f3"}]})
        self.assertEqual(data.adapt_eval(value)[1], "mate-or-invalid-cp")

    def test_depth_nodes_and_cp_filters(self):
        for key, value in (("depth", 19), ("knodes", 99)):
            r = record()
            r["evals"][0][key] = value
            self.assertEqual(data.adapt_eval(r)[1], "insufficient-search")
        self.assertEqual(data.adapt_eval(record(cp=2001))[1], "cp-outside-band")
        self.assertEqual(data.adapt_eval(record(cp=True))[1], "mate-or-invalid-cp")

    def test_entire_pv_legality(self):
        self.assertEqual(data.adapt_eval(record(line="g1f3 g8f6 f3f8"))[1], "illegal-pv")
        self.assertEqual(data.adapt_eval(record(line="a1a8"))[1], "illegal-pv")

    def test_tactical_first_move_excluded(self):
        b = chess.Board()
        for m in ("e2e4", "d7d5"):
            b.push_uci(m)
        self.assertEqual(data.adapt_eval(record(b.fen(), line="e4d5"))[1], "tactical-first-pv")

    def test_invalid_board_and_check_excluded(self):
        self.assertEqual(data.adapt_eval(record("8/8/8/8/8/8/8/8 w - - 0 1"))[1], "invalid-board")
        fen = "4k3/8/8/8/8/8/4r3/4K2R w - - 0 1"
        self.assertEqual(data.adapt_eval(record(fen, line="e1f1"))[1], "check-or-insufficient")

    def test_mirrors_and_turns_share_keys_and_role(self):
        b = chess.Board()
        for m in ("e2e4", "c7c5", "g1f3", "d7d6", "f1b5"):
            b.push_uci(m)
        values = [b.fen(), b.mirror().fen(), b.transform(chess.flip_horizontal).fen()]
        keys = [data.key_data(f) for f in values]
        self.assertEqual(len({k["cluster"] for k in keys}), 1)
        self.assertEqual(len({k["family"] for k in keys}), 1)
        self.assertEqual(len({data.role_for_family(k["family"]) for k in keys}), 1)

    def test_keys_match_independent_repository_js(self):
        b = chess.Board()
        fens = [b.fen()]
        for m in ("e2e4", "c7c5", "g1f3", "d7d6", "f1b5", "b8c6"):
            b.push_uci(m)
            fens.extend((b.fen(), b.mirror().fen()))
        script = "const c=require('./test/training/corpus.js');let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).map(f=>[c.clusterKey(f),c.positionFamilyKey(f)]))));"
        expected = json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, input=json.dumps(fens).encode()))
        for fen, (cluster, family) in zip(fens, expected):
            self.assertEqual(data.key_data(fen)["cluster"], cluster)
            self.assertEqual(data.key_data(fen)["family"], family)

    def test_quarantine_contains_incident_and_every_start_position(self):
        boundary = data.load_quarantine(ROOT)
        key = data.key_data(chess.STARTING_FEN)
        self.assertIn(key["cluster"], boundary["clusters"])
        self.assertIn(key["family"], boundary["families"])
        self.assertGreater(len(boundary["clusters"]), 2000)
        self.assertEqual(len(boundary["manifest"]["files"]), len(data.QUARANTINE))


class PublicationTests(unittest.TestCase):
    def test_same_descriptor_hash_preserves_offset(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(b"abcdef")
            stream.seek(3)
            identity = data.descriptor_identity(stream)
            self.assertEqual(identity, {"sha256": data.digest(b"abcdef"), "bytes": 6})
            self.assertEqual(stream.tell(), 3)

    def test_import_complete_manifest_no_overwrite_and_duplicate_rejection(self):
        raw = data.encoded(record()) + b"\n" + data.encoded(record()) + b"\npartial"
        compressed = zstandard.ZstdCompressor().compress(raw)
        boundary = {"clusters": set(), "families": set(), "sources": set(), "manifest": {"files": []}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.zst"
            source.write_bytes(compressed)
            manifest = root / "source.json"
            manifest.write_bytes(data.encoded({"url": data.EVAL_URL, "license": "CC0-1.0", "bytes": len(compressed), "sha256": data.digest(compressed)}))
            with mock.patch.dict(data.RULES, {"sourceBytes": len(compressed)}), mock.patch.object(data, "load_quarantine", return_value=boundary):
                output = root / "out"
                result = data.import_eval(source, manifest, output, ROOT, workers=1)
                self.assertEqual(result["counts"]["sourceRecords"], 2)
                self.assertEqual(result["counts"]["admitted"], 1)
                self.assertEqual(result["counts"]["duplicate-cluster"], 1)
                self.assertEqual(result["discardedPartialLineBytes"], 7)
                self.assertIsNone(result["uniqueSourceGames"])
                self.assertFalse(result["productionFitAllowed"])
                self.assertEqual(len(result["files"]), 3)
                for item in result["files"]:
                    value = (output / item["path"]).read_bytes()
                    self.assertEqual(data.digest(value), item["sha256"])
                with self.assertRaises(FileExistsError):
                    data.import_eval(source, manifest, output, ROOT, workers=1)

    def test_corrupt_source_never_gets_completion_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.zst"
            source.write_bytes(b"bad")
            manifest = root / "source.json"
            manifest.write_bytes(data.encoded({"url": data.EVAL_URL, "license": "CC0-1.0", "bytes": 3, "sha256": "0" * 64}))
            boundary = {"clusters": set(), "families": set(), "sources": set(), "manifest": {"files": []}}
            with mock.patch.dict(data.RULES, {"sourceBytes": 3}), mock.patch.object(data, "load_quarantine", return_value=boundary):
                with self.assertRaisesRegex(ValueError, "source bytes"):
                    data.import_eval(source, manifest, root / "out", ROOT, workers=1)
            self.assertFalse((root / "out/manifest.json").exists())


class NaturalGameTests(unittest.TestCase):
    @staticmethod
    def game_bytes():
        game = chess.pgn.Game()
        game.headers.update({"Event": "Rated Classical game", "Site": "https://lichess.org/AbCd1234",
                             "WhiteElo": "1800", "BlackElo": "1800", "TimeControl": "600+0", "Result": "1/2-1/2"})
        board, node = game.board(), game
        # Deterministic authored legal game, sufficient length without repeated
        # fixed knight shuffles; selecting by UCI order is only a test fixture.
        for ply in range(48):
            moves = sorted(board.legal_moves, key=lambda move: move.uci())
            if not moves:
                break
            move = moves[(ply * 13 + 7) % len(moves)]
            node = node.add_variation(move)
            board.push(move)
        return (str(game) + "\n").encode()

    def test_unlabelled_candidate_replays_and_has_opaque_source_identity(self):
        candidate, inventory = data.parse_pgn(self.game_bytes())
        self.assertIsNotNone(candidate)
        row, original_id = candidate
        self.assertEqual(original_id, "AbCd1234")
        self.assertEqual(row["sourceGameId"], data.digest(b"lichess:AbCd1234"))
        self.assertIsNone(row["cpWhite"])
        board = chess.Board()
        for uci in row["prefixUci"]:
            board.push_uci(uci)
        self.assertEqual(board.fen(en_passant="fen"), row["fen"])
        self.assertEqual(row["selectedPly"], len(row["prefixUci"]))

    def test_rating_bot_truncation_filters(self):
        raw = self.game_bytes()
        self.assertEqual(data.parse_pgn(raw.replace(b'WhiteElo "1800"', b'WhiteElo "800"'))[1]["reason"], "rating-or-time-control")
        self.assertEqual(data.parse_pgn(raw.replace(b'[Site ', b'[WhiteTitle "BOT"]\n[Site '))[1]["reason"], "bot")
        self.assertEqual(data.parse_pgn(raw.rstrip()[:-7])[1]["reason"], "unfinished-or-truncated")

    def test_unknown_or_unbalanced_movetext_is_not_silently_skipped(self):
        raw = self.game_bytes()
        self.assertEqual(data.parse_pgn(raw.replace(b"1. ", b"1. UNKNOWN ", 1))[1]["reason"], "invalid-metadata-or-game")
        self.assertEqual(data.parse_pgn(raw.replace(b"1. ", b"1. {unclosed ", 1))[1]["reason"], "invalid-metadata-or-game")


if __name__ == "__main__":
    unittest.main()
