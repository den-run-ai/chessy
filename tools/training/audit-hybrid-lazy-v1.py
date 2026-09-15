#!/usr/bin/env python3
"""Audit a completed lazy-accumulator cost run without repeating any timing.

The auditor reconstructs the complete rotation, every paired statistic and the
registered decision. It loads actual WASM modules for untimed evaluation only.
No dataset, teacher split, engine search, training or cost producer is executed.
"""
from __future__ import annotations
import argparse
import gzip
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess

HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('_hybrid_lazy_independent_io',HERE.with_name('audit-natural-runtime.py'))
io=importlib.util.module_from_spec(spec);spec.loader.exec_module(io)
require=io.require


def close(actual,expected,label):
    if isinstance(expected,dict):
        require(isinstance(actual,dict) and actual.keys()==expected.keys(),label+' fields differ')
        for key in expected:close(actual[key],expected[key],label+'.'+key)
    elif isinstance(expected,float):
        require(io.finite(actual) and math.isclose(actual,expected,rel_tol=2e-12,abs_tol=2e-12),label+' value differs')
    else:require(io.equal(actual,expected),label+' value differs')


def statistics_from_rows(rows):
    lookup={(r['variant'],r['position'],r['repetition'],r['kind'],r['budget']):r for r in rows}
    require(len(lookup)==len(rows)==576,'missing or duplicate timing cells')
    stages=['opening']*4+['middlegame']*4+['endgame']*4
    expected=[]
    for repetition in range(4):
        for position in range(12):
            names=['shipped','original','lazy'];offset=(position+repetition)%3
            for variant in names[offset:]+names[:offset]:
                for kind,budget in [('evaluation',None),('nodes',4096),('nodes',16384),('time',40)]:
                    expected.append((variant,position,repetition,kind,budget))
    require(list(lookup)==expected,'registered rotation/order differs')
    exact=0
    for row in rows:
        require(row['stage']==stages[row['position']] and io.finite(row['elapsedMs']) and row['elapsedMs']>0,'invalid timing or phase')
        if row['kind']=='evaluation':
            require(row['repetitions']==10000 and io.integer(row['checksum']),'invalid evaluation inventory')
        else:
            result=dict(row['result']);move=result.get('move')
            require(isinstance(move,dict) and all(io.integer(move.get(k)) and 0<=move[k]<64 for k in ('from','to')),'invalid ABI move squares')
            square=lambda x:chr(97+x%8)+str(8-x//8)
            result['moveUci']=square(move['from'])+square(move['to'])+(move['promotion'] or '').lower()
            io.validate_result(result,111,row['budget'] if row['kind']=='nodes' else 0)
            require(row['result']['nodes']>0,'zero search nodes')
            if row['variant']=='lazy' and row['kind']=='nodes':
                other=lookup[('original',row['position'],row['repetition'],row['kind'],row['budget'])]
                require(io.equal(row['result'],other['result']),'available fixed-node result differs')
                exact+=1
    require(exact==96,'fixed-node comparison inventory differs')
    summary={}
    for stage in ['all','opening','middlegame','endgame']:
        summary[stage]={}
        for variant in ['original','lazy']:
            summary[stage][variant]={}
            for comparator in ['shipped','original']:
                if comparator==variant:continue
                metrics={}
                for kind,budget in [('evaluation',None),('nodes',4096),('nodes',16384),('time',40)]:
                    cells=[r for r in rows if r['variant']==variant and r['kind']==kind and r['budget']==budget and (stage=='all' or r['stage']==stage)]
                    ratios=[];elapsed=[];nps=[];full=0
                    for row in cells:
                        other=lookup[(comparator,row['position'],row['repetition'],kind,budget)]
                        ratios.append(row['elapsedMs']/other['elapsedMs']);elapsed.append(row['elapsedMs'])
                        if kind!='evaluation':
                            nps.append((row['result']['nodes']/row['elapsedMs'])/(other['result']['nodes']/other['elapsedMs']))
                            if kind=='nodes':full+=row['result']['nodes']==other['result']['nodes']==budget
                    result={'pairs':len(cells),'pairedMedianTimeRatio':statistics.median(ratios),'medianElapsedMs':statistics.median(elapsed)}
                    if kind!='evaluation':result.update(pairedMedianNpsRatio=statistics.median(nps),bothConsumedNodeBudget=full if kind=='nodes' else None)
                    metrics[kind+('' if budget is None else str(budget))]=result
                summary[stage][variant][comparator]=metrics
    return summary


def audit(repo,directory,cost,output,prior_audit):
    repo,directory,cost,output,prior_audit=map(lambda p:Path(p).absolute(),(repo,directory,cost,output,prior_audit))
    require(not output.exists(),'refusing to replace independent audit')
    inputs=io.Inputs()
    def snapshot(path):
        path=Path(path);return inputs.json(path,{'sha256':io.digest(path.read_bytes())})
    inherited=snapshot(prior_audit)
    require(inherited['status']=='PASS' and inherited['checks']['compiledParityMismatches']==0,'prior independent full-score audit did not pass')
    initial_path=prior_audit.parent/'hybrid-runtime-cost-v1.json'
    initial=inputs.json(initial_path,inherited['inputs'][str(initial_path)])
    integrity=snapshot(str(cost)+'.integrity.json')
    raw=inputs.read(cost,integrity);report=io.strict_json(raw)
    compressed=inputs.read(str(cost)+'.gz',{'sha256':integrity['gzipSha256'],'bytes':integrity['gzipBytes']})
    require(gzip.decompress(compressed)==raw and integrity['recordCount']==576,'cost compressed backup differs')
    require(report['schema']=='chessy.hybrid-runtime-lazy-cost.v1' and report['status']=='completed','completed lazy receipt required')
    require(report['researchOnly'] is True and report['productionIntegrationAllowed'] is False and report['strengthClaimAllowed'] is False and report['modelSelectionAllowed'] is False,'research scope differs')
    source=inputs.json(directory/'lazy-source.json',{'sha256':report['sourceReceiptSha256']})
    require(source['schema']=='chessy.hybrid-runtime-lazy-build.v1' and source['modelSha256']==report['modelSha256']=='3a759a37d3af0beed0dda352a05294686d286176a4dcbdfa85a3fabef0083f25','frozen model differs')
    require(report['config']==source['config']=={'kind':'smooth','lo':6,'hi':12,'id':'smooth-6-12'},'frozen gate differs')
    require(source['plan']==report['plan'] and report['plan']['expectedRecords']==576 and report['plan']['followupGamesAllowed'] is False and report['plan']['pvEqualityRequired'] is False,'registered plan differs')
    prior_source=inputs.json(Path(source['priorDirectory'])/'hybrid-source.json',{'sha256':source['priorSourceReceiptSha256']})
    require(source['priorSourceReceiptSha256']==report['priorSourceReceiptSha256'] and prior_source['expandedWeightsSha256']==report['expandedWeightsSha256'],'prior component binding differs')
    for dependency in source['dependencies']:inputs.read(repo/dependency['path'],dependency)
    require([r['variant'] for r in source['emitted']]==['original','lazy'],'source variant inventory differs')
    for variant in source['emitted']:
        for item in variant['files']:inputs.read(directory/variant['variant']/item['path'],item)
    native=inputs.json(directory/'lazy-native.json',{'sha256':report['nativeEvidenceSha256']})
    compiled=inputs.json(directory/'lazy-compiled.json',{'sha256':report['compiledEvidenceSha256']})
    require(native['sourceReceiptSha256']==compiled['sourceReceiptSha256']==report['sourceReceiptSha256'] and compiled['nativeEvidenceSha256']==report['nativeEvidenceSha256'],'build/native source binding differs')
    native_counts={}
    import re
    for kind,evidence in [('native',native),('compiled',compiled)]:
        require(evidence['passed'] is True and [r['variant'] for r in evidence['rows']]==['original','lazy'],'incomplete native/build evidence')
        require(evidence['toolchain']==report['toolchain'],'native/build toolchain differs')
        for row in evidence['rows']:
            require(row['status']==0 and row['signal'] is None and row['error'] is None,'unsuccessful native/build process')
            log=inputs.read(row['logPath'],{'sha256':row['logSha256'],'bytes':row['bytes']}).decode()
            if kind=='native':
                counts=re.findall(r'test result: ok\. (\d+) passed; 0 failed;',log)
                require(len(counts)==1,'native test count missing');native_counts[row['variant']]=int(counts[0])
            else:inputs.read(row['modulePath'],{'sha256':row['moduleSha256']})
    require(native_counts['original']>=10 and native_counts['lazy']>=17,'required native validation inventory missing')
    for tool in report['toolchain'].values():inputs.read(tool['path'],tool)
    ledger=snapshot(Path(source['priorDirectory'])/'.hybrid-runtime-lazy-v1.started.json')
    require(ledger==report['start'] and ledger['sourceReceiptSha256']==report['sourceReceiptSha256'] and Path(ledger['output'])==cost,'one-shot ledger binding differs')
    preflight=snapshot(str(cost)+'.preflight.json')
    require(preflight['sourceReceiptSha256']==report['sourceReceiptSha256'] and preflight['nativeEvidenceSha256']==report['nativeEvidenceSha256'] and preflight['parity']==report['parity'] and preflight['layout']==report['layout'],'preflight binding differs')
    require(report['layout']['positionBytes']==74 and report['layout']['undoBytes']==10 and report['layout']['stackBytes']>0,'lazy storage policy differs')
    require(len(report['parity'])==501 and [r['fen'] for r in report['parity']]==[r['fen'] for r in initial['parity']] and len({r['fen'] for r in report['parity']})==501,'compiled parity FEN inventory differs')
    module_paths={'shipped':repo/'assets/chessy-ai-fast.wasm','original':directory/'original/dist/chessy-ai-fast.wasm','lazy':directory/'lazy/dist/chessy-ai-fast.wasm'}
    for name,module_path in module_paths.items():
        info=report['modules'][name];inputs.read(module_path,{'sha256':info['sha256'],'bytes':info['rawBytes']})
    require(report['modules']['original']['sha256']==initial['modules']['hybrid']['sha256'] and report['modules']['shipped']['sha256']==initial['modules']['shipped']['sha256'],'original or shipped reference changed')
    # Only untimed evaluate calls; producer, search and data interfaces are absent.
    script="""const fs=require('node:fs'),zlib=require('node:zlib');const q=JSON.parse(fs.readFileSync(0,'utf8'));const W=require(q.wrapper);const out={};for(const [name,p] of Object.entries(q.paths)){const b=fs.readFileSync(p),e=W.loadSync(b);out[name]={scores:q.fens.map(f=>e.evaluate(f)),memoryBytes:e.memoryBytes(),brotliBytes:zlib.brotliCompressSync(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length};}process.stdout.write(JSON.stringify(out));"""
    for p in [repo/'assets/wasm-engine.js',HERE,HERE.with_name('audit-natural-runtime.py')]:inputs.read(p,{'sha256':io.digest(p.read_bytes())})
    actual=io.strict_json(subprocess.run(['node','-e',script],input=json.dumps({'wrapper':str(repo/'assets/wasm-engine.js'),'paths':{k:str(v) for k,v in module_paths.items()},'fens':[r['fen'] for r in initial['parity']]}),text=True,capture_output=True,check=True).stdout)
    for name,result in actual.items():
        expected=[r['shipped' if name=='shipped' else 'hybrid'] for r in initial['parity']]
        require(result['scores']==expected,'actual compiled full score mismatch')
        require(result['memoryBytes']==report['modules'][name]['memoryBytes']==(26542080 if name=='shipped' else 26607616),'WASM memory differs')
        require(result['brotliBytes']==report['modules'][name]['brotliBytes'],'Brotli byte count differs')
    for recorded,expected in zip(report['parity'],initial['parity']):
        require(recorded['wanted']==recorded['actual']==expected['hybrid'],'recorded full score differs')
    initial_checksums={(r['variant'],r['position']):r['checksum'] for r in initial['records'] if r['kind']=='evaluation'}
    for row in report['records']:
        if row['kind']=='evaluation':require(row['checksum']==initial_checksums[('shipped' if row['variant']=='shipped' else 'hybrid',row['position'])],'timed evaluation checksum differs from authenticated full-score reference')
    summary=statistics_from_rows(report['records']);close(report['summary'],summary,'paired summary')
    ratio=summary['all']['lazy']['original']['nodes16384']['pairedMedianNpsRatio']
    phases={s:summary[s]['lazy']['original']['nodes16384']['pairedMedianNpsRatio'] for s in ['opening','middlegame','endgame']}
    eligible=ratio>=1.05 and all(value>=.95 for value in phases.values())
    close(report['selection'],{'selected':'lazy' if eligible else None,'eligible':eligible,'exactEvaluation':True,'exactSearch':True,'nativeValidationPassed':True,'medianNpsRatioVsOriginal16384':ratio,'phaseNpsRatios':phases,'criteria':report['plan']['selection']},'registered selection')
    require(report['parityMismatches']==0 and report['searchSignatureMismatches']==[] and report['exactReturnedNodeBudgetSearchSignatures'] is True and report['exactReturnedNodeBudgetSearchPairs']==96 and report['pvEqualityClaimed'] is False,'validation flags differ')
    inputs.recheck()
    result={'schema':'chessy.hybrid-lazy-independent-audit.v1','status':'PASS','costSha256':io.digest(raw),'sourceReceiptSha256':report['sourceReceiptSha256'],'researchOnly':True,'productionIntegrationAllowed':False,'strengthClaimAllowed':False,
        'checks':{'completeRotatedTimingGrid':576,'actualCompiledScoresRechecked':1503,'uniqueFens':501,'compiledScoreMismatches':0,'exactAvailableFixedNodeSearchPairs':96,'allPairedStatisticsRecomputed':True,'nativeTests':native_counts,'selected':report['selection']['selected'],'timingRerun':False,'engineSearchesRunByAuditor':0,'datasetFilesRead':0,'pvEqualityClaimed':False},
        'selection':report['selection'],'layout':report['layout'],'modules':report['modules'],'summary':summary,'inputs':{str(p):info for p,info in inputs.files.items()},
        'limitations':['One quiet-host V8 timing grid; neither physical-device nor strength acceptance.','Full-score reference inherits the previously completed independent original runtime audit; actual new modules are loaded for evaluation only.','Native authored-path checks validate cache lifecycle and raw accumulators; available fixed-node search result objects are checked, with no PV claim.']}
    with output.open('x') as stream:json.dump(result,stream,sort_keys=True,indent=2);stream.write('\n')
    print(json.dumps({'status':'PASS','selected':result['checks']['selected'],'timingCells':576,'actualCompiledScores':1503,'medianNpsRatioVsOriginal16384':ratio,'phaseNpsRatios':phases}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['repo','directory','cost','output','prior-audit']:p.add_argument('--'+name,required=True,type=Path)
    a=p.parse_args();audit(a.repo,a.directory,a.cost,a.output,a.prior_audit)
