#!/usr/bin/env python3
"""Independent completed v4 audit; no trainer/model imports or NNUE-test reads.

Reuses previously tested independent v3 binary decoding, inference and scalar
metrics. Reconstructs the normalized objective and delegates the independently
implemented factorial/conditional-budget decision reconstruction to a small
separate module. The frozen execution checkout is only read.
"""
from __future__ import annotations
import argparse
import importlib.util
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import numpy as np
HERE=Path(__file__).resolve()
sys.path.insert(0,str(HERE.parent))
spec=importlib.util.spec_from_file_location('_independent_v3_audit',HERE.with_name('audit-h4-v3.py'))
calc=importlib.util.module_from_spec(spec)
spec.loader.exec_module(calc)
import h4_v4_audit_stages as stages
old=calc.old
require,close,sha=calc.require,calc.close,calc.sha
phase_values,decode,floating_parts=calc.phase_values,calc.decode,calc.floating_parts
inference,expected_metadata=calc.inference,calc.expected_metadata
Q1,Q2,CP=16384,4096,400


def objective_audit(floating, integer, config, seed, data, qat):
    """Independent gather/scatter gradient and architecture-matched L2 penalty."""
    h=config['hidden'];phase=config['mode']=='phase-residual-shipped-hce'
    effective=tuple(part/scale for part,scale in zip(integer,(Q1,Q1,Q2,Q1*Q2))) if qat else floating
    w,b,o,ob=effective
    wi,bi,turn=data['features']
    table=np.vstack((w,np.zeros((1,h))))
    pw,pb=table[wi].sum(axis=1)+b,table[bi].sum(axis=1)+b
    aw,ab=np.clip(pw,0,1),np.clip(pb,0,1)
    ordered=np.concatenate((np.where(turn[:,None]==1,aw,ab),np.where(turn[:,None]==1,ab,aw)),axis=1)
    mix=np.column_stack((data['materialPhase']/24,1-data['materialPhase']/24)) if phase else np.ones((len(turn),1))
    logits=inference(effective,data,False,phase)/100
    weights=np.where(data['phase']=='endgame',config['endgameWeight'],1.).astype(float)
    weights/=weights.sum()
    delta=(np.exp(-np.logaddexp(0,-logits))-data['target'])*4*weights*turn
    head_gradient=delta[:,None]*mix
    ordered_gradient=head_gradient@o
    gw=np.where(turn[:,None]==1,ordered_gradient[:,:h],ordered_gradient[:,h:])*((pw>0)&(pw<1))
    gb=np.where(turn[:,None]==1,ordered_gradient[:,h:],ordered_gradient[:,:h])*((pb>0)&(pb<1))
    first=np.zeros((768,h))
    for unit in range(h):
        first[:,unit]=np.bincount(wi.ravel(),weights=np.repeat(gw[:,unit],32),minlength=769)[:768]
        first[:,unit]+=np.bincount(bi.ravel(),weights=np.repeat(gb[:,unit],32),minlength=769)[:768]
    data_gradient=np.concatenate((first.ravel(),(gw+gb).sum(axis=0),(head_gradient.T@ordered).ravel(),head_gradient.sum(axis=0)))
    params=np.concatenate(tuple(value.ravel() for value in floating))
    anchor=np.concatenate((np.random.default_rng(seed).normal(0,.04,768*h),np.full(h,.25),np.zeros(len(params)-(768*h+h))))
    displacement=params-anchor
    coefficients=np.full(len(params),config['l2'])
    coefficients[768*h+h:] *= .5 if phase else 1
    reg_gradient=coefficients*displacement
    gradient=data_gradient+reg_gradient
    components={'dataCE':float(np.dot(weights,old.row_losses(inference(effective,data,False,phase),data['target']))),
        'regularizer':float(.5*np.dot(coefficients,displacement*displacement)),
        'dataGradientL2':float(np.linalg.norm(data_gradient)),'regularizerGradientL2':float(np.linalg.norm(reg_gradient)),
        'gradientL2':float(np.linalg.norm(gradient)),'gradientMaxAbs':float(np.max(np.abs(gradient))),
        'fakeQuantization':bool(qat),'normalizedWeightedMean':True,'trunkL2':config['l2'],
        'outputL2':config['l2']*(.5 if phase else 1)}
    pre=np.concatenate((pw,pb))
    activation={'rows':len(turn),'perspectivesPooled':2,'zeroActivationFraction':(pre<=0).mean(axis=0).tolist(),
        'upperSaturationFraction':(pre>=1).mean(axis=0).tolist(),'interiorFraction':((pre>0)&(pre<1)).mean(axis=0).tolist()}
    return components,activation,gradient


