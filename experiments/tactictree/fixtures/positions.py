"""Curated fixtures. Each is (name, board-with-move-history, expected motifs).

Move history matters: the natural-move model needs the opponent's last move
(e.g. a capture) to know what the 'automatic' reply would be.
"""
import chess
from src.tactictree.labels import Motif


def _from_moves(sans: list[str]) -> chess.Board:
    b = chess.Board()
    for s in sans:
        b.push_san(s)
    return b


def fixtures():
    out = []

    # 1. Elephant Trap (QGD): after 7.Bxd8 the automatic 7...Kxd8 leaves Black
    #    worse; the zwischenzug 7...Bb4+! wins the queen back first.
    out.append((
        "elephant_trap_zwischenzug",
        _from_moves(["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Nbd7",
                     "cxd5", "exd5", "Nxd5", "Nxd5", "Bxd8"]),
        {Motif.INTERMEZZO},
    ))

    # 2. Petroff trap: 3...Nxe4 4.Qe2 Nf6?? 5.Nc6+ — knight moves away and
    #    discovers check from the e2 queen, then wins the d8 queen.
    out.append((
        "petroff_discovered_check",
        _from_moves(["e4", "e5", "Nf3", "Nf6", "Nxe5", "Nxe4",
                     "Qe2", "Nf6"]),
        {Motif.DISCOVERED_CHECK},
    ))

    # 3. Knight fork: Nb5-c7+ forks Ke8 and Ra8. Pawns included so that
    #    winning the exchange is actually decisive (a bare K+N vs K+R
    #    position is a book draw and the engine rightly ignores the fork).
    out.append((
        "royal_fork",
        chess.Board("r3k3/5p2/8/1N6/8/8/5PPP/6K1 w - - 0 1"),
        {Motif.FORK},
    ))

    # 4. Absolute pin: Re8 pins Ne4 against Ke1; White must not rely on the
    #    knight. Static features alone CAN see this one (by design).
    out.append((
        "absolute_pin",
        chess.Board("4r1k1/8/8/8/4N3/8/8/4K3 w - - 0 1"),
        {Motif.PIN},
    ))

    # 5. Quiet control position: no tactics expected (false-positive check).
    out.append((
        "quiet_italian",
        _from_moves(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6",
                     "d3", "d6"]),
        {Motif.QUIET},
    ))
    return out
