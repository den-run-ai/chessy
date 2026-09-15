'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const H=require('../../tools/training/hybrid-match-v1');
const N=require('../../tools/training/natural-runtime-run');
const Chess=globalThis.Chess;
const protocol=JSON.parse(fs.readFileSync(require('path').join(__dirname,'../../eval/training/hybrid-match-v1.json')));
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  const r={protocol:{...protocol,maxSearchedPlies:2},modules:{shipped:{sha256:'a'.repeat(64)},hybrid:{sha256:'b'.repeat(64)},expanded:{sha256:'c'.repeat(64)}}};
  const task=H.makeTasks(H.openings().slice(0,1),r.protocol)[0],rows=[];
  const engine={search(fen){const state=Chess.parseFen(fen);return {move:Chess.legalMoves(state)[0],score:0,scorePov:'white',depth:30,
    attemptedDepth:null,nodes:1,qnodes:0,cutoffs:0,researches:0,stopReason:'max-depth'};}};
  N.playGame(task,{baseline:engine,candidate:engine},{baseline:r.modules.shipped,candidate:r.modules.hybrid},r.protocol,row=>{if(!row.control)rows.push(row);});
  return {r,task,rows};
}
test('both complete 100-opening color-paired arms frozen before outcomes',()=>{
  const rows=H.openings(),tasks=H.makeTasks(rows,protocol);assert.equal(rows.length,100);assert.equal(tasks.length,400);
  assert.equal(new Set(tasks.map(t=>t.taskId)).size,400);
  for(const opening of rows)for(const arm of ['hybrid','expanded'])assert.deepEqual(tasks.filter(t=>t.opening.index===opening.index&&t.arm===arm).map(t=>t.candidateColor).sort(),['b','w']);
  assert.deepEqual(tasks.slice(0,4).map(t=>t.arm),['hybrid','hybrid','expanded','expanded']);
  assert.deepEqual(tasks.slice(4,8).map(t=>t.arm),['expanded','expanded','hybrid','hybrid']);
  assert.equal(protocol.formalHoldoutAccessAllowed,false);assert.equal(protocol.formalPass,false);
});
test('legal game and genuine ply-cap termination independently replay',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);assert.equal(audited.reason,'ply-cap');assert.equal(audited.searchedPlies,2);});
for(const [name,mutate] of [
  ['history omission',rows=>{rows[1].positions={};}],
  ['wrong evaluator',rows=>{rows[1].moduleSha256='d'.repeat(64);}],
  ['unequal search time',rows=>{rows[1].requested.timeMs=40;}],
  ['endpoint corruption',rows=>{rows[1].fenAfter=rows[1].fenBefore;}],
  ['counter inconsistency',rows=>{rows[1].result.qnodes=2;}],
  ['invented score',rows=>{rows.at(-1).candidateScore=1;}],
  ['premature termination',rows=>{rows.splice(2,1);}],
  ['extra move',rows=>{rows.splice(3,0,copy(rows[2]));}],
  ['missing end',rows=>{rows.pop();}],
  ['wrong opening color',rows=>{rows[0].candidateColor='b';}]
])test('audit rejects '+name,()=>{const f=fixture();mutate(f.rows);assert.throws(()=>H.auditGame(f.rows,f.task,f.r));});
test('canonical raw parser refuses truncated or duplicate-key evidence',()=>{
  assert.throws(()=>H.parseLines(Buffer.from('{"x":1}')));
  assert.throws(()=>H.parseLines(Buffer.from('{"x":1,"x":1}\n')));
  assert.deepEqual(H.parseLines(Buffer.from('{"x":1}\n')),[{x:1}]);
});
test('partial schedule cannot be scored',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);
  f.r.tasks=H.makeTasks(H.openings(),protocol);f.r.openings=H.openings();assert.throws(()=>H.analyzeAudited([audited],f.r),/inventory/);});
test('CLI rejects duplicates and unknown parameters',()=>{
  assert.throws(()=>H.args(['run','--registration','x','--registration','y']));
  assert.throws(()=>H.args(['run','--time-ms','100']));
});
