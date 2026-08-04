"""Build the minimal contrastive tree.

Key design decision (the research idea): human-relevant-minimal != engine-
minimal. The tree keeps exactly two lines:

  1. BEST     — the engine PV, truncated to `max_plies`.
  2. NATURAL  — the human-expected move (e.g. automatic recapture) and the
                engine's refutation of it.

The contrast between them is the machine-readable definition of an
intermezzo, a trap, a desperado. Node count stays ~2*max_plies+1, i.e. small
enough that one LLM sub-call per node is cheap.
"""
from __future__ import annotations
import chess
from .engine import Engine, natural_move
from .labels import TreeNode, BRANCH_BEST, BRANCH_NATURAL


def _is_forcing(parent: chess.Board, move: chess.Move) -> bool:
    return parent.gives_check(move) or parent.is_capture(move)


def _grow_line(root_board: chess.Board, first: chess.Move, pv: list[chess.Move],
               branch: str, max_plies: int, eng: Engine,
               pov: chess.Color) -> TreeNode:
    """Create a chain of nodes following first + pv, evaluating each ply."""
    b = root_board.copy()
    node = None
    head = None
    moves = [first] + [m for m in pv if m != first][: max_plies - 1] \
        if pv and pv[0] != first else ([first] + pv[1:max_plies])
    ply = 1
    for mv in moves[:max_plies]:
        if mv not in b.legal_moves:
            break
        forcing = _is_forcing(b, mv)
        b.push(mv)
        score = None
        if not b.is_game_over():
            infos = eng.analyse(b, multipv=1)
            score = infos[0][1] if b.turn == pov else -infos[0][1]
        else:
            score = 100_000 if b.is_checkmate() and b.turn != pov else 0
        child = TreeNode(board=b.copy(), move_in=mv, branch=branch,
                         ply=ply, eval_cp=score, is_forcing=forcing)
        if node is None:
            head = child
        else:
            node.children.append(child)
        node = child
        ply += 1
    return head


def build_contrastive_tree(board: chess.Board, eng: Engine,
                           max_plies: int = 6) -> TreeNode:
    pov = board.turn
    root = TreeNode(board=board.copy(), move_in=None, branch="root", ply=0)

    analysis = eng.analyse(board)                       # multipv at root
    best_move, best_cp, best_pv = analysis[0]
    root.eval_cp = best_cp

    best_head = _grow_line(board, best_move, best_pv, BRANCH_BEST,
                           max_plies, eng, pov)
    if best_head:
        root.children.append(best_head)

    nat = natural_move(board)
    if nat is not None and nat != best_move:
        nat_cp, nat_pv = eng.eval_after(board, nat, pov)
        nat_head = _grow_line(board, nat, [nat] + nat_pv, BRANCH_NATURAL,
                              max_plies, eng, pov)
        if nat_head:
            nat_head.eval_cp = nat_cp
            root.children.append(nat_head)
    return root
