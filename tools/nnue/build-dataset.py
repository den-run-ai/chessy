#!/usr/bin/env python3
"""Build the NNUE prototype training set from the CC0 Lichess evaluations DB.

Input: one or more parquet shards of the official Hugging Face mirror
`Lichess/chess-position-evaluations` (denormalised: one row per PV line per
evaluation session; rows for one FEN are contiguous, the first row of a
session is the best line). Output: packed NumPy arrays plus a manifest.

Rules (all frozen here, before any training):
  * one record per FEN: the deepest evaluation session (ties: most knodes),
    best line only;
  * depth >= MIN_DEPTH;
  * quiet: side to move not in check, best move is neither a capture,
    en passant, nor a promotion, and the best move is legal;
  * mate scores map to +/-MATE_CP (White POV); cp is clamped to +/-MATE_CP;
  * quarantine: any position whose exact/model-symmetry cluster or static
    pawn/king/material family appears in the repository's frozen quarantine
    inputs (scorecard corpus + puzzle sources, both incident fixtures, the
    100-opening v1 bank and the 400-endpoint v2 manifest, every prefix
    position) is dropped, using the same key functions as the natural pilot;
  * split by SHA-256 of the four-field FEN: train / validation / test. The
    Lichess export has no game lineage, so transpositions of one game can
    straddle splits; validation loss is therefore optimistic and playing
    strength is the decisive measurement.

The raw data stays outside Git; only this script and the manifest are
committed. Labels are Lichess exploration evaluations (mixed Stockfish
versions/depths), not the repository's pinned certification teacher.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import multiprocessing
import os
import sys
import time
from pathlib import Path

import chess
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
MIN_DEPTH = 15
MATE_CP = 3000
MAX_PIECES = 32
PAD = 768
PIECES = "PNBRQKpnbrqk"
SPLIT_CELLS = 1000
VALIDATION_CELLS = range(950, 975)
TEST_CELLS = range(975, 1000)
SCHEMA = "chessy.nnue-proto-dataset.v1"


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


def features_white(board_field: str) -> list[int]:
    """White-perspective 768 indices, Chessy square 0 = a8 (matches h4_model)."""
    result = []
    for rank, cells in enumerate(board_field.split("/")):
        file = 0
        for char in cells:
            if char.isdigit():
                file += int(char)
            else:
                result.append(PIECES.index(char) * 64 + rank * 8 + file)
                file += 1
    return result


def split_cell(fen4: str) -> int:
    return int(hashlib.sha256(fen4.encode()).hexdigest()[:12], 16) % SPLIT_CELLS


def process_row_group(args):
    shard_path, group_index, boundary_path = args
    ns = load_module("natural_select", "test/training/natural-select.py")
    boundary = json.loads(Path(boundary_path).read_text())
    clusters = set(boundary["clusters"])
    families = set(boundary["families"])
    table = pq.ParquetFile(shard_path).read_row_group(group_index)
    columns = table.to_pydict()
    fens = columns["fen"]
    lines = columns["line"]
    depths = columns["depth"]
    knodes = columns["knodes"]
    cps = columns["cp"]
    mates = columns["mate"]
    total = len(fens)

    stats = {
        "rows": total,
        "uniqueFens": 0,
        "shallow": 0,
        "noLine": 0,
        "inCheck": 0,
        "notQuiet": 0,
        "illegalBest": 0,
        "badPosition": 0,
        "quarantinedCluster": 0,
        "quarantinedFamily": 0,
        "mate": 0,
        "kept": 0,
    }
    feats, stms, cp_out, mate_out, depth_out, knode_out, phase_out, cell_out, fen_out = (
        [], [], [], [], [], [], [], [], [])

    index = 0
    while index < total:
        fen = fens[index]
        # Rows for one FEN are contiguous; pick the deepest session, best line.
        best = index
        cursor = index
        while cursor < total and fens[cursor] == fen:
            if (depths[cursor], knodes[cursor]) > (depths[best], knodes[best]):
                best = cursor
            # Within one session the first row is the best PV; skip the rest.
            cursor += 1
        index = cursor
        stats["uniqueFens"] += 1
        if depths[best] < MIN_DEPTH:
            stats["shallow"] += 1
            continue
        line = lines[best]
        if not line:
            stats["noLine"] += 1
            continue
        fields = fen.split()
        if len(fields) != 4:
            stats["badPosition"] += 1
            continue
        try:
            board = chess.Board(fen + " 0 1")
        except ValueError:
            stats["badPosition"] += 1
            continue
        if not board.is_valid():
            stats["badPosition"] += 1
            continue
        if board.is_check():
            stats["inCheck"] += 1
            continue
        try:
            move = chess.Move.from_uci(line.split()[0])
        except ValueError:
            stats["illegalBest"] += 1
            continue
        if move not in board.legal_moves:
            stats["illegalBest"] += 1
            continue
        if board.is_capture(move) or move.promotion is not None:
            stats["notQuiet"] += 1
            continue
        keys = ns.key_data(fen)
        if keys["cluster"] in clusters:
            stats["quarantinedCluster"] += 1
            continue
        if keys["positionFamily"] in families:
            stats["quarantinedFamily"] += 1
            continue
        mate = mates[best]
        if mate is not None:
            stats["mate"] += 1
            cp = MATE_CP if mate > 0 else -MATE_CP
            mate_flag = 1 if mate > 0 else -1
        else:
            cp = max(-MATE_CP, min(MATE_CP, int(cps[best])))
            mate_flag = 0
        indices = features_white(fields[0])
        if len(indices) > MAX_PIECES:
            stats["badPosition"] += 1
            continue
        padded = indices + [PAD] * (MAX_PIECES - len(indices))
        feats.append(padded)
        stms.append(0 if fields[1] == "w" else 1)
        cp_out.append(cp)
        mate_out.append(mate_flag)
        depth_out.append(int(depths[best]))
        knode_out.append(int(knodes[best]))
        phase = min(24, sum({"n": 1, "b": 1, "r": 2, "q": 4}.get(c.lower(), 0) for c in fields[0]))
        phase_out.append(phase)
        cell_out.append(split_cell(fen))
        fen_out.append(fen)
        stats["kept"] += 1

    return (
        group_index,
        stats,
        np.asarray(feats, dtype=np.uint16).reshape(-1, MAX_PIECES),
        np.asarray(stms, dtype=np.uint8),
        np.asarray(cp_out, dtype=np.int16),
        np.asarray(mate_out, dtype=np.int8),
        np.asarray(depth_out, dtype=np.uint8),
        np.asarray(knode_out, dtype=np.int32),
        np.asarray(phase_out, dtype=np.uint8),
        np.asarray(cell_out, dtype=np.uint16),
        fen_out,
    )


def build_boundary(output: Path, extra_files: list[str]) -> dict:
    ns = load_module("natural_select", "test/training/natural-select.py")
    rules = json.loads((ROOT / "eval/training/natural-pilot-v1.json").read_text())
    boundary = ns.quarantine(ROOT, rules)
    manifest = dict(boundary["manifest"])
    manifest["extraQuarantine"] = []
    for extra in extra_files:
        path = Path(extra)
        payload = json.loads(path.read_text())
        fens = payload["quarantineFens"] if isinstance(payload, dict) else payload
        added_clusters = added_families = 0
        for fen in fens:
            keys = ns.key_data(fen)
            added_clusters += keys["cluster"] not in boundary["clusters"]
            added_families += keys["positionFamily"] not in boundary["families"]
            boundary["clusters"].add(keys["cluster"])
            boundary["families"].add(keys["positionFamily"])
        manifest["extraQuarantine"].append({"path": str(path), "sha256": sha256_file(path), "fens": len(fens),
                                            "newClusters": added_clusters, "newFamilies": added_families})
    manifest["clusters"] = len(boundary["clusters"])
    manifest["families"] = len(boundary["families"])
    payload = {
        "clusters": sorted(boundary["clusters"]),
        "families": sorted(boundary["families"]),
        "manifest": manifest,
    }
    output.write_text(json.dumps(payload))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", action="append", required=True, help="parquet shard path")
    parser.add_argument("--output", required=True, help="output directory (must not exist)")
    parser.add_argument("--workers", type=int, default=max(1, os.cpu_count() or 1))
    parser.add_argument("--max-row-groups", type=int, default=0, help="debug: limit groups per shard")
    parser.add_argument("--extra-quarantine", action="append", default=[],
                        help="JSON with quarantineFens (e.g. the dev opening bank); clusters and families are added to the boundary")
    args = parser.parse_args()

    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    output.mkdir(parents=True)
    started = time.time()

    shards = []
    jobs = []
    boundary_path = output / "quarantine-boundary.json"
    boundary_manifest = build_boundary(boundary_path, args.extra_quarantine)
    print(json.dumps({"stage": "quarantine", **{k: v for k, v in boundary_manifest.items() if k != "sourceFiles"}}), flush=True)
    for shard in args.shard:
        path = Path(shard)
        meta = pq.ParquetFile(path).metadata
        shards.append({"path": str(path), "bytes": path.stat().st_size, "sha256": sha256_file(path),
                       "rows": meta.num_rows, "rowGroups": meta.num_row_groups})
        groups = meta.num_row_groups if not args.max_row_groups else min(meta.num_row_groups, args.max_row_groups)
        jobs.extend((str(path), g, str(boundary_path)) for g in range(groups))
    print(json.dumps({"stage": "shards", "shards": shards, "jobs": len(jobs)}), flush=True)

    parts = []
    totals: dict[str, int] = {}
    with multiprocessing.Pool(args.workers) as pool:
        for result in pool.imap_unordered(process_row_group, jobs):
            group_index, stats = result[0], result[1]
            for key, value in stats.items():
                totals[key] = totals.get(key, 0) + value
            parts.append(result)
            print(json.dumps({"stage": "group", "group": group_index, "kept": stats["kept"],
                              "elapsedS": round(time.time() - started, 1)}), flush=True)
    parts.sort(key=lambda item: item[0])

    feats = np.concatenate([p[2] for p in parts])
    stm = np.concatenate([p[3] for p in parts])
    cp = np.concatenate([p[4] for p in parts])
    mate = np.concatenate([p[5] for p in parts])
    depth = np.concatenate([p[6] for p in parts])
    knodes = np.concatenate([p[7] for p in parts])
    phase = np.concatenate([p[8] for p in parts])
    cell = np.concatenate([p[9] for p in parts])
    fens = [fen for p in parts for fen in p[10]]

    split = np.zeros(len(cell), dtype=np.uint8)  # 0 train, 1 validation, 2 test
    split[np.isin(cell, np.array(list(VALIDATION_CELLS)))] = 1
    split[np.isin(cell, np.array(list(TEST_CELLS)))] = 2

    np.savez(output / "dataset.npz", feats=feats, stm=stm, cp=cp, mate=mate, depth=depth,
             knodes=knodes, phase=phase, split=split)
    with (output / "fens.txt").open("w") as stream:
        stream.write("\n".join(fens) + "\n")

    def bucket(values):
        return {"opening": int((values >= 18).sum()), "middlegame": int(((values >= 7) & (values < 18)).sum()),
                "endgame": int((values < 7).sum())}

    manifest = {
        "schema": SCHEMA,
        "source": {
            "dataset": "Lichess/chess-position-evaluations (Hugging Face mirror of https://database.lichess.org/#evals)",
            "license": "CC0-1.0",
            "shards": shards,
            "labelKind": "exploration evaluations from the Lichess analysis board (mixed Stockfish builds/depths); not the pinned certification teacher",
        },
        "rules": {"minDepth": MIN_DEPTH, "mateCp": MATE_CP, "quiet": "not in check; best move legal, non-capture, non-promotion",
                  "sessionChoice": "deepest depth, then most knodes; first PV row",
                  "quarantine": "natural-pilot-v1 requiredFiles via natural-select.quarantine (cluster + structural family)",
                  "split": {"cells": SPLIT_CELLS, "validation": [VALIDATION_CELLS.start, VALIDATION_CELLS.stop - 1],
                            "test": [TEST_CELLS.start, TEST_CELLS.stop - 1], "key": "sha256(fen4)[:12] mod cells"},
                  "lineage": "unavailable (FEN-only export); transpositions may straddle splits"},
        "quarantine": {k: v for k, v in boundary_manifest.items()},
        "counts": totals,
        "splits": {"train": int((split == 0).sum()), "validation": int((split == 1).sum()), "test": int((split == 2).sum())},
        "phaseBuckets": {"train": bucket(phase[split == 0]), "validation": bucket(phase[split == 1]), "test": bucket(phase[split == 2])},
        "stmWhiteFraction": float((stm == 0).mean()) if len(stm) else None,
        "mateFraction": float((mate != 0).mean()) if len(mate) else None,
        "cpStats": {"mean": float(cp.mean()), "std": float(cp.std()), "absMedian": float(np.median(np.abs(cp)))} if len(cp) else None,
        "outputs": {"dataset.npz": sha256_file(output / "dataset.npz"), "fens.txt": sha256_file(output / "fens.txt"),
                    "quarantine-boundary.json": sha256_file(boundary_path)},
        "elapsedSeconds": round(time.time() - started, 1),
        "script": {"path": "tools/nnue/build-dataset.py", "sha256": sha256_file(Path(__file__))},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"stage": "done", "splits": manifest["splits"], "counts": totals,
                      "elapsedS": manifest["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
