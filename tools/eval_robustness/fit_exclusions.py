"""Construct a label-blind exclusion list for the calibration experiment."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re

from tools.sparse_eval.data import key_data, load_quarantine

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = re.compile(rb'"(cluster|family)":"([a-f0-9]{64})"')
SELECTION_SHA256 = "2add1b46557117edd833bf493bc66c4264ad4700e0fa416ffa81a543a8b8a92f"


def verify_inventory(path, expected, interesting):
    """Hash complete original roles while extracting only cluster/family metadata."""
    hit = set()
    hasher = hashlib.sha256()
    count = 0
    with path.open("rb") as records:
        for line in records:
            hasher.update(line)
            pairs = IDENTITY.findall(line)
            if len(pairs) != 2 or {k for k, _ in pairs} != {b"family", b"cluster"}:
                raise ValueError(f"missing identity metadata: {path.name}")
            hit.update(interesting.intersection(value.decode() for _, value in pairs))
            count += 1
    if hasher.hexdigest() != expected["sha256"] or count != expected["rows"]:
        raise ValueError(f"inventory mismatch: {path.name}")
    return hit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", type=Path)
    parser.add_argument("original_roles", type=Path)
    parser.add_argument("original_selection", type=Path)
    args = parser.parse_args()
    source = args.collection.read_bytes()
    groups = {}
    for line in gzip.decompress(source).splitlines():
        row = json.loads(line)
        keys = groups.setdefault(row["group"], set())
        for child in [row, *row["children"]]:
            values = key_data(child["fen"])
            keys.update((values["family"], values["cluster"]))
    interesting = set.union(*groups.values())
    quarantine = load_quarantine(ROOT)
    hits = {"historicalQuarantine": interesting & (quarantine["families"] | quarantine["clusters"])}
    inventory = json.loads((ROOT / "eval/sparse-pesto-v1/DATA-MANIFEST.json").read_bytes())["files"]
    for f in inventory:
        hits[f["role"]] = verify_inventory(args.original_roles / f["path"], f, interesting)
    hits["oldOOD"] = verify_inventory(args.original_selection, {"rows": 4096, "sha256": SELECTION_SHA256}, interesting)
    excluded = {g: sorted(k for k, v in hits.items() if v & ids) for g, ids in groups.items()}
    print(json.dumps({"schema": "chessy.sparse-hard-position-family-exclusions.v1",
                      "collectionSha256": hashlib.sha256(source).hexdigest(),
                      "method": "Exclude entire game if any root or chosen child matches a protected cluster or structural family, including file/color symmetry. Original labels unread.",
                      "originalRoleSha256": {f["role"]: f["sha256"] for f in inventory},
                      "originalSelectionSha256": SELECTION_SHA256, "quarantine": quarantine["manifest"],
                      "excludedGroups": {g: reason for g, reason in sorted(excluded.items()) if reason}},
                     sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
