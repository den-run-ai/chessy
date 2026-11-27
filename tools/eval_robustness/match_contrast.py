"""Compare both sets of audited games on their common replication openings."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import random
import statistics

import chess.pgn

from tools.eval_pipeline.frontier import candidate_points, quantile, sha
from .match import EVIDENCE


def pair_scores(path, numerator, bank):
    by_id = defaultdict(dict)
    candidate = f"r85-no-pawn-ratio-{numerator}-16"
    with path.open() as pgn:
        while (game := chess.pgn.read_game(pgn)) is not None:
            headers = game.headers
            key = headers["OpeningId"]
            if (game.errors or headers["SourceGameId"] != key or key not in bank or headers["SearchLimit"] != "25ms/move"
                    or {headers["White"], headers["Black"]} != {candidate, "r85-hce-memory"}):
                raise ValueError("unexpected replication PGN")
            color = "white" if headers["White"] == candidate else "black"
            if color in by_id[key]:
                raise ValueError("duplicate color in joint comparison")
            prefix = bank[key]["prefixUci"]
            moves = [m.uci() for m in game.mainline_moves()]
            if moves[:len(prefix)] != prefix:
                raise ValueError("opening prefix differs")
            by_id[key][color] = candidate_points(headers["Result"], color)
    if set(by_id) != set(bank) or any(set(x) != {"white", "black"} for x in by_id.values()):
        raise ValueError("incomplete paired opening inventory")
    return {k: statistics.mean(v.values()) for k, v in by_id.items()}


def analyze(unscaled, fitted, source):
    bank = {r["sourceGameId"]: r for r in map(json.loads, source.read_bytes().splitlines())}
    by_family = defaultdict(list)
    a, b = pair_scores(unscaled, 16, bank), pair_scores(fitted, 12, bank)
    for key, row in bank.items():
        by_family[row["ply4Family"]].append((a[key], b[key], b[key] - a[key]))
    groups = [by_family[key] for key in sorted(by_family)]
    counts = [len(g) for g in groups]
    totals = [[sum(v) for v in zip(*g)] for g in groups]
    rng = random.Random(20261127)
    draws = [[], [], []]
    for _ in range(10_000):
        selection = [rng.randrange(len(groups)) for _ in groups]
        denominator = sum(counts[i] for i in selection)
        for values, replicate in zip(zip(*(totals[i] for i in selection)), draws):
            replicate.append(sum(values) / denominator)
    reports = {}
    names = ("unscaledVsHce", "fittedVsHce", "fittedMinusUnscaledVsHce")
    for name, values, bootstrap in zip(names, zip(*totals), draws):
        def interval(tail):
            return [quantile(bootstrap, tail), quantile(bootstrap, 1 - tail)]
        reports[name] = {"point": sum(values) / sum(counts), "marginal95": interval(.025),
                         "simultaneous95": interval(.05 / 6)}
    return {"openingPairs": len(bank), "gamesPerModel": 2 * len(bank), "fourPlyFamilies": len(groups),
            "largestFamily": max(counts), "models": reports,
            "sameStartAndColor": True, "directMatchBetweenModels": False,
            "unscaledPgnSha256": sha(unscaled.read_bytes()), "fittedPgnSha256": sha(fitted.read_bytes()),
            "bankSha256": sha(source.read_bytes()), "protocolSha256": sha((EVIDENCE / "match-joint-protocol.json").read_bytes()),
            "note": "Paired difference in game scores against HCE across two successive measurement periods."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unscaled", type=Path)
    parser.add_argument("fitted", type=Path)
    parser.add_argument("bank", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    result = analyze(args.unscaled, args.fitted, args.bank)
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
