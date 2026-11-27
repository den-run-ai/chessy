#!/usr/bin/env python3
"""One bounded posthoc census; no engine subprocess or fitted model access."""
import base64, collections, gzip, hashlib, json, os, pathlib, platform, subprocess, sys
import chess

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROTOCOL = 'eval/training/hybrid-retained-tactical-v1.md'
EXPECTED = {
    'archive': 'd1fe0e2b2cb0586a3811df386d48110fa2859ec39fac659f518118d307b72f86',
    'matchRegistration': '8610cb22228618f4a2f5da68e269b25eaf8cf2f883d251527769a618b26a5c71',
    'matchAudit': '508190d5fb45668eb9d023958ff3e41a9e69c55d04f3e4679fa26df921220d85',
}
HYBRID = '18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493'
def check(value, message):
    if not value: raise ValueError(message)
def sha(b): return hashlib.sha256(b).hexdigest()
def encode(v): return (json.dumps(v, sort_keys=True) + '\n').encode()
def write(p, v):
    with pathlib.Path(p).open('xb') as f: f.write(encode(v))
def verified(p, h):
    b = pathlib.Path(p).read_bytes(); check(sha(b) == h, 'identity changed: ' + str(p)); return b
def runtime():
    return {'python': platform.python_version(), 'pythonPath': os.path.realpath(sys.executable),
            'pythonSha256': sha(pathlib.Path(sys.executable).read_bytes()), 'chess': chess.__version__,
            'chessPath': chess.__file__, 'chessSha256': sha(pathlib.Path(chess.__file__).read_bytes())}
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
def freeze(out, paths):
    check(chess.__version__ == '1.11.2', 'pinned chess required')
    out=pathlib.Path(out); out.mkdir()
    inputs={k:{'path':str(pathlib.Path(p).resolve()), 'sha256':EXPECTED[k]} for k,p in zip(EXPECTED, paths)}
    check(len(inputs)==3, 'three inputs required')
    for v in inputs.values(): verified(v['path'],v['sha256'])
    code=pathlib.Path(__file__).read_bytes(); protocol=(ROOT/PROTOCOL).read_bytes()
    snapshot=out/'implementation'; snapshot.mkdir()
    (snapshot/'audit.py').write_bytes(code); (snapshot/'protocol.md').write_bytes(protocol)
    os.chmod(snapshot/'audit.py',0o444); os.chmod(snapshot/'protocol.md',0o444); os.chmod(snapshot,0o555)
    r={'schema':'chessy.hybrid-retained-tactical.registration.v1','posthoc':True,'researchOnly':True,
       'watchdogSeconds':60,'expectedGames':40,'expectedMoves':5258,'expectedHybridDecisions':2628,
       'inputs':inputs,'runtime':runtime(),'scriptSha256':sha(code),'protocolSha256':sha(protocol)}
    write(out/'registration.json',r); return r
def preflight(out):
    out=pathlib.Path(out); raw=(out/'registration.json').read_bytes(); r=json.loads(raw)
    check(r['runtime']==runtime() and chess.__version__=='1.11.2', 'runtime changed')
    check(r['watchdogSeconds']==60 and r['expectedGames']==40 and r['expectedMoves']==5258 and r['expectedHybridDecisions']==2628,'workload changed')
    snapshot=out/'implementation'
    check(pathlib.Path(__file__).resolve()==(snapshot/'audit.py').resolve(),'run must execute retained script')
    check(snapshot.stat().st_mode&0o222==0 and (snapshot/'audit.py').stat().st_mode&0o222==0,'snapshot must remain read-only')
    verified(snapshot/'audit.py',r['scriptSha256']); verified(snapshot/'protocol.md',r['protocolSha256'])
    check(sha(pathlib.Path(__file__).read_bytes())==r['scriptSha256'],'executing script changed')
    check(set(r['inputs'])==set(EXPECTED),'input inventory')
    inputs={}
    for k,v in r['inputs'].items():
        check(v['sha256']==EXPECTED[k],'unexpected input'); inputs[k]=verified(v['path'],v['sha256'])
    return r,inputs,sha(raw)
