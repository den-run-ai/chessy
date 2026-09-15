#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const vm=require('node:vm'),{isBuiltin}=require('node:module');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ROOT=path.resolve(__dirname,'../..');
const check=(v,m)=>{if(!v)throw Error(m);};
const encode=x=>JSON.stringify(x,null,2)+'\n';
// This built-in-only bootstrap executes the same retained runner bytes that
// are hashed below. No repository module is loaded through require/cache.
if(typeof __qsearchCaptured==='undefined'){
  const captured=[__filename,path.join(ROOT,'experiments/wasm/bench.js'),
    path.join(ROOT,'test/fixtures/wasm-r69-signatures.json')]
    .map(file=>({path:file,bytes:Buffer.from(fs.readFileSync(file))}));
  const compiled=vm.compileFunction(captured[0].bytes.toString('utf8').replace(/^#![^\n]*/,''),
    ['require','module','exports','__filename','__dirname','__qsearchCaptured'],{filename:__filename});
  compiled(require,module,module.exports,__filename,__dirname,captured);
}else{
const captured=__qsearchCaptured;
const dependencies=()=>captured.map(x=>({path:path.relative(ROOT,x.path),sha256:sha(x.bytes)}));
const sourcesUnchanged=()=>captured.every(x=>sha(fs.readFileSync(x.path))===sha(x.bytes));
let bench;
function getBench(){
  if(bench)return bench;
  const source=captured[1],loaded={exports:{}};
  const builtinRequire=id=>{
    check(isBuiltin(id),'benchmark may import only built-in modules');
    const name=id.replace(/^node:/,'');
    if(name==='fs')return Object.freeze({readFileSync(file,encoding){
      check(file===captured[2].path&&encoding==='utf8','benchmark attempted an uncaptured file read');
      return captured[2].bytes.toString('utf8');
    }});
    return require('node:'+name);
  };
  vm.compileFunction(source.bytes.toString('utf8'),
    ['require','module','exports','__filename','__dirname'],{filename:source.path})
    (builtinRequire,loaded,loaded.exports,source.path,path.dirname(source.path));
  bench=loaded.exports;return bench;
}
const fixedFields=['abiVersion','move','score','depth','attemptedDepth','nodes','qnodes','cutoffs','researches','stopReason'];
const positions=()=>getBench().POSITIONS.map(([name,fen])=>({name,fen}));
const WARMUP_CONTRACT={nodeLimit:10000,maxDepth:111,timeMs:0,quiesce:true,rounds:2};
const ORDER_CONTRACT='rotate engine order by (position index + repetition) modulo engine count';
// Shared across worktrees/copies on this host/account. No runtime override.
const LEDGER_ROOT=path.join(fs.realpathSync(os.homedir()),'.local/state/chessy-research/den-run-ai/chessy');
const PROTOCOL='chessy.qsearch-cost.development';
// Exact completed recipes, generated from the unchanged historical registrations.
const RETIRED=new Set(['6eeeabd09ee5d7defc38e3282e8c2a8c691b94b63e551cb53c86cddba90e1f83',
  'eaafe111b0a172d0eb106112fd270c98e294d405fddcb73f760bac61be9c6a44']);
function experimentId(plan){
  return sha(encode({protocol:PROTOCOL,mode:plan.mode,modules:plan.modules.map(m=>m.sha256).sort(),positions:plan.positions.map(p=>p.fen),
    options:plan.options,warmup:plan.warmup,order:plan.order}));
}
function ledgerPath(plan){return path.join(LEDGER_ROOT,experimentId(plan)+'.started.json');}
function checkUnused(plan){
  check(!RETIRED.has(experimentId(plan)),'historical experiment is retired; audit only');
  check(!fs.existsSync(ledgerPath(plan)),'experiment already reserved; reruns are forbidden');
}
function reserve(plan,planBytes,out){
  checkUnused(plan);fs.mkdirSync(LEDGER_ROOT,{recursive:true,mode:0o700});
  const ledger=ledgerPath(plan),entry={schema:'chessy.qsearch-cost.attempt.v1',protocol:PROTOCOL,
    experimentId:experimentId(plan),registrationSha256:sha(planBytes),output:out,
    started:new Date().toISOString(),rerunAllowed:false};
  const bytes=Buffer.from(encode(entry)),fd=fs.openSync(ledger,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const parent=fs.openSync(LEDGER_ROOT,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  return {path:ledger,bytes,entry}; // Never remove this reservation, including failures.
}

const MODE_CONTRACTS={
  fixed:{modules:3,options:{maxDepth:111,nodeLimits:[10000,36000,230000],timeMs:0,quiesce:true,repetitions:4}},
  master:{modules:2,options:{maxDepth:30,nodeLimits:[0],timeMs:5000,quiesce:true,repetitions:2}}
};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(value,expected,label)=>check(value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&equal(Object.keys(value).sort(),expected.slice().sort()),'invalid '+label+' fields');
function validatePlan(plan){
  keys(plan,['schema','mode','created','researchOnly','productionIntegrationAllowed','strengthClaimAllowed',
    'selectionAllowed','positions','options','warmup','order','modules','dependencies',
    ...(plan&&plan.schema==='chessy.qsearch-cost.benchmark.v3'?['experimentId']:[])],'plan');
  check(['chessy.qsearch-cost.benchmark.v1','chessy.qsearch-cost.benchmark.v2','chessy.qsearch-cost.benchmark.v3'].includes(plan.schema)&&plan.researchOnly===true
    &&plan.productionIntegrationAllowed===false&&plan.strengthClaimAllowed===false,'invalid plan');
  check(typeof plan.mode==='string'&&Object.hasOwn(MODE_CONTRACTS,plan.mode),'unknown mode');
  const contract=MODE_CONTRACTS[plan.mode];
  check(typeof plan.created==='string'&&Number.isFinite(Date.parse(plan.created))
    &&new Date(plan.created).toISOString()===plan.created,'invalid registration timestamp');
  check(plan.selectionAllowed===(plan.mode==='fixed'),'invalid selection policy');
  check(equal(plan.positions,positions()),'position inventory differs from supported corpus');
  check(equal(plan.options,contract.options),'mode-specific options differ');
  check(equal(plan.warmup,WARMUP_CONTRACT),'warmup differs');
  check(plan.order===ORDER_CONTRACT,'engine order differs');
  check(Array.isArray(plan.modules)&&plan.modules.length===contract.modules,'mode-specific module inventory differs');
  const paths=new Set(),hashes=new Set();
  for(const module of plan.modules){
    keys(module,['path','sha256'],'module');
    check(typeof module.path==='string'&&path.isAbsolute(module.path)&&path.normalize(module.path)===module.path,'invalid module path');
    check(typeof module.sha256==='string'&&/^[a-f0-9]{64}$/.test(module.sha256),'invalid module identity');
    check(!paths.has(module.path)&&!hashes.has(module.sha256),'duplicate module identity');
    paths.add(module.path);hashes.add(module.sha256);
  }
  const expectedDependencies=['tools/search/qsearch-bench.js','experiments/wasm/bench.js'];
  if(plan.schema!=='chessy.qsearch-cost.benchmark.v1')expectedDependencies.push('test/fixtures/wasm-r69-signatures.json');
  check(Array.isArray(plan.dependencies)&&plan.dependencies.length===expectedDependencies.length,'dependency inventory differs');
  for(let i=0;i<expectedDependencies.length;i++){
    const dep=plan.dependencies[i];keys(dep,['path','sha256'],'dependency');
    check(dep.path===expectedDependencies[i]&&typeof dep.sha256==='string'&&/^[a-f0-9]{64}$/.test(dep.sha256),'invalid dependency identity');
  }
  if(plan.schema==='chessy.qsearch-cost.benchmark.v3')check(plan.experimentId===experimentId(plan),'scientific experiment identity differs');
  return true;
}
function expectedRows(plan){
  validatePlan(plan);const rows=[];
  for(const nodeLimit of plan.options.nodeLimits)for(let position=0;position<plan.positions.length;position++)
    for(let repetition=0;repetition<plan.options.repetitions;repetition++)for(let offset=0;offset<plan.modules.length;offset++)
      rows.push({position,name:plan.positions[position].name,engine:(position+repetition+offset)%plan.modules.length,repetition,nodeLimit});
  return rows;
}
function validateRows(plan,rows){
  const Bench=getBench(),expected=expectedRows(plan);
  check(Array.isArray(rows)&&rows.length===expected.length&&rows.length>0,'complete row inventory differs');
  const signatures=new Map();
  for(let i=0;i<expected.length;i++){
    const row=rows[i];keys(row,[...Object.keys(expected[i]),...fixedFields,'experimentMetrics','ms'],'result row');
    check(Object.keys(expected[i]).every(k=>row[k]===expected[i][k]),'row identity/order differs at '+i);
    check(row.ms>0&&Number.isFinite(row.ms),'invalid row timing');
    check([1,2].includes(row.abiVersion)&&typeof row.move==='string'&&/^[a-h][1-8][a-h][1-8][QRBN]?$/.test(row.move),'invalid row ABI/move');
    for(const key of ['score','depth','nodes','qnodes','cutoffs','researches'])
      check(Number.isSafeInteger(row[key])&&(key==='score'||row[key]>=0),'invalid row '+key);
    check(row.nodes>0&&row.qnodes<=row.nodes&&row.depth<=plan.options.maxDepth,'invalid row counters');
    check(row.nodeLimit===0||row.nodes<=row.nodeLimit,'row exceeded node budget');
    check(row.attemptedDepth===null||Number.isSafeInteger(row.attemptedDepth)&&row.attemptedDepth>=0
      &&row.attemptedDepth<=plan.options.maxDepth,'invalid attempted depth');
    check(Bench.STOP_REASONS.includes(row.stopReason)&&row.stopReason!=='unknown','invalid stop reason');
    check(row.experimentMetrics===null||Array.isArray(row.experimentMetrics)&&row.experimentMetrics.length===Bench.EXPERIMENT_METRIC_SLOTS
      &&Array.from(row.experimentMetrics).every(v=>Number.isSafeInteger(v)&&v>=0),'invalid experiment metrics');
    if(plan.mode==='fixed'){
      const key=row.position+':'+row.nodeLimit,signature=fixedFields.map(f=>row[f]);
      if(signatures.has(key))check(equal(signature,signatures.get(key)),'fixed-node row signatures differ');
      else signatures.set(key,signature);
    }
  }
  return rows.length;
}
function register(file,mode,modules){
  check(typeof mode==='string'&&Object.hasOwn(MODE_CONTRACTS,mode),'unknown mode');
  check(Array.isArray(modules)&&modules.length===MODE_CONTRACTS[mode].modules,'mode-specific module inventory differs');
  const plan={schema:'chessy.qsearch-cost.benchmark.v3',mode,created:new Date().toISOString(),researchOnly:true,
    productionIntegrationAllowed:false,strengthClaimAllowed:false,selectionAllowed:mode==='fixed',
    positions:positions(),
    options:{...MODE_CONTRACTS[mode].options,nodeLimits:[...MODE_CONTRACTS[mode].options.nodeLimits]},
    warmup:{...WARMUP_CONTRACT},order:ORDER_CONTRACT,
    modules:modules.map(p=>({path:fs.realpathSync(p),sha256:sha(fs.readFileSync(p))})),dependencies:dependencies()};
  plan.experimentId=experimentId(plan);validatePlan(plan);checkUnused(plan);check(sourcesUnchanged(),'benchmark dependency changed before registration');
  fs.writeFileSync(file,encode(plan),{flag:'wx'});return plan;
}
async function run(file,out){
  const planBytes=fs.readFileSync(file),plan=JSON.parse(planBytes);
  check(plan&&plan.schema==='chessy.qsearch-cost.benchmark.v3'&&equal(plan.dependencies,dependencies()),'benchmark dependency changed after registration');
  validatePlan(plan);const Bench=getBench();
  // Authenticate the complete inventory before any engine is loaded; execute
  // these retained module bytes instead of reopening mutable paths.
  const retained=plan.modules.map(m=>{
    check(fs.realpathSync(m.path)===m.path,'module path changed after registration');
    const bytes=fs.readFileSync(m.path);check(sha(bytes)===m.sha256,'module changed after registration');return bytes;
  });
  out=path.join(fs.realpathSync(path.dirname(path.resolve(out))),path.basename(out));
  const attempt=reserve(plan,planBytes,out);let lock,rows=[];
  try{
    lock=fs.openSync(out+'.lock','wx');
    const engines=[];
    for(let i=0;i<plan.modules.length;i++){
      const m=plan.modules[i];engines.push(await Bench.loadOrdinaryWasmBytes(retained[i],'module-'+i,m.path));
    }
    for(let r=0;r<plan.warmup.rounds;r++)for(const e of engines)for(const p of plan.positions)e.search(p.fen,plan.warmup);
    for(const limit of plan.options.nodeLimits){for(let pi=0;pi<plan.positions.length;pi++){
      const p=plan.positions[pi];let expected=null;
      for(let rep=0;rep<plan.options.repetitions;rep++){
        for(let offset=0;offset<engines.length;offset++){
          const ei=(pi+rep+offset)%engines.length;
          const result=engines[ei].search(p.fen,{...plan.options,nodeLimit:limit});
          // Retain the observed failure too, before any result validation.
          rows.push({position:pi,name:p.name,engine:ei,repetition:rep,nodeLimit:limit,...result});
          if(plan.mode==='fixed'){
            const signature=fixedFields.map(f=>result[f]);
            if(expected===null)expected=signature;else check(JSON.stringify(signature)===JSON.stringify(expected),'fixed-node signature diverged '+p.name+' '+limit+' module '+ei);
          }
          check(result.ms>0&&Number.isFinite(result.ms),'invalid timing');
        }
      }
      process.stdout.write(JSON.stringify({position:pi,nodeLimit:limit,completeRows:rows.length})+'\n');
    }}
    check(sha(fs.readFileSync(file))===sha(planBytes),'registration changed while running');
    check(sourcesUnchanged(),'benchmark dependency changed while running');
    check(sha(fs.readFileSync(attempt.path))===sha(attempt.bytes),'experiment reservation changed while running');
    check(engines.length===plan.modules.length,'executed module inventory differs');
    validateRows(plan,rows);
    const report={schema:'chessy.qsearch-cost.benchmark-results.v3',attempt:attempt.entry,ledgerPath:attempt.path,registrationSha256:sha(planBytes),registration:plan,
      runtime:{node:process.version,versions:process.versions,platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model},
      modules:engines.map(e=>({bytes:e.binaryBytes,brotliBytes:e.brotliBytes,memoryBytes:e.memoryBytes()})),
      complete:true,exactFixedNodeParity:plan.mode==='fixed',rows};
    fs.writeFileSync(out,encode(report),{flag:'wx'});return report;
  }catch(error){fs.writeFileSync(out+'.failure.json',encode({error:String(error),attempt:attempt.entry,ledgerPath:attempt.path,rows}),{flag:'wx'});throw error;}
  finally{if(lock!==undefined)fs.closeSync(lock);}
}
if(require.main===module){
  const [command,...args]=process.argv.slice(2);
  Promise.resolve().then(()=>{
    if(command==='register'){check(args.length>=4,'register PLAN MODE REFERENCE CANDIDATE [CANDIDATE2]');return register(args[0],args[1],args.slice(2));}
    check(command==='run'&&args.length===2,'run PLAN RESULTS');return run(...args);
  }).then(x=>console.log(encode(x.rows?{complete:true,rows:x.rows.length}:{registered:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={register,run,validatePlan,expectedRows,validateRows,experimentId,assertUnspent:checkUnused};
}
