#!/usr/bin/env python3
"""Independent post-completion H4-v2 audit; no model/trainer imports or fitting.

Only shared-train and already-consumed NNUE-validation can be opened. There is
deliberately no NNUE-test loader. --run-completed is required in addition to the
completed selection receipt. The original source/teacher audits and the shipped
WASM/frozen HCE helpers are explicit dependencies, not independently re-created.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys

os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import chess
import numpy as np

WORK = REPO = RUN = None  # Bound by an explicit recovered-workspace argument.
HEAD = 'b57e1320a18579c797f7dfc19c459d7859f757bd'
CONTRACT_SHA = 'f40b32d8201eea731e022a9940ec0d33b682d50c219a2ca4c35df241738082b0'
V1_SELECTION_SHA = 'ca581e7197f6e94b9e112759ce2d8ba36ef356c8ce191ee0866a3a92aced64c0'
SUMMARY_SHA = '8862475a1c4d22867832b6a7399da91f2a1a14f1aad26994826e98a8975bc26d'
HCE_SELECTION_SHA = '022c0cd99d61293d8262fd98df06fd4401e462954a24895a855d790ea779db69'
HCE_WEIGHTS_SHA = 'dcd343d60a85dc59fd9641a1b53d877e8dea359096e85fa611aa1cbd724225ef'
WASM_SHA = '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f'
Q1, Q2, CP = 16384, 4096, 400
PHASES = ('opening', 'middlegame', 'endgame')
AUTHORED = [
 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1',
 '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2',
 '4k3/P7/8/8/8/8/7p/4K3 w - - 0 1',
 '4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1',
 '4k3/3q4/8/8/8/8/8/4K3 w - - 0 1',
 '4k3/8/8/8/8/8/4N3/4K3 w - - 0 1',
]
EVIDENCE = {}


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, wanted=None, size=None):
    path = Path(path).absolute()
    require(not path.is_symlink() and path.resolve() == path, 'nonsymlink canonical input required')
    before = path.stat()
    require(stat.S_ISREG(before.st_mode), 'regular file required')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        raw = stream.read()
        after = os.fstat(stream.fileno())
    fingerprint = lambda s: (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    require(fingerprint(before)==fingerprint(opened)==fingerprint(after)==fingerprint(path.stat()), 'input changed during audit')
    digest = sha(raw)
    require(wanted is None or digest == wanted, 'input digest differs: '+str(path))
    require(size is None or len(raw) == size, 'input byte count differs: '+str(path))
    EVIDENCE[str(path)] = {'sha256':digest,'bytes':len(raw)}
    return raw


def load(path, wanted=None, size=None):
    return json.loads(read(path,wanted,size))


def close(actual, expected, where, absolute=2e-10):
    if isinstance(expected,dict):
        require(isinstance(actual,dict) and actual.keys()==expected.keys(),where+': object fields differ')
        for key,value in expected.items(): close(actual[key],value,where+'.'+key,absolute)
    elif isinstance(expected,list):
        require(isinstance(actual,list) and len(actual)==len(expected),where+': list size differs')
        for i,(a,b) in enumerate(zip(actual,expected)): close(a,b,where+'.'+str(i),absolute)
    elif type(expected) is float:
        require(isinstance(actual,(float,int)) and math.isfinite(actual) and math.isclose(actual,expected,rel_tol=2e-10,abs_tol=absolute),
                f'{where}: {actual!r} != {expected!r}')
    else:
        require(actual==expected,where+': value differs')


def features(fens):
    white,black,turn = [],[],[]
    for fen in fens:
        board=chess.Board(fen)
        w,b=[],[]
        for square,piece in board.piece_map().items():
            channel=piece.piece_type-1+(0 if piece.color else 6)
            native=square ^ 56
            w.append(channel*64+native)
            b.append(((channel+6)%12)*64+(native^56))
        require(len(w)<=32 and len(set(w))==len(w),'invalid piece inventory')
        white.append(sorted(w)+[768]*(32-len(w)))
        black.append(sorted(b)+[768]*(32-len(b)))
        turn.append(1 if board.turn else -1)
    return np.asarray(white,dtype=np.int32),np.asarray(black,dtype=np.int32),np.asarray(turn,dtype=np.int64)


def expected_metadata(h,residual):
    return {'schema':'chessy-h4-v2-quantized-v1','researchOnly':True,'inputs':768,'hidden':h,
     'parameters':771*h+1,'parameterBytes':1544*h+4,'q1':Q1,'q2':Q2,'cpScale':CP,'maximumPieces':32,
     'layout':f'W1[768,{h}]:i16,b1[{h}]:i32,W2[{2*h}]:i16,b2[1]:i32;little-endian',
     'featureOrder':'PNBRQKpnbrqk; a8=0; black: color-swap,square^56',
     'outputOrder':f'side-to-move[{h}],other[{h}]','weightRounding':'nearest-ties-to-even',
     'scoreRounding':'floor((numerator*400+denominator/2)/denominator);white-sign-after-stm-round',
     'activation':'clamp(sum(W1)+b1,0,16384)',
     'mode':'residual-shipped-hce' if residual else 'net-only',
     'fixedBaseline':'shipped-hce' if residual else 'none','maximumAbsScoreCp':10000}


def decode(raw,h):
    require(h in (4,8) and len(raw)==1544*h+4,'binary size/width differs')
    cursor=0
    def consume(code,count):
        nonlocal cursor
        result=np.asarray(struct.unpack_from('<'+str(count)+code,raw,cursor),dtype=np.int64)
        cursor+=struct.calcsize('<'+str(count)+code)
        return result
    w=consume('h',768*h).reshape(768,h)
    b=consume('i',h)
    o=consume('h',2*h)
    ob=int(consume('i',1)[0])
    require(cursor==len(raw),'trailing model bytes')
    for value,bound in ((w,31130),(b,31130),(o,16384),(ob,134217728)):
        require(np.all(np.abs(value)<=bound),'quantized projection bound exceeded')
    maximum_accumulator=np.sort(np.abs(w),axis=0)[-32:].sum(axis=0)+np.abs(b)
    require(np.all(maximum_accumulator<=2147483647),'int32 accumulator theoretical overflow')
    max_dot=Q1*sum(abs(int(v)) for v in o)+abs(ob)
    require(max_dot*CP+Q1*Q2//2<=9223372036854775807,'int64 output theoretical overflow')
    return w,b,o,ob


def unpack_float(params,h):
    params=np.asarray(params,dtype=np.float64)
    require(params.shape==(771*h+1,) and np.all(np.isfinite(params)),'invalid float checkpoint')
    cut=768*h
    w,b,o,ob=params[:cut].reshape(768,h),params[cut:cut+h],params[cut+h:-1],float(params[-1])
    require(np.max(np.abs(w))<=1.9 and np.max(np.abs(b))<=1.9 and np.max(np.abs(o))<=4 and abs(ob)<=2,
            'float projection bound exceeded')
    return w,b,o,ob


def activations(parts,x,integer):
    w,b,o,ob=parts
    wi,bi,turn=x
    table=np.vstack((w,np.zeros((1,w.shape[1]),dtype=w.dtype)))
    pw=table[wi].sum(axis=1)+b
    pb=table[bi].sum(axis=1)+b
    upper=Q1 if integer else 1
    aw,ab=np.minimum(upper,np.maximum(0,pw)),np.minimum(upper,np.maximum(0,pb))
    first=np.where(turn[:,None]==1,aw,ab)
    second=np.where(turn[:,None]==1,ab,aw)
    return np.concatenate((first,second),axis=1),pw,pb


def inference(parts,x,base,integer,round_cp=True):
    ordered,_,_=activations(parts,x,integer)
    _,_,output,bias=parts
    numerator=ordered@output+bias
    if integer and round_cp:
        stm=(numerator*CP+(Q1*Q2)//2)//(Q1*Q2)
    else:
        stm=numerator*(CP/(Q1*Q2) if integer else CP)
    result=stm*x[2]
    return result if base is None else result+base


def row_losses(cp,target):
    logits=np.asarray(cp,dtype=float)/100
    return target*np.logaddexp(0,-logits)+(1-target)*np.logaddexp(0,logits)


def metrics(cp,data):
    error=np.asarray(cp)-data['teacher']
    losses=row_losses(cp,data['target'])
    def subset(mask):
        return {'rows':int(mask.sum()),'crossEntropy':float(losses[mask].mean()),
                'teacherCpMae':float(np.abs(error[mask]).mean()),
                'teacherCpRmse':float(np.sqrt(np.square(error[mask]).mean())),
                'p99AbsoluteCpError':float(np.quantile(np.abs(error[mask]),.99)),
                'signAccuracy':float(np.mean(np.sign(np.asarray(cp)[mask])==np.sign(data['teacher'][mask])))}
    result=subset(np.ones(len(cp),dtype=bool))
    result['byPhase']={phase:subset(data['phase']==phase) for phase in PHASES}
    return result


def quantization_check(integer,floating):
    delta=np.abs(integer-floating)
    result={'rows':len(integer),'integerMismatches':0,
            'maximumAbsFloatDifferenceCp':float(delta.max()),'meanAbsFloatDifferenceCp':float(delta.mean()),
            'maximumAbsoluteScoreCp':float(max(np.abs(integer).max(),np.abs(floating).max()))}
    reasons=[]
    if result['maximumAbsFloatDifferenceCp']>5 or result['meanAbsFloatDifferenceCp']>1:
        reasons.append('quantization-float-difference')
    if result['maximumAbsoluteScoreCp']>10000:reasons.append('score-range')
    return result|{'reasons':reasons}


def objective_audit(params,integer_parts,data,config,seed):
    """Independent scatter-sum QAT gradient, plus the explicitly summed penalty."""
    h=config['hidden']; n=len(data['target']); x=data['features']
    base=data['baseline'] if config['mode']=='residual-shipped-hce' else None
    effective=(integer_parts[0]/Q1,integer_parts[1]/Q1,integer_parts[2]/Q2,integer_parts[3]/(Q1*Q2))
    ordered,pw,pb=activations(effective,x,False)
    logits=inference(integer_parts,x,base,True,round_cp=False)/100
    probability=np.exp(-np.logaddexp(0,-logits))
    delta=(probability-data['target'])*4*x[2]/n
    output=effective[2]
    gw=delta[:,None]*np.where(x[2][:,None]==1,output[:h],output[h:])*((pw>0)&(pw<1))
    gb=delta[:,None]*np.where(x[2][:,None]==1,output[h:],output[:h])*((pb>0)&(pb<1))
    first_gradient=np.zeros((768,h))
    for unit in range(h):
        first_gradient[:,unit]=np.bincount(x[0].ravel(),weights=np.repeat(gw[:,unit],32),minlength=769)[:768]
        first_gradient[:,unit]+=np.bincount(x[1].ravel(),weights=np.repeat(gb[:,unit],32),minlength=769)[:768]
    data_gradient=np.concatenate((first_gradient.ravel(),(gw+gb).sum(axis=0),ordered.T@delta,[delta.sum()]))
    initial=np.concatenate((np.random.default_rng(seed).normal(0,.04,768*h),np.full(h,.25),np.zeros(2*h+1)))
    displacement=params-initial
    regularizer=.5*config['l2']*float(displacement@displacement)
    reg_gradient=config['l2']*displacement
    gradient=data_gradient+reg_gradient
    components={'dataCE':float(row_losses(inference(integer_parts,x,base,True,round_cp=False),data['target']).mean()),
       'regularizer':regularizer,'dataGradientL2':float(np.linalg.norm(data_gradient)),
       'regularizerGradientL2':float(np.linalg.norm(reg_gradient)),
       'gradientL2':float(np.linalg.norm(gradient)),'gradientMaxAbs':float(np.abs(gradient).max()),'fakeQuantization':True}
    pre=np.concatenate((pw,pb))
    activation={'rows':n,'perspectivesPooled':2,'zeroActivationFraction':(pre<=0).mean(axis=0).tolist(),
                'upperSaturationFraction':(pre>=1).mean(axis=0).tolist(),
                'interiorFraction':((pre>0)&(pre<1)).mean(axis=0).tolist()}
    return components,activation


def slice_data(data,mask):
    indexes=np.flatnonzero(mask)
    return {key:tuple(v[indexes] for v in value) if key=='features' else
                 [value[int(i)] for i in indexes] if key=='fens' else value[indexes]
            for key,value in data.items()}


def identity(data):
    return {k:sorted(set(data[k].tolist())) for k in ('row_id','cluster','family','source')}


def guards(base,candidate):
    reasons=[]
    if candidate['crossEntropy']>base['crossEntropy']*.995:reasons.append('CE-gain-below-0.5-percent')
    for field,limit in (('teacherCpMae',1.02),('teacherCpRmse',1.02),('p99AbsoluteCpError',1.05)):
        if candidate[field]>base[field]*limit:reasons.append(field+'-guard')
    for phase in PHASES:
        b,c=base['byPhase'][phase],candidate['byPhase'][phase]
        if min(b['rows'],c['rows'])<100:reasons.append(phase+'-coverage')
        elif c['crossEntropy']>b['crossEntropy']*1.01:reasons.append(phase+'-CE-guard')
    return reasons


def comparator_rows(fens,weights):
    # Explicit shared dependency: shipped WASM and independently frozen HCE
    # runtime helper. Neural mapping, decoding, inference and metrics are separate.
    javascript=r"""
