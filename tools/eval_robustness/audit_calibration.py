"""Independently check the fitted scalar and repeat a label-blind sample of UCI searches."""
import argparse
from collections import Counter
import gzip
import hashlib
import itertools
import json
from pathlib import Path

import chess
import chess.engine
import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import expit


def sha(data):
    return hashlib.sha256(data).hexdigest()


def objective_check(rows, report):
    # Compute the scalar objective directly. Compare boundaries too, since
    # bounded minimization alone does not evaluate its endpoints.
    train = [row for row in rows if int(sha(b'eval-robustness-v1\0' + row["group"].encode())[:16], 16) % 10 >= 3]
    counts = Counter(row["group"] for row in train)
    results = {}
    for name, pair_weight, penalty in [("calibrated", .75, .0025), ("pointwiseOnly", 0, .0025),
                                       ("tenfoldPenalty", .75, .025), ("unregularized", .75, 0)]:
        terms = []
        for row in train:
            children = row["children"]
            group_weight = 1 / (len(counts) * counts[row["group"]])
            def add(b, l, teacher, temp, weight):
                terms.append((b / temp, (l - b) / temp, expit(teacher / temp), group_weight * weight))
            for child in children:
                add(child["hce"], child["noPawn"], child["teacher"], 250, (1 - pair_weight) / len(children))
            pairs = list(itertools.combinations(children, 2))
            for a, b in pairs:
                add(a["hce"] - b["hce"], a["noPawn"] - b["noPawn"], a["teacher"] - b["teacher"],
                    120, pair_weight / len(pairs))
        base, slope, target, weight = np.array(terms).T
        def loss(alpha):
            logit = base + alpha * slope
            return np.dot(weight, np.logaddexp(0, logit) - target * logit) + penalty * alpha ** 2
        optimum = minimize_scalar(loss, bounds=(0, 1), method="bounded", options={"xatol": 1e-12}).x
        alpha = min([0., optimum, 1.], key=loss)
        n = min(range(17), key=lambda i: abs(i/16 - alpha))
        expected = report["fits"][name]
        if abs(alpha - expected["alpha"]) > 1e-6 or n != expected["numerator"]:
            raise ValueError(f"independent optimum differs for {name}")
        results[name] = {"alpha": alpha, "numerator": n, "loss": float(loss(alpha))}
    return results


def repeat_labels(rows, teacher_path):
    selected = sorted(rows, key=lambda r: sha(("audit:" + r["root"]).encode()))[:32]
    repeats = []
    with chess.engine.SimpleEngine.popen_uci(str(teacher_path.resolve())) as eng:
        eng.configure({"Threads": 1, "Hash": 16})
        for row in selected:
            position = chess.Board()
            for token in row["prefixUci"]:
                position.push_uci(token)
            root_side = position.turn
            for child in row["children"]:
                position.push_uci(child["uci"])
                if not child["terminal"]:
                    info = eng.analyse(position, chess.engine.Limit(nodes=12000), game=object())
                    if info.get("upperbound") or info.get("lowerbound"):
                        raise ValueError("unexpected bounded repeated search")
                    score = info["score"].pov(root_side).score(mate_score=3000)
                    repeats.append({"root": row["root"], "uci": child["uci"], "oldCp": child["teacher"],
                                    "newCp": max(-3000, min(3000, score)), "oldNodes": child["teacherNodes"],
                                    "newNodes": info["nodes"]})
                position.pop()
    return repeats


def replay_order(rows, repeats, teacher_path):
    """Hold each child fixed and change only earlier searches in its process."""
    positions = {row["root"]: row for row in rows}
    results = []
    for repeat in (row for row in repeats if row["oldCp"] != row["newCp"]):
        row = positions[repeat["root"]]
        root = chess.Board()
        for token in row["prefixUci"]:
            root.push_uci(token)
        child = root.copy()
        child.push_uci(repeat["uci"])
        example = {"root": row["root"], "uci": repeat["uci"], "frozen": repeat["oldCp"]}
        for with_prefix, key in [(False, "fresh"), (True, "sameRootAndPrecedingSiblings")]:
            with chess.engine.SimpleEngine.popen_uci(str(teacher_path.resolve())) as eng:
                eng.configure({"Threads": 1, "Hash": 16})
                def evaluate(board):
                    info = eng.analyse(board, chess.engine.Limit(nodes=12000), game=object())
                    return info["score"].pov(root.turn).score(mate_score=3000)
                if with_prefix:
                    evaluate(root)
                    for sibling in row["children"]:
                        if sibling["uci"] == repeat["uci"]:
                            break
                        if not sibling["terminal"]:
                            position = root.copy()
                            position.push_uci(sibling["uci"])
                            evaluate(position)
                example[key] = [evaluate(child) for _ in range(3)]
        results.append(example)
    return results


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ("collection", "fit", "exclusions", "teacher", "output"):
        p.add_argument(arg, type=Path)
    args = p.parse_args()
    data = args.collection.read_bytes()
    rows = [json.loads(line) for line in gzip.decompress(data).splitlines()]
    fits = args.fit.read_bytes()
    report = json.loads(fits)
    if sha(data) != report["collectionSha256"]:
        raise ValueError("collection identity differs from fit")
    teacher = sha(args.teacher.read_bytes())
    manifest = json.loads(args.collection.with_suffix(".manifest.json").read_bytes())
    if teacher != manifest["sha256"]["teacher"]:
        raise ValueError("teacher identity differs from collection")
    exclusions = args.exclusions.read_bytes()
    if sha(exclusions) != report["exclusionsSha256"]:
        raise ValueError("exclusions differ from fit")
    omitted = json.loads(exclusions)["excludedGroups"]
    optimum = objective_check([row for row in rows if row["group"] not in omitted], report)
    repeats = repeat_labels(rows, args.teacher)
    counts = [c["teacherNodes"] for row in rows for c in row["children"] if not c["terminal"]]
    all_nodes = {"nonterminal": len(counts), "requested": 12000, "minimum": min(counts), "maximum": max(counts),
                 "median": float(np.median(counts)), "p95": float(np.percentile(counts, 95)),
                 "under": sum(n < 12000 for n in counts), "over": sum(n > 12000 for n in counts)}
    result = {"collectionSha256": sha(data), "fitSha256": sha(fits), "teacherSha256": teacher,
              "independentScalarOptima": optimum, "collectionReportedNodes": all_nodes,
              "repeatedRoots": 32, "repeatedChildren": len(repeats),
              "matchedCp": sum(r["oldCp"] == r["newCp"] for r in repeats),
              "matchedNodes": sum(r["oldNodes"] == r["newNodes"] for r in repeats),
              "maxAbsoluteCpDifference": max(abs(r["oldCp"] - r["newCp"]) for r in repeats),
              "changedSearches": [r for r in repeats if (r["oldCp"], r["oldNodes"]) != (r["newCp"], r["newNodes"])],
              "orderRepeats": replay_order(rows, repeats, args.teacher),
              "scope": "Single repeated 32-root hash sample. Exact fresh search outcomes may vary. Training reuses frozen labels."}
    with args.output.open("x") as f:
        json.dump(result, f, indent=2, sort_keys=True, allow_nan=False)
        f.write("\n")
