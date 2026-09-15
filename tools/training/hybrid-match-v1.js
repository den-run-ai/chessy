#!/usr/bin/env node
/* Research-only, frozen paired equal-time diagnostic. No formal holdout import.
 * Reuses the reviewed arbiter/repetition/search semantics from natural-runtime.
 * The parent survives synchronous child searches and retains partial evidence.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const N = require('./natural-runtime-run');
const WasmEngine = require('../../assets/wasm-engine');
const Openings = require('../../test/ai-match-openings');
const { clusterStats } = require('../../test/match-stats');
const Chess = globalThis.Chess;
const ROOT = path.resolve(__dirname, '../..');
const PROTOCOL_PATH = path.join(ROOT, 'eval/training/hybrid-match-v1.json');
const IMPLEMENTATION = [__filename, PROTOCOL_PATH, 'tools/training/natural-runtime-run.js',
  'assets/engine.js', 'assets/wasm-engine.js', 'test/ai-match-openings.js',
  'test/ai-match-protocol.js', 'test/match-stats.js'].map(p => path.isAbsolute(p) ? p : path.join(ROOT, p));
function check(ok, message) { if (!ok) throw new Error(message); }
function same(a, b, label) { check(N.stable(a) === N.stable(b), label + ' differs'); }
function identity(file) { const bytes = fs.readFileSync(file); return { path: path.resolve(file), sha256: N.sha(bytes), bytes: bytes.length }; }
function verified(info) { const s = N.snapshot(info.path, info.sha256); check(s.bytes.length === info.bytes, 'artifact byte size differs'); return s; }
function json(file) { return JSON.parse(fs.readFileSync(file)); }
// Hash and parse one retained snapshot; never reopen a receipt for its value.
function receipt(file) { const bytes = fs.readFileSync(file); return { info: { path: path.resolve(file), sha256: N.sha(bytes), bytes: bytes.length }, value: JSON.parse(bytes) }; }
function validateReceipts(r) {
  const offlineValue = JSON.parse(verified(r.offline).bytes), runtimeValue = JSON.parse(verified(r.runtime).bytes);
  check(r.evidence.length === 1, 'exact runtime source receipt required');
  verified(r.evidence[0]);
  validateReceiptValues(offlineValue, runtimeValue, r.evidence[0], r.modules);
  check(r.offlineTestEligible === offlineValue.testEligible, 'offline eligibility differs');
}
function validateReceiptValues(offlineValue, runtimeValue, source, modules) {
  check(['chessy.hybrid-screen.v1','chessy.hybrid-screen.v1b'].includes(offlineValue.schema) && typeof offlineValue.testEligible === 'boolean', 'frozen offline screen receipt required');
  check(runtimeValue.schema === 'chessy.hybrid-runtime-cost.v1' && runtimeValue.status === 'completed' && runtimeValue.researchOnly === true &&
    runtimeValue.parityMismatches === 0 && runtimeValue.sourceReceiptSha256 === source.sha256 &&
    runtimeValue.modelSha256 === offlineValue.decision.finalBinarySha256, 'bound research runtime parity receipt required');
  same(runtimeValue.config, offlineValue.decision.config, 'runtime/frozen hybrid gate');
  for (const side of ['shipped', 'hybrid', 'expanded']) check(runtimeValue.modules[side].sha256 === modules[side].sha256, 'runtime receipt module differs: ' + side);
  check(Array.isArray(runtimeValue.parity) && runtimeValue.parity.length > 0, 'raw runtime parity evidence required');
}
function newJson(file, value) { fs.writeFileSync(file, N.stable(value) + '\n', { flag: 'wx' }); return identity(file); }
function openings() {
  check(Openings.length === 100, 'development opening count changed');
  return Openings.map(([name, san], index) => ({ index, name, san, ...N.openingPrefix(san) }))
    .map(o => ({ index: o.index, name: o.name, san: o.san, prefixUci: o.prefix, fen: o.fen }));
}
function makeTasks(rows, protocol) {
  const tasks = [];
  for (const opening of rows) {
    const arms = opening.index % 2 ? ['expanded', 'hybrid'] : ['hybrid', 'expanded'];
    const colors = opening.index % 2 ? ['b', 'w'] : ['w', 'b'];
    for (const arm of arms) for (const candidateColor of colors) tasks.push({
      taskId: `${arm}-o${opening.index}-${candidateColor}`, arm, opening,
      candidateColor, timeMs: protocol.timeMs
    });
  }
  return tasks;
}
function register(args) {
  const protocol = json(PROTOCOL_PATH), modules = {};
  for (const side of ['shipped', 'hybrid', 'expanded']) modules[side] = identity(args[side]);
  check(new Set(Object.values(modules).map(x => x.sha256)).size === 3, 'all three evaluator modules must differ');
  const offlineSnapshot = receipt(args['offline-report']), runtimeSnapshot = receipt(args['runtime-receipt']);
  const offline = offlineSnapshot.info, runtime = runtimeSnapshot.info;
  const offlineValue = offlineSnapshot.value, runtimeValue = runtimeSnapshot.value, source = identity(args['runtime-source']);
  validateReceiptValues(offlineValue, runtimeValue, source, modules);
  const evidence = [source];
  const rows = openings(), tasks = makeTasks(rows, protocol);
  check(tasks.length === protocol.totalGames, 'planned count differs');
  const registration = { schema: 'chessy.hybrid-development-match-registration.v1', createdAtUtc: new Date().toISOString(),
    researchOnly: true, formalPass: false, shippingOrEloClaimAllowed: false,
    offlineTestEligible: offlineValue.testEligible,
    candidateAdvancementAllowed: false,
    protocol, modules, offline, runtime, evidence, openings: rows, tasks,
    implementation: IMPLEMENTATION.map(identity),
    environment: { node: process.versions.node, v8: process.versions.v8, platform: process.platform, arch: process.arch,
      cpus: os.cpus().map(cpu => cpu.model) },
    noRerunLedger: path.join(path.dirname(offline.path), '.hybrid-match-v1.started.json') };
  return newJson(args.output, registration);
}
function preflight(file, digest) {
  const snap = N.snapshot(file, digest), r = JSON.parse(snap.bytes);
  check(r.schema === 'chessy.hybrid-development-match-registration.v1' && r.researchOnly === true && r.formalPass === false &&
    r.shippingOrEloClaimAllowed === false && r.candidateAdvancementAllowed === false, 'research registration required');
  same(r.protocol, json(PROTOCOL_PATH), 'protocol'); same(r.openings, openings(), 'opening replay');
  same(r.tasks, makeTasks(r.openings, r.protocol), 'complete paired schedule');
  check(r.tasks.length === 400, 'complete 400-game schedule required');
  same(r.implementation.map(x => x.path), IMPLEMENTATION, 'implementation inventory');
  for (const info of [...r.implementation, ...Object.values(r.modules), r.offline, r.runtime, ...r.evidence]) verified(info);
  validateReceipts(r);
  check(r.noRerunLedger === path.join(path.dirname(r.offline.path), '.hybrid-match-v1.started.json'), 'canonical one-shot ledger differs');
  check(process.versions.node === r.environment.node && process.versions.v8 === r.environment.v8 && process.platform === r.environment.platform && process.arch === r.environment.arch, 'registered runtime changed');
  return r;
}
function taskModules(r, task) { return { baseline: r.modules.shipped, candidate: r.modules[task.arm] }; }
function auditGame(rows, task, r) {
  check(rows.length >= 2, 'incomplete game');
  const header = rows[0], modules = taskModules(r, task), config = r.protocol;
  same(header, { schema: 'chessy.natural-runtime-game-header.v1', taskId: task.taskId,
    openingIndex: task.opening.index, openingName: task.opening.name, prefixUci: task.opening.prefixUci,
    timeMs: task.timeMs, candidateColor: task.candidateColor, maxPlies: config.maxSearchedPlies,
    maxDepth: config.maxDepth, modules: Object.fromEntries(Object.entries(modules).map(([k,v]) => [k,{sha256:v.sha256}])) }, 'game header');
  let state = N.replay(task.opening.prefixUci), ply = 0; const measured = [];
  check(Chess.toFen(state) === task.opening.fen, 'opening endpoint differs');
  for (const row of rows.slice(1, -1)) {
    check(!Chess.gameStatus(state).over && ply < config.maxSearchedPlies, 'move recorded after terminal state');
    const side = state.turn === task.candidateColor ? 'candidate' : 'baseline';
    check(row.schema === 'chessy.natural-runtime-move.v1' && row.taskId === task.taskId && row.ply === ply && row.color === state.turn &&
      row.moduleId === side && row.moduleSha256 === modules[side].sha256 && row.fenBefore === Chess.toFen(state), 'move identity/FEN/order differs');
    same(row.positions, state.positions, 'full-prefix repetition history');
    same(row.requested, { maxDepth: config.maxDepth, timeMs: task.timeMs, nodeLimit: 0, quiesce: config.quiesce }, 'equal time request');
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
function parseLines(bytes) {
  check(bytes.length && bytes[bytes.length - 1] === 10, 'truncated raw record');
  return bytes.toString().trimEnd().split('\n').map(line => { const row = JSON.parse(line); check(N.stable(row) === line, 'noncanonical raw row'); return row; });
}
function quantile(values, p) { const sorted = values.slice().sort((a,b)=>a-b), position = (sorted.length-1)*p, lo = Math.floor(position);
  return sorted[lo] + (sorted[Math.min(lo+1,sorted.length-1)]-sorted[lo])*(position-lo); }
function analyzeAudited(games, r) {
  same(games.map(g => g.taskId), r.tasks.map(t => t.taskId), 'audited game inventory');
  const byArm = {};
  for (const arm of r.protocol.arms) {
    const selected = games.filter(g => g.arm === arm), pairs = r.openings.map(o => {
      const pair = selected.filter(g => g.openingIndex === o.index);
      check(pair.length === 2 && new Set(pair.map(g=>g.candidateColor)).size === 2, 'incomplete color pair');
      return { op: o.index, pair: pair.reduce((s,g)=>s+g.candidateScore,0)/2 };
    });
    const stats = clusterStats(pairs), timing = {};
    for (const side of ['baseline','candidate']) {
      const moves = selected.flatMap(g=>g.measured.filter(m=>m.side===side));
      const totalElapsedMs = moves.reduce((s,m)=>s+m.elapsedMs,0), totalNodes = moves.reduce((s,m)=>s+m.nodes,0);
      timing[side] = { moves: moves.length, totalElapsedMs, totalNodes, nodesPerSecond: 1000*totalNodes/totalElapsedMs,
        meanCompletedDepth: moves.reduce((s,m)=>s+m.depth,0)/moves.length,
        meanObservedMs: totalElapsedMs/moves.length, medianObservedMs: quantile(moves.map(m=>m.elapsedMs),.5),
        p95ObservedMs: quantile(moves.map(m=>m.elapsedMs),.95), maximumObservedMs: Math.max(...moves.map(m=>m.elapsedMs)),
        overTwoTimesRequested: moves.filter(m=>m.elapsedMs>2*r.protocol.timeMs).length,
        depthHistogram: moves.reduce((a,m)=>{a[m.depth]=(a[m.depth]||0)+1;return a;},{}),
        stopReasons: moves.reduce((a,m)=>{a[m.stopReason]=(a[m.stopReason]||0)+1;return a;},{}) };
    }
    byArm[arm] = { games: selected.length, openingPairs: pairs.length,
      wins: selected.filter(g=>g.candidateScore===1).length, draws: selected.filter(g=>g.candidateScore===.5).length,
      losses: selected.filter(g=>g.candidateScore===0).length, candidateScore: stats.mean,
      descriptiveOpeningClusterLower95: stats.lo95, openingPairStandardDeviation: stats.sd,
      terminationReasons: selected.reduce((a,g)=>{a[g.reason]=(a[g.reason]||0)+1;return a;},{}), timing,
      meanObservedTimeRatio: timing.candidate.meanObservedMs/timing.baseline.meanObservedMs,
      aggregateNodesPerSecondRatio: timing.candidate.nodesPerSecond/timing.baseline.nodesPerSecond,
      formalPass: false, shippingOrEloClaimAllowed: false };
  }
  return byArm;
}
function auditDirectory(r, output, manifest) {
  check(manifest.status === 'completed' && manifest.formalPass === false && manifest.researchOnly === true, 'complete research manifest required');
  auditWarmup(r,output,manifest.warmup);
  same(manifest.games.map(g=>g.taskId), r.tasks.map(t=>t.taskId), 'complete raw game inventory');
  const games = r.tasks.map((task,index)=>{
    const info = manifest.games[index]; check(info.status === 'complete' && info.path === task.taskId+'.jsonl', 'raw game binding differs');
    const bytes = fs.readFileSync(path.join(output,info.path)); check(N.sha(bytes)===info.sha256 && bytes.length===info.bytes, 'raw game hash differs');
    const rows = parseLines(bytes); check(rows.length===info.rows, 'raw row count differs'); return auditGame(rows,task,r);
  });
  return analyzeAudited(games,r);
}
function auditWarmup(r,output,info) {
  check(info && info.status === 'complete' && info.path === 'warmup.jsonl', 'warmup binding missing');
  const bytes=fs.readFileSync(path.join(output,info.path));check(bytes.length===info.bytes&&N.sha(bytes)===info.sha256,'warmup hash differs');
  const rows=parseLines(bytes);check(rows.length===info.rows,'warmup row count differs');let serial=0;
  for(const index of r.protocol.warmup.openingIndices)for(const side of r.protocol.warmup.moduleOrder){
    const row=rows[serial++],state=N.replay(r.openings[index].prefixUci);
    check(row&&row.schema==='chessy.hybrid-match-warmup.v1'&&row.openingIndex===index&&row.moduleId===side&&
      row.moduleSha256===r.modules[side].sha256&&row.fenBefore===Chess.toFen(state),'warmup cell differs');
    same(row.positions,state.positions,'warmup history');
    same(row.requested,{maxDepth:r.protocol.maxDepth,timeMs:0,nodeLimit:r.protocol.warmup.nodesPerSearch,quiesce:true},'warmup budget');
    N.validateSearchResult(row.result,r.protocol.maxDepth,row.requested);
    check(Number.isFinite(row.elapsedMs)&&row.elapsedMs>0,'warmup elapsed time invalid');
    const named=Chess.sqName(row.result.move.from)+Chess.sqName(row.result.move.to)+(row.result.move.promotion||'').toLowerCase();
    check(named===row.result.moveUci,'warmup packed/UCI move differs');N.play(state,named);
  }
  check(serial===rows.length,'extra warmup rows');
}
async function childMain(registration) {
  const r = registration, engines = {};
  const emit = row => process.send(row);
  for (const side of ['shipped','hybrid','expanded']) engines[side] = await WasmEngine.load(verified(r.modules[side]).bytes);
  for (const index of r.protocol.warmup.openingIndices) for (const side of r.protocol.warmup.moduleOrder) {
    const requested = {maxDepth:r.protocol.maxDepth, timeMs:0, nodeLimit:r.protocol.warmup.nodesPerSearch, quiesce:true};
    const record = N.timedSearch(engines[side],side,r.modules[side].sha256,N.replay(r.openings[index].prefixUci),requested,emit);
    emit({schema:'chessy.hybrid-match-warmup.v1',openingIndex:index,...record});
  }
  emit({control:'warmup-complete'});
  for (const task of r.tasks) {
    N.playGame(task,{baseline:engines.shipped,candidate:engines[task.arm]},taskModules(r,task),r.protocol,emit);
    // Synchronous searches must yield to the IPC pipe between games. The final
    // callback also proves preceding raw records have left the child queue.
    await new Promise((resolve,reject)=>process.send({control:'game-flushed'},error=>error?reject(error):resolve()));
  }
  await new Promise((resolve,reject)=>process.send({control:'complete'},error=>error?reject(error):resolve()));
  process.disconnect();
}
async function run(args) {
  const r = preflight(args.registration,args['registration-sha256']);
  check(!fs.existsSync(args.output),'output directory must be new');
  // Ledger location is bound to the offline screen, not a caller-chosen output.
  newJson(r.noRerunLedger,{registrationSha256:args['registration-sha256'], startedAtUtc:new Date().toISOString(), output:args.output, scoreRerunAllowed:false});
  fs.mkdirSync(args.output,{recursive:false});
  const startedAtUtc = new Date().toISOString(), games = [];
  let writer = new N.Writer(path.join(args.output,'warmup.jsonl')), warmup, currentTask, failure = null, completed = false;
  const child = cp.fork(__filename,['--internal-child'],{stdio:['ignore','ignore','pipe','ipc']});
  let errorText = '', timer; child.stderr.on('data',bytes=>{errorText+=(bytes.toString());});
  const stop = message => { failure ||= message; child.kill('SIGKILL'); };
  const armTimer = () => { clearTimeout(timer); timer=setTimeout(()=>stop('search/startup watchdog expired'),r.protocol.searchWatchdogMs); };
  const workloadTimer=setTimeout(()=>stop('registered total workload watchdog expired'),r.protocol.workloadWatchdogMs);
  armTimer(); child.send(r);
  child.on('message',row=>{
    try {
      if(row.control==='failed'){stop(row.error);return;}
      if(row.control==='search-start'){armTimer();return;}
      if(row.control==='game-flushed'){armTimer();return;}
      if(row.control==='warmup-complete'){warmup=N.closeObserved(writer);writer=null;check(warmup.status==='complete','warmup evidence incomplete');armTimer();return;}
      if(row.control==='complete'){completed=true;clearTimeout(timer);return;}
      if(row.schema==='chessy.natural-runtime-game-header.v1') {
        check(!writer && games.length<r.tasks.length,'unexpected game header'); currentTask=r.tasks[games.length];
        check(row.taskId===currentTask.taskId,'game schedule differs');writer=new N.Writer(path.join(args.output,currentTask.taskId+'.jsonl'));
      }
      check(writer,'record outside a game');writer.append(row);
      if(row.schema==='chessy.natural-runtime-game-result.v1'){games.push({taskId:currentTask.taskId,...N.closeObserved(writer)});writer=null;
        if(games.length%20===0)console.log(JSON.stringify({stage:'progress',completedGames:games.length,plannedGames:r.tasks.length}));}
      armTimer();
    } catch(error) { stop(error.message); }
  });
  await new Promise(resolve=>{child.on('error',error=>{failure ||= error.message;});child.on('exit',code=>{
    clearTimeout(timer);clearTimeout(workloadTimer);if(code!==0||!completed)failure ||= 'child incomplete: '+errorText.slice(-1000);resolve();});});
  if(writer){const info=N.closeObserved(writer);if(currentTask)games.push({taskId:currentTask.taskId,...info});else warmup=info;}
  let analysis = null;
  const manifest = {schema:'chessy.hybrid-development-match-raw-manifest.v1', registration:identity(args.registration), startedAtUtc,
    completedAtUtc:new Date().toISOString(), status:failure?'failed':'completed',failure,warmup,games,
    researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false};
  if(!failure)try {preflight(args.registration,args['registration-sha256']);analysis=auditDirectory(r,args.output,manifest);}catch(error){failure=error.message;manifest.failure=failure;manifest.status='failed';}
  newJson(path.join(args.output,'raw-manifest.json'),manifest);
  const summary = {schema:'chessy.hybrid-development-match-summary.v1',status:failure?'failed':'completed',failure,
    registrationSha256:args['registration-sha256'],rawManifest:identity(path.join(args.output,'raw-manifest.json')),
    offlineTestEligible:r.offlineTestEligible,researchOnly:true,formalPass:false,shippingOrEloClaimAllowed:false,
    completedGames:games.length,plannedGames:r.tasks.length,byArm:failure?null:analysis};
  newJson(path.join(args.output,'summary.json'),summary);return summary;
}
function args(argv) {
  const command=argv[0], names=command==='register'?['shipped','hybrid','expanded','offline-report','runtime-receipt','runtime-source','output']:
    command==='run'||command==='audit'?['registration','registration-sha256','output']:null;
  check(names,'expected register, run or audit');const parsed={command};
  for(let i=1;i<argv.length;i+=2){const name=argv[i].replace(/^--/,'');check(argv[i].startsWith('--')&&names.includes(name)&&!Object.hasOwn(parsed,name)&&argv[i+1],'unknown/repeated/missing CLI option');parsed[name]=name.endsWith('sha256')?argv[i+1]:path.resolve(argv[i+1]);}
  check(names.every(name=>Object.hasOwn(parsed,name)),'all registered inputs required');return parsed;
}
if(require.main===module){
  if(process.argv[2]==='--internal-child')process.once('message',r=>childMain(r).catch(error=>{process.send({control:'failed',error:error.message});process.disconnect();process.exitCode=1;}));
  else (async()=>{const a=args(process.argv.slice(2));if(a.command==='register')return register(a);if(a.command==='run')return run(a);
    const r=preflight(a.registration,a['registration-sha256']);return auditDirectory(r,a.output,json(path.join(a.output,'raw-manifest.json')));})()
    .then(result=>{console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;})
    .catch(error=>{console.error('hybrid-match-v1: '+error.message);process.exitCode=1;});
}
module.exports={receipt,validateReceipts,openings,makeTasks,auditGame,analyzeAudited,parseLines,register,preflight,args,auditWarmup};
