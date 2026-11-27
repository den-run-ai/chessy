"""Select two disjoint color-paired development banks before running either candidate."""
import argparse
import json
from collections import Counter
from pathlib import Path

from tools.sparse_eval_v2.openings import ROOT, encoded, load_quarantine, replay, rows, sha, write

SALT = "chessy.sparse-eval-robustness.v1"
COUNT = 32
MAX_PER_FAMILY_PER_BANK = 2
EVIDENCE = ROOT / "eval/sparse-pesto-v1"


def select(data, out, replication=False):
    # The sparse-v1 manifests identify all role files for label-blind exclusion.
    manifest = json.loads((EVIDENCE / "DATA-MANIFEST.json").read_bytes())
    quarantine = load_quarantine(ROOT)
    games, clusters, families = set(quarantine["sources"]), set(quarantine["clusters"]), set(quarantine["families"])
    for binding in manifest["files"]:
        for _, row in rows(data / "eval-v1", binding):
            families.add(row["family"])
            clusters.add(row["cluster"])

    ood = json.loads((EVIDENCE / "OOD-SELECTION-MANIFEST.json").read_bytes())
    for _, row in rows(data / "ood-selection-v1", ood["files"][0]):
        games.add(row["sourceGameId"])
        families.add(row["family"])
        clusters.add(row["cluster"])
    old_bank = ROOT / "eval/sparse-pesto-v2/game-openings.jsonl"
    for line in old_bank.read_bytes().splitlines():
        row = json.loads(line)
        games.add(row["sourceGameId"])
        families.add(row["rootFamily"])
        clusters.add(row["rootCluster"])

    if replication:
        # These banks were frozen and excluded before the replication starts.
        for label in ("unscaled", "fitted"):
            for line in (ROOT / f"eval/eval-robustness-v1/match-{label}-openings.jsonl").read_bytes().splitlines():
                previous = json.loads(line)
                games.add(previous["sourceGameId"])
                families.add(previous["rootFamily"])
                clusters.add(previous["rootCluster"])

    natural = json.loads((EVIDENCE / "NATURAL-MANIFEST.json").read_bytes())
    binding = next(x for x in natural["files"] if x["path"] == "positions.jsonl")
    ranked = []
    for index, row in rows(data / "pgn-v1", binding):
        game = row["sourceGameId"]
        if sha(game.encode())[0] not in "def" or game in games:
            continue
        if row["family"] in families or row["cluster"] in clusters:
            continue
        if not 16 <= row["selectedPly"] <= 32 or row["phase"] < 18:
            continue
        salt = SALT + (".replication" if replication else "")
        priority = sha((salt + "\0" + game).encode())
        ranked.append((priority, index, row))
    labels = ["replication"] if replication else ["unscaled", "fitted"]
    desired = 128 if replication else COUNT
    banks = [[] for _ in labels]
    family_counts = [Counter() for _ in labels]
    ply8_used = set()
    if replication:
        for label in ("unscaled", "fitted"):
            for line in (ROOT / f"eval/eval-robustness-v1/match-{label}-openings.jsonl").read_bytes().splitlines():
                ply8_used.add(json.loads(line)["ply8Family"])
    for priority, index, row in sorted(ranked):
        bank = sum(map(len, banks)) % len(banks)
        if row["family"] in families or row["cluster"] in clusters or row["sourceGameId"] in games:
            continue
        groups = replay(row)
        if groups[8] in ply8_used or family_counts[bank][groups[4]] >= MAX_PER_FAMILY_PER_BANK:
            continue
        families.add(row["family"])
        clusters.add(row["cluster"])
        games.add(row["sourceGameId"])
        ply8_used.add(groups[8])
        family_counts[bank][groups[4]] += 1
        banks[bank].append({k: row[k] for k in ("sourceId", "sourceGameId", "fen", "prefixUci", "selectedPly", "phase")}
                           | {"priority": priority, "sourcePositionIndex": index, "ply4Family": groups[4],
                              "ply8Family": groups[8], "rootFamily": row["family"], "rootCluster": row["cluster"]})
        if sum(map(len, banks)) == len(banks) * desired:
            break
    if list(map(len, banks)) != [desired] * len(banks):
        raise ValueError("insufficient eligible openings")
    out.mkdir(parents=True, exist_ok=True)
    for label, bank in zip(labels, banks):
        write(out / f"match-{label}-openings.jsonl", b"".join(encoded(row) for row in bank))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="restored original data/ directory")
    parser.add_argument("output", type=Path)
    parser.add_argument("--replication", action="store_true", help="new 128-pair bank excluding both screens")
    args = parser.parse_args()
    select(args.data, args.output, args.replication)
