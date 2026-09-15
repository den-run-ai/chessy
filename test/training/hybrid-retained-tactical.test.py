import importlib.util, pathlib
import chess
p=pathlib.Path(__file__).resolve().parents[2]/'tools/training/hybrid-retained-tactical-v1.py'
s=importlib.util.spec_from_file_location('audit',p); a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
b=chess.Board('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'); before=b.fen()
assert 'f7g7' in a.mate_moves(b)
assert not a.inspect(b,chess.Move.from_uci('f7g7'))['missedMateInOne']
assert a.inspect(b,chess.Move.from_uci('f7f6'))['missedMateInOne']
assert b.fen()==before and len(b.move_stack)==0
b=chess.Board('7k/5Q2/6K1/8/8/8/8/8 w - - 99 1')
assert 'f7g7' in a.mate_moves(b), 'mate on halfmove100 takes precedence'
b.push_uci('f7g7'); assert b.is_checkmate() and b.halfmove_clock==100
b=chess.Board('7k/5Q2/6K1/8/8/8/8/8 w - - 100 1')
assert a.mate_moves(b)==[], 'already ended draw permits no subsequent move'
b=chess.Board('r6k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); before=b.fen()
r=a.inspect(b,chess.Move.from_uci('a8a1'))
assert r['avoidableImmediateMate'] and r['avoidsImmediateMateWitness']
assert b.fen()==before and len(b.move_stack)==0
assert a.phase(chess.Board())==24
assert a.phase(chess.Board('7k/8/6K1/8/8/8/8/8 w - - 0 1'))==0
print('Synthetic legal mate, avoidable threat, board restoration and phase fixtures PASS')
