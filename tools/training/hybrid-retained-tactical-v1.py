#!/usr/bin/env python3
"""Pure fixture helpers for the completed census; all execution is retired."""
import sys
import chess

RETIRED = ('Retained tactical census v1 is completed and retired; '
           'freeze/preflight/run/child are disabled for every path. No rerun is permitted.')
def retired(*args, **kwargs):
    raise RuntimeError(RETIRED)

def check(value, message):
    if not value: raise ValueError(message)
def key(b): return ' '.join(b.fen(en_passant='legal').split()[:4])
def phase(b): return min(24, sum(len(b.pieces(p, c))*w for c in chess.COLORS for p,w in [(chess.KNIGHT,1),(chess.BISHOP,1),(chess.ROOK,2),(chess.QUEEN,4)]))
def mate_moves(b):
    if b.is_checkmate() or b.is_stalemate() or b.is_insufficient_material() or b.halfmove_clock >= 100 or b.is_repetition(3): return []
    result=[]
    for m in list(b.legal_moves):
        b.push(m)
        if b.is_checkmate(): result.append(m.uci())
        b.pop()
    return sorted(result)
def inspect(b, chosen):
    check(chosen in b.legal_moves, 'illegal selected move')
    own=mate_moves(b); b.push(chosen); replies=mate_moves(b); b.pop(); safe=None
    if replies:
        for m in sorted(b.legal_moves, key=lambda m:m.uci()):
            if m == chosen: continue
            b.push(m); avoids=not mate_moves(b); b.pop()
            if avoids: safe=m.uci(); break
    return {'mateInOneMoves':own, 'missedMateInOne':bool(own and chosen.uci() not in own),
            'opponentMateReplies':replies, 'avoidsImmediateMateWitness':safe,
            'avoidableImmediateMate':bool(replies and safe)}

# Former API names fail before inspecting paths, inputs, runtime or ledgers.
freeze = preflight = run = child = retired

if __name__ == '__main__':
    print(RETIRED, file=sys.stderr)
    sys.exit(2)
