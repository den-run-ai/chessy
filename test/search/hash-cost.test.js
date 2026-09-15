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

// The source receipt hashes the same generator/template bytes that execute.
{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hash-generator-capture-'));
  function generator(name){
    const copy=path.join(directory,name),entry=path.join(copy,'tools/search/hash-cost.js');
    for(const rel of ['tools/search/hash-cost.js','tools/search/hash-board.rs.in','tools/search/hash-parity.rs.in',
      ...['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'].map(p=>'experiments/wasm/'+p)]){
      fs.mkdirSync(path.dirname(path.join(copy,rel)),{recursive:true});fs.copyFileSync(path.join(root,rel),path.join(copy,rel));
    }
    return entry;
  }
  const read=fs.readFileSync;
  try{
    const entry=generator('swapped-self'),next=fs.readFileSync(entry,'utf8').replace('chessy.searched-board-hash.source.v1','chessy.searched-board-hash.source.test-v2');
    let reads=0,loaded;
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(String(file)===entry&&++reads===1)fs.writeFileSync(file,next);return bytes;};
    try{loaded=require(entry);}finally{fs.readFileSync=read;}
    const receipt=loaded.prepare(path.join(directory,'generated'));
    assert.equal(reads,2);assert.equal(receipt.schema,'chessy.searched-board-hash.source.test-v2');
    assert.equal(receipt.dependencies.find(x=>x.path==='hash-cost.js').sha256,H.sha(next));
    fs.appendFileSync(entry,'\n// later replacement\n');
    assert.throws(()=>loaded.prepare(path.join(directory,'later')),/generator dependency changed after capture/);
    assert.equal(fs.existsSync(path.join(directory,'later')),false);
    const templateEntry=generator('swapped-template'),template=path.join(path.dirname(templateEntry),'hash-board.rs.in');
    let templateLoaded;
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(String(file)===template)fs.appendFileSync(file,'\n// concurrent change\n');return bytes;};
    try{templateLoaded=require(templateEntry);}finally{fs.readFileSync=read;}
    assert.throws(()=>templateLoaded.prepare(path.join(directory,'bad-template')),/generator dependency changed after capture/);
    assert.equal(fs.existsSync(path.join(directory,'bad-template')),false);
    const sourceEntry=generator('swapped-source'),source=path.join(path.dirname(sourceEntry),'../../experiments/wasm/src/search.rs');
    const sourceLoaded=require(sourceEntry);
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(path.resolve(String(file))===path.resolve(source))fs.appendFileSync(file,'\n// changed source\n');return bytes;};
    try{assert.throws(()=>sourceLoaded.prepare(path.join(directory,'bad-source')),/generator dependency changed after capture/);}finally{fs.readFileSync=read;}
    assert.equal(fs.existsSync(path.join(directory,'bad-source')),false);
  }finally{fs.readFileSync=read;fs.rmSync(directory,{recursive:true,force:true});}
}

