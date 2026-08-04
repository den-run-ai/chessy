"""Engine wrapper + 'natural move' model.

The natural-move model is the crucial second ingredient of the contrastive
tree: the move a human would reflexively play (automatic recapture, obvious
capture). The intermezzo is *defined* relative to it. Here it is a heuristic;
the intended upgrade is a human-move model such as Maia (hook provided).
"""
from __future__ import annotations
from typing import Optional
import chess
import chess.engine

STOCKFISH_PATHS = ["/usr/games/stockfish", "/usr/local/bin/stockfish", "stockfish"]
PIECE_VALUE = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 320,
               chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 0}


class Engine:
    def __init__(self, depth: int = 14, multipv: int = 3):
        self.depth = depth
        self.multipv = multipv
        self._e = None
        for p in STOCKFISH_PATHS:
            try:
                self._e = chess.engine.SimpleEngine.popen_uci(p)
                break
            except FileNotFoundError:
                continue
        if self._e is None:
            raise RuntimeError("Stockfish not found; install it or add path.")

    def close(self):
        if self._e:
            self._e.quit()

    def analyse(self, board: chess.Board, multipv: Optional[int] = None):
        """Return list of (move, eval_cp_from_mover_pov, pv)."""
        infos = self._e.analyse(
            board, chess.engine.Limit(depth=self.depth),
            multipv=multipv or self.multipv)
        out = []
        for info in infos:
            score = info["score"].pov(board.turn).score(mate_score=100_000)
            out.append((info["pv"][0], score, list(info["pv"])))
        return out

    def eval_after(self, board: chess.Board, move: chess.Move, pov: chess.Color):
        """Eval (cp, pov colour) and PV after playing `move`."""
        b = board.copy()
        b.push(move)
        info = self._e.analyse(b, chess.engine.Limit(depth=self.depth))
        score = info["score"].pov(pov).score(mate_score=100_000)
        return score, list(info.get("pv", []))


def natural_move(board: chess.Board) -> Optional[chess.Move]:
    """Heuristic human-expected move. Priority:
    1. Recapture on the square of the opponent's last capture.
    2. Capture of the highest-value hanging-or-profitable enemy piece.
    Returns None if nothing 'automatic' suggests itself (then no contrast
    branch is built and intermezzo cannot be claimed — by design).

    TODO(maia): replace with Maia-1500 policy argmax for a learned model of
    the *expected* move rather than a hand rule.
    """
    last = board.peek() if board.move_stack else None
    if last is not None:
        parent = board.copy()
        parent.pop()
        if parent.is_capture(last):                 # opponent just captured
            target = last.to_square
            recaps = [m for m in board.legal_moves if m.to_square == target
                      and board.is_capture(m)]
            if recaps:                              # cheapest recapturer first
                recaps.sort(key=lambda m: PIECE_VALUE[
                    board.piece_at(m.from_square).piece_type])
                return recaps[0]
    # otherwise: most valuable profitable capture
    caps = [m for m in board.legal_moves if board.is_capture(m)]
    scored = []
    for m in caps:
        victim = board.piece_at(m.to_square)
        if victim is None:                          # en passant
            vv = PIECE_VALUE[chess.PAWN]
        else:
            vv = PIECE_VALUE[victim.piece_type]
        attacker = PIECE_VALUE[board.piece_at(m.from_square).piece_type]
        defended = board.is_attacked_by(not board.turn, m.to_square)
        gain = vv - (attacker if defended else 0)
        if gain > 0:
            scored.append((gain, m))
    if scored:
        scored.sort(key=lambda t: -t[0])
        return scored[0][1]
    return None