const fs=require('fs');
const W=require('./test/wasm-test-engine');
const L=require('./test/training/hce-r3-linear');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
for(let i=0;i<input.fens.length;i++){
 const fen=input.fens[i];
 process.stdout.write(JSON.stringify({id:i,baseline:W.engine.evaluate(fen),expanded:L.runtimeRoundedScore(L.compile(fen),input.weights)})+'\n');
}
"""
    result=subprocess.run(['node','-e',javascript],cwd=REPO,
        input=json.dumps({'fens':fens,'weights':weights}),text=True,capture_output=True,check=True)
    rows=[json.loads(line) for line in result.stdout.splitlines()]
    require(len(rows)==len(fens) and all(row['id']==i for i,row in enumerate(rows)),'HCE comparator inventory differs')
    return np.asarray([r['baseline'] for r in rows],dtype=np.int64),np.asarray([r['expanded'] for r in rows],dtype=np.int64)


def check_javascript(artifacts,config,data,integer):
    rows=[]
    for i,fen in enumerate(data['fens']):
        row={'id':str(i),'fen':fen}
        if config['mode']=='residual-shipped-hce':row['baselineCp']=int(data['baseline'][i])
        rows.append(json.dumps(row))
    result=subprocess.run(['node',str(REPO/'test/training/h4-v2-reference.js'),
                           str(RUN/artifacts['binary']['path']),str(RUN/artifacts['metadata']['path'])],
                          input='\n'.join(rows)+'\n',text=True,capture_output=True,check=True)
    actual=[json.loads(line) for line in result.stdout.splitlines()]
    require(len(actual)==len(integer) and all(row['id']==str(i) for i,row in enumerate(actual)),'JS reference inventory differs')
    require(np.array_equal(integer,np.asarray([row['cpWhite'] for row in actual])),
            'independent decoded integer outputs differ from JS BigInt')


def model_artifacts(artifacts,config):
    def artifact(kind):
        item=artifacts[kind]
        require(Path(item['path']).name==item['path'],'artifact must be direct run child')
        return read(RUN/item['path'],item['sha256'],item['bytes'])
    params=np.asarray(json.loads(artifact('float')),dtype=np.float64)
    metadata=json.loads(artifact('metadata'))
    h=config['hidden']; residual=config['mode']=='residual-shipped-hce'
    require(metadata==expected_metadata(h,residual),'metadata contract differs')
    parts=decode(artifact('binary'),h)
    floating=unpack_float(params,h)
    for a,b in zip(parts,(np.rint(floating[0]*Q1),np.rint(floating[1]*Q1),np.rint(floating[2]*Q2),np.rint(floating[3]*Q1*Q2))):
        require(np.array_equal(a,b),'binary differs from specified float quantization')
    return params,parts,floating


def audit(output):
    require((RUN/'selection.json').is_file(),'completed selection.json is required before any role decoding')
    require(np.__version__=='2.3.5','frozen NumPy version required for initialization-anchor audit')
    contract=load(REPO/'eval/training/natural-nnue-h4-v2.json',CONTRACT_SHA)
    require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()==HEAD,'execution checkout HEAD changed')
    state_key=sha((CONTRACT_SHA+'\0'+SUMMARY_SHA+'\0nnue-test').encode())
    state=REPO/'.research-state'/state_key
    frozen=load(state/'selection-frozen.json')
    selection=load(RUN/'selection.json',frozen['sha256'])
    require(selection['head']==HEAD and selection['contractSha256']==CONTRACT_SHA,'result implementation identity differs')
    require(not (RUN/'failure.json').exists(),'execution failure receipt exists')
    old=load(WORK/'h4-run/selection.json',V1_SELECTION_SHA)
    inputs=selection['inputSha256']
    for relative in ('tools/training/h4_v2_model.py','tools/training/natural-nnue-h4-v2.py',
                     'test/training/h4-v2-reference.js','tools/training/h4_model.py','tools/training/h4_data.py',
                     'tools/training/natural-pilot-fit.py','test/training/hce-r3-baseline.js',
                     'test/training/hce-r3-linear.js','test/training/hce-r3-features.js','test/training/corpus.js',
                     'test/wasm-test-engine.js','assets/engine.js','assets/wasm-engine.js','assets/chessy-ai-fast.wasm'):
        path=REPO/relative
        read(path,inputs[str(path)])
    require(inputs[str(REPO/'assets/chessy-ai-fast.wasm')]==WASM_SHA,'shipped comparator differs')
    original_summary=old['auditEvidence']['relocations']
    summary_paths=[Path(p) for p,s in old['inputSha256'].items() if s==SUMMARY_SHA]
    require(len(summary_paths)==1,'original label summary locator ambiguous')
    label_summary=load(summary_paths[0],SUMMARY_SHA)
    hce_paths=[Path(p) for p,s in old['inputSha256'].items() if s==HCE_SELECTION_SHA]
    require(len(hce_paths)==1,'frozen expanded HCE locator ambiguous')
    weights=load(hce_paths[0],HCE_SELECTION_SHA)['researchWeights']
    require(sha(json.dumps(weights,separators=(',',':')).encode())==HCE_WEIGHTS_SHA,'expanded weights differ')
    datasets={}
    for role,count in (('shared-train',33103),('nnue-validation',2374)):
        entry=next(e for e in label_summary['output']['files'] if e['role']==role)
        require(Path(entry['path']).name==entry['path'],'role filename must be a direct child')
        path=summary_paths[0].parent/entry['path']
        require(inputs[str(path)]==old['inputSha256'][str(path)]==entry['sha256'],'consumed role digest differs from v1 pins')
        raw=read(path,entry['sha256'],entry['bytes'])
        rows=[json.loads(line) for line in raw.splitlines()]
        require(len(rows)==entry['rows']==count,'consumed role count differs')
        for row in rows:
            require(row['role']==role,'role stream contains foreign role')
            wdl=row['teacher']['wdl']
            require(sum(wdl)==1000 and row['teacher']['targetWhite']==(wdl[0]+.5*wdl[1])/1000,'teacher target/WDL differs')
        fens=[r['fen'] for r in rows]
        baseline,expanded=comparator_rows(fens,weights)
        datasets[role]={'fens':fens,'features':features(fens),'target':np.asarray([r['teacher']['targetWhite'] for r in rows]),
                       'teacher':np.asarray([r['teacher']['scoreCp'] for r in rows]),
                       'phase':np.asarray([r['phaseBucket'] for r in rows]),'family':np.asarray([r['positionFamily'] for r in rows]),
                       'source':np.asarray([r['sourceId'] for r in rows]),'row_id':np.asarray([r['id'] for r in rows]),
                       'cluster':np.asarray([r['cluster'] for r in rows]),'baseline':baseline,'expanded':expanded}
    full=datasets['shared-train']
    mask=np.asarray([int(hashlib.sha256(b'chessy-h4-v2-inner-20260915'+bytes([0])+str(f).encode()).hexdigest()[:16],16)%5==0 for f in full['family']])
    datasets['inner-train']=slice_data(full,~mask)
    datasets['inner-validation']=slice_data(full,mask)
    recorded_identities=load(RUN/'split-identities.json')
    for role in ('shared-train','inner-train','inner-validation'):
        close(identity(datasets[role]),recorded_identities[role],'identity '+role)
    for key in ('row_id','cluster','family','source'):
        require(not set(datasets['inner-train'][key])&set(datasets['inner-validation'][key]),'inner overlap '+key)
        require(not set(full[key])&set(datasets['nnue-validation'][key]),'outer overlap '+key)
    for role in datasets:
        for name,key in (('shipped-hce','baseline'),('frozen-expanded-hce','expanded')):
            close(metrics(datasets[role][key],datasets[role]),selection['comparators'][role][name],'comparator '+role+' '+name)
    authored_baseline,_=comparator_rows(AUTHORED,weights)
    datasets['authored']={'fens':AUTHORED,'features':features(AUTHORED),'baseline':authored_baseline}
    audited=[]
    integer_outputs=0
    for record in selection['runs']:
        config=record['config']; seed=record['seed']
        require(config in contract['configurations'] and seed in contract['training']['seeds'],'foreign run')
        require(record['epochsRun']==300 and record['convergenceClaimed'] is False,'fit budget/convergence claim differs')
        curve=record['curves']
        require([p['epoch'] for p in curve]==list(range(10,301,10)),'checkpoint epoch inventory differs')
        require(all(p['qat']==(p['epoch']>=201) for p in curve),'QAT epoch marking differs')
        best=min((p for p in curve if p['qat']),key=lambda p:(p['innerValidationQuantizedCe'],p['epoch']))
        close(record['selectedEpoch'],best['epoch'],'best checkpoint epoch')
        close(record['selectedInnerCe'],best['innerValidationQuantizedCe'],'best checkpoint loss')
        params,parts,float_parts=model_artifacts(record['artifacts'],config)
        prefix=config['id']+'-'+str(seed)
        close(load(RUN/(prefix+'.report.json')),record,'standalone run report '+prefix)
        for role in ('inner-train','inner-validation','authored'):
            data=datasets[role];base=data['baseline'] if config['mode']=='residual-shipped-hce' else None
            integer=inference(parts,data['features'],base,True)
            floating=inference(float_parts,data['features'],base,False)
            check_javascript(record['artifacts'],config,data,integer)
            integer_outputs+=len(integer)
            close(quantization_check(integer,floating),record['checks'][role],'quantization '+prefix+' '+role)
            if role!='authored':close(metrics(integer,data),record['quality'][role],'metrics '+prefix+' '+role)
        components,activation=objective_audit(params,parts,datasets['inner-train'],config,seed)
        close(components,best['objectiveComponents'],'QAT objective '+prefix)
        close(activation,best['activations'],'activation '+prefix)
        close(components['gradientL2'],best['gradientNorm'],'gradient norm '+prefix)
        close(components['gradientMaxAbs'],best['maximumAbsGradient'],'gradient max '+prefix)
        close(record['quality']['inner-validation']['crossEntropy'],record['selectedInnerCe'],'selected checkpoint CE '+prefix)
        audited.append({'config':config['id'],'seed':seed,'selectedEpoch':record['selectedEpoch'],
                        'innerValidationCe':record['selectedInnerCe'],'quantizationPass':all(not c['reasons'] for c in record['checks'].values()),
                        'regularizer':components['regularizer'],'gradientL2':components['gradientL2']})
        print(json.dumps({'audited':prefix,'integerOutputs':integer_outputs}),flush=True)
    candidates=[]
    for order,config in enumerate(contract['configurations']):
        records=[r for r in selection['runs'] if r['config']['id']==config['id']]
        require(sorted(r['seed'] for r in records)==contract['training']['seeds'],'missing or duplicated seeds')
        representative=sorted(records,key=lambda r:(r['selectedInnerCe'],r['seed']))[1]
        if config['eligibleForTest']:
            candidates.append((representative['selectedInnerCe'],order,config,representative,sorted(r['selectedEpoch'] for r in records)[1]))
    loss,_,config,representative,epoch=min(candidates,key=lambda c:(c[0],c[1]))
    wanted={'config':config,'seed':representative['seed'],'epochs':epoch,'medianInnerCe':loss,
            'innerRepresentativeEpoch':representative['selectedEpoch'],'head':HEAD,'contractSha256':CONTRACT_SHA,
            'selectionUsesOuter':False,'nnueValidationDecoded':False,'nnueTestDecoded':False}
    close(selection['decision'],wanted,'chosen recipe')
    close(load(RUN/'decision.json'),wanted,'decision file')
    close(load(state/'recipe-frozen.json'),wanted,'frozen recipe')
    final=selection['final'];params,parts,float_parts=model_artifacts(final['artifacts'],config)
    frozen_model=load(state/'model-frozen.json')
    close(frozen_model['artifacts'],final['artifacts'],'frozen final model')
    require(frozen_model['decisionSha256']==EVIDENCE[str(RUN/'decision.json')]['sha256'],'decision byte identity differs')
    require(final['fit']['selectedEpoch']==final['fit']['epochsRun']==epoch and final['fit']['seed']==representative['seed'],
            'refit recipe/seed/epoch differs')
    stop_reasons=[]
    for role in ('shared-train','authored','nnue-validation'):
        data=datasets[role];base=data['baseline'] if config['mode']=='residual-shipped-hce' else None
        integer=inference(parts,data['features'],base,True)
        floating=inference(float_parts,data['features'],base,False)
        check_javascript(final['artifacts'],config,data,integer)
        integer_outputs+=len(integer)
        check=quantization_check(integer,floating)
        close(check,final['checks'][role],'final quantization '+role)
        stop_reasons.extend(role+':'+r for r in check['reasons'])
        if role!='authored':
            close(metrics(integer,data),final['quality'][role],'final metrics '+role)
            close(metrics(floating,data),final['floatQuality'][role],'final float metrics '+role)
    components,activation=objective_audit(params,parts,full,config,representative['seed'])
    close(components,final['fit']['curves'][-1]['objectiveComponents'],'final objective')
    close(activation,final['fit']['curves'][-1]['activations'],'final activations')
    for name,base in selection['comparators']['nnue-validation'].items():
        stop_reasons.extend(name+':'+r for r in guards(base,final['quality']['nnue-validation']))
    if final['artifacts']['binary']['bytes']>6500:stop_reasons.append('parameter-size')
    close(stop_reasons,selection['stopReasons'],'final stop reasons')
    require(selection['testEligible']==(not stop_reasons),'test eligibility differs')
    require(frozen['testEligible']==selection['testEligible'],'state eligibility differs')
    require(frozen['binarySha256']==final['artifacts']['binary']['sha256'],'selected binary state differs')
    marker=(state/'test-opened.json').exists()
    # No test artifact contents, labels, or test hashes are read by this script.
    if not selection['testEligible']:
        require(not marker,'ineligible candidate opened test')
    result={'schema':'chessy.h4-v2-independent-audit.v1','status':'PASS','researchOnly':True,
      'executionHead':HEAD,'contractSha256':CONTRACT_SHA,'selectionSha256':frozen['sha256'],
      'auditedSelectedInnerCheckpoints':len(audited),'independentIntegerOutputs':integer_outputs,
      'independentIntegerVersusJsBigIntMismatches':0,
      'mismatches':0,'nnueTestFilesReadOrHashed':0,'nnueTestPerformanceAudited':False,
      'testExposureMarkerExists':marker,'innerRows':{'train':int((~mask).sum()),'validation':int(mask.sum())},
      'auditedRuns':audited,'decision':wanted,'finalObjective':components,'finalStopReasons':stop_reasons,
      'observedPaidSpendUsd':selection['paidSpendUsd'],'inputs':EVIDENCE,
      'dependencies':['Original externally pinned v1 source/teacher/role audits; no relabeling or source replay.',
                      'Frozen shipped WASM and expanded-HCE runtime helpers provide comparator/baseline scores; their bytes are authenticated.',
                      'NumPy default_rng reproduces the registered initialization anchor for the regularization audit.'],
      'independentWork':['python-chess square/color mapping, struct little-endian decoder, manual integer/float inference.',
                         'Alternative stable BCE, all scalar/phase metrics, quantization checks and guards.',
                         'Manual scatter-sum QAT analytic gradient, regularizer sum, activation fractions.',
                         'NUL-delimited family split, selected curves/seed/epoch decision, model/state digest bindings.'],
      'limitations':['Does not replay optimizer trajectories or independently regenerate all unretained checkpoints.',
                     'Curve-best selection is checked against preserved curves; selected checkpoints are numerically rescored.',
                     'Trusted isolated-runner state is not hostile same-account attestation.',
                     'No NNUE-test performance, device runtime, or playing-strength claim is made.']}
    output=Path(output)
    require(not output.exists(),'refusing to overwrite audit result')
    output.write_text(json.dumps(result,sort_keys=True,indent=2,allow_nan=False)+'\n')
    print(json.dumps({k:result[k] for k in ('status','auditedSelectedInnerCheckpoints','independentIntegerOutputs','mismatches','nnueTestFilesReadOrHashed')}))


def self_test():
    x=features([AUTHORED[0]])
    require(len(set(x[0][0]))==32,'start mapping must have 32 distinct features')
    require(np.array_equal(np.sort(x[0][0]),np.sort(x[1][0])),'symmetric start perspectives differ')
    x=features(['P7/8/8/8/8/8/8/8 w - - 0 1'])
    require(x[0][0,0]==0 and x[1][0,0]==440,'hardcoded a8 pawn mapping differs')
    for h in (4,8):
        raw=struct.pack('<'+str(768*h)+'h',*([0]*(768*h)))+struct.pack('<'+str(h)+'i',*([0]*h))
        raw+=struct.pack('<'+str(2*h)+'h',*([0]*(2*h)))+struct.pack('<i',-2097152)
        parts=decode(raw,h)
        require(inference(parts,x,None,True).tolist()==[-12],'negative half rounding differs')
        require(inference(parts,x,np.array([7]),True).tolist()==[-5],'residual cp addition differs')
    print('synthetic independent decoder/mapping/rounding checks passed; no dataset files opened')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-completed',action='store_true')
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--workspace-root',type=Path,help='Recovered evidence workspace; contains chessy-neural-v2, h4-run, h4-v2-run and recovered.')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.self_test:self_test()
    elif args.run_completed:
        if args.workspace_root is None:parser.error('--workspace-root is required for the completed audit')
        WORK=args.workspace_root.absolute()
        REPO,RUN=WORK/'chessy-neural-v2',WORK/'h4-v2-run'
        audit(args.output or WORK/'h4-v2-independent-audit.json')
    else:parser.error('explicit --run-completed required; never invoke before root confirms completion')
