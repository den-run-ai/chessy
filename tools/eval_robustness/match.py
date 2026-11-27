"""Register and play one development comparison on the preselected match bank."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

from tools.eval_pipeline import games

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "eval/eval-robustness-v1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bank", choices=["unscaled", "fitted", "replication"])
    parser.add_argument("base", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--numerator", type=int, required=True)
    parser.add_argument("--register-only", action="store_true", help="freeze a conditional arm without playing it")
    parser.add_argument("--zero-scale-fallback", action="store_true",
                        help="register half strength only if the fitted numerator is zero")
    parser.add_argument("--shard", type=int, choices=range(4), help="replication opening index modulo four")
    args = parser.parse_args()
    if (args.shard is None) != (args.bank != "replication"):
        parser.error("replication requires a predetermined shard, other comparisons run unsharded")
    if args.zero_scale_fallback and (args.bank != "fitted" or args.numerator != 8):
        parser.error("the zero-scale fallback uses numerator 8 on the second bank")
    numerator = args.numerator
    if not 0 < numerator <= 16 or (args.bank == "unscaled" and numerator != 16):
        parser.error("use the frozen nonzero numerator out of 16, or use HCE directly for zero")
    openings = EVIDENCE / f"match-{args.bank}-openings.jsonl"
    bank = [json.loads(line) for line in openings.read_bytes().splitlines()]
    if args.shard is not None:
        if len(bank) != 128:
            parser.error("replication requires all 128 reserved openings")
        bank = bank[args.shard::4]
    args.out.mkdir(parents=True, exist_ok=False)
    config = {"schema": games.frontier.SCHEMA, "experimentId": f"sparse-robustness-{args.bank}-n{numerator}",
              "researchOnly": True, "productionAdmission": False,
              "base": {"id": "r85-hce-memory", "sha256": games.sha(args.base.read_bytes())},
              "candidate": {"id": f"r85-no-pawn-ratio-{numerator}-16", "sha256": games.sha(args.candidate.read_bytes())},
              "singleBudgetScreen": True, "timeControlsMs": [25], "minimumWorthwhileScore": .55,
              "openingIds": [r["sourceGameId"] for r in bank],
              "clusterByOpening": {r["sourceGameId"]: r["ply4Family"] for r in bank},
              "bootstrap": {"confidence": .95, "samples": 10000, "seed": 20261127},
              "postOpeningPlyCap": 180, "maxDepth": 30, "nodeLimit": 0,
              "nodeArguments": ["--no-liftoff", "--no-wasm-lazy-compilation"],
              "warmup": {"cycles": 4, "nodeLimit": 10000, "timeMs": 0, "fens": [games.chess.STARTING_FEN]}}
    if args.shard is not None:
        config["experimentId"] += f"-shard-{args.shard}"
        config["shardIndex"] = args.shard
        config["bankSha256"] = games.sha(openings.read_bytes())
    if args.zero_scale_fallback:
        config["experimentId"] += "-conditional-on-zero-fit"
        config["executionCondition"] = "Execute only when the primary fitted numerator equals zero."
    config_path = args.out / "config.json"
    config_path.write_bytes(games.encoded(config))
    campaign = args.out / "campaign"
    result = games.register(config_path, openings, args.base, args.candidate, ROOT / "tools/eval_pipeline/host.mjs",
                            ROOT / "assets/wasm-engine.js", ROOT / "assets/engine.js", shutil.which("node"), campaign,
                            [Path(__file__), Path(__file__).with_name("match_openings.py")])
    print(json.dumps(result), flush=True)
    if args.register_only:
        return
    subprocess.run([sys.executable, result["runner"], "run", str(campaign), "--registration-sha256",
                    result["registrationSha256"]], check=True)


if __name__ == "__main__":
    main()
