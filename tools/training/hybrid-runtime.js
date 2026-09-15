#!/usr/bin/env node
'use strict';

// Separate private research experiment. Parameters are external authenticated
// inputs; only generated scratch copies contain fitted numbers. No holdout data
// is read and no output can qualify a model for production or assert strength.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {performance}=require('node:perf_hooks');
const Phase=require('./nnue-phase-runtime');
const Exporter=require('./natural-runtime-export');
const Ref=require('../../test/training/h4-v3-reference');
const Linear=require('../../test/training/hce-r3-linear');
const Wasm=require('../../assets/wasm-engine');
require('../../assets/engine');
const Chess=globalThis.Chess;
const ROOT=path.resolve(__dirname,'../..');
const TEMPLATE=path.join(__dirname,'hybrid-runtime.rs.in');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const DEPENDENCIES=[__filename,TEMPLATE,path.join(__dirname,'nnue-phase-runtime.js'),path.join(__dirname,'nnue-phase-runtime.rs.in'),
  path.join(__dirname,'natural-runtime-export.js'),...['h4-v3-reference.js','hce-r3-linear.js','hce-r3-baseline.js','hce-r3-features.js','corpus.js'].map(x=>path.join(ROOT,'test/training',x)),
  path.join(ROOT,'assets/wasm-engine.js'),path.join(ROOT,'assets/engine.js')];
