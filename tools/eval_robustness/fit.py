"""Development-only convex calibration on labelled alternatives from distinct games."""
import argparse
import gzip
import hashlib
import itertools
import json
import math
import os
import random
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from statistics import fmean


PROTOCOL_HASH = "2fc45f051789dc3da602ce80e617081e43cf8a00a2e5001fe66382ba5e162da6"
PENALTY = 0.0025
PAIR_WEIGHT = 0.75


def digest(data):
    return hashlib.sha256(data).hexdigest()


def held_out(group):
    key = hashlib.sha256(b"eval-robustness-v1\0" + group.encode("utf-8")).digest()
    return int.from_bytes(key[:8], "big") % 10 < 3


def sigmoid(x):
    if x < 0:
        exp_x = math.exp(x)
        return exp_x / (1 + exp_x)
    return 1 / (1 + math.exp(-x))


def bounded_teacher(child):
    return max(-2000, min(2000, child["teacher"]))


def is_tactical(child):
    return child["tactical"] or child["check"]


def fen_key(fen):
    return " ".join(fen.split()[:4])


def read_groups(raw):
    groups = defaultdict(list)
    roots = set()
    for line in raw.splitlines():
        row = json.loads(line)
        if not isinstance(row["group"], str) or not row["group"]:
            raise ValueError("missing source group")
        identities = (row["group"], fen_key(row["fen"]))
        if identities in roots:
            raise ValueError("duplicate source root")
        roots.add(identities)
        children = row["children"]
        if len(children) < 2 or len({c["uci"] for c in children}) != len(children):
            raise ValueError("each root needs distinct alternatives")
        for child in children:
            for key in ("hce", "full", "noPawn", "teacher"):
                if type(child[key]) is not int:
                    raise ValueError(f"expected integer score: {key}")
            for key in ("tactical", "check"):
                if type(child[key]) is not bool:
                    raise ValueError(f"expected boolean: {key}")
        groups[row["group"]].append(row)
    if not groups:
        raise ValueError("empty input")
    return groups


def design(groups, pair_weight):
    """Each tuple is an affine logit offset+slope*alpha, target and weight."""
    terms = []
    for rows in groups.values():
        for row in rows:
            children = row["children"]
            root_weight = 1 / (len(groups) * len(rows))
            point_weight = (1 - pair_weight) * root_weight / len(children)
            pair_mass = pair_weight * root_weight / math.comb(len(children), 2)
            for child in children:
                if point_weight:
                    terms.append((child["hce"] / 250, (child["noPawn"] - child["hce"]) / 250,
                                  sigmoid(child["teacher"] / 250), point_weight))
            if pair_mass:
                for a, b in itertools.combinations(children, 2):
                    base = a["hce"] - b["hce"]
                    delta = (a["noPawn"] - b["noPawn"]) - base
                    terms.append((base / 120, delta / 120, sigmoid((a["teacher"] - b["teacher"]) / 120),
                                  pair_mass))
    return terms


def fit(terms, penalty):
    def derivative(alpha):
        return 2 * penalty * alpha + sum(
            weight * slope * (sigmoid(offset + slope * alpha) - target)
            for offset, slope, target, weight in terms
        )

    low, high = 0., 1.
    if derivative(low) >= 0:
        alpha = low
    elif derivative(high) <= 0:
        alpha = high
    else:
        for _ in range(56):
            midpoint = (low + high) / 2
            if derivative(midpoint) < 0:
                low = midpoint
            else:
                high = midpoint
        alpha = (low + high) / 2
    return {"alpha": alpha, "numerator": min(range(17), key=lambda n: abs(n / 16 - alpha)),
            "denominator": 16, "penalty": penalty, "gradientAtZero": derivative(0),
            "gradientAtOne": derivative(1), "gradientAtFit": derivative(alpha)}


