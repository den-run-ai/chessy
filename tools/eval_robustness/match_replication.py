"""Freeze every shard before running independent opening pairs on designated CPUs."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time

from tools.eval_pipeline import frontier, games
from .match import EVIDENCE


def register_run(args):
    cpus = list(map(int, args.cpus.split(",")))
    if len(cpus) != 4 or len(set(cpus)) != 4:
        raise ValueError("four distinct CPU IDs required")
    args.out.mkdir(parents=True, exist_ok=False)
    entries = []
    processes = []
    for i, cpu in enumerate(cpus):
        folder = args.out / f"shard-{i}"
        result = subprocess.run(["taskset", "-c", str(cpu), sys.executable, "-m", "tools.eval_robustness.match",
                                 "replication", str(args.base), str(args.candidate), str(folder),
                                 "--shard", str(i), "--numerator", str(args.numerator), "--register-only"],
                                check=True, capture_output=True, text=True)
        receipt = json.loads(result.stdout)
        entries.append({"shard": i, "cpu": cpu, "games": receipt["games"], "sha256": receipt["registrationSha256"]})
    bank = EVIDENCE / "match-replication-openings.jsonl"
    manifest = {"purpose": ("independent replication of unscaled no-pawn after its exploratory 57.8125% point estimate"
                            if args.numerator == 16 else "replicate the frozen fitted no-pawn model on the same 128 pairs"),
                "residualNumerator": args.numerator,
                "openingBankSha256": games.sha(bank.read_bytes()), "timeMs": 25, "targetScore": .55,
                "rule": "128 new source games, two colors, 4 fixed shards by opening index modulo 4; use all outcomes",
                "uncertainty": "paired by source game, resample four-ply structural families across the full bank",
                "shards": entries}
    games.write(args.out / "joint-registration.json", games.encoded(manifest))
    # Freeze all registers before consulting any previous campaign completion flags.
    if args.after is not None:
        deadline = time.monotonic() + 1800
        pending = [args.after / f"shard-{i}/campaign" for i in range(4)]
        while any(not (p / "completion.json").is_file() for p in pending):
            if any((p / "failure.json").exists() for p in pending) or time.monotonic() >= deadline:
                raise RuntimeError("preceding CPU reservation failed or timed out")
            time.sleep(.5)
    for entry in entries:
        folder = args.out / f"shard-{entry['shard']}"
        campaign = folder / "campaign"
        with (folder / "run.log").open("x") as log:
            processes.append(subprocess.Popen(["taskset", "-c", str(entry["cpu"]), sys.executable,
                                               str(campaign / "source/games.py"), "run", str(campaign),
                                               "--registration-sha256", entry["sha256"]], stdout=log, stderr=subprocess.STDOUT))
    status = [p.wait() for p in processes]
    if any(status):
        raise RuntimeError(f"incomplete replication: {status}")


def summarize(args):
    registration = json.loads((args.out / "joint-registration.json").read_bytes())
    bank_raw = (EVIDENCE / "match-replication-openings.jsonl").read_bytes()
    if games.sha(bank_raw) != registration["openingBankSha256"]:
        raise ValueError("bank digest differs from preregistration")
    bank = [json.loads(line) for line in bank_raw.splitlines()]
    opening_ids = [r["sourceGameId"] for r in bank]
    groups = {r["sourceGameId"]: r["ply4Family"] for r in bank}
    pair_scores, colors, shard_stats, endings = {}, {}, [], Counter()
    if ([s["shard"] for s in registration["shards"]] != list(range(4))
            or len({s["cpu"] for s in registration["shards"]}) != 4):
        raise ValueError("invalid four-shard registration")
    models = None
    for entry in registration["shards"]:
        root = args.out / f"shard-{entry['shard']}/campaign"
        audit = games.audit(root, entry["sha256"], publish=not (root / "audit.json").exists())
        actual = json.loads((root / "audit.json").read_bytes())
        if audit != actual:
            raise ValueError("retained shard audit mismatch")
        config = json.loads((root / "config.json").read_bytes())
        local = json.loads((root / "registration.json").read_bytes())
        if local["selectedCpu"] != entry["cpu"] or config["timeControlsMs"] != [25] or config["shardIndex"] != entry["shard"]:
            raise ValueError("shard hardware or experiment settings differ from registration")
        current_models = {s: config[s] for s in ("base", "candidate")}
        if models is not None and models != current_models:
            raise ValueError("evaluator identity differs across shards")
        models = current_models
        if config["openingIds"] != opening_ids[entry["shard"]::4] or config["bankSha256"] != registration["openingBankSha256"]:
            raise ValueError("shard does not match its frozen bank partition")
        results = [json.loads(line) for line in (root / "games.jsonl").read_bytes().splitlines()]
        for row in frontier.validate_records(config, results):
            key, color = row["openingId"], row["candidateColor"]
            if color in colors.setdefault(key, {}):
                raise ValueError("duplicate color in joint schedule")
            colors[key][color] = frontier.candidate_points(row["result"], color)
            endings[row["termination"]] += 1
        profile = audit["profiles"][0]
        timing = audit["timing"][0]
        shard_stats.append({"shard": entry["shard"], "cpu": entry["cpu"], "wins": profile["wins"],
                            "draws": profile["draws"], "losses": profile["losses"], "score": profile["candidateScore"],
                            "moves": audit["campaignAudit"]["movesReplayed"], "cleanRealizedEqualTime": timing["cleanRealizedEqualTime"],
                            "candidateTimeLimitMedianMs": timing["telemetry"]["candidate"]["timeLimitMedianMs"],
                            "baseTimeLimitMedianMs": timing["telemetry"]["base"]["timeLimitMedianMs"],
                            "auditSha256": games.sha((root / "audit.json").read_bytes())})
    if set(colors) != set(opening_ids) or len(colors) != 128:
        raise ValueError("incomplete joint schedule")
    for opening, moves in colors.items():
        if set(moves) != {"white", "black"}:
            raise ValueError("missing game in color pair")
        pair_scores[opening] = statistics.mean(moves.values())
    config = {"timeControlsMs": [25], "openingIds": opening_ids, "clusterByOpening": groups,
              "bootstrap": {"confidence": .95, "samples": 10000, "seed": 20261127}}
    bands, bootstrap = frontier._bootstrap(config, {25: pair_scores})
    aggregate = {k: sum(s[k] for s in shard_stats) for k in ("wins", "draws", "losses", "moves")}
    aggregate.update({"games": 256, "pairs": 128, "score": statistics.mean(pair_scores.values()), "targetScore": .55,
                      "clusterInterval95": bands[25], "bootstrap": bootstrap, "terminations": dict(endings),
                      "models": models, "shards": shard_stats, "jointRegistrationSha256": games.sha((args.out / "joint-registration.json").read_bytes())})
    args.results.write_text(json.dumps(aggregate, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    reg = sub.add_parser("register-run")
    reg.add_argument("base", type=Path)
    reg.add_argument("candidate", type=Path)
    reg.add_argument("out", type=Path)
    reg.add_argument("--cpus", default="0,1,6,7")
    reg.add_argument("--numerator", type=int, choices=[12, 16], default=16)
    reg.add_argument("--after", type=Path, help="wait for prior four shards to seal before using their CPUs")
    audit = sub.add_parser("audit")
    audit.add_argument("out", type=Path)
    audit.add_argument("results", type=Path)
    args = parser.parse_args()
    (register_run if args.action == "register-run" else summarize)(args)
