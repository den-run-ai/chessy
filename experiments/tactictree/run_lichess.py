"""Evaluate tactictree on a theme-stratified Lichess puzzle sample.

Per puzzle (position = FEN + opponent's setup move Moves[0]):

  static   — position-only rule baseline (the ablation)
  rules    — contrastive tree + RuleBasedReasoner + deterministic
             intermezzo contrast rule (no LLM)
  llm      — contrastive tree + OpenRouter per-node sub-calls (best branch)
             + tree-level compose call + the deterministic contrast rule:
             the full hybrid system
  llm_only — motifs from LLM annotations alone (root + best-line nodes +
             compose), i.e. WITHOUT the deterministic intermezzo rule —
             the pure recursive-LLM labeller

Hit = any mapped motif of the SAMPLED theme appears in the prediction set
(recall on the sampled theme; co-occurring tags are not scored).

Output is incremental JSONL (one record per puzzle, flushed immediately);
re-running skips ids already present, and the .llmcache makes repeated LLM
calls free. A hard cap on estimated spend protects $-limited keys.
"""
import argparse
import csv
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import chess
from src.tactictree.engine import Engine
from src.tactictree.tree import build_contrastive_tree
from src.tactictree.recursion import compose_root, static_baseline, _line
from src.tactictree.reasoner import RuleBasedReasoner, OpenRouterReasoner
from src.tactictree.features import material_cp
from src.tactictree.labels import Motif, BRANCH_BEST, BRANCH_NATURAL

THEME_MAP = {
    "intermezzo":       {Motif.INTERMEZZO},
    "fork":             {Motif.FORK},
    "pin":              {Motif.PIN},
    "skewer":           {Motif.SKEWER},
    "discoveredAttack": {Motif.DISCOVERED_ATTACK, Motif.DISCOVERED_CHECK},
    "deflection":       {Motif.DEFLECTION},
    "hangingPiece":     {Motif.HANGING_PIECE},
    "mateIn2":          {Motif.MATE_THREAT},
}

IN_RATE, OUT_RATE = 1.50, 7.50   # $/M tokens, google/gemini-3.6-flash


def llm_only_motifs(root, report) -> set:
    """LLM-attributed motifs only: root + best-line node annotations (which,
    after an LLM compose_root pass, are the LLM's) + the compose judgment.
    Excludes the deterministic intermezzo rule's insertion."""
    got = set()
    if root.annotation:
        got |= set(root.annotation.motifs)
    best_head = next((c for c in root.children if c.branch == BRANCH_BEST), None)
    if best_head:
        for n in _line(best_head):
            if n.annotation:
                got |= set(n.annotation.motifs)
    if report.llm_motifs:
        got |= set(report.llm_motifs)
    return got


