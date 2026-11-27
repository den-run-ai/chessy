#!/usr/bin/env python3
"""Apply an additional quarantine to an already built prototype dataset.

Equivalent to passing `--extra-quarantine` to build-dataset.py (row selection
is independent per row), but avoids re-reading the parquet shards: every
retained FEN is re-keyed with the same natural-select key functions and rows
whose exact/model-symmetry cluster or structural family falls inside the
extra quarantine set are dropped. Writes a new dataset directory with an
updated manifest that records the filter provenance.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import multiprocessing
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, relative: str):
    path = ROOT / relative
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


_NS = None
_CLUSTERS: set = set()
_FAMILIES: set = set()


def _init(clusters, families):
    global _NS, _CLUSTERS, _FAMILIES
    _NS = load_module("natural_select", "test/training/natural-select.py")
    _CLUSTERS = set(clusters)
    _FAMILIES = set(families)


def _keep_chunk(args):
    start, fens = args
    keep = np.ones(len(fens), dtype=bool)
    reasons = {"cluster": 0, "family": 0}
    for index, fen in enumerate(fens):
        keys = _NS.key_data(fen)
        if keys["cluster"] in _CLUSTERS:
            keep[index] = False
            reasons["cluster"] += 1
        elif keys["positionFamily"] in _FAMILIES:
            keep[index] = False
            reasons["family"] += 1
    return start, keep, reasons


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="input dataset directory")
    parser.add_argument("--extra-quarantine", action="append", required=True, help="JSON with quarantineFens")
    parser.add_argument("--output", required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    source = Path(args.dataset)
    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    started = time.time()
    ns = load_module("natural_select", "test/training/natural-select.py")
    clusters, families = set(), set()
    extras = []
    for extra in args.extra_quarantine:
        path = Path(extra)
        payload = json.loads(path.read_text())
        fens = payload["quarantineFens"] if isinstance(payload, dict) else payload
        for fen in fens:
            keys = ns.key_data(fen)
            clusters.add(keys["cluster"])
            families.add(keys["positionFamily"])
        extras.append({"path": str(path), "sha256": sha256_file(path), "fens": len(fens)})
    print(json.dumps({"stage": "extra-quarantine", "clusters": len(clusters), "families": len(families)}), flush=True)

    fens = source.joinpath("fens.txt").read_text().splitlines()
    data = np.load(source / "dataset.npz")
    assert len(fens) == len(data["stm"])
    chunk = 200_000
    jobs = [(start, fens[start:start + chunk]) for start in range(0, len(fens), chunk)]
    keep = np.ones(len(fens), dtype=bool)
    reasons = {"cluster": 0, "family": 0}
    with multiprocessing.Pool(args.workers, initializer=_init, initargs=(clusters, families)) as pool:
        done = 0
        for start, chunk_keep, chunk_reasons in pool.imap_unordered(_keep_chunk, jobs):
            keep[start:start + len(chunk_keep)] = chunk_keep
            for key, value in chunk_reasons.items():
                reasons[key] += value
            done += 1
            if done % 10 == 0:
                print(json.dumps({"stage": "progress", "chunks": done, "of": len(jobs), "elapsedS": round(time.time() - started, 1)}), flush=True)

    output.mkdir(parents=True)
    arrays = {key: data[key][keep] for key in data.files}
    np.savez(output / "dataset.npz", **arrays)
    kept_fens = [fen for fen, flag in zip(fens, keep) if flag]
    (output / "fens.txt").write_text("\n".join(kept_fens) + "\n")
    manifest = json.loads((source / "manifest.json").read_text())
    split = arrays["split"]
    phase = arrays["phase"]

    def bucket(values):
        return {"opening": int((values >= 18).sum()), "middlegame": int(((values >= 7) & (values < 18)).sum()),
                "endgame": int((values < 7).sum())}

    manifest["filteredFrom"] = {"dataset": str(source), "manifestSha256": sha256_file(source / "manifest.json"),
                                "datasetNpzSha256": manifest["outputs"]["dataset.npz"], "extraQuarantine": extras,
                                "dropped": reasons, "keptRows": int(keep.sum()), "inputRows": int(len(keep))}
    manifest["counts"]["quarantinedDevBankCluster"] = reasons["cluster"]
    manifest["counts"]["quarantinedDevBankFamily"] = reasons["family"]
    manifest["counts"]["kept"] = int(keep.sum())
    manifest["splits"] = {"train": int((split == 0).sum()), "validation": int((split == 1).sum()), "test": int((split == 2).sum())}
    manifest["phaseBuckets"] = {"train": bucket(phase[split == 0]), "validation": bucket(phase[split == 1]), "test": bucket(phase[split == 2])}
    manifest["stmWhiteFraction"] = float((arrays["stm"] == 0).mean())
    manifest["mateFraction"] = float((arrays["mate"] != 0).mean())
    cp = arrays["cp"]
    manifest["cpStats"] = {"mean": float(cp.mean()), "std": float(cp.std()), "absMedian": float(np.median(np.abs(cp)))}
    manifest["outputs"] = {"dataset.npz": sha256_file(output / "dataset.npz"), "fens.txt": sha256_file(output / "fens.txt")}
    manifest["filterScript"] = {"path": "tools/nnue/filter-dataset.py", "sha256": sha256_file(Path(__file__))}
    manifest["elapsedSeconds"] = round(time.time() - started, 1)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"stage": "done", "dropped": reasons, "splits": manifest["splits"], "elapsedS": manifest["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