// Retained-source tests and first-failure capture use synthetic adapters only.
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hash-bench-test-'));
  const runnerSource=fs.readFileSync(path.join(root,'tools/search/hash-bench.js'));
  const ledgerLiteral="path.join(fs.realpathSync(os.homedir()),'.local/state/chessy-research/den-run-ai/chessy')";
  const benchmarkSource=fs.readFileSync(path.join(root,'experiments/wasm/bench.js'));
  const referencePositions=require('../../experiments/wasm/bench').POSITIONS;
  const B=require('../../tools/search/hash-bench');
  function fixture(name,source=benchmarkSource,ledger=path.join(dir,name+'-ledger')){
    const study=path.join(dir,name),runner=path.join(study,'tools/search/hash-bench.js');
    const benchmark=path.join(study,'experiments/wasm/bench.js');
    const frozen=path.join(study,'test/fixtures/wasm-r69-signatures.json');
    for(const file of [runner,benchmark,frozen])fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(runner,runnerSource.toString().replace(ledgerLiteral,JSON.stringify(ledger)));fs.writeFileSync(benchmark,source);
    fs.copyFileSync(path.join(root,'test/fixtures/wasm-r69-signatures.json'),frozen);
    return {runner,benchmark,frozen};
  }
  try {
    fs.mkdirSync(path.join(dir,'candidate/dist'),{recursive:true});
    const base=path.join(dir,'base.wasm'),candidate=path.join(dir,'candidate/dist/candidate.wasm');
    fs.writeFileSync(base,'base');fs.writeFileSync(candidate,'candidate');
    fs.writeFileSync(path.join(dir,'candidate/source.json'),'{}');
    for(const failure of ['signature','timing']){
      const source=Buffer.from(`module.exports={POSITIONS:${JSON.stringify(referencePositions)},
        async loadOrdinaryWasmBytes(bytes,label){return {search:()=>({
          abiVersion:2,move:'a8b8',score:'${failure}'==='signature'&&label==='module-1'?1:0,
          depth:1,attemptedDepth:2,nodes:1,qnodes:0,cutoffs:0,researches:0,stopReason:'node-limit',
          ms:'${failure}'==='timing'?0:1
        })};}};`);
      const f=fixture(failure,source),runner=require(f.runner);
      const plan=path.join(dir,failure+'.plan.json'),out=path.join(dir,failure+'.json');
      runner.register(plan,'fixed',[base,candidate]);
      await assert.rejects(runner.run(plan,out),failure==='signature'?/signature diverged/:/invalid timing/);
      assert.equal(fs.existsSync(out),false);
      const saved=JSON.parse(fs.readFileSync(out+'.failure.json'));
      assert.equal(saved.rows.length,failure==='signature'?2:1);
      assert.equal(saved.rows.at(-1)[failure==='signature'?'score':'ms'],failure==='signature'?1:0);
    }
    const cached=fixture('cached');require.cache[cached.benchmark]={exports:{POSITIONS:[]}};
    const retained=require(cached.runner),planPath=path.join(dir,'cached.plan.json');
    const plan=retained.register(planPath,'fixed',[base,candidate]);
    assert.deepEqual(plan.positions,B.positions());assert.equal(plan.dependencies.length,3);
    assert.throws(()=>retained.register(path.join(dir,'duplicate.plan.json'),'fixed',[base,base]),/distinct module/);
    const sameBytes=path.join(dir,'same.wasm');fs.copyFileSync(base,sameBytes);
    assert.throws(()=>retained.register(path.join(dir,'same.plan.json'),'fixed',[base,sameBytes]),/distinct module/);
    for(const [label,change] of [
      ['path',p=>p.modules[1].path=p.modules[0].path],
      ['hash',p=>p.modules[1].sha256=p.modules[0].sha256],
      ['canonical',p=>p.modules[1].path='relative.wasm']
    ]){
      const bad=structuredClone(plan);change(bad);const input=path.join(dir,label+'.json'),output=input+'.out';
      fs.writeFileSync(input,JSON.stringify(bad));await assert.rejects(retained.run(input,output),/module identit/);
      assert.equal(fs.existsSync(output+'.lock'),false);
    }
    const cli=require('node:child_process').spawnSync(process.execPath,[cached.runner,'register',path.join(dir,'cli.plan.json'),'fixed',base,candidate],{encoding:'utf8'});
    assert.equal(cli.status,0);assert.deepEqual(JSON.parse(cli.stdout),{registered:true});
    plan.warmup.rounds=0;
    assert.equal(retained.register(path.join(dir,'warmup-copy.plan.json'),'fixed',[base,candidate]).warmup.rounds,2);
    delete require.cache[cached.benchmark];
    const read=fs.readFileSync;
    const swapped=fixture('swapped');let reads=0,old;
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(String(file)===swapped.benchmark){reads++;fs.writeFileSync(file,benchmarkSource.toString().replace('opening (Ruy Lopez)','changed opening'));}return bytes;};
    try{old=require(swapped.runner);}finally{fs.readFileSync=read;}
    assert.equal(reads,1);assert.deepEqual(old.positions(),B.positions());
    assert.throws(()=>old.register(path.join(dir,'swapped.plan.json'),'fixed',[base,candidate]),/dependency changed before registration/);
    const self=fixture('self');let selfReads=0,selfRunner;
    const next=Buffer.from(fs.readFileSync(self.runner,'utf8').replace('quiesce:true,rounds:2','quiesce:true,rounds:3'));
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(String(file)===self.runner&&++selfReads===1)fs.writeFileSync(file,next);return bytes;};
    try{selfRunner=require(self.runner);}finally{fs.readFileSync=read;}
    const selfPlan=selfRunner.register(path.join(dir,'self.plan.json'),'fixed',[base,candidate]);
    assert.equal(selfReads,2);assert.equal(selfPlan.warmup.rounds,3);assert.equal(selfPlan.dependencies[0].sha256,H.sha(next));
    fs.appendFileSync(self.runner,'\n// changed again');
    assert.throws(()=>selfRunner.register(path.join(dir,'self-again.plan.json'),'fixed',[base,candidate]),/dependency changed before registration/);
    const swappedFixture=fixture('frozen');let fixtureReads=0,fixtureRunner;
    fs.readFileSync=function(file,...args){const bytes=read.call(fs,file,...args);if(String(file)===swappedFixture.frozen){fixtureReads++;fs.writeFileSync(file,'bad JSON');}return bytes;};
    try{fixtureRunner=require(swappedFixture.runner);}finally{fs.readFileSync=read;}
    assert.equal(fixtureReads,1);assert.deepEqual(fixtureRunner.positions(),B.positions());
    assert.throws(()=>fixtureRunner.register(path.join(dir,'frozen.plan.json'),'fixed',[base,candidate]),/dependency changed before registration/);
    const unauthenticated=fixture('unauthenticated',Buffer.from("throw Error('unauthenticated benchmark executed');"));
    const output=path.join(dir,'unauthenticated.json');
    await assert.rejects(require(unauthenticated.runner).run(planPath,output),/dependency changed after registration/);
    assert.equal(fs.existsSync(output+'.lock'),false);
    const imported=fixture('imported',Buffer.concat([benchmarkSource,Buffer.from("\nrequire('./uncaptured');")]));
    assert.throws(()=>require(imported.runner).positions(),/only built-in modules/);
    const untracked=fixture('untracked',Buffer.concat([benchmarkSource,Buffer.from("\nrequire('fs').readFileSync(__filename,'utf8');")]));
    assert.throws(()=>require(untracked.runner).positions(),/uncaptured file read/);
    const sharedLedger=path.join(dir,'shared-ledger'),stub=Buffer.from(`module.exports={POSITIONS:${JSON.stringify(referencePositions)},async loadOrdinaryWasmBytes(){await Promise.resolve();throw Error('fixture engine load');}};`);
    const a=fixture('one-shot-a',stub,sharedLedger),b=fixture('one-shot-b',stub,sharedLedger);
    fs.appendFileSync(b.runner,'\n// comment-only copy must retain experiment identity\n');
    const A=require(a.runner),Other=require(b.runner),aPlan=path.join(dir,'once-a.plan.json'),bPlan=path.join(dir,'once-b.plan.json');
    const first=A.register(aPlan,'fixed',[base,candidate]);
    const relocated=path.join(dir,'relocated/dist/renamed.wasm'),relocatedBase=path.join(dir,'renamed-base.wasm');
    fs.mkdirSync(path.dirname(relocated),{recursive:true});fs.copyFileSync(candidate,relocated);fs.copyFileSync(base,relocatedBase);
    fs.writeFileSync(path.join(dir,'relocated/source.json'),'{}');
    const second=Other.register(bPlan,'fixed',[relocatedBase,relocated]);
    assert.equal(first.experimentIdentity,second.experimentIdentity);
    assert.notDeepEqual(first.dependencies,second.dependencies);
    const relabeled=fixture('relabeled',Buffer.from(stub.toString().replace('opening (Ruy Lopez)','relabeled opening')),sharedLedger);
    const labelRunner=require(relabeled.runner),labelPlan=path.join(dir,'relabeled.json');
    assert.equal(labelRunner.register(labelPlan,'fixed',[base,candidate]).experimentIdentity,first.experimentIdentity);
    const movedPlan=path.join(dir,'copy-of-registration.json');fs.copyFileSync(aPlan,movedPlan);
    const attempt=A.run(aPlan,path.join(dir,'first-attempt.json'));
    const results=await Promise.allSettled([attempt,Other.run(bPlan,path.join(dir,'other-output.json')),A.run(movedPlan,path.join(dir,'copied-output.json'))]);
    assert.match(String(results[0].reason),/fixture engine load/);
    for(const result of results.slice(1))assert.match(String(result.reason),/already started/);
    assert.equal(fs.existsSync(path.join(dir,'other-output.json.lock')),false);
    assert.equal(fs.existsSync(path.join(dir,'copied-output.json.lock')),false);
    assert.equal(fs.readdirSync(sharedLedger).length,1);
    const spent=JSON.parse(fs.readFileSync(path.join(sharedLedger,fs.readdirSync(sharedLedger)[0])));
    assert.equal(spent.experimentIdentity,first.experimentIdentity);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'first-attempt.json.failure.json'))).attempt,spent);
    assert.throws(()=>Other.register(path.join(dir,'reregister.json'),'fixed',[relocatedBase,relocated]),/already started/);
    await assert.rejects(A.run(aPlan,path.join(dir,'retry.json')),/already started/);
    assert.throws(()=>labelRunner.register(path.join(dir,'relabel-retry.json'),'fixed',[base,candidate]),/already started/);
    const raced=fixture('raced',stub),raceRunner=require(raced.runner),racePlan=path.join(dir,'race-plan.json');
    raceRunner.register(racePlan,'fixed',[base,candidate]);
    const open=fs.openSync;let winningPath;
    fs.openSync=function(file,flags,...args){
      if(flags==='wx'&&String(file).endsWith('.started.json')&&!winningPath){
        winningPath=file;const competing=open.call(fs,file,flags,...args);
        fs.writeFileSync(competing,'winning reservation\n');fs.closeSync(competing);
      }
      return open.call(fs,file,flags,...args);
    };
    try{await assert.rejects(raceRunner.run(racePlan,path.join(dir,'raced-out.json')),/EEXIST/);}finally{fs.openSync=open;}
    assert.equal(fs.readFileSync(winningPath,'utf8'),'winning reservation\n');
    assert.equal(fs.existsSync(path.join(dir,'raced-out.json.lock')),false);
    // Exact historical recipes are retired, while other scientific corpora are distinct.
    for(const mode of ['fixed','master']){
      const historical=JSON.parse(fs.readFileSync(path.join(root,'eval/hash-cost-v1',mode+'-registration.json')));
      assert.throws(()=>B.assertUnspent(historical),/completed and retired/);
      const relabel=structuredClone(historical);relabel.positions[0].name='new label';relabel.positions[0].phase='metadata';
      assert.throws(()=>B.assertUnspent(relabel),/completed and retired/);
      const otherCorpus=structuredClone(historical);otherCorpus.positions[0].fen=historical.positions[1].fen;
      assert.notEqual(B.experimentIdentity(otherCorpus),B.experimentIdentity(historical));B.assertUnspent(otherCorpus);
    }
    console.log('Hash retained generator/runner/loader/fixture and durable one-shot failure/concurrency/copy tests PASS (no WASM/search)');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
