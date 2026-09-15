#!/usr/bin/env python3
"""Reproduce the one fixed historical pilot; never admit a production input.

Reads retained snapshots, verifies the original source/input identities, and
emits compact forensic evidence only. No teacher execution, weights or labels
are published. Requires the repository's original git object, Node, NumPy
2.3.5, SciPy 1.17.0 and python-chess (chess module 1.11.2).
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types

# Set before either NumPy or SciPy is imported.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[variable] = "1"

import chess
import numpy as np
import scipy


ROOT = Path(__file__).resolve().parents[2]
COMMIT = "f769f87903cd8ee026a1aa2472f6e81a58514298"
ANALYZER = "tools/training/analyze-hce-synthetic-pilot.py"
EXPECTED = {
    "input": "77db4b4b4c40b5bb4e14c67aaf98f3e36b590128bc9b02125028f9abe9a413ae",
    "label_summary": "2f8076471fb49cd57a87233b54d60a8b0e6406e4dcdfb28804d60550b2a0a57f",
    "source_archive": "2deeca8664333eb98103fcb2019b898879255cba7e1a9f8940e7c09a8aad2038",
    "executable": "ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319",
    "analysis": "566ee8e8c5f11b9a573cf33ebd0fe0ee33c024615198391c0a28269224fce5f7",
    "generated": "a7186f8dce3cbe71d8b481360b36906dabafcf2d7f6d557b6f854fc02dbfcef9",
    "historical": "0922b103df889a833d4cc77af890261d33f1cd2676f8b6ef15278cd974b3b33f",
}

NODE_AUDIT = r"""
const fs = require('fs'), crypto = require('crypto');
const Data = require('./tools/training/hce-synthetic-pilot-data');
const Linear = require('./test/training/hce-r3-linear');
const Baseline = require('./test/training/hce-r3-baseline');
const Corpus = require('./test/training/corpus');
const Wasm = require('./test/wasm-test-engine');
const weights = Baseline.baselineCenter();
const rows = fs.readFileSync(process.argv[1], 'utf8').trim().split('\n').map(JSON.parse);
const out = {featureVectorMismatches: 0, clusterKeyMismatches: 0,
  positionFamilyKeyMismatches: 0, runtimeRoundedScoreMismatchesBefore: 0,
  runtimeRoundedScoreMismatchesAfter: 0, largestMismatchCp: 0};
for (const row of rows) {
  const compiled = Linear.compile(row.fen);
  if (compiled.fixedCp !== row.fixedCp ||
      JSON.stringify(compiled.sparse.map(e => e[0])) !== JSON.stringify(row.indices) ||
      JSON.stringify(compiled.sparse.map(e => e[1])) !== JSON.stringify(row.data))
    out.featureVectorMismatches++;
  if (Corpus.clusterKey(row.fen) !== row.cluster) out.clusterKeyMismatches++;
  if (Corpus.positionFamilyKey(row.fen) !== row.positionFamily) out.positionFamilyKeyMismatches++;
  let legacy = compiled.fixedTaperCp;
  for (let i = 0; i < weights.length; i++) legacy += compiled.dense[i] * weights[i];
  legacy = Math.round(legacy) + compiled.mopUpCp;
  const actual = Wasm.engine.evaluate(row.fen);
  if (legacy !== actual) out.runtimeRoundedScoreMismatchesBefore++;
  out.largestMismatchCp = Math.max(out.largestMismatchCp, Math.abs(legacy - actual));
  if (Linear.runtimeRoundedScore(compiled, weights) !== actual)
    out.runtimeRoundedScoreMismatchesAfter++;
}
const generated = Data.generate({rows: 12000, seed: 1370914});
const hash = crypto.createHash('sha256');
for (const row of generated.rows) hash.update(JSON.stringify(row) + '\n');
out.generatedInputSha256 = hash.digest('hex');
out.generatedInputRows = generated.rows.length;
process.stdout.write(JSON.stringify(out));
"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require_bytes(path: Path, expected: str) -> bytes:
    # Hash and consume these same bytes, never reopen an authenticated pathname.
    data = path.read_bytes()
    if digest(data) != expected:
        raise ValueError(f"{path.name}: SHA-256 differs from the fixed historical run")
    return data


def historical_module() -> tuple[types.ModuleType, str]:
    source = subprocess.check_output(["git", "show", f"{COMMIT}:{ANALYZER}"], cwd=ROOT)
    if digest(source) != EXPECTED["historical"]:
        raise ValueError("historical analyzer source differs")
    module = types.ModuleType("pilot_historical_forensic")
    module.__file__ = str(ROOT / ANALYZER)
    sys.modules[module.__name__] = module
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module, digest(source)


