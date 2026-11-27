#!/usr/bin/env python3
"""Mutation-sensitive export/source-capture contracts; no timing observations."""
import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("eval_pipeline_prepare", ROOT / "tools/eval_pipeline/prepare.py")
pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pipeline)
IMPORT_SPEC = importlib.util.spec_from_file_location("eval_pipeline_refit_import", ROOT / "tools/eval_pipeline/refit_import.py")
refit_import = importlib.util.module_from_spec(IMPORT_SPEC)
IMPORT_SPEC.loader.exec_module(refit_import)


def packed(edits=None):
    weights = [0] * pipeline.TOTAL
    for index, value in (edits or {}).items():
        weights[index] = value
    return struct.pack("<" + "h" * len(weights), *weights)


class Export(unittest.TestCase):
    def test_complete_model_and_signed_pair_orientation(self):
        # White pawn east toward a black rook and the black rook's reverse
        # orientation both contribute. Their White-POV signs are opposite.
        a = 8064 + (((0 * 6 + 3) * 2 + 1) * 8 + 2)
        b = 8064 + (((3 * 6 + 0) * 2 + 1) * 8 + 6)
        result = pipeline.tables(packed({0: 3, 384: -5, 3456: 7, 6528: -9, a: 11, b: 4}))
        self.assertEqual(result["fused"][0], [-2, 0])
        self.assertEqual(result["enemy"][0], [7, 0])
        self.assertEqual(result["pawn"][0], [-9, 0])
        self.assertEqual(result["pairs"][(1 * 13 + 10) * 4], [7, 0])
        self.assertEqual(sum(len(v) * 2 for v in result.values()), pipeline.MODEL_BYTES)
        self.assertEqual(result["pairs"][0], [0, 0])

    def test_stage_offsets_are_independent(self):
        result = pipeline.tables(packed({0: 3, pipeline.BASE: -5}))
        self.assertEqual(result["fused"][0], [3, -5])
        self.assertEqual(result["fused"][384], [3, -5])
        self.assertEqual(result["fused"][1], [0, 0])

    def test_no_clipping_or_implicit_quantization(self):
        for raw in (b"", packed()[:-1], packed({0: 128}), packed({0: 80, 384: 80})):
            with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                pipeline.tables(raw)
        a = 8064 + (((0 * 6 + 3) * 2 + 1) * 8 + 2)
        b = 8064 + (((3 * 6 + 0) * 2 + 1) * 8 + 6)
        with self.assertRaisesRegex(ValueError, "paired-ray"):
            pipeline.tables(packed({a: 100, b: -100}))

    def test_current_model_is_unchanged_and_baked(self):
        raw = (ROOT / pipeline.DEFAULT_MODEL).read_bytes()
        self.assertEqual(pipeline.sha(raw), "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304")
        rendered = pipeline.render_model(raw).decode()
        self.assertIn("static MODEL", rendered)
        self.assertIn("Model::from_tables", rendered)
        self.assertNotIn("load_dense", rendered)
        self.assertNotIn("static mut", rendered)


class Preparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name)
        self.root = self.parent / "repo"
        self.root.mkdir()
        for name in pipeline.PRODUCTION:
            destination = self.root / "experiments/wasm" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "experiments/wasm" / name, destination)
        for name in (*pipeline.IMPLEMENTATION,):
            destination = self.root / "tools/eval_pipeline" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "tools/eval_pipeline" / name, destination)
        for name in (pipeline.DEFAULT_MODEL, pipeline.DEFAULT_SELECTION, "LICENSE",
                     "THIRD_PARTY_NOTICES.md", "assets/chessy-ai-fast.wasm",
                     "assets/engine.js", "assets/wasm-engine.js"):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.output = self.parent / "candidate"

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE)

    def prepare(self):
        return pipeline.prepare(self.root, self.commit, self.output)

    def test_current_production_not_mutable_working_copy_is_captured(self):
        original = (self.root / "experiments/wasm/src/search.rs").read_bytes()
        (self.root / "experiments/wasm/src/search.rs").write_text("unreviewed working change\n")
        receipt = self.prepare()
        self.assertEqual((self.output / "base/src/search.rs").read_bytes(), original)
        for variant in pipeline.VARIANTS:
            source = self.output / "variants" / variant
            self.assertEqual((source / "src/search.rs").read_bytes(), original)
            self.assertIn(b"search_seeded", (source / "src/lib.rs").read_bytes())
            self.assertIn(b"analysis_root", (source / "src/lib.rs").read_bytes())
        self.assertEqual(receipt["abiVersion"], 2)
        self.assertEqual(receipt["evaluationCacheBytes"], 0)
        self.assertEqual(receipt["model"]["coefficientBytes"], 16712)

    def test_only_explicit_isa_and_evaluator_changes(self):
        self.prepare()
        base = self.output / "base"
        for variant in pipeline.VARIANTS:
            source = self.output / "variants" / variant
            for name in ("Cargo.toml", "Cargo.lock", "src/search.rs", "src/engine.rs"):
                self.assertEqual((source / name).read_bytes(), (base / name).read_bytes())
            build = (source / "build.sh").read_text()
            self.assertIn("MEMORY_BYTES=26542080\n", build)
            self.assertEqual("--enable-simd" in build, variant.endswith("-simd"))
            self.assertEqual((source / "src/eval_pipeline/model.rs").exists(), variant.startswith("sparse-"))

    def test_existing_destination_is_never_replaced(self):
        self.output.mkdir()
        (self.output / "sentinel").write_text("keep")
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual((self.output / "sentinel").read_text(), "keep")

    def test_extra_memory_is_explicit_and_matched_control_is_otherwise_exact(self):
        receipt = pipeline.prepare(self.root, self.commit, self.output, extra_memory_page=True)
        self.assertTrue(receipt["explicitExtraMemoryPage"])
        self.assertEqual(receipt["baselineMemoryPages"], 405)
        self.assertEqual(receipt["candidateMemoryPages"], 406)
        base = self.output / "variants/baseline"
        matched = self.output / "variants/baseline-memory"
        for name in pipeline.PRODUCTION:
            if name != "build.sh":
                self.assertEqual((base / name).read_bytes(), (matched / name).read_bytes())
        self.assertEqual((matched / "build.sh").read_bytes(),
                         (base / "build.sh").read_bytes().replace(
                             b"MEMORY_BYTES=26542080\n", b"MEMORY_BYTES=26607616\n"))
        for variant in pipeline.VARIANTS[1:]:
            self.assertIn("MEMORY_BYTES=26607616\n", (self.output / "variants" / variant / "build.sh").read_text())

    def test_model_or_hce_constant_tampering_rejected_before_publication(self):
        model = self.root / pipeline.DEFAULT_MODEL
        original = model.read_bytes()
        model.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValueError, "retained prior selection"):
            self.prepare()
        self.assertFalse(self.output.exists())
        model.write_bytes(original)
        constants = self.root / "tools/eval_pipeline/hce_constants.rs"
        constants.write_text(constants.read_text().replace("PHASE_MAX: i32 = 24", "PHASE_MAX: i32 = 23"))
        with self.assertRaisesRegex(ValueError, "HCE constants"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_snapshot_mutation_extra_source_and_ambient_configuration_rejected(self):
        self.prepare()
        file = self.output / "variants/sparse-simd/src/eval.rs"
        original = file.read_bytes()
        file.chmod(0o644)
        file.write_bytes(original + b"\n// mutation\n")
        with self.assertRaisesRegex(ValueError, "retained input changed"):
            pipeline.verify_prepared(self.output)
        file.write_bytes(original)
        extra = self.output / "variants/sparse-simd/src/extra.rs"
        extra.write_text("// hidden source\n")
        with self.assertRaisesRegex(ValueError, "inventory"):
            pipeline.verify_prepared(self.output)
        extra.unlink()
        config = self.parent / ".cargo/config.toml"
        config.parent.mkdir()
        config.write_text('[build]\nrustflags = ["-Ctarget-cpu=native"]\n')
        with self.assertRaisesRegex(ValueError, "ambient Cargo"):
            pipeline.verify_prepared(self.output)

    def test_unknown_production_module_is_not_silently_omitted(self):
        extra = self.root / "experiments/wasm/src/extra.rs"
        extra.write_text("// new source\n")
        self.git("add", str(extra))
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "extra source")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        with self.assertRaisesRegex(ValueError, "inventory changed"):
            self.prepare()

    def test_refit_options_are_explicit_and_do_not_change_hce_build_flags(self):
        with self.assertRaisesRegex(ValueError, "provided together"):
            pipeline.prepare(self.root, self.commit, self.output, recipe="refit-no-pawn")
        base = {name: (self.root / "experiments/wasm" / name).read_bytes() for name in pipeline.PRODUCTION}
        implementation = {name: (self.root / "tools/eval_pipeline" / name).read_bytes() for name in pipeline.IMPLEMENTATION}
        for variant in pipeline.VARIANTS:
            plain = pipeline.variant_sources(base, implementation, b"model", variant)
            specialized = pipeline.variant_sources(base, implementation, b"model", variant,
                                                   family_cfg="eval_pipeline_no_pawn")
            if variant.startswith("sparse-"):
                self.assertIn(b"--cfg eval_pipeline_no_pawn", specialized["build.sh"])
                self.assertEqual(specialized["src/search.rs"], plain["src/search.rs"])
                self.assertEqual(specialized["src/engine.rs"], plain["src/engine.rs"])
            else:
                self.assertEqual(specialized, plain)
        with self.assertRaisesRegex(ValueError, "unregistered"):
            pipeline.variant_sources(base, implementation, b"model", "sparse-simd", family_cfg="ignore_guards")


