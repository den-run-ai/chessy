'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Runtime=require('../../tools/training/hybrid-runtime'),Phase=require('../../tools/training/nnue-phase-runtime');
const Baseline=require('./hce-r3-baseline'),Ref=require('./h4-v3-reference'),Linear=require('./hce-r3-linear');
const ROOT=path.resolve(__dirname,'../..');
const source=Runtime.historicalInput('experiments/wasm/src/eval.rs').toString('utf8'),before=Phase.sha(fs.readFileSync(path.join(ROOT,'experiments/wasm/src/eval.rs')));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-hybrid-runtime-test-'));
function withoutLiveInputs(callback){
  const read=fs.readFileSync;
  fs.readFileSync=function(file,...args){
    const absolute=path.resolve(String(file));
    if(absolute.startsWith(path.join(ROOT,'experiments/wasm')+path.sep)||absolute===path.join(ROOT,'assets/chessy-ai-fast.wasm'))
      throw Error('historical reproduction attempted a live production read');
    return read.call(fs,file,...args);
  };
  try{return callback();}finally{fs.readFileSync=read;}
}
try {
  const fixture=Phase.synthetic(8),weights=Baseline.baselineCenter(Baseline.parseRustEvaluator(source));
  weights[753]=7;weights[754]=13;weights[757]=11;weights[758]=9;
  const put=(name,value)=>{const p=path.join(tmp,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(p,bytes);return {path:p,sha256:Phase.sha(bytes)};};
  const model=put('model.bin',fixture.bytes),metadata=put('metadata.json',fixture.metadata),expandedSelection=put('expanded.json',{researchWeights:weights});
  const manifest={schema:'chessy.hybrid-runtime-input.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    config:Runtime.CONFIGS[4],model,metadata,expandedSelection,expandedWeightsSha256:Phase.sha(JSON.stringify(weights))};
  const manifestFile=put('inputs.json',manifest).path;
  const target=path.join(tmp,'build'),receipt=withoutLiveInputs(()=>Runtime.prepare(target,manifestFile));
  assert.equal(receipt.schema,'chessy.hybrid-runtime-build.v2');
  assert.equal(receipt.baselineCommit,'577d4abcaee6c86099120963023ad6bcef1a3401');
  const historical=require('../../eval/training/hybrid-runtime-results-2026-09.json');
  assert.equal(receipt.baselineWasmSha256,historical.modules.shipped.sha256);
  assert.equal(Phase.sha(withoutLiveInputs(()=>Runtime.baselineWasm())),historical.modules.shipped.sha256);
  assert.equal(receipt.sourceInputs.find(x=>x.path==='src/search.rs').sha256,'e13b53fdb744f8fb647ae9c74ebc5ea2289c6881ba676122336b3f93ec8671cd');
  assert.equal(receipt.sourceInputs.find(x=>x.path==='src/lib.rs').sha256,'f65850e8bf8064f90baad14c033a20db3fc94b326db608ce9959c397a81094bc');
  assert.equal(receipt.config.id,'smooth-4-10');assert.equal(receipt.modelSha256,model.sha256);
  assert.equal(receipt.emitted.length,3);assert.equal(receipt.productionIntegrationAllowed,false);
  assert.equal(withoutLiveInputs(()=>Runtime.verifyPrepared(target)).receiptSha256,Phase.sha(fs.readFileSync(path.join(target,'hybrid-source.json'))));
  assert.throws(()=>Runtime.prepare(target,manifestFile),/EEXIST/);
  assert.throws(()=>Runtime.prepare(path.join(ROOT,'unsafe-hybrid'),manifestFile),/outside a Git checkout/);
  const edited=path.join(target,'hybrid/src/eval.rs'),original=fs.readFileSync(edited);fs.appendFileSync(edited,'\n');
  assert.throws(()=>Runtime.verifyPrepared(target),/does not reproduce/);fs.writeFileSync(edited,original);
  const bytes=fs.readFileSync(model.path);fs.writeFileSync(model.path,Buffer.from('tampered'));
  assert.throws(()=>Runtime.verifyPrepared(target),/authenticated input changed/);fs.writeFileSync(model.path,bytes);
  const rp=path.join(target,'hybrid-source.json');fs.writeFileSync(rp,JSON.stringify({...receipt,emitted:receipt.emitted.slice(1)}));
  assert.throws(()=>Runtime.verifyPrepared(target),/variant inventory/);fs.writeFileSync(rp,JSON.stringify(receipt));
  fs.writeFileSync(rp,JSON.stringify({...receipt,plan:{...receipt.plan,timeBudgetsMs:[80]}}));
  assert.throws(()=>Runtime.verifyPrepared(target),/frozen cost plan/);fs.writeFileSync(rp,JSON.stringify(receipt));
  for(const change of [{baselineCommit:'0'.repeat(40)},{baselineWasmSha256:'0'.repeat(64)}]){
    fs.writeFileSync(rp,JSON.stringify({...receipt,...change}));
    assert.throws(()=>Runtime.verifyPrepared(target),/historical baseline identity/);
  }
  fs.writeFileSync(rp,JSON.stringify(receipt));
  // The reader lives in hybrid-runtime.js, already in the preparation's
  // authenticated closure; a reader edit invalidates follow-ups through it.
  const implementation=path.join(ROOT,'tools/training/hybrid-runtime.js'),read=fs.readFileSync;
  assert(receipt.dependencies.some(x=>x.path==='tools/training/hybrid-runtime.js'));
  fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);
    return path.resolve(String(file))===implementation?Buffer.concat([Buffer.from(bytes),Buffer.from('\n// changed reader\n')]):bytes;};
  try{assert.throws(()=>Runtime.verifyPrepared(target),/dependency identity changed/);}finally{fs.readFileSync=read;}
  // Corrupt each immutable input independently; no fallback to current bytes.
  const cp=require('node:child_process'),execute=cp.execFileSync;
  for(const filename of [...receipt.sourceInputs.map(x=>'experiments/wasm/'+x.path),'assets/chessy-ai-fast.wasm']){
    cp.execFileSync=function(command,args,options){const bytes=execute.call(cp,command,args,options);
      return args.includes(Runtime.HISTORICAL_COMMIT+':'+filename)?Buffer.concat([bytes,Buffer.from([0])]):bytes;};
    try{assert.throws(()=>Runtime.historicalInput(filename),/historical hybrid input hash differs/);}finally{cp.execFileSync=execute;}
  }
  assert.throws(()=>Runtime.inputs({...manifest,expandedWeightsSha256:'0'.repeat(64)}),/weights digest/);
  assert.throws(()=>Runtime.validateConfig({...Runtime.CONFIGS[4],hi:11}),/unregistered/);
  assert.throws(()=>Runtime.validateConfig({...Runtime.CONFIGS[4],extra:true}),/unregistered/);
  for(const config of Runtime.CONFIGS)for(let p=0;p<=24;p++)for(const [e,n]of [[-3,-2],[-4,3],[3,-4],[0,-1],[-1,0],[700,-120]]) {
    const expected=config.kind==='hard'?(p<=config.threshold?e:n):Math.floor((Math.max(0,Math.min(config.hi-config.lo,p-config.lo))*n+
      (config.hi-config.lo-Math.max(0,Math.min(config.hi-config.lo,p-config.lo)))*e)/(config.hi-config.lo)+0.5);
    assert.equal(Runtime.mix(config,p,e,n),expected);
    if(config.kind==='smooth'&&p<=config.lo)assert.equal(Runtime.mix(config,p,e,n),e);
    if(config.kind==='smooth'&&p>=config.hi)assert.equal(Runtime.mix(config,p,e,n),n);
  }
  const counts={opening:0,middlegame:0,endgame:0};
  for(const {fen,stage}of Runtime.FIXTURES){const phase=Ref.parseFen(fen).phaseUnits;counts[stage]++;
    assert.equal(stage,phase>18?'opening':phase>8?'middlegame':'endgame');Linear.compile(fen);}
  assert.deepEqual(counts,{opening:4,middlegame:4,endgame:4});
  const cases=Runtime.parityFens();assert.equal(cases.length,501);for(const fen of cases)Linear.compile(fen);
  for(const variant of ['expanded','neural','hybrid']){const rust=fs.readFileSync(path.join(target,variant,'src/eval.rs'),'utf8');
    assert.equal((rust.match(/^pub fn evaluate\(/gm)||[]).length,2); // one nested expanded function, one public wrapper
    assert(rust.includes('score + nnue_finish(nnue_acc, position.turn, phase)'));
    assert(rust.includes('hybrid_expanded::evaluate(position)'));assert(!rust.includes('{{'));
    assert(rust.includes('evaluate_hce(position) + nnue_refresh(position)'));}
  assert.equal(Phase.sha(fs.readFileSync(path.join(ROOT,'experiments/wasm/src/eval.rs'))),before);
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
console.log('PASS: hybrid private-source identity, immutable plans, full-baseline semantics, endpoints, rounding and balanced legal fixtures');
