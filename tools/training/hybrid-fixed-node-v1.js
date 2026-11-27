#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const N=require('./natural-runtime-run'),H=require('./hybrid-match-v1'),C=require('./hybrid-match-capture-v1'),R=require('./hybrid-match-recovery-v1');
const Wasm=require('../../assets/wasm-engine');
const Chess=globalThis.Chess;
const ROOT=path.resolve(__dirname,'../..'),CONTRACT=path.join(ROOT,'eval/training/hybrid-fixed-node-v1.json');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b,label)=>check(N.stable(a)===N.stable(b),label+' differs');
function jsonSnapshot(file){const bytes=fs.readFileSync(file);return {value:JSON.parse(bytes),identity:{path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length}};}
const read=file=>jsonSnapshot(file).value;
function identity(file){const bytes=fs.readFileSync(file);return {path:path.resolve(file),sha256:N.sha(bytes),bytes:bytes.length};}
function verify(info){const snap=N.snapshot(info.path,info.sha256);check(snap.bytes.length===info.bytes,'bound byte size differs');return snap;}
function write(file,value){return {...C.atomic(file,Buffer.from(N.stable(value)+'\n')),path:path.resolve(file)};}
const IMPLEMENTATION=[__filename,CONTRACT,'tools/training/hybrid-match-recovery-v1.js','tools/training/hybrid-match-capture-v1.js',
  'tools/training/hybrid-match-v1.js','tools/training/natural-runtime-run.js','assets/engine.js','assets/wasm-engine.js',
  'test/ai-match-openings.js','test/ai-match-protocol.js','test/match-stats.js','tools/training/audit-hybrid-fixed-node-v1.py',
  'tools/training/audit-natural-runtime.py'].map(p=>path.isAbsolute(p)?p:path.join(ROOT,p));
function requireRetainedExecution(root,files,registration){
  check(path.resolve(root)===root,'absolute retained execution root required');
  const directories=new Set([root]);
  for(const file of files){
    check(path.resolve(file)===file&&file.startsWith(root+path.sep),'implementation escaped retained execution root');
    const stat=fs.lstatSync(file);
    check(stat.isFile()&&!(stat.mode&0o222)&&fs.realpathSync(file)===file,'execution snapshot files must be read-only regular files without symlinks');
    for(let directory=path.dirname(file);directory!==root;directory=path.dirname(directory))directories.add(directory);
  }
  for(const directory of directories){
    const stat=fs.lstatSync(directory);
    check(stat.isDirectory()&&!(stat.mode&0o222)&&fs.realpathSync(directory)===directory,'execution snapshot directories must be read-only without symlinks');
  }
  if(registration){
    same(registration.implementation.map(info=>info.path),files,'registered retained implementation paths');
    for(const info of registration.implementation)verify(info);
  }
}
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
function makeTasks(rows,protocol){return rows.flatMap(opening=>(opening.index%2?['b','w']:['w','b']).map(candidateColor=>({
  taskId:`hybrid-n${protocol.nodeLimit}-o${opening.index}-${candidateColor}`,arm:'hybrid',opening,candidateColor,timeMs:0,nodeLimit:protocol.nodeLimit})));}
