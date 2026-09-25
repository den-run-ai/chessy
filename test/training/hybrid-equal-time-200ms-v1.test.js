'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const H=require('../../tools/training/hybrid-equal-time-200ms-v1');
const Opening=require('../../tools/training/hybrid-match-v1');
const N=require('../../tools/training/natural-runtime-run');
const Chess=globalThis.Chess;
const protocol=JSON.parse(fs.readFileSync(require('path').join(__dirname,'../../eval/training/hybrid-equal-time-200ms-v1.json')));
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  const r={protocol:{...protocol,maxSearchedPlies:2},modules:{shipped:{sha256:'a'.repeat(64)},hybrid:{sha256:'b'.repeat(64)},expanded:{sha256:'c'.repeat(64)}}};
  const task=H.makeTasks(Opening.openings().slice(0,1),r.protocol)[0],rows=[];
  const engine={search(fen){const state=Chess.parseFen(fen),m=Chess.legalMoves(state)[0];return {move:{from:m.from,to:m.to,promotion:m.promotion||null},score:0,scorePov:'white',depth:2,
    attemptedDepth:3,nodes:2048,qnodes:1000,cutoffs:300,researches:0,stopReason:'time-limit'};}};
  H.playGame(task,{baseline:engine,candidate:engine},{baseline:r.modules.shipped,candidate:r.modules.hybrid},r.protocol,row=>{if(!row.control)rows.push(row);});
  for(const row of rows)if(row.schema==='chessy.natural-runtime-move.v1')row.elapsedMs=200.25;
  return {r,task,rows};
}
test('frozen salted SHA selection has20exposed pairs and40equal-time tasks',()=>{
  const source=Opening.openings(),rows=H.selectOpenings(source,protocol),tasks=H.makeTasks(rows,protocol);
  assert.equal(source.length,100);assert.equal(rows.length,20);assert.equal(tasks.length,40);assert.equal(new Set(tasks.map(t=>t.taskId)).size,40);
  assert.deepEqual(rows.map(o=>o.index),[6,59,38,86,28,60,41,58,57,51,96,83,78,34,91,14,5,84,75,74]);
  assert.deepEqual(rows.map(o=>o.index),protocol.openingSelection.selectedOriginalIndices);
  for(const opening of rows)assert.deepEqual(tasks.filter(t=>t.opening.index===opening.index).map(t=>t.candidateColor).sort(),['b','w']);
  assert.deepEqual(tasks.slice(0,4).map(t=>t.candidateColor),['w','b','b','w']);
  assert(tasks.every(t=>t.nodeLimit===0&&t.timeMs===200&&t.arm==='hybrid'));
  assert.equal(protocol.formalHoldoutAccessAllowed,false);assert.equal(protocol.formalPass,false);assert.equal(protocol.workloadWatchdogMs,35*60*1000);
  assert.throws(()=>H.selectOpenings(source.slice(1),protocol),/100opening/);
});
test('legal game and genuine ply-cap termination independently replay',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);assert.equal(audited.reason,'ply-cap');assert.equal(audited.searchedPlies,2);});
for(const [name,mutate] of [
  ['history omission',rows=>{rows[1].positions={};}],
  ['wrong evaluator',rows=>{rows[1].moduleSha256='d'.repeat(64);}],
  ['unequal search time',rows=>{rows[1].requested.timeMs=40;}],
  ['endpoint corruption',rows=>{rows[1].fenAfter=rows[1].fenBefore;}],
  ['counter inconsistency',rows=>{rows[1].result.qnodes=20000;}],
  ['node cap in equal-time search',rows=>{rows[1].requested.nodeLimit=16384;}],
  ['node-limited time search',rows=>{rows[1].result.stopReason='node-limit';}],
  ['early false time limit',rows=>{rows[1].elapsedMs=199.9;}],
  ['invented score',rows=>{rows.at(-1).candidateScore=1;}],
  ['premature termination',rows=>{rows.splice(2,1);}],
  ['extra move',rows=>{rows.splice(3,0,copy(rows[2]));}],
  ['missing end',rows=>{rows.pop();}],
  ['wrong opening color',rows=>{rows[0].candidateColor='b';}]
])test('audit rejects '+name,()=>{const f=fixture();mutate(f.rows);assert.throws(()=>H.auditGame(f.rows,f.task,f.r));});
test('canonical raw parser refuses truncated or duplicate-key evidence',()=>{
  assert.throws(()=>Opening.parseLines(Buffer.from('{"x":1}')));
  assert.throws(()=>Opening.parseLines(Buffer.from('{"x":1,"x":1}\n')));
  assert.deepEqual(Opening.parseLines(Buffer.from('{"x":1}\n')),[{x:1}]);
});
test('partial schedule cannot be scored',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);
  f.r.openings=H.selectOpenings(Opening.openings(),protocol);f.r.tasks=H.makeTasks(f.r.openings,protocol);assert.throws(()=>H.analyzeAudited([audited],f.r),/inventory/);});
test('CLI rejects duplicates and unknown parameters',()=>{
  assert.throws(()=>H.args(['run','--registration','x','--registration','y']));
  assert.throws(()=>H.args(['run','--time-ms','100']));
});

if(process.env.CHESSY_EXPORT_TIME200_FIXTURE)fs.writeFileSync(process.env.CHESSY_EXPORT_TIME200_FIXTURE,JSON.stringify(fixture()));

test('invalid search evidence is emitted before a hard failure',()=>{
 const rows=[],state=N.replay(Opening.openings()[0].prefixUci);
 const invalid={move:Chess.legalMoves(state)[0],nodes:16385};
 assert.throws(()=>H.timedSearch({search:()=>invalid},'candidate','b'.repeat(64),state,{maxDepth:30,nodeLimit:0,timeMs:200,quiesce:true},row=>rows.push(row)));
 assert.equal(rows[1].schema,'chessy.hybrid-fixed-node-invalid-search.v1');assert.deepEqual(rows[1].rawResult,invalid);
});
