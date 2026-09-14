#!/usr/bin/env python3
"""Meaningful selector checks: illegal/truncated source, leakage and JS parity."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import random
import subprocess
import tempfile
import unittest

import chess

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("natural_select", HERE / "natural-select.py")
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
RULES = json.loads(selector.RULES.read_text())
SANS = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 a4 c5 d5 c4"


def fixture(sid="Abcd1234"):
    return ('[Event "Rated Classical game"]\n[Site "https://lichess.org/' + sid + '"]\n'
            '[UTCDate "2013.01.10"]\n[WhiteElo "1700"]\n[BlackElo "1650"]\n'
            '[TimeControl "300+0"]\n[Result "1-0"]\n\n' + SANS + ' 1-0\n\n').encode()


class NaturalSelectorTest(unittest.TestCase):
    def test_keys_equal_existing_js_on_corpus_and_independent_trajectories(self):
        rows = [json.loads(line) for line in (selector.ROOT / "eval/corpus/eval-v1.ndjson").read_text().splitlines()]
        fens = [row["fen"] for row in rows if "fen" in row]
        rng = random.Random(1370930)
        board = chess.Board()
        for _ in range(160):
            if board.is_game_over():
                board.reset()
            board.push(rng.choice(list(board.legal_moves)))
            fens.append(board.fen(en_passant="fen"))
        script = "const C=require(process.argv[1]);let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(f=>({cluster:C.clusterKey(f),positionFamily:C.positionFamilyKey(f),phaseBucket:C.phaseBucket(f)})))));"
        result = subprocess.check_output(["node", "-e", script, str(HERE / "corpus.js")], input=json.dumps(fens).encode())
        self.assertEqual([selector.key_data(fen) for fen in fens], json.loads(result))

    def test_candidate_replays_exact_fen_and_is_quiet(self):
        row, inventory = selector.parse_game(fixture(), 0, 125, RULES)
        self.assertIsNotNone(row)
        board = chess.Board()
        for uci in row["prefixUci"]:
            board.push_uci(uci)
        self.assertEqual(board.fen(en_passant="fen"), row["fen"])
        self.assertFalse(board.is_check())
        self.assertGreaterEqual(board.halfmove_clock, 2)
        self.assertEqual(row["sourceGame"]["selectedPly"], len(row["prefixUci"]))
        self.assertEqual(row["sourceGame"]["pgnByteStart"], 125)
        self.assertEqual(row["sourceGame"]["rawSha256"], selector.sha(fixture()))

    def test_invalid_late_move_cannot_supply_valid_earlier_candidate(self):
        raw = fixture().replace(b"c4 1-0", b"Kzz 1-0")
        row, record = selector.parse_game(raw, 0, 0, RULES)
        self.assertIsNone(row)
        self.assertEqual(record["reason"], "malformed-pgn")

    def test_truncation_and_conflicting_result_rejected(self):
        for raw, expected in ((fixture().rstrip()[:-3], "missing-final-result-token"),
                              (fixture().replace(b"c4 1-0", b"c4 0-1"), "conflicting-result-token")):
            row, record = selector.parse_game(raw, 0, 0, RULES)
            self.assertIsNone(row)
            self.assertEqual(record["reason"], expected)

    def test_missing_metadata_and_outside_time_control_rejected(self):
        for raw, reason in ((fixture().replace(b'[WhiteElo "1700"]\n', b""), "missing-source-metadata"),
                            (fixture().replace(b"300+0", b"60+0"), "time-control-too-fast")):
            row, record = selector.parse_game(raw, 0, 0, RULES)
            self.assertIsNone(row)
            self.assertEqual(record["reason"], reason)

    def test_archive_framing_preserves_every_original_byte(self):
        first, second = fixture(), fixture("Efgh5678")
        games = list(selector.iter_raw_games(io.BytesIO(first + second)))
        self.assertEqual(games, [(0, first), (len(first), second)])
        with self.assertRaisesRegex(ValueError, "before first Event"):
            list(selector.iter_raw_games(io.BytesIO(b"garbage\n" + first)))

    def test_source_and_family_isolation_no_quarantine_substitution(self):
        row, _ = selector.parse_game(fixture(), 0, 0, RULES)
        candidates, inventory = [], []
        for index in range(8):
            candidate = copy.deepcopy(row)
            candidate.update(id=str(index), selectionPriority=str(index), sourceId=str(index), cluster=str(index))
            candidate["sourceGame"]["index"] = index
            candidates.append(candidate)
            inventory.append({"index": index})
        boundary = {"sources": set(), "families": set(), "clusters": {"0"}}
        selected = selector.select_global(candidates, inventory, boundary, RULES)
        self.assertEqual(len(selected), 4)
        self.assertEqual(inventory[0]["reason"], "quarantined-model-cluster")
        self.assertEqual(inventory[7]["reason"], "structural-family-cap")
        self.assertEqual(len({r["role"] for r in selected}), 1)
        # A duplicate source ID at a different family still cannot cross roles.
        candidates[2]["sourceId"] = candidates[1]["sourceId"]
        candidates[2]["positionFamily"] = "d" * 64
        selected = selector.select_global(candidates, inventory, boundary, RULES)
        self.assertEqual(inventory[2]["reason"], "duplicate-source-game")
        self.assertEqual(len({r["sourceId"] for r in selected}), len(selected))

    def test_shortfall_never_claims_full_pilot(self):
        report = selector.coverage([], RULES)
        self.assertFalse(report["fullPilotReady"])
        self.assertIn("fewer-than-40000-selected", report["failedGates"])

    def test_partial_archive_rejected_before_output_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "partial.zst", Path(tmp) / "output"
            source.write_bytes(b"not-the-complete-archive")
            with self.assertRaisesRegex(ValueError, "complete official compressed archive"):
                selector.run(source, output, selector.ROOT)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    import logging
    logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)
    unittest.main()
