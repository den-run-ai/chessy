#!/usr/bin/env python3
"""Exact native parity on retained validation FENs, without opening labels.

Timing fields are discarded. These are correctness runs, never cost evidence.
The historical full-model scores are authenticated frozen v1 evidence. The
king-model oracle is the same pinned v1 evaluator applied once to these FENs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FEN_SHA = "1f5402d0b61d18f2c8c1dd791d99fc1bcecd2c44956b5bc28c8ed8bcf0c81900"
FULL_SHA = "4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304"
FULL_SCORES_SHA = "489cb41f8ee9dbfd61ed546bbd172804dd51ff82e4f538c4982ae79668fc1df0"
REFERENCE_SHA = "5ac4a988d1b42999deada673b82117a5e9b8fead9d383a841cbc78827d641443"
SIGNATURE = ("row", "candidate", "nodes", "qnodes", "depth", "score", "move")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class Executable:
    def __init__(self, path, expected):
        self.handle = open(path, "rb")
        if sha(self.handle.read()) != expected:
            raise ValueError("executable identity mismatch")
        self.digest = expected

    def run(self, args, data):
        # The authenticated inode itself is executed, without reopening a path.
        fd = self.handle.fileno()
        return subprocess.check_output([f"/proc/self/fd/{fd}", *map(str, args)], input=data, pass_fds=(fd,))


def signature(raw):
    return sorted(tuple(row[key] for key in SIGNATURE) for row in map(json.loads, raw.splitlines()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--wide-build", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fens = (args.work / "packed-v1/validation.fens.txt").read_bytes()
    expected_full = (args.work / "fast-parity-v1/fast.scores.txt").read_bytes()
    full = (ROOT / "eval/sparse-pesto-v1/fit/full.i16le").read_bytes()
    king = (ROOT / "eval/sparse-pesto-v1/fit/king.i16le").read_bytes()
    if sha(fens) != FEN_SHA or sha(full) != FULL_SHA or sha(expected_full) != FULL_SCORES_SHA:
        raise ValueError("frozen FEN/model/full-score evidence differs")
    if len(fens.splitlines()) != 100164 or len(expected_full.splitlines()) != 100164:
        raise ValueError("incomplete validation inventory")
    roots_raw = (args.work / "runtime-v1/positions.json").read_bytes()
    roots = json.loads(roots_raw)
    if len(roots) != 24 or len({row["fen"] for row in roots}) != 24:
        raise ValueError("expected24 distinct original timing roots")
    root_fens = ("\n".join(row["fen"] for row in roots) + "\n").encode()
    builds = {}
    for name, path in (("narrow", args.build), ("wide", args.wide_build)):
        raw = path.read_bytes()
        receipt = json.loads(raw)
        if receipt["schema"] != "chessy.sparse-v2-native-build.v1":
            raise ValueError("wrong build receipt")
        for source, digest in receipt["sourceHashes"].items():
            if sha((ROOT / source).read_bytes()) != digest:
                raise ValueError("working source differs from frozen build:" + source)
        builds[name] = {"receipt": receipt, "sha256": sha(raw)}
    reference = Executable(args.work / "packaged-runtime-v1/sparse-eval-fast", REFERENCE_SHA)
    args.output.mkdir(parents=True, exist_ok=False)
    for name, raw in (("full", full), ("king", king)):
        path = args.output / (name + ".i16le")
        path.write_bytes(raw); path.chmod(0o444)
    expected_king = reference.run(("eval", args.output / "king.i16le"), fens)
    (args.output / "king-reference.scores.txt").write_bytes(expected_king)
    observations = []
    binaries = []
    for precision, information in builds.items():
        model_name = "full" if precision == "narrow" else "king"
        expected = expected_full if precision == "narrow" else expected_king
        for architecture, item in information["receipt"]["native"].items():
            executable = Executable(item["path"], item["sha256"])
            binaries.append((precision, architecture, executable))
            for variant in ("compact", "fused", "cached"):
                actual = executable.run(("eval", args.output / (model_name + ".i16le"), variant), fens)
                if actual != expected:
                    raise ValueError(f"validation parity mismatch:{precision}/{architecture}/{variant}")
                path = args.output / f"{precision}-{architecture}-{variant}.scores.txt"
                path.write_bytes(actual)
                observations.append({"precision": precision, "architecture": architecture, "variant": variant,
                    "model": model_name, "binarySha256": executable.digest, "rows": 100164,
                    "scoresSha256": sha(actual), "referenceScoresSha256": sha(expected), "exact": True})
    search_checks = []
    for nodes in (10000, 36000):
        expected = reference.run(("search", args.output / "full.i16le", nodes, 30), root_fens)
        expected_signature = signature(expected)
        (args.output / f"search-reference-{nodes}.json").write_text(json.dumps(expected_signature) + "\n")
        for precision, architecture, executable in binaries:
            # Every implementation also checks the same full model; wide-fused
            # changes storage width only and must preserve identical work.
            for variant in ("compact", "fused", "cached"):
                actual = executable.run(("search", args.output / "full.i16le", variant, nodes, 30), root_fens)
                actual_signature = signature(actual)
                if actual_signature != expected_signature:
                    raise ValueError(f"search signature mismatch:{precision}/{architecture}/{variant}/{nodes}")
                payload = (json.dumps(actual_signature) + "\n").encode()
                (args.output / f"search-{precision}-{architecture}-{variant}-{nodes}.json").write_bytes(payload)
                search_checks.append({"precision": precision, "architecture": architecture, "variant": variant,
                    "nodeBudget": nodes, "positions": 24, "comparisons": len(actual_signature),
                    "signatureSha256": sha(payload), "exact": True})
    report = {"schema": "chessy.sparse-v2-native-parity.v1", "status": "complete-exact",
              "purpose": "correctness-only-no-labels-no-timing-claims", "sourceSha256": sha(Path(__file__).read_bytes()),
              "buildReceiptSha256": {key: value["sha256"] for key, value in builds.items()},
              "validationFenSha256": sha(fens), "fullWeightsSha256": sha(full), "kingWeightsSha256": sha(king),
              "rootsSha256": sha(roots_raw), "referenceBinarySha256": REFERENCE_SHA,
              "scoreComparisons": sum(item["rows"] for item in observations),
              "searchComparisons": sum(item["comparisons"] for item in search_checks),
              "static": observations, "search": search_checks}
    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(report_path), "sha256": sha(report_path.read_bytes()),
                      "scoreComparisons": report["scoreComparisons"], "searchComparisons": report["searchComparisons"]}, indent=2))


if __name__ == "__main__":
    main()
