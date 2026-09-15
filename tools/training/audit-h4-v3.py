#!/usr/bin/env python3
"""Independent completed-screen audit; never loads or hashes NNUE-test data.

No trainer/model imports and no fitting. Reuses the independent v2 audit's
python-chess mapping and scalar metrics; decodes both model layouts itself.
Source/teacher admission is an explicit inherited dependency. Only selected
checkpoints can be numerically replayed: other learning-curve values are checked
for complete inventory, schedule, finite values and selection consistency.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys

os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import chess
import numpy as np

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('_independent_v2_audit', HERE.with_name('audit-h4-v2.py'))
old = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old)
require, close, sha = old.require, old.close, old.sha
Q1, Q2, CP = 16384, 4096, 400


def phase_values(fens):
    values = []
    for fen in fens:
        board = chess.Board(fen)
        values.append(min(24, sum({chess.KNIGHT:1, chess.BISHOP:1, chess.ROOK:2, chess.QUEEN:4}.get(p.piece_type, 0)
                                  for p in board.piece_map().values())))
    return np.asarray(values, dtype=np.int64)


def decode(raw, hidden, phase):
    require(hidden in (4, 8), 'foreign hidden width')
    heads = 2 if phase else 1
    require(len(raw) == (1548*hidden+8 if phase else 1544*hidden+4), 'binary length differs')
    offset = 0
    def take(code, count):
        nonlocal offset
        result = np.asarray(struct.unpack_from('<'+str(count)+code, raw, offset), dtype=np.int64)
        offset += struct.calcsize('<'+str(count)+code)
        return result
    w = take('h', 768*hidden).reshape(768, hidden)
    b = take('i', hidden)
    o = take('h', heads*2*hidden).reshape(heads, 2*hidden)
    ob = take('i', heads)
    for value, bound in ((w,31130),(b,31130),(o,16384),(ob,134217728)):
        require(np.all(np.abs(value)<=bound), 'quantized projection bound exceeded')
    require(np.all(np.sort(np.abs(w),axis=0)[-32:].sum(axis=0)+np.abs(b)<=2147483647), 'int32 bound exceeded')
    bound = max(Q1*sum(abs(int(v)) for v in row)+abs(int(bias)) for row,bias in zip(o,ob))
    factor = 24 if phase else 1
    require(bound*factor*CP+factor*Q1*Q2//2<=9223372036854775807, 'int64 bound exceeded')
    return w,b,o,ob


def floating_parts(params, hidden, phase):
    heads = 2 if phase else 1
    p = np.asarray(params,dtype=float)
    require(p.shape == (768*hidden+hidden+heads*(2*hidden+1),) and np.all(np.isfinite(p)), 'float shape/nonfinite')
    cut = 768*hidden
    parts = p[:cut].reshape(768,hidden),p[cut:cut+hidden],p[cut+hidden:-heads].reshape(heads,2*hidden),p[-heads:]
    for value,bound in zip(parts,(1.9,1.9,4,2)):
        require(np.all(np.abs(value)<=bound), 'float projection bound exceeded')
    return parts


def inference(parts, data, integer, phase):
    w,b,o,ob = parts
    wi,bi,turn = data['features']
    table = np.vstack((w,np.zeros((1,w.shape[1]),dtype=w.dtype)))
    upper = Q1 if integer else 1
    aw,ab = np.clip(table[wi].sum(axis=1)+b,0,upper),np.clip(table[bi].sum(axis=1)+b,0,upper)
    ordered = np.concatenate((np.where(turn[:,None]==1,aw,ab),np.where(turn[:,None]==1,ab,aw)),axis=1)
    outputs = ordered@o.T+ob
    if phase:
        material = data['materialPhase']
        total = material*outputs[:,0]+(24-material)*outputs[:,1]
    else:
        total = outputs[:,0]
    factor = 24 if phase else 1
    if integer:
        denominator = factor*Q1*Q2
        cp = (total*CP+denominator//2)//denominator
    else:
        cp = total*(CP/factor)
    return cp*turn+data['baseline']


def expected_metadata(hidden, phase):
    result = old.expected_metadata(hidden, True)
    if phase:
        result.update(schema='chessy-h4-v3-quantized-v1',parameters=773*hidden+2,parameterBytes=1548*hidden+8,
            layout=f'W1[768,{hidden}]:i16,b1[{hidden}]:i32,W2[2,{2*hidden}]:i16,b2[2]:i32;little-endian',
            outputOrder=f'MG,EG;side-to-move[{hidden}],other[{hidden}]',
            scoreRounding='floor((taperedNumerator*400+denominator/2)/denominator);white-sign-after-stm-round',
            mode='phase-residual-shipped-hce',phaseRule='min(24,N+B+2R+4Q);both-colors')
    return result


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


def choose(records, configurations, seeds, baseline):
    require(len(records)==len(configurations)*len(seeds), 'development fit inventory differs')
    choices,rejected = [],[]
    for order,config in enumerate(configurations):
        group = [r for r in records if r['config']==config]
        require(sorted(r['seed'] for r in group)==seeds, 'missing/duplicate/foreign seed')
        median = sorted(group,key=lambda r:(r['selectedInnerCe'],r['seed']))[1]
        reasons=[]
        for phase in old.PHASES:
            b,c = baseline['byPhase'][phase],median['quality']['inner-validation']['byPhase'][phase]
            if min(b['rows'],c['rows'])<100:reasons.append('shipped-hce:'+phase+'-coverage')
            elif c['crossEntropy']>b['crossEntropy']*1.01:reasons.append('shipped-hce:'+phase+'-CE-guard')
        if reasons:rejected.append({'config':config['id'],'reasons':reasons})
        elif config['eligibleForTest']:
            choices.append((median['selectedInnerCe'],order,config,median,sorted(r['selectedEpoch'] for r in group)[1]))
    if not choices:
        return {'config':None,'stopReasons':['no-inner-phase-eligible-candidate'],'phaseRejected':rejected}
    loss,_,config,median,epoch=min(choices,key=lambda x:x[:2])
    return {'config':config,'seed':median['seed'],'epochs':epoch,'medianInnerCe':loss,
            'innerRepresentativeEpoch':median['selectedEpoch'],'phaseRejected':rejected}


def ablations(records, configurations):
    pairs = [(0,1,'phase-heads-and-head-regularization'),(1,2,'h4-training-budget'),(2,3,'endgame-weight'),
             (3,4,'capacity'),(4,5,'h8-training-budget')]
    result=[]
    for a,b,name in pairs:
        left=[r['selectedInnerCe'] for r in records if r['config']==configurations[a]]
        right=[r['selectedInnerCe'] for r in records if r['config']==configurations[b]]
        gain=1-float(np.median(right))/float(np.median(left))
        result.append({'ablation':name,'control':configurations[a]['id'],'candidate':configurations[b]['id'],
            'relativeMedianCeImprovement':gain,'controlSeedRange':[min(left),max(left)],'candidateSeedRange':[min(right),max(right)],
            'smallPositiveGainBelowPoint1Percent':0<gain<.001,'boundedGridOnly':True,'convergenceClaimed':False})
    return result


def audit(repo, run, output, relocations=()):
    repo,run,output = Path(repo).absolute(),Path(run).absolute(),Path(output).absolute()
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
    require(summary['schema']=='chessy.h4-v3-screen.v1' and summary['researchOnly'] and summary['productionFitAllowed'] is False,
            'foreign screen receipt')
    require(summary['testOpened'] is False and summary['runtimeIntegrationPerformed'] is False,'screen scope differs')
    contract_raw=read(repo/'eval/training/natural-nnue-h4-v3.json',summary['contractSha256'])
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
    code_paths=('tools/training/natural-nnue-h4-v3.py','tools/training/h4_v3_model.py',
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
    for name,wanted in ((HERE,sha(HERE.read_bytes())),(HERE.with_name('audit-h4-v2.py'),sha(HERE.with_name('audit-h4-v2.py').read_bytes()))):
        read(name,wanted)
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
    if summary['decision']['config'] is not None:
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
        roles=('shared-train','authored','nnue-validation') if final else ('inner-train','inner-validation','authored')
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
        return reasons
    for record in summary['runs']:
        require(not checkpoint(record),'development numerical guard failed')
        close(load(run/(record['config']['id']+'-'+str(record['seed'])+'.report.json')),record,'standalone checkpoint receipt')
        print(json.dumps({'audited':record['config']['id'],'seed':record['seed'],'independentOutputs':outputs}),flush=True)
    decision=choose(summary['runs'],contract['configurations'],contract['training']['seeds'],summary['comparators']['inner-validation']['shipped-hce'])
    decision.update(head=head,contractSha256=summary['contractSha256'],selectionUsesOuter=False,nnueValidationDecoded=False,nnueTestDecoded=False)
    for value in (summary['decision'],load(run/'decision.json'),load(state/'recipe-frozen.json')):close(value,decision,'recipe decision')
    close(summary['ablations'],ablations(summary['runs'],contract['configurations']),'finite grid ablations')
    if decision['config'] is None:
        stop=['no-inner-phase-eligible-candidate']
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
        for name,base in summary['comparators']['nnue-validation'].items():
            stop.extend(name+':'+r for r in old.guards(base,final['quality']['nnue-validation']))
        if final['artifacts']['binary']['bytes']>contract['quantization']['advancementParameterBudgetBytes']:stop.append('parameter-size')
    close(summary['stopReasons'],stop,'final guards')
    require(summary['testEligible']==(not stop),'test eligibility differs')
    seconds=sum(r['seconds'] for r in summary['runs'])+(summary['final']['fit']['seconds'] if 'final' in summary else 0)
    close(summary['trainingSeconds'],seconds,'total fit time')
    require(len(summary['runs'])+(1 if 'final' in summary else 0)<=contract['training']['maximumFits'],'fit cap exceeded')
    result={'schema':'chessy.h4-v3-independent-audit.v1','status':'PASS','executionHead':head,
        'selectionSha256':sha(summary_raw),'contractSha256':sha(contract_raw),'mismatches':0,
        'selectedDevelopmentCheckpoints':len(summary['runs']),'finalCheckpointAudited':'final' in summary,
        'independentlyDecodedOutputs':outputs,'nnueTestFilesReadOrHashed':0,'decision':decision,'stopReasons':stop,
        'testEligible':not stop,'ablations':summary['ablations'],'inputs':old.EVIDENCE,
        'dependencies':['Original 53-file source/teacher admission is inherited; no source replay or test-file hashing.',
            'Authenticated shipped WASM and frozen expanded-HCE helper supply comparator scores.',
            'Independent v2 audit supplies python-chess feature mapping and scalar metric/guard routines.'],
        'limitations':['Optimizer trajectories and unretained checkpoint values are not independently replayed.',
            'All curve checkpoints are checked for inventory, schedule, finite values and selection consistency.',
            'No NNUE-test data, device performance or playing strength is evaluated.']}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:json.dump(result,stream,sort_keys=True,indent=2,allow_nan=False);stream.write('\n')
    print(json.dumps({k:result[k] for k in ('status','selectedDevelopmentCheckpoints','independentlyDecodedOutputs','mismatches','nnueTestFilesReadOrHashed')}))


def self_test():
    fens=['4k3/8/8/8/8/8/8/4K3 w - - 0 1','4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1']
    data={'features':old.features(fens),'materialPhase':phase_values(fens),'baseline':np.array([17,-31])}
    require(data['materialPhase'].tolist()==[0,4],'independent phase mapping differs')
    for h in (4,8):
        for phase in (False,True):
            heads=2 if phase else 1
            raw=bytes(768*h*2+h*4+heads*2*h*2)+struct.pack('<'+str(heads)+'i',*([-2097152]*heads))
            parts=decode(raw,h,phase)
            require(inference(parts,data,True,phase).tolist()==[5,-19],'signed rounding or baseline addition differs')
            try:decode(raw+b'\0',h,phase)
            except AssertionError:pass
            else:raise AssertionError('trailing bytes accepted')
    print('Independent H4/H8 single/phase decoding and signed-rounding synthetic checks passed; no dataset opened')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--run-completed',action='store_true')
    parser.add_argument('--execution-repo',type=Path)
    parser.add_argument('--run-dir',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--relocate',action='append',default=[],metavar='OLD=NEW')
    args=parser.parse_args()
    if args.self_test:self_test()
    elif args.run_completed:
        if not all((args.execution_repo,args.run_dir,args.output)):parser.error('--execution-repo, --run-dir and --output are required')
        mapping=[tuple(map(Path,p.split('=',1))) for p in args.relocate]
        if any(len(p)!=2 for p in mapping):parser.error('relocation must be OLD=NEW')
        audit(args.execution_repo,args.run_dir,args.output,mapping)
    else:parser.error('explicit --run-completed required before any dataset access')
