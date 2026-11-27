#!/usr/bin/env python3
"""Artificial rules-only ledgers; no WASM, engine games, or holdouts are run."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import chess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval_v2 import games as g
from tools.sparse_eval_v2 import audit_games as a

spec = importlib.util.spec_from_file_location("authored_openings", Path(__file__).with_name("sparse-v2-openings.test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
CONFIG = json.loads((ROOT / "eval/sparse-pesto-v2/GAME-CONFIG.json").read_bytes())


def response(request_id, move="g1f3", nodes=10000, time_ms=0):
    return {"id": request_id, "move": move, "nodes": nodes, "qnodes": 100, "cutoffs": 15,
            "researches": 1, "depth": 2, "attempted_depth": 3, "score": 0, "scorePov": "white",
            "verifiedFen": True, "elapsed_ns": 25_500_000, "tt_saturated": False,
            "stop_reason": "time_limit" if time_ms else "node_limit"}


def artificial_campaign(directory, forge_first_outcome=False):
    """Full schedule of artificial two-cycle repetitions, never measured results."""
    directory = Path(directory)
    registration_dir, campaign = directory / "registration", directory / "campaign"
    registration_dir.mkdir(); campaign.mkdir()
    base = fixtures.row(0)
    openings = []
    for index in range(64):
        openings.append({"index": index, "selectedPly": base["selectedPly"], "prefixUci": base["prefixUci"],
                         "fen": base["fen"], "sourceGameId": str(index), "rootFamily": str(index),
                         "rootCluster": str(index), "ply8Family": str(index), "ply4Family": str(index // 4)})
    files = {}
    retained = {"openings.jsonl": b"".join(g.encoded(row) for row in openings),
                "backend/rules.js": (ROOT / "assets/engine.js").read_bytes(),
                "backend/full.wasm": b"synthetic-fixture-no-executable-module",
                "backend/full.i16le": bytes(34560)}
    for name in ("games.py", "audit_games.py", "audit_rules.js"):
        retained["implementation/" + name] = (ROOT / "tools/sparse_eval_v2" / name).read_bytes()
    for name, raw in retained.items():
        path = registration_dir / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        files[name] = {"path": name, "bytes": len(raw), "sha256": g.sha(raw)}
    schedule = g.schedule(CONFIG, openings, ["full"])
    registration = {"schema": g.SCHEMA + ".registration", "status": "frozen-before-games",
                    "testFixtureOnly": True, "models": ["full"], "variant": "compact",
                    "nodeArguments": ["--no-liftoff", "--no-wasm-lazy-compilation"],
                    "modelSettings": {"full": {"variant": "compact"}}, "config": CONFIG,
                    "files": files, "schedule": schedule, "executable": g.identity(shutil.which("node"))}
    raw = g.encoded(registration); digest = g.sha(raw)
    (registration_dir / "manifest.json").write_bytes(raw); (campaign / "registration.json").write_bytes(raw)
    ledger = g.Ledger(campaign / "raw.jsonl")
    ledger.emit({"type": "header", "registrationSha256": digest, "scheduledGames": len(schedule), "testFixtureOnly": True})
    def exchange(kind, request_id, request, result, **extra):
        result_raw = g.encoded(result)
        ledger.emit({"type": kind, "model": "full", "requestId": request_id, "request": request,
                     "requestSha256": g.sha(request.encode() + b"\n"), "response": result_raw.decode(),
                     "responseSha256": g.sha(result_raw), "wallNs": 26_000_000, **extra})
    ready_id = "full-ready"
    ready = {"id": ready_id, "mode": "ready", "variant": "compact",
             "nodeArguments": ["--no-liftoff", "--no-wasm-lazy-compilation"],
             "moduleSha256": files["backend/full.wasm"]["sha256"], "weightsSha256": files["backend/full.i16le"]["sha256"],
             "rulesSha256": files["backend/rules.js"]["sha256"]}
    exchange("ready", ready_id, "INFO\t" + ready_id, ready)
    for cycle in range(4):
        for index, fen in enumerate(CONFIG["warmup"]["fens"]):
            for mode in (["hce", "candidate"] if cycle % 2 == 0 else ["candidate", "hce"]):
                request_id = f"full-warmup-{cycle}-{index}-{mode}"
                move = next(iter(chess.Board(fen).legal_moves)).uci()
                exchange("warmup", request_id, g.request_text(request_id, mode, 10000, 0, 30, fen, fen, []),
                         response(request_id, move), mode=mode, fen=fen)
    pgn = bytearray()
    move_count = 0
    cycle = ["f3h4", "f6h5", "h4f3", "h5f6"] * 2
    for entry in schedule:
        opening = openings[entry["openingIndex"]]
        board, history = g.initial_board(opening), list(opening["prefixUci"])
        ledger.emit({"type": "start", "game": entry, "fen": opening["fen"],
                     "sourceGameId": opening["sourceGameId"], "prefixSha256": g.sha(g.encoded(history))})
        for ply, token in enumerate(cycle):
            assert g.terminal(board, ply, 180) is None
            mode = "candidate" if (board.turn == chess.WHITE) == (entry["candidateColor"] == "white") else "hce"
            request_id = f"{entry['gameId']}-{ply}"
            fen = board.fen(en_passant="fen")
            request = g.request_text(request_id, mode, entry["nodeLimit"], entry["timeMs"], 30, chess.STARTING_FEN, fen, history)
            exchange("move", request_id, request, response(request_id, token, 10000, entry["timeMs"]),
                     gameId=entry["gameId"], ply=ply, mode=mode, fen=fen, historySha256=g.sha(g.encoded(history)))
            board.push_uci(token); history.append(token); move_count += 1
        ending = g.terminal(board, 8, 180)
        assert ending == {"result": "1/2-1/2", "reason": "current-threefold"}
        if forge_first_outcome and entry["index"] == 0:
            ending = {"result": "1-0", "reason": "checkmate"}
        chunk = g.pgn_bytes(entry, opening, history, ending, "2026.11.27")
        pgn.extend(chunk)
        ledger.emit({"type": "end", "gameId": entry["gameId"], "plies": 8, **ending,
                     "fen": board.fen(en_passant="fen"), "fullHistorySha256": g.sha(g.encoded(history)),
                     "pgnSha256": g.sha(chunk), "pgnBytes": len(chunk)})
    ledger.emit({"type": "footer", "completedGames": len(schedule), "completedMoves": move_count,
                 "prefixSha256": ledger.digest.hexdigest(), "prefixBytes": ledger.size,
                 "registrationSha256": digest, "returncodes": {"full": 0}})
    raw_binding = ledger.close(); (campaign / "games.pgn").write_bytes(pgn)
    (campaign / "full.stderr").write_bytes(b"")
    completion = {"status": "complete-sealed-before-audit", "registrationSha256": digest, "games": len(schedule),
                  "moves": move_count, "raw": raw_binding, "pgn": {"path": "games.pgn", "bytes": len(pgn), "sha256": g.sha(pgn)},
                  "returncodes": {"full": 0}, "stderr": {"full": g.identity(campaign / "full.stderr")}}
    (campaign / "manifest.json").write_bytes(g.encoded(completion))
    return registration_dir / "manifest.json", digest, campaign / "manifest.json"


class GameContracts(unittest.TestCase):
    def test_balanced_complete_fixed_schedule(self):
        openings = [{"index": index} for index in range(64)]
        scheduled = g.schedule(CONFIG, openings, ["full", "pruned"])
        self.assertEqual(len(scheduled), 384)
        self.assertEqual(len({row["gameId"] for row in scheduled}), 384)
        self.assertEqual(scheduled[0]["candidateColor"], "white")
        self.assertEqual(scheduled[2]["candidateColor"], "black")
        self.assertTrue(all(row["rootSeed"] == 0 for row in scheduled))
        with self.assertRaises(ValueError):
            g.schedule(CONFIG, openings, ["full", "pruned", "extra"])

    def test_current_repetition_and_mate_precede_cap(self):
        board = chess.Board()
        for token in ["g1f3", "g8f6", "f3g1", "f6g8"]:
            board.push_uci(token)
        self.assertIsNone(g.terminal(board, 4, 180))
        for token in ["g1f3", "g8f6", "f3g1", "f6g8"]:
            board.push_uci(token)
        self.assertEqual(g.terminal(board, 8, 8)["reason"], "current-threefold")
        mate = chess.Board("7k/6Q1/5K2/8/8/8/8/8 b - - 100 1")
        self.assertEqual(g.terminal(mate, 180, 180), {"result": "1-0", "reason": "checkmate"})

    def test_response_budget_and_identity_mutations(self):
        good = response("test")
        g.validate_response(good, "test", 10000, 0, 30)
        for key, value in (("nodes", 10001), ("qnodes", 10001), ("id", "wrong"), ("scorePov", "black"),
                           ("verifiedFen", False), ("depth", 31), ("stop_reason", "time_limit"),
                           ("tt_saturated", True), ("elapsed_ns", 0), ("attempted_depth", 2)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                g.validate_response(dict(good, **{key: value}), "test", 10000, 0, 30)

    def test_config_and_json_corruption_fail_closed(self):
        g.validate_config(CONFIG)
        with self.assertRaises(ValueError):
            g.validate_config(dict(CONFIG, postOpeningPlyCap=200))
        with self.assertRaises(ValueError):
            g.decode('{"nodes":1,"nodes":2}')
        with self.assertRaises(ValueError):
            g.decode('{"value":NaN}')

    def test_endpoint_weighted_cluster_sensitivity(self):
        result = a.intervals([1, 1, 0, 0], ["a", "a", "b", "b"])
        self.assertEqual(result["mean"], .5)
        self.assertEqual(result["coarseOpeningSensitivity"]["groups"], 2)
        self.assertGreater(result["coarseOpeningSensitivity"]["standardError"], result["standardError"])
        self.assertEqual(a.intervals([.5] * 64, list(range(64)))["interval95"], [.5, .5])

    @unittest.skipUnless(shutil.which("node"), "Node is required for independent rules replay")
    def test_complete_artificial_256_game_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            registration, digest, campaign = artificial_campaign(directory)
            result = a.audit(registration, digest, campaign, Path(directory) / "audit")
            self.assertEqual(result["allGamesReplayed"], 256)
            self.assertEqual(result["searchesRerun"], 0)
            self.assertEqual([row["draws"] for row in result["profiles"]], [128, 128])
            self.assertTrue(result["profiles"][0]["timeBudgetAudit"]["cleanRealizedEqualTime"])
            # A coherent rehash cannot hide a different WASM execution tier.
            completed = json.loads(campaign.read_bytes())
            raw_path = campaign.parent / completed["raw"]["path"]
            rows = [json.loads(line) for line in raw_path.read_bytes().splitlines()]
            ready = next(row for row in rows if row["type"] == "ready")
            handshake = json.loads(ready["response"])
            handshake["nodeArguments"] = []
            changed = g.encoded(handshake)
            ready["response"], ready["responseSha256"] = changed.decode(), g.sha(changed)
            prefix = b"".join(g.encoded(row) for row in rows[:-1])
            rows[-1]["prefixSha256"], rows[-1]["prefixBytes"] = g.sha(prefix), len(prefix)
            changed = prefix + g.encoded(rows[-1])
            raw_path.write_bytes(changed)
            completed["raw"].update(bytes=len(changed), sha256=g.sha(changed))
            campaign.write_bytes(g.encoded(completed))
            with self.assertRaisesRegex(ValueError, "ready handshake content differs"):
                a.audit(registration, digest, campaign, Path(directory) / "bad-tier-audit")

    @unittest.skipUnless(shutil.which("node"), "Node is required for independent rules replay")
    def test_rehashed_ledger_and_pgn_cannot_forge_a_win(self):
        with tempfile.TemporaryDirectory() as directory:
            registration, digest, campaign = artificial_campaign(directory, forge_first_outcome=True)
            with self.assertRaisesRegex(ValueError, "independently reconstructed outcome differs"):
                a.audit(registration, digest, campaign, Path(directory) / "audit")


if __name__ == "__main__":
    unittest.main()