def fmt(ms) -> list:
    return sorted(m.value for m in ms)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--puzzles", default="lichess/puzzles_50.csv")
    ap.add_argument("--out", default="lichess/results_gemini-3.6-flash.jsonl")
    ap.add_argument("--model", default="google/gemini-3.6-flash")
    ap.add_argument("--depth", type=int, default=14)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--cap-usd", type=float, default=2.30)
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--in-rate", type=float, default=IN_RATE,
                    help="$/M prompt tokens (cap math + est display)")
    ap.add_argument("--out-rate", type=float, default=OUT_RATE)
    ap.add_argument("--no-reasoning", action="store_true",
                    help="disable provider-side reasoning (distinct cache keys)")
    args = ap.parse_args()
    in_rate, out_rate = args.in_rate, args.out_rate

    here = pathlib.Path(__file__).parent
    outp = here / args.out
    outp.parent.mkdir(exist_ok=True)
    done = set()
    if outp.exists():
        for line in outp.read_text().splitlines():
            try:
                r = json.loads(line)
                if "hits" in r:            # errored puzzles get retried
                    done.add(r["id"])
            except Exception:
                pass

    rows = list(csv.DictReader(open(here / args.puzzles)))
    if args.limit:
        rows = rows[: args.limit]

    # Round-robin across themes: the CSV is theme-grouped, so a spend-cap
    # halt would otherwise drop the tail themes entirely; interleaved, it
    # degrades every theme's n uniformly instead.
    by_theme = {}
    for r in rows:
        by_theme.setdefault(r["sampled_theme"], []).append(r)
    rows = []
    while any(by_theme.values()):
        for t in list(by_theme):
            if by_theme[t]:
                rows.append(by_theme[t].pop(0))

    usage = {"in": 0, "out": 0}
    eng = Engine(depth=args.depth, multipv=3)
    try:
        eng._e.configure({"Threads": 3, "Hash": 256})
    except Exception:
        pass

    t0 = time.time()
    stopped = False
    with open(outp, "a") as fh:
        for i, row in enumerate(rows):
            if row["puzzle_id"] in done:
                continue
            est = usage["in"] / 1e6 * in_rate + usage["out"] / 1e6 * out_rate
            if est >= args.cap_usd:
                print(f"SPEND CAP: est ${est:.2f} >= ${args.cap_usd} — "
                      f"stopping before puzzle {i + 1}/{len(rows)}", flush=True)
                stopped = True
                break

            board = chess.Board(row["fen"])
            moves = row["moves"].split()
            board.push(chess.Move.from_uci(moves[0]))
            pov = board.turn
            expect = THEME_MAP[row["sampled_theme"]]
            t = time.time()
            rec = {"id": row["puzzle_id"], "theme": row["sampled_theme"],
                   "rating": int(row["rating"]), "themes_all": row["themes"]}
            try:
                root = build_contrastive_tree(board, eng, max_plies=6)
                best_head = next((c for c in root.children
                                  if c.branch == BRANCH_BEST), None)
                nat_head = next((c for c in root.children
                                 if c.branch == BRANCH_NATURAL), None)

                static = set(static_baseline(board, pov))
                rules_rep = compose_root(
                    root, RuleBasedReasoner(material_cp(board, pov)), pov)
                rules_set = set(rules_rep.motifs)

                rec.update({
                    "best_san": rules_rep.best_move_san,
                    "engine_matches_solution":
                        bool(best_head and best_head.move_in.uci() == moves[1]),
                    "natural_exists": nat_head is not None,
                    "nodes": rules_rep.node_count,
                    "static": fmt(static),
                    "rules": fmt(rules_set),
                })

                if not args.no_llm:
                    r = OpenRouterReasoner(
                        model=args.model, usage=usage,
                        cache_dir=str(here / ".llmcache"),
                        reasoning={"enabled": False} if args.no_reasoning else None)
                    llm_rep = compose_root(root, r, pov)
                    llm_set = set(llm_rep.motifs) | set(llm_rep.llm_motifs or [])
                    lonly = llm_only_motifs(root, llm_rep)
                    rec.update({
                        "llm": fmt(llm_set),
                        "llm_only": fmt(lonly),
                        "compose": fmt(llm_rep.llm_motifs or []),
                        "compose_narrative": llm_rep.llm_narrative[:200],
                        "llm_calls": r.calls,
                    })
                else:
                    llm_set, lonly = set(), set()

                rec["hits"] = {
                    "static": bool(expect & static),
                    "rules": bool(expect & rules_set),
                    "llm": bool(expect & llm_set),
                    "llm_only": bool(expect & lonly),
                }
            except Exception as e:
                rec["error"] = f"{type(e).__name__}: {e}"[:250]
            rec["dt"] = round(time.time() - t, 1)
            rec["cum_tokens"] = dict(usage)
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            h = rec.get("hits", {})
            print(f"[{i + 1}/{len(rows)}] {rec['id']:6} {rec['theme']:17} "
                  f"r{rec['rating']} "
                  f"static={'Y' if h.get('static') else 'n'} "
                  f"rules={'Y' if h.get('rules') else 'n'} "
                  f"llm={'Y' if h.get('llm') else 'n'} "
                  f"llmOnly={'Y' if h.get('llm_only') else 'n'} "
                  f"{rec['dt']:5.1f}s est=${usage['in'] / 1e6 * in_rate + usage['out'] / 1e6 * out_rate:.3f}"
                  + (f"  ERR {rec['error']}" if "error" in rec else ""),
                  flush=True)
    eng.close()

    # ---- summary over the FULL results file --------------------------------
    recs = [json.loads(l) for l in outp.read_text().splitlines() if l.strip()]
    ok = [r for r in recs if "hits" in r]
    errs = [r for r in recs if "error" in r]
    cols = ["static", "rules", "llm", "llm_only"]
    print("\n" + "=" * 74)
    print(f"{'theme':18}{'n':>3} {'static':>8} {'rules':>8} {'llm':>8} {'llmOnly':>8}")
    themes = list(dict.fromkeys(r["theme"] for r in ok))
    for t in themes:
        sub = [r for r in ok if r["theme"] == t]
        cells = [sum(r["hits"][c] for r in sub) for c in cols]
        print(f"{t:18}{len(sub):>3} " +
              " ".join(f"{c:>7}" for c in
                       (f"{v}/{len(sub)}" for v in cells)))
    print("-" * 74)
    tot = [sum(r["hits"][c] for r in ok) for c in cols]
    print(f"{'TOTAL':18}{len(ok):>3} " +
          " ".join(f"{c:>7}" for c in (f"{v}/{len(ok)}" for v in tot)))
    print(f"\nengine best == puzzle solution: "
          f"{sum(r['engine_matches_solution'] for r in ok)}/{len(ok)}"
          f" | natural branch existed: "
          f"{sum(r['natural_exists'] for r in ok)}/{len(ok)}"
          f" | errors: {len(errs)}")
    est = usage["in"] / 1e6 * in_rate + usage["out"] / 1e6 * out_rate
    print(f"this session: {usage['in']} in / {usage['out']} out tokens "
          f"≈ ${est:.4f} | wall {time.time() - t0:.0f}s"
          + (" | STOPPED AT SPEND CAP" if stopped else ""))


if __name__ == "__main__":
    main()
