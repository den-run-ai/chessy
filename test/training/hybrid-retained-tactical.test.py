import importlib.util, pathlib, hashlib, json, os, subprocess, sys, tempfile
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

class Poison:
    def __fspath__(self): raise AssertionError('retired API must not access path')
    def __str__(self): raise AssertionError('retired API must not stringify input')
    def __iter__(self): raise AssertionError('retired API must not iterate input')
def rejects(module, value):
    for name in ['freeze','preflight','run','child']:
        try: getattr(module,name)(value)
        except RuntimeError as e: assert 'completed and retired' in str(e)
        else: raise AssertionError('retired API returned')
rejects(a,Poison())
with tempfile.TemporaryDirectory() as folder:
    root=pathlib.Path(folder); copied=root/'copied.py'; copied.write_bytes(p.read_bytes())
    alias=root/'alias.py'; alias.symlink_to(copied)
    study=root/'copied-study'; study.mkdir(); (study/'registration.json').write_text('{}\n')
    for entry in [p,copied,alias]:
        for command in ['freeze','preflight','run','child','invented']:
            result=subprocess.run([sys.executable,str(entry),command,str(study)],capture_output=True,text=True,timeout=2,
                                  env={**os.environ,'CHESSY_TACTICAL_TOKEN':'fabricated'})
            assert result.returncode==2 and 'completed and retired' in result.stderr, result.stderr
    assert sorted(x.name for x in study.iterdir())==['registration.json']
    spec=importlib.util.spec_from_file_location('copied',copied); cached=importlib.util.module_from_spec(spec); spec.loader.exec_module(cached)
    original=copied.read_bytes(); retained=root/'retained.py'; copied.rename(retained)
    marker=root/'unverified-child-ran'
    copied.write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("unverified")\n')
    rejects(cached,study); assert not marker.exists()
    copied.unlink(); retained.rename(copied); assert copied.read_bytes()==original
historical=p.with_name('hybrid-retained-tactical-historical-v1.py.txt')
digest=hashlib.sha256(historical.read_bytes()).hexdigest()
assert digest=='15a9b6b4fc34cb804783d5ae171c0ba514eeeba0bc086d3d62a637dbf4e4984f'
assert historical.stat().st_mode&0o111==0
registration=json.loads((p.parents[2]/'eval/training/hybrid-retained-tactical-registration-2026-09.json').read_bytes())
assert registration['scriptSha256']==digest
print('Synthetic mate/phase fixtures, retired entrypoints and exact historical source PASS')
