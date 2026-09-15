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
if(typeof __hashCaptured==='undefined'){
  const captured=[__filename,path.join(ROOT,'experiments/wasm/bench.js'),
    path.join(ROOT,'test/fixtures/wasm-r69-signatures.json')]
    .map(file=>({path:file,bytes:Buffer.from(fs.readFileSync(file))}));
  const compiled=vm.compileFunction(captured[0].bytes.toString('utf8').replace(/^#![^\n]*/,''),
    ['require','module','exports','__filename','__dirname','__hashCaptured'],{filename:__filename});
  compiled(require,module,module.exports,__filename,__dirname,captured);
}else{
const captured=__hashCaptured;
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
const runtime=()=>({node:process.version,versions:process.versions,platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model});
const options=mode=>mode==='fixed'?{maxDepth:111,nodeLimits:[10000,36000,230000],timeMs:0,quiesce:true,repetitions:4}
  :{maxDepth:30,nodeLimits:[0],timeMs:5000,quiesce:true,repetitions:2};
const positions=()=>getBench().POSITIONS.map(([name,fen],i)=>({name,fen,phase:i<2?'opening':i>=8&&i<16?'endgame':'middlegame'}));
const warmup={nodeLimit:10000,maxDepth:111,timeMs:0,quiesce:true,rounds:2};
const fixedFields=['abiVersion','move','score','depth','attemptedDepth','nodes','qnodes','cutoffs','researches','stopReason'];
const order='rotate engine order by (position index + repetition) modulo engine count';
// Shared across worktrees/copies for this host/account; there is no runtime override.
const LEDGER_ROOT=path.join(fs.realpathSync(os.homedir()),'.local/state/chessy-research/den-run-ai/chessy');
// Exact completed fixed/Master recipes derived from the historical registrations.
const completedRecipes=new Set(['040a44f3a977e90df26aecc8df02b1d87c9b9df289c0b945ef9dafa85b7fc752',
  '3b031d49302e6aa723cca7ca83cf3ef7199cf24e2d497ffa0880a90f9db57670']);
function experimentIdentity(plan){
  return sha(JSON.stringify({protocol:'chessy.searched-board-hash.one-shot.v1',mode:plan.mode,
    modules:plan.modules.map(m=>m.sha256).sort(),positions:plan.positions.map(p=>p.fen),options:plan.options,warmup:plan.warmup,order}));
}
function ledgerPath(plan){return path.join(LEDGER_ROOT,experimentIdentity(plan)+'.started.json');}
function requireUnspent(plan){
  check(!completedRecipes.has(experimentIdentity(plan)),'historical hash comparison is completed and retired');
  check(!fs.existsSync(ledgerPath(plan)),'registered experiment has already started; no retry or rerun');
}
function reserve(plan,registrationSha256){
  requireUnspent(plan);fs.mkdirSync(LEDGER_ROOT,{recursive:true,mode:0o700});
  const file=ledgerPath(plan),entry={schema:'chessy.research-started.v1',experimentIdentity:plan.experimentIdentity,
    registrationSha256,started:new Date().toISOString(),pid:process.pid},bytes=Buffer.from(encode(entry));
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(LEDGER_ROOT,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  return {path:file,bytes,entry};
}

function validateModules(modules){
  check(Array.isArray(modules)&&modules.length===2,'exactly two distinct module identities required');
  const paths=new Set(),hashes=new Set();
  for(const m of modules){
    check(m&&typeof m.path==='string'&&path.isAbsolute(m.path)&&path.normalize(m.path)===m.path
      &&typeof m.sha256==='string'&&/^[a-f0-9]{64}$/.test(m.sha256),'invalid canonical module identity');
    check(!paths.has(m.path)&&!hashes.has(m.sha256),'two distinct module identities required');
    paths.add(m.path);hashes.add(m.sha256);
  }
}
function register(file,mode,modules){
  check(['fixed','master'].includes(mode),'unknown mode');
  check(Array.isArray(modules)&&modules.length===2,'exactly one reference and one frozen candidate required');
  const identities=modules.map(p=>({path:fs.realpathSync(p),sha256:sha(fs.readFileSync(p))}));
  validateModules(identities);
  const plan={schema:'chessy.searched-board-hash.benchmark.v2',mode,created:new Date().toISOString(),researchOnly:true,
    productionIntegrationAllowed:false,strengthClaimAllowed:false,selectionAllowed:mode==='fixed',
    positions:positions(),options:options(mode),warmup:{...warmup},runtime:runtime(),
    order,
    sourceReceipt:(()=>{const p=fs.realpathSync(path.join(path.dirname(modules[1]),'../source.json'));return {path:p,sha256:sha(fs.readFileSync(p))};})(),
    modules:identities,dependencies:dependencies()};
  plan.experimentIdentity=experimentIdentity(plan);requireUnspent(plan);
  check(sourcesUnchanged(),'benchmark dependency changed before registration');
  fs.writeFileSync(file,encode(plan),{flag:'wx'});return plan;
}
async function run(file,out){
  const planBytes=fs.readFileSync(file),plan=JSON.parse(planBytes);
  check(plan&&plan.schema==='chessy.searched-board-hash.benchmark.v2'&&JSON.stringify(plan.dependencies)===JSON.stringify(dependencies()),'benchmark dependency changed after registration');
  validateModules(plan.modules);
  check(plan.schema==='chessy.searched-board-hash.benchmark.v2'&&plan.researchOnly===true&&plan.productionIntegrationAllowed===false&&plan.strengthClaimAllowed===false,'invalid plan');
  check(['fixed','master'].includes(plan.mode)&&plan.modules.length===2,'invalid mode/modules');
  check(JSON.stringify(plan.options)===JSON.stringify(options(plan.mode))&&JSON.stringify(plan.positions)===JSON.stringify(positions())&&JSON.stringify(plan.warmup)===JSON.stringify(warmup),'registered budget or positions changed');
  check(plan.order===order&&plan.selectionAllowed===(plan.mode==='fixed'),'invalid order or selection contract');
  check(plan.experimentIdentity===experimentIdentity(plan),'experiment identity changed after registration');
  check(JSON.stringify(plan.runtime)===JSON.stringify(runtime()),'runtime changed after registration');
  check(sha(fs.readFileSync(plan.sourceReceipt.path))===plan.sourceReceipt.sha256,'generated source receipt changed');
  const Bench=getBench(),retained=plan.modules.map(m=>{
    check(fs.realpathSync(m.path)===m.path,'module path changed after registration');
    const bytes=fs.readFileSync(m.path);check(sha(bytes)===m.sha256,'module changed after registration');return bytes;
  });
  const attempt=reserve(plan,sha(planBytes));let lock,rows=[];
  try{
    lock=fs.openSync(out+'.lock','wx');
    const engines=[];
    for(let i=0;i<plan.modules.length;i++){
      const m=plan.modules[i],bytes=retained[i];
      engines.push(await Bench.loadOrdinaryWasmBytes(bytes,'module-'+i,m.path));
    }
    for(let r=0;r<plan.warmup.rounds;r++)for(const e of engines)for(const p of plan.positions)e.search(p.fen,plan.warmup);
    for(const limit of plan.options.nodeLimits){for(let pi=0;pi<plan.positions.length;pi++){
      const p=plan.positions[pi];let expected=null;
      for(let rep=0;rep<plan.options.repetitions;rep++){
        for(let offset=0;offset<engines.length;offset++){
          const ei=(pi+rep+offset)%engines.length;
          const result=engines[ei].search(p.fen,{...plan.options,nodeLimit:limit});
          rows.push({position:pi,name:p.name,phase:p.phase,engine:ei,repetition:rep,nodeLimit:limit,...result});
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
    check(rows.length===plan.positions.length*plan.options.nodeLimits.length*plan.options.repetitions*engines.length,'incomplete observation inventory');
    check(sourcesUnchanged(),'benchmark dependency changed while running');
    check(sha(fs.readFileSync(attempt.path))===sha(attempt.bytes),'experiment reservation changed while running');
    check(sha(fs.readFileSync(plan.sourceReceipt.path))===plan.sourceReceipt.sha256,'generated source receipt changed while running');
    const report={schema:'chessy.searched-board-hash.benchmark-results.v2',attempt:attempt.entry,ledgerPath:attempt.path,registrationSha256:sha(planBytes),registration:plan,
      runtime:runtime(),
      modules:engines.map(e=>({bytes:e.binaryBytes,brotliBytes:e.brotliBytes,memoryBytes:e.memoryBytes()})),
      complete:true,exactFixedNodeParity:plan.mode==='fixed',rows};
    fs.writeFileSync(out,encode(report),{flag:'wx'});return report;
  }catch(error){fs.writeFileSync(out+'.failure.json',encode({error:String(error),attempt:attempt.entry,ledgerPath:attempt.path,rows}),{flag:'wx'});throw error;}
  finally{if(lock!==undefined)fs.closeSync(lock);}
}
if(require.main===module){
  const [command,...args]=process.argv.slice(2);
  Promise.resolve().then(()=>{
    if(command==='register'){check(args.length===4,'register PLAN MODE REFERENCE CANDIDATE');return register(args[0],args[1],args.slice(2));}
    check(command==='run'&&args.length===2,'run PLAN RESULTS');return run(...args);
  }).then(x=>console.log(encode(x.rows?{complete:true,rows:x.rows.length}:{registered:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={register,run,positions,experimentIdentity,assertUnspent:requireUnspent};
}
