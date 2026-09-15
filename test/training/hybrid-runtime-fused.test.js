'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Phase=require('../../tools/training/nnue-phase-runtime'),Runtime=require('../../tools/training/hybrid-runtime');
const Mechanism=require('../../tools/training/hybrid-runtime-fused'),Baseline=require('./hce-r3-baseline');
const ROOT=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-hybrid-fused-test-'));
try {
  const engine=fs.readFileSync(path.join(ROOT,'experiments/wasm/src/engine.rs'),'utf8');
  const patched=Mechanism.patchEngine(engine);
  assert(patched.includes('pub hybrid_material_phase: i16,'));assert(patched.includes('hybrid_material_phase: 0,'));
  assert.equal((patched.match(/hybrid_replace_square\(/g)||[]).length,17);
  assert.equal((patched.match(/position\.board\[.*?\] = /g)||[]).length,1);
  assert(!patched.includes('.clamp('));assert(!patched.includes('nnue_acc'));
  assert.throws(()=>Mechanism.patchEngine(engine.replace('position.board[square] = piece;','position.board[square] = piece;\nposition.board[square] = piece;')),/16-write/);
  assert.throws(()=>Mechanism.patchEngine(engine.replace('    pub board: [Piece; BOARD_SQUARES],','')),/anchor/);
  const fixture=Phase.synthetic(8),source=fs.readFileSync(path.join(ROOT,'experiments/wasm/src/eval.rs'),'utf8');
  const weights=Baseline.baselineCenter(Baseline.parseRustEvaluator(source));weights[753]=7;weights[754]=13;
  const put=(name,value)=>{const filename=path.join(tmp,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(filename,bytes);return {path:filename,sha256:Phase.sha(bytes)};};
  const manifest={schema:'chessy.hybrid-runtime-input.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    config:Runtime.CONFIGS[5],model:put('model.bin',fixture.bytes),metadata:put('metadata.json',fixture.metadata),
    expandedSelection:put('selection.json',{researchWeights:weights}),expandedWeightsSha256:Phase.sha(JSON.stringify(weights))};
  const input=put('input.json',manifest),prior=path.join(tmp,'prior'),target=path.join(tmp,'mechanisms');Runtime.prepare(prior,input.path);
  const before=Phase.sha(fs.readFileSync(path.join(prior,'hybrid/src/eval.rs')));
  const receipt=Mechanism.prepare(target,prior);assert.equal(receipt.modelSelectionAllowed,false);
  assert.deepEqual(receipt.emitted.map(x=>x.variant),['original','cached','fused']);Mechanism.verifyPrepared(target);
  assert(fs.readFileSync(path.join(target,'original/src/eval.rs')).equals(fs.readFileSync(path.join(prior,'hybrid/src/eval.rs'))));
  const cached=fs.readFileSync(path.join(target,'cached/src/eval.rs'),'utf8');assert(cached.includes('position.hybrid_material_phase as i32'));
  const fused=fs.readFileSync(path.join(target,'fused/src/eval.rs'),'utf8');assert(fused.includes('let blend = phase > 6 && phase < 12;'));
  assert(fused.includes('scalar_reference::evaluate(position)'));assert(fused.includes('assert_eq!(all_queens.hybrid_material_phase, 256)'));
  assert(fused.includes('hybrid_round((phase - 6) * neural + (12 - phase) * expanded, 6) + mop'));
  assert.throws(()=>Mechanism.prepare(target,prior),/EEXIST/);
  assert.throws(()=>Mechanism.prepare(path.join(ROOT,'unsafe-mechanism'),prior),/outside a Git checkout/);
  const file=path.join(target,'cached/src/engine.rs'),original=fs.readFileSync(file);fs.appendFileSync(file,'\n');
  assert.throws(()=>Mechanism.verifyPrepared(target),/does not reproduce/);fs.writeFileSync(file,original);
  const rp=path.join(target,'mechanism-source.json');fs.writeFileSync(rp,JSON.stringify({...receipt,plan:{...receipt.plan,pairedRepetitions:8}}));
  assert.throws(()=>Mechanism.verifyPrepared(target),/mechanism plan changed/);fs.writeFileSync(rp,JSON.stringify(receipt));
  assert.equal(Phase.sha(fs.readFileSync(path.join(prior,'hybrid/src/eval.rs'))),before);
  const summary={};for(const stage of ['all','opening','middlegame','endgame']){summary[stage]={};for(const variant of ['cached','fused'])
    summary[stage][variant]={original:{nodes16384:{pairedMedianNpsRatio:1.1,pairedMedianTimeRatio:0.9,medianElapsedMs:10}}};}
  assert.equal(Mechanism.selectMechanism(summary,[]).selected,'cached');
  summary.all.fused.original.nodes16384.medianElapsedMs=8;
  assert.equal(Mechanism.selectMechanism(summary,[]).selected,'fused');
  summary.middlegame.fused.original.nodes16384.pairedMedianNpsRatio=0.949;
  assert.equal(Mechanism.selectMechanism(summary,[]).selected,'cached');
  summary.all.cached.original.nodes16384.pairedMedianNpsRatio=1.049;
  assert.equal(Mechanism.selectMechanism(summary,[]).selected,null);
  summary.all.cached.original.nodes16384.pairedMedianNpsRatio=1.05;
  assert.equal(Mechanism.selectMechanism(summary,[{variant:'cached'}]).selected,null);
  assert.equal(Mechanism.selectMechanism(summary,[],[{variant:'cached'}]).selected,null);
  summary.all.cached.original.nodes16384.pairedMedianNpsRatio=NaN;
  assert.throws(()=>Mechanism.selectMechanism(summary,[]),/invalid mechanism selection/);
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
console.log('PASS: immutable exact-score mechanism plan, full raw-phase mutation closure, private output and original-source preservation');