const sha=Phase.sha,encode=x=>JSON.stringify(x,null,2)+'\n';
const check=(ok,message)=>{if(!ok)throw Error(message);};
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous source anchor: '+a);return s.replace(a,b);};
const CONFIGS=Object.freeze([
  {id:'hard-4',kind:'hard',threshold:4},{id:'hard-6',kind:'hard',threshold:6},{id:'hard-8',kind:'hard',threshold:8},
  {id:'smooth-2-8',kind:'smooth',lo:2,hi:8},{id:'smooth-4-10',kind:'smooth',lo:4,hi:10},{id:'smooth-6-12',kind:'smooth',lo:6,hi:12},
]);
// Four authored positions per material-phase stratum. These are exposed cost
// diagnostics, never formal strength openings or samples from the sealed test.
const FIXTURES=Object.freeze([
  ['opening','initial','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['opening','kiwipete','r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['opening','open-game','r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'],
  ['opening','closed-game','rnbqkbnr/pp2pppp/2p5/3p4/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 3'],
  ['middlegame','rooks-knights','r3k2r/ppp2ppp/2n5/3p4/3P4/2N5/PPP2PPP/R3K2R w KQkq - 0 1'],
  ['middlegame','queen-rook-bishop','r2q2k1/pp3ppp/2b5/3p4/3P4/2B5/PP3PPP/R2Q2K1 w - - 0 1'],
  ['middlegame','queen-rook-knight','4r1k1/ppq2ppp/2n5/3p4/3P4/2N5/PPQ2PPP/4R1K1 w - - 0 1'],
  ['middlegame','double-rook-bishop','r3r1k1/pp3ppp/2b5/3p4/3P4/2B5/PP3PPP/R3R1K1 w - - 0 1'],
  ['endgame','lucena','1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['endgame','minor-pieces','8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['endgame','promotion-race','8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['endgame','pawn-ending','8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
].map(([stage,label,fen])=>({stage,label,fen})));
const SPECIAL_FENS=Object.freeze([
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1',
  '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1','4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1',
  '4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1','4k3/8/8/8/3Pp3/8/8/4R1K1 b - d3 0 1',
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  'rnbqk2r/ppp1nNpp/8/2b5/8/2P5/PP1pBPPP/RNBQ1K1R b kq - 1 8',
  '8/1P3k2/8/8/8/8/1p3K2/8 b - - 0 1',
]);
const PLAN=Object.freeze({pairedRepetitions:4,evaluationWarmupCalls:1000,evaluationMeasuredCalls:10000,
  nodeBudgets:[4096,16384],timeBudgetsMs:[40],maxDepth:111,quiescence:true,
  fixtures:12,stageCounts:{opening:4,middlegame:4,endgame:4},
  order:'rotate [shipped,expanded,neural,hybrid] by (position+repetition)%4',
  selectionByTimingAllowed:false,formalStrengthAllowed:false});

function validateConfig(config) {
  const wanted=CONFIGS.find(x=>x.id===config?.id);
  check(wanted&&Object.keys(config).length===Object.keys(wanted).length&&Object.entries(wanted).every(([k,v])=>config[k]===v),'unregistered hybrid configuration');
  return wanted;
}
function mix(config,phase,expanded,neural) {
  validateConfig(config);
  check(Number.isInteger(phase)&&phase>=0&&phase<=24&&Number.isSafeInteger(expanded)&&Number.isSafeInteger(neural),'invalid integer mixture');
  if(config.kind==='hard')return phase<=config.threshold?expanded:neural;
  const den=BigInt(config.hi-config.lo),w=BigInt(Math.max(0,Math.min(Number(den),phase-config.lo)));
  return Number(Ref.floorDivide(w*BigInt(neural)+(den-w)*BigInt(expanded)+den/2n,den));
}
function parityFens() {
  const values=new Set();
  for(const fen of [...FIXTURES.map(x=>x.fen),...SPECIAL_FENS]) {
    values.add(fen);
    const state=Chess.parseFen(fen);
    for(const mv of Chess.legalMoves(state))values.add(Chess.toFen(Chess.applyMove(state,mv)));
  }
  return [...values];
}
function authFile(filename,hash) {
  check(typeof filename==='string'&&/^[a-f0-9]{64}$/.test(hash||''),'input path and external digest required');
  const bytes=fs.readFileSync(filename);check(sha(bytes)===hash,'authenticated input changed: '+path.basename(filename));return bytes;
}
function inputs(manifest) {
  check(manifest.schema==='chessy.hybrid-runtime-input.v1'&&manifest.researchOnly===true&&manifest.productionIntegrationAllowed===false&&manifest.strengthClaimAllowed===false,'research-only input manifest required');
  const config=validateConfig(manifest.config);
  const bin=authFile(manifest.model.path,manifest.model.sha256),metadata=authFile(manifest.metadata.path,manifest.metadata.sha256);
  const selection=JSON.parse(authFile(manifest.expandedSelection.path,manifest.expandedSelection.sha256));
  const weights=selection.researchWeights;
  check(Array.isArray(weights)&&sha(JSON.stringify(weights))===manifest.expandedWeightsSha256,'frozen expanded HCE weights digest differs');
  const model=Ref.loadModel(bin,JSON.parse(metadata));check(model.hidden===8,'this frozen runtime experiment accepts H8 only');
  return {config,bin,metadata,weights,model};
}
function render(source,data,variant) {
  check(['expanded','neural','hybrid'].includes(variant),'unknown runtime variant');
  let neural=Phase.render(source,fs.readFileSync(path.join(__dirname,'nnue-phase-runtime.rs.in'),'utf8'),data.model,'fused');
  neural=neural.replace(/\bevaluate\(/g,'evaluate_neural(');
  const expanded=Exporter.exportRust(source,data.weights).split('\n#[cfg(test)]\nmod tests {')[0];
  const {config}=data,lo=config.kind==='hard'?config.threshold:config.lo,hi=config.kind==='hard'?config.threshold+1:config.hi;
  const parameters={LOW:lo,HIGH:hi,HARD:String(config.kind==='hard'),
    ENTRY:variant==='expanded'?'hybrid_expanded::evaluate(position)':variant==='neural'?'evaluate_neural(position)':'evaluate_hybrid(position)',
    FIXTURES:[...FIXTURES.map(x=>x.fen),...SPECIAL_FENS].map(f=>`            b"${f}",`).join('\n')};
  const template=fs.readFileSync(TEMPLATE,'utf8').replace(/\{\{([A-Z]+)\}\}/g,(_,k)=>{check(Object.hasOwn(parameters,k),'unknown runtime template key');return parameters[k];});
  check(!template.includes('{{'),'unexpanded runtime template');
  return neural+'\nmod hybrid_expanded {\n'+expanded+'\n}\n'+template;
}
function capturedSources(){return Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,'experiments/wasm',p))]));}
function renderAll(captured,data,variant) {
  return {...captured,'src/eval.rs':Buffer.from(render(captured['src/eval.rs'].toString(),data,variant)),
    'build.sh':Buffer.from(Phase.researchBuild(captured['build.sh'].toString()))};
}
function prepare(destination,manifestPath) {
  destination=Phase.outsideRepository(destination);
  const manifestBytes=fs.readFileSync(manifestPath),manifest=JSON.parse(manifestBytes),data=inputs(manifest);
  const captured=capturedSources(),dependency=DEPENDENCIES.map(p=>({path:path.relative(ROOT,p),sha256:sha(fs.readFileSync(p))}));
  const variants=['expanded','neural','hybrid'].map(variant=>({variant,output:renderAll(captured,data,variant)}));
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination,'inputs.json'),manifestBytes,{flag:'wx'});
  for(const {variant,output}of variants){fs.mkdirSync(path.join(destination,variant));fs.mkdirSync(path.join(destination,variant,'src'));
    for(const p of FILES)fs.writeFileSync(path.join(destination,variant,p),output[p],{flag:'wx'});}
  const receipt={schema:'chessy.hybrid-runtime-build.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    inputManifestSha256:sha(manifestBytes),config:data.config,plan:PLAN,fixtureSha256:sha(JSON.stringify(FIXTURES)),
    baselineWasmSha256:sha(fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm'))),dependencies:dependency,
    sourceInputs:FILES.map(p=>({path:p,sha256:sha(captured[p])})),
    emitted:variants.map(({variant,output})=>({variant,files:FILES.map(p=>({path:p,sha256:sha(output[p]),bytes:output[p].length}))})),
    modelSha256:manifest.model.sha256,expandedWeightsSha256:manifest.expandedWeightsSha256,
    memoryPolicy:{shipped:26542080,research:26607616,productionCapChanged:false},
    implementation:'Material-phase prescan; fused H8 accumulation in shipped HCE board pass; expanded-only fallback; both complete rounded HCEs in smooth transition. No incremental accumulator.'};
  for(const d of dependency)check(sha(fs.readFileSync(path.join(ROOT,d.path)))===d.sha256,'dependency changed during preparation');
  fs.writeFileSync(path.join(destination,'hybrid-source.json'),encode(receipt),{flag:'wx'});return receipt;
}
function verifyPrepared(directory) {
  const rb=fs.readFileSync(path.join(directory,'hybrid-source.json')),receipt=JSON.parse(rb);
  check(receipt.schema==='chessy.hybrid-runtime-build.v1'&&receipt.productionIntegrationAllowed===false&&receipt.strengthClaimAllowed===false,'invalid source receipt');
  check(JSON.stringify(receipt.plan)===JSON.stringify(PLAN)&&receipt.fixtureSha256===sha(JSON.stringify(FIXTURES)),'frozen cost plan changed');
  check(Array.isArray(receipt.dependencies)&&receipt.dependencies.length===DEPENDENCIES.length,'incomplete dependency closure');
  receipt.dependencies.forEach((d,i)=>check(d.path===path.relative(ROOT,DEPENDENCIES[i])&&d.sha256===sha(fs.readFileSync(DEPENDENCIES[i])),'dependency identity changed'));
  const mb=fs.readFileSync(path.join(directory,'inputs.json'));check(sha(mb)===receipt.inputManifestSha256,'input manifest changed');
  const data=inputs(JSON.parse(mb)),captured=capturedSources();
  check(JSON.stringify(receipt.config)===JSON.stringify(data.config),'configuration changed');
  check(JSON.stringify(receipt.sourceInputs.map(x=>x.path))===JSON.stringify(FILES),'source inventory differs');
  receipt.sourceInputs.forEach(x=>check(sha(captured[x.path])===x.sha256,'baseline source changed'));
  check(JSON.stringify(receipt.emitted.map(x=>x.variant))===JSON.stringify(['expanded','neural','hybrid']),'variant inventory changed');
  for(const {variant,files}of receipt.emitted){check(JSON.stringify(files.map(x=>x.path))===JSON.stringify(FILES),'emitted inventory differs');
    const output=renderAll(captured,data,variant);for(const f of files){const bytes=fs.readFileSync(path.join(directory,variant,f.path));
      check(bytes.equals(output[f.path])&&sha(bytes)===f.sha256&&bytes.length===f.bytes,'generated source does not reproduce');}}
  return {receipt,receiptSha256:sha(rb),data};
}
function loadModule(bytes){return {bytes,engine:Wasm.loadSync(bytes),api:new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{now_ms:()=>performance.now()}}).exports};}
function directEvaluate(api,fen){const bytes=Buffer.from(fen);new Uint8Array(api.memory.buffer,api.input_ptr(),bytes.length).set(bytes);
  check(api.load_position(bytes.length)===0,'FEN rejected');for(let i=0;i<PLAN.evaluationWarmupCalls;i++)api.evaluate_loaded();
  const start=performance.now();let checksum=0;for(let i=0;i<PLAN.evaluationMeasuredCalls;i++)checksum+=api.evaluate_loaded();
  return {elapsedMs:performance.now()-start,repetitions:PLAN.evaluationMeasuredCalls,checksum};}