def current_module():
    spec = importlib.util.spec_from_file_location("pilot_current_forensic", ROOT / ANALYZER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run(args) -> dict:
    if args.output.exists():
        raise FileExistsError("refusing to overwrite forensic output")
    if (np.__version__, scipy.__version__, chess.__version__) != ("2.3.5", "1.17.0", "1.11.2"):
        raise ValueError("requires NumPy 2.3.5, SciPy 1.17.0 and chess module 1.11.2")
    driver_hash = digest(Path(__file__).read_bytes())
    implementation_paths = [ANALYZER, "tools/training/hce-synthetic-pilot-data.js",
        "test/training/hce-r3-linear.js", "test/training/hce-r3-features.js",
        "test/training/hce-r3-baseline.js", "test/training/corpus.js",
        "assets/chessy-ai-fast.wasm", "experiments/wasm/src/eval.rs"]
    implementation_hashes = {path: digest((ROOT / path).read_bytes()) for path in implementation_paths}
    snapshots = {name: require_bytes(getattr(args, name), EXPECTED[name]) for name in (
        "input", "label_summary", "source_archive", "executable"
    )}
    original = json.loads(require_bytes(
        ROOT / "eval/training/pilots/hce-synthetic-12k-25kn-analysis.json", EXPECTED["analysis"]
    ))
    old, historical_hash = historical_module()
    current = current_module()
    with tempfile.TemporaryDirectory(prefix="chessy-forensic-") as directory:
        temporary = Path(directory)
        for name in ("input", "label_summary"):
            path = temporary / name
            path.write_bytes(snapshots[name])
            path.chmod(0o400)
        summary = old.load_summary(temporary / "label_summary", temporary / "input")
        datasets, inventory = old.load_rows(temporary / "input", summary)
        node = json.loads(subprocess.check_output(
            ["node", "-e", NODE_AUDIT, str(temporary / "input")], cwd=ROOT
        ))
    if node["generatedInputSha256"] != EXPECTED["generated"]:
        raise AssertionError("generated 12k input differs from the original")
    for key in ("featureVectorMismatches", "clusterKeyMismatches",
                "positionFamilyKeyMismatches", "runtimeRoundedScoreMismatchesAfter"):
        if node[key]:
            raise AssertionError(f"independent geometry/reconstruction check failed: {key}")

    records = [json.loads(line) for line in snapshots["input"].splitlines()]
    seeds = collections.defaultdict(set)
    tactical = collections.Counter()
    excluded = collections.Counter()
    excluded_in_check = 0
    bad = set()
    for row in records:
        board = chess.Board(row["fen"] + " 0 1")
        if not board.is_valid():
            raise AssertionError("historical row contains an invalid position")
        in_check = board.is_check()
        tactical["inCheck"] += in_check
        tactical["captureAvailable"] += any(board.is_capture(move) for move in board.legal_moves)
        tactical["teacherBestMoveIsCapture"] += board.is_capture(chess.Move.from_uci(row["teacher"]["bestMoveUci"]))
        for move in row["teacher"]["pvUci"]:
            board.push_uci(move)  # Independent legality check; raises on failure.
        seeds[row["sourceSeed"]["id"]].add(row["split"])
        if row["teacher"]["seldepth"] < row["teacher"]["depth"]:
            bad.add(row["id"])
            excluded[row["split"]] += 1
            excluded_in_check += in_check
    filtered = {}
    for split, dataset in datasets.items():
        mask = np.asarray([row_id not in bad for row_id in dataset.row_id])
        filtered[split] = dataclasses.replace(dataset, **{
            field.name: getattr(dataset, field.name)[mask] for field in dataclasses.fields(dataset)
        })
    metadata = old.load_metadata(ROOT)
    center = np.asarray(metadata["center"], dtype=float)
    scales = np.asarray(metadata["scales"], dtype=float)
    bounds = old.full_bounds(center)
    original_k = old.calibration_k(datasets["train"], center)
    filtered_k = old.calibration_k(filtered["train"], center)
    reproduction, sensitivity, rounding = {}, {}, {}
    for name, active in old.surfaces().items():
        for mode, data, calibration in (("original", datasets, original_k), ("filtered", filtered, filtered_k)):
            attempts = []
            for regularization in original["lambdaGrid"]:
                fit = old.fit_surface(name, active, data, center, scales,
                                      calibration["value"], regularization, bounds)
                fit["validationLoss"] = old.metrics(data["validation"], fit["weights"], calibration["value"])["crossEntropy"]
                attempts.append(fit)
            selected = min((fit for fit in attempts if fit["success"]),
                           key=lambda fit: (fit["validationLoss"], fit["lambda"]))
            losses = {split: old.metrics(dataset, selected["weights"], calibration["value"])["crossEntropy"]
                      for split, dataset in data.items()}
            if mode == "original":
                reference = next(item for item in original["surfaces"] if item["surface"] == name)
                rounded = np.rint(selected["weights"])
                matches = old.sha256_json_ints(rounded.astype(np.int64)) == reference["weights"]["roundedVectorSha256"]
                difference = max(abs(losses[split] - reference["float"][split]["crossEntropy"]) for split in data)
                if not matches or difference != 0 or selected["lambda"] != reference["lambda"]:
                    raise AssertionError(f"original fit does not reproduce exactly: {name}")
                reproduction[name] = {"lambda": selected["lambda"], "validation": losses["validation"],
                                      "test": losses["test"], "roundedVectorHashMatches": matches,
                                      "maxCeDifference": difference}
                rounding[name] = {split: current.metrics(dataset, rounded, calibration["value"], runtime_rounding=True)["crossEntropy"]
                                  for split, dataset in data.items()}
            else:
                sensitivity[name] = {"lambda": selected["lambda"], "crossEntropy": losses,
                    "zeroedMobility": [i for i in range(4) if round(selected["weights"][i]) == 0],
                    "pawnAttacksAtUpperBound": int(sum(abs(selected["weights"][i] - 96) < 1e-7 for i in range(753, 759)))}
        print(f"forensic audit reproduced {name}", file=sys.stderr, flush=True)
    report = {
        "schema": "chessy.hce-synthetic-pilot-forensic-audit.v1",
        "status": "forensic-reproduction-only-no-candidate", "date": "2026-09-14",
        "runtimeFilesChanged": False, "qualityClaimAllowed": False, "strengthClaimAllowed": False,
        "source": {"implementationCommit": COMMIT, "historicalAnalyzerSha256": historical_hash,
            "forensicDriverSha256": driver_hash, "rawLabelStreamSha256": EXPECTED["input"],
            "generatedInputSha256": node.pop("generatedInputSha256"),
            "generatedInputRows": node.pop("generatedInputRows"), "generatedInputReproduced": True,
            "sourceArchiveSha256": EXPECTED["source_archive"], "teacherExecutableSha256": EXPECTED["executable"],
            "sourceArchiveAndExecutableRehashed": True, "numpy": np.__version__, "scipy": scipy.__version__,
            "implementationSha256": implementation_hashes},
        "originalFitReproduction": {"inventory": inventory, "calibration": original_k, "surfaces": reproduction},
        "independentGeometryAudit": {"rows": len(records), "invalidPositions": 0, "illegalPvSequences": 0,
            **node, "sourceSeeds": len(seeds), "sourceSeedsCrossSplits": sum(len(value) > 1 for value in seeds.values()),
            "tacticalContext": dict(tactical), "depthRuleExcludedBySplit": dict(excluded),
            "depthRuleExcludedInCheck": excluded_in_check, "pythonChessVersion": chess.__version__},
        "sensitivity": {"originalReproducedRuntimeRoundedCrossEntropy": rounding,
            "originalFrozenRuntimeRoundedCrossEntropy": {split: current.metrics(dataset, center, original_k["value"], runtime_rounding=True)["crossEntropy"] for split, dataset in datasets.items()},
            "depthRuleSensitivity": {"removedRows": len(bad), "retained": {split: dataset.rows for split, dataset in filtered.items()},
                "calibration": filtered_k, "frozenBaselineCrossEntropy": {split: old.metrics(dataset, center, filtered_k["value"])["crossEntropy"] for split, dataset in filtered.items()},
                "surfaces": sensitivity, "status": "post-hoc contaminated-data sensitivity only; no new holdout or strength evidence"}},
        "interpretation": [
            "All original selected lambdas, metrics and rounded-vector hashes reproduce exactly. This verifies implementation, not generalization.",
            "215 rows violate the frozen seldepth >= depth rule. Legitimate Stockfish searches can have seldepth below nominal depth; this alone does not imply corrupt labels. The frozen rule remains unchanged.",
            "Legacy rounded metrics round weights only with a smooth taper. RuntimeRounded separately uses integer numerator and final Rust-compatible rounding.",
            "Every source seed crosses splits. Position-family bootstrap intervals do not account for this common source dependence.",
            "Boundary saturation persists after exclusions. This warrants clean-data ablations, not a claim of optimizer failure or Elo harm.",
            "The sensitivity refits the same surfaces and lambda grid after declared exclusions. It is post-hoc analysis of contaminated data, without a shipping or certified model."
        ],
    }
    if digest(Path(__file__).read_bytes()) != driver_hash:
        raise RuntimeError("forensic driver changed during the run")
    if any(digest((ROOT / path).read_bytes()) != value for path, value in implementation_hashes.items()):
        raise RuntimeError("forensic implementation changed during the run")
    with args.output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("input", "label-summary", "source-archive", "executable", "output"):
        parser.add_argument("--" + option, type=Path, required=True)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
