#!/usr/bin/env python3
"""Offline teacher-loss comparison: shipped HCE vs exported prototype nets.

For each evaluator the White-POV score is turned into a side-to-move expected
score with sigmoid(k * cp / 400) and compared with the Lichess target by mean
squared error on the dataset's validation and test rows. The scale k is fitted
on the validation rows for every evaluator (one free parameter each, so the
HCE's different centipawn scale does not penalise it); the nets are also
reported at their native k = 1.

Usage:
  python3 tools/nnue/compare-offline.py --dataset /data/ds/dataset.npz \
      --base assets/chessy-ai-fast.wasm --net /data/nets/h16.json --net ... \
      --out /data/nets/offline-comparison.json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load_train_module():
    spec = importlib.util.spec_from_file_location("nnue_train", ROOT / "tools/nnue/train.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["nnue_train"] = module
    spec.loader.exec_module(module)
    return module


def read_bin(path: Path) -> dict:
    blob = path.read_bytes()
    assert blob[:4] == b"CNNU"
    hidden = int.from_bytes(blob[8:12], "little")
    offset = 16
    w1 = np.frombuffer(blob, dtype="<i2", count=768 * hidden, offset=offset).reshape(768, hidden)
    offset += 768 * hidden * 2
    b1 = np.frombuffer(blob, dtype="<i2", count=hidden, offset=offset)
    offset += hidden * 2
    w2 = np.frombuffer(blob, dtype="<i2", count=2 * hidden, offset=offset)
    offset += 2 * hidden * 2
    b2 = int.from_bytes(blob[offset:offset + 4], "little", signed=True)
    return {"w1": w1, "b1": b1, "w2": w2, "b2": b2, "hidden": hidden}


def fit_scale(cp_pred_white: np.ndarray, target_stm: np.ndarray, stm: np.ndarray) -> float:
    sign = np.where(stm == 0, 1.0, -1.0)
    x = cp_pred_white * sign / 400.0
    best_k, best_loss = 1.0, float("inf")
    for k in np.linspace(0.2, 3.0, 141):
        loss = float(((1 / (1 + np.exp(-k * x)) - target_stm) ** 2).mean())
        if loss < best_loss:
            best_k, best_loss = float(k), loss
    return best_k


def loss_at(cp_pred_white, target_stm, stm, k):
    sign = np.where(stm == 0, 1.0, -1.0)
    return float(((1 / (1 + np.exp(-k * cp_pred_white * sign / 400.0)) - target_stm) ** 2).mean())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--base", default=str(ROOT / "assets/chessy-ai-fast.wasm"))
    parser.add_argument("--net", action="append", default=[], help="model card json from train.py")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    train = load_train_module()
    data = np.load(args.dataset)
    fens = (Path(args.dataset).parent / "fens.txt").read_text().splitlines()
    split, feats, stm, cp, mate, phase = (data[k] for k in ("split", "feats", "stm", "cp", "mate", "phase"))
    lut = train.black_lut()
    subsets = {"validation": np.flatnonzero(split == 1), "test": np.flatnonzero(split == 2)}
    sign = np.where(stm == 0, 1.0, -1.0)
    target = 1 / (1 + np.exp(-(cp * sign) / 400.0))

    # HCE scores via the production loader.
    hce = {}
    for name, idx in subsets.items():
        text = "\n".join(fens[i] for i in idx) + "\n"
        out = subprocess.run(["node", str(ROOT / "tools/nnue/hce-eval.js"), "--wasm", args.base], input=text,
                             capture_output=True, text=True, check=True).stdout
        hce[name] = np.array([int(v) for v in out.split()], dtype=np.float64)
        assert len(hce[name]) == len(idx)

    report = {"schema": "chessy.nnue-proto-offline-comparison.v1", "dataset": args.dataset, "evaluators": {}}
    k_hce = fit_scale(hce["validation"], target[subsets["validation"]], stm[subsets["validation"]])
    entry = {"kind": "shipped-hce", "module": args.base, "fittedScale": k_hce}
    for name, idx in subsets.items():
        entry[name] = {"mseAtFittedScale": loss_at(hce[name], target[idx], stm[idx], k_hce),
                       "mseAtScale1": loss_at(hce[name], target[idx], stm[idx], 1.0),
                       "byPhase": {}}
        for phase_name, mask in (("opening", phase[idx] >= 18), ("middlegame", (phase[idx] >= 7) & (phase[idx] < 18)), ("endgame", phase[idx] < 7)):
            entry[name]["byPhase"][phase_name] = loss_at(hce[name][mask], target[idx][mask], stm[idx][mask], k_hce)
    report["evaluators"]["hce"] = entry

    for card_path in args.net:
        card = json.loads(Path(card_path).read_text())
        q = read_bin(Path(card["artifacts"]["bin"]["path"]))
        preds = {}
        for name, idx in subsets.items():
            fw = feats[idx]
            preds[name] = train.quantised_eval(q, fw, lut[fw], stm[idx]).astype(np.float64)
        k = fit_scale(preds["validation"], target[subsets["validation"]], stm[subsets["validation"]])
        entry = {"kind": "nnue", "hidden": q["hidden"], "card": card_path, "fittedScale": k}
        for name, idx in subsets.items():
            entry[name] = {"mseAtFittedScale": loss_at(preds[name], target[idx], stm[idx], k),
                           "mseAtScale1": loss_at(preds[name], target[idx], stm[idx], 1.0), "byPhase": {}}
            for phase_name, mask in (("opening", phase[idx] >= 18), ("middlegame", (phase[idx] >= 7) & (phase[idx] < 18)), ("endgame", phase[idx] < 7)):
                entry[name]["byPhase"][phase_name] = loss_at(preds[name][mask], target[idx][mask], stm[idx][mask], 1.0)
        report["evaluators"][f"h{q['hidden']}"] = entry

    # Constant predictor reference (predict the mean target).
    for name, idx in subsets.items():
        mean_target = float(target[idx].mean())
        report.setdefault("constantReference", {})[name] = float(((target[idx] - mean_target) ** 2).mean())

    Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
    summary = {k: {"val": round(v["validation"]["mseAtFittedScale"], 6), "test": round(v["test"]["mseAtFittedScale"], 6), "k": round(v["fittedScale"], 3)}
               for k, v in report["evaluators"].items()}
    print(json.dumps({"constant": report["constantReference"], **summary}, indent=1))


if __name__ == "__main__":
    main()
