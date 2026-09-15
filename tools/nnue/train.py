#!/usr/bin/env python3
"""Train, quantise and export one 768->H->1 two-perspective SCReLU net.

Research prototype for the NNUE-vs-HCE question (#105). The same dataset,
seed, schedule and batch size are used for every hidden width so the widths
are comparable. Nothing here touches the shipped engine.

Model (float): acc_p = W1[features_p] + b1 for perspective p in {white, black};
h = [screlu(acc_stm), screlu(acc_nstm)]; out = h . W2 + b2, in units where
sigmoid(out) is the side-to-move expected score (out * 400 ~ centipawns).
Loss: mean squared error between sigmoid(out) and sigmoid(cp_stm / 400).

Quantisation (bullet "simple" convention): W1,b1 -> i16 at QA=255; W2 -> i16
at QB=64; b2 -> i32 at QA*QB. Integer inference in `quantised_eval` below is
an exact model of experiments/wasm/src/nnue.rs, including truncating
division, and produces the goldens the Rust test suite checks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

QA = 255
QB = 64
SCALE = 400
PAD = 768
CLIP = 1.98  # float weight clip so the i16 accumulator can never overflow (32 * 505 + 505 < 32767)
OUTPUT_CLAMP = 30_000
SCHEMA = "chessy.nnue-proto-model.v1"


def black_lut() -> np.ndarray:
    lut = np.empty(769, dtype=np.int64)
    for index in range(768):
        channel, square = divmod(index, 64)
        lut[index] = ((channel + 6) % 12) * 64 + (square ^ 56)
    lut[PAD] = PAD
    return lut


class Net(nn.Module):
    def __init__(self, hidden: int) -> None:
        super().__init__()
        self.hidden = hidden
        self.embed = nn.EmbeddingBag(769, hidden, mode="sum", padding_idx=PAD)
        self.bias = nn.Parameter(torch.zeros(hidden))
        self.out = nn.Linear(2 * hidden, 1)
        nn.init.normal_(self.embed.weight, std=0.05)
        with torch.no_grad():
            self.embed.weight[PAD].zero_()
        nn.init.normal_(self.out.weight, std=0.05)
        nn.init.zeros_(self.out.bias)

    def forward(self, feats_w, feats_b, stm):
        acc_w = self.embed(feats_w) + self.bias
        acc_b = self.embed(feats_b) + self.bias
        white_to_move = (stm == 0).unsqueeze(1)
        acc_stm = torch.where(white_to_move, acc_w, acc_b)
        acc_nstm = torch.where(white_to_move, acc_b, acc_w)
        hidden = torch.cat((acc_stm, acc_nstm), dim=1).clamp(0.0, 1.0)
        return self.out(hidden * hidden).squeeze(1)

    def clip(self) -> None:
        with torch.no_grad():
            self.embed.weight.clamp_(-CLIP, CLIP)
            self.embed.weight[PAD].zero_()
            self.bias.clamp_(-CLIP, CLIP)
            self.out.weight.clamp_(-CLIP, CLIP)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def quantise(net: Net) -> dict[str, np.ndarray | int]:
    w1 = np.rint(net.embed.weight.detach().numpy()[:768] * QA).astype(np.int64)
    b1 = np.rint(net.bias.detach().numpy() * QA).astype(np.int64)
    w2 = np.rint(net.out.weight.detach().numpy()[0] * QB).astype(np.int64)
    b2 = int(np.rint(float(net.out.bias.detach().numpy()[0]) * QA * QB))
    for name, values in (("w1", w1), ("b1", b1), ("w2", w2)):
        if np.abs(values).max() > 32767:
            raise SystemExit(f"{name} saturates i16")
    # Accumulator bound: 32 largest |w1| in any hidden column plus |b1| stays inside i16.
    worst = np.sort(np.abs(w1), axis=0)[-32:].sum(axis=0) + np.abs(b1)
    if worst.max() >= 32767:
        raise SystemExit(f"accumulator bound violated: {worst.max()}")
    if not -2**31 <= b2 < 2**31:
        raise SystemExit("b2 saturates i32")
    return {"w1": w1.astype(np.int16), "b1": b1.astype(np.int16), "w2": w2.astype(np.int16), "b2": b2,
            "accumulatorBound": int(worst.max())}


def encode(q: dict, hidden: int) -> bytes:
    header = b"CNNU" + struct.pack("<III", 1, hidden, 0)
    return header + q["w1"].astype("<i2").tobytes() + q["b1"].astype("<i2").tobytes() + \
        q["w2"].astype("<i2").tobytes() + struct.pack("<i", q["b2"])


def trunc_div(a: np.ndarray, b: int) -> np.ndarray:
    """Rust/JS-style truncating integer division on int64 arrays."""
    q = np.abs(a) // abs(b)
    return np.where((a < 0) != (b < 0), -q, q)


def quantised_eval(q: dict, feats_w: np.ndarray, feats_b: np.ndarray, stm: np.ndarray) -> np.ndarray:
    """Exact integer model of nnue.rs `evaluate`; returns White-POV cp."""
    hidden = q["b1"].shape[0]
    w1 = np.vstack((q["w1"].astype(np.int64), np.zeros((1, hidden), dtype=np.int64)))  # PAD row
    acc_w = w1[feats_w].sum(axis=1) + q["b1"].astype(np.int64)
    acc_b = w1[feats_b].sum(axis=1) + q["b1"].astype(np.int64)
    assert np.abs(acc_w).max() < 32768 and np.abs(acc_b).max() < 32768
    white = (stm == 0)[:, None]
    acc_stm = np.where(white, acc_w, acc_b)
    acc_nstm = np.where(white, acc_b, acc_w)
    sq_stm = np.clip(acc_stm, 0, QA) ** 2
    sq_nstm = np.clip(acc_nstm, 0, QA) ** 2
    w2 = q["w2"].astype(np.int64)
    total = sq_stm @ w2[:hidden] + sq_nstm @ w2[hidden:]
    scaled = trunc_div((trunc_div(total, QA) + q["b2"]) * SCALE, QA * QB)
    stm_cp = np.clip(scaled, -OUTPUT_CLAMP, OUTPUT_CLAMP)
    return np.where(stm == 0, stm_cp, -stm_cp)


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def metrics(pred_cp_white: np.ndarray, cp_white: np.ndarray, stm: np.ndarray, mate: np.ndarray, phase: np.ndarray) -> dict:
    sign = np.where(stm == 0, 1.0, -1.0)
    target = sigmoid(cp_white * sign / SCALE)
    pred = sigmoid(pred_cp_white * sign / SCALE)
    err = (pred - target) ** 2
    non_mate = mate == 0
    out = {
        "mse": float(err.mean()),
        "cpMae": float(np.abs(np.clip(pred_cp_white, -1500, 1500) - np.clip(cp_white, -1500, 1500))[non_mate].mean()),
        "signAccuracy": float(((pred_cp_white > 0) == (cp_white > 0))[np.abs(cp_white) >= 50].mean()),
        "byPhase": {},
        "n": int(len(err)),
    }
    for name, mask in (("opening", phase >= 18), ("middlegame", (phase >= 7) & (phase < 18)), ("endgame", phase < 7)):
        if mask.any():
            out["byPhase"][name] = {"mse": float(err[mask].mean()), "n": int(mask.sum())}
    return out


def evaluate_float(net: Net, feats_w: np.ndarray, lut: np.ndarray, stm: np.ndarray, batch: int = 65536) -> np.ndarray:
    net.eval()
    outputs = []
    with torch.no_grad():
        for start in range(0, len(stm), batch):
            fw = torch.from_numpy(feats_w[start:start + batch].astype(np.int64))
            fb = torch.from_numpy(lut[feats_w[start:start + batch]])
            s = torch.from_numpy(stm[start:start + batch].astype(np.int64))
            outputs.append(net(fw, fb, s).numpy())
    net.train()
    out = np.concatenate(outputs) * SCALE
    return np.where(stm == 0, out, -out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--hidden", type=int, required=True)
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--batch", type=int, default=16384)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=10601)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-train", type=int, default=0, help="debug: cap training rows")
    parser.add_argument("--goldens", type=int, default=256)
    parser.add_argument("--out", required=True, help="output prefix, e.g. /data/nets/h32")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(args.threads)
    started = time.time()

    data_dir = Path(args.dataset).parent
    data = np.load(args.dataset)
    split = data["split"]
    feats = data["feats"]
    stm = data["stm"]
    cp = data["cp"].astype(np.float32)
    mate = data["mate"]
    phase = data["phase"]
    manifest_path = data_dir / "manifest.json"
    dataset_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    train_idx = np.flatnonzero(split == 0)
    val_idx = np.flatnonzero(split == 1)
    test_idx = np.flatnonzero(split == 2)
    if args.max_train:
        train_idx = train_idx[: args.max_train]
    lut = black_lut()
    lut_t = torch.from_numpy(lut)

    net = Net(args.hidden)
    optimizer = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=0.0)
    steps_per_epoch = math.ceil(len(train_idx) / args.batch)
    total_steps = steps_per_epoch * args.epochs
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps, eta_min=args.lr * 0.01)
    rng = np.random.default_rng(args.seed)

    sign_all = np.where(stm == 0, 1.0, -1.0).astype(np.float32)
    target_all = (1.0 / (1.0 + np.exp(-(cp * sign_all) / SCALE))).astype(np.float32)

    history = []
    print(json.dumps({"stage": "start", "hidden": args.hidden, "train": int(len(train_idx)), "validation": int(len(val_idx)),
                      "test": int(len(test_idx)), "steps": total_steps}), flush=True)
    step = 0
    for epoch in range(args.epochs):
        order = rng.permutation(train_idx)
        running = 0.0
        count = 0
        epoch_start = time.time()
        for start in range(0, len(order), args.batch):
            idx = order[start:start + args.batch]
            fw_np = feats[idx]
            fw = torch.from_numpy(fw_np.astype(np.int64))
            fb = lut_t[fw]
            s = torch.from_numpy(stm[idx].astype(np.int64))
            target = torch.from_numpy(target_all[idx])
            pred = torch.sigmoid(net(fw, fb, s))
            loss = ((pred - target) ** 2).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            scheduler.step()
            net.clip()
            running += loss.item() * len(idx)
            count += len(idx)
            step += 1
        val_pred = evaluate_float(net, feats[val_idx], lut, stm[val_idx])
        val = metrics(val_pred, cp[val_idx], stm[val_idx], mate[val_idx], phase[val_idx])
        record = {"epoch": epoch + 1, "trainMse": running / count, "valMse": val["mse"], "valCpMae": val["cpMae"],
                  "lr": scheduler.get_last_lr()[0], "epochSeconds": round(time.time() - epoch_start, 1)}
        history.append(record)
        print(json.dumps({"stage": "epoch", **record}), flush=True)

    # Quantise and export.
    q = quantise(net)
    blob = encode(q, args.hidden)
    out_prefix = Path(args.out)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    (out_prefix.with_suffix(".bin")).write_bytes(blob)
    torch.save(net.state_dict(), out_prefix.with_suffix(".pt"))

    def full_eval(indices: np.ndarray) -> dict:
        fw = feats[indices]
        fb = lut[fw]
        float_cp = evaluate_float(net, fw, lut, stm[indices])
        quant_cp = quantised_eval(q, fw, fb, stm[indices])
        return {
            "float": metrics(float_cp, cp[indices], stm[indices], mate[indices], phase[indices]),
            "quantised": metrics(quant_cp, cp[indices], stm[indices], mate[indices], phase[indices]),
            "quantisationCpMae": float(np.abs(float_cp - quant_cp).mean()),
            "quantisationCpMax": float(np.abs(float_cp - quant_cp).max()),
        }

    validation = full_eval(val_idx)
    test = full_eval(test_idx)

    # Goldens: exact integer outputs the Rust test reproduces (fen|white_cp).
    fens = (data_dir / "fens.txt").read_text().splitlines()
    golden_idx = val_idx[rng.permutation(len(val_idx))[: args.goldens]]
    golden_cp = quantised_eval(q, feats[golden_idx], lut[feats[golden_idx]], stm[golden_idx])
    golden_lines = ["# fen|white_pov_cp from tools/nnue/train.py quantised_eval"]
    for index, value in zip(golden_idx, golden_cp):
        golden_lines.append(f"{fens[index]} 0 1|{int(value)}")
    golden_path = out_prefix.with_suffix(".goldens.txt")
    golden_path.write_text("\n".join(golden_lines) + "\n")

    card = {
        "schema": SCHEMA,
        "hidden": args.hidden,
        "config": {"epochs": args.epochs, "batch": args.batch, "lr": args.lr, "seed": args.seed, "clip": CLIP,
                   "optimizer": "AdamW(wd=0)", "schedule": "cosine to 1% of lr", "loss": "MSE(sigmoid(out), sigmoid(cp_stm/400))",
                   "activation": "SCReLU", "perspectives": "shared W1, stm-first output", "featureMap": "eval/training/nnue-v1-architecture.json"},
        "quantisation": {"QA": QA, "QB": QB, "SCALE": SCALE, "accumulatorBound": q["accumulatorBound"],
                         "w2AbsMax": int(np.abs(q["w2"]).max()), "b2": q["b2"]},
        "dataset": {"path": str(Path(args.dataset).resolve()), "manifestSha256": sha256_bytes(manifest_path.read_bytes()) if manifest_path.exists() else None,
                    "train": int(len(train_idx)), "validation": int(len(val_idx)), "test": int(len(test_idx)),
                    "datasetNpzSha256": dataset_manifest.get("outputs", {}).get("dataset.npz")},
        "history": history,
        "validation": validation,
        "test": test,
        "artifacts": {"bin": {"path": str(out_prefix.with_suffix('.bin')), "bytes": len(blob), "sha256": sha256_bytes(blob)},
                      "goldens": {"path": str(golden_path), "count": len(golden_idx), "sha256": sha256_bytes(golden_path.read_bytes())}},
        "parameterBytes": len(blob) - 16,
        "trainSeconds": round(time.time() - started, 1),
        "torch": torch.__version__,
    }
    out_prefix.with_suffix(".json").write_text(json.dumps(card, indent=2) + "\n")
    print(json.dumps({"stage": "done", "hidden": args.hidden, "valMse": validation["quantised"]["mse"],
                      "testMse": test["quantised"]["mse"], "quantCpMae": validation["quantisationCpMae"],
                      "bytes": len(blob), "seconds": card["trainSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
