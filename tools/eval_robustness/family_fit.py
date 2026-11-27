"""Fit eight convex family/phase scales on the retained development games."""
import argparse
import gzip
import itertools
import json
import math
from pathlib import Path
import subprocess
import sys

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.eval_pipeline.prepare import tables
from tools.eval_robustness import fit
from tools.eval_robustness.fit_validation import INPUTS
from tools.sparse_eval import features
from tools.sparse_eval.fit import metrics

BANK = ROOT / "eval/eval-robustness-v1"
PROTOCOL = "4cfc96b377698c55c94253c551c846c9059a12b4dc465583e948dd408232edd4"
FAMILIES = ("pst", "own_king", "enemy_king", "ray")
SHAPE = (2, features.BASE_FEATURES)


def checked(path, sha):
    raw = path.read_bytes()
    if fit.digest(raw) != sha:
        raise ValueError(f"unexpected input identity at {path}")
    return raw


def load_groups():
    primary = json.loads((BANK / "fit-results.json").read_text())
    rows = checked(BANK / "collection.jsonl.gz", primary["collectionSha256"])
    groups = fit.read_groups(gzip.decompress(rows))
    exclusions = json.loads(checked(BANK / "fit-exclusions.json", primary["exclusionsSha256"]))
    for group in exclusions["excludedGroups"]:
        del groups[group]
    train = {g: r for g, r in groups.items() if not fit.held_out(g)}
    test = {g: r for g, r in groups.items() if fit.held_out(g)}
    if len(train) != primary["trainGroups"] or len(test) != primary["heldOut"]["hce"]["all"]["groups"]:
        raise ValueError("source groups differ from primary")
    train_keys = fit.position_keys(train, "roots") | fit.position_keys(train, "children")
    test_keys = fit.position_keys(test, "roots") | fit.position_keys(test, "children")
    if train_keys & test_keys or primary["droppedCrossSplitTestRoots"]:
        raise ValueError("expected identical disjoint position partitions")
    return train, test, primary


def all_children(groups):
    return [child for rows in groups.values() for row in rows for child in row["children"]]


