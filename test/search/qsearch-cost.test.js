'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Cost=require('../../tools/search/qsearch-cost'),Bench=require('../../tools/search/qsearch-bench');
const ROOT=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-qsearch-test-'));
(async function(){try{
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
  // Identity-only fixtures: malformed registrations must fail before WASM load.
  const candidates=[1,2].map(i=>{const file=path.join(temp,'candidate-'+i+'.wasm');fs.writeFileSync(file,Buffer.from('distinct candidate '+i));return file;});
  const modules=[wasm,...candidates];
  const file=path.join(temp,'fixed.json'),plan=Bench.register(file,'fixed',modules);
  assert.deepEqual(plan.options.nodeLimits,[10000,36000,230000]);assert.equal(plan.positions.length,18);
  assert.equal(plan.options.repetitions,4);assert.equal(plan.strengthClaimAllowed,false);
  assert.throws(()=>Bench.register(file,'fixed',modules),/EEXIST/);
  assert.throws(()=>Bench.register(path.join(temp,'bad.json'),'formal',modules),/unknown/);
  const master=Bench.register(path.join(temp,'master.json'),'master',modules.slice(0,2));
  assert.equal(master.options.maxDepth,30);assert.equal(master.options.timeMs,5000);assert.equal(master.options.repetitions,2);
  assert.equal(master.selectionAllowed,false);
  assert.throws(()=>Bench.register(path.join(temp,'duplicate.json'),'master',[wasm,wasm]),/duplicate module identity/);
  assert.throws(()=>Bench.register(path.join(temp,'missing.json'),'fixed',modules.slice(0,2)),/module inventory/);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const badPlans=[
    ['empty modules',p=>p.modules=[]],['missing module',p=>p.modules.pop()],['extra module',p=>p.modules.push(p.modules[0])],
    ['duplicate module path',p=>p.modules[1].path=p.modules[0].path],['duplicate module hash',p=>p.modules[1].sha256=p.modules[0].sha256],
    ['malformed module hash',p=>p.modules[1].sha256='bad'],['relative module path',p=>p.modules[1].path='candidate.wasm'],
    ['missing module hash',p=>delete p.modules[1].sha256],['empty positions',p=>p.positions=[]],
    ['missing position',p=>p.positions.pop()],['duplicate position',p=>p.positions[1]=p.positions[0]],
    ['reordered positions',p=>p.positions.reverse()],['sparse positions',p=>delete p.positions[0]],
    ['invented position',p=>p.positions[0].fen='8/8/8/8/8/8/8/8 w - - 0 1'],
    ['empty budgets',p=>p.options.nodeLimits=[]],['duplicate budget',p=>p.options.nodeLimits[1]=10000],
    ['invented budget',p=>p.options.nodeLimits[1]=12345],['reordered budgets',p=>p.options.nodeLimits.reverse()],
    ['zero repetitions',p=>p.options.repetitions=0],['fractional repetitions',p=>p.options.repetitions=1.5],
    ['missing repetitions',p=>delete p.options.repetitions],['changed depth',p=>p.options.maxDepth=1],
    ['time/node mix',p=>p.options.timeMs=5000],['disabled quiescence',p=>p.options.quiesce=false],
    ['missing warmup',p=>p.warmup={}],['zero warmup',p=>p.warmup.rounds=0],['changed order',p=>p.order='reference first'],
    ['unknown mode',p=>p.mode='formal'],['invented field',p=>p.complete=true],['bad policy',p=>p.selectionAllowed=false],
    ['bad timestamp',p=>p.created='not a date'],['missing dependency',p=>p.dependencies.pop()],
    ['invented dependency',p=>p.dependencies[1].path='other.js'],['bad dependency hash',p=>p.dependencies[1].sha256='bad']
  ];
  for(let i=0;i<badPlans.length;i++){
    const [label,mutate]=badPlans[i],bad=clone(plan);mutate(bad);
    assert.throws(()=>Bench.validatePlan(bad),undefined,label);
    const input=path.join(temp,'bad-'+i+'.json'),output=path.join(temp,'out-'+i+'.json');fs.writeFileSync(input,JSON.stringify(bad));
    // No lock or result artifacts: validation occurs before execution begins.
    await assert.rejects(Bench.run(input,output),undefined,label);
    assert.equal(fs.existsSync(output),false,label);assert.equal(fs.existsSync(output+'.lock'),false,label);
  }
  const wrongMaster=clone(master);wrongMaster.options.maxDepth=111;
  assert.throws(()=>Bench.validatePlan(wrongMaster),/mode-specific options/);
  const policyMaster=clone(master);policyMaster.selectionAllowed=true;
  assert.throws(()=>Bench.validatePlan(policyMaster),/selection policy/);
  const moduleMaster=clone(master);moduleMaster.modules.push(plan.modules[2]);
  assert.throws(()=>Bench.validatePlan(moduleMaster),/module inventory/);
  const changedFile=clone(plan);changedFile.modules[2].sha256='f'.repeat(64);
  const changedInput=path.join(temp,'changed-file.json'),changedOutput=path.join(temp,'changed-output.json');
  fs.writeFileSync(changedInput,JSON.stringify(changedFile));
  await assert.rejects(Bench.run(changedInput,changedOutput),/module changed after registration/);
  assert.equal(fs.existsSync(changedOutput+'.lock'),false);
  // Mutation of a returned plan cannot rewrite the internal supported contracts.
  const mutable=Bench.register(path.join(temp,'mutable.json'),'fixed',modules);mutable.positions.length=0;mutable.options.nodeLimits.length=0;
  assert.throws(()=>Bench.validatePlan(mutable),/position inventory/);Bench.validatePlan(plan);
  // Copy only source into temporary repositories: all mutation cases below
  // authenticate JavaScript bytes and never instantiate a WASM engine.
  const runnerSource=fs.readFileSync(path.join(ROOT,'tools/search/qsearch-bench.js'));
  const benchmarkSource=fs.readFileSync(path.join(ROOT,'experiments/wasm/bench.js'));
  function fixture(name,benchmark=benchmarkSource){
    const root=path.join(temp,name),runner=path.join(root,'tools/search/qsearch-bench.js'),benchmarkPath=path.join(root,'experiments/wasm/bench.js');
    fs.mkdirSync(path.dirname(runner),{recursive:true});fs.mkdirSync(path.dirname(benchmarkPath),{recursive:true});
    fs.writeFileSync(runner,runnerSource);fs.writeFileSync(benchmarkPath,benchmark);
    const frozen=path.join(root,'test/fixtures/wasm-r69-signatures.json');
    fs.mkdirSync(path.dirname(frozen),{recursive:true});fs.copyFileSync(path.join(ROOT,'test/fixtures/wasm-r69-signatures.json'),frozen);
    return {runner,benchmarkPath};
  }
  const cached=fixture('cached-benchmark');
  require.cache[cached.benchmarkPath]={exports:{POSITIONS:[]}};
  try{
    const captured=require(cached.runner),registered=captured.register(path.join(temp,'cache-plan.json'),'fixed',modules);
    assert.deepEqual(registered.positions,plan.positions,'require.cache cannot substitute benchmark code');
    assert.equal(registered.dependencies[0].sha256,Cost.sha(runnerSource));
    assert.equal(registered.dependencies[1].sha256,Cost.sha(benchmarkSource));
    assert.equal(registered.dependencies.length,3);
  }finally{delete require.cache[cached.benchmarkPath];delete require.cache[cached.runner];}

  const swapped=fixture('swapped-benchmark');
  const alternate=Buffer.from(benchmarkSource.toString().replace('opening (Ruy Lopez)','replacement corpus'));
  const read=fs.readFileSync;let benchmarkReads=0,retained;
  fs.readFileSync=function(file,...args){
    const bytes=read.call(fs,file,...args);
    if(String(file)===swapped.benchmarkPath){benchmarkReads++;fs.writeFileSync(file,alternate);}
    return bytes;
  };
  try{retained=require(swapped.runner);}finally{fs.readFileSync=read;}
  assert.equal(benchmarkReads,1,'capture reads benchmark source exactly once');
  retained.validatePlan(plan); // Uses captured corpus A although the pathname is B.
  const substituted=clone(plan);substituted.positions[0].name='replacement corpus';
  assert.throws(()=>retained.validatePlan(substituted),/position inventory/);
  const swapOutput=path.join(temp,'swapped-plan.json');
  assert.throws(()=>retained.register(swapOutput,'fixed',modules),/dependency changed before registration/);
  assert.equal(fs.existsSync(swapOutput),false);
  delete require.cache[swapped.runner];

  // Simulate Node receiving runner A, followed immediately by pathname B.
  // The bootstrap must execute captured B and attest B, not cached A code.
  const self=fixture('swapped-runner');let runnerReads=0,selfRunner;
  const newRunner=Buffer.from(runnerSource.toString().replace('quiesce:true,rounds:2','quiesce:true,rounds:3'));
  assert.notDeepEqual(newRunner,runnerSource);
  fs.readFileSync=function(file,...args){
    const bytes=read.call(fs,file,...args);
    if(String(file)===self.runner&&++runnerReads===1)fs.writeFileSync(file,newRunner);
    return bytes;
  };
  try{selfRunner=require(self.runner);}finally{fs.readFileSync=read;}
  assert.equal(runnerReads,2,'runner capture follows Node bootstrap read');
  const selfPlan=selfRunner.register(path.join(temp,'self-plan.json'),'fixed',modules);
  assert.equal(selfPlan.warmup.rounds,3,'executed implementation comes from captured runner B');
  assert.equal(selfPlan.dependencies[0].sha256,Cost.sha(newRunner));
  // A cached exported runner must not attest replacement pathname C.
  fs.writeFileSync(self.runner,Buffer.concat([newRunner,Buffer.from('// replacement C\n')]));
  assert.throws(()=>selfRunner.register(path.join(temp,'cached-self-plan.json'),'fixed',modules),/dependency changed before registration/);
  delete require.cache[self.runner];

  const frozenSwap=fixture('swapped-signature-fixture');
  const frozenPath=path.resolve(path.dirname(frozenSwap.runner),'../../test/fixtures/wasm-r69-signatures.json');
  let frozenReads=0,frozenRunner;
  fs.readFileSync=function(file,...args){
    const bytes=read.call(fs,file,...args);
    if(String(file)===frozenPath){frozenReads++;fs.writeFileSync(file,'not JSON');}
    return bytes;
  };
  try{frozenRunner=require(frozenSwap.runner);}finally{fs.readFileSync=read;}
  frozenRunner.validatePlan(plan); // Eager fixture parse consumes retained valid JSON.
  assert.equal(frozenReads,1,'signature input is captured once, never reopened for parsing');
  assert.throws(()=>frozenRunner.register(path.join(temp,'frozen-swap-plan.json'),'fixed',modules),/dependency changed before registration/);
  delete require.cache[frozenSwap.runner];
  const unauthenticated=fixture('unauthenticated-benchmark',Buffer.from("throw Error('unauthenticated benchmark executed');"));
  const isolated=require(unauthenticated.runner),unauthenticatedOut=path.join(temp,'unauthenticated-out.json');
  await assert.rejects(isolated.run(file,unauthenticatedOut),/dependency changed after registration/);
  assert.equal(fs.existsSync(unauthenticatedOut+'.lock'),false,'authentication precedes benchmark evaluation');
  delete require.cache[unauthenticated.runner];
  const transitive=fixture('transitive-import',Buffer.concat([benchmarkSource,Buffer.from("\nrequire('./untracked');\n")]));
  const closedImports=require(transitive.runner);
  assert.throws(()=>closedImports.register(path.join(temp,'transitive-plan.json'),'fixed',modules),/only built-in modules/);
  delete require.cache[transitive.runner];
  const untracked=fixture('untracked-input',Buffer.concat([benchmarkSource,Buffer.from("\nrequire('fs').readFileSync(__filename,'utf8');\n")]));
  const closedInputs=require(untracked.runner);
  assert.throws(()=>closedInputs.register(path.join(temp,'untracked-plan.json'),'fixed',modules),/uncaptured file read/);
  delete require.cache[untracked.runner];

  // Synthetic adapters exercise failure retention without any WASM execution.
  for(const failure of ['timing','divergence']){
    const source=Buffer.from(`module.exports={
      POSITIONS:${JSON.stringify(plan.positions.map(p=>[p.name,p.fen]))},
      STOP_REASONS:['unknown','max-depth','time-limit','node-limit','mate','game-over'],EXPERIMENT_METRIC_SLOTS:16,
      async loadOrdinaryWasmBytes(bytes,label){return {search(fen,options){return {
        abiVersion:2,move:'a2a3',score:options.repetitions&&label==='module-1'&&'${failure}'==='divergence'?1:0,
        depth:1,attemptedDepth:1,nodes:1,qnodes:0,cutoffs:0,researches:0,stopReason:'max-depth',experimentMetrics:null,
        ms:options.repetitions&&'${failure}'==='timing'?0:1
      };}};}
    };`);
    const failureFixture=fixture('observed-'+failure,source),runner=require(failureFixture.runner);
    const input=path.join(temp,'observed-'+failure+'-plan.json'),output=path.join(temp,'observed-'+failure+'-out.json');
    runner.register(input,'fixed',modules);
    await assert.rejects(runner.run(input,output),failure==='timing'?/invalid timing/:/signature diverged/);
    const observed=JSON.parse(fs.readFileSync(output+'.failure.json'));
    assert.equal(observed.rows.length,failure==='timing'?1:2,'first rejected observation is retained');
    assert.equal(observed.rows.at(-1)[failure==='timing'?'ms':'score'],failure==='timing'?0:1);
    assert.equal(fs.existsSync(output),false,'rejected observations never certify completion');
    delete require.cache[failureFixture.runner];
  }
  const historical=['fixed','master'].map(mode=>JSON.parse(fs.readFileSync(path.join(ROOT,'eval/qsearch-cost-v1',mode+'-results.json'))));
  for(const result of historical){
    Bench.validatePlan(result.registration);
    const expectedCount=result.registration.mode==='fixed'?648:72;
    assert.equal(Bench.expectedRows(result.registration).length,expectedCount);
    assert.equal(Bench.validateRows(result.registration,result.rows),expectedCount);
    for(const [label,mutate] of [
      ['empty rows',rows=>rows.length=0],['missing row',rows=>rows.pop()],['duplicate row',rows=>rows[1]=rows[0]],
      ['reordered rows',rows=>rows.reverse()],['sparse row',rows=>delete rows[0]],
      ['wrong position',rows=>rows[0].position=999],['wrong engine',rows=>rows[0].engine=999],
      ['wrong repetition',rows=>rows[0].repetition=999],['wrong budget',rows=>rows[0].nodeLimit=999],
      ['wrong name',rows=>rows[0].name='invented'],['missing score',rows=>delete rows[0].score],
      ['zero elapsed',rows=>rows[0].ms=0],['zero nodes',rows=>rows[0].nodes=0],['infinite elapsed',rows=>rows[0].ms=Infinity]
    ]){const rows=clone(result.rows);mutate(rows);assert.throws(()=>Bench.validateRows(result.registration,rows),undefined,label);}
  }
  const divergent=clone(historical[0].rows);divergent[1].score++;
  assert.throws(()=>Bench.validateRows(historical[0].registration,divergent),/signatures differ/);
  console.log('qsearch source capture/cache mutation, strict registration, 720 historical rows and negative completion cases: passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
