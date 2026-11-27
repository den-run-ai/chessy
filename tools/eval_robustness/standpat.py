"""Trace actual r85 stand-pat visits, verify the tree against WASM and label them offline."""
import argparse
from collections import defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import tempfile

import chess
import chess.engine

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
EVIDENCE = REPO / "eval/eval-robustness-v1"
GAMES = REPO / "eval/eval-production-v1/games.jsonl"
MODELS = ["hce", "full", "noPawn", "half"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def roots():
    raw = GAMES.read_bytes()
    records = []
    for game in map(json.loads, raw.splitlines()):
        if game["timeMs"] != 25:
            continue
        moves = game["fullMoves"]
        opening_length = len(moves) - game["postOpeningPlies"]
        board = chess.Board()
        history = [board.fen(en_passant="fen")]
        for ply, move in enumerate(moves, 1):
            board.push_uci(move)
            history.append(board.fen(en_passant="fen"))
            if ply - opening_length in (8, 32, 64) and ply < len(moves):
                records.append(dict(game=game["scheduleId"], opening=game["openingId"],
                                    ply=ply, history=history.copy()))
    return records, digest(raw)


def run_trace(rustc, roots, temp, no_pawn_crate=None):
    inputs = {}
    source_dir = (no_pawn_crate / "src") if no_pawn_crate else REPO / "experiments/wasm/src"
    flags = []
    if no_pawn_crate:
        flags = ["--cfg", "eval_pipeline_no_pawn", "--cfg", "eval_pipeline_simd"]
        (temp / "eval_pipeline").mkdir()
        for name in ("core.rs", "model.rs", "hce_constants.rs", "simd.rs"):
            raw = (source_dir / "eval_pipeline" / name).read_bytes()
            (temp / "eval_pipeline" / name).write_bytes(raw)
            inputs["eval_pipeline/" + name] = digest(raw)
    for name in ("engine", "eval", "search", "standpat"):
        path = (HERE if name == "standpat" else source_dir) / f"{name}.rs"
        raw = path.read_bytes()
        inputs[name] = digest(raw)
        if name == "standpat" and no_pawn_crate:
            raw += (b'\n#[path = "eval_pipeline/core.rs"] mod pipeline_core;\n'
                    b'#[path = "eval_pipeline/simd.rs"] mod simd;\n')
        if name == "search":
            anchor = b"        best = eval::evaluate(position);\n"
            assert raw.count(anchor) == 1
            raw = raw.replace(anchor, anchor +
                              b"        crate::observe(position, best, alpha, beta, qply);\n")
        (temp / f"{name}.rs").write_bytes(raw)
    binary = temp / "trace"
    subprocess.run([rustc, *flags, "--edition=2021", "-Copt-level=3", str(temp / "standpat.rs"),
                    "-o", str(binary)], check=True)
    histories = "".join("\t".join(r["history"]) + "\n" for r in roots)
    result = subprocess.run([binary], input=histories, text=True, capture_output=True, check=True)
    events, signatures = [], []
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if fields[0] == "R":
            index, *signature = map(int, fields[1:])
            assert index == len(signatures)
            signatures.append(signature)
        else:
            assert fields[0] == "E"
            root, stratum, visits, ordinal, qply, score, bound = map(int, fields[1:-1])
            events.append(dict(root=root, stratum=stratum, visits=visits, ordinal=ordinal,
                               qply=qply, tracedScore=score, bound=bound, fen=fields[-1]))
    assert len(signatures) == len(roots)
    return events, signatures, inputs


def wasm_scores(modules, roots, signatures, events, origin):
    fens = sorted({event["fen"] for event in events})
    command = ["node", str(REPO / "tools/eval_pipeline/host.mjs"),
               "--loader", str(REPO / "assets/wasm-engine.js"),
               "--rules", str(REPO / "assets/engine.js")]
    for name, path in modules.items():
        command.extend(["--wasm", f"{name}={path.resolve()}"])
    requests = [dict(op="info")]
    for r in roots:
        requests.append(dict(op="search", engine=origin, fen=r["history"][-1],
                             historyFens=r["history"], rootSeed=0xC0FFEE, nodeLimit=10000,
                             timeMs=0, maxDepth=111))
    for fen in fens:
        requests.extend(dict(op="evaluate", fen=fen, engine=m) for m in modules)
    payload = "".join(json.dumps(dict(id=i, **r)) + "\n" for i, r in enumerate(requests))
    out = subprocess.run(command, input=payload, text=True, capture_output=True, check=True)
    rows = []
    for request, line in enumerate(out.stdout.splitlines()):
        row = json.loads(line)
        assert row["ok"] and row["id"] == request, row
        rows.append(row["result"])
    assert len(rows) == len(requests)
    for expected, row in zip(signatures, rows[1:]):
        move = row["move"]
        packed = (move["from"] | (move["to"] << 6) |
                  (" QRBN".index((move["promotion"] or " ").upper()) << 12)) if move else 0xffffffff
        actual = [row[k] for k in ("score", "depth", "nodes", "qnodes")] + [packed]
        assert actual == expected, (actual, expected)
    results = iter(rows[1 + len(roots):])
    scores = {}
    for fen in fens:
        hce, full, no_pawn = (next(results)["score"] for _ in modules)
        half = hce + int((no_pawn - hce) / 2)
        scores[fen] = dict(zip(MODELS, [hce, full, no_pawn, half]))
    for e in events:
        assert e["tracedScore"] == scores[e["fen"]][{"hce": "hce", "nopawn": "noPawn"}[origin]]
        e["scores"] = scores[e["fen"]]
    return {k: v["sha256"] for k, v in rows[0]["engines"].items()}


def teacher_labels(path, events, temp):
    # Execute a private copy of the bytes identified here.
    raw = path.read_bytes()
    binary = temp / path.name
    binary.write_bytes(raw)
    binary.chmod(0o500)
    cache = {}
    for fen in sorted({e["fen"] for e in events}):
        # Chatarunga retains search state across UCI new-game commands.
        # A new OS process isolates each leaf, including the first.
        with chess.engine.SimpleEngine.popen_uci(str(binary), timeout=30) as engine:
            for key, value in (("Threads", 1), ("Hash", 16)):
                if key in engine.options:
                    engine.configure({key: value})
            board = chess.Board(fen)
            assert board.is_valid() and not board.is_check() and not board.is_game_over()
            info = engine.analyse(board, chess.engine.Limit(nodes=12000))
            value = info["score"].white()
            cache[fen] = dict(cp=value.score(), mate=value.mate(), depth=info["depth"],
                              nodes=info["nodes"], bounded=bool(info.get("lowerbound") or
                                                               info.get("upperbound")))
            identity = engine.id
    return cache, dict(sha256=digest(raw), id=identity)



def summarize(events, teacher, stratum):
    selected = [e for e in events if e["stratum"] == stratum]
    report = dict(sampled=len(selected), bounded=0, mate=0, byModel={})
    for field in ("bounded", "mate"):
        report[field] = sum(1 for e in selected if e["labels"][teacher][field] not in (None, False))
    for model in MODELS:
        grouped = defaultdict(lambda: defaultdict(list))
        for e in selected:
            label = e["labels"][teacher]
            if label["bounded"]:
                continue
            group = grouped[e["root"]]
            value = label["cp"]
            estimate = e["scores"][model]
            if value is None:
                value = 3000 if label["mate"] > 0 else -3000
            else:
                error = abs(estimate - value)
                group["maeCp"].append(error)
                group["errorAtLeast200"].append(error >= 200)
            direction = 1 if e["fen"].split()[1] == "w" else -1
            stop = direction * (estimate - e["bound"]) >= 0
            target = direction * (value - e["bound"]) >= 0
            group["adverseStop"].append(stop and not target)
            group["missedStop"].append(not stop and target)
            group["cutoffDisagreement"].append(stop != target)
        metric = {}
        for key in sorted({k for group in grouped.values() for k in group}):
            metric[key] = statistics.fmean(statistics.fmean(g[key]) for g in grouped.values() if g[key])
        report["byModel"][model] = metric
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("rustc", "full", "no-pawn", "hce", "chatarunga", "sf11", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--no-pawn-crate", type=Path,
                        help="trace the #202 unscaled no-pawn tree instead of HCE")
    args = parser.parse_args()
    origin = "nopawn" if args.no_pawn_crate else "hce"
    args.output.mkdir(exist_ok=False)
    records, games_sha = roots()
    with tempfile.TemporaryDirectory() as work:
        temp = Path(work)
        events, signatures, source_ids = run_trace(args.rustc.resolve(), records, temp, args.no_pawn_crate)
        module_ids = wasm_scores(dict(hce=args.hce, full=args.full, nopawn=args.no_pawn),
                                 records, signatures, events, origin)
        teachers = {}
        for name in ("sf11", "chatarunga"):
            labels, teachers[name] = teacher_labels(getattr(args, name), events, temp)
            for event in events:
                event.setdefault("labels", {})[name] = labels[event["fen"]]
    for i, record in enumerate(records):
        record["fen"] = record.pop("history")[-1]
        record["signature"] = signatures[i]
    ledger = json.dumps(dict(roots=records, events=events), separators=(",", ":")).encode()
    packed = gzip.compress(ledger, mtime=0)
    (args.output / f"standpat-{origin}-events.json.gz").write_bytes(packed)
    report = dict(tracedEngine=origin, roots=len(records), games=len({r["game"] for r in records}),
                  openings=len({r["opening"] for r in records}), uniqueFens=len({e["fen"] for e in events}),
                  events=len(events), wasmRootSignaturesChecked=len(signatures),
                  ledgerSha256=digest(ledger), modules=module_ids, teachers=teachers,
                  protocolSha256=digest((EVIDENCE / "standpat-protocol.json").read_bytes()),
                  sourceSha256=source_ids, samplerSha256=digest(Path(__file__).read_bytes()),
                  gameCorpusSha256=games_sha,
                  rustc=subprocess.check_output([args.rustc, "--version"], text=True).strip(),
                  results={t: {name: summarize(events, t, i) for i, name in enumerate(
                      ("uniformVisits", "within50CpOfTracedCutoff"))} for t in teachers})
    (args.output / f"standpat-{origin}-results.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
