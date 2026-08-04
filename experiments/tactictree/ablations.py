"""The two mechanism ablations from REPORT.md §5, sized to a strict
leftover budget (~$0.45 on the key).

A. --mode mono: the ENTIRE contrastive tree serialized into ONE prompt.
   Does the recursive decomposition beat a single long-context judgment?
   Run paired against the main run on the first 2 puzzles per theme.

B. --mode nobackup: identical recursion, but child labels are withheld
   from every node prompt. Scored, like the main run, on the UNION of node
   labels + compose — so a motif caught at its own node still counts, and
   what this isolates is whether upward label-passing is load-bearing for
   recall or only for narratives/precision. Run on 6 puzzles the main run
   HIT, so losses are directly attributable. Leaf and root prompts are
   byte-identical to the main run (their children list was already empty),
   so they replay free from .llmcache.

Note: trees are rebuilt (engine analysis is not cached; Threads=3 like the
main run), so minor eval/PV drift vs the main run's trees is possible.
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
from src.tactictree.recursion import compose_root, _line
from src.tactictree.reasoner import OpenRouterReasoner
from src.tactictree.features import node_features
from src.tactictree.labels import Motif, BRANCH_BEST, BRANCH_NATURAL
from run_lichess import THEME_MAP, llm_only_motifs, IN_RATE, OUT_RATE

HERE = pathlib.Path(__file__).parent

MONO_PROMPT = (
    "You are a chess tactics classifier. You see a MINIMAL CONTRASTIVE "
    "ANALYSIS TREE for one position: the engine's best line versus the "
    "'natural' human reply (e.g. automatic recapture), with engine evals.\n"
    "Root position (FEN): {fen}, {pov} to move.\n"
    "BEST line (SAN, eval in cp for {pov} after each ply):\n{best}\n"
    "NATURAL line and its refutation:\n{nat}\n"
    "Per-ply board features along the best line (JSON):\n{feats}\n\n"
    "Identify ALL tactical motifs present in the tree, including tree-level "
    "motifs that only exist in the contrast between the two lines (e.g. an "
    "intermezzo: a forcing in-between move played INSTEAD of the natural "
    "reply, after which the deferred gain still lands). Allowed ids: fork, "
    "pin, skewer, discoveredAttack, discoveredCheck, intermezzo, deflection, "
    "hangingPiece, mateThreat, quiet.\n"
    'Reply with STRICT JSON only: {{"motifs": ["..."], "narrative": "<=30 words"}}'
)

NOBACKUP_IDS = ["0F9xB", "09uWW", "07dgW", "00mvr", "04qGt", "01yqP"]


class NoBackupReasoner(OpenRouterReasoner):
    """Node calls never see child labels — the semantic backup is severed."""

    def label_node(self, board, move_in, pov, child_annotations):
        return super().label_node(board, move_in, pov, [])


def compact_feats(node, board_root, pov):
    f = node_features(node.board, node.move_in, pov)
    out = {"ply": node.ply, "eval_cp": node.eval_cp}
    for k in ("checks", "mate", "discovered_check"):
        if f.get(k):
            out[k] = True
    if f.get("pins"):
        out["pins"] = [p["square"] for p in f["pins"]]
    if f.get("hanging"):
        out["hanging"] = [h["square"] for h in f["hanging"]]
    if f.get("fork_targets"):
        out["fork_targets"] = [t["square"] for t in f["fork_targets"]]
    return out


def san_walk(root_board, head):
    b, parts = root_board.copy(), []
    for n in _line(head):
        parts.append(f"{b.san(n.move_in)} ({n.eval_cp if n.eval_cp is not None else '?'}cp)")
        b.push(n.move_in)
    return " ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["mono", "nobackup"], required=True)
    ap.add_argument("--cap-usd", type=float, required=True,
                    help="stop when the SHARED ablations spend estimate reaches this")
    args = ap.parse_args()

    main_res = {}
    for l in open(HERE / "lichess/results_gemini-3.6-flash.jsonl"):
        r = json.loads(l)
        if "hits" in r:
            main_res[r["id"]] = r

    rows = list(csv.DictReader(open(HERE / "lichess/puzzles_50.csv")))
    if args.mode == "mono":
        cnt = {}
        subset = []
        for r in rows:
            t = r["sampled_theme"]
            if cnt.get(t, 0) < 2:
                cnt[t] = cnt.get(t, 0) + 1
                subset.append(r)
    else:
        subset = [r for r in rows if r["puzzle_id"] in NOBACKUP_IDS]

    # shared spend meter across both ablation modes, persisted on disk
    meter_p = HERE / "lichess/ablations_spend.json"
    usage = json.loads(meter_p.read_text()) if meter_p.exists() else {"in": 0, "out": 0}

    outp = HERE / "lichess/ablations.jsonl"
    done = set()
    if outp.exists():
        for l in open(outp):
            try:
                j = json.loads(l)
                done.add((j["mode"], j["id"]))
            except Exception:
                pass

    eng = Engine(depth=14, multipv=3)
    try:
        eng._e.configure({"Threads": 3, "Hash": 256})
    except Exception:
        pass

    flips = {"lost": [], "gained": []}
    n_hit = n_base_hit = n_done = 0
    with open(outp, "a") as fh:
        for row in subset:
            if (args.mode, row["puzzle_id"]) in done:
                continue
            est = usage["in"] / 1e6 * IN_RATE + usage["out"] / 1e6 * OUT_RATE
            if est >= args.cap_usd:
                print(f"SPEND CAP: ${est:.3f} >= ${args.cap_usd}", flush=True)
                break
            board = chess.Board(row["fen"])
            board.push(chess.Move.from_uci(row["moves"].split()[0]))
            pov = board.turn
            expect = THEME_MAP[row["sampled_theme"]]
            base = main_res.get(row["puzzle_id"], {})
            t = time.time()
            rec = {"mode": args.mode, "id": row["puzzle_id"],
                   "theme": row["sampled_theme"], "rating": int(row["rating"])}
            try:
                root = build_contrastive_tree(board, eng, max_plies=6)
                best_head = next((c for c in root.children
                                  if c.branch == BRANCH_BEST), None)
                nat_head = next((c for c in root.children
                                 if c.branch == BRANCH_NATURAL), None)
                r = (OpenRouterReasoner if args.mode == "mono"
                     else NoBackupReasoner)(model="google/gemini-3.6-flash",
                                            usage=usage,
                                            cache_dir=str(HERE / ".llmcache"))
                if args.mode == "mono":
                    feats = [compact_feats(n, board, pov)
                             for n in ([root] + (_line(best_head) if best_head else []))]
                    prompt = MONO_PROMPT.format(
                        fen=board.fen(), pov="white" if pov else "black",
                        best=san_walk(board, best_head) if best_head else "(none)",
                        nat=san_walk(board, nat_head) if nat_head
                            else "(no natural move identified)",
                        feats=json.dumps(feats))
                    got = set(r._to_ann(r._call(prompt)).motifs)
                    rec["narrative"] = ""
                else:
                    rep = compose_root(root, r, pov)
                    got = llm_only_motifs(root, rep)
                    rec["narrative"] = rep.llm_narrative[:120]
                hit = bool(expect & got)
                base_hit = bool(base.get("hits", {}).get("llm_only"))
                rec.update({"motifs": sorted(m.value for m in got), "hit": hit,
                            "main_llm_only": base.get("llm_only"),
                            "main_hit": base_hit, "calls": r.calls})
                n_hit += hit
                n_base_hit += base_hit
                n_done += 1
                if base_hit and not hit:
                    flips["lost"].append(row["puzzle_id"])
                if hit and not base_hit:
                    flips["gained"].append(row["puzzle_id"])
            except Exception as e:
                rec["error"] = f"{type(e).__name__}: {e}"[:200]
                if "402" in rec["error"]:
                    fh.write(json.dumps(rec) + "\n")
                    print("402 — key exhausted, stopping", flush=True)
                    break
            rec["dt"] = round(time.time() - t, 1)
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            meter_p.write_text(json.dumps(usage))
            est = usage["in"] / 1e6 * IN_RATE + usage["out"] / 1e6 * OUT_RATE
            print(f"[{args.mode}] {rec['id']:6} {rec['theme']:17} "
                  f"hit={'Y' if rec.get('hit') else 'n'}"
                  f"(main {'Y' if rec.get('main_hit') else 'n'}) "
                  f"{rec.get('motifs')} est=${est:.3f}"
                  + (f" ERR {rec['error']}" if "error" in rec else ""), flush=True)
    eng.close()
    meter_p.write_text(json.dumps(usage))
    est = usage["in"] / 1e6 * IN_RATE + usage["out"] / 1e6 * OUT_RATE
    print(f"\n{args.mode}: {n_hit}/{n_done} vs main {n_base_hit}/{n_done} "
          f"on the same puzzles | lost={flips['lost']} gained={flips['gained']} "
          f"| shared ablation spend ≈ ${est:.3f}")


if __name__ == "__main__":
    main()
