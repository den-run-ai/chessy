#!/usr/bin/env python3
"""Synthetic trust-boundary tests; these fixtures do not admit pilot data."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("h4_data_tested", ROOT / "tools/training/h4_data.py")
data = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = data
spec.loader.exec_module(data)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class H4DataTests(unittest.TestCase):
    def test_exact_identity_relocation_and_missing_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = b"original transcript bytes\n"
            (root / "relocated-name").write_bytes(raw)
            inventory = data.Inventory([root])
            artifact = inventory.locate(hashlib.sha256(raw).hexdigest(), len(raw))
            self.assertEqual(artifact.read(), raw)
            with self.assertRaisesRegex(ValueError, "missing exact"):
                inventory.locate("0" * 64)
            with self.assertRaisesRegex(ValueError, "missing exact"):
                inventory.locate(artifact.sha256, artifact.size + 1)

    def test_modified_artifact_cannot_reuse_discovery_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence"
            path.write_bytes(b"original")
            inventory = data.Inventory([path.parent])
            artifact = inventory.locate(hashlib.sha256(b"original").hexdigest())
            path.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "changed"):
                artifact.read()
            with self.assertRaisesRegex(ValueError, "changed"):
                inventory.locate(artifact.sha256)

    def test_symlinks_are_not_recovered_as_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target-file"
            target.write_bytes(b"expected")
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "nonsymlink"):
                data.snapshot(link)
            inventory = data.Inventory([root])
            self.assertEqual([a.path for a in inventory.by_sha[hashlib.sha256(b"expected").hexdigest()]], [target])

    def test_replacement_during_same_descriptor_read_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, replacement = root / "evidence", root / "replacement"
            path.write_bytes(b"original\n")
            replacement.write_bytes(b"original\n")
            real_sha = hashlib.sha256
            class ReplaceOnHash:
                def __init__(self):
                    self.digest = real_sha()
                    self.done = False
                def update(self, raw):
                    self.digest.update(raw)
                    if not self.done:
                        replacement.replace(path)
                        self.done = True
                def hexdigest(self):
                    return self.digest.hexdigest()
            with patch.object(data.hashlib, "sha256", ReplaceOnHash):
                with self.assertRaisesRegex(ValueError, "changed|replaced"):
                    data.snapshot(path)

    def test_json_parses_the_hashed_bytes_not_a_second_path_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence"
            original = b'{"retained":true}\n'
            path.write_bytes(original)
            artifact = data.Artifact(path, hashlib.sha256(original).hexdigest(), len(original))
            real_read = artifact.read
            def checked_then_replace():
                raw = real_read()
                path.write_bytes(b'{"retained":false}\n')
                return raw
            with patch.object(data.Artifact, "read", lambda self: checked_then_replace()):
                self.assertEqual(data._json(artifact), {"retained": True})

    def test_original_closure_digest_survives_relocation_but_not_path_rewrite(self):
        value = {"sha256": "a" * 64, "bytes": 12}
        left = {"/old/code.py": value}
        right = {"/old/code.py": value, "/old/data.jsonl": {"sha256": "b" * 64, "bytes": 19}}
        pins = {"auditedFiles": 2, "auditedClosureSha256": hashlib.sha256(encoded(right)).hexdigest()}
        self.assertEqual(data._merge_closure({"inputs": left}, {"files": right}, pins)[2], right)
        rewritten = {"/new/code.py": value, "/old/data.jsonl": right["/old/data.jsonl"]}
        with self.assertRaisesRegex(ValueError, "closure identity"):
            data._merge_closure({"inputs": {"/new/code.py": value}}, {"files": rewritten}, pins)
        changed = copy.deepcopy(right)
        changed["/old/code.py"]["bytes"] += 1
        with self.assertRaisesRegex(ValueError, "disagree"):
            data._merge_closure({"inputs": left}, {"files": changed}, pins)

    def test_hce_roles_rejected_before_any_file_read(self):
        for role in ("hce-validation", "hce-test", "any-other-role"):
            with self.subTest(role=role), patch.object(data.Artifact, "read") as reader:
                with self.assertRaisesRegex(ValueError, "reserved NNUE"):
                    data.load_role(SimpleNamespace(), role)
                reader.assert_not_called()

    def fixture(self, root, count=2):
        # Authored synthetic rows exercise parsing only, not real admission.
        role = "shared-train"
        rows = []
        for i in range(count):
            rows.append({"schema": "chessy.natural-pilot-row.v1", "id": f"{i + 1:064x}",
                         "cluster": f"{i + 101:064x}", "positionFamily": f"{i + 201:064x}",
                         "sourceId": f"game-{i}", "sourceGame": {"id": f"game-{i}", "rawSha256": "f" * 64},
                         "role": role, "fen": "unused", "phaseBucket": "opening"})
        teacher = {"scoreCp": 0, "wdl": [250, 500, 250], "targetWhite": .5,
                   "depth": 16, "seldepth": 20, "nodes": 100000, "scoreNodes": 100000,
                   "bestmove": "e2e4", "pv": ["e2e4", "e7e5"]}
        labels = [row | {"teacher": copy.deepcopy(teacher)} for row in rows]
        auth = SimpleNamespace(summary_original="/old/labels/summary.json", selection_original="/old/selected/manifest.json",
                               artifacts={}, summary={"output": {"files": []}}, selection={"selection": {"files": []}},
                               contract={"data": {"rows": {role: count}}},
                               rules={"selection": {"roles": {role: [0, 100]}, "maximumRowsPerFamily": 4}},
                               fit_rules=data.fit.contract())
        self.write_fixture(auth, root, labels, rows)
        return auth, labels, rows

    def write_fixture(self, auth, root, labels, sources):
        for key, rows, original, container in (
                ("labels", labels, "/old/labels/shared-train.ndjson", auth.summary["output"]),
                ("sources", sources, "/old/selected/shared-train.ndjson", auth.selection["selection"])):
            raw = b"".join(encoded(row) + b"\n" for row in rows)
            path = root / key
            path.write_bytes(raw)
            artifact = data.Artifact(path, hashlib.sha256(raw).hexdigest(), len(raw))
            auth.artifacts[original] = artifact
            container["files"] = [{"role": "shared-train", "path": "shared-train.ndjson",
                                    "rows": len(rows), "sha256": artifact.sha256, "bytes": artifact.size}]

    def test_duplicate_accepted_ids_and_partition_count_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth, labels, sources = self.fixture(root)
            self.assertEqual(len(data._role_rows(auth, "shared-train")), 2)
            self.write_fixture(auth, root, [labels[0], labels[0]], sources)
            with self.assertRaisesRegex(ValueError, "duplicate admitted id"):
                data._role_rows(auth, "shared-train")
            self.write_fixture(auth, root, labels, sources)
            auth.summary["output"]["files"][0]["rows"] = 3
            with self.assertRaisesRegex(ValueError, "partition count"):
                data._role_rows(auth, "shared-train")

    def test_selected_source_preservation_and_teacher_admission(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth, labels, sources = self.fixture(root)
            modified = copy.deepcopy(labels)
            modified[0]["sourceGame"]["rawSha256"] = "e" * 64
            self.write_fixture(auth, root, modified, sources)
            with self.assertRaisesRegex(ValueError, "changed selected source"):
                data._role_rows(auth, "shared-train")
            modified = copy.deepcopy(labels)
            modified[0]["teacher"]["nodes"] = 99999
            self.write_fixture(auth, root, modified, sources)
            with self.assertRaisesRegex(ValueError, "admission"):
                data._role_rows(auth, "shared-train")

    def test_missing_archive_cannot_be_admitted_from_code_or_synthetic_fixtures(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "missing exact audited artifact"):
                data.authenticate(Path(temporary))


if __name__ == "__main__":
    unittest.main()
