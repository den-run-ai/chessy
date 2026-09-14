#!/usr/bin/env python3
"""Synthetic adversarial checks; never open real training or holdout labels."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import chess

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("natural_label_audit", ROOT / "tools/training/audit-natural-labels.py")
A = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(A)
TEACHER = json.loads((ROOT / "eval/training/natural-teacher-v1.json").read_text())
RULES = json.loads((ROOT / "eval/training/natural-pilot-v1.json").read_text())
FIT = json.loads((ROOT / "eval/training/natural-fit-v1.json").read_text())
PREFIX = ["e2e4", "e7e5", "g1f3", "b8c6"]
PV = ["f1b5", "a7a6", "b5a4"]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value, rows=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    items = value if rows else [value]
    raw = b"".join((json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n").encode() for item in items)
    path.write_bytes(raw)
    return {"path": path.name, "sha256": sha(raw), "bytes": len(raw), "rows": len(items)}


def fixture_row(index=0, role="shared-train", prefix=None):
    prefix = list(prefix or PREFIX)
    board = chess.Board()
    for move in prefix:
        board.push_uci(move)
    return {"schema": "chessy.natural-pilot-row.v1", "id": sha(str(index).encode()),
            "role": role, "sourceId": f"test{index:04d}", "prefixUci": prefix,
            "sourceGame": {"id": f"test{index:04d}", "selectedPly": len(prefix)},
            "fen": board.fen(en_passant="fen"), "fen4": " ".join(board.fen(en_passant="fen").split()[:4])}


def row_events(row, invalid_depth=False, extra_info=None):
    lines = ["# row-start " + row["id"], "> ucinewgame", "> setoption name Clear Hash", "> isready", "< readyok",
             "> position startpos moves " + " ".join(row["prefixUci"]), "> go nodes 100000",
             "< info depth 12 seldepth " + ("11" if invalid_depth else "14") + " score cp 18 wdl 40 940 20 nodes 90000 pv f1b5 a7a6 b5a4"]
    if extra_info:
        lines.extend(extra_info)
    lines.extend(["< info depth 13 seldepth 15 score cp 20 lowerbound nodes 100021 pv f1b5",
                  "< bestmove f1b5 ponder a7a6",
                  "# row-end " + ("invalid-search-depth" if invalid_depth else "accepted")])
    return lines


def startup(teacher):
    return ["> uci", "< Stockfish 18 by the Stockfish developers", "< id name Stockfish 18", "< uciok"] + [
        "> setoption name " + name + " value " + str(teacher["uci"][name]).lower()
        for name in ("Threads", "Hash", "Ponder", "MultiPV", "SyzygyPath", "UCI_LimitStrength", "UCI_ShowWDL")] + [
        "> isready", "< readyok", "> export_net big.nnue small.nnue", "> isready", "< info string exported network", "< readyok"]


def make_bundle(parent):
    repo, selected_dir, directory = parent / "repo", parent / "selection", parent / "closed-label-fixture"
    teacher, rules, fit = copy.deepcopy(TEACHER), copy.deepcopy(RULES), copy.deepcopy(FIT)
    engine = parent / "fake-stockfish-bytes"
    engine.write_bytes(b"synthetic fixture; never executable")
    teacher["engine"]["executable"]["sha256"] = sha(engine.read_bytes())
    configs = {}
    for name, value in (("natural-pilot-v1.json", rules), ("natural-fit-v1.json", fit), ("natural-teacher-v1.json", teacher)):
        configs[name] = write(repo / "eval/training" / name, value)
        configs[name]["path"] = "eval/training/" + name
        configs[name].pop("rows")
    by_role = {role: [] for role in A.ROLES}
    roles = ["shared-train"] * 2 + ["hce-validation"] * 2 + ["hce-test"] * 2 + ["nnue-validation", "nnue-test"]
    rows = [fixture_row(i, role) for i, role in enumerate(roles)]
    for row in rows:
        by_role[row["role"]].append(row)
    selection = {"schema": "chessy.natural-pilot-selection.v1", "status": "complete-research-only-selection",
        "productionFitAllowed": False, "coverage": {"fullPilotReady": True},
        "preregistration": configs["natural-pilot-v1.json"], "fitPreregistration": configs["natural-fit-v1.json"],
        "teacherContract": configs["natural-teacher-v1.json"],
        "source": {"sha256": rules["source"]["sha256"], "uncompressedSha256": "b" * 64},
        "selection": {"rows": 8, "files": [{"role": role, **write(selected_dir / (role + ".ndjson"), values, True)} for role, values in by_role.items()]}}
    selection_identity = write(selected_dir / "manifest.json", selection)
    implementation = {}
    for relative in A.IMPLEMENTATION:
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic implementation placeholder\n")
        implementation[relative] = sha(path.read_bytes())
    accepted, excluded, workers = {role: [] for role in A.ROLES}, [], []
    for i, row in enumerate(rows):
        events = row_events(row, invalid_depth=i == 7)
        outcome = A.audit_row_conversation(events, row, teacher, 2000)
        if outcome["accepted"]:
            accepted[row["role"]].append({**row, "teacher": outcome["teacher"]})
        else:
            excluded.append({**row, "exclusion": {k: outcome[k] for k in ("reason", "detail", "attempted")}})
        transcript = [{"rowId": None, "index": None, "line": line} for line in startup(teacher)]
        transcript += [{"rowId": row["id"], "index": i, "line": line} for line in events]
        transcript += [{"rowId": None, "index": None, "line": "> quit"}]
        workers.append({"slot": i, "status": "completed", "networks": [
            {k: network[k] for k in ("option", "sha256", "bytes")} for network in teacher["engine"]["networks"]],
            "transcript": write(directory / f"worker-{i}.uci.jsonl", transcript, True),
            "partition": write(directory / f"worker-{i}.partition.jsonl", [{"index": i, "id": row["id"], **outcome}], True)})
    summary = {"schema": "chessy.natural-pilot-label-summary.v1", "status": "completed", "formalPass": False,
        "disposition": "research-only-not-production-fit-eligible", "failures": [], "teacher": teacher,
        "execution": {"workers": 8, "assignment": "complete-role-order-index-mod-workers", "positionCommand": "startpos-full-prefix", "retry": False},
        "output": {"selectedRows": 8, "acceptedRows": 7, "excludedRows": 1, "exclusionFraction": 1 / 8,
            "files": [{"role": role, **write(directory / (role + ".ndjson"), values, True)} for role, values in accepted.items()],
            "exclusions": write(directory / "excluded.ndjson", excluded, True)},
        "provenance": {"selectionManifestSha256": selection_identity["sha256"],
            "preregistrationSha256": configs["natural-pilot-v1.json"]["sha256"],
            "fitPreregistrationSha256": configs["natural-fit-v1.json"]["sha256"],
            "teacherManifestSha256": configs["natural-teacher-v1.json"]["sha256"],
            "sourceSha256": selection["source"]["sha256"], "sourceUncompressedSha256": selection["source"]["uncompressedSha256"],
            "implementation": implementation, "runtime": {"node": "v22.0.0", "platform": "linux", "arch": "x64"}}, "workers": workers}
    identity = write(directory / "summary.json", summary)
    args = SimpleNamespace(repo_root=repo, summary=directory / "summary.json", summary_sha256=identity["sha256"],
                           selection_manifest=selected_dir / "manifest.json", stockfish=engine, output=parent / "audit.json")
    return args, summary


def commit_summary(args, summary):
    args.summary_sha256 = write(args.summary, summary)["sha256"]


def mutate_rows(args, binding, change):
    path = args.summary.parent / binding["path"]
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    change(rows)
    binding.update(write(path, rows, True))


class LabelArtifactAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-natural-label-audit-")
        self.addCleanup(self.temp.cleanup)
        self.args, self.summary = make_bundle(Path(self.temp.name))

    def check_bundle(self):
        with patch.object(A, "EXPECTED_ROWS", 8):
            return A.audit(self.args)

    def test_complete_eight_worker_partition_and_raw_reconstruction(self):
        report = self.check_bundle()
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["counts"]["rawAdmissionReconstructions"], 8)
        self.assertEqual(report["counts"]["acceptedFullPvLegalityChecks"], 7)
        self.assertFalse(report["fitExclusionGateSatisfied"])
        text = json.dumps(report)
        for forbidden in ('"scoreCp":', '"targetWhite":', '"teacherCpMae":', '"crossEntropy":', '"wdl":', '"pv":', '"f1b5"'):
            self.assertNotIn(forbidden, text)

    def test_every_actual_file_hash_and_byte_count_checked(self):
        binding = self.summary["workers"][0]["transcript"]
        path = self.args.summary.parent / binding["path"]
        path.write_bytes(path.read_bytes().replace(b"100000", b"100001"))
        with self.assertRaisesRegex(A.AuditError, "hash mismatch"):
            self.check_bundle()

    def test_rehashed_wrong_prefix_and_budget_still_fail(self):
        for old, new in (("> go nodes 100000", "> go nodes 99999"),
                         ("> position startpos moves " + " ".join(PREFIX), "> position fen synthetic")):
            with self.subTest(old=old):
                binding = self.summary["workers"][0]["transcript"]
                original = (self.args.summary.parent / binding["path"]).read_bytes()
                mutate_rows(self.args, binding, lambda rows: [row.update(line=new) for row in rows if row["line"] == old])
                commit_summary(self.args, self.summary)
                with self.assertRaisesRegex(A.AuditError, "commands/prefix/budget"):
                    self.check_bundle()
                path = self.args.summary.parent / binding["path"]
                path.write_bytes(original)
                binding.update(sha256=sha(original), bytes=len(original), rows=len(original.splitlines()))
                commit_summary(self.args, self.summary)

    def test_accepted_row_cannot_mutate_immutable_source(self):
        binding = self.summary["output"]["files"][0]
        mutate_rows(self.args, binding, lambda rows: rows[0].update(sourceId="tampered"))
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "source row mutated"):
            self.check_bundle()

    def test_rehashed_output_and_ledger_cannot_disagree_with_raw_teacher(self):
        def alter(rows):
            rows[0]["teacher"]["scoreCp"] += 1
        mutate_rows(self.args, self.summary["output"]["files"][0], alter)
        mutate_rows(self.args, self.summary["workers"][0]["partition"], alter)
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "raw teacher admission/metadata"):
            self.check_bundle()

    def test_missing_or_duplicate_terminal_bestmove_rejected_after_rehash(self):
        binding = self.summary["workers"][0]["transcript"]
        mutate_rows(self.args, binding, lambda rows: rows.__setitem__(slice(None), [row for row in rows if not row["line"].startswith("< bestmove")]))
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "terminal bestmove"):
            self.check_bundle()

    def test_worker_row_assignment_is_not_trusted_from_rehashed_headers(self):
        binding = self.summary["workers"][0]["transcript"]
        mutate_rows(self.args, binding, lambda rows: [row.update(index=1) for row in rows if row["rowId"] is not None])
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "worker assignment"):
            self.check_bundle()

    def test_exclusion_reason_recomputed_from_raw(self):
        mutate_rows(self.args, self.summary["output"]["exclusions"], lambda rows: rows[0]["exclusion"].update(reason="missing-wdl"))
        mutate_rows(self.args, self.summary["workers"][7]["partition"], lambda rows: rows[0].update(reason="missing-wdl"))
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "raw teacher admission/metadata"):
            self.check_bundle()

    def test_accepted_excluded_intersection_rejected_after_rehash(self):
        accepted_path = self.args.summary.parent / self.summary["output"]["files"][0]["path"]
        row = json.loads(accepted_path.read_text().splitlines()[0])
        row.pop("teacher")
        row["exclusion"] = {"reason": "missing-wdl", "detail": None, "attempted": True}
        binding = self.summary["output"]["exclusions"]
        mutate_rows(self.args, binding, lambda rows: rows.__setitem__(0, row))
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "intersection"):
            self.check_bundle()

    def test_missing_worker_and_implementation_closure_rejected(self):
        self.summary["workers"].pop()
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "worker inventory"):
            self.check_bundle()
        self.summary["provenance"]["implementation"].pop("assets/engine.js")
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "implementation identity closure"):
            self.check_bundle()

    def test_rehashed_wrong_startup_hash_configuration_rejected(self):
        binding = self.summary["workers"][0]["transcript"]
        mutate_rows(self.args, binding, lambda rows: [row.update(line="> setoption name Hash value 16")
            for row in rows if row["line"] == "> setoption name Hash value 64"])
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "startup UCI configuration"):
            self.check_bundle()

    def test_ready_barrier_reordering_and_preparation_failure_marker_rejected(self):
        events = startup(TEACHER)
        events[0], events[3] = events[3], events[0]
        with self.assertRaises(A.AuditError):
            A.audit_startup(events, TEACHER)
        events = startup(TEACHER)
        events[-3], events[-1] = events[-1], events[-3]
        with self.assertRaises(A.AuditError):
            A.audit_startup(events, TEACHER)
        row = fixture_row()
        events = row_events(row)
        events.insert(5, "# worker-failure synthetic")
        with self.assertRaisesRegex(A.AuditError, "preparation"):
            A.audit_row_conversation(events, row, TEACHER, 2000)

    def test_truncated_jsonl_rejected_even_after_size_and_hash_update(self):
        binding = self.summary["workers"][0]["partition"]
        path = self.args.summary.parent / binding["path"]
        raw = path.read_bytes()[:-1]
        path.write_bytes(raw)
        binding.update(sha256=sha(raw), bytes=len(raw))
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "truncated"):
            self.check_bundle()

    def test_missing_completion_and_worker_failure_fail_closed(self):
        self.summary["status"] = "failed"
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "completion marker"):
            self.check_bundle()

    def test_boolean_numeric_substitution_rejected(self):
        self.summary["output"]["excludedRows"] = True
        commit_summary(self.args, self.summary)
        with self.assertRaisesRegex(A.AuditError, "noninteger"):
            self.check_bundle()
        self.assertFalse(A.equal(True, 1))
        self.assertTrue(A.equal(1, 1.0))
        self.assertFalse(A.integer(True))

    def test_json_duplicate_keys_fail_closed(self):
        with self.assertRaisesRegex(A.AuditError, "duplicate JSON"):
            A.strict_json('{"x":1,"x":2}')

    def test_mate_resets_old_exact_even_when_later_terminal_is_bound(self):
        row = fixture_row()
        events = row_events(row, extra_info=["< info depth 13 seldepth 15 score mate 2 nodes 95000 pv f1b5"])
        events[-1] = "# row-end missing-score"
        result = A.audit_row_conversation(events, row, TEACHER, 2000)
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "missing-score")

    def test_maximum_effort_mate_takes_precedence_over_new_exact(self):
        row = fixture_row()
        events = row_events(row, extra_info=[
            "< info depth 13 seldepth 15 score mate 2 nodes 110000 pv f1b5",
            "< info depth 14 seldepth 16 score cp 18 wdl 40 940 20 nodes 99000 pv f1b5"])
        events[-1] = "# row-end mate-score"
        self.assertEqual(A.audit_row_conversation(events, row, TEACHER, 2000)["reason"], "mate-score")

    def test_full_pv_legality_not_just_head(self):
        row = fixture_row()
        events = row_events(row)
        events[7] += " a8a4"
        events[-1] = "# row-end illegal-pv"
        self.assertEqual(A.audit_row_conversation(events, row, TEACHER, 2000)["reason"], "illegal-pv")

    def test_black_pov_and_saturated_target_are_exact(self):
        row = fixture_row(prefix=["e2e4"])
        board = A.replay_source(row)
        info = A.parse_info("info depth 12 seldepth 14 score cp 18 wdl 1000 0 0 nodes 100021 pv e7e5")
        result = A.assess(info, info, "e7e5", row, TEACHER, 2000, board)
        self.assertEqual(result["teacher"]["scoreCp"], -18)
        self.assertEqual(result["teacher"]["targetWhite"], 0)
        self.assertTrue(A.equal(result["teacher"]["targetWhite"], 0))

    def test_full_pv_can_continue_after_unclaimed_repetition(self):
        row = fixture_row(prefix=["e2e4"])
        info = A.parse_info("info depth 12 seldepth 14 score cp 18 wdl 40 940 20 nodes 100021 pv e7e5 g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8 b1c3")
        self.assertTrue(A.assess(info, info, "e7e5", row, TEACHER, 2000, A.replay_source(row))["accepted"])


if __name__ == "__main__":
    unittest.main()
