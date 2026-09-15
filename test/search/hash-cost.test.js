'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const H=require('../../tools/search/hash-cost');
const root=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hash-source-test-'));
try {
  const dest=path.join(tmp,'candidate'),before=fs.readFileSync(path.join(root,'experiments/wasm/src/search.rs'));
  const r=H.prepare(dest),after=fs.readFileSync(path.join(dest,'src/search.rs'),'utf8');
  assert.deepEqual(fs.readFileSync(path.join(root,'experiments/wasm/src/search.rs')),before);
  assert.equal(r.productionIntegrationAllowed,false);
  assert.equal(r.source.filter(x=>x.sha256!==r.generated.find(y=>y.path===x.path).sha256).map(x=>x.path).join(','),'src/search.rs');
  assert.match(after,/unsafe fn hash_position\(position: &mut Position\)/);
  assert.equal(after.split('advance_board_hash(position, mv, ply, true);').length,2);
  assert.equal(after.split('advance_board_hash(position, mv, ply, position.halfmove >= 4);').length,2);
  assert.match(after,/engine::has_legal_en_passant\(position\)/);
  for(const p of r.generated)assert.equal(H.sha(fs.readFileSync(path.join(dest,p.path))),p.sha256);
  assert.throws(()=>H.prepare(dest),/EEXIST/);
  assert.throws(()=>H.prepare(path.join(root,'forbidden-research-output')),/outside/);
  console.log('hash source isolation, unchanged engine/eval, anchored searched edges and exact snapshot hashes PASS');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}

// Exercise failure capture with synthetic observations; this does not search.
(async()=>{
  const benchPath=require.resolve('../../experiments/wasm/bench'),originalBench=require(benchPath);
  const Bench={...originalBench},runnerPath=require.resolve('../../tools/search/hash-bench');
  const previousRunner=require.cache[runnerPath];
  require.cache[benchPath].exports=Bench;delete require.cache[runnerPath];
  const B=require(runnerPath),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hash-bench-test-'));
  try {
    fs.mkdirSync(path.join(dir,'candidate/dist'),{recursive:true});
    const base=path.join(dir,'base.wasm'),candidate=path.join(dir,'candidate/dist/candidate.wasm');
    fs.writeFileSync(base,'base');fs.writeFileSync(candidate,'candidate');
    fs.writeFileSync(path.join(dir,'candidate/source.json'),'{}');
    for(const failure of ['signature','timing']){
      let loaded=0;
      Bench.loadOrdinaryWasmBytes=async()=>{const engine=loaded++;return {search:()=>({
        abiVersion:2,move:123,score:failure==='signature'?engine:0,depth:1,attemptedDepth:2,
        nodes:1,qnodes:0,cutoffs:0,researches:0,stopReason:'node-limit',ms:failure==='timing'?NaN:1
      })};};
      const plan=path.join(dir,failure+'.plan.json'),out=path.join(dir,failure+'.json');
      B.register(plan,'fixed',[base,candidate]);
      await assert.rejects(B.run(plan,out),failure==='signature'?/signature diverged/:/invalid timing/);
      assert.equal(fs.existsSync(out),false);
      const saved=JSON.parse(fs.readFileSync(out+'.failure.json'));
      assert.equal(saved.rows.length,failure==='signature'?2:1);
      if(failure==='signature')assert.equal(saved.rows[1].score,1);else assert.equal(saved.rows[0].ms,null);
    }
    console.log('hash benchmark retains first divergent and invalid timing observations PASS (synthetic; no search)');
  } finally {
    require.cache[benchPath].exports=originalBench;
    if(previousRunner)require.cache[runnerPath]=previousRunner;else delete require.cache[runnerPath];
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
