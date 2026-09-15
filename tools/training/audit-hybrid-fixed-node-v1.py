#!/usr/bin/env python3
"""Independent python-chess replay of the canonical fixed-node diagnostic archive.

Reuses the tested independent natural-runtime auditor for move legality,
full-prefix repetition, terminal adjudication and search-result validation.
Never runs a search or reads incomplete-game/interim scores.
"""
from __future__ import annotations
import argparse
import base64
import gzip
from collections import Counter
import importlib.util
import json
import math
from pathlib import Path
import statistics
HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('_independent_natural_runtime',HERE.with_name('audit-natural-runtime.py'))
old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
require=old.require

def require_retained_auditor(repo, registration=None):
    repo=Path(repo).absolute()
    require(repo==repo.resolve() and Path(__file__).absolute()==HERE
            and HERE==repo/'tools/training'/HERE.name,'audit must execute the registered retained auditor path')
    own=[HERE,HERE.with_name('audit-natural-runtime.py')]
    files=own if registration is None else [Path(item['path']) for item in registration['implementation']]
    require(len(files)==len(set(files)) and set(own)<=set(files),'registered auditor/helper inventory differs')
    directories={repo}
    for file in files:
        require(file.is_absolute() and file==file.resolve() and repo in file.parents
                and file.is_file() and not file.is_symlink() and file.stat().st_mode&0o222==0,
                'audit implementation must be read-only regular files inside the retained root')
        for directory in file.parents:
            directories.add(directory)
            if directory==repo:break
    for directory in directories:
        require(directory.is_dir() and not directory.is_symlink() and directory==directory.resolve()
                and directory.stat().st_mode&0o222==0,'audit snapshot directories must be read-only without symlinks')



def close(a,b,label):
    if isinstance(b,dict):
        require(isinstance(a,dict) and a.keys()==b.keys(),label+' fields differ')
        for key in b:close(a[key],b[key],label+'.'+key)
    elif isinstance(b,float):require(type(a) in (float,int) and math.isfinite(a) and math.isclose(a,b,rel_tol=2e-10,abs_tol=2e-10),label+' differs')
    else:require(old.equal(a,b),label+' differs')


def percentile(values,p):
    s=sorted(values);n=(len(s)-1)*p;i=math.floor(n)
    return s[i]+(s[min(i+1,len(s)-1)]-s[i])*(n-i)


def timing(records,time_ms):
    result={}
    for side in ('baseline','candidate'):
        rows=[r for r in records if r['moduleId']==side];elapsed=[r['elapsedMs'] for r in rows];total=sum(elapsed);nodes=sum(r['result']['nodes'] for r in rows)
        result[side]={'moves':len(rows),'totalElapsedMs':total,'totalNodes':nodes,'nodesPerSecond':1000*nodes/total,
            'meanCompletedDepth':sum(r['result']['depth'] for r in rows)/len(rows),'meanObservedMs':total/len(rows),
            'medianObservedMs':percentile(elapsed,.5),'p95ObservedMs':percentile(elapsed,.95),'maximumObservedMs':max(elapsed),
            'depthHistogram':dict(Counter(str(r['result']['depth']) for r in rows)),
            'stopReasons':dict(Counter(r['result']['stopReason'] for r in rows))}
    return result



chess=old.chess
integer=old.integer
equal=old.equal
position_key=old.position_key
terminal=old.terminal
push=old.push
validate_result=old.validate_result
finite=old.finite

