#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const N=require('./natural-runtime-run'),H=require('./hybrid-match-v1'),C=require('./hybrid-match-capture-v1'),R=require('./hybrid-match-recovery-v1');
const Wasm=require('../../assets/wasm-engine');
const F=require('./hybrid-fixed-node-v1');
const Chess=globalThis.Chess;
const ROOT=path.resolve(__dirname,'../..'),CONTRACT=path.join(ROOT,'eval/training/hybrid-equal-time-200ms-v1.json');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b,label)=>check(N.stable(a)===N.stable(b),label+' differs');
function jsonSnapshot(file){const bytes=fs.readFileSync(file);return {value:JSON.parse(bytes),identity:{path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length}};}
const read=file=>jsonSnapshot(file).value;
function identity(file){const bytes=fs.readFileSync(file);return {path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length};}
function verify(info){const snap=N.snapshot(info.path,info.sha256);check(snap.bytes.length===info.bytes,'bound byte size differs');return snap;}
function write(file,value){return {...C.atomic(file,Buffer.from(N.stable(value)+'\n')),path:path.resolve(file)};}
const IMPLEMENTATION=[__filename,CONTRACT,'tools/training/hybrid-match-recovery-v1.js','tools/training/hybrid-match-capture-v1.js',
  'tools/training/hybrid-match-v1.js','tools/training/hybrid-fixed-node-v1.js','eval/training/hybrid-fixed-node-v1.json','tools/training/natural-runtime-run.js','assets/engine.js','assets/wasm-engine.js',
  'test/ai-match-openings.js','test/ai-match-protocol.js','test/match-stats.js','tools/training/audit-hybrid-equal-time-200ms-v1.py',
  'tools/training/audit-natural-runtime.py'].map(p=>path.isAbsolute(p)?p:path.join(ROOT,p));
function originalSnapshot(file,digest){
  check(digest===read(CONTRACT).originalRegistrationSha256,'wrong original registration');
  const captured=N.snapshot(file,digest),r=JSON.parse(captured.bytes);
  check(r.schema==='chessy.hybrid-development-match-registration.v1'&&r.formalPass===false,'original research registration required');
  for(const info of Object.values(r.modules))verify(info);
  const offline=JSON.parse(verify(r.offline).bytes),runtime=JSON.parse(verify(r.runtime).bytes);
  check(['chessy.hybrid-screen.v1','chessy.hybrid-screen.v1b'].includes(offline.schema)&&typeof offline.testEligible==='boolean','original offline screen invalid');
  check(runtime.schema==='chessy.hybrid-runtime-cost.v1'&&runtime.status==='completed'&&runtime.researchOnly===true&&runtime.parityMismatches===0&&runtime.modelSha256===offline.decision.finalBinarySha256,'original parity/model receipt invalid');
  check(r.evidence.length===1&&runtime.sourceReceiptSha256===r.evidence[0].sha256,'original source identity differs');
  for(const info of r.evidence)verify(info);
  same(runtime.config,offline.decision.config,'original runtime/offline gate');
  for(const side of ['shipped','hybrid','expanded'])check(runtime.modules[side].sha256===r.modules[side].sha256,'original runtime module differs');
  check(Array.isArray(runtime.parity)&&runtime.parity.length>0,'original parity evidence missing');
  return {value:r,identity:{path:captured.path,sha256:captured.sha256,bytes:captured.bytes.length}};
}
function selectOpenings(rows,protocol){
  check(rows.length===100&&rows.every((row,index)=>row.index===index),'complete unchanged100opening source required');
  return rows.map(opening=>({opening,digest:N.sha(Buffer.from(protocol.openingSelection.salt+'|'+opening.index))}))
    .sort((a,b)=>a.digest.localeCompare(b.digest)).slice(0,20).map(row=>row.opening);
}
function makeTasks(rows,protocol){return rows.flatMap(opening=>(opening.index%2?['b','w']:['w','b']).map(candidateColor=>({
  taskId:`hybrid-t${protocol.timeMs}-o${opening.index}-${candidateColor}`,arm:'hybrid',opening,candidateColor,timeMs:protocol.timeMs,nodeLimit:0})));}
