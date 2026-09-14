#!/usr/bin/env python3
"""Regression tests for natural HCE fit gates and split exposure controls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("natural_fit", ROOT / "tools/training/natural-pilot-fit.py")
fit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fit
spec.loader.exec_module(fit)
np, sparse = fit.np, fit.sparse


class NaturalFitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = fit.contract()
        cls.center, cls.scales = fit.metadata()

    def data(self, serial=0, rows=90, signal=0):
        values = np.arange(rows) % 41 - 20
        matrix = sparse.csr_matrix((values.astype(float), (np.arange(rows), np.full(rows, 17))), shape=(rows, 965))
        matrix.eliminate_zeros()
        baseline = matrix @ self.center
        teacher = matrix @ (self.center + np.eye(1, 965, 17).ravel() * signal)
        return fit.Data(matrix, np.zeros(rows), fit.arith.sigmoid(teacher / 400), teacher,
            np.asarray([fit.PHASES[i % 3] for i in range(rows)]),
            np.asarray([f"family-{serial}-{i // 3}" for i in range(rows)]),
            np.asarray([f"source-{serial}-{i}" for i in range(rows)]),
            np.asarray([f"row-{serial}-{i}" for i in range(rows)]),
            np.asarray([f"cluster-{serial}-{i}" for i in range(rows)]),
            baseline, ["unused"] * rows, fit.ROLES[min(serial, 2)])

    def test_integer_bounds_preserve_mobility_and_unsupported_weights(self):
        data = self.data(signal=8)
        low, high = fit.bounds(self.center, data)
        self.assertTrue(np.all(low[:4] > 0))
        self.assertTrue(np.array_equal(low[:4], self.center[:4]))
        self.assertTrue(np.array_equal(high[:4], self.center[:4]))
        self.assertEqual(low[17], self.center[17] - 10)
        self.assertEqual(high[17], self.center[17] + 10)
        self.assertTrue(np.array_equal(low[18:], self.center[18:]))
        fitted, info = fit.fit(data, self.center, self.scales, 1, 759, .02, (low, high), self.rules)
        self.assertTrue(info["success"])
        self.assertTrue(np.all(fitted[759:] == 0))
        self.assertTrue(np.array_equal(fitted[:17], self.center[:17]))
        self.assertTrue(np.array_equal(fitted[18:], self.center[18:]))
        self.assertGreater(fitted[17], self.center[17])
        self.assertTrue(np.all(fitted == np.rint(fitted)))

    def test_half_tie_rounding_reproduces_rust_sign_behavior(self):
        data = self.data(rows=2)
        data.matrix = sparse.csr_matrix((2, 965))
        data.fixed_cp = np.asarray([-1138.5000000000002, 1138.4999999999998])
        self.assertEqual(fit.arith.runtime_predictions(data, self.center).tolist(), [-1138, 1139])
        with self.assertRaisesRegex(ValueError, "integer weights"):
            fit.arith.runtime_predictions(data, self.center + .5)

    def test_real_node_feature_stream_matches_wasm_and_integer_affine(self):
        rows = [{"id": "opening", "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
                {"id": "endgame", "fen": "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1"}]
        changed = self.center.copy()
        changed[17] += 2
        features = [json.loads(line) for line in fit.node_features({"rows": rows, "weights": changed.astype(int).tolist()}).splitlines()]
        for feature in features:
            data = self.data(rows=1)
            data.matrix = sparse.csr_matrix((feature["data"], feature["indices"], [0, len(feature["data"])]), shape=(1, 965))
            data.fixed_cp = np.asarray([feature["fixedCp"]])
            self.assertEqual(fit.arith.runtime_predictions(data, self.center)[0], feature["baselineCp"])
            self.assertEqual(fit.arith.runtime_predictions(data, changed)[0], feature["candidateCp"])

    def test_teacher_fails_frozen_cp_wdl_and_budget_admission(self):
        valid = {"scoreCp": 50, "wdl": [300, 400, 300], "targetWhite": .5,
                 "depth": 16, "seldepth": 22, "nodes": 100000, "scoreNodes": 99900,
                 "bestmove": "e2e4", "pv": ["e2e4", "e7e5"]}
        fit.check_teacher(valid, self.rules["teacherAdmission"])
        for mutation in ({"scoreCp": 2001}, {"nodes": 99999}, {"wdl": [300, 400, 301]},
                         {"targetWhite": .6}, {"scoreNodes": 100001}, {"pv": ["d2d4"]}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                fit.check_teacher(valid | mutation, self.rules["teacherAdmission"])

    def test_all_leakage_keys_checked(self):
        left = fit.identities(self.data(0))
        right = fit.identities(self.data(1))
        fit.assert_disjoint(left, right)
        for key in left:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                fit.assert_disjoint(left, right | {key: left[key]})

    def test_cp_and_phase_guards_prevent_ce_only_candidate(self):
        baseline = {"crossEntropy": .5, "teacherCpMae": 100, "teacherCpRmse": 200,
                    "byPhase": {p: {"rows": 101, "crossEntropy": .5} for p in fit.PHASES}}
        candidate = baseline | {"crossEntropy": .49, "teacherCpMae": 103}
        self.assertIn("teacherCpMae-deterioration-over-2-percent", fit.guard(baseline, candidate, self.rules))
        candidate = baseline | {"crossEntropy": .49, "byPhase": baseline["byPhase"] | {"endgame": {"rows": 101, "crossEntropy": .51}}}
        self.assertIn("endgame-cross-entropy-deterioration-over-1-percent", fit.guard(baseline, candidate, self.rules))
        self.assertTrue(fit.guard(baseline, baseline, self.rules))

    def test_family_bootstrap_preserves_row_estimand(self):
        data = self.data(rows=5)
        data.family = np.asarray(["a", "b", "b", "b", "b"])
        base = np.asarray([0, 0, 0, 0, 0])
        candidate = np.asarray([100, 1, 1, 1, 1])
        result = fit.bootstrap_families(data, base, candidate, 1, self.rules)
        delta = fit.arith.row_losses(candidate, data.target, 1) - fit.arith.row_losses(base, data.target, 1)
        self.assertAlmostEqual(result["candidateMinusBaselineMean"], float(np.mean(delta)))
        self.assertEqual(result["families"], 2)
        self.assertEqual(result["maxRowsPerFamily"], 4)

    def test_baseline_selection_never_loads_test(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            summary_path, manifest_path = root / "labels.json", root / "manifest.json"
            summary_path.write_text("{}")
            manifest_path.write_text("{}")
            calls = []
            def load(summary, directory, role, *args):
                calls.append(role)
                self.assertNotEqual(role, "hce-test")
                return self.data(0 if role == "shared-train" else 1)
            with patch.object(fit, "load_summary", return_value=({}, {})), \
                    patch.object(fit, "load_role", side_effect=load), \
                    patch.object(fit, "candidate_parity"):
                with patch.object(fit, "authenticate_audits", return_value=({}, {})):
                    result = fit.select(summary_path, manifest_path, root / "selection.json",
                        selection_audit_path=root/"source-audit", selection_audit_sha="a"*64,
                        label_audit_path=root/"label-audit", label_audit_sha="b"*64)
            self.assertEqual(calls, ["shared-train", "hce-validation"])
            self.assertEqual(result["selected"]["surface"], "baseline")
            self.assertFalse(result["testEligible"])
            with patch.object(fit, "load_role") as loader:
                with self.assertRaisesRegex(ValueError, "cannot open test"):
                    fit.evaluate_test(root / "selection.json", root / "report.json")
                loader.assert_not_called()
            self.assertFalse((root / "selection.json.test-opened").exists())

    def test_failed_test_consumes_exposure_and_refuses_copied_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            labels = root / "labels"
            labels.mkdir()
            summary_path = labels / "summary.json"
            summary_path.write_text(json.dumps({"provenance": {"teacherManifestSha256": "c"*64}}))
            selection = root / "selection.json"
            audit = {"selectionAuditPath": str(root / "source-audit"), "selectionAuditSha256": "a"*64,
                     "labelAuditPath": str(root / "label-audit"), "labelAuditSha256": "b"*64,
                     "auditedClosureSha256": "d"*64}
            frozen = {"schema": "chessy.natural-pilot-frozen-selection.v1", "inputSha256": {},
                "researchWeights": self.center.astype(int).tolist(), "labelSummaryPath": str(summary_path),
                "selectionManifestPath": str(root / "manifest.json"),
                "report": {"testEligible": True, "auditEvidence": audit, "selectionManifestSha256": "e"*64,
                    "selected": {"surface": "constrained753", "weightsSha256": fit.arith.sha256_json_ints(self.center)}}}
            selection.write_text(json.dumps(frozen))
            with patch.object(fit, "load_summary", return_value=({}, {})), \
                    patch.object(fit, "authenticate_audits", return_value=({}, audit)), \
                    patch.object(fit, "load_role", side_effect=ValueError("bad test hash")):
                with self.assertRaisesRegex(ValueError, "bad test hash"):
                    fit.evaluate_test(selection, root / "report.json")
            marker = fit.exposure_marker(summary_path, "e"*64, "c"*64)
            self.assertTrue(marker.exists())
            self.assertNotIn(labels, marker.parents)
            copied_selection = root / "copied-selection.json"
            copied_selection.write_bytes(selection.read_bytes())
            with patch.object(fit, "authenticate_audits", return_value=({}, audit)), patch.object(fit, "load_role") as loader:
                with self.assertRaises(FileExistsError):
                    fit.evaluate_test(copied_selection, root / "different-report.json")
                loader.assert_not_called()
            self.assertFalse((root / "report.json").exists())
            self.assertFalse((root / "different-report.json").exists())

    def test_summary_identity_coverage_and_exclusion_checks_precede_fit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rules_path = ROOT / "eval/training/natural-pilot-v1.json"
            teacher_path = ROOT / "eval/training/natural-teacher-v1.json"
            rules = fit.read_json(rules_path)
            manifest = {"schema": "chessy.natural-pilot-selection.v1", "status": "complete-research-only-selection",
                "productionFitAllowed": False, "coverage": {"fullPilotReady": True, "failedGates": []},
                "preregistration": {"sha256": fit.sha(rules_path)}, "fitPreregistration": {"sha256": fit.CONTRACT_SHA},
                "teacherContract": {"sha256": fit.sha(teacher_path)},
                "source": {"sha256": rules["source"]["sha256"], "uncompressedSha256": "a" * 64,
                           "games": rules["source"]["games"], "license": "CC0-1.0"},
                "selection": {"rows": 50000, "uniqueSourceGames": 50000, "uniqueClusters": 50000,
                              "sourceDispositions": {"admitted": 50000, "excluded": rules["source"]["games"] - 50000}}}
            manifest_path, summary_path = root / "manifest.json", root / "summary.json"
            manifest_path.write_text(json.dumps(manifest))
            summary = {"schema": "chessy.natural-pilot-label-summary.v1", "status": "completed",
                "teacher": fit.read_json(teacher_path), "failures": [],
                "provenance": {"selectionManifestSha256": fit.sha(manifest_path),
                    "preregistrationSha256": fit.sha(rules_path), "fitPreregistrationSha256": fit.CONTRACT_SHA,
                    "teacherManifestSha256": fit.sha(teacher_path), "sourceSha256": rules["source"]["sha256"],
                    "sourceUncompressedSha256": "a" * 64},
                "output": {"selectedRows": 50000, "acceptedRows": 49000, "excludedRows": 1000,
                    "exclusionFraction": .02, "files": [{"role": r, "rows": n} for r, n in
                    zip(("shared-train", "hce-validation", "hce-test", "nnue-validation", "nnue-test"), (35000, 4500, 4500, 2500, 2500))]}}
            summary_path.write_text(json.dumps(summary))
            fit.load_summary(summary_path, manifest_path)
            bad = json.loads(json.dumps(summary))
            bad["provenance"]["sourceSha256"] = "b" * 64
            summary_path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "source identity"):
                fit.load_summary(summary_path, manifest_path)
            bad = json.loads(json.dumps(summary))
            bad["output"].update(acceptedRows=44000, excludedRows=6000, exclusionFraction=.12)
            bad["output"]["files"][0]["rows"] -= 5000
            summary_path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "exclusion fraction"):
                fit.load_summary(summary_path, manifest_path)
            manifest["coverage"] = {"fullPilotReady": False, "failedGates": ["fewer-than-40000-selected"]}
            manifest_path.write_text(json.dumps(manifest))
            summary["provenance"]["selectionManifestSha256"] = fit.sha(manifest_path)
            summary_path.write_text(json.dumps(summary))
            with self.assertRaisesRegex(ValueError, "failed preregistered coverage"):
                fit.load_summary(summary_path, manifest_path)

    def test_complete_synthetic_label_interface_and_real_optimizer(self):
        # Tiny synthetic contract fixture: only the in-memory minimum row
        # counts are reduced. Source identity and source census are fixtures,
        # never a real dataset. Loader, feature extraction, parity, optimizer,
        # selection, hashes, and publication execute without mocks. Test-role
        # filenames deliberately do not exist, so an accidental read fails.
        examples = [
            ("shared-train", "rnbqkbnr/pp1ppppp/2p5/8/5P2/2P5/PP1PP1PP/RNBQKBNR b KQkq - 0 2"),
            ("shared-train", "rnbqkbnr/pp1ppp1p/2p5/6p1/5P2/1PP5/P2PP1PP/RNBQKBNR b KQkq - 0 3"),
            ("shared-train", "rnbqkbnr/pp2pp1p/2pp4/6p1/5P2/1PP5/P2PP1PP/RNBQKBNR w KQkq - 0 4"),
            ("shared-train", "rnbqkbnr/pp2pp1p/2pp4/6p1/1P3P2/2P5/P2PP1PP/RNBQKBNR b KQkq - 0 4"),
            ("hce-validation", "rnbqkbnr/pp1ppppp/2p5/8/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2"),
            ("hce-validation", "r1b1kbnr/1p1n3p/1qp1p3/p2p1pp1/1P3P1N/2P1P3/P1QPK1PP/RNB2B1R w kq - 0 10"),
            ("hce-validation", "rnbkn2r/1p4b1/4p3/PBppq1pp/5P1N/2P1P2P/P1QP1KP1/RNBR4 b - - 0 19"),
            ("hce-validation", "1nbkn2r/1p4b1/4p3/rB1pq1pp/2p2P1N/2P1P2P/PQ1P1KP1/RNBR4 w - - 0 21")]
        rows = [{"id": fit.hashlib.sha256(f"synthetic-{i}".encode()).hexdigest(), "fen": fen}
                for i, (_, fen) in enumerate(examples)]
        features = [json.loads(line) for line in fit.node_features({"rows": rows}).splitlines()]
        selected, accepted = {}, {}
        for i, ((role, fen), row, feature) in enumerate(zip(examples, rows, features)):
            source_id = f"TEST{i:04d}"
            row.update(schema="chessy.natural-pilot-row.v1", role=role, fen4=" ".join(fen.split()[:4]),
                       sourceId=source_id, sourceGame={"id": source_id, "rawSha256": "a" * 64},
                       cluster=feature["cluster"], positionFamily=feature["family"], phaseBucket=feature["phase"])
            wins = round(float(fit.arith.sigmoid(np.asarray([feature["baselineCp"] / 400]))[0]) * 1000)
            teacher = {"scoreCp": feature["baselineCp"], "wdl": [wins, 0, 1000-wins],
                       "targetWhite": wins / 1000, "depth": 18, "seldepth": 22,
                       "nodes": 100100, "scoreNodes": 95000, "bestmove": "e2e4", "pv": ["e2e4"]}
            selected.setdefault(role, []).append(row)
            accepted.setdefault(role, []).append(row | {"teacher": teacher})
        with tempfile.TemporaryDirectory(prefix="natural-fit-synthetic-") as temporary:
            root = Path(temporary)
            source_root, label_root = root / "selected", root / "labelled"
            source_root.mkdir()
            label_root.mkdir()
            def write_stream(directory, role, values):
                path = directory / (role + ".ndjson")
                path.write_text("".join(json.dumps(row) + "\n" for row in values))
                return {"role": role, "path": path.name, "rows": len(values), "bytes": path.stat().st_size, "sha256": fit.sha(path)}
            source_files = [write_stream(source_root, r, values) for r, values in selected.items()]
            label_files = [write_stream(label_root, r, values) for r, values in accepted.items()]
            for role in ("hce-test", "nnue-validation", "nnue-test"):
                placeholder = {"role": role, "path": role + ".ndjson", "rows": 1, "bytes": 1, "sha256": "b" * 64}
                source_files.append(placeholder)
                label_files.append(placeholder)
            rules_path = ROOT / "eval/training/natural-pilot-v1.json"
            teacher_path = ROOT / "eval/training/natural-teacher-v1.json"
            rules = fit.read_json(rules_path)
            manifest = {"schema": "chessy.natural-pilot-selection.v1", "status": "complete-research-only-selection",
                "productionFitAllowed": False, "coverage": {"fullPilotReady": True, "failedGates": []},
                "preregistration": {"sha256": fit.sha(rules_path)}, "fitPreregistration": {"sha256": fit.CONTRACT_SHA},
                "teacherContract": {"sha256": fit.sha(teacher_path)},
                "source": {"sha256": rules["source"]["sha256"], "uncompressedSha256": "a" * 64,
                           "games": rules["source"]["games"], "license": "CC0-1.0"},
                "selection": {"rows": 11, "files": source_files, "uniqueSourceGames": 11, "uniqueClusters": 11,
                              "sourceDispositions": {"selected": 11, "excluded": rules["source"]["games"]-11}}}
            manifest_path, summary_path = source_root / "manifest.json", label_root / "summary.json"
            manifest_path.write_text(json.dumps(manifest))
            summary = {"schema": "chessy.natural-pilot-label-summary.v1", "status": "completed",
                "teacher": fit.read_json(teacher_path), "failures": [],
                "provenance": {"selectionManifestSha256": fit.sha(manifest_path),
                    "preregistrationSha256": fit.sha(rules_path), "fitPreregistrationSha256": fit.CONTRACT_SHA,
                    "teacherManifestSha256": fit.sha(teacher_path), "sourceSha256": rules["source"]["sha256"],
                    "sourceUncompressedSha256": "a" * 64},
                "output": {"selectedRows": 11, "acceptedRows": 11, "excludedRows": 0,
                           "exclusionFraction": 0, "files": label_files}}
            summary_path.write_text(json.dumps(summary))
            tiny = json.loads(json.dumps(self.rules))
            tiny["minimumRows"] = {role: 1 for role in fit.ROLES}
            output, report_path = root / "private-selection.json", root / "report.json"
            with patch.object(fit, "contract", return_value=tiny), patch.object(fit, "authenticate_audits", return_value=({}, {})):
                report = fit.select(summary_path, manifest_path, output, report_path,
                    selection_audit_path=root/"source-audit", selection_audit_sha="a"*64,
                    label_audit_path=root/"label-audit", label_audit_sha="b"*64)
            self.assertEqual(report["selected"]["surface"], "baseline")
            self.assertFalse(report["testOpened"])
            self.assertEqual(report["coverage"]["train"]["baselineWasmParityRows"], 4)
            self.assertEqual(report["coverage"]["validation"]["baselineWasmParityMismatches"], 0)
            self.assertEqual(len(report["candidates"]), 12)
            self.assertNotIn("researchWeights", fit.read_json(report_path))
            self.assertTrue(all("hce-test.ndjson" not in path for path in fit.read_json(output)["inputSha256"]))

    def audit_fixture(self, root):
        """Synthetic hash-only attestations, separate from model/label tests."""
        selected_root, label_root = root / "selected", root / "labels"
        selected_root.mkdir()
        label_root.mkdir()
        def identity(path):
            return {"sha256": fit.sha(path), "bytes": path.stat().st_size}
        def artifact(path, data=b'{"synthetic":true}\n'):
            path.write_bytes(data)
            return {"path": path.name, **identity(path), "rows": 1}
        def bind(paths):
            return {str(path.resolve()): identity(path) for path in paths}
        roles = ("shared-train", "hce-validation", "hce-test", "nnue-validation", "nnue-test")
        selected_files = [{"role": role, **artifact(selected_root / (role + ".ndjson"))} for role in roles]
        labelled_files = [{"role": role, **artifact(label_root / (role + ".ndjson"))} for role in roles]
        exclusions = artifact(label_root / "excluded.ndjson", b"")
        exclusions["rows"] = 0
        workers = [{"slot": i, "transcript": artifact(label_root / f"worker-{i}.uci.jsonl"),
                    "partition": artifact(label_root / f"worker-{i}.partition.jsonl")} for i in range(8)]
        archive, executable = root / "archive", root / "stockfish"
        artifact(archive, b"synthetic compressed archive")
        artifact(executable, b"synthetic executable")
        configs = {}
        for key, name in (("preregistration", "natural-pilot-v1.json"), ("fitPreregistration", "natural-fit-v1.json"),
                          ("teacherContract", "natural-teacher-v1.json")):
            path = ROOT / "eval/training" / name
            configs[key] = {"path": str(path.relative_to(ROOT)), **identity(path)}
        inventory = artifact(selected_root / "source-inventory.ndjson")
        quarantine = root / "quarantine-fixture.json"
        artifact(quarantine, b"synthetic quarantine")
        implementation = ROOT / "test/training/corpus.js"
        manifest = {**configs, "source": {**identity(archive), "games": 5},
                    "implementation": [{"path": str(implementation.relative_to(ROOT)), **identity(implementation)}],
                    "quarantine": {"sourceFiles": [{"path": "fixture.json", **identity(quarantine)}]},
                    "coverage": {"fullPilotReady": True, "failedGates": []},
                    "selection": {"rows": 5, "files": selected_files, "sourceInventory": inventory}}
        manifest_path = selected_root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        summary = {"teacher": {"engine": {"executable": {"sha256": fit.sha(executable)}}},
                   "provenance": {"implementation": {"assets/engine.js": fit.sha(ROOT / "assets/engine.js")}},
                   "workers": workers, "output": {"acceptedRows": 5, "excludedRows": 0,
                   "files": labelled_files, "exclusions": exclusions}}
        summary_path = label_root / "summary.json"
        summary_path.write_text(json.dumps(summary))
        shared = [manifest_path, *(ROOT / binding["path"] for binding in configs.values()),
                  *(selected_root / entry["path"] for entry in selected_files)]
        source_audit = {"schema": "chessy.natural-selection-independent-audit.v1", "status": "PASS",
            "researchOnly": True, "productionFitAllowed": False, "teacherLabelsRead": 0,
            "counts": {**{key: 5 for key in ("selectedRows", "sourceGames", "clusters", "fullLegalPrefixReplays",
                "javascriptCorpusKeyComparisons", "sourceInventoryRowsAuthenticated")},
                "mismatches": 0, "quarantineIntersections": 0, "crossRoleSourceOrFamilyOverlap": 0},
            "coverage": manifest["coverage"], "inputs": bind([*shared, archive, quarantine, implementation, selected_root / inventory["path"],
                ROOT / "tools/training/audit-natural-selection.py"])}
        label_audit = {"schema": "chessy.natural-label-artifact-independent-audit.v1", "status": "PASS",
            "researchOnly": True, "productionFitAllowed": False, "modelEvaluationPerformed": False,
            "fitExclusionGateSatisfied": True,
            "counts": {**{key: 5 for key in ("selectedRows", "fullSourceHistoryReplays", "rawAdmissionReconstructions",
                "terminalBestmovesChecked", "acceptedRows", "acceptedFullPvLegalityChecks")},
                "excludedRows": 0, "workersCompleted": 8, "mismatches": 0},
            "files": bind([*shared, summary_path, executable, ROOT / "assets/engine.js",
                ROOT / "tools/training/audit-natural-labels.py", *label_root.iterdir()])}
        source_path, label_path = root / "source-audit.json", root / "label-audit.json"
        source_path.write_text(json.dumps(source_audit))
        label_path.write_text(json.dumps(label_audit))
        kwargs = {"selection_audit_path": source_path, "selection_audit_sha": fit.sha(source_path),
                  "label_audit_path": label_path, "label_audit_sha": fit.sha(label_path)}
        return summary_path, manifest_path, kwargs

    def test_independent_audits_require_exact_raw_closure_and_rehash_publication(self):
        with tempfile.TemporaryDirectory(prefix="natural-fit-audit-fixture-") as temporary:
            root = Path(temporary)
            summary, manifest, kwargs = self.audit_fixture(root)
            expected, evidence = fit.authenticate_audits(summary, manifest, **kwargs)
            raw = summary.parent / "worker-0.uci.jsonl"
            self.assertIn(raw, expected)
            self.assertGreater(evidence["auditedFiles"], 23)
            # Consumer cannot accept a PASS report that omits a required file,
            # even when the caller supplies the new report's correct hash.
            report_path = kwargs["label_audit_path"]
            original = report_path.read_bytes()
            report = fit.read_json(report_path)
            del report["files"][str(raw)]
            report_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "omitted mandatory"):
                fit.authenticate_audits(summary, manifest, **(kwargs | {"label_audit_sha": fit.sha(report_path)}))
            report_path.write_bytes(original)
            source_audit_path = kwargs["selection_audit_path"]
            source_original = source_audit_path.read_bytes()
            for missing in (root / "quarantine-fixture.json", ROOT / "test/training/corpus.js"):
                source_report = json.loads(source_original)
                del source_report["inputs"][str(missing)]
                source_audit_path.write_text(json.dumps(source_report))
                with self.subTest(missing=missing.name), self.assertRaisesRegex(ValueError, "omitted mandatory"):
                    fit.authenticate_audits(summary, manifest, **(kwargs | {"selection_audit_sha": fit.sha(source_audit_path)}))
            source_audit_path.write_bytes(source_original)
            # A previously authenticated transcript changing after audit must
            # block both a fresh fitting admission and final publication.
            raw.write_text("changed after independent audit\n")
            with self.assertRaisesRegex(ValueError, "audited evidence changed"):
                fit.authenticate_audits(summary, manifest, **kwargs)
            with self.assertRaisesRegex(ValueError, "authenticated input changed"):
                fit.publish(root / "candidate.json", {"researchOnly": True}, expected)
            self.assertFalse((root / "candidate.json").exists())
            raw.unlink()
            with self.assertRaisesRegex(ValueError, "missing or unaccounted raw artifacts"):
                fit.authenticate_audits(summary, manifest, **kwargs)

    def test_audit_external_hash_and_pass_status_are_mandatory(self):
        with tempfile.TemporaryDirectory(prefix="natural-fit-audit-fixture-") as temporary:
            summary, manifest, kwargs = self.audit_fixture(Path(temporary))
            with self.assertRaisesRegex(ValueError, "external identity differs"):
                fit.authenticate_audits(summary, manifest, **(kwargs | {"label_audit_sha": "0"*64}))
            path = kwargs["selection_audit_path"]
            report = fit.read_json(path)
            report["status"] = "FAIL"
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "must PASS"):
                fit.authenticate_audits(summary, manifest, **(kwargs | {"selection_audit_sha": fit.sha(path)}))

    def test_wrong_dependencies_fail_before_any_input_access(self):
        with patch.object(fit.np, "__version__", "0.0"), patch.object(fit, "read_json") as reader:
            with self.assertRaisesRegex(ValueError, "NumPy 2.3.5"):
                fit.evaluate_test(Path("never-open.json"), Path("never-write.json"))
            reader.assert_not_called()
        with patch.object(fit.scipy, "__version__", "0.0"), patch.object(fit, "load_summary") as loader:
            with self.assertRaisesRegex(ValueError, "SciPy 1.17.0"):
                fit.select(Path("never-summary"), Path("never-manifest"), Path("never-output"),
                    selection_audit_path=Path("never-source-audit"), selection_audit_sha="a"*64,
                    label_audit_path=Path("never-label-audit"), label_audit_sha="b"*64)
            loader.assert_not_called()

    def test_publication_input_change_never_creates_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input"
            source.write_text("before")
            expected = {source: fit.sha(source)}
            source.write_text("changed")
            with self.assertRaisesRegex(ValueError, "input changed"):
                fit.publish(root / "output", {"ok": True}, expected)
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
