#!/usr/bin/env python3
"""Independent completed hybrid audit: no trainer/model imports or test access.

Binary inference and Python-chess features come from the existing independent
v3 audit. Scalar divmod blending, phase guards and candidate selection are
reconstructed here. Source admission is inherited from the pinned 53-file
closure; only shared-train and the already-opened NNUE validation are decoded.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import chess
import numpy as np
HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('_hybrid_independent_v3',HERE.with_name('audit-h4-v3.py'))
calc=importlib.util.module_from_spec(spec);spec.loader.exec_module(calc)
old=calc.old
require,close,sha=old.require,old.close,old.sha
CONTRACT_SHA='6dba25fed6adbcc056e00b3d78b15606857a4b69c118ee57ef67168f9c11c8d0'
ALLOWED_ROLES=('shared-train','nnue-validation')


def role_entry(label,role):
    require(role in ALLOWED_ROLES,'sealed or foreign role is forbidden')
    matches=[entry for entry in label['output']['files'] if entry['role']==role]
    require(len(matches)==1,'missing or duplicate allowed role')
    return matches[0]


def weights_for(phase,config):
    require(type(phase) is int and 0<=phase<=24,'invalid independent material phase')
    if config['kind']=='hard':
        threshold=config['threshold']
        require(type(threshold) is int and 0<=threshold<24,'invalid hard threshold')
        return int(phase>threshold),1
    require(config['kind']=='smooth','unknown hybrid kind')
    lo,hi=config['lo'],config['hi']
    require(type(lo) is int and type(hi) is int and 0<=lo<hi<=24,'invalid smooth endpoints')
    return max(0,min(hi-lo,phase-lo)),hi-lo


def blend(neural,fallback,phase,config,integer=True):
    require(len(neural)==len(fallback)==len(phase),'blend row inventory differs')
    result=[]
    for n,f,p in zip(neural,fallback,phase):
        w,d=weights_for(int(p),config)
        if integer:
            require(float(n).is_integer() and float(f).is_integer(),'noninteger component')
            # divmod has a nonnegative remainder for negative numerators too.
            q,r=divmod(w*int(n)+(d-w)*int(f),d)
            result.append(q+int(2*r>=d))
        else:
            result.append((w*float(n)+(d-w)*float(f))/d)
    return np.asarray(result,dtype=np.int64 if integer else float)


def phase_guard(base,candidate):
    reasons=[]
    for phase in old.PHASES:
        b,c=base['byPhase'][phase],candidate['byPhase'][phase]
        require(type(b['rows']) is int and type(c['rows']) is int,'noninteger phase coverage')
        if min(b['rows'],c['rows'])<100:reasons.append(phase+'-coverage')
        else:
            require(all(math.isfinite(x['crossEntropy']) and x['crossEntropy']>=0 for x in (b,c)),'invalid phase CE')
            if c['crossEntropy']>b['crossEntropy']*1.01:reasons.append(phase+'-CE-guard')
    return reasons


def select(development,configs):
    require(set(development['models'])=={c['id'] for c in configs},'missing/extra gate inventory')
    stops=list(development['numericalStopReasons']);eligible=[]
    for config in configs:
        record=development['models'][config['id']]
        close(record['config'],config,'gate configuration')
        require(math.isfinite(record['quality']['crossEntropy']) and record['quality']['crossEntropy']>=0,'invalid inner CE')
        reasons=phase_guard(development['comparators']['shipped-hce'],record['quality'])
        close(record['innerPhaseStopReasons'],reasons,'inner phase guard')
        if not reasons:eligible.append(config)
    if not eligible:stops.append('no-inner-phase-eligible-candidate')
    winner=None if stops else min(eligible,key=lambda c:development['models'][c['id']]['quality']['crossEntropy'])
    return winner,stops


def require_single_outer(summary,winner):
    if winner is None:
        require('outer' not in summary,'rejected inner screen opened outer')
    else:
        require(set(summary['outer']['models'])=={winner['id']},'outer has alternative or missing gate')
        close(summary['outer']['models'][winner['id']]['config'],winner,'frozen outer gate')


def coverage(data,config=None):
    phase=data['materialPhase'];pieces=np.asarray([len(chess.Board(f).piece_map()) for f in data['fens']])
    def counts(mask):return {'rows':int(mask.sum()),**{str(k):int(np.sum(mask&(pieces<=k))) for k in (3,4,5,6,7)}}
    result={'materialPhaseCounts':{str(p):int(np.sum(phase==p)) for p in range(25)},
            'pieceCountPotentialSyzygyCoverage':{'meaning':'piece count only; castling rights and exact supported material are not adjudicated',
                'all':counts(np.ones(len(phase),dtype=bool)),'endgame':counts(data['phase']=='endgame')}}
    if config:
        fractions=[weights_for(int(p),config) for p in phase]
        result['gateCoverage']={'expandedOnly':sum(w==0 for w,d in fractions),'blend':sum(0<w<d for w,d in fractions),'neuralOnly':sum(w==d for w,d in fractions)}
    return result


def audit(repo,run,output,relocations=()):
    repo,run,output=Path(repo).absolute(),Path(run).absolute(),Path(output).absolute()
    require(not output.exists(),'refusing to replace audit output')
    old.EVIDENCE.clear();old.REPO=repo
    def relocated(path):
        value=Path(path)
        for before,after in relocations:
            if value.is_relative_to(before):return Path(after)/value.relative_to(before)
        return value
    def read(path,wanted=None,size=None):return old.read(relocated(path),wanted,size)
    def load(path,wanted=None,size=None):return json.loads(read(path,wanted,size))
    raw=read(run/'selection.json');summary=json.loads(raw)
    require(summary['schema']=='chessy.hybrid-screen.v1b' and summary['researchOnly'] is True and summary['productionFitAllowed'] is False,'screen scope differs')
    require(summary['testOpened'] is False and summary['runtimeIntegrationPerformed'] is False,'screen exposure/scope differs')
    require(summary['trainingFits']==summary['newLabels']==summary['paidSpendUsd']==0,'zero-fit/spend contract differs')
    require(summary['contractSha256']==CONTRACT_SHA,'unregistered hybrid contract')
    contract=load(repo/'eval/training/hybrid-v1b.json',CONTRACT_SHA)
    close(summary['inherited'],contract['inherited'],'inherited pins')
    inputs=summary['inputSha256'];head=summary['head']
    def locate(digest):
        matches=[Path(p) for p,s in inputs.items() if s==digest]
        require(bool(matches),'missing pinned evidence identity')
        return matches[0]
    # Authenticate executed repo helpers against both receipt and execution commit.
    # Never iterate/read data closure: its inventory includes sealed test bytes.
    for path,wanted in inputs.items():
        p=relocated(path)
        if not p.is_relative_to(repo) or '.research-state' in p.parts:continue
        relative=str(p.relative_to(repo))
        if relative.startswith(('tools/','test/','assets/','experiments/','eval/')):
            data=read(p,wanted)
            committed=subprocess.check_output(['git','show',head+':'+relative],cwd=repo)
            require(data==committed,'execution helper differs from registered commit: '+relative)
    evidence=summary['auditEvidence']
    require(evidence['auditedFiles']==53 and evidence['auditedClosureSha256']=='5f5deaf0ff2240ce4e507451322af465f67d4b219d1ddb0a030a70f56ab3156f','admission closure differs')
    prior=load(locate(contract['inherited']['selectionSha256']),contract['inherited']['selectionSha256'])
    require(prior['contractSha256']==contract['inherited']['contractSha256'],'prior recipe differs')
    public=load(repo/'eval/neural-h4-v4/results-2026-09.json')
    require(public['privateSelectionSha256']==contract['inherited']['selectionSha256'],'public prior checkpoint identity differs')
    models={}
    for role,prefix in [('development',contract['inherited']['developmentPrefix']),('final','final')]:
        source=prior['final'] if role=='final' else next(r for r in prior['runs'] if r['config']['id']=='h8-phase-eg1-e900' and r['seed']==10513)
        parts={}
        for kind,suffix in [('binary','bin'),('float','float.json'),('metadata','metadata.json')]:
            pin=contract['inherited'][role][kind];artifact=source['artifacts'][kind]
            require(artifact['sha256']==pin and artifact['path']==prefix+'.'+suffix,'checkpoint differs from inherited selection')
            parts[kind]=read(locate(pin),pin,artifact['bytes'])
        close(json.loads(parts['metadata']),calc.expected_metadata(8,True),'complete inherited metadata')
        integer=calc.decode(parts['binary'],8,True);floating=calc.floating_parts(json.loads(parts['float']),8,True)
        for q,f,scale in zip(integer,floating,(16384,16384,4096,16384*4096)):
            require(np.array_equal(q,np.rint(f*scale)),'inherited float/binary mismatch')
        models[role]=(integer,floating)
    state=repo/'.research-state'/('hybrid-'+CONTRACT_SHA)
    frozen=load(state/'selection-frozen.json')
    close(frozen,{'selectionSha256':sha(raw),'testEligible':summary['testEligible']},'completion state')
    started=load(state/'run-started.json');require(started['head']==head and started['contractSha256']==CONTRACT_SHA,'start state differs')
    require(relocated(started['output'])==run,'start output differs')
    decision_raw=read(run/'decision.json');decision=json.loads(decision_raw)
    close(summary['decision'],decision,'decision receipt')
    close(load(state/'candidate-frozen.json'),{'decisionSha256':sha(decision_raw),**decision},'candidate freeze')
    label=load(locate(old.SUMMARY_SHA),old.SUMMARY_SHA)
    hce=load(locate(old.HCE_SELECTION_SHA),old.HCE_SELECTION_SHA)['researchWeights']
    require(sha(json.dumps(hce,separators=(',',':')).encode())==old.HCE_WEIGHTS_SHA,'expanded weights differ')
    def role_data(role):
        entry=role_entry(label,role)
        rows=[json.loads(line) for line in read(locate(entry['sha256']),entry['sha256'],entry['bytes']).splitlines()]
        require(len(rows)==entry['rows'] and all(r['role']==role for r in rows),'role row inventory differs')
        for row in rows:
            wdl=row['teacher']['wdl']
            require(sum(wdl)==1000 and row['teacher']['targetWhite']==(wdl[0]+.5*wdl[1])/1000,'target/WDL differs')
        fens=[r['fen'] for r in rows];phase=calc.phase_values(fens)
        coarse=np.asarray(['endgame' if p<=6 else 'opening' if p>=18 else 'middlegame' for p in phase])
        require(np.array_equal(coarse,np.asarray([r['phaseBucket'] for r in rows])),'material/coarse phase semantics differ')
        baseline,expanded=old.comparator_rows(fens,hce)
        return {'fens':fens,'features':old.features(fens),'materialPhase':phase,'baseline':baseline,'expanded':expanded,
            'target':np.asarray([r['teacher']['targetWhite'] for r in rows]),'teacher':np.asarray([r['teacher']['scoreCp'] for r in rows]),
            'phase':coarse,**{k:np.asarray([r[rk] for r in rows]) for k,rk in [('family','positionFamily'),('source','sourceId'),('row_id','id'),('cluster','cluster')]}}
    full=role_data('shared-train')
    mask=np.asarray([int.from_bytes(hashlib.sha256(b'chessy-h4-v2-inner-20260915\0'+f.encode()).digest()[:8],'big')%5==0 for f in full['family']])
    training,inner=old.slice_data(full,~mask),old.slice_data(full,mask)
    identities=load(run/'split-identities.json')
    for name,d in [('shared-train',full),('inner-train',training),('inner-validation',inner)]:close(old.identity(d),identities[name],'split identities')
    for key in ('family','source','row_id','cluster'):require(not set(training[key])&set(inner[key]),'inner overlap')
    outputs=0
    def evaluate(data,parts,configs,reported,inner_stage=False):
        nonlocal outputs
        neural=calc.inference(parts[0],data,True,True);floating=calc.inference(parts[1],data,False,True)
        outputs+=len(neural);close(reported['coverage'],coverage(data),'role coverage')
        require(set(reported['comparators'])=={'shipped-hce','frozen-expanded-hce','pure-neural'},'comparator inventory differs')
        for name,cp in [('shipped-hce',data['baseline']),('frozen-expanded-hce',data['expanded']),('pure-neural',neural)]:close(reported['comparators'][name],old.metrics(cp,data),'comparator '+name)
        stops=[]
        for config in configs:
            cp=blend(neural,data['expanded'],data['materialPhase'],config);fp=blend(floating,data['expanded'],data['materialPhase'],config,False)
            outputs+=len(cp);r=reported['models'][config['id']]
            close(r['quality'],old.metrics(cp,data),'integer hybrid metrics '+config['id'])
            close(r['floatQuality'],old.metrics(fp,data),'float hybrid metrics '+config['id'])
            numerical=old.quantization_check(cp,fp);reasons=numerical.pop('reasons');close(r['checks'],numerical,'hybrid numerical guard')
            if reasons:stops.append(config['id']+':numerical-guard')
            close(r['coverage'],coverage(data,config),'gate coverage')
            if inner_stage:
                jumps=[]
                for p in range(24):
                    a=blend(neural,data['expanded'],np.full(len(cp),p),config)
                    b=blend(neural,data['expanded'],np.full(len(cp),p+1),config);jumps.append(np.abs(b-a))
                maximum=np.max(np.stack(jumps),axis=0)
                close({k:r['transitionDiagnostic'][k] for k in ('maximumCp','p95Cp','p99Cp')},{'maximumCp':int(maximum.max()),'p95Cp':float(np.quantile(maximum,.95)),'p99Cp':float(np.quantile(maximum,.99))},'gate transition')
        close(reported['numericalStopReasons'],stops,'numerical stop reasons')
        return neural
    neural=evaluate(inner,models['development'],contract['configurations'],summary['development'],True)
    winner,stops=select(summary['development'],contract['configurations'])
    expected={'schema':'chessy.hybrid-frozen-candidate.v1','config':winner,'head':head,'contractSha256':CONTRACT_SHA,
        'finalBinarySha256':contract['inherited']['final']['binary'],'selectionUsesOuter':False,'testDecoded':False,'developmentStopReasons':stops}
    close(decision,expected,'independently selected candidate');require_single_outer(summary,winner)
    if winner:
        close(load(state/'validation-opened.json'),{'decisionSha256':sha(decision_raw),'previouslyExposed':True},'outer exposure state')
        s,e,p=inner['baseline'],inner['expanded'],inner['materialPhase']
        variants={'shipped':s,'expanded':e,'pure-neural':neural,'hybrid':blend(neural,e,p,winner),
            'gated-neural-shipped-fallback':blend(neural,s,p,winner),'expanded-base-plus-gated-residual':e+blend(neural-s,np.zeros(len(p),dtype=np.int64),p,winner)}
        close(summary['componentAblations']['models'],{name:old.metrics(cp,inner) for name,cp in variants.items()},'component ablations')
        outer=role_data('nnue-validation')
        for key in ('family','source','row_id','cluster'):require(not set(full[key])&set(outer[key]),'outer overlap')
        evaluate(outer,models['final'],[winner],summary['outer'])
        stops+=summary['outer']['numericalStopReasons']
        quality=summary['outer']['models'][winner['id']]['quality']
        for name in ('shipped-hce','frozen-expanded-hce'):stops.extend(name+':'+r for r in old.guards(summary['outer']['comparators'][name],quality))
    else:require(not (state/'validation-opened.json').exists(),'rejected screen has outer marker')
    close(summary['stopReasons'],stops,'overall stop reasons');require(summary['testEligible']==(not stops),'test eligibility differs')
    # Recheck only the exact allowed inputs read by this audit, never the closure.
    for path,info in list(old.EVIDENCE.items()):read(path,info['sha256'],info['bytes'])
    result={'schema':'chessy.hybrid-independent-audit.v1','status':'PASS','executionHead':head,'selectionSha256':sha(raw),'contractSha256':CONTRACT_SHA,
        'independentlyDecodedOutputs':outputs,'developmentGates':len(contract['configurations']),'outerCandidates':int(winner is not None),
        'nnueTestFilesReadOrHashed':0,'mismatches':0,'decision':decision,'stopReasons':stops,'testEligible':not stops,'inputs':old.EVIDENCE,
        'limitations':['Source/teacher admission inherits the pinned 53-file audit; sealed rows are never read or hashed.',
            'Historical optimizer trajectories are not replayed; inherited exact checkpoint bytes and all hybrid predictions are checked.',
            'Repeatedly exposed inner/outer validation remains exploratory. No playing-strength inference is made.']}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:json.dump(result,stream,indent=2,sort_keys=True,allow_nan=False);stream.write('\n')
    print(json.dumps({k:result[k] for k in ('status','independentlyDecodedOutputs','outerCandidates','mismatches','nnueTestFilesReadOrHashed','testEligible')}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run-completed',action='store_true');p.add_argument('--execution-repo',type=Path,required=True);p.add_argument('--run-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--relocate',action='append',default=[])
    a=p.parse_args()
    if not a.run_completed:p.error('explicit --run-completed required before dataset access')
    mappings=[tuple(map(Path,pair.split('=',1))) for pair in a.relocate]
    if any(len(pair)!=2 for pair in mappings):p.error('relocation must be OLD=NEW')
    audit(a.execution_repo,a.run_dir,a.output,mappings)