function precursorSnapshot(summaryPath,auditPath){
  const expected=read(CONTRACT).precursor,summary=N.snapshot(summaryPath,expected.summarySha256),audit=N.snapshot(auditPath,expected.independentAuditSha256);
  const s=JSON.parse(summary.bytes),a=JSON.parse(audit.bytes);
  check(s.schema==='chessy.hybrid-fixed-node-diagnostic-summary.v1'&&s.status==='completed'&&s.failure===null&&s.completedGames===200&&s.plannedGames===200&&s.byArm.hybrid.candidateScore===0.5,'wrong completed fixed-node precursor');
  check(a.schema==='chessy.hybrid-fixed-node-independent-audit.v1'&&a.status==='PASS'&&a.mismatches===0&&a.games===200&&a.summarySha256===summary.sha256,'wrong independent precursor audit');
  check(s.registrationSha256===expected.registrationSha256&&a.registrationSha256===expected.registrationSha256,'precursor registration mismatch');
  return {summary:{path:summary.path,sha256:summary.sha256,bytes:summary.bytes.length},independentAudit:{path:audit.path,sha256:audit.sha256,bytes:audit.bytes.length}};
}
function retired(){throw Error('This completed diagnostic recipe is retired; preserve its original evidence and do not rerun it.');}
function register(){return retired();}
function preflight(file,digest){
  F.requireRetainedExecution(ROOT,IMPLEMENTATION);
  const r=JSON.parse(N.snapshot(file,digest).bytes);check(r.schema==='chessy.hybrid-equal-time-200ms-diagnostic-registration.v1'&&r.researchOnly===true&&r.formalPass===false&&
    r.shippingOrEloClaimAllowed===false&&r.candidateAdvancementAllowed===false,'research-only equal-time200ms registration required');
  same(r.protocol,read(CONTRACT),'equal-time200ms protocol');
  const source=originalSnapshot(r.originalRegistration.path,r.protocol.originalRegistrationSha256),original=source.value;
  same(r.originalRegistration,source.identity,'original retained-byte binding');
  check(r.originalRegistration.sha256===r.protocol.originalRegistrationSha256,'original digest differs');
  check(r.noRerunLedger===path.join(path.dirname(original.offline.path),'.hybrid-equal-time-200ms-v1.started.json'),'canonical one-shot ledger differs');
  same(r.modules,{shipped:original.modules.shipped,hybrid:original.modules.hybrid},'identical original modules');
  same(original.openings,H.openings(),'original exposed opening bank');same(r.openings,selectOpenings(original.openings,r.protocol),'hash-selected20opening replay');
  same(r.precursor,precursorSnapshot(r.precursor.summary.path,r.precursor.independentAudit.path),'frozen completed precursor');
  same(r.tasks,makeTasks(r.openings,r.protocol),'complete paired equal-time200ms schedule');check(r.tasks.length===40&&r.protocol.timeMs===200&&r.protocol.nodeLimit===0&&r.protocol.maxSearchedPlies===180&&r.protocol.workloadWatchdogMs===2100000,'complete bounded40game200ms schedule required');
  F.requireRetainedExecution(ROOT,IMPLEMENTATION,r);
  for(const info of [...r.implementation,...Object.values(r.modules),r.originalRegistration])verify(info);
  for(const [key,value] of Object.entries({node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch}))same(r.environment[key],value,'registered runtime '+key);
  return r;
}
function taskModules(r,task){return {baseline:r.modules.shipped,candidate:r.modules[task.arm]};}
const awaitCaptured=R.awaitCaptured;
const playGame=F.playGame,timedSearch=F.timedSearch,analyzeAudited=H.analyzeAudited;
function auditGame(rows,task,r){
  const game=F.auditGame(rows,task,r);
  for(const row of rows.slice(1,-1))if(row.result.stopReason==='time-limit')check(row.elapsedMs>=task.timeMs,'time-limit stopped before requested budget');
  return game;
}
function audit(r,output,manifest){
  check(manifest.status==='completed'&&manifest.formalPass===false,'completed research equal-time200ms manifest required');
  same(manifest.games.map(g=>g.taskId),r.tasks.map(t=>t.taskId),'complete40game capture inventory');
  const archived=C.readArchive(path.join(output,manifest.retainedArchive.path),manifest.retainedArchive,[manifest.warmup,...manifest.games]);
  // Reuse the frozen warmup validator on a temporary exact archive member.
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-recovery-warmup-'));
  try{fs.writeFileSync(path.join(temporary,'warmup.jsonl'),archived.get('warmup.jsonl'),{flag:'wx'});H.auditWarmup(r,temporary,manifest.warmup);}
  finally{fs.rmSync(temporary,{recursive:true,force:true});}
  const games=r.tasks.map((task,index)=>{const info=manifest.games[index];check(info.status==='complete'&&info.path===task.taskId+'.jsonl','captured game binding differs');
    const rows=H.parseLines(archived.get(info.path));check(rows.length===info.rows,'archive row count differs');return auditGame(rows,task,r);});
  return analyzeAudited(games,r);
}
function liveDiscrepancies(output,receipts){return receipts.flatMap(receipt=>{
  try{const bytes=fs.readFileSync(path.join(output,receipt.path)),sha256=N.sha(bytes);return bytes.length===receipt.bytes&&sha256===receipt.sha256?[]:
    [{path:receipt.path,observedBytes:bytes.length,observedSha256:sha256,expectedBytes:receipt.bytes,expectedSha256:receipt.sha256}];}
  catch(error){return [{path:receipt.path,error:error.message}];}
});}
function args(argv){const command=argv[0],names=command==='register'?['original-registration','original-registration-sha256','precursor-summary','precursor-audit','output']:
  command==='run'||command==='audit'?['registration','registration-sha256','output']:null;check(names,'expected register/run/audit');const a={command};
  for(let i=1;i<argv.length;i+=2){const name=argv[i].replace(/^--/,'');check(argv[i].startsWith('--')&&names.includes(name)&&!Object.hasOwn(a,name)&&argv[i+1],'unknown/repeated/missing option');
    a[name]=name.endsWith('sha256')?argv[i+1]:path.resolve(argv[i+1]);}check(names.every(name=>Object.hasOwn(a,name)),'all inputs required');return a;}
if(require.main===module)(async()=>{
  if(['register','run','--internal-child'].includes(process.argv[2]))retired();
  const a=args(process.argv.slice(2));return audit(preflight(a.registration,a['registration-sha256']),a.output,read(path.join(a.output,'raw-manifest.json')));
})().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error('hybrid-equal-time-200ms-v1: '+error.message);process.exitCode=1;});
module.exports={selectOpenings,precursorSnapshot,register,preflight,audit,liveDiscrepancies,args,awaitCaptured,makeTasks,playGame,auditGame,analyzeAudited,timedSearch};