def integer_score(child, model):
    if isinstance(model, str):
        return child[model]
    scaled = model * (child["noPawn"] - child["hce"])
    truncated = (abs(scaled) // 16) * (1 if scaled >= 0 else -1)
    return child["hce"] + truncated


def decision(children, model):
    predictions = {c["uci"]: integer_score(c, model) for c in children}
    picked = min(children, key=lambda c: (-predictions[c["uci"]], c["uci"]))
    best = max(c["teacher"] for c in children)
    best_bounded = max(bounded_teacher(c) for c in children)
    regret = best_bounded - bounded_teacher(picked)
    order = []
    for a, b in itertools.combinations(children, 2):
        direction = a["teacher"] - b["teacher"]
        if direction:
            product = direction * (predictions[a["uci"]] - predictions[b["uci"]])
            order.append(1 if product > 0 else .5 if product == 0 else 0)
    errors = [abs(predictions[c["uci"]] - bounded_teacher(c)) for c in children]
    metrics = {"regretCp": regret, "severe150Rate": int(regret >= 150),
               "topAgreement": int(picked["teacher"] == best), "childMaeCp": fmean(errors)}
    if order:
        metrics["pairAccuracy"] = fmean(order)
    for tactical, name in [(True, "tacticalChildMaeCp"), (False, "quietChildMaeCp")]:
        subset = [e for c, e in zip(children, errors) if is_tactical(c) == tactical]
        if subset:
            metrics[name] = fmean(subset)
    return metrics


def evaluate(groups, model):
    """Keep the group weighting in slices with different numbers of roots."""
    per_group = defaultdict(lambda: defaultdict(dict))
    counts = defaultdict(Counter)
    for group, rows in groups.items():
        by_slice = defaultdict(lambda: defaultdict(list))
        for row in rows:
            children = row["children"]
            best = max(c["teacher"] for c in children)
            tactical_best = any(is_tactical(c) and c["teacher"] == best for c in children)
            slice_key = "teacherBestIncludesTactical" if tactical_best else "teacherBestOnlyQuiet"
            for section in ["all", slice_key]:
                counts[section]["roots"] += 1
                counts[section]["children"] += len(children)
                for metric, value in decision(children, model).items():
                    by_slice[section][metric].append(value)
        for section, metrics in by_slice.items():
            for metric, values in metrics.items():
                per_group[section][metric][group] = fmean(values)
    result = {}
    for section, metrics in per_group.items():
        result[section] = {"groups": len(metrics["regretCp"]), **counts[section],
                           **{metric: fmean(values.values()) for metric, values in metrics.items()}}
    return result, per_group["all"]["regretCp"]


def regret_interval(base, other):
    diff = [other[g] - base[g] for g in sorted(base)]
    sampler = random.Random(20261127)
    samples = sorted(fmean(sampler.choices(diff, k=len(diff))) for _ in range(5000))
    return {"mean": fmean(diff), "percentile95": [samples[124], samples[4874]], "groups": len(diff)}


def position_keys(groups, role):
    return {fen_key(fen) for rows in groups.values() for row in rows
            for fen in ([row["fen"]] if role == "roots" else [c["fen"] for c in row["children"]])}


def analyze(raw, protocol, exclusions_raw):
    if digest(protocol) != PROTOCOL_HASH:
        raise ValueError("unexpected fit protocol identity")
    groups = read_groups(gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw)
    exclusions = json.loads(exclusions_raw)
    if exclusions["collectionSha256"] != digest(raw) or not set(exclusions["excludedGroups"]) <= groups.keys():
        raise ValueError("exclusion inventory does not match collection")
    for g in exclusions["excludedGroups"]:
        del groups[g]
    train = {g: rows for g, rows in groups.items() if not held_out(g)}
    test = {g: rows for g, rows in groups.items() if held_out(g)}
    if not train or not test:
        raise ValueError("both grouped partitions are required")
    # Count exact board/side/rights/ep transpositions with clocks removed. Dropping
    # the complete affected test root preserves its alternative choice set.
    train_keys = position_keys(train, "roots") | position_keys(train, "children")
    removed_test = 0
    test_filtered = {}
    for group, rows in test.items():
        keep = [r for r in rows if not ({fen_key(r["fen"])} | {fen_key(c["fen"]) for c in r["children"]}) & train_keys]
        removed_test += len(rows) - len(keep)
        if keep:
            test_filtered[group] = keep
    if not test_filtered:
        raise ValueError("no distinct held-out roots survived")
    mix = design(train, PAIR_WEIGHT)
    fits = {"calibrated": fit(mix, PENALTY), "unregularized": fit(mix, 0),
            "tenfoldPenalty": fit(mix, 10 * PENALTY), "pointwiseOnly": fit(design(train, 0), PENALTY)}
    methods = {name: name for name in ("hce", "full", "noPawn")}
    methods.update({name: f["numerator"] for name, f in fits.items()})
    summaries, regrets = {}, {}
    for name, method in methods.items():
        summaries[name], regrets[name] = evaluate(test_filtered, method)
    training_summary, _ = evaluate(train, methods["calibrated"])
    return {"schema": "chessy.sparse-hard-position-fit-result.v1", "researchOnly": True,
            "excludedSourceGroups": len(exclusions["excludedGroups"]), "exclusionsSha256": digest(exclusions_raw),
            "collectionSha256": digest(raw), "protocolSha256": PROTOCOL_HASH,
            "fitScriptSha256": digest(Path(__file__).read_bytes()),
            "model": "calibrated", "fits": fits,
            "trainGroups": len(train), "trainRoots": sum(map(len, train.values())),
            "trainChildren": sum(len(row["children"]) for rows in train.values() for row in rows),
            "droppedCrossSplitTestRoots": removed_test,
            "fitDiagnostics": training_summary, "heldOut": summaries,
            "calibratedMinusControlRegretCp": {name: regret_interval(regrets[name], regrets["calibrated"])
                                               for name in ("hce", "full", "noPawn")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", type=Path)
    parser.add_argument("protocol", type=Path)
    parser.add_argument("exclusions", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = analyze(args.collection.read_bytes(), args.protocol.read_bytes(), args.exclusions.read_bytes())
    # Publish complete JSON with atomic no-replace semantics.
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as tmp:
        path = Path(tmp.name)
        try:
            tmp.write((json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n").encode())
            tmp.flush()
            os.link(path, args.output)
        finally:
            path.unlink()


if __name__ == "__main__":
    main()
