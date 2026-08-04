"""End-to-end feasibility run.

For each fixture:
  1. build the minimal contrastive tree (engine PV + natural-move refutation)
  2. run the recursive labeller (rule-based reasoner standing in for LLM
     sub-calls) with semantic backup
  3. run the static position-only baseline (ablation)
  4. compare both against expected labels

Prints a table + summary stats: tree sizes, timing, and the projected
LLM sub-call budget for the real recursive-LLM version.
"""
import sys, time, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import chess
from src.tactictree.engine import Engine
from src.tactictree.tree import build_contrastive_tree
from src.tactictree.recursion import compose_root, static_baseline
from src.tactictree.reasoner import RuleBasedReasoner
from src.tactictree.features import material_cp
from src.tactictree.labels import Motif
from fixtures.positions import fixtures


def fmt(motifs):
    return ",".join(m.value for m in motifs) or "-"


def make_reasoner(kind, model, usage, root_mat):
    if kind == "openrouter":
        from src.tactictree.reasoner import OpenRouterReasoner
        return OpenRouterReasoner(model=model, usage=usage)
    return RuleBasedReasoner(root_mat)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--reasoner", choices=["rules", "openrouter"],
                    default="rules")
    ap.add_argument("--model", default="google/gemini-3.6-flash")
    ap.add_argument("--depth", type=int, default=14)
    args = ap.parse_args()
    usage = {"in": 0, "out": 0}
    eng = Engine(depth=args.depth, multipv=3)
    rows, total_nodes, total_calls, t0 = [], 0, 0, time.time()
    hits_tree = hits_static = 0

    for name, board, expected in fixtures():
        pov = board.turn
        t = time.time()
        root = build_contrastive_tree(board, eng, max_plies=6)
        reasoner = make_reasoner(args.reasoner, args.model, usage,
                                 material_cp(board, pov))
        report = compose_root(root, reasoner, pov)
        dt = time.time() - t

        static = set(static_baseline(board, pov))
        tree_set = set(report.motifs)
        ok_tree = expected <= tree_set
        ok_static = expected <= static
        hits_tree += ok_tree
        hits_static += ok_static
        total_nodes += report.node_count
        total_calls += report.llm_subcalls_simulated

        rows.append((name, fmt(sorted(expected)), fmt(static),
                     fmt(report.motifs), "Y" if ok_tree else "n",
                     "Y" if ok_static else "n",
                     report.best_move_san, report.natural_move_san or "-",
                     report.node_count, f"{dt:.1f}s"))
        print(f"\n=== {name} ===")
        print(f"  FEN: {report.root_fen}")
        print(f"  best {report.best_move_san} ({report.eval_best_cp:+d}cp)"
              f"  natural {report.natural_move_san} "
              f"({report.eval_natural_cp}cp)")
        print(f"  static-only : {fmt(static)}")
        print(f"  recursive   : {fmt(report.motifs)}")
        if report.llm_motifs is not None:
            print(f"  llm-composed: {fmt(report.llm_motifs)}"
                  f"  <- {report.llm_narrative[:150]}")
        print(f"  narrative   : {report.narrative[:220]}")

    n = len(rows)
    print("\n" + "=" * 78)
    print(f"{'fixture':32}{'expected':14}{'static':16}{'tree✓':6}{'static✓':8}")
    for r in rows:
        print(f"{r[0]:32}{r[1]:14}{r[2]:16}{r[4]:6}{r[5]:8}")
    print("=" * 78)
    print(f"recall  — recursive tree: {hits_tree}/{n}   "
          f"static baseline: {hits_static}/{n}")
    print(f"avg tree size: {total_nodes/n:.1f} nodes | "
          f"avg simulated LLM sub-calls: {total_calls/n:.1f}/position | "
          f"wall time {time.time()-t0:.0f}s")
    if args.reasoner == "openrouter":
        cost = usage["in"] / 1e6 * 1.50 + usage["out"] / 1e6 * 7.50
        print(f"OpenRouter usage: {usage['in']} in / {usage['out']} out "
              f"tokens ≈ ${cost:.4f} ({args.model}; gemini-3.6-flash rates)")
    else:
        print("cost projection (real sub-calls, ~700 tok/call): "
              f"~{int(total_calls/n)} calls ≈ {(total_calls/n)*700/1000:.0f}K "
              "tokens/position")
    eng.close()


if __name__ == "__main__":
    main()
