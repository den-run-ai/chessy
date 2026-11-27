#!/usr/bin/env python3
"""Small restoration boundary tests; no corpus, fitting, or native execution."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("eval_pipeline_restore_refit_test", ROOT / "tools/eval_pipeline/restore_refit_inputs.py")
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def identity(raw):
    return {"bytes": len(raw), "sha256": restore.digest(raw)}


class RestoreRefitContracts(unittest.TestCase):
    def test_recoverable_inventory_is_exactly_train_validation_and_16_arrays(self):
        self.assertEqual(len(restore.RECOVERABLE), 19)
        self.assertEqual(restore.ROLES, ("train", "validation"))
        self.assertEqual(sum(name.startswith("packed/") and name != "packed/PACKED.json" for name in restore.RECOVERABLE), 16)
        self.assertTrue(all("holdout" not in name and "ood" not in name for name in restore.RECOVERABLE))
        self.assertNotIn("extractor", restore.RECOVERABLE)
        self.assertNotIn("refit-no-pawn.i16le", restore.RECOVERABLE)
        self.assertNotIn("RESULTS.json", restore.RECOVERABLE)

    def test_path_traversal_and_symlink_ancestors_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("../data", "inputs/../data", "inputs//data", "./data", "/tmp/data", "", None):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    restore.target(root, name)
            (root / "real").mkdir()
            (root / "alias").symlink_to(root / "real", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                restore.target(root, "alias/new-file")
            (root / "dangling").symlink_to(root / "missing")
            with self.assertRaisesRegex(ValueError, "symlink"):
                restore.target(root, "dangling")

    def test_stream_copy_authenticates_exact_source_and_never_replaces(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); raw = b"retained source bytes\n"
            source, destination = root / "source", root / "destination"
            source.write_bytes(raw)
            self.assertEqual(restore.copy_verified(source, destination, identity(raw)), identity(raw))
            self.assertEqual(destination.read_bytes(), raw)
            with self.assertRaises(FileExistsError):
                restore.copy_verified(source, destination, identity(raw))
            self.assertEqual(destination.read_bytes(), raw)
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                restore.copy_verified(source, root / "bad-copy", identity(b"different"))
            self.assertEqual(source.read_bytes(), raw)

    def test_existing_mismatch_is_preserved_and_valid_existing_input_is_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); raw = b"verified input"
            source, destination = root / "source", root / "existing"
            source.write_bytes(raw); destination.write_bytes(b"preserve this mismatch")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                restore.publish_missing(source, destination, identity(raw))
            self.assertEqual(destination.read_bytes(), b"preserve this mismatch")
            source.write_bytes(b"preserve this mismatch")
            self.assertFalse(restore.publish_missing(source, destination, identity(source.read_bytes())))

    def test_atomic_publish_and_losing_writer_preserve_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); raw = b"newly restored input"
            source, destination = root / "source", root / "new" / "file"
            source.write_bytes(raw)
            self.assertTrue(restore.publish_missing(source, destination, identity(raw)))
            self.assertEqual(destination.read_bytes(), raw)
            other = root / "failed" / "file"
            with patch.object(restore.os, "link", side_effect=OSError("publication failure")):
                with self.assertRaisesRegex(OSError, "publication failure"):
                    restore.publish_missing(source, other, identity(raw))
            self.assertFalse(other.exists())
            self.assertEqual(source.read_bytes(), raw)
            self.assertEqual(destination.read_bytes(), raw)

    def test_preflight_requires_preserved_evidence_but_allows_missing_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = {"inputs/train.jsonl": identity(b"raw"), "extractor": identity(b"native")}
            with self.assertRaisesRegex(ValueError, "preserved evidence"):
                restore.preflight(root, inventory)
            (root / "extractor").write_bytes(b"native")
            self.assertEqual(restore.preflight(root, inventory), ["inputs/train.jsonl"])
            (root / "inputs").mkdir(); (root / "inputs/train.jsonl").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                restore.preflight(root, inventory)

    def test_wrong_completed_manifest_fails_before_work_or_data_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); study = root / "study"; study.mkdir()
            (study / "RESULTS.json").write_bytes(b"{}")
            with patch.object(restore.subprocess, "run", side_effect=AssertionError("no packing may start")):
                with self.assertRaisesRegex(ValueError, "frozen manifest"):
                    restore.restore(study, root / "unavailable-data", root / "work")
            self.assertFalse((root / "work").exists())
            self.assertFalse((study / "RESTORED-INPUTS.json").exists())
            self.assertEqual((study / "RESULTS.json").read_bytes(), b"{}")

    def test_pack_plan_cannot_request_fitting_or_holdout(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for changed in ({"fitAllowed": True}, {"holdoutAllowed": True}, {"roles": ["train", "validation", "holdout"]}):
                plan = {"schema": "chessy.eval-pipeline-refit-restore-plan.v1", "resultsSha256": restore.RESULTS_SHA,
                        "roles": ["train", "validation"], "fitAllowed": False, "holdoutAllowed": False, "files": {}}
                plan.update(changed)
                (work / "PACK-PLAN.json").write_text(json.dumps(plan))
                with self.assertRaisesRegex(ValueError, "pack-only"):
                    restore.pack(work)

    def test_changed_packing_source_is_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory); driver = work / "source/tools/eval_pipeline/refit.py"
            driver.parent.mkdir(parents=True)
            raw = b"raise AssertionError('untrusted driver must never execute')\n"
            driver.write_bytes(raw)
            plan = {"schema": "chessy.eval-pipeline-refit-restore-plan.v1", "resultsSha256": restore.RESULTS_SHA,
                    "roles": ["train", "validation"], "fitAllowed": False, "holdoutAllowed": False,
                    "files": {"source/tools/eval_pipeline/refit.py": identity(raw)}}
            (work / "PACK-PLAN.json").write_text(json.dumps(plan))
            with self.assertRaisesRegex(ValueError, "frozen manifest/source"):
                restore.pack(work)


if __name__ == "__main__":
    unittest.main()