def child(out):
    out=pathlib.Path(out); ledger=json.loads((out/'started.json').read_bytes())
    check(os.getppid()==ledger['parentPid'] and os.environ.get('CHESSY_TACTICAL_TOKEN')==ledger['token'],'supervised child only')
    r,inputs,digest=preflight(out); check(digest==ledger['registrationSha256'],'parent registration changed')
    archive=json.loads(inputs['archive']); tasks={t['taskId']:t for t in json.loads(inputs['matchRegistration'])['tasks']}
    check(len(tasks)==40 and len(archive['entries'])==41,'source inventory')
    names=set(); games=set(); moves=0; decisions=0
    with (out/'rows.jsonl').open('xb') as stream:
        def emit(v): stream.write(encode(v)); stream.flush()
        for member in archive['entries']:
            check(member['path'] not in names,'duplicate member'); names.add(member['path'])
            raw=gzip.decompress(base64.b64decode(member['gzipBase64'])); check(sha(raw)==member['sha256'] and len(raw)==member['bytes'],'member identity')
            lines=raw.splitlines(keepends=True); check(len(lines)==member['rows'],'member rows')
            if member['path']=='warmup.jsonl': continue
            h=json.loads(lines[0]); tid=h['taskId']; check(tid in tasks and tid not in games,'game inventory'); games.add(tid)
            check(h['prefixUci']==tasks[tid]['opening']['prefixUci'],'prefix changed')
            b=chess.Board(); history=collections.Counter({key(b):1}); prior=None
            for uci in h['prefixUci']:
                m=chess.Move.from_uci(uci); check(m in b.legal_moves,'illegal prefix'); b.push(m); history[key(b)]+=1
            for ply,line in enumerate(lines[1:-1]):
                row=json.loads(line); check(row['taskId']==tid and row['ply']==ply,'move identity')
                check(b.fen(en_passant='fen')==row['fenBefore'] and dict(history)==row['positions'],'full replay context changed')
                chosen=chess.Move.from_uci(row['result']['moveUci']); check(chosen in b.legal_moves,'illegal recorded move')
                if row['moduleSha256']==HYBRID:
                    p=phase(b); transitions=[]
                    if prior is not None:
                        for boundary,a,z in [('low6',prior<=6,p<=6),('high12',prior>=12,p>=12)]:
                            if a!=z: transitions.append({'boundary':boundary,'direction':'up' if p>prior else 'down','fromPhase':prior,'toPhase':p})
                    value={'type':'decision','taskId':tid,'ply':ply,'fen':row['fenBefore'],'move':chosen.uci(),'phase':p,'phaseTransitions':transitions,**inspect(b,chosen)}
                    emit(value); decisions+=1; prior=p
                b.push(chosen); history[key(b)]+=1; moves+=1
                check(b.fen(en_passant='fen')==row['fenAfter'],'post-move FEN changed')
            check(json.loads(lines[-1])['schema']=='chessy.natural-runtime-game-result.v1','incomplete game')
            emit({'type':'game-complete','taskId':tid,'games':len(games),'moves':moves,'hybridDecisions':decisions})
        check(games==set(tasks) and 'warmup.jsonl' in names and moves==5258 and decisions==2628,'incomplete census')
        emit({'type':'complete','games':40,'moves':moves,'hybridDecisions':decisions})
def run(out):
    out=pathlib.Path(out); _,_,digest=preflight(out); token=os.urandom(24).hex()
    write(out/'started.json',{'parentPid':os.getpid(),'token':token,'registrationSha256':digest})
    failure=None
    with (out/'stderr.txt').open('xb') as err:
        worker=subprocess.Popen([sys.executable,str(out/'implementation/audit.py'),'child',str(out)],env={**os.environ,'CHESSY_TACTICAL_TOKEN':token},stdout=subprocess.DEVNULL,stderr=err)
        try:
            code=worker.wait(timeout=60)
            if code: failure='child exit '+str(code)
        except subprocess.TimeoutExpired:
            worker.kill(); worker.wait(); failure='60-second watchdog; no rerun permitted'
    rows=[]
    if (out/'rows.jsonl').exists():
        for line in (out/'rows.jsonl').read_bytes().splitlines():
            try: rows.append(json.loads(line))
            except json.JSONDecodeError: failure=failure or 'partial final row'
    complete=bool(not failure and rows and rows[-1].get('type')=='complete')
    if not complete: failure=failure or 'missing complete census'
    preflight(out)
    d=[v for v in rows if v['type']=='decision']; transitions=[t for v in d for t in v['phaseTransitions']]
    result={'schema':'chessy.hybrid-retained-tactical.results.v1','registrationSha256':digest,'complete':complete,'failure':failure,
            'auditedHybridDecisions':len(d),'missedMateInOne':sum(v['missedMateInOne'] for v in d),
            'avoidableImmediateMate':sum(v['avoidableImmediateMate'] for v in d),'phaseTransitions':dict(collections.Counter(t['boundary']+'-'+t['direction'] for t in transitions)),
            'findings':[v for v in d if v['missedMateInOne'] or v['avoidableImmediateMate']],
            'rowsSha256':sha((out/'rows.jsonl').read_bytes()) if (out/'rows.jsonl').exists() else None}
    write(out/('results.json' if complete else 'failure.json'),result); check(complete,failure); return result
if __name__=='__main__':
    command,*args=sys.argv[1:]
    if command=='freeze': print(json.dumps(freeze(args[0],args[1:])))
    elif command=='run': print(json.dumps(run(args[0])))
    elif command=='child': child(args[0])
    else: raise ValueError('freeze OUT ARCHIVE REGISTRATION AUDIT | run OUT')
