'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Runtime=require('../../tools/training/hybrid-runtime'),Phase=require('../../tools/training/nnue-phase-runtime');
const Baseline=require('./hce-r3-baseline'),Ref=require('./h4-v3-reference'),Linear=require('./hce-r3-linear');
const ROOT=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(ROOT,'experiments/wasm/src/eval.rs'),'utf8'),before=Phase.sha(source);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-hybrid-runtime-test-'));
try {
  const fixture=Phase.synthetic(8),weights=Baseline.baselineCenter(Baseline.parseRustEvaluator(source));
  weights[753]=7;weights[754]=13;weights[757]=11;weights[758]=9;
  const put=(name,value)=>{const p=path.join(tmp,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(p,bytes);return {path:p,sha256:Phase.sha(bytes)};};
  const model=put('model.bin',fixture.bytes),metadata=put('metadata.json',fixture.metadata),expandedSelection=put('expanded.json',{researchWeights:weights});
  const manifest={schema:'chessy.hybrid-runtime-input.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    config:Runtime.CONFIGS[4],model,metadata,expandedSelection,expandedWeightsSha256:Phase.sha(JSON.stringify(weights))};
  const manifestFile=put('inputs.json',manifest).path;
  const target=path.join(tmp,'build'),receipt=Runtime.prepare(target,manifestFile);
  assert.equal(receipt.config.id,'smooth-4-10');assert.equal(receipt.modelSha256,model.sha256);
  assert.equal(receipt.emitted.length,3);assert.equal(receipt.productionIntegrationAllowed,false);
  assert.equal(Runtime.verifyPrepared(target).receiptSha256,Phase.sha(fs.readFileSync(path.join(target,'hybrid-source.json'))));
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