def audit_game(rows, task, modules):
    require(len(rows) >= 2, "incomplete game records")
    header, footer = rows[0], rows[-1]
    require(header.get("schema") == "chessy.natural-runtime-game-header.v1", "missing game header")
    for key in ("taskId", "openingIndex", "openingName", "prefixUci", "timeMs", "candidateColor", "maxPlies", "maxDepth", "nodeLimit"):
        require(equal(header.get(key), task[key]), "game header/task mismatch: " + key)
    require(equal(header.get("modules"), modules), "game header module mismatch")
    board, positions = chess.Board(), Counter()
    positions[position_key(board)] = 1
    for uci in task["prefixUci"]:
        require(terminal(board, positions) is None, "opening continues after terminal position")
        push(board, positions, uci)
    require(terminal(board, positions) is None, "opening root is terminal")
    searched = rows[1:-1]
    require(len(searched) <= task["maxPlies"], "game exceeds searched-ply cap")
    elapsed = {"baseline": 0.0, "candidate": 0.0}
    nodes = {"baseline": 0, "candidate": 0}
    move_counts = {"baseline": 0, "candidate": 0}
    for ply, record in enumerate(searched):
        require(record.get("schema") == "chessy.natural-runtime-move.v1", "unexpected game record")
        require(record.get("taskId") == task["taskId"] and integer(record.get("ply"))
                and record["ply"] == ply, "move task or ply sequence mismatch")
        require(terminal(board, positions) is None, "searched move follows terminal position")
        color = "w" if board.turn == chess.WHITE else "b"
        module_id = "candidate" if color == task["candidateColor"] else "baseline"
        require(record.get("color") == color and record.get("moduleId") == module_id
                and record.get("moduleSha256") == modules[module_id]["sha256"], "move module/color mismatch")
        require(record.get("fenBefore") == board.fen(en_passant="fen"), "move FEN-before mismatch")
        require(equal(record.get("positions"), dict(positions)), "full legal-EP repetition map mismatch")
        require(equal(record.get("requested"), {"timeMs": task["timeMs"], "maxDepth": task["maxDepth"],
                                                "nodeLimit": task["nodeLimit"], "quiesce": True}), "move search request mismatch")
        validate_result(record.get("result"), task["maxDepth"], task["nodeLimit"])
        require(finite(record.get("elapsedMs")) and record["elapsedMs"] > 0, "invalid elapsed milliseconds")
        push(board, positions, record["result"]["moveUci"])
        require(record.get("fenAfter") == board.fen(en_passant="fen"), "move FEN-after mismatch")
        elapsed[module_id] += record["elapsedMs"]
        nodes[module_id] += record["result"]["nodes"]
        move_counts[module_id] += 1
    outcome = terminal(board, positions)
    if outcome is None:
        require(len(searched) == task["maxPlies"], "game stopped before terminal or ply cap")
        outcome = ("1/2-1/2", "ply-cap")
    result, reason = outcome
    candidate_score = .5 if result == "1/2-1/2" else float((result == "1-0") == (task["candidateColor"] == "w"))
    require(footer.get("schema") == "chessy.natural-runtime-game-result.v1", "missing game result footer")
    require(footer.get("taskId") == task["taskId"] and integer(footer.get("searchedPlies"))
            and footer["searchedPlies"] == len(searched), "footer task or searched-ply mismatch")
    require(footer.get("finalFen") == board.fen(en_passant="fen"), "footer final FEN mismatch")
    require(footer.get("result") == result and footer.get("reason") == reason
            and equal(footer.get("candidateScore"), candidate_score), "footer outcome differs from independent replay")
    return {"taskId": task["taskId"], "openingIndex": task["openingIndex"], "timeMs": task["timeMs"],
            "candidateColor": task["candidateColor"], "searchedPlies": len(searched), "result": result,
            "reason": reason, "candidateScore": candidate_score, "elapsedMs": elapsed, "nodes": nodes,
            "searchedMoves": move_counts}


