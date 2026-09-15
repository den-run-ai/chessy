#!/usr/bin/env node
'use strict';
// Prospective implementation-only extension. All chess/search/score mechanics
// are reused from the immutable400-game runner; no prior outcome is inspected.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const H=require('./hybrid-match-v1'),N=require('./natural-runtime-run');
const ROOT=path.resolve(__dirname,'../..'),CHILD=path.join(__dirname,'hybrid-match-v1.js');
const CONTRACT=path.join(ROOT,'eval/training/hybrid-match-optimized-v1.json');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b,label)=>check(N.stable(a)===N.stable(b),label+' differs');
const read=file=>JSON.parse(fs.readFileSync(file));
function identity(file){const bytes=fs.readFileSync(file);return {path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length};}
function verify(info){const snap=N.snapshot(info.path,info.sha256);check(snap.bytes.length===info.bytes,'bound byte size differs');return snap;}
function write(file,value){fs.writeFileSync(file,N.stable(value)+'\n',{flag:'wx'});return identity(file);}
function median(values){const a=values.slice().sort((x,y)=>x-y);check(a.length>0,'empty sample');return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;}
function decision(report,protocol){
  check(report.schema==='chessy.hybrid-runtime-mechanism-cost.v1'&&report.status==='completed'&&report.researchOnly===true,
    'complete same-score mechanism report required');
  check(report.parityMismatches===0&&report.parity.length===protocol.trigger.requiredExactCompiledParityCases&&
    new Set(report.parity.map(r=>r.fen)).size===report.parity.length,'complete unique compiled parity inventory required');
  check(report.exactNodeBudgetSearchSignatures===true&&report.searchSignatureMismatches.length===0,'exact fixed-node signatures required');
  const records=report.records,variants={};check(records.length===768,'complete mechanism cost inventory required');
  // Check every original/optimized fixed-node cell ourselves, not its summary.
  for(const variant of protocol.trigger.variants){
    for(const row of report.parity)check(row[variant]===row.wanted,'compiled evaluator parity differs');
    const ratios=[],times=[],byPhase={opening:[],middlegame:[],endgame:[]};
    for(const budget of protocol.trigger.requiredExactFixedNodeSignatureBudgets)for(let position=0;position<12;position++)for(let repetition=0;repetition<4;repetition++){
      const select=name=>records.filter(r=>r.variant===name&&r.kind==='nodes'&&r.budget===budget&&r.position===position&&r.repetition===repetition);
      const own=select(variant),original=select('original');check(own.length===1&&original.length===1,'missing/duplicate fixed-node cell');
      const row=own[0],base=original[0];same(row.result,base.result,'complete fixed-node search signature');
      check(row.stage===base.stage&&Object.hasOwn(byPhase,row.stage),'phase stratum differs');
      check(Number.isFinite(row.elapsedMs)&&row.elapsedMs>0&&Number.isFinite(base.elapsedMs)&&base.elapsedMs>0&&row.result.nodes>0,'invalid runtime measurements');
      if(budget===16384){const ratio=(row.result.nodes/row.elapsedMs)/(base.result.nodes/base.elapsedMs);ratios.push(ratio);times.push(row.elapsedMs);byPhase[row.stage].push(ratio);}
    }
    check(ratios.length===48&&Object.values(byPhase).every(rows=>rows.length===16),'complete balanced16384-node grid required');
    const ratio=median(ratios),phaseRatios=Object.fromEntries(Object.entries(byPhase).map(([phase,values])=>[phase,median(values)]));
    variants[variant]={medianPairedNpsRatio:ratio,phaseMedianPairedNpsRatios:phaseRatios,medianElapsedMs:median(times),
      eligible:ratio>=protocol.trigger.minimumMedianPairedNpsRatioVersusOriginalAt16384&&
        Object.values(phaseRatios).every(value=>value>=protocol.trigger.minimumPhaseMedianPairedNpsRatioVersusOriginalAt16384)};
  }
  const eligible=protocol.trigger.variants.filter(name=>variants[name].eligible);
  eligible.sort((a,b)=>variants[a].medianElapsedMs-variants[b].medianElapsedMs||protocol.trigger.variants.indexOf(a)-protocol.trigger.variants.indexOf(b));
  return {variants,selected:eligible[0]||null,gameOutcomesUsed:false};
}
function tasks(openings,protocol){return H.makeTasks(openings,protocol).filter(t=>t.arm==='hybrid');}
function register(a){
  const protocol=read(CONTRACT),original=H.preflight(a['original-registration'],a['original-registration-sha256']);
  const originalRegistration=identity(a['original-registration']),runtimeSnapshot=H.receipt(a['mechanism-report']),source=identity(a['mechanism-source']);
  check(originalRegistration.sha256===a['original-registration-sha256'],'original registration changed');
  const runtime=runtimeSnapshot.info,report=runtimeSnapshot.value,picked=decision(report,protocol);
  check(report.sourceReceiptSha256===source.sha256,'mechanism source receipt differs');
  const originalRuntime=JSON.parse(verify(original.runtime).bytes);
  check(report.priorSourceReceiptSha256===originalRuntime.sourceReceiptSha256&&report.modelSha256===originalRuntime.modelSha256&&
    report.expandedWeightsSha256===originalRuntime.expandedWeightsSha256,'frozen evaluator ancestry differs');
  same(report.config,originalRuntime.config,'frozen model gate');
  check(report.modules.original.sha256===original.modules.hybrid.sha256&&report.modules.shipped.sha256===original.modules.shipped.sha256,'original module identity differs');
  if(!picked.selected)return write(a.output,{schema:'chessy.hybrid-optimized-development-match-skipped.v1',researchOnly:true,formalPass:false,
    protocol,decision:picked,runtime,source,originalRegistration,reason:'No implementation passes the prospective exact-score/speed trigger.'});
  const selected=identity(a[picked.selected]);check(report.modules[picked.selected].sha256===selected.sha256,'selected optimized module differs');
  const modules={shipped:original.modules.shipped,hybrid:selected,expanded:original.modules.shipped};
  const r={schema:'chessy.hybrid-optimized-development-match-registration.v1',createdAtUtc:new Date().toISOString(),researchOnly:true,formalPass:false,
    shippingOrEloClaimAllowed:false,candidateAdvancementAllowed:false,protocol,decision:picked,modules,openings:original.openings,tasks:tasks(original.openings,protocol),
    runtime,source,originalRegistration,originalRegistrationSha256:a['original-registration-sha256'],offlineTestEligible:original.offlineTestEligible,
    implementation:[...original.implementation,identity(__filename),identity(CONTRACT)],environment:original.environment,
    noRerunLedger:path.join(path.dirname(original.offline.path),'.hybrid-match-optimized-v1.started.json')};
  check(r.tasks.length===200,'complete200game schedule required');return write(a.output,r);
}
function preflight(file,digest){
  const r=JSON.parse(N.snapshot(file,digest).bytes);check(r.schema==='chessy.hybrid-optimized-development-match-registration.v1'&&r.researchOnly===true&&r.formalPass===false&&
    r.shippingOrEloClaimAllowed===false,'research extension registration required');same(r.protocol,read(CONTRACT),'prospective protocol');
  const original=H.preflight(r.originalRegistration.path,r.originalRegistrationSha256);
  check(r.originalRegistration.sha256===r.originalRegistrationSha256,'original registration identity differs');
  check(r.noRerunLedger===path.join(path.dirname(original.offline.path),'.hybrid-match-optimized-v1.started.json'),'canonical one-shot extension ledger differs');
  same(r.implementation.map(info=>info.path),[...original.implementation.map(info=>info.path),__filename,CONTRACT],'implementation inventory');
  same(r.openings,original.openings,'original exposed openings');same(r.tasks,tasks(r.openings,r.protocol),'complete200game schedule');
  const report=JSON.parse(verify(r.runtime).bytes),source=verify(r.source),originalRuntime=JSON.parse(verify(original.runtime).bytes);
  same(r.decision,decision(report,r.protocol),'prospective mechanism selection');check(r.decision.selected,'no eligible implementation');
  check(report.sourceReceiptSha256===source.sha256&&report.priorSourceReceiptSha256===originalRuntime.sourceReceiptSha256&&
    report.modelSha256===originalRuntime.modelSha256&&report.expandedWeightsSha256===originalRuntime.expandedWeightsSha256,'frozen evaluator ancestry differs');
  same(report.config,originalRuntime.config,'frozen model gate');
  check(report.modules.original.sha256===original.modules.hybrid.sha256&&report.modules.shipped.sha256===original.modules.shipped.sha256&&
    report.modules[r.decision.selected].sha256===r.modules.hybrid.sha256,'mechanism module identity differs');
  same(r.modules.shipped,original.modules.shipped,'original shipped module');
  check(r.candidateAdvancementAllowed===false&&r.offlineTestEligible===original.offlineTestEligible,'research eligibility differs');
  for(const info of [...r.implementation,...Object.values(r.modules),r.runtime,r.source,r.originalRegistration])verify(info);
  return r;
}
function audit(r,output,manifest){
  check(manifest.status==='completed'&&manifest.formalPass===false,'complete research manifest required');
  same(manifest.games.map(g=>g.taskId),r.tasks.map(t=>t.taskId),'complete raw200game inventory');H.auditWarmup(r,output,manifest.warmup);
  const games=r.tasks.map((task,index)=>{const info=manifest.games[index];check(info.status==='complete'&&info.path===task.taskId+'.jsonl','raw game path/status differs');
    const bytes=fs.readFileSync(path.join(output,info.path));check(bytes.length===info.bytes&&N.sha(bytes)===info.sha256,'raw game hash differs');
    const rows=H.parseLines(bytes);check(rows.length===info.rows,'raw row count differs');return H.auditGame(rows,task,r);});
  return H.analyzeAudited(games,r);
}
async function run(a){
  const r=preflight(a.registration,a['registration-sha256']);check(!fs.existsSync(a.output),'new output required');
  write(r.noRerunLedger,{registrationSha256:a['registration-sha256'],startedAtUtc:new Date().toISOString(),output:a.output,scoreRerunAllowed:false});
  fs.mkdirSync(a.output);let writer=new N.Writer(path.join(a.output,'warmup.jsonl')),warmup,task,failure=null,completed=false,timer;const games=[];
  const startedAtUtc=new Date().toISOString(),child=cp.fork(CHILD,['--internal-child'],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';
  child.stderr.on('data',bytes=>{stderr+=bytes.toString();});const stop=message=>{failure ||= message;child.kill('SIGKILL');};
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>stop('search/startup watchdog expired'),r.protocol.searchWatchdogMs);};
  const total=setTimeout(()=>stop('total workload watchdog expired'),r.protocol.workloadWatchdogMs);arm();child.send(r);
  child.on('message',row=>{try{
    if(row.control==='failed'){stop(row.error);return;}
    if(row.control==='search-start'||row.control==='game-flushed'){arm();return;}
    if(row.control==='warmup-complete'){warmup=N.closeObserved(writer);writer=null;check(warmup.status==='complete','warmup incomplete');arm();return;}
    if(row.control==='complete'){completed=true;clearTimeout(timer);return;}
    if(row.schema==='chessy.natural-runtime-game-header.v1'){check(!writer&&games.length<r.tasks.length,'unexpected header');task=r.tasks[games.length];
      check(row.taskId===task.taskId,'schedule differs');writer=new N.Writer(path.join(a.output,task.taskId+'.jsonl'));}
    check(writer,'raw row outside game');writer.append(row);
    if(row.schema==='chessy.natural-runtime-game-result.v1'){games.push({taskId:task.taskId,...N.closeObserved(writer)});writer=null;
      if(games.length%20===0)console.log(JSON.stringify({stage:'progress',completedGames:games.length,plannedGames:r.tasks.length}));}arm();
  }catch(error){stop(error.message);}});
  await new Promise(resolve=>{child.on('error',error=>{failure ||= error.message;});child.on('exit',code=>{clearTimeout(timer);clearTimeout(total);
    if(code!==0||!completed)failure ||= 'child incomplete: '+stderr.slice(-1000);resolve();});});
  if(writer){const info=N.closeObserved(writer);if(task)games.push({taskId:task.taskId,...info});else warmup=info;}
  const manifest={schema:'chessy.hybrid-optimized-development-match-raw-manifest.v1',registration:identity(a.registration),startedAtUtc,completedAtUtc:new Date().toISOString(),
    status:failure?'failed':'completed',failure,warmup,games,researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false};let byArm=null;
  if(!failure)try{preflight(a.registration,a['registration-sha256']);byArm=audit(r,a.output,manifest);}catch(error){failure=error.message;manifest.failure=failure;manifest.status='failed';}
  const rawManifest=write(path.join(a.output,'raw-manifest.json'),manifest),summary={schema:'chessy.hybrid-optimized-development-match-summary.v1',status:failure?'failed':'completed',failure,
    registrationSha256:a['registration-sha256'],rawManifest,decision:r.decision,completedGames:games.length,plannedGames:r.tasks.length,byArm:failure?null:byArm,
    researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false,offlineTestEligible:r.offlineTestEligible};write(path.join(a.output,'summary.json'),summary);return summary;
}
function args(argv){const command=argv[0],names=command==='register'?['original-registration','original-registration-sha256','mechanism-report','mechanism-source','cached','fused','output']:
  command==='run'||command==='audit'?['registration','registration-sha256','output']:null;check(names,'expected register/run/audit');const a={command};
  for(let i=1;i<argv.length;i+=2){const name=argv[i].replace(/^--/,'');check(argv[i].startsWith('--')&&names.includes(name)&&!Object.hasOwn(a,name)&&argv[i+1],'unknown/repeated/missing option');
    a[name]=name.endsWith('sha256')?argv[i+1]:path.resolve(argv[i+1]);}check(names.every(name=>Object.hasOwn(a,name)),'all inputs required');return a;}
if(require.main===module)(async()=>{const a=args(process.argv.slice(2));if(a.command==='register')return register(a);if(a.command==='run')return run(a);
  return audit(preflight(a.registration,a['registration-sha256']),a.output,read(path.join(a.output,'raw-manifest.json')));})().then(value=>{
    console.log(JSON.stringify(value));if(value.status==='failed')process.exitCode=1;}).catch(error=>{console.error('hybrid-match-optimized-v1: '+error.message);process.exitCode=1;});
module.exports={register,decision,tasks,median,preflight,audit};
