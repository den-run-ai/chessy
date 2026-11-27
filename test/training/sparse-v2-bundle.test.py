#!/usr/bin/env python3
"""Tiny local-Git and hostile-archive fixtures; no experiment data is read."""
import hashlib
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

import zstandard

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval_v2 import bundle as b


def git_repo(root):
    repo = root / "repo"; repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
    (repo / "code.py").write_bytes(b"retained source\n")
    subprocess.run(["git", "-C", str(repo), "-c", "core.autocrlf=false", "add", "code.py"], check=True, capture_output=True)
    return repo


def hostile(root, entries, files, references=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name); info.mode = 0o600; info.type = kind
            if kind == tarfile.SYMTYPE:
                info.linkname = "../outside"
            else:
                info.size = len(content)
            archive.addfile(info, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
        manifest = {"schema": b.SCHEMA, "files": files, "references": references or [], "fileCount": len(files) + len(references or [])}
        payload = b.encoded(manifest)
        info = tarfile.TarInfo("RESTORE.json"); info.mode = 0o444; info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    raw = zstandard.ZstdCompressor().compress(buffer.getvalue())
    path = root / "hostile.tar.zst"; path.write_bytes(raw)
    return path, hashlib.sha256(raw).hexdigest()


class BundleContracts(unittest.TestCase):
    def test_staged_blobs_deduplicate_and_restore_despite_worktree_edit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = git_repo(root); evidence = root / "evidence"; evidence.mkdir()
            (evidence / "copy.py").write_bytes(b"retained source\n")
            (evidence / "raw.bin").write_bytes(b"\x00raw evidence\xff")
            (repo / "code.py").write_bytes(b"uncommitted worktree change\n")
            package = root / "archive.tar.zst"
            created = b.create(repo, [("run", evidence)], package)
            self.assertEqual((created["rawFiles"], created["repoReferences"]), (1, 1))
            self.assertEqual(hashlib.sha256(package.read_bytes()).hexdigest(), created["sha256"])
            restored = b.restore(repo, package, created["sha256"], root / "restored")
            self.assertEqual(restored["fileCount"], 2)
            self.assertEqual((root / "restored/run/copy.py").read_bytes(), b"retained source\n")
            self.assertEqual((root / "restored/run/raw.bin").read_bytes(), b"\x00raw evidence\xff")
            with self.assertRaises(ValueError):
                b.create(repo, [("run", evidence)], package)
            with self.assertRaises(ValueError):
                b.restore(repo, package, created["sha256"], root / "restored")

    def test_source_symlinks_and_duplicate_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = git_repo(root); evidence = root / "evidence"; evidence.mkdir()
            (evidence / "link").symlink_to(repo / "code.py")
            with self.assertRaises(ValueError):
                b.create(repo, [("run", evidence)], root / "bad.tar.zst")
            (evidence / "link").unlink(); (evidence / "plain").write_bytes(b"raw")
            with self.assertRaises(ValueError):
                b.create(repo, [("run", evidence), ("run", evidence)], root / "bad.tar.zst")

    def test_traversal_and_symlink_tar_members_are_rejected(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); repo = git_repo(root)
                archive, digest = hostile(root, [(name, b"bad", kind)], [])
                with self.assertRaises(ValueError):
                    b.restore(repo, archive, digest, root / "restored")
                self.assertFalse((root / "escape").exists())
                self.assertFalse((root / "restored/RESTORED.json").exists())

    def test_duplicate_member_and_payload_hash_forgery_are_rejected(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); repo = git_repo(root)
                entries = [("raw", b"payload", tarfile.REGTYPE)] * (2 if duplicate else 1)
                files = [{"archivePath": "raw", "sha256": "0" * 64, "bytes": 7, "mode": 0o600}]
                archive, digest = hostile(root, entries, files)
                with self.assertRaises(ValueError):
                    b.restore(repo, archive, digest, root / "restored")
                self.assertFalse((root / "restored/RESTORED.json").exists())

    def test_wrong_external_digest_and_size_limit_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = git_repo(root)
            item = {"archivePath": "raw", "sha256": hashlib.sha256(b"payload").hexdigest(), "bytes": 7, "mode": 0o600}
            archive, digest = hostile(root, [("raw", b"payload", tarfile.REGTYPE)], [item])
            with self.assertRaises(ValueError):
                b.restore(repo, archive, "0" * 64, root / "wrong-hash")
            self.assertFalse((root / "wrong-hash").exists())
            with self.assertRaises(ValueError):
                b.restore(repo, archive, digest, root / "too-large", max_bytes=6)

    def test_unavailable_or_wrong_git_blob_is_not_filled_from_other_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = git_repo(root)
            reference = {"archivePath": "copy", "repoPath": "code.py", "gitBlobSha": "0" * 40,
                         "sha256": hashlib.sha256(b"retained source\n").hexdigest(), "bytes": 16, "mode": 0o600}
            archive, digest = hostile(root, [], [], [reference])
            with self.assertRaises(ValueError):
                b.restore(repo, archive, digest, root / "restored")
            self.assertFalse((root / "restored/RESTORED.json").exists())


if __name__ == "__main__":
    unittest.main()