def augment(child, original):
    counts, phase = features.extract_raw(child["fen"], families=FAMILIES)
    sign = 1 if child["fen"].split()[1] == "b" else -1
    vector = np.zeros((2, len(FAMILIES)), dtype=np.int64)
    active = []
    for col, family in enumerate(FAMILIES):
        start, stop = features.FAMILIES[family]
        for i, count in counts.items():
            if start <= i < stop:
                vector[:, col] += sign * count * original[:, i] * [phase, 24 - phase]
                active.append((i, sign * count))
    child["basis"] = vector.ravel() / 24
    child["active"] = active
    numerator = int(vector.sum())
    correction = (1 if numerator >= 0 else -1) * ((abs(numerator) + 12) // 24)
    if child["noPawn"] != child["hce"] + correction or phase != child["phase"]:
        raise ValueError("source score differs from reconstructed family contributions")


def design(groups, predictor):
    x, base, target, mass = [], [], [], []

    def append(a, b, temperature, weight):
        point = b is None
        x.append((predictor(a) if point else predictor(a) - predictor(b)) / temperature)
        base.append((a["hce"] if point else a["hce"] - b["hce"]) / temperature)
        target.append(expit((a["teacher"] if point else a["teacher"] - b["teacher"]) / temperature))
        mass.append(weight)

    for rows in groups.values():
        for row in rows:
            weight = 1 / (len(groups) * len(rows))
            children = row["children"]
            for child in children:
                append(child, None, 250, weight * (1 - fit.PAIR_WEIGHT) / len(children))
            for a, b in itertools.combinations(children, 2):
                append(a, b, 120, weight * fit.PAIR_WEIGHT / math.comb(len(children), 2))
    return tuple(np.asarray(values) for values in (x, base, target, mass))


def solve(train):
    x, base, target, mass = design(train, lambda c: c["basis"])

    def objective(alpha):
        z = x @ alpha + base
        offsets = alpha - np.mean(alpha)
        loss = np.dot(mass, np.logaddexp(0, z) - target * z)
        penalty = 0.0025 * np.mean(alpha**2) + 0.01 * np.mean(offsets**2)
        gradient = x.T @ (mass * (expit(z) - target)) + (0.005 * alpha + 0.02 * offsets) / len(alpha)
        return loss + penalty, gradient

    result = minimize(objective, np.full(8, .75), jac=True, method="L-BFGS-B",
                      bounds=[(0, 1)] * 8, options={"ftol": 1e-15, "gtol": 1e-10, "maxiter": 500})
    projected = result.x - np.clip(result.x - result.jac, 0, 1)
    residual = float(np.abs(projected).max())
    if not result.success or residual > 1e-8:
        raise ValueError(f"fit failed optimality check: {result.message}, {residual}")
    return result.x.reshape(2, 4), dict(loss=float(result.fun), projectedGradient=residual,
                                        iterations=result.nit, solver="L-BFGS-B")


def export(original, alpha):
    exported = np.zeros(SHAPE, dtype="<i2")
    for col, name in enumerate(FAMILIES):
        start, stop = features.FAMILIES[name]
        values = original[:, start:stop] * alpha[:, col, None]
        exported[:, start:stop] = np.sign(values) * np.floor(np.abs(values) + 0.5)
    tables(exported.tobytes())  # Validates every fused and paired-ray lookup in i8.
    return exported


def native_scores(extractor, model, fens):
    result = subprocess.run([extractor, "eval", model], input=fens, capture_output=True, check=True)
    return np.fromstring(result.stdout.decode(), sep=" ", dtype=np.int64).reshape(-1, 3)


def score_children(children, exported, extractor, model):
    fens = "".join(c["fen"] + "\n" for c in children).encode()
    raw = native_scores(extractor, model, fens)
    for child, (baseline, total, _) in zip(children, raw, strict=True):
        phase = child["phase"]
        numerator = sum(count * (int(exported[0, i]) * phase + int(exported[1, i]) * (24 - phase))
                        for i, count in child["active"])
        rounded = (1 if numerator >= 0 else -1) * ((abs(numerator) + 12) // 24)
        sign = 1 if child["fen"].split()[1] == "b" else -1
        child["family"] = child["hce"] + rounded
        if baseline * sign != child["hce"] or total * sign != child["family"]:
            raise ValueError("integer-score mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("refit_study", type=Path)
    parser.add_argument("model", type=Path, help="destination for fitted i16 weights")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    checked(BANK / "family-protocol.json", PROTOCOL)
    train, test, primary = load_groups()
    source = checked(BANK / "build-no-pawn.i16le", "222e0157eefd08009477ecdc04986406844e29e7927c96f9662fd038eccfddf2")
    original = np.frombuffer(source, dtype="<i2").reshape(SHAPE).astype(np.int64)
    children = all_children(train) + all_children(test)
    for child in children:
        augment(child, original)
    alpha, convergence = solve(train)
    exported = export(original, alpha)
    args.model.write_bytes(exported.tobytes())
    extractor = args.refit_study / "extractor"
    checked(extractor, "70c8b583c4083e956ae550c196d59edf15bffce7dfb75742d41b5a9ee966431a")
    score_children(children, exported, extractor, args.model)

    scalar = primary["fits"]["calibrated"]["numerator"]
    summaries, regrets = {}, {}
    methods = {"hce": "hce", "full": "full", "noPawn": "noPawn", "scalar": scalar, "family": "family"}
    for name, model in methods.items():
        summaries[name], regrets[name] = fit.evaluate(test, model)
        x, base, target, mass = design(test, lambda c: fit.integer_score(c, model) - c["hce"])
        z = base + x
        summaries[name]["mixedCE"] = float(np.dot(mass, np.logaddexp(0, z) - target * z))
    quiet_fens = args.refit_study / "packed/validation.fens.txt"
    fens = checked(quiet_fens, "1f5402d0b61d18f2c8c1dd791d99fc1bcecd2c44956b5bc28c8ed8bcf0c81900")
    quiet = native_scores(extractor, args.model, fens)
    snapshot = {}
    for key in ("hce", "teacher", "phase"):
        path, dtype, sha = INPUTS[key]
        snapshot[key] = np.frombuffer(checked(args.refit_study / path, sha), dtype=dtype)
    if not np.array_equal(quiet[:,0], snapshot["hce"]):
        raise ValueError("quiet validation native HCE or FEN order differs")
    result = {
        "protocolSha256": PROTOCOL,
        "collectionSha256": primary["collectionSha256"],
        "exclusionsSha256": primary["exclusionsSha256"],
        "primaryFitSha256": fit.digest((BANK / "fit-results.json").read_bytes()),
        "sourceModelSha256": fit.digest(source),
        "modelSha256": fit.digest(exported.tobytes()),
        "researchOnly": True,
        "scales": {name: {"mg": float(alpha[0, i]), "eg": float(alpha[1, i])}
                   for i, name in enumerate(FAMILIES)},
        "convergence": convergence,
        "fitGroups": len(train),
        "heldoutGroups": len(test),
        "nonzero": int(np.count_nonzero(exported)),
        "nativeParityChildren": len(children),
        "holdout": summaries,
        "familyMinusControlRegretCp": {
            name: fit.regret_interval(values, regrets["family"])
            for name, values in regrets.items() if name != "family"
        },
        "quietValidation": metrics(quiet[:, 1], snapshot["teacher"], snapshot["phase"]),
    }
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
