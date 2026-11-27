#!/usr/bin/env python3
"""Freeze sources, build pinned portable native scalar/SIMD binaries, receipt last."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ["tools/sparse_eval_v2/" + name for name in
           ("runtime.rs", "core.rs", "simd.rs", "hce_constants.rs", "generate_hce_constants.py", "build_native.py")]
SOURCES += ["tools/sparse_eval/baseline/" + name for name in ("engine.rs", "eval.rs", "search.rs", "manifest.json")]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rustc", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wide-fused", action="store_true")
    args = parser.parse_args()
    compiler = args.rustc.resolve()
    version = subprocess.check_output([str(compiler), "--version", "--verbose"], text=True)
    if not version.startswith("rustc 1.97.1 ") or "commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452" not in version:
        raise ValueError("pinned Rust1.97.1 compiler required")
    compiler_hash = sha(compiler.read_bytes())
    retained = {name: (ROOT / name).read_bytes() for name in SOURCES}
    baseline_manifest = json.loads(retained["tools/sparse_eval/baseline/manifest.json"])
    for row in baseline_manifest["files"]:
        if sha(retained["tools/sparse_eval/baseline/" + row["path"]]) != row["sha256"]:
            raise ValueError("pinned baseline source changed")
    args.output.mkdir(parents=True, exist_ok=False)
    source_root = args.output / "source"
    for name, raw in retained.items():
        path = source_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        path.chmod(0o444)
    builds = {}
    for name, extra in (("scalar", []), ("simd", ["--cfg", "v2_simd"])):
        binary = args.output / ("sparse-v2-" + name)
        options = ["--edition=2021", "-C", "opt-level=3", "-C", "lto=fat", "-C", "codegen-units=1", "-C", "panic=abort"]
        if args.wide_fused:
            options += ["--cfg", "v2_wide_fused"]
        command = [str(compiler), *options, *extra, "tools/sparse_eval_v2/runtime.rs", "-o", str(binary.resolve())]
        subprocess.run(command, cwd=source_root, check=True, capture_output=True)
        binary.chmod(0o555)
        raw = binary.read_bytes()
        builds[name] = {"path": str(binary.resolve()), "sha256": sha(raw), "bytes": len(raw), "command": command,
                        "metadata": json.loads(subprocess.check_output([str(binary), "metadata"]))}
    if sha(compiler.read_bytes()) != compiler_hash:
        raise ValueError("compiler changed while building")
    for name, raw in retained.items():
        if (source_root / name).read_bytes() != raw:
            raise ValueError("retained source snapshot changed while building")
    receipt = {"schema": "chessy.sparse-v2-native-build.v1", "researchOnly": True,
               "compilerVersion": version, "compilerSha256": compiler_hash,
               "sourceHashes": {name: sha(raw) for name, raw in retained.items()}, "sourceSnapshot": str(source_root.resolve()),
               "wideFused": args.wide_fused, "target": "portable-native-x86_64", "native": builds}
    path = args.output / "build.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    path.chmod(0o444)
    print(json.dumps({"receipt": str(path.resolve()), "sha256": sha(path.read_bytes()), "native": builds}, indent=2))


if __name__ == "__main__":
    main()
