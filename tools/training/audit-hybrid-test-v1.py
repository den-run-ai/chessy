#!/usr/bin/env python3
"""Audit an already completed, consumed hybrid test; never opens a sealed test.

The marker and completed receipt must authenticate before row access. No
training/model implementation is imported. Only the one retained candidate is
reconstructed with the independent v3 binary decoder and scalar hybrid blend.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import numpy as np
HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('_independent_hybrid',HERE.with_name('audit-hybrid-v1.py'))
hybrid=importlib.util.module_from_spec(spec);spec.loader.exec_module(hybrid)
calc,old=hybrid.calc,hybrid.old
require,close,sha=old.require,old.close,old.sha
CONTRACT_SHA='4af21daf6ed8015ddfa5ff8cc0636f9e3d997f43a5c56c24d564587f8485eb60'


def bootstrap(data,baseline,candidate):
    difference=old.row_losses(candidate,data['target'])-old.row_losses(baseline,data['target'])
    groups={}
    for family,value in zip(data['family'],difference):groups.setdefault(family,[]).append(float(value))
    ordered=[groups[family] for family in sorted(groups)]
    totals=np.asarray([math.fsum(group) for group in ordered]);counts=np.asarray([len(group) for group in ordered])
    rng=np.random.default_rng(1050915);draws=[]
    for _ in range(2000):
        indexes=rng.integers(0,len(ordered),len(ordered))
        draws.append(float(totals[indexes].sum()/counts[indexes].sum()))
    return {'families':len(ordered),'iterations':2000,'seed':1050915,'candidateMinusBaselineMean':float(difference.mean()),
            'ci95':np.quantile(draws,[.025,.975]).tolist()}


def audit(repo,run,output):
    repo,run,output=Path(repo).absolute(),Path(run).absolute(),Path(output).absolute()
    require(not output.exists(),'refusing to replace independent test audit')
    old.EVIDENCE.clear();old.REPO=repo
    read,load=old.read,old.load
    rules=load(repo/'eval/training/hybrid-test-v1.json',CONTRACT_SHA)
    raw=read(run/'test.json');receipt=json.loads(raw)
    require(receipt['schema']=='chessy.hybrid-test.v1' and receipt['testOpened'] is True,'completed opening receipt required before any rows')
    require(receipt['contractSha256']==CONTRACT_SHA and receipt['role']=='nnue-test' and receipt['summarySha256']==old.SUMMARY_SHA,'test role/registration identity differs')
    require(receipt['runtimeIntegrationAllowed'] is False and receipt['formalPass'] is False and receipt['trainingFits']==receipt['paidSpendUsd']==0,'research test scope differs')
    require(receipt['binarySha256']==rules['modelBinarySha256'] and receipt['selectionSha256']==rules['screenArtifacts']['selection.json'],'frozen test candidate differs')
    consumed=repo/'.research-state'/('dataset-'+sha((old.SUMMARY_SHA+'\0nnue-test').encode()))/'test-opened.json'
    marker=load(consumed)
    close(marker,{k:receipt[k] for k in ('head','contractSha256','selectionSha256','decisionSha256','binarySha256','summarySha256','role')}|{'schema':'chessy.hybrid-test-opening.v1'},'consumed dataset marker')
    close(load(repo/'.research-state'/('hybrid-test-'+CONTRACT_SHA)/'test-completed.json'),{'sha256':sha(raw),'offlinePass':receipt['offlinePass']},'completed test state')
    inputs=receipt['inputSha256']
    def locate(digest):
        matches=[Path(p) for p,value in inputs.items() if value==digest]
        require(bool(matches),'missing authenticated test evidence');return matches[0]
    def pinned(path):
        require(str(path) in inputs,'omitted test helper');return read(path,inputs[str(path)])
    # Authenticate executed helpers before launching the comparator subprocess.
    # Read only tracked code paths here; do not iterate/hash raw dataset closure.
    for name,value in inputs.items():
        p=Path(name)
        if not p.is_relative_to(repo):continue
        relative=str(p.relative_to(repo))
        if relative.startswith(('tools/','test/','assets/','experiments/','eval/')):
            actual=read(p,value);committed=subprocess.check_output(['git','show',receipt['head']+':'+relative],cwd=repo)
            require(actual==committed,'test helper differs from execution commit')
    for p in (HERE,HERE.with_name('audit-hybrid-v1.py'),HERE.with_name('audit-h4-v3.py'),HERE.with_name('audit-h4-v2.py')):read(p)
    for name,pin in rules['screenArtifacts'].items():read(run/name,pin)
    offline=load(run/'selection.json',rules['screenArtifacts']['selection.json'])
    require(offline['testEligible'] is True and offline['decision']['config']==rules['config'],'frozen eligible gate differs')
    screen=load(repo/'eval/training/hybrid-v1b.json',rules['screenContractSha256'])
    inherited=screen['inherited']['final']
    integer=calc.decode(read(locate(inherited['binary']),inherited['binary']),8,True)
    floating=calc.floating_parts(load(locate(inherited['float']),inherited['float']),8,True)
    close(load(locate(inherited['metadata']),inherited['metadata']),calc.expected_metadata(8,True),'full model metadata')
    for q,f,scale in zip(integer,floating,(16384,16384,4096,16384*4096)):
        require(np.array_equal(q,np.rint(f*scale)),'model float/integer encoding differs')
    label=load(locate(old.SUMMARY_SHA),old.SUMMARY_SHA)
    entries=[entry for entry in label['output']['files'] if entry['role']=='nnue-test'];require(len(entries)==1,'test role inventory differs')
    entry=entries[0]
    # First test-row read occurs only after all consumed/completed state and
    # frozen-candidate checks above. This command cannot perform an initial test.
    rows=[json.loads(line) for line in read(locate(entry['sha256']),entry['sha256'],entry['bytes']).splitlines()]
    require(len(rows)==entry['rows']==receipt['testRows']==2331 and all(row['role']=='nnue-test' for row in rows),'opened test inventory differs')
    for row in rows:
        wdl=row['teacher']['wdl'];require(sum(wdl)==1000 and row['teacher']['targetWhite']==(wdl[0]+.5*wdl[1])/1000,'teacher target identity differs')
    fens=[row['fen'] for row in rows];phase=calc.phase_values(fens)
    coarse=np.asarray(['endgame' if p<=6 else 'opening' if p>=18 else 'middlegame' for p in phase])
    require(np.array_equal(coarse,np.asarray([row['phaseBucket'] for row in rows])),'phase semantics differ')
    weights=load(locate(old.HCE_SELECTION_SHA),old.HCE_SELECTION_SHA)['researchWeights']
    require(sha(json.dumps(weights,separators=(',',':')).encode())==old.HCE_WEIGHTS_SHA,'expanded weights differ')
    baseline,expanded=old.comparator_rows(fens,weights)
    data={'fens':fens,'features':old.features(fens),'materialPhase':phase,'baseline':baseline,'expanded':expanded,'phase':coarse,
        'teacher':np.asarray([row['teacher']['scoreCp'] for row in rows]),'target':np.asarray([row['teacher']['targetWhite'] for row in rows]),
        **{key:np.asarray([row[source] for row in rows]) for key,source in [('row_id','id'),('cluster','cluster'),('source','sourceId'),('family','positionFamily')]}}
    identities=load(run/'split-identities.json',rules['screenArtifacts']['split-identities.json'])['shared-train']
    for key in ('row_id','cluster','source','family'):require(not set(data[key])&set(identities[key]),'test/shared-train identity overlap')
    neural=calc.inference(integer,data,True,True);fp=calc.inference(floating,data,False,True)
    config=rules['config'];cp=hybrid.blend(neural,expanded,phase,config);floating_cp=hybrid.blend(fp,expanded,phase,config,False)
    result=receipt['result'];require(set(result['models'])=={config['id']},'opened test evaluated an alternative candidate')
    chosen=result['models'][config['id']];close(chosen['config'],config,'test gate')
    close(chosen['quality'],old.metrics(cp,data),'test integer metrics');close(chosen['floatQuality'],old.metrics(floating_cp,data),'test float metrics')
    checks=old.quantization_check(cp,floating_cp);numerical=checks.pop('reasons');close(chosen['checks'],checks,'test numerical checks')
    close(chosen['coverage'],hybrid.coverage(data,config),'test gate coverage');close(result['coverage'],hybrid.coverage(data),'test coverage')
    require(set(result['comparators'])=={'shipped-hce','frozen-expanded-hce','pure-neural'},'test comparator inventory')
    for name,prediction in [('shipped-hce',baseline),('frozen-expanded-hce',expanded),('pure-neural',neural)]:close(result['comparators'][name],old.metrics(prediction,data),'test comparator '+name)
    stops=[config['id']+':numerical-guard'] if numerical else [];close(result['numericalStopReasons'],stops,'test numerical stop reasons')
    intervals={}
    for name,prediction in [('shipped-hce',baseline),('frozen-expanded-hce',expanded)]:
        stops.extend(name+':'+reason for reason in old.guards(result['comparators'][name],chosen['quality']))
        intervals[name]=bootstrap(data,prediction,cp)
        if intervals[name]['ci95'][1]>=0:stops.append(name+':bootstrap-upper95-not-negative')
    close(receipt['bootstrap'],intervals,'independent cluster bootstrap');close(receipt['stopReasons'],stops,'test stop reasons')
    require(receipt['offlinePass']==(not stops),'test pass differs')
    output_data={'schema':'chessy.hybrid-test-independent-audit.v1','status':'PASS','testAlreadyOpened':True,'initialTestOpeningPerformed':False,
        'testReceiptSha256':sha(raw),'contractSha256':CONTRACT_SHA,'candidateConfig':config,'testRows':len(rows),'independentlyDecodedOutputs':len(rows)*2,
        'mismatches':0,'offlinePass':not stops,'stopReasons':stops,'bootstrap':intervals,'inputs':old.EVIDENCE,
        'limitations':['This audits the already consumed offline test and cannot authorize initial test access or reselection.',
            'Source/teacher admission and outer-role isolation are inherited authenticated checks; all test predictions and loss intervals are independently recomputed.',
            'Playing strength, production licensing, device cost and formal evaluator admission remain separate.']}
    with output.open('x') as stream:json.dump(output_data,stream,sort_keys=True,indent=2);stream.write('\n')
    print(json.dumps({k:output_data[k] for k in ('status','testAlreadyOpened','testRows','mismatches','offlinePass','stopReasons')}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--audit-completed-test',action='store_true');p.add_argument('--execution-repo',type=Path,required=True);p.add_argument('--run-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    if not args.audit_completed_test:p.error('explicit --audit-completed-test required; initial test opening is not supported')
    audit(args.execution_repo,args.run_dir,args.output)
