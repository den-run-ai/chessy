'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Cost=require('../../tools/search/qsearch-cost'),Bench=require('../../tools/search/qsearch-bench');
const ROOT=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-qsearch-test-'));
try{
  const production=['src/engine.rs','src/search.rs'].map(p=>fs.readFileSync(path.join(ROOT,'experiments/wasm',p)));
  for(const variant of ['checks','tactical']){
    const out=path.join(temp,variant),reads=new Map(),read=fs.readFileSync;let receipt;
    fs.readFileSync=function(file,...args){if(String(file).endsWith('.rs.in'))reads.set(String(file),(reads.get(String(file))||0)+1);return read.call(fs,file,...args);};
    try{receipt=Cost.prepare(out,variant);}finally{fs.readFileSync=read;}
    assert.equal(reads.size,4);for(const count of reads.values())assert.equal(count,1,'templates must be read and hashed from one retained snapshot');
    assert.equal(receipt.variant,variant);assert.equal(receipt.productionIntegrationAllowed,false);
    for(const file of receipt.generated)assert.equal(Cost.sha(fs.readFileSync(path.join(out,file.path))),file.sha256);
    assert.throws(()=>Cost.prepare(out,variant),/EEXIST/);
  }
  assert.throws(()=>Cost.prepare(path.join(ROOT,'not-created')),/outside repository/);
  fs.symlinkSync(ROOT,path.join(temp,'repo-link'),'dir');
  assert.throws(()=>Cost.prepare(path.join(temp,'repo-link','not-created')),/outside repository/);
  assert.throws(()=>Cost.prepare(path.join(temp,'unknown'),'unknown'),/unknown/);
  assert.throws(()=>Cost.patchSearch('missing source anchors'),/missing\/ambiguous/);
  assert.throws(()=>Cost.patchEngine('missing source anchors','tactical'),/missing tactical/);
  for(const [i,p] of ['src/engine.rs','src/search.rs'].entries())assert.deepEqual(fs.readFileSync(path.join(ROOT,'experiments/wasm',p)),production[i]);
  const wasm=path.join(ROOT,'assets/chessy-ai-fast.wasm');
  const file=path.join(temp,'fixed.json'),plan=Bench.register(file,'fixed',[wasm,wasm]);
  assert.deepEqual(plan.options.nodeLimits,[10000,36000,230000]);assert.equal(plan.positions.length,18);
  assert.equal(plan.options.repetitions,4);assert.equal(plan.strengthClaimAllowed,false);
  assert.throws(()=>Bench.register(file,'fixed',[wasm,wasm]),/EEXIST/);
  assert.throws(()=>Bench.register(path.join(temp,'bad.json'),'formal',[wasm,wasm]),/unknown/);
  const master=Bench.register(path.join(temp,'master.json'),'master',[wasm,wasm]);
  assert.equal(master.options.maxDepth,30);assert.equal(master.options.timeMs,5000);assert.equal(master.options.repetitions,2);
  assert.equal(master.selectionAllowed,false);
  console.log('qsearch source isolation, no-clobber registration and diagnostic budgets: passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
