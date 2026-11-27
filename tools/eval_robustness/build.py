#!/usr/bin/env python3
"""Build the pinned no-pawn evaluator with an integer residual strength (n/16)."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from eval_pipeline import prepare

BASE = "2cf89b6e2ff7c7f2f11c2bf39e4c9b7bc99d28e0"
STUDY = ROOT / "eval/eval-robustness-v1"
REFERENCE = ROOT / "eval/eval-production-v1/REFIT-COST-REGISTRATION.json"


def build(output, numerator, rustc, cargo, wasm_opt):
    registration = json.loads(REFERENCE.read_bytes())
    weights = (STUDY / "build-no-pawn.i16le").read_bytes()
    binding = registration["modelBindings"]["no-pawn-simd"]["model"]
    if prepare.sha(weights) != binding["sha256"]:
        raise ValueError("no-pawn weights differ from the registered refit")

    base = {name: prepare.git(ROOT, "show", BASE + ":experiments/wasm/" + name)
            for name in prepare.PRODUCTION}
    implementation = {name: (ROOT / "tools/eval_pipeline" / name).read_bytes()
                      for name in ("core.rs", "simd.rs", "hce_constants.rs")}
    sources = prepare.variant_sources(base, implementation, prepare.render_model(weights),
                                      "sparse-simd", memory_bytes=prepare.MEMORY_BYTES + 65536,
                                      family_cfg="eval_pipeline_no_pawn")
    # Check the entire generated crate against the earlier unscaled experiment.
    for name, source in sources.items():
        expected = registration["files"]["provenance/no-pawn/variants/sparse-simd/" + name]
        if prepare.identity(source) != expected:
            raise ValueError("unscaled source differs from the registered experiment: " + name)
    core_path = "src/eval_pipeline/core.rs"
    if numerator != 16:
        sources[core_path] = prepare.replace_once(
            sources[core_path], b"        baseline + residual\n",
            f"        baseline + residual * {numerator} / 16\n".encode(), "integer residual")

    output.mkdir(parents=True, exist_ok=False)
    crate = output / "crate"
    for name, source in sources.items():
        prepare.write_once(crate / name, source, executable=name == "build.sh")
    environment = prepare.clean_environment(output)
    environment.update(CHESSY_RUSTC_BIN=str(rustc.resolve()), CHESSY_CARGO_BIN=str(cargo.resolve()),
                       CHESSY_WASM_OPT_BIN=str(wasm_opt.resolve()), BINARYEN_CORES="1",
                       CHESSY_CARGO_TARGET_DIR=str(output / "target"))
    with (output / "build.log").open("x") as log:
        subprocess.run(["sh", str(crate / "build.sh")], env=environment, check=True,
                       stdout=log, stderr=subprocess.STDOUT)
    raw = (crate / "dist/chessy-ai-fast.wasm").read_bytes()
    if numerator == 16 and prepare.identity(raw) != registration["files"]["modules/no-pawn-simd.wasm"]:
        raise ValueError("unscaled build differs from the registered module")
    prepare.write_once(output / "candidate.wasm", raw)
    receipt = {
        "baseCommit": BASE, "model": binding, "numerator": numerator, "denominator": 16,
        "rounding": "toward zero after the original integer residual interpolation",
        "candidate": prepare.identity(raw), "abiVersion": 2,
        "matchedControl": registration["files"]["modules/hce-reference.wasm"],
        "unscaledCandidate": registration["files"]["modules/no-pawn-simd.wasm"],
        "modifiedCore": prepare.identity(sources[core_path]),
        "tools": {name: prepare.identity(tool.read_bytes()) for name, tool in
                  (("rustc", rustc), ("cargo", cargo), ("wasm-opt", wasm_opt))},
    }
    prepare.write_once(output / "build.json", prepare.canonical(receipt))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--numerator", type=int, choices=range(17), required=True)
    for tool in ("rustc", "cargo", "wasm-opt"):
        parser.add_argument("--" + tool, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.output.resolve(), args.numerator, args.rustc, args.cargo, args.wasm_opt)))
