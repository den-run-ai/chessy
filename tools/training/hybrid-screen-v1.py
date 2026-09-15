#!/usr/bin/env python3
"""Bounded authenticated hybrid development screen; this executable cannot open test."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
for name in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'):os.environ[name]='1'
import numpy as np
import h4_data as data_io
import h4_v3_model as phase_model
ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
shared=module('_hybrid_shared',ROOT/'tools/training/natural-nnue-h4-v3.py')
hybrid=module('_hybrid_model',ROOT/'tools/training/hybrid-model-v1.py')
util=shared.util
CONTRACT=ROOT/'eval/training/hybrid-v1.json'
CONTRACT_SHA='b5bd9d7509a5bf504d8c26b211c340939a914f7fac9480b765353ace1e159b36'


def implementation():
    rules=json.loads(util.read_exact(CONTRACT,CONTRACT_SHA))
    paths=[CONTRACT,Path(__file__),ROOT/'tools/training/hybrid-model-v1.py',ROOT/'tools/training/hybrid-reference-v1.js',
           ROOT/'tools/training/hybrid-selftest-v1.py',ROOT/'tools/training/natural-nnue-h4-v3.py',
           ROOT/'tools/training/h4_v3_model.py',ROOT/'tools/training/h4_v2_model.py',ROOT/'tools/training/h4_model.py',
           ROOT/'tools/training/h4_data.py',ROOT/'tools/training/natural-nnue-h4.py',ROOT/'tools/training/h4_ablation.py',
           ROOT/'test/training/h4-v3-reference.js',ROOT/'eval/neural-h4-v4/results-2026-09.json']
    tracked=set(subprocess.check_output(['git','ls-files'],cwd=ROOT,text=True).splitlines())
    if any(str(p.relative_to(ROOT)) not in tracked for p in paths):raise ValueError('commit all implementation before measurements')
    if subprocess.check_output(['git','diff','HEAD','--',*[str(p.relative_to(ROOT)) for p in paths]],cwd=ROOT):raise ValueError('implementation differs from commit')
    expected={p:util.digest(p.read_bytes()) for p in paths};expected.update(data_io.fit.closure())
    for exe in (sys.executable,subprocess.check_output(['which','node'],text=True).strip()):
        p=Path(exe).resolve();expected[p]=util.digest(p.read_bytes())
    return rules,expected,subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()


def authenticate_checkpoints(directory,rules,expected):
    receipt_path=directory/'selection.json';raw=util.read_exact(receipt_path,rules['inherited']['selectionSha256'])
    expected[receipt_path]=util.digest(raw);receipt=json.loads(raw)
    public=json.loads((ROOT/'eval/neural-h4-v4/results-2026-09.json').read_text())
    if public['privateSelectionSha256']!=util.digest(raw):raise ValueError('v4 public selection identity differs')
    if receipt['contractSha256']!=rules['inherited']['contractSha256']:raise ValueError('v4 contract differs')
    models={}
    for role,prefix in [('development',rules['inherited']['developmentPrefix']),('final','final')]:
        source=receipt['final'] if role=='final' else next(r for r in receipt['runs'] if r['config']['id']=='h8-phase-eg1-e900' and r['seed']==10513)
        artifacts=source['artifacts'];contents={}
        for key,suffix in [('binary','bin'),('float','float.json'),('metadata','metadata.json')]:
            p=directory/(prefix+'.'+suffix);a=artifacts[key]
            if p.name!=a['path'] or a['sha256']!=rules['inherited'][role][key]:raise ValueError('unexpected inherited checkpoint')
            contents[key]=util.read_exact(p,a['sha256']);expected[p]=a['sha256']
        params=np.asarray(json.loads(contents['float']));quantized=phase_model.quantize(params,hidden=8,baseline_id='shipped-hce')
        if quantized.to_bytes()!=contents['binary'] or quantized.metadata()!=json.loads(contents['metadata']):raise ValueError('inherited model float/integer mismatch')
        models[role]={'params':params,'quantized':quantized,'prefix':directory/prefix}
    return models


def coverage(data,phase,config=None):
    pieces=np.asarray([sum(c.isalpha() for c in f.split()[0]) for f in data.fens])
    def counts(mask):return {'rows':int(np.sum(mask)),**{str(k):int(np.sum(mask&(pieces<=k))) for k in (3,4,5,6,7)}}
    result={'materialPhaseCounts':{str(p):int(np.sum(phase==p)) for p in range(25)},
            'pieceCountPotentialSyzygyCoverage':{'meaning':'piece count only; castling rights and exact supported material are not adjudicated','all':counts(np.ones(data.rows,dtype=bool)),
                                              'endgame':counts(data.phase=='endgame')}}
    if config:
        w,d=hybrid.gate(phase,config);result['gateCoverage']={'expandedOnly':int(np.sum(w==0)),'blend':int(np.sum((w>0)&(w<d))),'neuralOnly':int(np.sum(w==d))}
    return result


def evaluate(data,model,bases,configs,output,*,include_ablations=False):
    phase=phase_model.phase_from_fens(data.fens);features=phase_model.features_from_fens(data.fens)
    neural=model['quantized'].predict_cp(*features,baseline_cp=data.baseline_cp,phase_units=phase)
    floating=phase_model.predict_cp(model['params'],*features,hidden=8,baseline_cp=data.baseline_cp,phase_units=phase)
    fallback=bases['frozen-expanded-hce'];predictions={c['id']:hybrid.blend(neural,fallback,phase,c) for c in configs}
    with tempfile.TemporaryDirectory(prefix='hybrid-parity-',dir=output) as name:
        p=Path(name)/'configs.json';p.write_text(json.dumps(configs))
        records=[json.dumps({'id':str(i),'fen':fen,'shippedCp':int(data.baseline_cp[i]),'expandedCp':int(fallback[i])}) for i,fen in enumerate(data.fens)]
        proc=subprocess.run(['node',str(ROOT/'tools/training/hybrid-reference-v1.js'),str(model['prefix'])+'.bin',str(model['prefix'])+'.metadata.json',str(p)],
                            input='\n'.join(records)+'\n',text=True,capture_output=True,check=True)
        actual=[json.loads(line) for line in proc.stdout.splitlines()]
    if len(actual)!=data.rows or any(r['id']!=str(i) for i,r in enumerate(actual)):raise ValueError('independent row identity mismatch')
    if not np.array_equal(neural,np.asarray([r['neuralCp'] for r in actual])):raise ValueError('neural integer mismatch')
    if not np.array_equal(phase,np.asarray([r['phase'] for r in actual])):raise ValueError('phase mismatch')
    reports={};reasons=[]
    for ix,c in enumerate(configs):
        cp=predictions[c['id']];fp=hybrid.blend(floating,fallback,phase,c,integer=False)
        mismatches=int(np.sum(cp!=np.asarray([r['hybrids'][ix] for r in actual])))
        delta=np.abs(cp-fp)
        checks={'rows':data.rows,'integerMismatches':mismatches,'maximumAbsFloatDifferenceCp':float(np.max(delta)),
                'meanAbsFloatDifferenceCp':float(np.mean(delta)),'maximumAbsoluteScoreCp':float(max(np.max(np.abs(cp)),np.max(np.abs(fp))))}
        if mismatches or checks['maximumAbsFloatDifferenceCp']>5 or checks['meanAbsFloatDifferenceCp']>1 or checks['maximumAbsoluteScoreCp']>10000:
            reasons.append(c['id']+':numerical-guard')
        report={'config':c,'quality':util.quality_metrics(cp,data),'floatQuality':util.quality_metrics(fp,data),'checks':checks,'coverage':coverage(data,phase,c)}
        if include_ablations:
            # Hold component values fixed while varying phase by one unit. This isolates
            # the gate contribution; it is not a claim about legal move score changes.
            jumps=[]
            for p in range(24):
                a=hybrid.blend(neural,fallback,np.full(data.rows,p),c)
                b=hybrid.blend(neural,fallback,np.full(data.rows,p+1),c)
                jumps.append(np.abs(b-a))
            max_jump=np.max(np.stack(jumps),axis=0)
            report['transitionDiagnostic']={'method':'max phase-adjacent gate-only cp difference per row with both evaluator outputs frozen; not legal-move discontinuity',
                    'maximumCp':int(np.max(max_jump)),'p95Cp':float(np.quantile(max_jump,.95)),'p99Cp':float(np.quantile(max_jump,.99))}
        reports[c['id']]=report
    base_quality={name:util.quality_metrics(cp,data) for name,cp in bases.items()}
    base_quality['pure-neural']=util.quality_metrics(neural,data)
    return {'models':reports,'comparators':base_quality,'coverage':coverage(data,phase),'numericalStopReasons':reasons},predictions,neural


def component_ablations(data,neural,bases,config):
    phase=phase_model.phase_from_fens(data.fens);shipped=bases['shipped-hce'];expanded=bases['frozen-expanded-hce']
    variants={'shipped':shipped,'expanded':expanded,'pure-neural':neural,
              'hybrid':hybrid.blend(neural,expanded,phase,config),
              'gated-neural-shipped-fallback':hybrid.blend(neural,shipped,phase,config),
              'expanded-base-plus-gated-residual':expanded+hybrid.blend(neural-shipped,np.zeros(data.rows,dtype=np.int64),phase,config)}
    return {'interpretation':'exploratory component isolation on reused inner-validation only; baseline swap may be distribution-shifted and is never eligible',
            'models':{name:util.quality_metrics(cp,data) for name,cp in variants.items()}}


def run(bundle,checkpoints,output):
    start=time.monotonic();rules,expected,head=implementation();auth=data_io.authenticate(bundle);expected.update(auth.expected)
    models=authenticate_checkpoints(checkpoints,rules,expected)
    state=ROOT/'.research-state'/('hybrid-'+CONTRACT_SHA)
    output.mkdir(parents=True,exist_ok=False)
    util.publish(state/'run-started.json',util.encoded({'head':head,'contractSha256':CONTRACT_SHA,'output':str(output)}),expected)
    train=data_io.load_role(auth,'shared-train');inner_train,inner=shared.inner_split(train)
    identities={r:data_io.fit.identities(d) for r,d in [('shared-train',train),('inner-train',inner_train),('inner-validation',inner)]}
    util.publish(output/'split-identities.json',util.encoded(identities),expected)
    print(json.dumps({'stage':'admitted','sharedTrain':train.rows,'innerValidation':inner.rows,'testDecoded':False}),flush=True)
    bases=util.comparator_predictions(auth,inner)
    development,predictions,neural=evaluate(inner,models['development'],bases,rules['configurations'],output,include_ablations=True)
    failures=development['numericalStopReasons'];eligible=[]
    for c in rules['configurations']:
        r=development['models'][c['id']];r['innerPhaseStopReasons']=shared.phase_guard(development['comparators']['shipped-hce'],r['quality'])
        if not r['innerPhaseStopReasons']:eligible.append(c)
    if not eligible:failures.append('no-inner-phase-eligible-candidate')
    winner=None if failures else min(eligible,key=lambda c:development['models'][c['id']]['quality']['crossEntropy'])
    decision={'schema':'chessy.hybrid-frozen-candidate.v1','config':winner,'head':head,'contractSha256':CONTRACT_SHA,
              'finalBinarySha256':rules['inherited']['final']['binary'],'selectionUsesOuter':False,'testDecoded':False,'developmentStopReasons':failures}
    util.publish(output/'decision.json',util.encoded(decision),expected)
    util.publish(state/'candidate-frozen.json',util.encoded({'decisionSha256':util.digest(util.encoded(decision)),**decision}),expected)
    print(json.dumps({'stage':'candidate-frozen','config':winner,'stopReasons':failures}),flush=True)
    summary={'schema':'chessy.hybrid-screen.v1','head':head,'contractSha256':CONTRACT_SHA,'researchOnly':True,'productionFitAllowed':False,
             'paidSpendUsd':0,'trainingFits':0,'newLabels':0,'testOpened':False,'runtimeIntegrationPerformed':False,
             'auditEvidence':auth.evidence,'inherited':rules['inherited'],'development':development,'decision':decision,
             'dataCaveat':rules['data']['caveat'],'stopReasons':list(failures),'testEligible':False,'inputSha256':{str(p):d for p,d in expected.items()}}
    if winner:
        summary['componentAblations']=component_ablations(inner,neural,bases,winner)
        util.publish(state/'validation-opened.json',util.encoded({'decisionSha256':util.digest(util.encoded(decision)),'previouslyExposed':True}),expected)
        outer=data_io.load_role(auth,'nnue-validation');outer_bases=util.comparator_predictions(auth,outer)
        result,_,_=evaluate(outer,models['final'],outer_bases,[winner],output)
        summary['outer']=result;chosen=result['models'][winner['id']]
        summary['stopReasons']+=result['numericalStopReasons']
        for name in outer_bases:
            summary['stopReasons'] += [name+':'+r for r in util.guard(result['comparators'][name],chosen['quality'])]
        summary['testEligible']=not summary['stopReasons']
    summary['elapsedSeconds']=time.monotonic()-start
    util.publish(output/'selection.json',util.encoded(summary),expected)
    util.publish(state/'selection-frozen.json',util.encoded({'selectionSha256':util.digest(util.encoded(summary)),'testEligible':summary['testEligible']}),expected)
    print(json.dumps({'stage':'completed','selected':winner,'testEligible':summary['testEligible'],'testOpened':False,'stopReasons':summary['stopReasons'],'elapsedSeconds':summary['elapsedSeconds']}),flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--checkpoints',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    run(a.bundle.absolute(),a.checkpoints.absolute(),a.output.absolute())
if __name__=='__main__':main()
