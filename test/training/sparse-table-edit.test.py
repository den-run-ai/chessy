#!/usr/bin/env python3
"""Bounded-prefix authentication must also reject tampering outside the prefix."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.sparse_eval.table_edit import retained_prefix, fen_prefix


class PrefixTests(unittest.TestCase):
    def test_tail_tampering_and_complete_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b"prefix"+b"x"*(2*1024*1024)
            path = root/"train.bin"
            path.write_bytes(payload)
            item = {"path": path.name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            self.assertEqual(retained_prefix(root, item, 6), b"prefix")
            self.assertEqual(retained_prefix(root, item, 0), b"")
            path.write_bytes(payload[:-1]+b"y")
            with self.assertRaises(ValueError):
                retained_prefix(root, item, 6)

    def test_fen_count_tail_and_path_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b"fen1\nfen2\nfen3\n"
            path = root/"train.fens.txt"
            path.write_bytes(payload)
            item = {"path": path.name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            self.assertEqual(fen_prefix(root, item, 2, 3), ["fen1", "fen2"])
            with self.assertRaises(ValueError):
                fen_prefix(root, item, 2, 4)
            with self.assertRaises(ValueError):
                retained_prefix(root, dict(item, path="../train.fens.txt"), 1)
            alias = root/"alias"
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                retained_prefix(root, dict(item, path="alias"), 1)


if __name__ == "__main__":
    unittest.main()
