#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const N=require('./natural-runtime-run'),H=require('./hybrid-match-v1'),C=require('./hybrid-match-capture-v1');
const Wasm=require('../../assets/wasm-engine');
const ROOT=path.resolve(__dirname,'../..'),CONTRACT=path.join(ROOT,'eval/training/hybrid-match-recovery-v1.json');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b,label)=>check(N.stable(a)===N.stable(b),label+' differs');
const read=file=>JSON.parse(fs.readFileSync(file));
function identity(file){const bytes=fs.readFileSync(file);return {path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length};}
function verify(info){const snap=N.snapshot(info.path,info.sha256);check(snap.bytes.length===info.bytes,'bound byte size differs');return snap;}
function write(file,value){return {...C.atomic(file,Buffer.from(N.stable(value)+'\n')),path:path.resolve(file)};}
function register(a){
  const recovery=read(CONTRACT),original=H.preflight(a['original-registration'],a['original-registration-sha256']);
  check(a['original-registration-sha256']===recovery.originalRegistrationSha256,'wrong invalid original registration');
  const failedManifest=identity(a['failed-manifest']),forensicAudit=identity(a['forensic-audit']),conditionalSkip=identity(a['conditional-skip']);
  check(failedManifest.sha256===recovery.failedOriginalManifestSha256&&read(failedManifest.path).status==='failed','original failed manifest differs');
  const forensic=read(forensicAudit.path);check(forensic.formalPass===false&&forensic.scoresCalculated===false&&forensic.fullyAuthenticatedGames===338,'independent unscored forensic failure required');
  const skip=read(conditionalSkip.path);check(skip.schema==='chessy.hybrid-optimized-development-match-skipped.v1'&&skip.decision.selected===null,'conditional optimized extension must remain skipped');
  const originalRegistration=identity(a['original-registration']);
  const r={schema:'chessy.hybrid-match-infrastructure-recovery-registration.v1',createdAtUtc:new Date().toISOString(),researchOnly:true,formalPass:false,
    shippingOrEloClaimAllowed:false,candidateAdvancementAllowed:false,protocol:original.protocol,recovery,modules:original.modules,
    openings:original.openings,tasks:original.tasks,environment:original.environment,offlineTestEligible:original.offlineTestEligible,
    originalRegistration,failedManifest,forensicAudit,conditionalSkip,
    implementation:[...original.implementation,identity(__filename),identity(CONTRACT),identity(path.join(__dirname,'hybrid-match-capture-v1.js'))],
    executionRoot:path.dirname(a.output),noRerunLedger:path.join(path.dirname(original.offline.path),'.hybrid-match-recovery-v1.started.json')};return write(a.output,r);
}
function preflight(file,digest){
  const r=JSON.parse(N.snapshot(file,digest).bytes);check(r.schema==='chessy.hybrid-match-infrastructure-recovery-registration.v1'&&r.researchOnly===true&&r.formalPass===false&&
    r.shippingOrEloClaimAllowed===false&&r.candidateAdvancementAllowed===false,'research-only recovery registration required');
  same(r.recovery,read(CONTRACT),'technical recovery amendment');
  const original=H.preflight(r.originalRegistration.path,r.recovery.originalRegistrationSha256);
  check(r.noRerunLedger===path.join(path.dirname(original.offline.path),'.hybrid-match-recovery-v1.started.json'),'canonical one-shot recovery ledger differs');
  same(r.modules,original.modules,'identical original modules');same(r.protocol,original.protocol,'identical original rules');same(r.tasks,original.tasks,'identical original400task schedule');
  same(r.openings,original.openings,'original exposed opening bank');check(r.tasks.length===400,'complete400task schedule required');
  for(const info of [...r.implementation,...Object.values(r.modules),r.originalRegistration,r.failedManifest,r.forensicAudit,r.conditionalSkip])verify(info);return r;
}
function taskModules(r,task){return {baseline:r.modules.shipped,candidate:r.modules[task.arm]};}
function awaitCaptured(taskId,channel=process){return new Promise((resolve,reject)=>{
  const handler=message=>{if(message.control==='game-captured'&&message.taskId===taskId){channel.off('message',handler);resolve();}};
  channel.on('message',handler);channel.send({control:'game-ready',taskId},error=>{if(error){channel.off('message',handler);reject(error);}});
});}
async function child(r){
  const engines={},emit=row=>process.send(row);
  for(const side of ['shipped','hybrid','expanded'])engines[side]=await Wasm.load(verify(r.modules[side]).bytes);
  for(const index of r.protocol.warmup.openingIndices)for(const side of r.protocol.warmup.moduleOrder){
    const requested={maxDepth:r.protocol.maxDepth,timeMs:0,nodeLimit:r.protocol.warmup.nodesPerSearch,quiesce:true};
    const record=N.timedSearch(engines[side],side,r.modules[side].sha256,N.replay(r.openings[index].prefixUci),requested,emit);
    emit({schema:'chessy.hybrid-match-warmup.v1',openingIndex:index,...record});}
  emit({control:'warmup-complete'});await awaitCaptured('warmup');
  for(const task of r.tasks){N.playGame(task,{baseline:engines.shipped,candidate:engines[task.arm]},taskModules(r,task),r.protocol,emit);await awaitCaptured(task.taskId);}
  await new Promise((resolve,reject)=>process.send({control:'complete'},error=>error?reject(error):resolve()));process.disconnect();
}
function audit(r,output,manifest){
  check(manifest.status==='completed'&&manifest.formalPass===false,'completed research recovery manifest required');
  same(manifest.games.map(g=>g.taskId),r.tasks.map(t=>t.taskId),'complete400game capture inventory');
  const archived=C.readArchive(path.join(output,manifest.retainedArchive.path),manifest.retainedArchive,[manifest.warmup,...manifest.games]);
  // Reuse the frozen warmup validator on a temporary exact archive member.
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-recovery-warmup-'));
  try{fs.writeFileSync(path.join(temporary,'warmup.jsonl'),archived.get('warmup.jsonl'),{flag:'wx'});H.auditWarmup(r,temporary,manifest.warmup);}
  finally{fs.rmSync(temporary,{recursive:true,force:true});}
  const games=r.tasks.map((task,index)=>{const info=manifest.games[index];check(info.status==='complete'&&info.path===task.taskId+'.jsonl','captured game binding differs');
    const rows=H.parseLines(archived.get(info.path));check(rows.length===info.rows,'archive row count differs');return H.auditGame(rows,task,r);});
  return H.analyzeAudited(games,r);
}
function liveDiscrepancies(output,receipts){return receipts.flatMap(receipt=>{
  try{const bytes=fs.readFileSync(path.join(output,receipt.path)),sha256=N.sha(bytes);return bytes.length===receipt.bytes&&sha256===receipt.sha256?[]:
    [{path:receipt.path,observedBytes:bytes.length,observedSha256:sha256,expectedBytes:receipt.bytes,expectedSha256:receipt.sha256}];}
  catch(error){return [{path:receipt.path,error:error.message}];}
});}
async function run(a){
  const r=preflight(a.registration,a['registration-sha256']);check(path.dirname(a.output)===r.executionRoot&&!fs.existsSync(a.output),'new output must use registered recovery root');
  write(r.noRerunLedger,{registrationSha256:a['registration-sha256'],startedAtUtc:new Date().toISOString(),output:a.output,scoreRerunAllowed:false});fs.mkdirSync(a.output);
  const retained=new Map(),games=[],startedAtUtc=new Date().toISOString();let writer=new C.AtomicRetainedWriter(path.join(a.output,'warmup.jsonl'),retained);
  let warmup,currentTask,capturedId=null,failure=null,completed=false,timer;
  const worker=cp.fork(__filename,['--internal-child'],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';worker.stderr.on('data',bytes=>{stderr+=bytes.toString();});
  const stop=message=>{failure ||= message;worker.kill('SIGKILL');};
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>stop('search/startup watchdog expired'),r.protocol.searchWatchdogMs);};
  const total=setTimeout(()=>stop('registered total workload watchdog expired'),r.protocol.workloadWatchdogMs);arm();worker.send(r);
  worker.on('message',row=>{try{
    if(row.control==='failed'){stop(row.error);return;}
    if(row.control==='search-start'){arm();return;}
    if(row.control==='warmup-complete'){warmup={status:'complete',...writer.close()};writer=null;capturedId='warmup';arm();return;}
    if(row.control==='game-ready'){check(!writer&&capturedId===row.taskId,'child advanced before exact capture');worker.send({control:'game-captured',taskId:row.taskId});arm();return;}
    if(row.control==='complete'){completed=true;clearTimeout(timer);return;}
    if(row.schema==='chessy.natural-runtime-game-header.v1'){check(!writer&&games.length<r.tasks.length,'unexpected game header');currentTask=r.tasks[games.length];
      check(row.taskId===currentTask.taskId,'frozen schedule differs');writer=new C.AtomicRetainedWriter(path.join(a.output,currentTask.taskId+'.jsonl'),retained);}
    check(writer,'record outside captured game');writer.append(row);
    if(row.schema==='chessy.natural-runtime-game-result.v1'){games.push({taskId:currentTask.taskId,status:'complete',...writer.close()});writer=null;capturedId=currentTask.taskId;
      if(games.length%20===0)console.log(JSON.stringify({stage:'progress',completedGames:games.length,plannedGames:r.tasks.length}));}arm();
  }catch(error){stop(error.message);}});
  await new Promise(resolve=>{worker.on('error',error=>{failure ||= error.message;});worker.on('exit',code=>{clearTimeout(timer);clearTimeout(total);
    if(code!==0||!completed)failure ||= 'child incomplete: '+stderr.slice(-1000);resolve();});});
  if(writer)try{const receipt={status:'partial',...writer.close()};if(currentTask)games.push({taskId:currentTask.taskId,...receipt});else warmup=receipt;}catch(error){failure ||= error.message;}
  // No compression, archive writing or score audit can precede timed-child exit.
  console.log(JSON.stringify({stage:'timed-searches-stopped',completedGames:games.length,plannedGames:r.tasks.length}));
  let retainedArchive=null,byArm=null;
  if(!failure)try{retainedArchive=C.archive(path.join(a.output,'retained-games.json'),retained,[warmup,...games]);}catch(error){failure=error.message;}
  const manifest={schema:'chessy.hybrid-match-infrastructure-recovery-raw-manifest.v1',registration:identity(a.registration),startedAtUtc,completedAtUtc:new Date().toISOString(),
    status:failure?'failed':'completed',failure,warmup:warmup||null,games,retainedArchive,liveFileDiscrepancies:liveDiscrepancies(a.output,[...(warmup?[warmup]:[]),...games]),
    researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false,archiveSource:'Exact bytes retained in parent as originally emitted; never reconstructed from live files.'};
  if(!failure)try{preflight(a.registration,a['registration-sha256']);byArm=audit(r,a.output,manifest);}catch(error){failure=error.message;manifest.failure=failure;manifest.status='failed';}
  const rawManifest=write(path.join(a.output,'raw-manifest.json'),manifest),summary={schema:'chessy.hybrid-match-infrastructure-recovery-summary.v1',status:failure?'failed':'completed',failure,
    registrationSha256:a['registration-sha256'],rawManifest,retainedArchive,completedGames:games.length,plannedGames:r.tasks.length,
    liveFileDiscrepancies:manifest.liveFileDiscrepancies.length,byArm:failure?null:byArm,researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false,
    originalBatchStillInvalid:true,conditionalOptimizedFollowupStillSkipped:true,offlineTestEligible:r.offlineTestEligible};write(path.join(a.output,'summary.json'),summary);return summary;
}
function args(argv){const command=argv[0],names=command==='register'?['original-registration','original-registration-sha256','failed-manifest','forensic-audit','conditional-skip','output']:
  command==='run'||command==='audit'?['registration','registration-sha256','output']:null;check(names,'expected register/run/audit');const a={command};
  for(let i=1;i<argv.length;i+=2){const name=argv[i].replace(/^--/,'');check(argv[i].startsWith('--')&&names.includes(name)&&!Object.hasOwn(a,name)&&argv[i+1],'unknown/repeated/missing option');
    a[name]=name.endsWith('sha256')?argv[i+1]:path.resolve(argv[i+1]);}check(names.every(name=>Object.hasOwn(a,name)),'all inputs required');return a;}
if(require.main===module){if(process.argv[2]==='--internal-child')process.once('message',r=>child(r).catch(error=>{process.send({control:'failed',error:error.message},()=>process.disconnect());process.exitCode=1;}));
  else(async()=>{const a=args(process.argv.slice(2));if(a.command==='register')return register(a);if(a.command==='run')return run(a);
    return audit(preflight(a.registration,a['registration-sha256']),a.output,read(path.join(a.output,'raw-manifest.json')));})().then(value=>{
      console.log(JSON.stringify(value));if(value.status==='failed')process.exitCode=1;}).catch(error=>{console.error('hybrid-match-recovery-v1: '+error.message);process.exitCode=1;});}
module.exports={register,preflight,audit,liveDiscrepancies,args,awaitCaptured};
