#!/usr/bin/env python3
"""Build frozen research scalar/SIMD WASM from one shared numeric source tree.

The output prefix is exclusive, sources are copied before compilation, and
completion metadata is published last. This never writes production assets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

RUST_RELEASE = "1.97.1"
RUST_COMMIT = "8bab26f4f68e0e26f0bb7960be334d5b520ea452"
BINARYEN_VERSION = "131"
MEMORY_BYTES = 32 * 1024 * 1024
STACK_BYTES = 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def write(path, data):
    with open(path, "xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": path.name, "bytes": len(data), "sha256": sha(data)}


def output(command):
    return subprocess.run([str(x) for x in command], check=True, capture_output=True, text=True).stdout.strip()


def build(root, destination, rustc, wasm_opt, wasm_dis, *, wide_fused=False):
    root, destination, rustc, wasm_opt, wasm_dis = map(Path, (root, destination, rustc, wasm_opt, wasm_dis))
    root, destination = root.resolve(), destination.resolve()
    rustc, wasm_opt, wasm_dis = rustc.resolve(), wasm_opt.resolve(), wasm_dis.resolve()
    if os.environ.get("RUSTFLAGS") or os.environ.get("CARGO_ENCODED_RUSTFLAGS"):
        raise ValueError("clear ambient Rust flags for an explicit research build")
    compiler = output([rustc, "--version", "--verbose"])
    optimizer = output([wasm_opt, "--version"])
    disassembler = output([wasm_dis, "--version"])
    if f"release: {RUST_RELEASE}" not in compiler or f"commit-hash: {RUST_COMMIT}" not in compiler:
        raise ValueError("the research build requires the repository-pinned Rust release and commit")
    if not re.search(r"\bversion " + BINARYEN_VERSION + r"\b", optimizer + "\n" + disassembler):
        raise ValueError("the research build requires pinned Binaryen 131")
    for text in (optimizer, disassembler):
        if not re.search(r"\bversion " + BINARYEN_VERSION + r"\b", text):
            raise ValueError("optimizer and disassembler must both be Binaryen 131")
    tools = {name: {"path": str(path), "sha256": sha(path.read_bytes())}
             for name, path in (("rustc", rustc), ("wasm-opt", wasm_opt), ("wasm-dis", wasm_dis))}
    baseline_path = root / "tools/sparse_eval/baseline/manifest.json"
    baseline_bytes = baseline_path.read_bytes()
    baseline = json.loads(baseline_bytes)
    if baseline.get("schema") != "chessy.sparse-eval-baseline.v1" or baseline.get("release") != "r84":
        raise ValueError("the declared measured r84 baseline is required")
    sources = {}
    for item in baseline["files"]:
        if item["path"] not in ("engine.rs", "eval.rs", "search.rs"):
            raise ValueError("unexpected baseline source")
        path = baseline_path.parent / item["path"]
        payload = path.read_bytes()
        if len(payload) != item["bytes"] or sha(payload) != item["sha256"]:
            raise ValueError("pinned baseline source identity mismatch")
        sources[str(path.relative_to(root))] = payload
    if len(sources) != 3:
        raise ValueError("incomplete pinned baseline inventory")
    sources[str(baseline_path.relative_to(root))] = baseline_bytes
    for name in ("core.rs", "simd.rs", "wasm.rs", "hce_constants.rs", "wasm_runner.mjs", "build_wasm.py"):
        path = root / "tools/sparse_eval_v2" / name
        sources[str(path.relative_to(root))] = path.read_bytes()
    sources["assets/engine.js"] = (root / "assets/engine.js").read_bytes()
    for required in ("core.rs", "simd.rs", "wasm.rs", "hce_constants.rs", "wasm_runner.mjs"):
        if "tools/sparse_eval_v2/" + required not in sources:
            raise ValueError("missing shared build source: " + required)
    destination.mkdir(parents=False, exist_ok=False)
    snapshot = destination / "source"
    snapshot.mkdir()
    for name, payload in sources.items():
        path = snapshot / name
        path.parent.mkdir(parents=True, exist_ok=True)
        write(path, payload)
        path.chmod(0o444)
    source_hashes = {name: sha(payload) for name, payload in sorted(sources.items())}
    plan = {"schema": "chessy.sparse-v2-wasm-build-plan.v1", "researchOnly": True,
        "productionEligible": False, "sourceHashes": source_hashes, "tools": tools,
        "compiler": compiler, "binaryen": optimizer, "wideFused": wide_fused,
        "initialMemoryBytes": MEMORY_BYTES, "maximumMemoryBytes": MEMORY_BYTES,
        "stackBytes": STACK_BYTES, "targets": ["scalar", "simd128"],
        "allocator": False, "wasi": False, "threads": False,
        "numericSourceSharedAcrossTargets": True, "timingsMeasured": False}
    write(destination / "plan.json", encoded(plan))
    results = []
    common = [str(rustc), "--edition=2021", "--crate-type=cdylib", "--target=wasm32-unknown-unknown",
              "-C", "opt-level=3", "-C", "lto=fat", "-C", "codegen-units=1", "-C", "panic=abort",
              "-C", "link-arg=--no-entry", "-C", "link-arg=--export-memory", "-C", "link-arg=--gc-sections",
              "-C", "link-arg=-z", "-C", f"link-arg=stack-size={STACK_BYTES}",
              "-C", f"link-arg=--initial-memory={MEMORY_BYTES}", "-C", f"link-arg=--max-memory={MEMORY_BYTES}"]
    if wide_fused:
        common += ["--cfg", "v2_wide_fused"]
    for name, enabled in (("scalar", False), ("simd128", True)):
        raw = destination / (name + ".raw.wasm")
        final = destination / (name + ".wasm")
        wat = destination / (name + ".wat")
        flags = ["-C", "target-feature=" + ("+simd128" if enabled else "-simd128")]
        if enabled:
            flags += ["--cfg", "v2_simd"]
        command = common + flags + [str(snapshot / "tools/sparse_eval_v2/wasm.rs"), "-o", str(raw)]
        subprocess.run(command, check=True, capture_output=True)
        optimize = [str(wasm_opt), str(raw), "--enable-mutable-globals", "--enable-sign-ext",
                    "--enable-reference-types", "--enable-multivalue", "--enable-nontrapping-float-to-int",
                    "--enable-bulk-memory", "--enable-simd" if enabled else "--disable-simd",
                    "--disable-relaxed-simd", "-O3", "--converge", "--strip-debug", "--strip-producers",
                    "--strip-toolchain-annotations", "-o", str(final)]
        subprocess.run(optimize, check=True, capture_output=True)
        subprocess.run([str(wasm_dis), str(final), "-o", str(wat)], check=True, capture_output=True)
        disassembly = wat.read_text()
        operations = {op: len(re.findall(r"\(" + re.escape(op) + r"\b", disassembly))
                      for op in ("v128.load", "i8x16.eq", "i8x16.bitmask", "i8x16.ne", "v128.const")}
        any_simd = bool(re.search(r"\b(?:v128|[iuf](?:8x16|16x8|32x4|64x2))\.", disassembly))
        if enabled and operations["i8x16.bitmask"] == 0:
            raise ValueError("explicit SIMD build has no emitted occupancy bitmask")
        if not enabled and any_simd:
            raise ValueError("scalar build contains SIMD operations")
        artifacts = {}
        for key, path in (("raw", raw), ("module", final), ("disassembly", wat)):
            payload = path.read_bytes()
            artifacts[key] = {"path": path.name, "bytes": len(payload), "sha256": sha(payload)}
            path.chmod(0o444)
        results.append({"target": name, "compileCommand": command, "optimizeCommand": optimize,
                        "artifacts": artifacts, "emittedSimdOperations": operations,
                        "containsSimd": any_simd, "explicitOccupancySimd": enabled})
    for name, payload in sources.items():
        if (root / name).read_bytes() != payload:
            raise ValueError("source changed during build; completion is not published: " + name)
    for name, item in tools.items():
        if sha(Path(item["path"]).read_bytes()) != item["sha256"]:
            raise ValueError("build tool changed during compilation: " + name)
    result = {**plan, "schema": "chessy.sparse-v2-wasm-build.v1", "status": "complete-research-only",
              "builds": results, "sourceSnapshot": "source", "sourcesUnchangedAtCompletion": True}
    write(destination / "results.json", encoded(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rustc", type=Path, required=True)
    parser.add_argument("--wasm-opt", type=Path, required=True)
    parser.add_argument("--wasm-dis", type=Path, required=True)
    parser.add_argument("--wide-fused", action="store_true")
    args = parser.parse_args()
    result = build(args.root, args.output, args.rustc, args.wasm_opt, args.wasm_dis, wide_fused=args.wide_fused)
    print(json.dumps({"status": result["status"], "output": str(args.output),
                      "modules": [b["artifacts"]["module"] for b in result["builds"]]}, sort_keys=True))
