#!/usr/bin/env python3
"""Collect prototype evidence into one weight-free JSON and Markdown tables.

Reads the dataset manifest, model cards, module sizes, benches, mate
diagnostics, match summaries and the offline comparison from the data
directory and writes eval/nnue-proto-2026-09/results.json (no weights, no
positions) plus tables on stdout for the report.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def pct(x):
    return f"{100 * x:.1f}%"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="/home/user/data")
    parser.add_argument("--dataset", default="ds2q")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    data = Path(args.data)
    nets = data / "nets"
    matches = data / "matches"

    manifest = load(data / args.dataset / "manifest.json")
    tags = ["h16", "h32", "h64", "h128"]
    extra = sorted(p.stem.replace("-size", "") for p in matches.glob("*-mopup-size.txt"))
    cards = {tag: load(nets / f"{tag}.json") for tag in tags}
    sizes = {}
    for tag in tags + extra:
        text = matches / f"{tag}-size.txt"
        if text.exists():
            sizes[tag] = dict(item.split("=") for item in text.read_text().split())
    benches = {tag: load(matches / f"{tag}-bench.json") for tag in tags + extra}
    mates = {tag: load(matches / f"{tag}-mate.json") for tag in tags + extra}
    goldens = {tag: load(matches / f"{tag}-wasm-goldens.json") for tag in tags}
    match_runs = {}
    for path in sorted(matches.glob("*.summary.json")):
        summary = load(path)
        if summary and "summary" in summary:
            match_runs[path.name.replace(".summary.json", "")] = summary
    offline = load(matches / "offline-comparison.json")

    results = {
        "schema": "chessy.nnue-proto-results.v1",
        "researchOnly": True,
        "formalPass": False,
        "dataset": {k: manifest.get(k) for k in ("schema", "source", "rules", "quarantine", "counts", "splits", "phaseBuckets",
                                                  "stmWhiteFraction", "mateFraction", "cpStats", "outputs", "filteredFrom")} if manifest else None,
        "models": {tag: {k: card.get(k) for k in ("hidden", "config", "quantisation", "history", "validation", "test", "artifacts",
                                                  "parameterBytes", "trainSeconds", "torch")} for tag, card in cards.items() if card},
        "modules": sizes,
        "wasmGoldens": goldens,
        "benches": {tag: {k: b.get(k) for k in ("nodes", "reps", "medianNpsRatio", "p25", "p75", "modules", "perPosition")}
                    for tag, b in benches.items() if b},
        "mateConversion": {tag: {"converted": m["converted"], "total": m["total"], "rows": [{k: r[k] for k in ("name", "won", "plies", "reason")} for r in m["rows"]]}
                           for tag, m in mates.items() if m},
        "matches": {name: {k: run[k] for k in ("modules", "openingBank", "protocol", "elapsedSeconds", "summary")} for name, run in match_runs.items()},
        "offline": offline,
    }
    Path(args.out).write_text(json.dumps(results, indent=1) + "\n")

    # Markdown tables.
    lines = []
    if manifest:
        c, s = manifest["counts"], manifest["splits"]
        lines.append("### Dataset\n")
        lines.append(f"- rows scanned {c['rows']:,}; unique FENs {c['uniqueFens']:,}; kept {c['kept']:,} "
                     f"(train {s['train']:,} / validation {s['validation']:,} / test {s['test']:,})")
        lines.append(f"- dropped: shallow {c['shallow']:,}, in check {c['inCheck']:,}, not quiet {c['notQuiet']:,}, "
                     f"bad {c['badPosition']:,}, quarantined cluster {c['quarantinedCluster']:,}, quarantined family {c['quarantinedFamily']:,}, "
                     f"dev-bank cluster {c.get('quarantinedDevBankCluster', 0):,}, dev-bank family {c.get('quarantinedDevBankFamily', 0):,}")
        lines.append(f"- mate-labelled fraction {pct(manifest['mateFraction'])}; white to move {pct(manifest['stmWhiteFraction'])}; "
                     f"phase buckets (train) {manifest['phaseBuckets']['train']}\n")
    lines.append("### Models\n")
    lines.append("| Net | Params (bytes) | Train MSE | Val MSE (float) | Val MSE (quantised) | Test MSE (quantised) | Val cp MAE | Quantisation cp MAE / max | Accumulator bound | Train s |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for tag, card in cards.items():
        if not card:
            continue
        v, t = card["validation"], card["test"]
        train_mse = [h for h in card["history"] if "trainMse" in h][-1]["trainMse"]
        lines.append(f"| {tag} | {card['parameterBytes']:,} | {train_mse:.5f} | {v['float']['mse']:.5f} | {v['quantised']['mse']:.5f} | "
                     f"{t['quantised']['mse']:.5f} | {v['quantised']['cpMae']:.1f} | {v['quantisationCpMae']:.2f} / {v['quantisationCpMax']:.0f} | "
                     f"{card['quantisation']['accumulatorBound']} | {card['trainSeconds']:.0f} |")
    if offline:
        lines.append("\n### Offline teacher loss (MSE on expected score; scale fitted per evaluator on validation)\n")
        lines.append("| Evaluator | fitted k | validation | test | val opening | val middlegame | val endgame |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for name, e in offline["evaluators"].items():
            bp = e["validation"]["byPhase"]
            lines.append(f"| {name} | {e['fittedScale']:.2f} | {e['validation']['mseAtFittedScale']:.5f} | {e['test']['mseAtFittedScale']:.5f} | "
                         f"{bp['opening']:.5f} | {bp['middlegame']:.5f} | {bp['endgame']:.5f} |")
        lines.append(f"| constant predictor | – | {offline['constantReference']['validation']:.5f} | {offline['constantReference']['test']:.5f} | | | |")
    lines.append("\n### Modules, throughput and lone-king conversion\n")
    lines.append("| Module | Pages | Raw bytes | Brotli bytes | Median NPS ratio (p25–p75) | WASM goldens | Mate conversion |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for tag in tags + extra:
        size = sizes.get(tag)
        if not size:
            continue
        bench = benches.get(tag)
        mate = mates.get(tag)
        gold = goldens.get(tag)
        lines.append(f"| {tag} | {size['pages']} | {int(size['bytes']):,} | {int(size['brotli']):,} | "
                     f"{bench['medianNpsRatio']:.3f} ({bench['p25']:.3f}–{bench['p75']:.3f}) | " if bench else f"| {tag} | {size['pages']} | {int(size['bytes']):,} | {int(size['brotli']):,} | n/a | ")
        lines[-1] += (f"{gold['checked']}/{gold['checked'] - gold['mismatches']} ok | " if gold else "– | ")
        lines[-1] += (f"{mate['converted']}/{mate['total']} |" if mate else "– |")
    lines.append("\n### Development matches vs shipped HCE (dev bank, both colours)\n")
    lines.append("| Run | Budget | Games | W–D–L | Score | 95% CI (opening-clustered) | One-sided LB | Elo (CI) | NPS ratio | Ply-cap draws |")
    lines.append("| --- | --- | ---: | --- | ---: | --- | ---: | --- | ---: | ---: |")
    for name, run in match_runs.items():
        s = run["summary"]
        b = s["budget"]
        budget = f"{b['nodes']:,} nodes" if b["nodes"] else f"{b['timeMs']} ms"
        ci = s["openingClustered"]["ci95"]
        elo = s["eloEstimate"]
        lines.append(f"| {name} | {budget} | {s['games']} | {s['wins']}–{s['draws']}–{s['losses']} | {pct(s['score'])} | "
                     f"{pct(ci[0])}–{pct(ci[1])} | {pct(s['openingClustered']['oneSidedLower95'])} | "
                     f"{elo['point']} ({elo['ci95'][0]} … {elo['ci95'][1]}) | {s['npsRatio']:.3f} | {s['reasons'].get('ply-cap', 0)} |")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
