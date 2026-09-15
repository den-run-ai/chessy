'use strict';
const assert=require('node:assert/strict');
const path=require('node:path'),{spawnSync}=require('node:child_process');
const {signature,validateRows}=require('../../tools/training/hybrid-eval-counts');
const result={move:{from:0,to:1,promotion:null},score:4,scorePov:'white',depth:2,attemptedDepth:3,nodes:16384,qnodes:9000,cutoffs:100,researches:2,stopReason:'node-limit'};
const selected=Array.from({length:24},(_,i)=>({taskId:'task-'+i,ply:i,archivedModuleSha256:'shipped',archivedResult:{...result,score:-99}}));
const rows=[];
for(let i=0;i<24;i++)for(let offset=0;offset<2;offset++){
  const observer=(i+offset)%2===1,counts=Array(25).fill(0);counts[i===23?24:i]=5;
  rows.push({index:i,taskId:'task-'+i,ply:i,arm:observer?'observer':'original',result:{...result},counts:observer?counts:null});
}
const aggregate=validateRows(rows,selected);
assert.equal(aggregate.phaseCounts.reduce((a,b)=>a+b,0),120);
assert.equal(aggregate.expandedOnly,35);assert.equal(aggregate.blend,25);assert.equal(aggregate.neuralOnly,60);assert.equal(aggregate.phaseCounts[24],5);
assert.deepEqual(signature(result),signature({...result,move:{promotion:null,to:1,from:0},moveUci:'a8b8'}));
function broken(change,pattern){const r=structuredClone(rows),s=structuredClone(selected);change(r,s);assert.throws(()=>validateRows(r,s),pattern);}
broken(r=>r.pop(),/48-row/);
broken(r=>r[0].arm='observer',/identity\/order/);
broken(r=>r[1].result.score++,/mismatch/);
broken(r=>r[1].counts[0]=-1,/counter range/);
broken(r=>r[1].counts[0]=16385,/more evaluations/);
broken(r=>{r[0].result={nodes:16384};r[1].result={nodes:16384};},/result fields/);
broken(r=>{r[1].countsError='injected read trap';},/result fields/);
broken((r,s)=>{s[0].archivedModuleSha256='18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493';},/archived hybrid/);
const child=spawnSync(process.execPath,[path.resolve(__dirname,'../../tools/training/hybrid-eval-counts.js'),'child','/does-not-exist'],{encoding:'utf8',timeout:2000});
assert.equal(child.status,1);assert.match(child.stderr,/child requires parent IPC/);
console.log('Counts-only inventory, parity, phase sums and archived-arm boundary PASS');
