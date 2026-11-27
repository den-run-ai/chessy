#!/usr/bin/env python3
"""Diagnostic D2: build a shallow-search-distillation dataset.

Takes the first `--max-train` training rows (dataset order) plus every
validation and test row of a prototype dataset, labels them with a WASM
module's own quiescent search at a fixed node budget through
tools/nnue/relabel-search.js, drops terminal roots, and writes a new dataset
directory whose manifest records the teacher module and budget.
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--wasm", default=str(ROOT / "assets/chessy-ai-fast.wasm"))
    parser.add_argument("--nodes", type=int, default=2000)
    parser.add_argument("--max-train", type=int, default=4_000_000)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--chunk", type=int, default=200_000)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.dataset)
    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    started = time.time()
    fens = source.joinpath("fens.txt").read_text().splitlines()
    data = np.load(source / "dataset.npz")
    split = data["split"]
    train_idx = np.flatnonzero(split == 0)[: args.max_train]
    keep_idx = np.sort(np.concatenate((train_idx, np.flatnonzero(split != 0))))
    print(json.dumps({"stage": "select", "rows": int(len(keep_idx)), "train": int(len(train_idx))}), flush=True)

    labels = np.empty(len(keep_idx), dtype=np.int64)
    terminal = np.zeros(len(keep_idx), dtype=bool)
    for start in range(0, len(keep_idx), args.chunk):
        block = keep_idx[start:start + args.chunk]
        text = "\n".join(fens[i] for i in block) + "\n"
        out = subprocess.run(["node", str(ROOT / "tools/nnue/relabel-search.js"), "--wasm", args.wasm, "--nodes", str(args.nodes),
                              "--workers", str(args.workers)], input=text, capture_output=True, text=True, check=True).stdout.split()
        assert len(out) == len(block)
        for offset, value in enumerate(out):
            if value == "x":
                terminal[start + offset] = True
            else:
                labels[start + offset] = int(value)
        print(json.dumps({"stage": "progress", "rows": start + len(block), "of": len(keep_idx), "elapsedS": round(time.time() - started, 1)}), flush=True)

    final_idx = keep_idx[~terminal]
    output.mkdir(parents=True)
    arrays = {key: data[key][final_idx] for key in data.files}
    arrays["cp"] = labels[~terminal].astype(np.int16)
    arrays["mate"] = np.zeros(len(final_idx), dtype=np.int8)
    np.savez(output / "dataset.npz", **arrays)
    (output / "fens.txt").write_text("\n".join(fens[i] for i in final_idx) + "\n")
    manifest = json.loads((source / "manifest.json").read_text())
    new_split = arrays["split"]
    manifest["relabelled"] = {"kind": "shipped-module-quiescent-search", "nodes": args.nodes, "module": str(Path(args.wasm).resolve()),
                              "moduleSha256": sha256_file(Path(args.wasm)), "sourceDataset": str(source),
                              "sourceManifestSha256": sha256_file(source / "manifest.json"), "maxTrain": args.max_train,
                              "terminalDropped": int(terminal.sum())}
    manifest["splits"] = {"train": int((new_split == 0).sum()), "validation": int((new_split == 1).sum()), "test": int((new_split == 2).sum())}
    manifest["mateFraction"] = 0.0
    cp = arrays["cp"]
    manifest["cpStats"] = {"mean": float(cp.mean()), "std": float(cp.std()), "absMedian": float(np.median(np.abs(cp)))}
    manifest["outputs"] = {"dataset.npz": sha256_file(output / "dataset.npz"), "fens.txt": sha256_file(output / "fens.txt")}
    manifest["relabelScript"] = {"path": "tools/nnue/relabel-search.py", "sha256": sha256_file(Path(__file__))}
    manifest["elapsedSeconds"] = round(time.time() - started, 1)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"stage": "done", "splits": manifest["splits"], "terminalDropped": int(terminal.sum()),
                      "cpStats": manifest["cpStats"], "elapsedS": manifest["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
