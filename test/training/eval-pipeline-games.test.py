#!/usr/bin/env python3
"""Rules-only synthetic ledgers plus a tiny production-host plumbing smoke.

No historical strength evidence, training data, or locked openings are used.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import chess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.eval_pipeline import frontier as f
from tools.eval_pipeline import games as g


def configuration(module_hash):
    return {"schema": f.SCHEMA, "experimentId": "synthetic-game-ledger-contract",
            "researchOnly": True, "productionAdmission": False, "syntheticFixtureOnly": True,
            "base": {"id": "hce-base", "sha256": module_hash},
            "candidate": {"id": "hce-control", "sha256": module_hash},
            "timeControlsMs": [1, 2], "openingIds": ["fixture-0", "fixture-1"],
            "nodeLimit": 0, "maxDepth": 3, "postOpeningPlyCap": 180,
            "bootstrap": {"seed": 137, "samples": 2000, "confidence": .95},
            "warmup": {"cycles": 1, "nodeLimit": 100, "timeMs": 0, "fens": [chess.STARTING_FEN]}}


def fixture_inputs(directory, actual=False):
    directory = Path(directory)
    source = directory / "input"
    source.mkdir()
    module_raw = (ROOT / "assets/chessy-ai-fast.wasm").read_bytes() if actual else b"synthetic-not-executable-wasm"
    (source / "engine.wasm").write_bytes(module_raw)
    cfg = configuration(g.sha(module_raw))
    if actual:
        cfg.update(maxDepth=1, postOpeningPlyCap=2)
    (source / "config.json").write_bytes(g.encoded(cfg))
    board = chess.Board()
    prefix = ["g1f3", "g8f6"]
    for token in prefix:
        board.push_uci(token)
    openings = [{"openingId": key, "sourceGameId": "authored-source-" + str(index),
                 "prefixUci": prefix, "selectedPly": 2, "fen": board.fen(en_passant="fen")}
                for index, key in enumerate(cfg["openingIds"])]
    (source / "openings.jsonl").write_bytes(b"".join(g.encoded(row) for row in openings))
    node = shutil.which("node") if actual else sys.executable
    receipt = g.register(source / "config.json", source / "openings.jsonl", source / "engine.wasm", source / "engine.wasm",
                         ROOT / "tools/eval_pipeline/host.mjs", ROOT / "assets/wasm-engine.js", ROOT / "assets/engine.js",
                         node, directory / "campaign")
    return directory / "campaign", cfg, openings, receipt


def search_response(request, token, board):
    move = chess.Move.from_uci(token)
    def internal(square):
        return (7 - chess.square_rank(square)) * 8 + chess.square_file(square)
    return {"id": request["id"], "ok": True,
            "result": {"move": {"from": internal(move.from_square), "to": internal(move.to_square), "promotion": None},
                       "uci": token, "score": 0, "scorePov": "white", "depth": 1, "attemptedDepth": 2,
                       "nodes": 100, "qnodes": 50, "cutoffs": 4, "researches": 2,
                       "stopReason": "time-limit" if request["timeMs"] else "node-limit",
                       "engineCallMs": request["timeMs"] + .1},
            "rules": {"fen": board.fen(en_passant="fen"), "legalUcis": sorted(move.uci() for move in board.legal_moves),
                      "status": {"over": False, "check": board.is_check()}}}


def synthetic_campaign(directory):
    root, cfg, openings, receipt = fixture_inputs(directory)
    reg, _, digest = g.load_registration(root)
    ledger = g.Ledger(root / "raw.jsonl")
    ledger.emit({"type": "header", "schema": g.SCHEMA + ".raw", "registrationSha256": digest,
                 "scheduledGames": len(reg["schedule"]), "resultsSealedUntilComplete": True})
    info = {"abiVersion": 2, "nodeVersion": "synthetic", "v8Version": "synthetic", "execArgv": [],
            "loaderSha256": reg["files"]["backend/wasm-engine.cjs"]["sha256"],
            "rulesSha256": reg["files"]["backend/engine.cjs"]["sha256"],
            "engines": {side: {"sha256": cfg[side]["sha256"], "bytes": reg["files"]["backend/" + side + ".wasm"]["bytes"],
                                "memoryBytes": 0, "loadMs": 0} for side in ("base", "candidate")}}
    def exchange(kind, request, response, **metadata):
        raw = g.encoded(response)
        ledger.emit({"type": kind, **metadata, "request": request, "requestSha256": g.sha(g.encoded(request)),
                     "response": raw.decode(), "responseSha256": g.sha(raw),
                     "wallNs": int((request.get("timeMs", 0) + 1) * 1e6)})
    request = {"id": "info", "op": "info"}
    exchange("info", request, {"id": "info", "ok": True, "result": info})
    for side in ("base", "candidate"):
        request = {"id": "warmup-0-0-" + side, "op": "search", "engine": side,
                   "fen": chess.STARTING_FEN, "historyFens": [chess.STARTING_FEN], "maxDepth": 3,
                   "nodeLimit": 100, "timeMs": 0, "rootSeed": 0}
        exchange("warmup", request, search_response(request, "g1f3", chess.Board()))
    records, pgns, total = [], [], 0
    cycle = ["f3h4", "f6h5", "h4f3", "h5f6"] * 2
    for slot in reg["schedule"]:
        opening = next(row for row in openings if row["openingId"] == slot["openingId"])
        board, history = g.prefix_board(opening)
        full_moves = list(opening["prefixUci"])
        ledger.emit({"type": "start", "slot": slot, "fen": history[-1], "sourceGameId": opening["sourceGameId"],
                     "prefixSha256": g.sha(g.encoded(full_moves))})
        for ply, token in enumerate(cycle):
            assert g.ending(board, ply, 180) is None
            side = "candidate" if (board.turn == chess.WHITE) == (slot["candidateColor"] == "white") else "base"
            request = {"id": slot["scheduleId"] + "-" + str(ply), "op": "search", "engine": side,
                       "fen": history[-1], "historyFens": list(history), "maxDepth": 3,
                       "nodeLimit": 0, "timeMs": slot["timeMs"], "rootSeed": 0}
            exchange("move", request, search_response(request, token, board), scheduleId=slot["scheduleId"], ply=ply,
                     historySha256=g.sha(g.encoded(history)))
            board.push_uci(token)
            full_moves.append(token)
            history.append(board.fen(en_passant="fen"))
        terminal = {"result": "1/2-1/2", "termination": "current-threefold"}
        request = {"id": slot["scheduleId"] + "-replay", "op": "replay", "moves": full_moves}
        exchange("replay", request, {"id": request["id"], "ok": True,
                 "result": {"fen": history[-1], "historyFens": history,
                            "legalUcis": sorted(move.uci() for move in board.legal_moves),
                            "status": {"over": True, "result": "1/2-1/2", "reason": "threefold repetition"}}},
                 scheduleId=slot["scheduleId"])
        pgn = g.game_pgn(slot, opening, full_moves, terminal)
        pgns.append(pgn)
        record = {**slot, **terminal, "postOpeningPlies": len(cycle), "completed": True, "nodeLimit": 0,
                  "baseSha256": cfg["base"]["sha256"], "candidateSha256": cfg["candidate"]["sha256"],
                  "sourceGameId": opening["sourceGameId"], "fullMoves": full_moves, "finalFen": history[-1],
                  "historySha256": g.sha(g.encoded(history)), "pgnSha256": g.sha(pgn), "pgnBytes": len(pgn)}
        records.append(record)
        ledger.emit({"type": "end", "record": record})
        total += len(cycle)
    ledger.emit({"type": "footer", "registrationSha256": digest, "completedGames": len(records), "completedMoves": total,
                 "returncode": 0, "prefixSha256": ledger.digest.hexdigest(), "prefixBytes": ledger.size})
    raw = ledger.close()
    payloads = {"games.jsonl": b"".join(g.encoded(row) for row in records), "games.pgn": b"".join(pgns), "host.stderr": b""}
    files = {"raw.jsonl": raw}
    for name, payload in payloads.items():
        (root / name).write_bytes(payload)
        files[name] = {"path": name, "bytes": len(payload), "sha256": g.sha(payload)}
    completion = {"schema": g.SCHEMA + ".completion", "status": "complete-sealed-before-audit", "registrationSha256": digest,
                  "games": len(records), "moves": total, "files": files, "hostInfo": info, "outcomeSummaryProduced": False}
    (root / "completion.json").write_bytes(g.encoded(completion))
    return root, digest


def reseal_raw(root, mutate):
    """Alter semantic evidence and reauthenticate bytes, defeating hash-only audits."""
    rows = [g.decoded(line) for line in (root / "raw.jsonl").read_bytes().splitlines()]
    mutate(rows)
    prefix = b"".join(g.encoded(row) for row in rows[:-1])
    rows[-1].update(prefixSha256=g.sha(prefix), prefixBytes=len(prefix))
    raw = prefix + g.encoded(rows[-1])
    (root / "raw.jsonl").write_bytes(raw)
    completion = g.decoded((root / "completion.json").read_bytes())
    completion["files"]["raw.jsonl"].update(bytes=len(raw), sha256=g.sha(raw), rows=len(rows))
    (root / "completion.json").write_bytes(g.encoded(completion))


class GameContracts(unittest.TestCase):
    def test_registration_requires_exact_module_and_full_prefix(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, cfg, openings, receipt = fixture_inputs(temporary)
            registration, selected, digest = g.load_registration(root, receipt["registrationSha256"])
            self.assertEqual(len(registration["schedule"]), 8)
            self.assertEqual(len(selected), 2)
            self.assertIn("source/chess/__init__.py", registration["files"])
            with self.assertRaisesRegex(ValueError, "external pre-game"):
                g.load_registration(root, "0" * 64)
            bad = copy.deepcopy(openings[0])
            bad["prefixUci"] = bad["prefixUci"][:-1]
            with self.assertRaisesRegex(ValueError, "complete opening"):
                g.prefix_board(bad)
            bad = copy.deepcopy(openings[0])
            bad["prefixUci"][0] = "a1a8"
            with self.assertRaisesRegex(ValueError, "illegal opening"):
                g.prefix_board(bad)

    def test_full_synthetic_campaign_replays_all_histories_and_pgns(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, digest = synthetic_campaign(temporary)
            report = g.audit(root, digest, publish=False)
            self.assertEqual(report["games"], 8)
            self.assertEqual(report["campaignAudit"]["movesReplayed"], 64)
            self.assertEqual(report["campaignAudit"]["pgnsVerified"], 8)
            self.assertEqual(report["campaignAudit"]["searchesRerun"], 0)
            self.assertTrue(all(row["cleanRealizedEqualTime"] for row in report["timing"]))
            self.assertTrue(all(row["candidateScore"] == .5 for row in report["profiles"]))
            self.assertFalse(report["policy"]["productionEnable"])

    def test_missing_history_rejected_even_after_rehash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, digest = synthetic_campaign(temporary)
            def mutate(rows):
                row = next(row for row in rows if row["type"] == "move")
                row["request"]["historyFens"] = row["request"]["historyFens"][-1:]
                row["requestSha256"] = g.sha(g.encoded(row["request"]))
            reseal_raw(root, mutate)
            with self.assertRaisesRegex(ValueError, "reconstructed request"):
                g.audit(root, digest, publish=False)

    def test_illegal_move_rejected_even_after_rehash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, digest = synthetic_campaign(temporary)
            def mutate(rows):
                row = next(row for row in rows if row["type"] == "move")
                response = g.decoded(row["response"])
                response["result"]["uci"] = "a1a8"
                raw = g.encoded(response)
                row.update(response=raw.decode(), responseSha256=g.sha(raw))
            reseal_raw(root, mutate)
            with self.assertRaisesRegex(ValueError, "illegal selected"):
                g.audit(root, digest, publish=False)

    def test_early_outcome_missing_game_and_time_forgery_are_rejected(self):
        mutations = [lambda rows: next(row for row in rows if row["type"] == "end")["record"].update(result="1-0", termination="checkmate"),
                     lambda rows: rows.pop(next(i for i, row in enumerate(rows) if row["type"] == "start")),
                     lambda rows: next(row for row in rows if row["type"] == "move").update(wallNs=0)]
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root, digest = synthetic_campaign(temporary)
                reseal_raw(root, mutation)
                with self.assertRaises(ValueError):
                    g.audit(root, digest, publish=False)

    def test_failure_receipt_and_source_drift_block_audit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, digest = synthetic_campaign(temporary)
            (root / "failure.json").write_text('{"status":"failed"}')
            with self.assertRaisesRegex(ValueError, "failed campaign"):
                g.audit(root, digest, publish=False)
        with tempfile.TemporaryDirectory() as temporary:
            root, digest = synthetic_campaign(temporary)
            source = root / "backend/engine.cjs"
            source.chmod(0o644)
            source.write_bytes(source.read_bytes() + b"\n// changed\n")
            with self.assertRaisesRegex(ValueError, "retained bytes"):
                g.audit(root, digest, publish=False)

    def test_rules_terminal_precedes_ply_cap(self):
        board = chess.Board()
        for token in ["f2f3", "e7e5", "g2g4", "d8h4"]:
            board.push_uci(token)
        self.assertEqual(g.ending(board, 4, 4), {"result": "0-1", "termination": "checkmate"})
        self.assertEqual(g.audited_ending(board, 4, 4), {"result": "0-1", "termination": "checkmate"})

    def test_production_host_retained_runner_smoke(self):
        self.assertIsNotNone(shutil.which("node"), "Node is required by the production host contract")
        with tempfile.TemporaryDirectory() as temporary:
            root, cfg, openings, receipt = fixture_inputs(temporary, actual=True)
            command = [sys.executable, str(root / "source/games.py"), "run", str(root),
                       "--registration-sha256", receipt["registrationSha256"]]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            report = g.audit(root, receipt["registrationSha256"], publish=False)
            self.assertEqual(report["games"], 8)
            self.assertEqual(report["campaignAudit"]["movesReplayed"], 16)
            self.assertTrue(all(row["terminationCounts"] == {"ply-cap": 4} for row in report["profiles"]))
            first = (root / "raw.jsonl").read_bytes()
            rejected = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual((root / "raw.jsonl").read_bytes(), first)


if __name__ == "__main__":
    unittest.main()