function retired(){throw Error('This completed diagnostic recipe is retired; preserve its original evidence and do not rerun it.');}
function register(){return retired();}
function preflight(file,digest){
  requireRetainedExecution(ROOT,IMPLEMENTATION);
  const r=JSON.parse(N.snapshot(file,digest).bytes);check(r.schema==='chessy.hybrid-fixed-node-diagnostic-registration.v1'&&r.researchOnly===true&&r.formalPass===false&&
    r.shippingOrEloClaimAllowed===false&&r.candidateAdvancementAllowed===false,'research-only fixed-node registration required');
  same(r.protocol,read(CONTRACT),'fixed-node protocol');
  const source=originalSnapshot(r.originalRegistration.path,r.protocol.originalRegistrationSha256),original=source.value;
  same(r.originalRegistration,source.identity,'original retained-byte binding');
  check(r.originalRegistration.sha256===r.protocol.originalRegistrationSha256,'original digest differs');
  check(r.noRerunLedger===path.join(path.dirname(original.offline.path),'.hybrid-fixed-node-v1.started.json'),'canonical one-shot ledger differs');
  same(r.modules,{shipped:original.modules.shipped,hybrid:original.modules.hybrid},'identical original modules');
  same(r.openings,original.openings,'original exposed opening bank');same(r.openings,H.openings(),'opening replay');
  same(r.tasks,makeTasks(r.openings,r.protocol),'complete paired fixed-node schedule');check(r.tasks.length===200,'complete 200-game schedule required');
  requireRetainedExecution(ROOT,IMPLEMENTATION,r);
  for(const info of [...r.implementation,...Object.values(r.modules),r.originalRegistration])verify(info);
  for(const [key,value] of Object.entries({node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch}))same(r.environment[key],value,'registered runtime '+key);
  return r;
}
function taskModules(r,task){return {baseline:r.modules.shipped,candidate:r.modules[task.arm]};}
const awaitCaptured=R.awaitCaptured;
function playGame(task, engines, modules, config, emit) {
  let state = N.replay(task.opening.prefixUci), plies = 0;
  check(Chess.toFen(state) === task.opening.fen, 'opening replay changed');
  emit({ schema: 'chessy.natural-runtime-game-header.v1', taskId: task.taskId,
    openingIndex: task.opening.index, openingName: task.opening.name, prefixUci: task.opening.prefixUci,
    timeMs: task.timeMs, nodeLimit: task.nodeLimit, candidateColor: task.candidateColor, maxPlies: config.maxSearchedPlies,
    maxDepth: config.maxDepth, modules: Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, { sha256: value.sha256 }])) });
  while (plies < config.maxSearchedPlies && !Chess.gameStatus(state).over) {
    const color = state.turn, moduleId = color === task.candidateColor ? 'candidate' : 'baseline';
    const requested = { maxDepth: config.maxDepth, timeMs: task.timeMs, nodeLimit: config.nodeLimit, quiesce: config.quiesce };
    const record = timedSearch(engines[moduleId], moduleId, modules[moduleId].sha256, state, requested, emit);
    state = N.play(state, record.result.moveUci);
    emit({ schema: 'chessy.natural-runtime-move.v1', taskId: task.taskId, ply: plies, color, ...record, fenAfter: Chess.toFen(state) });
    plies++;
  }
  const status = Chess.gameStatus(state), result = status.over ? status.result : '1/2-1/2';
  const whitePoints = result === '1-0' ? 1 : result === '0-1' ? 0 : .5;
  const outcome = { schema: 'chessy.natural-runtime-game-result.v1', taskId: task.taskId, searchedPlies: plies,
    finalFen: Chess.toFen(state), result, reason: status.over ? status.reason : 'ply-cap',
    candidateScore: task.candidateColor === 'w' ? whitePoints : 1-whitePoints };
  emit(outcome); return outcome;
}
function auditGame(rows, task, r) {
  check(rows.length >= 2, 'incomplete game');
  const header = rows[0], modules = taskModules(r, task), config = r.protocol;
  same(header, { schema: 'chessy.natural-runtime-game-header.v1', taskId: task.taskId,
    openingIndex: task.opening.index, openingName: task.opening.name, prefixUci: task.opening.prefixUci,
    timeMs: task.timeMs, nodeLimit: task.nodeLimit, candidateColor: task.candidateColor, maxPlies: config.maxSearchedPlies,
    maxDepth: config.maxDepth, modules: Object.fromEntries(Object.entries(modules).map(([k,v]) => [k,{sha256:v.sha256}])) }, 'game header');
  let state = N.replay(task.opening.prefixUci), ply = 0; const measured = [];
  check(Chess.toFen(state) === task.opening.fen, 'opening endpoint differs');
  for (const row of rows.slice(1, -1)) {
    check(!Chess.gameStatus(state).over && ply < config.maxSearchedPlies, 'move recorded after terminal state');
    const side = state.turn === task.candidateColor ? 'candidate' : 'baseline';
    check(row.schema === 'chessy.natural-runtime-move.v1' && row.taskId === task.taskId && row.ply === ply && row.color === state.turn &&
      row.moduleId === side && row.moduleSha256 === modules[side].sha256 && row.fenBefore === Chess.toFen(state), 'move identity/FEN/order differs');
    same(row.positions, state.positions, 'full-prefix repetition history');
    same(row.requested, { maxDepth: config.maxDepth, timeMs: task.timeMs, nodeLimit: config.nodeLimit, quiesce: config.quiesce }, 'fixed node request');
    N.validateSearchResult(row.result, config.maxDepth, row.requested);
    check(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, 'invalid observed elapsed time');
    const named = Chess.sqName(row.result.move.from) + Chess.sqName(row.result.move.to) + (row.result.move.promotion || '').toLowerCase();
    check(named === row.result.moveUci, 'packed/UCI move differs');
    state = N.play(state, row.result.moveUci); check(row.fenAfter === Chess.toFen(state), 'move endpoint differs');
    measured.push({ side, elapsedMs: row.elapsedMs, nodes: row.result.nodes, depth: row.result.depth,
      attemptedDepth: row.result.attemptedDepth, stopReason: row.result.stopReason }); ply++;
  }
  const status = Chess.gameStatus(state); check(status.over || ply === config.maxSearchedPlies, 'premature termination');
  const result = status.over ? status.result : '1/2-1/2', whitePoints = result === '1-0' ? 1 : result === '0-1' ? 0 : .5;
  const expected = { schema: 'chessy.natural-runtime-game-result.v1', taskId: task.taskId, searchedPlies: ply,
    finalFen: Chess.toFen(state), result, reason: status.over ? status.reason : 'ply-cap',
    candidateScore: task.candidateColor === 'w' ? whitePoints : 1 - whitePoints };
  same(rows[rows.length - 1], expected, 'terminal result');
  return { taskId: task.taskId, arm: task.arm, openingIndex: task.opening.index, candidateColor: task.candidateColor,
    ...expected, measured };
}
function analyzeAudited(games,r){
  const byArm=H.analyzeAudited(games,r);
  for(const arm of Object.values(byArm))for(const side of Object.values(arm.timing))delete side.overTwoTimesRequested;
  return byArm;
}
function timedSearch(engine,moduleId,moduleSha256,state,requested,emit){
  const fenBefore=Chess.toFen(state),positions={...state.positions};let result=null;
  emit({control:'search-start'});const start=performance.now();
  try{
    result=engine.search(fenBefore,{...requested,positions});const elapsedMs=performance.now()-start;
    N.validateSearchResult(result,requested.maxDepth,requested);
    const moveUci=Chess.sqName(result.move.from)+Chess.sqName(result.move.to)+(result.move.promotion||'').toLowerCase();
    check(Chess.legalMoves(state).some(m=>Chess.sqName(m.from)+Chess.sqName(m.to)+(m.promotion||'').toLowerCase()===moveUci),'WASM returned illegal move');
    check(Number.isFinite(elapsedMs)&&elapsedMs>0,'invalid elapsed time');
    return {moduleId,moduleSha256,fenBefore,positions,requested,result:{...result,moveUci},elapsedMs};
  }catch(error){emit({schema:'chessy.hybrid-fixed-node-invalid-search.v1',moduleId,moduleSha256,fenBefore,positions,requested,
    rawResult:result,elapsedMs:performance.now()-start,error:error.message});throw error;}
}
function audit(r,output,manifest){
  check(manifest.status==='completed'&&manifest.formalPass===false,'completed research fixed-node manifest required');
  same(manifest.games.map(g=>g.taskId),r.tasks.map(t=>t.taskId),'complete 200-game capture inventory');
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
function args(argv){const command=argv[0],names=command==='register'?['original-registration','original-registration-sha256','output']:
  command==='run'||command==='audit'?['registration','registration-sha256','output']:null;check(names,'expected register/run/audit');const a={command};
  for(let i=1;i<argv.length;i+=2){const name=argv[i].replace(/^--/,'');check(argv[i].startsWith('--')&&names.includes(name)&&!Object.hasOwn(a,name)&&argv[i+1],'unknown/repeated/missing option');
    a[name]=name.endsWith('sha256')?argv[i+1]:path.resolve(argv[i+1]);}check(names.every(name=>Object.hasOwn(a,name)),'all inputs required');return a;}
if(require.main===module)(async()=>{
  if(['register','run','--internal-child'].includes(process.argv[2]))retired();
  const a=args(process.argv.slice(2));return audit(preflight(a.registration,a['registration-sha256']),a.output,read(path.join(a.output,'raw-manifest.json')));
})().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error('hybrid-fixed-node-v1: '+error.message);process.exitCode=1;});
module.exports={register,preflight,audit,liveDiscrepancies,args,awaitCaptured,makeTasks,playGame,auditGame,analyzeAudited,timedSearch,requireRetainedExecution};