def audit(repo,registration,digest,run,output):
    repo,registration,run,output=map(lambda p:Path(p).absolute(),(repo,registration,run,output))
    require_retained_auditor(repo)
    require(not output.exists(),'refusing to replace match audit')
    inputs=old.Inputs();r=inputs.json(registration,{'sha256':digest})
    require(r['schema']=='chessy.hybrid-fixed-node-diagnostic-registration.v1' and r['researchOnly'] is True and r['formalPass'] is False and r['shippingOrEloClaimAllowed'] is False,'foreign match registration')
    require(r['candidateAdvancementAllowed'] is False,'development evidence cannot admit production')
    require_retained_auditor(repo,r)
    for item in [*r['implementation'],*r['modules'].values(),r['originalRegistration']]:inputs.read(item['path'],item)
    original=inputs.json(r['originalRegistration']['path'],r['originalRegistration'])
    for item in [*original['modules'].values(),original['offline'],original['runtime'],*original['evidence']]:inputs.read(item['path'],item)
    require(old.equal(r['modules'],{key:original['modules'][key] for key in ('shipped','hybrid')}),'unchanged original modules required')
    require(old.equal(r['openings'],original['openings']),'unchanged exposed opening bank required')
    for p in (HERE,HERE.with_name('audit-natural-runtime.py')):inputs.read(p,{'sha256':old.digest(p.read_bytes())})
    protocol=old.strict_json((repo/'eval/training/hybrid-fixed-node-v1.json').read_bytes());require(old.equal(protocol,r['protocol']),'registered protocol changed')
    require(r['originalRegistration']['sha256']==protocol['originalRegistrationSha256'],'original identity differs')
    require(protocol['totalGames']==200 and protocol['timeMs']==0 and protocol['nodeLimit']==16384 and protocol['arms']==['hybrid'] and len(r['openings'])==100,'protocol dimensions differ')
    require([o['index'] for o in r['openings']]==list(range(100)),'opening inventory differs')
    expected=[]
    for opening in r['openings']:
        index=opening['index'];colors=['b','w'] if index%2 else ['w','b']
        for color in colors:expected.append({'taskId':f'hybrid-n16384-o{index}-{color}','arm':'hybrid','opening':opening,'candidateColor':color,'timeMs':0,'nodeLimit':16384})
    require(old.equal(r['tasks'],expected),'complete rotated paired task schedule differs')
    summary_raw=(run/'summary.json').read_bytes();summary=inputs.json(run/'summary.json',{'sha256':old.digest(summary_raw)})
    require(summary['schema']=='chessy.hybrid-fixed-node-diagnostic-summary.v1' and summary['status']=='completed' and summary['failure'] is None and summary['completedGames']==summary['plannedGames']==200,'full completed batch required before raw score audit')
    require(summary['registrationSha256']==digest and summary['formalPass'] is False and summary['shippingOrEloClaimAllowed'] is False,'summary registration/scope differs')
    manifest=inputs.json(run/'raw-manifest.json',summary['rawManifest'])
    require(manifest['schema']=='chessy.hybrid-fixed-node-diagnostic-raw-manifest.v1' and manifest['status']=='completed' and manifest['failure'] is None and manifest['registration']['sha256']==digest,'raw manifest scope/binding differs')
    require([g['taskId'] for g in manifest['games']]==[t['taskId'] for t in expected],'raw game inventory differs')
    ledger_path=Path(r['noRerunLedger']);ledger=inputs.json(ledger_path,{'sha256':old.digest(ledger_path.read_bytes())})
    require(ledger['registrationSha256']==digest and Path(ledger['output']).absolute()==run and ledger['scoreRerunAllowed'] is False,'one-shot match ledger differs')
    archive_info=manifest['retainedArchive']
    require(old.equal(summary['retainedArchive'],archive_info),'archive binding differs')
    archived=inputs.json(old.child(run,archive_info['path']),archive_info)
    expected_receipts=[manifest['warmup'],*manifest['games']]
    require(archived['schema']=='chessy.hybrid-retained-game-archive.v1' and archived['compressionAfterTimedSearches'] is True,'canonical archive scope differs')
    require(len(archived['entries'])==archive_info['entries']==len(expected_receipts)==201,'canonical archive inventory differs')
    members={}
    for entry,expected_receipt in zip(archived['entries'],expected_receipts):
        for key in ('path','bytes','rows','sha256'):require(old.equal(entry[key],expected_receipt[key]),'canonical member receipt differs')
        require(entry['path'] not in members,'duplicate canonical member');members[entry['path']]=entry
    def captured_rows(receipt):
        entry=members[receipt['path']]
        compressed=base64.b64decode(entry['gzipBase64'],validate=True)
        raw=gzip.decompress(compressed)
        require(len(raw)==receipt['bytes'] and old.digest(raw)==receipt['sha256'],'canonical decompressed capture differs')
        require(raw.endswith(b'\n'),'canonical capture lacks final newline')
        lines=raw.splitlines();require(len(lines)==receipt['rows'] and all(line.strip() for line in lines),'canonical capture row inventory differs')
        return [old.strict_json(line) for line in lines]
    warmup=manifest['warmup'];require(warmup['status']=='complete' and warmup['path']=='warmup.jsonl','warmup binding differs')
    warm_rows=captured_rows(warmup);ix=0
    for index in protocol['warmup']['openingIndices']:
        for side in protocol['warmup']['moduleOrder']:
            row=warm_rows[ix];ix+=1;board=old.chess.Board();positions=Counter({old.position_key(board):1})
            for move in r['openings'][index]['prefixUci']:old.push(board,positions,move)
            require(row['schema']=='chessy.hybrid-match-warmup.v1' and row['openingIndex']==index and row['moduleId']==side and row['moduleSha256']==r['modules'][side]['sha256'],'warmup identity differs')
            require(row['fenBefore']==board.fen(en_passant='fen') and old.equal(row['positions'],dict(positions)),'warmup state differs')
            require(old.equal(row['requested'],{'maxDepth':30,'timeMs':0,'nodeLimit':10000,'quiesce':True}),'warmup budget differs')
            old.validate_result(row['result'],30,10000);require(old.finite(row['elapsedMs']) and row['elapsedMs']>0,'warmup elapsed differs');old.push(board,positions,row['result']['moveUci'])
    require(ix==len(warm_rows)==8,'warmup inventory differs')
    games=[];records={'hybrid':[]};moves=0
    for index,(task,item) in enumerate(zip(expected,manifest['games'])):
        require(item['status']=='complete' and item['path']==task['taskId']+'.jsonl','game artifact binding differs')
        rows=captured_rows(item)
        flattened={'taskId':task['taskId'],'openingIndex':task['opening']['index'],'openingName':task['opening']['name'],
            'prefixUci':task['opening']['prefixUci'],'timeMs':task['timeMs'],'candidateColor':task['candidateColor'],'maxPlies':180,'maxDepth':30,'nodeLimit':16384}
        modules={'baseline':{'sha256':r['modules']['shipped']['sha256']},'candidate':{'sha256':r['modules'][task['arm']]['sha256']}}
        game=audit_game(rows,flattened,modules);game['arm']=task['arm'];games.append(game)
        # Keep only timing fields after legal replay; full repetition maps can
        # otherwise retain hundreds of MB across the complete archive.
        records[task['arm']].extend({'moduleId':row['moduleId'],'elapsedMs':row['elapsedMs'],
            'result':{key:row['result'][key] for key in ('nodes','depth','stopReason')}} for row in rows[1:-1])
        moves+=len(rows)-2
        if (index+1)%100==0:print(json.dumps({'independentlyReplayedGames':index+1,'moves':moves}),flush=True)
    by_arm={}
    for arm in protocol['arms']:
        group=[game for game in games if game['arm']==arm];pairs=[]
        for index in range(100):
            pair=[game for game in group if game['openingIndex']==index]
            require(len(pair)==2 and {game['candidateColor'] for game in pair}=={'w','b'},'opening color pair incomplete');pairs.append(sum(game['candidateScore'] for game in pair)/2)
        mean=statistics.mean(pairs);sd=statistics.stdev(pairs);lower=max(0,mean-(1.645+1.55/99)*sd/10);times=timing(records[arm],0)
        by_arm[arm]={'games':len(group),'openingPairs':100,'wins':sum(game['candidateScore']==1 for game in group),'draws':sum(game['candidateScore']==.5 for game in group),
            'losses':sum(game['candidateScore']==0 for game in group),'candidateScore':mean,'descriptiveOpeningClusterLower95':lower,'openingPairStandardDeviation':sd,
            'terminationReasons':dict(Counter(game['reason'] for game in group)),'timing':times,
            'meanObservedTimeRatio':times['candidate']['meanObservedMs']/times['baseline']['meanObservedMs'],
            'aggregateNodesPerSecondRatio':times['candidate']['nodesPerSecond']/times['baseline']['nodesPerSecond'],'formalPass':False,'shippingOrEloClaimAllowed':False}
    close(summary['byArm'],by_arm,'independent complete match aggregate')
    promising=by_arm['hybrid']['candidateScore']>=protocol['decisionRule']['promisingCandidateScoreAtLeast']
    require(old.equal(summary['decision'],{'promising':promising,'next':protocol['decisionRule']['promisingNext' if promising else 'otherwiseNext']}),'preregistered research route differs')
    inputs.recheck()
    result={'schema':'chessy.hybrid-fixed-node-independent-audit.v1','status':'PASS','registrationSha256':digest,'summarySha256':old.digest(summary_raw),
        'researchOnly':True,'formalPass':False,'shippingOrEloClaimAllowed':False,'games':len(games),'independentlyReplayedSearchedMoves':moves,'warmupSearches':8,
        'mismatches':0,'canonicalArchiveMembers':201,'rawGameSource':'authenticated retained gzip archive only','mutableLiveGameFilesRead':0,'byArm':by_arm,'pythonChessVersion':old.chess.__version__,'engineSearchesRunByAuditor':0,'inputs':{str(p):info for p,info in inputs.files.items()},
        'limitations':['Independent legality/repetition/adjudication uses python-chess on authenticated retained archive members; mutable live game files are never used and wall-clock numbers are not remeasured.',
            'Unchanged hybrid versus shipped HCE at 16,384 nodes; expanded HCE remains an offline control, not an additional match arm.',
            'Exposed opening bank and fixed node control are developmental; descriptive clustered bounds do not establish Elo or shipping acceptance.']}
    with output.open('x') as stream:json.dump(result,stream,sort_keys=True,indent=2);stream.write('\n')
    print(json.dumps({k:result[k] for k in ('status','games','independentlyReplayedSearchedMoves','mismatches')}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--execution-repo',required=True,type=Path);p.add_argument('--registration',required=True,type=Path);p.add_argument('--registration-sha256',required=True);p.add_argument('--run-dir',required=True,type=Path);p.add_argument('--output',required=True,type=Path)
    a=p.parse_args();audit(a.execution_repo,a.registration,a.registration_sha256,a.run_dir,a.output)