function summarize(records) {
  const result={};
  for(const stage of ['all','opening','middlegame','endgame']){result[stage]={};
    for(const variant of ['expanded','neural','hybrid']){result[stage][variant]={};
      for(const comparator of ['shipped','expanded']){if(variant===comparator)continue;const group={};
        for(const [kind,budget]of [['evaluation',null],...PLAN.nodeBudgets.map(x=>['nodes',x]),...PLAN.timeBudgetsMs.map(x=>['time',x])]){
          const times=[],nps=[],depth=[];let complete=0;for(const row of records.filter(r=>r.variant===variant&&r.kind===kind&&r.budget===budget&&(stage==='all'||r.stage===stage))){
            const other=records.find(r=>r.variant===comparator&&r.kind===kind&&r.budget===budget&&r.position===row.position&&r.repetition===row.repetition);
            check(other&&row.elapsedMs>0&&other.elapsedMs>0,'incomplete timing pair');times.push(row.elapsedMs/other.elapsedMs);
            if(kind!=='evaluation'){check(row.result.nodes>0&&other.result.nodes>0,'invalid node counts');nps.push((row.result.nodes/row.elapsedMs)/(other.result.nodes/other.elapsedMs));depth.push(row.result.depth-other.result.depth);
              if(kind==='nodes')complete+=Number(row.result.nodes===budget&&other.result.nodes===budget);}}
          group[kind+(budget??'')]={pairs:times.length,pairedMedianTimeRatio:Phase.median(times)};
          if(nps.length)Object.assign(group[kind+budget],{pairedMedianNpsRatio:Phase.median(nps),medianCompletedDepthDifference:Phase.median(depth),bothConsumedNodeBudget:kind==='nodes'?complete:null});}
        result[stage][variant][comparator]=group;}}}
  return result;
}
function measure(directory,output) {
  check(!fs.existsSync(output),'measurement output already exists');const verified=verifyPrepared(directory),{receipt,data}=verified;
  const shippedBytes=fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm'));check(sha(shippedBytes)===receipt.baselineWasmSha256,'shipped module changed');
  const modules={shipped:loadModule(shippedBytes)};
  for(const variant of ['expanded','neural','hybrid'])modules[variant]=loadModule(fs.readFileSync(path.join(directory,variant,'dist/chessy-ai-fast.wasm')));
  for(const [id,m]of Object.entries(modules))check(m.engine.memoryBytes()===(id==='shipped'?26542080:26607616),'unexpected module memory');
  const parity=[];
  for(const fen of parityFens()){
    const shipped=modules.shipped.engine.evaluate(fen),expanded=Linear.runtimeRoundedScore(Linear.compile(fen),data.weights),neural=Ref.infer(data.model,fen,shipped);
    const p=Ref.parseFen(fen).phaseUnits,hybrid=mix(data.config,p,expanded,neural),expected={expanded,neural,hybrid};
    for(const variant of ['expanded','neural','hybrid'])check(modules[variant].engine.evaluate(fen)===expected[variant],variant+' independent full-evaluation parity failed: '+fen);
    parity.push({fen,phase:p,shipped,...expected});
  }
  // Freeze evidence before first timing; interrupted runs retain the completed
  // correctness audit. No score-dependent configuration replacement is allowed.
  fs.writeFileSync(output+'.preflight.json',encode({sourceReceiptSha256:verified.receiptSha256,parity,config:data.config}),{flag:'wx'});
  const records=[],names=['shipped','expanded','neural','hybrid'];
  for(let repetition=0;repetition<PLAN.pairedRepetitions;repetition++)for(let position=0;position<FIXTURES.length;position++){
    const {fen,stage}=FIXTURES[position],offset=(repetition+position)%4,order=names.slice(offset).concat(names.slice(0,offset));
    for(const variant of order){const module=modules[variant];records.push({variant,stage,position,repetition,kind:'evaluation',budget:null,...directEvaluate(module.api,fen)});
      for(const [kind,budget]of [...PLAN.nodeBudgets.map(x=>['nodes',x]),...PLAN.timeBudgetsMs.map(x=>['time',x])]){
        const start=performance.now(),result=module.engine.search(fen,{maxDepth:PLAN.maxDepth,nodeLimit:kind==='nodes'?budget:0,timeMs:kind==='time'?budget:0,quiesce:true});
        records.push({variant,stage,position,repetition,kind,budget,elapsedMs:performance.now()-start,result});}}
  }
  check(records.length===768,'incomplete measurement grid');
  const info=Object.fromEntries(Object.entries(modules).map(([name,m])=>[name,{sha256:sha(m.bytes),rawBytes:m.bytes.length,
    brotliBytes:zlib.brotliCompressSync(m.bytes,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length,memoryBytes:m.engine.memoryBytes()}]));
  const result={schema:'chessy.hybrid-runtime-cost.v1',status:'completed',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    sourceReceiptSha256:verified.receiptSha256,config:data.config,modelSha256:receipt.modelSha256,expandedWeightsSha256:receipt.expandedWeightsSha256,
    plan:PLAN,runtime:{node:process.versions.node,v8:process.versions.v8,brotli:process.versions.brotli},modules:info,parity,parityMismatches:0,
    summary:summarize(records),records,limitations:[
      'Exposed authored fixture costs, not formal strength games; no Elo/time acceptance.',
      'All three research modules allow one extra memory page; production memory cap unchanged.',
      'One host V8 run cannot satisfy physical-device admission or establish hardware-independent cost.',
      'Material-phase prepass adds work; H8 accumulation is fused into shipped HCE pass, not incrementally updated.',
      'Smooth transition computes both rounded HCE evaluators; endpoint branches skip the unused evaluator.',
      'Timed searches may visit different trees; actual node counts and completed depths are reported.',
      'Reported WASM sizes are full modules containing each fitted evaluator and shared search; fitted weights stay private.',
    ]};
  fs.writeFileSync(output,encode(result),{flag:'wx'});return {status:result.status,config:result.config,parityRows:parity.length,modules:info,summary:result.summary};
}
module.exports={CONFIGS,FIXTURES,SPECIAL_FENS,PLAN,mix,validateConfig,parityFens,inputs,render,prepare,verifyPrepared,summarize,measure};
if(require.main===module){const [command,...args]=process.argv.slice(2);try{
  if(command==='prepare'&&args.length===2)console.log(encode(prepare(...args)));
  else if(command==='measure'&&args.length===2)console.log(encode(measure(...args)));
  else throw Error('usage: hybrid-runtime.js prepare SCRATCH_DIRECTORY INPUT_MANIFEST.json; measure SCRATCH_DIRECTORY OUTPUT.json');
}catch(error){console.error(error.stack);process.exitCode=1;}}
