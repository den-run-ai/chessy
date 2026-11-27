#!/usr/bin/env python3
"""Compile scalar/SSE2 score and mask contracts with the pinned Rust toolchain."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class RuntimeContracts(unittest.TestCase):
    def test_scalar_and_simd_against_historical_score_and_independent_masks(self):
        compiler = (os.environ.get("EVAL_PIPELINE_RUSTC")
                    or os.environ.get("CHESSY_RUSTC_BIN")
                    or os.environ.get("SPARSE_EVAL_RUSTC") or shutil.which("rustc"))
        self.assertIsNotNone(compiler, "pinned rustc is required; set EVAL_PIPELINE_RUSTC")
        version = subprocess.run([compiler, "--version", "--verbose"], check=True,
                                 capture_output=True, text=True).stdout
        self.assertIn("release: 1.97.1", version)
        self.assertIn("commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452", version)
        with tempfile.TemporaryDirectory(prefix="chessy-eval-pipeline-runtime-") as directory:
            spec = importlib.util.spec_from_file_location("eval_pipeline_prepare_runtime_test",
                                                          ROOT / "tools/eval_pipeline/prepare.py")
            prepare = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(prepare)
            variants = (("full", None, []), ("no-pawn", (6528, 8064), ["--cfg", "eval_pipeline_no_pawn"]),
                        ("no-ray", (8064, 8640), ["--cfg", "eval_pipeline_no_ray"]))
            for family_name, removed, family_flags in variants:
                weights = bytearray((ROOT / "eval/sparse-pesto-v1/fit/full.i16le").read_bytes())
                if removed:
                    start, stop = removed
                    for offset in (0, 8640):
                        weights[(offset + start) * 2:(offset + stop) * 2] = bytes((stop - start) * 2)
                baked = Path(directory) / (family_name + "-model.rs")
                baked.write_bytes(prepare.render_model(bytes(weights)))
                baked.chmod(0o444)
                environment = {**os.environ, "EVAL_PIPELINE_BAKED_MODEL": str(baked)}
                for implementation, flags in (("scalar", []), ("simd", ["--cfg", "eval_pipeline_simd"])):
                    name = family_name + "-" + implementation
                    self.check_variant(directory, compiler, name, family_flags + flags, environment)

    def check_variant(self, directory, compiler, name, flags, environment):
        with self.subTest(implementation=name):
            binary = Path(directory) / name
            command = [compiler, "--edition=2021", "-O", "--test", "--cfg", "eval_pipeline_baked", *flags,
                       str(ROOT / "test/training/eval-pipeline-runtime.rs"), "-o", str(binary)]
            built = subprocess.run(command, capture_output=True, text=True, env=environment)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            checked = subprocess.run([str(binary), "--test-threads=1"], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            self.assertIn("test result: ok", checked.stdout)
            print(name + ": " + next(line for line in checked.stdout.splitlines()
                                     if line.startswith("test result:")))


if __name__ == "__main__":
    unittest.main()
