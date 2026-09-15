#!/usr/bin/env python3
"""Independent python-chess replay of the complete 400-game hybrid diagnostic.

Reuses the tested independent natural-runtime auditor for move legality,
full-prefix repetition, terminal adjudication and search-result validation.
Never runs a search or reads incomplete-game/interim scores.
"""
from __future__ import annotations
import argparse
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
            'overTwoTimesRequested':sum(value>2*time_ms for value in elapsed),
            'depthHistogram':dict(Counter(str(r['result']['depth']) for r in rows)),
            'stopReasons':dict(Counter(r['result']['stopReason'] for r in rows))}
    return result


def audit(repo,registration,digest,run,output):
    repo,registration,run,output=map(lambda p:Path(p).absolute(),(repo,registration,run,output))
    require(not output.exists(),'refusing to replace match audit')
    inputs=old.Inputs();r=inputs.json(registration,{'sha256':digest})
    require(r['schema']=='chessy.hybrid-development-match-registration.v1' and r['researchOnly'] is True and r['formalPass'] is False and r['shippingOrEloClaimAllowed'] is False,'foreign match registration')
    require(r['candidateAdvancementAllowed'] is False,'development evidence cannot admit production')
    for item in [*r['implementation'],*r['modules'].values(),r['offline'],r['runtime'],*r['evidence']]:inputs.read(item['path'],item)
    for p in (HERE,HERE.with_name('audit-natural-runtime.py')):inputs.read(p,{'sha256':old.digest(p.read_bytes())})
    protocol=old.strict_json((repo/'eval/training/hybrid-match-v1.json').read_bytes());require(old.equal(protocol,r['protocol']),'registered protocol changed')
    require(protocol['totalGames']==400 and protocol['timeMs']==20 and protocol['arms']==['hybrid','expanded'] and len(r['openings'])==100,'protocol dimensions differ')
    require([o['index'] for o in r['openings']]==list(range(100)),'opening inventory differs')
    expected=[]
    for opening in r['openings']:
        index=opening['index'];arms=['expanded','hybrid'] if index%2 else ['hybrid','expanded'];colors=['b','w'] if index%2 else ['w','b']
        for arm in arms:
            for color in colors:expected.append({'taskId':f'{arm}-o{index}-{color}','arm':arm,'opening':opening,'candidateColor':color,'timeMs':20})
    require(old.equal(r['tasks'],expected),'complete rotated paired task schedule differs')
    summary_raw=(run/'summary.json').read_bytes();summary=inputs.json(run/'summary.json',{'sha256':old.digest(summary_raw)})
    require(summary['schema']=='chessy.hybrid-development-match-summary.v1' and summary['status']=='completed' and summary['failure'] is None and summary['completedGames']==summary['plannedGames']==400,'full completed batch required before raw score audit')
    require(summary['registrationSha256']==digest and summary['formalPass'] is False and summary['shippingOrEloClaimAllowed'] is False,'summary registration/scope differs')
    manifest=inputs.json(run/'raw-manifest.json',summary['rawManifest'])
    require(manifest['schema']=='chessy.hybrid-development-match-raw-manifest.v1' and manifest['status']=='completed' and manifest['failure'] is None and manifest['registration']['sha256']==digest,'raw manifest scope/binding differs')
    require([g['taskId'] for g in manifest['games']]==[t['taskId'] for t in expected],'raw game inventory differs')
    ledger_path=Path(r['noRerunLedger']);ledger=inputs.json(ledger_path,{'sha256':old.digest(ledger_path.read_bytes())})
    require(ledger['registrationSha256']==digest and Path(ledger['output']).absolute()==run and ledger['scoreRerunAllowed'] is False,'one-shot match ledger differs')
    warmup=manifest['warmup'];require(warmup['status']=='complete' and warmup['path']=='warmup.jsonl','warmup binding differs')
    warm_rows=inputs.rows(old.child(run,warmup['path']),warmup);ix=0
    for index in protocol['warmup']['openingIndices']:
        for side in protocol['warmup']['moduleOrder']:
            row=warm_rows[ix];ix+=1;board=old.chess.Board();positions=Counter({old.position_key(board):1})
            for move in r['openings'][index]['prefixUci']:old.push(board,positions,move)
            require(row['schema']=='chessy.hybrid-match-warmup.v1' and row['openingIndex']==index and row['moduleId']==side and row['moduleSha256']==r['modules'][side]['sha256'],'warmup identity differs')
            require(row['fenBefore']==board.fen(en_passant='fen') and old.equal(row['positions'],dict(positions)),'warmup state differs')
            require(old.equal(row['requested'],{'maxDepth':30,'timeMs':0,'nodeLimit':10000,'quiesce':True}),'warmup budget differs')
            old.validate_result(row['result'],30,10000);require(old.finite(row['elapsedMs']) and row['elapsedMs']>0,'warmup elapsed differs');old.push(board,positions,row['result']['moveUci'])
    require(ix==len(warm_rows)==12,'warmup inventory differs')
    games=[];records={'hybrid':[],'expanded':[]};moves=0
    for index,(task,item) in enumerate(zip(expected,manifest['games'])):
        require(item['status']=='complete' and item['path']==task['taskId']+'.jsonl','game artifact binding differs')
        rows=inputs.rows(old.child(run,item['path']),item)
        flattened={'taskId':task['taskId'],'openingIndex':task['opening']['index'],'openingName':task['opening']['name'],
            'prefixUci':task['opening']['prefixUci'],'timeMs':task['timeMs'],'candidateColor':task['candidateColor'],'maxPlies':180,'maxDepth':30}
        modules={'baseline':{'sha256':r['modules']['shipped']['sha256']},'candidate':{'sha256':r['modules'][task['arm']]['sha256']}}
        game=old.audit_game(rows,flattened,modules);game['arm']=task['arm'];games.append(game);records[task['arm']].extend(rows[1:-1]);moves+=len(rows)-2
        if (index+1)%100==0:print(json.dumps({'independentlyReplayedGames':index+1,'moves':moves}),flush=True)
    by_arm={}
    for arm in protocol['arms']:
        group=[game for game in games if game['arm']==arm];pairs=[]
        for index in range(100):
            pair=[game for game in group if game['openingIndex']==index]
            require(len(pair)==2 and {game['candidateColor'] for game in pair}=={'w','b'},'opening color pair incomplete');pairs.append(sum(game['candidateScore'] for game in pair)/2)
        mean=statistics.mean(pairs);sd=statistics.stdev(pairs);lower=max(0,mean-(1.645+1.55/99)*sd/10);times=timing(records[arm],20)
        by_arm[arm]={'games':len(group),'openingPairs':100,'wins':sum(game['candidateScore']==1 for game in group),'draws':sum(game['candidateScore']==.5 for game in group),
            'losses':sum(game['candidateScore']==0 for game in group),'candidateScore':mean,'descriptiveOpeningClusterLower95':lower,'openingPairStandardDeviation':sd,
            'terminationReasons':dict(Counter(game['reason'] for game in group)),'timing':times,
            'meanObservedTimeRatio':times['candidate']['meanObservedMs']/times['baseline']['meanObservedMs'],
            'aggregateNodesPerSecondRatio':times['candidate']['nodesPerSecond']/times['baseline']['nodesPerSecond'],'formalPass':False,'shippingOrEloClaimAllowed':False}
    close(summary['byArm'],by_arm,'independent complete match aggregate')
    inputs.recheck()
    result={'schema':'chessy.hybrid-matches-independent-audit.v1','status':'PASS','registrationSha256':digest,'summarySha256':old.digest(summary_raw),
        'researchOnly':True,'formalPass':False,'shippingOrEloClaimAllowed':False,'games':len(games),'independentlyReplayedSearchedMoves':moves,'warmupSearches':12,
        'mismatches':0,'byArm':by_arm,'pythonChessVersion':old.chess.__version__,'engineSearchesRunByAuditor':0,'inputs':{str(p):info for p,info in inputs.files.items()},
        'limitations':['Independent legality/repetition/adjudication uses python-chess; wall-clock numbers are validated retained observations, not remeasured.',
            'Both candidate arms face shipped; this is not a direct hybrid-versus-expanded match.',
            'Exposed opening bank and short time control are developmental; descriptive clustered bounds do not establish Elo or shipping acceptance.']}
    with output.open('x') as stream:json.dump(result,stream,sort_keys=True,indent=2);stream.write('\n')
    print(json.dumps({k:result[k] for k in ('status','games','independentlyReplayedSearchedMoves','mismatches')}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--execution-repo',required=True,type=Path);p.add_argument('--registration',required=True,type=Path);p.add_argument('--registration-sha256',required=True);p.add_argument('--run-dir',required=True,type=Path);p.add_argument('--output',required=True,type=Path)
    a=p.parse_args();audit(a.execution_repo,a.registration,a.registration_sha256,a.run_dir,a.output)