def check_curve(record, training, rows, final=False):
    config = record['config']
    budget, epochs = config['epochs'], record['epochsRun']
    require(0<epochs<=budget and (final or epochs==budget), 'epoch budget differs')
    require(record['updates']==math.ceil(rows/training['batchSize'])*epochs, 'optimizer update count differs')
    require(record['convergenceClaimed'] is False and math.isfinite(record['seconds']) and record['seconds']>=0, 'time/convergence differs')
    expected_epochs = sorted(set(range(training['checkpointEveryEpochs'],epochs+1,training['checkpointEveryEpochs']))|{epochs})
    require([p['epoch'] for p in record['curves']]==expected_epochs, 'incomplete curve checkpoint inventory')
    for point in record['curves']:
        epoch = point['epoch']
        want_lr = training['minimumLearningRate']+.5*(training['learningRate']-training['minimumLearningRate'])*(1+math.cos(math.pi*(epoch-1)/(budget-1)))
        close(point['learningRate'],want_lr,'cosine schedule',absolute=1e-14)
        require(point['qat']==(epoch>budget*2//3), 'QAT schedule differs')
        require(math.isfinite(point['trainQuantizedCe']) and point['trainQuantizedCe']>=0, 'nonfinite curve CE')
        require(point['objectiveComponents']['fakeQuantization']==point['qat'], 'objective QAT flag differs')
        for value in point['objectiveComponents'].values():
            require(isinstance(value,(bool,float,int)) and math.isfinite(value), 'nonfinite objective component')
        for key in ('gradientNorm','maximumAbsGradient','projectedUpdates'):
            require(math.isfinite(point[key]) and point[key]>=0, 'invalid optimizer diagnostic')
        if not final:
            require(math.isfinite(point['innerValidationQuantizedCe']) and point['innerValidationQuantizedCe']>=0, 'nonfinite inner curve CE')
    if final:
        require(record['selectedEpoch']==epochs and record['selectedInnerCe'] is None, 'refit checkpoint differs')
        return record['curves'][-1]
    best = min((p for p in record['curves'] if p['qat']),key=lambda p:(p['innerValidationQuantizedCe'],p['epoch']))
    close(record['selectedEpoch'],best['epoch'],'selected curve epoch')
    close(record['selectedInnerCe'],best['innerValidationQuantizedCe'],'selected curve CE')
    return best


def audit(repo, run, output, relocations=()):
    repo,run,output = Path(repo).absolute(),Path(run).absolute(),Path(output).absolute()
    require(np.__version__=='2.3.5','frozen NumPy required for initialization-anchor replay')
    require(not output.exists(),'refusing to overwrite audit output')
    require(not (run/'failure.json').exists(),'failed run is not a completed screen')
    def relocated(path):
        value=Path(path)
        for before,after in relocations:
            if value.is_relative_to(before):return Path(after)/value.relative_to(before)
        return value
    def read(path,wanted=None,size=None):return old.read(relocated(path),wanted,size)
    def load(path,wanted=None,size=None):return json.loads(read(path,wanted,size))
    summary_raw=read(run/'selection.json')
    summary=json.loads(summary_raw)
    require(summary['schema']=='chessy.h4-v4-screen.v1' and summary['researchOnly'] and summary['productionFitAllowed'] is False,
            'foreign screen receipt')
    require(summary['testOpened'] is False and summary['runtimeIntegrationPerformed'] is False,'screen scope differs')
    contract_raw=read(repo/'eval/training/natural-nnue-h4-v4.json',summary['contractSha256'])
    contract=json.loads(contract_raw)
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
    require(head==summary['head'],'execution checkout HEAD differs')
    key=sha((summary['contractSha256']+'\0'+old.SUMMARY_SHA+'\0nnue-test').encode())
    state=repo/'.research-state'/key
    frozen=load(state/'selection-frozen.json')
    require(frozen['sha256']==sha(summary_raw) and frozen['testEligible']==summary['testEligible'],'completion state differs')
    inputs=summary['inputSha256']
    # Authenticate execution helpers before running comparator extraction, but
    # deliberately never iterate/read the data closure (it contains test files).
    code_paths=('tools/training/natural-nnue-h4-v4.py','tools/training/h4_v4_recipe.py','tools/training/natural-nnue-h4-v3.py','tools/training/h4_v3_model.py',
        'tools/training/h4_v2_model.py','tools/training/h4_model.py','tools/training/h4_data.py',
        'tools/training/natural-nnue-h4.py','tools/training/h4_ablation.py',
        'tools/training/natural-pilot-fit.py','tools/training/analyze-hce-synthetic-pilot.py',
        'test/training/h4-v3-reference.js','test/training/h4-v2-reference.js',
        'test/training/hce-r3-baseline.js','test/training/hce-r3-linear.js','test/training/hce-r3-features.js',
        'test/training/corpus.js','test/wasm-test-engine.js','assets/engine.js','assets/wasm-engine.js',
        'assets/chessy-ai-fast.wasm','experiments/wasm/src/eval.rs')
    for relative in code_paths:
        path=repo/relative
        expected=[wanted for name,wanted in inputs.items() if relocated(name)==path]
        require(len(expected)==1,'missing/ambiguous execution dependency '+relative)
        read(path,expected[0])
    for path in (HERE,HERE.with_name('audit-h4-v2.py'),HERE.with_name('audit-h4-v3.py'),HERE.with_name('h4_v4_audit_stages.py')):
        read(path,sha(path.read_bytes()))
    evidence=summary['auditEvidence']
    require(evidence['auditedFiles']==53 and evidence['auditedClosureSha256']=='5f5deaf0ff2240ce4e507451322af465f67d4b219d1ddb0a030a70f56ab3156f',
            'source/teacher admission closure differs')
    def locate(digest):
        matches=[Path(p) for p,s in inputs.items() if s==digest]
        require(bool(matches),'missing pinned evidence digest')
        return matches[0]
    label=load(locate(old.SUMMARY_SHA),old.SUMMARY_SHA)
    weights=load(locate(old.HCE_SELECTION_SHA),old.HCE_SELECTION_SHA)['researchWeights']
    require(sha(json.dumps(weights,separators=(',',':')).encode())==old.HCE_WEIGHTS_SHA,'frozen expanded weights differ')
    old.REPO=repo
    def data_for(fens, rows=None):
        baseline,expanded=old.comparator_rows(fens,weights)
        data={'fens':fens,'features':old.features(fens),'materialPhase':phase_values(fens),'baseline':baseline,'expanded':expanded}
        if rows is not None:
            data.update(target=np.asarray([r['teacher']['targetWhite'] for r in rows]),teacher=np.asarray([r['teacher']['scoreCp'] for r in rows]),
                phase=np.asarray([r['phaseBucket'] for r in rows]),family=np.asarray([r['positionFamily'] for r in rows]),
                source=np.asarray([r['sourceId'] for r in rows]),row_id=np.asarray([r['id'] for r in rows]),cluster=np.asarray([r['cluster'] for r in rows]))
        return data
    def role(role):
        require(role in ('shared-train','nnue-validation'),'NNUE-test loading is forbidden')
        entry=next(e for e in label['output']['files'] if e['role']==role)
        rows=[json.loads(line) for line in read(locate(entry['sha256']),entry['sha256'],entry['bytes']).splitlines()]
        require(len(rows)==entry['rows']==contract['data']['sharedTrainRows' if role=='shared-train' else 'nnueValidationRows'],'role count differs')
        require(all(r['role']==role for r in rows),'foreign row role')
        for row in rows:
            wdl=row['teacher']['wdl']
            require(sum(wdl)==1000 and row['teacher']['targetWhite']==(wdl[0]+.5*wdl[1])/1000,'teacher target/WDL differs')
        return data_for([r['fen'] for r in rows],rows)
    data={'shared-train':role('shared-train')}
    full=data['shared-train']
    mask=np.asarray([int.from_bytes(hashlib.sha256(b'chessy-h4-v2-inner-20260915\0'+f.encode()).digest()[:8],'big')%5==0 for f in full['family']])
    data['inner-train'],data['inner-validation']=old.slice_data(full,~mask),old.slice_data(full,mask)
    identities=load(run/'split-identities.json')
    for name in ('shared-train','inner-train','inner-validation'):close(old.identity(data[name]),identities[name],'split identities '+name)
    close(summary['innerRows'],{'train':int((~mask).sum()),'validation':int(mask.sum())},'inner coverage')
    for identity in ('row_id','cluster','family','source'):
        require(not set(data['inner-train'][identity])&set(data['inner-validation'][identity]),'inner overlap')
    if 'nnue-validation' in summary.get('final',{}).get('quality',{}):
        marker=load(state/'validation-opened.json')
        require(marker['modelSha256']==summary['final']['artifacts']['binary']['sha256'],'outer exposure model differs')
        data['nnue-validation']=role('nnue-validation')
        for identity in ('row_id','cluster','family','source'):
            require(not set(full[identity])&set(data['nnue-validation'][identity]),'outer overlap')
    for name,dataset in data.items():
        for comparator,column in (('shipped-hce','baseline'),('frozen-expanded-hce','expanded')):
            close(old.metrics(dataset[column],dataset),summary['comparators'][name][comparator],'comparator '+name)
    data['authored']=data_for(old.AUTHORED)
    outputs=0
    def checkpoint(record, final=False):
        nonlocal outputs
        config=record['config'] if not final else record['fit']['config']
        h,phase=config['hidden'],config['mode']=='phase-residual-shipped-hce'
        artifacts=record['artifacts']
        def artifact(kind):
            item=artifacts[kind]
            require(Path(item['path']).name==item['path'],'checkpoint must be direct run child')
            return read(run/item['path'],item['sha256'],item['bytes'])
        close(json.loads(artifact('metadata')),expected_metadata(h,phase),'complete metadata')
        parts=decode(artifact('binary'),h,phase)
        floats=floating_parts(json.loads(artifact('float')),h,phase)
        for integer,floating,scale in zip(parts,floats,(Q1,Q1,Q2,Q1*Q2)):
            require(np.array_equal(integer,np.rint(floating*scale)),'float/integer encoding mismatch')
        fit=record['fit'] if final else record
        best=check_curve(fit,contract['training'],len(full['fens']) if final else int((~mask).sum()),final)
        roles=(('shared-train','authored')+ (('nnue-validation',) if 'nnue-validation' in data else ())) if final else ('inner-train','inner-validation','authored')
        reasons=[]
        for name in roles:
            integer=inference(parts,data[name],True,phase)
            floating=inference(floats,data[name],False,phase)
            outputs+=len(integer)
            check=old.quantization_check(integer,floating)
            close(check,record['checks'][name],'quantization '+name)
            reasons.extend(name+':'+r for r in check['reasons'])
            if name!='authored':
                measured=old.metrics(integer,data[name])
                close(measured,record['quality'][name],'quality '+name)
                if final:close(old.metrics(floating,data[name]),record['floatQuality'][name],'float quality '+name)
                if name==('shared-train' if final else 'inner-train'):
                    close(measured['crossEntropy'],best['trainQuantizedCe'],'selected train curve CE')
                if name=='inner-validation':close(measured['crossEntropy'],fit['selectedInnerCe'],'selected inner curve CE')
        training_role='shared-train' if final else 'inner-train'
        components,activation,_=objective_audit(floats,parts,config,fit['seed'],data[training_role],best['qat'])
        close(components,best['objectiveComponents'],'matched weighted objective')
        close(activation,best['activations'],'activation diagnostics')
        close(components['gradientL2'],best['gradientNorm'],'independent full gradient norm')
        close(components['gradientMaxAbs'],best['maximumAbsGradient'],'independent full gradient maximum')
        return reasons
    for record in summary['runs']:
        require(not checkpoint(record),'development numerical guard failed')
        close(load(run/(record['config']['id']+'-'+str(record['seed'])+'.report.json')),record,'standalone checkpoint receipt')
        print(json.dumps({'audited':record['config']['id'],'seed':record['seed'],'independentOutputs':outputs}),flush=True)
    stage_result=stages.audit_stages(summary,contract,lambda relative:load(run/relative))
    decision=stage_result['decision']
    close(load(state/'architecture-frozen.json'),stage_result['factorialDecision'],'frozen factorial decision')
    close(load(state/'recipe-frozen.json'),decision,'frozen final recipe')
    if decision['config'] is None:
        stop=decision.get('stopReasons',[])
        require('final' not in summary and not (state/'model-frozen.json').exists(),'stopped decision has a frozen final model')
        require(not (state/'validation-opened.json').exists(),'no-candidate run opened outer validation')
    else:
        final=summary['final']
        close(final['fit']['config'],decision['config'],'refit config')
        require(final['fit']['seed']==decision['seed'] and final['fit']['epochsRun']==decision['epochs'],'refit seed/epoch differs')
        model_state=load(state/'model-frozen.json')
        close(model_state['artifacts'],final['artifacts'],'frozen model artifacts')
        require(model_state['decisionSha256']==sha(read(run/'decision.json')),'model decision hash differs')
        require(frozen['binarySha256']==final['artifacts']['binary']['sha256'],'selection model differs')
        stop=checkpoint(final,True)
        if 'nnue-validation' in data:
            for name,base in summary['comparators']['nnue-validation'].items():
                stop.extend(name+':'+r for r in old.guards(base,final['quality']['nnue-validation']))
        else:
            require(bool(stop),'final omitted outer without numerical failure')
            require(not (state/'validation-opened.json').exists(),'unreported outer exposure')
        if final['artifacts']['binary']['bytes']>contract['quantization']['advancementParameterBudgetBytes']:stop.append('parameter-size')
    close(summary['stopReasons'],stop,'final guards')
    require(summary['testEligible']==(not stop),'test eligibility differs')
    seconds=sum(r['seconds'] for r in summary['runs'])+(summary['final']['fit']['seconds'] if 'final' in summary else 0)
    close(summary['trainingSeconds'],seconds,'total fit time')
    require(len(summary['runs'])+(1 if 'final' in summary else 0)<=contract['training']['maximumFits'],'fit cap exceeded')
    test_markers=list((repo/'.research-state').glob('*/test-opened.json'))
    result={'schema':'chessy.h4-v4-independent-audit.v1','status':'PASS','executionHead':head,
        'selectionSha256':sha(summary_raw),'contractSha256':sha(contract_raw),'mismatches':0,
        'selectedDevelopmentCheckpoints':len(summary['runs']),'finalCheckpointAudited':'final' in summary,
        'independentObjectivesAndGradientsAudited':len(summary['runs'])+int('final' in summary),
        'independentlyDecodedOutputs':outputs,'nnueTestFilesReadOrHashed':0,'decision':decision,'stopReasons':stop,
        'testEligible':not stop,'factorialDecision':stage_result['factorialDecision'],'factorialAblations':stage_result['factorialAblations'],
        'budgetProgression':summary['budgetProgression'],'saturation':stage_result['saturation'],
        'saturationReached':summary['saturationReached'],'endReason':summary['endReason'],
        'globalOrLegacyTestOpeningMarkers':len(test_markers),
        'testMarkerContentsRead':False,'inputs':old.EVIDENCE,
        'dependencies':['Original 53-file source/teacher admission is inherited; no source replay or test-file hashing.',
            'Authenticated shipped WASM and frozen expanded-HCE helper supply comparator scores.',
            'Independent v2 audit supplies python-chess feature mapping and scalar metric/guard routines.'],
        'limitations':['Optimizer trajectories and unretained checkpoint values are not independently replayed.',
            'All curve checkpoints are checked for inventory, schedule, finite values and selection consistency; unretained weights are unavailable.',
            'No NNUE-test data, device performance or playing strength is evaluated.']}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:json.dump(result,stream,sort_keys=True,indent=2,allow_nan=False);stream.write('\n')
    print(json.dumps({k:result[k] for k in ('status','selectedDevelopmentCheckpoints','independentlyDecodedOutputs','mismatches','nnueTestFilesReadOrHashed')}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-completed',action='store_true')
    parser.add_argument('--execution-repo',type=Path,required=True)
    parser.add_argument('--run-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--relocate',action='append',default=[],metavar='OLD=NEW')
    args=parser.parse_args()
    if not args.run_completed:parser.error('explicit --run-completed required before any dataset access')
    mapping=[tuple(map(Path,p.split('=',1))) for p in args.relocate]
    if any(len(p)!=2 for p in mapping):parser.error('relocation must be OLD=NEW')
    audit(args.execution_repo,args.run_dir,args.output,mapping)
