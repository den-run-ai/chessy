#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Bench=require('../../experiments/wasm/bench');
const {sha}=require('./qsearch-cost');
const ROOT=path.resolve(__dirname,'../..');
const check=(v,m)=>{if(!v)throw Error(m);};
const encode=x=>JSON.stringify(x,null,2)+'\n';
const dependencies=()=>[__filename,path.join(ROOT,'experiments/wasm/bench.js')].map(p=>({path:path.relative(ROOT,p),sha256:sha(fs.readFileSync(p))}));
const fixedFields=['abiVersion','move','score','depth','attemptedDepth','nodes','qnodes','cutoffs','researches','stopReason'];
function register(file,mode,modules){
  check(['fixed','master'].includes(mode),'unknown mode');
  check(modules.length>=2&&modules.length<=3,'two or three modules required; reference first');
  const plan={schema:'chessy.qsearch-cost.benchmark.v1',mode,created:new Date().toISOString(),researchOnly:true,
    productionIntegrationAllowed:false,strengthClaimAllowed:false,selectionAllowed:mode==='fixed',
    positions:Bench.POSITIONS.map(([name,fen])=>({name,fen})),
    options:mode==='fixed'?{maxDepth:111,nodeLimits:[10000,36000,230000],timeMs:0,quiesce:true,repetitions:4}
      :{maxDepth:30,nodeLimits:[0],timeMs:5000,quiesce:true,repetitions:2},
    warmup:{nodeLimit:10000,maxDepth:111,timeMs:0,quiesce:true,rounds:2},
    order:'rotate engine order by (position index + repetition) modulo engine count',
    modules:modules.map(p=>({path:fs.realpathSync(p),sha256:sha(fs.readFileSync(p))})),dependencies:dependencies()};
  fs.writeFileSync(file,encode(plan),{flag:'wx'});return plan;
}
async function run(file,out){
  const planBytes=fs.readFileSync(file),plan=JSON.parse(planBytes);
  check(plan.schema==='chessy.qsearch-cost.benchmark.v1'&&plan.researchOnly===true&&plan.productionIntegrationAllowed===false&&plan.strengthClaimAllowed===false,'invalid plan');
  check(JSON.stringify(plan.dependencies)===JSON.stringify(dependencies()),'benchmark dependency changed after registration');
  const lock=fs.openSync(out+'.lock','wx');let rows=[];
  try{
    const engines=[];
    for(let i=0;i<plan.modules.length;i++){
      const m=plan.modules[i],bytes=fs.readFileSync(m.path);check(sha(bytes)===m.sha256,'module changed after registration');
      engines.push(await Bench.loadOrdinaryWasmBytes(bytes,'module-'+i,m.path));
    }
    for(let r=0;r<plan.warmup.rounds;r++)for(const e of engines)for(const p of plan.positions)e.search(p.fen,plan.warmup);
    for(const limit of plan.options.nodeLimits){for(let pi=0;pi<plan.positions.length;pi++){
      const p=plan.positions[pi];let expected=null;
      for(let rep=0;rep<plan.options.repetitions;rep++){
        for(let offset=0;offset<engines.length;offset++){
          const ei=(pi+rep+offset)%engines.length;
          const result=engines[ei].search(p.fen,{...plan.options,nodeLimit:limit});
          if(plan.mode==='fixed'){
            const signature=fixedFields.map(f=>result[f]);
            if(expected===null)expected=signature;else check(JSON.stringify(signature)===JSON.stringify(expected),'fixed-node signature diverged '+p.name+' '+limit+' module '+ei);
          }
          check(result.ms>0&&Number.isFinite(result.ms),'invalid timing');
          rows.push({position:pi,name:p.name,engine:ei,repetition:rep,nodeLimit:limit,...result});
        }
      }
      process.stdout.write(JSON.stringify({position:pi,nodeLimit:limit,completeRows:rows.length})+'\n');
    }}
    check(sha(fs.readFileSync(file))===sha(planBytes),'registration changed while running');
    check(JSON.stringify(plan.dependencies)===JSON.stringify(dependencies()),'benchmark dependency changed while running');
    const report={schema:'chessy.qsearch-cost.benchmark-results.v1',registrationSha256:sha(planBytes),registration:plan,
      runtime:{node:process.version,versions:process.versions,platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model},
      modules:engines.map(e=>({bytes:e.binaryBytes,brotliBytes:e.brotliBytes,memoryBytes:e.memoryBytes()})),
      complete:true,exactFixedNodeParity:plan.mode==='fixed',rows};
    fs.writeFileSync(out,encode(report),{flag:'wx'});return report;
  }catch(error){fs.writeFileSync(out+'.failure.json',encode({error:String(error),rows}),{flag:'wx'});throw error;}
  finally{fs.closeSync(lock);}
}
if(require.main===module){
  const [command,...args]=process.argv.slice(2);
  Promise.resolve().then(()=>{
    if(command==='register'){check(args.length>=4,'register PLAN MODE REFERENCE CANDIDATE [CANDIDATE2]');return register(args[0],args[1],args.slice(2));}
    check(command==='run'&&args.length===2,'run PLAN RESULTS');return run(...args);
  }).then(x=>console.log(encode({complete:true,rows:x.rows?x.rows.length:0}))).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={register,run};
