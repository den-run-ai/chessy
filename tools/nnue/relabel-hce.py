#!/usr/bin/env python3
"""Diagnostic D1: relabel a prototype dataset with the shipped HCE static eval.

Keeps every feature row, split and phase of the input dataset and replaces
the White-POV target with `evaluate_loaded` from the given WASM module
(tools/nnue/hce-eval.js), clamped like the original labels. Mate flags are
cleared. The output directory carries a manifest that records the source
dataset and module identity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MATE_CP = 3000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="input dataset directory")
    parser.add_argument("--wasm", default=str(ROOT / "assets/chessy-ai-fast.wasm"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--chunk", type=int, default=500_000)
    args = parser.parse_args()

    source = Path(args.dataset)
    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    started = time.time()
    fens = source.joinpath("fens.txt").read_text().splitlines()
    data = np.load(source / "dataset.npz")
    assert len(fens) == len(data["stm"])
    labels = np.empty(len(fens), dtype=np.int64)
    for start in range(0, len(fens), args.chunk):
        block = fens[start:start + args.chunk]
        text = "\n".join(block) + "\n"
        out = subprocess.run(["node", str(ROOT / "tools/nnue/hce-eval.js"), "--wasm", args.wasm], input=text,
                             capture_output=True, text=True, check=True).stdout.split()
        assert len(out) == len(block)
        labels[start:start + len(block)] = [int(v) for v in out]
        print(json.dumps({"stage": "progress", "rows": start + len(block), "of": len(fens), "elapsedS": round(time.time() - started, 1)}), flush=True)
    cp = np.clip(labels, -MATE_CP, MATE_CP).astype(np.int16)

    output.mkdir(parents=True)
    arrays = {key: data[key] for key in data.files}
    arrays["cp"] = cp
    arrays["mate"] = np.zeros(len(cp), dtype=np.int8)
    np.savez(output / "dataset.npz", **arrays)
    (output / "fens.txt").write_bytes((source / "fens.txt").read_bytes())
    manifest = json.loads((source / "manifest.json").read_text())
    manifest["relabelled"] = {"kind": "shipped-hce-static-eval", "module": str(Path(args.wasm).resolve()),
                              "moduleSha256": sha256_file(Path(args.wasm)), "sourceDataset": str(source),
                              "sourceManifestSha256": sha256_file(source / "manifest.json"), "mateCp": MATE_CP}
    manifest["mateFraction"] = 0.0
    manifest["cpStats"] = {"mean": float(cp.mean()), "std": float(cp.std()), "absMedian": float(np.median(np.abs(cp)))}
    manifest["outputs"] = {"dataset.npz": sha256_file(output / "dataset.npz"), "fens.txt": sha256_file(output / "fens.txt")}
    manifest["relabelScript"] = {"path": "tools/nnue/relabel-hce.py", "sha256": sha256_file(Path(__file__))}
    manifest["elapsedSeconds"] = round(time.time() - started, 1)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"stage": "done", "rows": len(cp), "cpStats": manifest["cpStats"], "elapsedS": manifest["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
