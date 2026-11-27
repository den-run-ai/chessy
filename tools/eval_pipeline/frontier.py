#!/usr/bin/env python3
"""Complete-schedule, equal-time development comparisons of one evaluator pair.

Each opening's two colors remain together. The same bootstrap cluster draw is
used at every registered time control; Bonferroni percentile bands account for
the declared grid. These approximate, descriptive intervals do not constitute
formal admission, prove independence of opening families, or calibrate human
Elo. This module checks records, not chess legality: the runner's separate raw
history/rules audit remains necessary.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics
from typing import Iterable

SCHEMA = "chessy.eval-frontier.v1"
COLORS = ("white", "black")
RESULTS = ("1-0", "0-1", "1/2-1/2")
DRAW_REASONS = frozenset(("stalemate", "insufficient-material", "threefold-repetition",
                          "current-threefold", "fifty-move", "ply-cap"))


def encoded(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _integer(value, minimum, maximum=None):
    return (type(value) is int and value >= minimum
            and (maximum is None or value <= maximum))


def _name(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 256


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def validate_config(config: dict) -> dict:
    """Validate a prospective grid; additive provenance/runner fields are bound."""
    require(isinstance(config, dict) and config.get("schema") == SCHEMA,
            "wrong frontier configuration schema")
    require(config.get("researchOnly") is True and config.get("productionAdmission") is False,
            "frontier is development-only; production admission is forbidden")
    require(_name(config.get("experimentId")), "missing experiment identity")
    for side in ("base", "candidate"):
        binding = config.get(side)
        require(isinstance(binding, dict) and _name(binding.get("id"))
                and _digest(binding.get("sha256")), "missing " + side + " build identity")
        if binding.get("modelSha256") is not None:
            require(_digest(binding["modelSha256"]), "invalid " + side + " model identity")
    require(config["base"]["id"] != config["candidate"]["id"], "evaluator IDs must differ")
    times = config.get("timeControlsMs")
    require(isinstance(times, list) and len(times) >= 2
            and all(_integer(value, 1, 60000) for value in times)
            and times == sorted(set(times)), "time grid must contain distinct increasing positive integer milliseconds")
    openings = config.get("openingIds")
    require(isinstance(openings, list) and len(openings) >= 2
            and all(_name(value) for value in openings)
            and len(set(openings)) == len(openings), "opening IDs must be distinct and nonempty")
    groups = config.get("clusterByOpening", {value: value for value in openings})
    require(isinstance(groups, dict) and set(groups) == set(openings)
            and all(_name(value) for value in groups.values()), "cluster map must cover exactly the opening IDs")
    require(type(config.get("nodeLimit")) is int and config["nodeLimit"] == 0,
            "equal-time frontier forbids a fixed node limit")
    require(_integer(config.get("maxDepth"), 1, 111), "invalid maximum depth")
    require(_integer(config.get("postOpeningPlyCap"), 1, 2000), "invalid searched-ply cap")
    boot = config.get("bootstrap")
    require(isinstance(boot, dict) and _integer(boot.get("seed"), 0, 2**64 - 1)
            and _integer(boot.get("samples"), 2000, 1000000), "invalid preregistered bootstrap settings")
    confidence = boot.get("confidence")
    require(type(confidence) in (int, float) and math.isfinite(confidence)
            and .8 <= confidence < 1, "invalid confidence level")
    worthwhile = config.get("minimumWorthwhileScore", .5)
    require(type(worthwhile) in (int, float) and math.isfinite(worthwhile)
            and .5 <= worthwhile < 1, "invalid minimum worthwhile candidate score")
    # Reject non-finite values anywhere in additive telemetry/provenance fields.
    encoded(config)
    return config


def schedule_id(config: dict, time_ms: int, opening_id: str, color: str) -> str:
    """Bind every slot to the complete configuration, including build hashes."""
    return sha(encoded([SCHEMA, sha(encoded(config)), time_ms, opening_id, color]))


def schedule(config: dict) -> list[dict]:
    validate_config(config)
    result = []
    times = config["timeControlsMs"]
    for index, opening_id in enumerate(config["openingIds"]):
        shift = index % len(times)
        # Interleave budgets and rotate their order across openings to reduce
        # confounding from host drift. No measured outcome chooses the order.
        for time_ms in times[shift:] + times[:shift]:
            # Alternate which color starts each pair.
            colors = COLORS if index % 2 == 0 else tuple(reversed(COLORS))
            for color in colors:
                result.append({"scheduleId": schedule_id(config, time_ms, opening_id, color),
                               "openingId": opening_id, "timeMs": time_ms,
                               "candidateColor": color, "baseId": config["base"]["id"],
                               "candidateId": config["candidate"]["id"]})
    return result


def candidate_points(result: str, color: str) -> float:
    require(result in RESULTS and color in COLORS, "invalid result or candidate color")
    if result == "1/2-1/2":
        return .5
    return float((result == "1-0") == (color == "white"))


def validate_records(config: dict, records: Iterable[dict]) -> list[dict]:
    expected = {row["scheduleId"]: row for row in schedule(config)}
    actual = {}
    for row in records:
        require(isinstance(row, dict), "game record must be an object")
        sid = row.get("scheduleId")
        require(isinstance(sid, str) and sid in expected, "extra or unbound schedule ID")
        require(sid not in actual, "duplicate game schedule ID")
        want = expected[sid]
        require(all(row.get(key) == value for key, value in want.items()),
                "record does not match registered schedule/evaluators")
        require(type(row.get("timeMs")) is int, "time control must be integer milliseconds")
        require(row.get("result") in RESULTS, "incomplete or invalid game result")
        require(row.get("termination") in DRAW_REASONS | {"checkmate"}, "invalid termination reason")
        require((row["result"] == "1/2-1/2") == (row["termination"] in DRAW_REASONS),
                "result contradicts termination")
        if "completed" in row:
            require(row["completed"] is True, "unfinished game")
        if "status" in row:
            require(row["status"] == "complete", "failed or incomplete game")
        if "nodeLimit" in row:
            require(type(row["nodeLimit"]) is int and row["nodeLimit"] == 0,
                    "record contains a fixed-node budget")
        for side in ("base", "candidate"):
            if side + "Sha256" in row:
                require(row[side + "Sha256"] == config[side]["sha256"], "record build identity mismatch")
        if "postOpeningPlies" in row:
            plies = row["postOpeningPlies"]
            require(_integer(plies, 0, config["postOpeningPlyCap"]), "invalid searched-ply count")
            if row["termination"] == "ply-cap":
                require(plies == config["postOpeningPlyCap"], "ply-cap draw stopped before registered cap")
        encoded(row)
        actual[sid] = row
    require(set(actual) == set(expected), "missing games from complete registered schedule")
    return [actual[sid] for sid in expected]


def quantile(values: list[float], fraction: float) -> float:
    """Linear-interpolated empirical quantile, identical definition at all times."""
    require(bool(values) and 0 <= fraction <= 1, "invalid quantile")
    ordered = sorted(values)
    location = (len(ordered) - 1) * fraction
    low, high = math.floor(location), math.ceil(location)
    return ordered[low] + (ordered[high] - ordered[low]) * (location - low)


def relative_elo(score: float) -> float | None:
    """Descriptive logistic score transform; unbounded endpoints remain null."""
    if not 0 < score < 1:
        return None
    return 400 * math.log10(score / (1 - score))


def _elo(point: float, interval: list[float]) -> dict:
    return {"point": relative_elo(point), "interval": [relative_elo(x) for x in interval],
            "lowerUnbounded": interval[0] == 0, "upperUnbounded": interval[1] == 1,
            "scope": "relative logistic score transform against this exact base at this time; not calibrated Elo"}


def _bootstrap(config: dict, paired: dict[int, dict[str, float]]) -> tuple[dict, dict]:
    times = config["timeControlsMs"]
    names = config["openingIds"]
    cluster_map = config.get("clusterByOpening", {value: value for value in names})
    members = defaultdict(list)
    for opening in names:
        members[cluster_map[opening]].append(opening)
    groups = [members[key] for key in sorted(members)]
    counts = [len(group) for group in groups]
    totals = [[sum(paired[t][opening] for opening in group) for t in times] for group in groups]
    observed = [statistics.mean(paired[t].values()) for t in times]
    rng = random.Random(config["bootstrap"]["seed"])
    samples = [[] for _ in times]
    for _ in range(config["bootstrap"]["samples"]):
        selected = [rng.randrange(len(groups)) for _ in groups]
        denominator = sum(counts[index] for index in selected)
        for j in range(len(times)):
            samples[j].append(sum(totals[index][j] for index in selected) / denominator)
    alpha = 1 - config["bootstrap"]["confidence"]
    tail = alpha / (2 * len(times))
    bands = {}
    degenerate = []
    for j, time_ms in enumerate(times):
        # An all-identical empirical distribution cannot supply uncertainty
        # about unobserved openings; do not report a zero-width certainty band.
        if len(groups) < 2 or min(samples[j]) == max(samples[j]):
            bands[time_ms] = [0., 1.]
            degenerate.append(time_ms)
        else:
            bands[time_ms] = [min(observed[j], quantile(samples[j], tail)),
                              max(observed[j], quantile(samples[j], 1 - tail))]
    info = {"method": "paired-cluster-bootstrap-bonferroni-percentile",
            "confidence": config["bootstrap"]["confidence"],
            "scope": "nominal simultaneous descriptive intervals over this fixed time grid; approximate, not a coverage guarantee",
            "replicates": config["bootstrap"]["samples"], "seed": config["bootstrap"]["seed"],
            "rng": "Python random.Random (MT19937)", "sameClusterDrawAcrossTimeGrid": True,
            "clusterCount": len(groups), "openingCount": len(names),
            "largestCluster": max(counts), "estimand": "opening-weighted mean of two-color pair scores",
            "marginalTailProbability": tail, "degenerateTimesMs": degenerate,
            "degeneratePolicy": "report [0,1], never infer strength from a zero-variance bootstrap"}
    return bands, info


def provisional_policy(profiles: list[dict], minimum_worthwhile_score: float = .5) -> dict:
    """Describe measured grid regions and propose confirmation, never a switch."""
    ordered = sorted(profiles, key=lambda row: row["timeMs"])
    transitions = []
    brackets = []
    for low, high in zip(ordered, ordered[1:]):
        a, b = low["candidateScore"] - .5, high["candidateScore"] - .5
        if a * b < 0:
            transitions.append({"lowerTimeMs": low["timeMs"], "upperTimeMs": high["timeMs"],
                                "direction": "candidate-improves" if a < b else "candidate-worsens"})
        left, right = low["simultaneousInterval"], high["simultaneousInterval"]
        if left[1] < .5 and right[0] > .5:
            brackets.append({"lowerTimeMs": low["timeMs"], "upperTimeMs": high["timeMs"],
                             "direction": "candidate-improves"})
        elif left[0] > .5 and right[1] < .5:
            brackets.append({"lowerTimeMs": low["timeMs"], "upperTimeMs": high["timeMs"],
                             "direction": "candidate-worsens"})
    shortlist = [row["timeMs"] for row in ordered
                 if row["simultaneousInterval"][0] > minimum_worthwhile_score]
    return {"productionEnable": False, "requiresFreshConfirmation": True,
            "crossingStatus": "descriptive-bracket-only" if brackets else "not-established",
            "pointEstimateTransitions": transitions, "supportedGridBrackets": brackets,
            "candidateConfirmationTimesMs": shortlist,
            "selectionRule": "confirm only preregistered product budgets whose simultaneous lower score exceeds the minimum worthwhile score",
            "nextStep": ("Freeze the selected model/budget and test on a fresh separately registered confirmation bank; keep HCE default."
                         if shortlist else "No budget qualifies for confirmation on this screen; retain HCE and improve the candidate before a new registered comparison."),
            "noInterpolationOrExtrapolation": True, "noMonotoneCurveFit": True,
            "noAutomaticActivationFromPointCrossing": True}


def analyze(config: dict, records: Iterable[dict]) -> dict:
    """Return a development report only after the entire registered grid exists."""
    rows = validate_records(config, records)
    by_time = defaultdict(list)
    paired = {time_ms: defaultdict(list) for time_ms in config["timeControlsMs"]}
    for row in rows:
        score = candidate_points(row["result"], row["candidateColor"])
        by_time[row["timeMs"]].append((row, score))
        paired[row["timeMs"]][row["openingId"]].append(score)
    paired = {time_ms: {opening: statistics.mean(values) for opening, values in values_by_opening.items()}
              for time_ms, values_by_opening in paired.items()}
    intervals, bootstrap = _bootstrap(config, paired)
    profiles = []
    for time_ms in config["timeControlsMs"]:
        games = by_time[time_ms]
        mean = statistics.mean(paired[time_ms].values())
        interval = intervals[time_ms]
        profiles.append({"timeMs": time_ms, "games": len(games), "openingPairs": len(paired[time_ms]),
                         "wins": sum(score == 1 for _, score in games),
                         "draws": sum(score == .5 for _, score in games),
                         "losses": sum(score == 0 for _, score in games),
                         "candidateScore": mean, "simultaneousInterval": interval,
                         "relativeElo": _elo(mean, interval),
                         "terminationCounts": dict(sorted(Counter(row["termination"] for row, _ in games).items())),
                         "pairedScores": [{"openingId": opening, "score": paired[time_ms][opening]}
                                          for opening in config["openingIds"]],
                         "descriptiveClassification": ("candidate-ahead" if interval[0] > .5
                                                       else "base-ahead" if interval[1] < .5 else "inconclusive")})
    return {"schema": SCHEMA + ".report", "status": "complete-development-screen",
            "researchOnly": True, "productionAdmission": False, "formalPass": False,
            "experimentId": config["experimentId"], "configSha256": sha(encoded(config)),
            "recordsSha256": sha(encoded(rows)), "scheduleSha256": sha(encoded(schedule(config))),
            "implementationSha256": sha(Path(__file__).read_bytes()),
            "base": config["base"], "candidate": config["candidate"],
            "completeSchedule": True, "games": len(rows), "profiles": profiles,
            "bootstrap": bootstrap,
            "policy": provisional_policy(profiles, config.get("minimumWorthwhileScore", .5)),
            "rulesReplayPerformedByAnalyzer": False,
            "limitations": ["Separate full-history legal replay and measured-budget audit are required before interpreting scores.",
                            "Opening/family dependence may remain beyond the declared clusters; these intervals are exploratory.",
                            "Time-limited execution varies across runs, hardware, compiler tiers and thermal conditions.",
                            "Relative Elo is a score transform for this opponent and budget, not a human or universal rating.",
                            "No inference about intermediate times, unmeasured models/devices, or a universal saturation curve.",
                            "Ply-cap draws remain draws and are reported separately; no result-based exclusions or retries."]}


def decoded(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non-finite JSON evidence")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--records", type=Path, required=True, help="JSONL, one complete normalized game per line")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    config_raw, records_raw = args.config.read_bytes(), args.records.read_bytes()
    report = analyze(decoded(config_raw), [decoded(line) for line in records_raw.splitlines() if line.strip()])
    report["inputFiles"] = {"config": {"sha256": sha(config_raw), "bytes": len(config_raw)},
                            "records": {"sha256": sha(records_raw), "bytes": len(records_raw)}}
    with args.out.open("xb") as target:
        target.write(encoded(report) + b"\n")
    print(json.dumps({"status": report["status"], "games": report["games"], "policy": report["policy"]}))


if __name__ == "__main__":
    main()
