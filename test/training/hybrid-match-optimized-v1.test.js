'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const H=require('../../tools/training/hybrid-match-optimized-v1');
const O=require('../../tools/training/hybrid-match-v1');
const protocol=JSON.parse(fs.readFileSync(path.join(__dirname,'../../eval/training/hybrid-match-optimized-v1.json')));
function fixture(cached=9,fused=8){
  const report={schema:'chessy.hybrid-runtime-mechanism-cost.v1',status:'completed',researchOnly:true,parityMismatches:0,
    parity:Array.from({length:501},(_,i)=>({fen:'fixture-'+i,wanted:i,cached:i,fused:i})),exactNodeBudgetSearchSignatures:true,searchSignatureMismatches:[],records:[]};
  for(const variant of ['original','cached','fused'])for(const budget of [4096,16384])for(let position=0;position<12;position++)for(let repetition=0;repetition<4;repetition++)
    report.records.push({variant,budget,kind:'nodes',position,repetition,stage:['opening','middlegame','endgame'][position%3],
      elapsedMs:variant==='original'?10:variant==='cached'?cached:fused,result:{nodes:budget,move:'a2a3',score:0,depth:3}});
  // Other evaluation/time/reference rows do not enter the selection estimator.
  while(report.records.length<768)report.records.push({kind:'evaluation'});
  return report;
}
test('prospective trigger chooses the faster eligible implementation',()=>{const d=H.decision(fixture(),protocol);assert.equal(d.selected,'fused');assert.equal(d.gameOutcomesUsed,false);});
test('exact runtime ties select cached',()=>{assert.equal(H.decision(fixture(9,9),protocol).selected,'cached');});
test('insufficient speed skips the entire extension',()=>{assert.equal(H.decision(fixture(10,10),protocol).selected,null);});
test('phase regression vetoes an otherwise faster implementation',()=>{const r=fixture(9,9);
  for(const row of r.records)if(row.variant==='fused'&&row.budget===16384&&row.stage==='endgame')row.elapsedMs=11;
  const d=H.decision(r,protocol);assert.equal(d.variants.fused.eligible,false);assert.equal(d.selected,'cached');});
test('fixed-node signature mismatch blocks selection',()=>{const r=fixture();r.records.find(row=>row.variant==='cached').result.score=1;assert.throws(()=>H.decision(r,protocol),/signature/);});
test('compiled parity mismatch blocks selection',()=>{const r=fixture();r.parity[0].fused++;assert.throws(()=>H.decision(r,protocol),/parity/);});
test('missing or duplicated paired cell blocks selection',()=>{const r=fixture();const i=r.records.findIndex(row=>row.variant==='cached');r.records[i]={...r.records[i+1]};assert.throws(()=>H.decision(r,protocol),/cell/);});
test('new schedule is exactly one200-game arm with the same exposed colorpairs',()=>{const rows=O.openings(),tasks=H.tasks(rows,protocol);assert.equal(tasks.length,200);
  assert(tasks.every(t=>t.arm==='hybrid'&&t.timeMs===20));for(let i=0;i<100;i++)assert.deepEqual(tasks.filter(t=>t.opening.index===i).map(t=>t.candidateColor).sort(),['b','w']);
  assert.equal(protocol.formalPass,false);assert.equal(protocol.trigger.gameResultsMayInfluenceTriggerOrSelection,false);});