class RefitImport(unittest.TestCase):
    """Synthetic closure tests, never training or strength observations."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.output = Path(self.temporary.name)
        self.raw = {name: b"synthetic fixture only\n" for name in refit_import.REQUIRED_REGISTERED}
        for name, digest in refit_import.SOURCE_HASHES.items():
            if name.startswith("source/experiments/"):
                source = ROOT / "tools/sparse_eval/baseline" / Path(name).name
            elif name.endswith("/fit.py"):
                source = ROOT / "tools/sparse_eval/fit.py"
            else:
                source = ROOT / "eval/sparse-pesto-v1/source-snapshots" / (digest + ".txt")
            self.raw[name] = source.read_bytes()
        self.raw["source/tools/eval_pipeline/refit.py"] = b"raise RuntimeError('imported code must never execute')\n"
        self.raw["inputs/original-full.i16le"] = (ROOT / pipeline.DEFAULT_MODEL).read_bytes()
        roles, source_roles = [], []
        for role, rows in (("train", 4), ("validation", 3)):
            source_roles.append({"role": role, "rows": rows, "path": role + ".jsonl",
                                 **pipeline.identity(self.raw["inputs/" + role + ".jsonl"])})
            files = {}
            for suffix in refit_import.PACKED_FILES:
                name = role + "." + suffix
                self.raw["packed/" + name] = ("synthetic " + name).encode()
                files[suffix] = {"path": name, **pipeline.identity(self.raw["packed/" + name])}
            roles.append({"role": role, "rows": rows, "files": files})
        data = {"schema": "chessy.sparse-eval-data.v1", "status": "complete-research-only",
                "researchOnly": True, "productionFitAllowed": False, "files": source_roles}
        self.raw["inputs/data-manifest.json"] = pipeline.canonical(data)
        data_sha = pipeline.sha(self.raw["inputs/data-manifest.json"])
        packed_manifest = {"schema": "chessy.sparse-packed.v1", "status": "complete-research-only",
                           "researchOnly": True, "productionFitAllowed": False,
                           "sourceManifestSha256": data_sha, "featureCount": 17280,
                           "noCrossRoleFamilyOrClusterOverlap": True, "roles": roles}
        self.raw["inputs/packed-manifest.json"] = pipeline.canonical(packed_manifest)
        packed_sha = pipeline.sha(self.raw["inputs/packed-manifest.json"])
        self.constants = patch.multiple(refit_import, DATA_SHA=data_sha, PACKED_SHA=packed_sha,
                                        ROLES={"train": 4, "validation": 3})
        self.constants.start()
        self.addCleanup(self.constants.stop)
        protocol = {"schema": "chessy.eval-pipeline-refit-protocol.v1", "researchOnly": True,
                    "rolesOpened": ["train", "validation"], "dataManifestSha256": data_sha,
                    "packedManifestSha256": packed_sha, "originalFullModelSha256": refit_import.FULL_SHA,
                    "recipes": list(refit_import.RECIPES.values()), "qualityRules": refit_import.QUALITY,
                    "productionAdmission": False, "noHoldoutOrOodFilesRead": True,
                    "fit": {"l1": 1e-5, "l2": 1e-4, "minSupport": 32, "maxIterations": 400,
                            "optimizerSourceSha256": refit_import.SOURCE_HASHES["source/tools/sparse_eval/fit.py"]}}
        self.raw["PROTOCOL.json"] = pipeline.canonical(protocol)
        registration = {"schema": "chessy.eval-pipeline-refit-registration.v1", "researchOnly": True,
                        "productionAdmission": False, "trainingStarted": False,
                        "noHoldoutOrOodFilesRead": True, "protocol": protocol,
                        "files": {name: pipeline.identity(self.raw[name]) for name in refit_import.REQUIRED_REGISTERED}}
        self.raw["REGISTRATION.json"] = pipeline.canonical(registration)
        registration_sha = pipeline.sha(self.raw["REGISTRATION.json"])
        self.raw["RUN-STARTED.json"] = pipeline.canonical({"registrationSha256": registration_sha, "protocol": protocol})
        self.raw["packed/PACKED.json"] = pipeline.canonical({
            "schema": "chessy.eval-pipeline-refit-packed.v1", "originalPackedManifestSha256": packed_sha,
            "noHoldoutOrOodFilesRead": True, "noCrossRoleFamilyOrClusterOverlap": True, "roles": roles})

        def metrics(ce, family=False):
            return {phase: {"rows": 3 if phase == "overall" else 1, "ce": ce, "maeCp": 9.0, "rmseCp": 19.0,
                            **({"families": 3 if phase == "overall" else 1} if family else {})}
                    for phase in ("overall", "opening", "middlegame", "endgame")}

        references = {}
        for label, ce in (("hce", 1.0), ("full", 0.8)):
            name = label + ".validation.i32"
            self.raw[name] = bytes(12)
            references[label] = {"validation": metrics(ce), "familyBalanced": metrics(ce, True),
                                 "scores": {"path": name, **pipeline.identity(self.raw[name])}}
        candidates = []
        for name, recipe in refit_import.RECIPES.items():
            candidate = {"schema": "chessy.eval-pipeline-refit-model.v1", "id": name,
                         "recipe": recipe, "researchOnly": True, "productionAdmission": False,
                         "noHoldoutOrOodFilesRead": True, "registrationSha256": registration_sha,
                         "dataManifestSha256": data_sha, "packedManifestSha256": packed_sha,
                         "originalFullModelSha256": refit_import.FULL_SHA,
                         "fit": {"schema": "chessy.sparse-convex-fit.v1", "researchOnly": True,
                                 "rows": 4, "columns": 17280, "families": recipe["families"],
                                 "l1": 1e-5, "l2": 1e-4, "iterations": 1, "solverSuccess": True,
                                 "projectedGradientInfinityNorm": 1e-6, "numericallyConverged": True},
                         "validation": metrics(0.82), "familyBalanced": metrics(0.82, True),
                         "qualityEligible": True, "runtime": {"losslessI8TablesSupported": True},
                         "qualityGuards": {}}
            for label, metric in (("rows", "validation"), ("families", "familyBalanced")):
                checks = refit_import.metrics_guard(candidate[metric], references["full"][metric],
                                                     references["hce"][metric], converged=True,
                                                     removed_zero=True, family_counts=label == "families")
                candidate["qualityGuards"][label] = {"checks": checks, "passed": True}
            for key, suffix, size in (("weights", ".i16le", 34560), ("floatWeights", ".f64le", 138240),
                                      ("validationScores", ".validation.i32", 12)):
                self.raw[name + suffix] = bytes(size)
                candidate[key] = {"path": name + suffix, **pipeline.identity(self.raw[name + suffix])}
            candidates.append(candidate)
        self.result = {"schema": "chessy.eval-pipeline-refit-results.v1", "status": "complete-research-only",
                       "researchOnly": True, "productionAdmission": False, "noHoldoutOrOodFilesRead": True,
                       "strengthEvidence": False, "registrationSha256": registration_sha,
                       "protocol": protocol, "references": references, "candidates": candidates}
        self.publish()

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self):
        for candidate in self.result["candidates"]:
            self.raw[candidate["id"] + ".json"] = pipeline.canonical(candidate)
        for name, raw in self.raw.items():
            path = self.output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        self.result["files"] = {name: pipeline.identity(raw) for name, raw in self.raw.items()}
        (self.output / "RESULTS.json").write_bytes(pipeline.canonical(self.result))

    def capture(self):
        return refit_import.capture(self.output / "RESULTS.json", "refit-no-pawn", validate_tables=pipeline.tables)

    def test_complete_closure_is_bound_without_executing_supplied_source(self):
        imported = self.capture()
        self.assertEqual(imported["receipt"]["completeInventoryFilesVerified"], len(self.raw))
        self.assertEqual(imported["specialization"]["coefficientBytes"], 13640)
        self.assertEqual(imported["model"], bytes(34560))
        self.assertIn("source/tools/eval_pipeline/refit.py", imported["retained"])
        self.assertIn("refit-no-pawn.validation.i32", imported["retained"])
        self.assertNotIn("inputs/train.jsonl", imported["retained"])
        self.assertFalse(imported["receipt"]["productionAdmission"])

    def test_missing_reference_and_changed_raw_corpus_fail_closed(self):
        (self.output / "inputs/train.jsonl").write_bytes(b"changed corpus")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.capture()
        self.publish()
        del self.raw["hce.validation.i32"]
        self.publish()
        with self.assertRaisesRegex(ValueError, "reference score"):
            self.capture()

    def test_quality_convergence_family_counts_and_export_flags_cannot_admit_bad_model(self):
        original = copy.deepcopy(self.result["candidates"][0])
        changes = (
            (lambda row: row.update(qualityEligible=False), "not validation eligible"),
            (lambda row: row["validation"]["overall"].update(ce=1.0), "quality guard"),
            (lambda row: row["fit"].update(projectedGradientInfinityNorm=0.1), "did not numerically converge"),
            (lambda row: row["familyBalanced"]["overall"].update(families=2), "family inventory"),
            (lambda row: row["runtime"].update(losslessI8TablesSupported=False), "runtime eligible"),
        )
        for change, message in changes:
            with self.subTest(message=message):
                self.result["candidates"][0] = copy.deepcopy(original)
                change(self.result["candidates"][0]); self.publish()
                with self.assertRaisesRegex(ValueError, message):
                    self.capture()

    def test_float_export_and_removed_family_are_verified_from_actual_bytes(self):
        candidate = self.result["candidates"][0]
        floats = candidate["floatWeights"]["path"]
        self.raw[floats] = struct.pack("<d", 1.0) + self.raw[floats][8:]
        candidate["floatWeights"] = {"path": floats, **pipeline.identity(self.raw[floats])}
        self.publish()
        with self.assertRaisesRegex(ValueError, "half-away rounding"):
            self.capture()
        values = [0] * 17280; values[6528] = 1
        for key, fmt in (("weights", "h"), ("floatWeights", "d")):
            path = candidate[key]["path"]
            self.raw[path] = struct.pack("<17280" + fmt, *values)
            candidate[key] = {"path": path, **pipeline.identity(self.raw[path])}
        self.publish()
        with self.assertRaisesRegex(ValueError, "family is not exactly zero"):
            self.capture()


if __name__ == "__main__":
    unittest.main()
