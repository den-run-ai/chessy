'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
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
// The completed scope has no executable generator, registration, loader, or
// launch entrypoint. Fail before touching even malformed input paths or IPC.
const auditor=require('../../tools/training/hybrid-eval-counts');
const disabled=['prepare','register','run','child','preflight','load'];
const poisoned=new Proxy({}, {get(){throw Error('must not inspect inputs');}});
for(const name of disabled)assert.throws(()=>auditor[name](poisoned,poisoned,poisoned),/completed and retired/);
assert.deepEqual(Object.keys(auditor).sort(),[...disabled,'select','signature','validateRows'].sort());
assert(Object.isFrozen(auditor));

const script=path.resolve(__dirname,'../../tools/training/hybrid-eval-counts.js');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-counts-retired-'));
try {
  const copied=path.join(temporary,'copied-runner.js');
  fs.copyFileSync(script,copied);
  const alias=path.join(temporary,'alias.js');fs.symlinkSync(copied,alias);
  const study=path.join(temporary,'copied-study');fs.mkdirSync(study);
  // Fabricated registration and an absent local ledger cannot reopen v1.
  fs.writeFileSync(path.join(study,'registration.json'),'{}\n');
  for(const entry of [script,copied,alias])for(const command of ['prepare','register','run','child']) {
    const args=command==='prepare'?[path.join(temporary,'fresh'),study,study]:[study];
    const output=spawnSync(process.execPath,[entry,command,...args],{encoding:'utf8',timeout:2000,env:{...process.env,CHESSY_PROFILE_PARENT_TOKEN:'fake-parent-token'}});
    assert.equal(output.status,2,output.stderr);assert.match(output.stderr,/completed and retired/);
  }
  assert.deepEqual(fs.readdirSync(study),['registration.json']);
  assert.equal(fs.existsSync(path.join(temporary,'fresh')),false);

  // Replace and restore the loaded entry pathname around a would-be run. The
  // retired API must never reopen it or fork a child, regardless of directory.
  // Reintroducing the historical run path fails the required retired error.
  const cached=require(copied),original=fs.readFileSync(copied);
  const marker=path.join(temporary,'unverified-child-ran');
  fs.renameSync(copied,copied+'.retained');
  fs.writeFileSync(copied,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"unverified");\n');
  for(const name of disabled)assert.throws(()=>cached[name](study,study,study),/completed and retired/);
  assert.equal(fs.existsSync(marker),false);
  fs.unlinkSync(copied);fs.renameSync(copied+'.retained',copied);
  assert.deepEqual(fs.readFileSync(copied),original);
  assert.throws(()=>cached.child(study),/completed and retired/);
} finally {fs.rmSync(temporary,{recursive:true,force:true});}

// Exact historical text remains bound to the public pre-execution registration.
const historical=path.resolve(__dirname,'../../tools/training/hybrid-eval-counts-historical-v1.js.txt');
const digest=crypto.createHash('sha256').update(fs.readFileSync(historical)).digest('hex');
assert.equal(digest,'42aa8eddbca4d1597710de4f971339d4f0523ae7f6f1c213468b51072f157aff');
assert.equal(fs.statSync(historical).mode&0o111,0);
const registration=require('../../eval/hybrid-eval-counts-v1/registration.json');
assert.equal(registration.dependencies.find(x=>x.path==='tools/training/hybrid-eval-counts.js').sha256,digest);
console.log('Counts-only inventory, parity, phase sums, archived-arm boundary and retired entrypoints PASS');
