"""Recursive labelling over the contrastive tree.

label_subtree() is the recursion: post-order traversal, one reasoner
sub-call per node, children's annotations passed to the parent call —
semantic minimax backup.

compose_root() implements the tree-level motifs that NO single node can
express. Intermezzo is the flagship case: it requires comparing the BEST
branch against the NATURAL branch, i.e. it only exists in the contrast.

static_baseline() is the ablation: same taxonomy, root position only.
"""
from __future__ import annotations
import chess
from .labels import (TreeNode, TreeReport, Motif, NodeAnnotation,
                     BRANCH_BEST, BRANCH_NATURAL)
from .features import node_features, material_cp
from .reasoner import Reasoner, RuleBasedReasoner

INTERMEZZO_MARGIN_CP = 150   # best line must beat natural line by this much


def label_subtree(node: TreeNode, reasoner: Reasoner,
                  pov: chess.Color) -> NodeAnnotation:
    child_anns = [label_subtree(c, reasoner, pov) for c in node.children]
    ann = reasoner.label_node(node.board, node.move_in, pov, child_anns)
    node.annotation = ann
    return ann


def _line(node: TreeNode) -> list[TreeNode]:
    out = [node]
    while node.children:
        node = node.children[0]
        out.append(node)
    return out


def compose_root(root: TreeNode, reasoner: Reasoner,
                 pov: chess.Color) -> TreeReport:
    for c in root.children:
        label_subtree(c, reasoner, pov)
    root.annotation = reasoner.label_node(root.board, None, pov, [])

    best_head = next((c for c in root.children if c.branch == BRANCH_BEST), None)
    nat_head = next((c for c in root.children if c.branch == BRANCH_NATURAL), None)

    motifs: list[Motif] = list(root.annotation.motifs)
    bits: list[str] = []
    best_line = _line(best_head) if best_head else []

    for n in best_line:                                   # backed-up motifs
        for m in (n.annotation.motifs if n.annotation else []):
            if m not in motifs:
                motifs.append(m)
        if n.annotation and n.annotation.narrative:
            bits.append(f"ply {n.ply}: {n.annotation.narrative}")

    # ---- intermezzo: exists only in the contrast ----------------------------
    if best_head and nat_head:
        eval_best = best_head.eval_cp if best_head.eval_cp is not None else 0
        eval_nat = nat_head.eval_cp if nat_head.eval_cp is not None else 0
        gap = eval_best - eval_nat
        forcing_first = best_head.is_forcing
        nat_target = nat_head.move_in.to_square
        deferred = any(n.move_in and n.move_in.to_square == nat_target
                       and n.branch == BRANCH_BEST and n.ply > 1
                       for n in best_line)
        gains_more = any((n.annotation.material_delta_cp if n.annotation else 0)
                         >= 200 for n in best_line[-2:])
        if gap >= INTERMEZZO_MARGIN_CP and forcing_first and (deferred or gains_more):
            motifs.insert(0, Motif.INTERMEZZO)
            bits.insert(0, (
                f"instead of the automatic "
                f"{root.board.san(nat_head.move_in)} (eval {eval_nat:+d}cp), "
                f"the in-between move {root.board.san(best_head.move_in)} "
                f"first ({eval_best:+d}cp, gap {gap:+d}cp)"
                + (", and the deferred capture still lands later" if deferred else "")))

    if not motifs:
        motifs = [Motif.QUIET]

    # ---- optional LLM tree-level judgment (the contrast, shown to a model) --
    llm_motifs, llm_narr = None, ""
    if best_head and nat_head:
        def san_line(head):
            b, out = root.board.copy(), []
            for n in _line(head):
                out.append(b.san(n.move_in)); b.push(n.move_in)
            return " ".join(out)
        summary = {
            "fen": root.board.fen(),
            "pov": "white" if pov else "black",
            "nat": root.board.san(nat_head.move_in),
            "nat_cp": nat_head.eval_cp,
            "best": root.board.san(best_head.move_in),
            "best_cp": best_head.eval_cp,
            "best_line": san_line(best_head),
            "nat_line": san_line(nat_head),
            "node_motifs": ",".join(sorted({m.value for n in best_line
                                            for m in (n.annotation.motifs
                                                      if n.annotation else [])})),
        }
        composed = reasoner.compose_tree(summary)
        if composed is not None:
            llm_motifs, llm_narr = composed.motifs, composed.narrative

    calls = getattr(reasoner, "calls", 0)
    return TreeReport(
        root_fen=root.board.fen(),
        best_move_san=root.board.san(best_head.move_in) if best_head else "?",
        natural_move_san=root.board.san(nat_head.move_in) if nat_head else None,
        eval_best_cp=best_head.eval_cp or 0 if best_head else 0,
        eval_natural_cp=nat_head.eval_cp if nat_head else None,
        motifs=motifs,
        narrative=" | ".join(bits[:4]),
        node_count=root.size(),
        llm_subcalls_simulated=calls,
        llm_motifs=llm_motifs,
        llm_narrative=llm_narr,
    )


def static_baseline(board: chess.Board, pov: chess.Color) -> list[Motif]:
    """Ablation: what a position-only classifier can see (no tree)."""
    r = RuleBasedReasoner(root_material_cp=material_cp(board, pov))
    ann = r.label_node(board, None, pov, [])
    return ann.motifs or [Motif.QUIET]
