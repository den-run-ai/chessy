"""Node-local features — the structured context handed to each reasoner
sub-call. Everything here is computable from ONE node (plus its incoming
move). Deliberately NO tree information: the point of the experiment is to
show which motifs are and aren't recoverable without the tree.
"""
from __future__ import annotations
import chess
from .engine import PIECE_VALUE

MAJOR = {chess.QUEEN, chess.ROOK, chess.KING}


def material_cp(board: chess.Board, pov: chess.Color) -> int:
    total = 0
    for sq, pc in board.piece_map().items():
        v = PIECE_VALUE[pc.piece_type]
        total += v if pc.color == pov else -v
    return total


def node_features(board: chess.Board, move_in: chess.Move | None,
                  pov: chess.Color) -> dict:
    f: dict = {"checks": board.is_check(), "mate": board.is_checkmate()}
    f["material_cp"] = material_cp(board, pov)

    # --- pins on valuable pieces (either side) -------------------------------
    pins = []
    for color in (chess.WHITE, chess.BLACK):
        for sq, pc in board.piece_map().items():
            if pc.color == color and pc.piece_type != chess.KING \
                    and board.is_pinned(color, sq):
                pins.append({"square": chess.square_name(sq),
                             "piece": pc.symbol(),
                             "value": PIECE_VALUE[pc.piece_type]})
    f["pins"] = pins

    # --- hanging pieces of side-to-move's opponent... ------------------------
    hanging = []
    for sq, pc in board.piece_map().items():
        if pc.piece_type == chess.KING:
            continue
        attackers = board.attackers(not pc.color, sq)
        defenders = board.attackers(pc.color, sq)
        if attackers and not defenders:
            hanging.append({"square": chess.square_name(sq),
                            "piece": pc.symbol()})
    f["hanging"] = hanging

    if move_in is None:
        return f

    # --- properties of the incoming move -------------------------------------
    mover_sq = move_in.to_square
    mover = board.piece_at(mover_sq)
    f["move"] = {"uci": move_in.uci(), "is_check": board.is_check()}

    if mover is not None:
        # fork: moved piece attacks >=2 valuable targets
        targets = []
        for t in board.attacks(mover_sq):
            victim = board.piece_at(t)
            if victim and victim.color != mover.color:
                if victim.piece_type in MAJOR or (
                        PIECE_VALUE[victim.piece_type] >
                        PIECE_VALUE[mover.piece_type]) or not \
                        board.attackers(victim.color, t):
                    targets.append({"square": chess.square_name(t),
                                    "piece": victim.symbol()})
        f["fork_targets"] = targets

        # discovered check: in check, but the moved piece is not a checker
        if board.is_check():
            checkers = board.checkers()
            f["discovered_check"] = mover_sq not in checkers
        else:
            f["discovered_check"] = False
    return f
