#!/usr/bin/env node
/* Private, preregistered runtime diagnostics. Never edits evaluator assets.
 * Main-thread watchdogs supervise synchronous searches in worker threads.
 * Every partial record survives failure; incomplete runs are never scored.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { performance } = require('perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
require('../../assets/engine');
const Chess = globalThis.Chess;
const WasmEngine = require('../../assets/wasm-engine');
const Openings = require('../../test/ai-match-openings');
const ROOT = path.resolve(__dirname, '../..');
const PHASES = ['opening', 'middlegame', 'endgame'];
const WATCHDOG_MS = 30000;
const HEX = /^[a-f0-9]{64}$/;
const IMPLEMENTATION = [__filename, 'assets/engine.js', 'assets/wasm-engine.js',
  'test/ai-match-openings.js', 'test/ai-match-protocol.js'].map(p => path.isAbsolute(p) ? p : path.join(ROOT, p));
function check(ok, message) { if (!ok) throw new Error(message); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function snapshot(file, wanted) {
  check(HEX.test(wanted || ''), 'external artifact SHA-256 required');
  const bytes = fs.readFileSync(file);
  check(sha(bytes) === wanted, 'artifact SHA-256 differs: ' + file);
  return { path: path.resolve(file), sha256: wanted, bytes };
}
function jsonSnapshot(file, wanted) { const s = snapshot(file, wanted); s.value = JSON.parse(s.bytes); return s; }
function rehash(inputs) {
  for (const item of inputs) check(sha(fs.readFileSync(item.path)) === item.sha256, 'runtime input changed: ' + item.path);
}
function moveName(move) { return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase(); }
function play(state, uci) {
  const move = Chess.legalMoves(state).find(m => moveName(m) === uci);
  check(move, 'illegal recorded move ' + uci);
  // Preserve the complete repetition map without costly SAN formatting.
  const next = Chess.applyMove(state, move);
  next.positions = { ...state.positions };
  const key = Chess.positionKey(next);
  next.positions[key] = (next.positions[key] || 0) + 1;
  return next;
}
function replay(prefix) {
  check(Array.isArray(prefix), 'full UCI prefix required');
  let state = Chess.newGameState();
  for (const uci of prefix) state = play(state, uci);
  return state;
}
function openingPrefix(san) {
  let state = Chess.newGameState(); const prefix = [];
  const strip = s => s.replace(/[+#]$/, '');
  for (const token of san.split(' ')) {
    const legal = Chess.legalMoves(state);
    const matches = legal.filter(move => strip(Chess.toSan(state, move, legal)) === strip(token));
    check(matches.length === 1, 'historical opening SAN is ambiguous/illegal');
    const uci = moveName(matches[0]); prefix.push(uci); state = play(state, uci);
  }
  return { prefix, fen: Chess.toFen(state) };
}
function expectedOpeningIndices() {
  return Openings.map((_, index) => ({ index, priority: sha('natural-runtime-v1|' + index) }))
    .sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 20).map(item => item.index);
}
function validateRegistration(registration, contract) {
  check(registration.schema === 'chessy.natural-runtime-registration-data.v1' &&
    registration.formalHoldoutAccessAllowed === false && registration.incidentAccessAllowed === false, 'private registration scope differs');
  check(registration.openings.length === 20 && Openings.length === 100, 'frozen development opening count differs');
  check(stable(registration.openings.map(item => item.index)) === stable(expectedOpeningIndices()), 'development opening selection differs');
  for (const item of registration.openings) {
    const original = Openings[item.index], played = openingPrefix(original[1]);
    check(item.name === original[0] && item.san === original[1] && item.fen === played.fen &&
      stable(item.prefixUci) === stable(played.prefix), 'registered opening differs from the exposed historical catalog');
  }
  check(registration.benchPositions.length === contract.microbench.positions, 'registered benchmark position count differs');
  check(new Set(registration.benchPositions.map(item => item.id)).size === registration.benchPositions.length, 'duplicate benchmark position');
  for (const phase of PHASES) {
    const rows = registration.benchPositions.filter(item => item.phase === phase);
    check(rows.length === contract.microbench.perPhase && rows.every((row, i) => HEX.test(row.id) && (!i || rows[i-1].id < row.id)), 'benchmark phase/count/order differs');
  }
  for (const item of registration.benchPositions) {
    const state = replay(item.prefixUci);
    check(Chess.toFen(state) === item.fen && !Chess.gameStatus(state).over, 'benchmark full prefix/terminal state differs');
  }
}
function validateReceipt(receipt, contract, contractSha256) {
  check(receipt.schema === 'chessy.natural-runtime-build-parity.v1' && receipt.status === 'PASS' && receipt.researchOnly === true &&
    receipt.productionIntegrationAllowed === false && receipt.shippingOrEloClaimAllowed === false, 'private build/parity receipt must PASS');
  check(receipt.contractSha256 === contractSha256 && receipt.frozenSelectionSha256 === contract.candidate.frozenSelectionSha256 &&
    receipt.testReportSha256 === contract.candidate.testReportSha256, 'build receipt frozen identities differ');
  check(receipt.runtime && receipt.runtime.node === contract.toolchain.node && receipt.runtime.brotli === contract.toolchain.brotli &&
    process.versions.brotli === contract.toolchain.brotli, 'build receipt/runtime toolchain differs');
  const gates = receipt.gates;
  check(gates && gates.baselineRebuildByteIdentical === true && gates.parityMismatches === 0 &&
    gates.parityRows >= contract.parity.minimumNaturalRows && gates.authoredFixtureRows > 0 && gates.authoredFixtureMismatches === 0 && gates.sizePass === true, 'required private reproduction/parity/size gates missing');
  check(receipt.weightsSha256 === contract.candidate.weightsSha256, 'build receipt is for another frozen vector');
  const base = receipt.modules.baseline, candidate = receipt.modules.candidate;
  check(base.sha256 === contract.baseline.wasmSha256 && base.rawBytes === contract.baseline.rawBytes, 'runtime baseline identity differs');
  check(candidate.rawBytes <= contract.privateSizeGate.maximumRawBytes && candidate.brotliBytes <= contract.privateSizeGate.maximumBrotliBytes,
    'private candidate exceeds preregistered size gate');
  check(candidate.sha256 !== base.sha256, 'candidate and baseline modules are identical');
}
function preflight(args) {
  const c = jsonSnapshot(args.contract, args['contract-sha256']);
  const r = jsonSnapshot(args.registration, args['registration-sha256']);
  const b = jsonSnapshot(args['build-receipt'], args['build-receipt-sha256']);
  const contract = c.value;
  check(contract.schema === 'chessy.natural-runtime-private-contract.v1' && contract.frozenBeforeRuntimeMeasurements === true &&
    contract.researchOnly === true && contract.productionIntegrationAllowed === false, 'frozen private runtime contract required');
  check(process.versions.node === contract.toolchain.node, 'runtime Node version differs from the frozen toolchain');
  check(r.sha256 === contract.registrationData.sha256 && r.bytes.length === contract.registrationData.bytes, 'registered data binding differs');
  check(sha(fs.readFileSync(path.join(ROOT, 'assets/engine.js'))) === r.value.inputs.engine.sha256 &&
    sha(fs.readFileSync(path.join(ROOT, 'test/ai-match-openings.js'))) === r.value.inputs.historicalOpeningFile.sha256,
    'registration arbiter/opening implementation binding differs');
  validateRegistration(r.value, contract);
  validateReceipt(b.value, contract, c.sha256);
  const inputs = [c, r, b, ...IMPLEMENTATION.map(p => ({ path: p, sha256: sha(fs.readFileSync(p)) }))];
  check(Array.isArray(b.value.evidence) && b.value.evidence.length > 0, 'complete build evidence closure required');
  for (const entry of [...b.value.evidence, b.value.implementation, b.value.rowEvidence]) {
    const retained = snapshot(entry.path, entry.sha256);
    if (entry.bytes != null) check(retained.bytes.length === entry.bytes, 'build evidence byte count differs');
    inputs.push(retained);
  }
  const frozenOrigins = b.value.evidence.filter(entry => entry.sha256 === contract.candidate.frozenSelectionSha256);
  check(frozenOrigins.length === 1, 'canonical frozen fit-selection origin missing or duplicated');
  const canonicalOrigin = path.dirname(path.resolve(frozenOrigins[0].path));
  const parityBytes = snapshot(b.value.rowEvidence.path, b.value.rowEvidence.sha256).bytes;
  const parityRows = parityBytes.toString().trim().split('\n').map(line => JSON.parse(line));
  const parityCounts = { naturalRows: 0, naturalMismatches: 0, authoredRows: 0, authoredMismatches: 0, baselineMismatches: 0, candidateMismatches: 0, byRole: {} };
  const parityIds = new Set();
  for (const row of parityRows) {
    check(['shared-train','hce-validation','hce-test','authored'].includes(row.role) && !parityIds.has(row.role+':'+row.id), 'parity row role/identity differs');
    parityIds.add(row.role+':'+row.id);
    for (const field of ['baseline','referenceBaseline','affineBaseline','candidate','expectedCandidate']) check(Number.isSafeInteger(row[field]), 'parity score is not an integer');
    const badBase = row.baseline !== row.referenceBaseline || row.affineBaseline !== row.referenceBaseline;
    const badCandidate = row.candidate !== row.expectedCandidate;
    check(row.mismatch === (badBase || badCandidate), 'parity mismatch evidence differs');
    const prefix = row.role === 'authored' ? 'authored' : 'natural';
    parityCounts[prefix+'Rows']++; parityCounts[prefix+'Mismatches'] += Number(row.mismatch);
    parityCounts.baselineMismatches += Number(badBase); parityCounts.candidateMismatches += Number(badCandidate);
    parityCounts.byRole[row.role] = (parityCounts.byRole[row.role] || 0) + 1;
  }
  check(stable(parityCounts) === stable(b.value.counts) && parityCounts.naturalRows === b.value.gates.parityRows &&
    parityCounts.authoredRows === b.value.gates.authoredFixtureRows && parityCounts.naturalMismatches === 0 && parityCounts.authoredMismatches === 0,
    'raw parity evidence is incomplete or fails');
  const modules = {};
  for (const key of ['baseline', 'candidate']) {
    const info = b.value.modules[key], retained = snapshot(info.path, info.sha256);
    check(retained.bytes.length === info.rawBytes, 'private module byte size differs');
    check(b.value.evidence.some(entry => path.resolve(entry.path) === retained.path && entry.sha256 === retained.sha256), 'build evidence omitted private module');
    modules[key] = { ...info, bytes: retained.bytes }; inputs.push(retained);
  }
  let benchBinding;
  if (args.command === 'match') {
    const bench = jsonSnapshot(args['bench-summary'], args['bench-summary-sha256']);
    check(bench.value.schema === 'chessy.natural-runtime-bench-summary.v1' && bench.value.status === 'completed' &&
      bench.value.costGatePassed === true && bench.value.contract.sha256 === c.sha256 &&
      bench.value.registration.sha256 === r.sha256 && bench.value.buildReceipt.sha256 === b.sha256,
      'matches require the complete frozen fixed-node cost gate');
    check(bench.value.modules.baseline.sha256 === modules.baseline.sha256 &&
      bench.value.modules.candidate.sha256 === modules.candidate.sha256, 'cost gate modules differ');
    const raw = snapshot(path.join(path.dirname(bench.path), bench.value.records.path), bench.value.records.sha256);
    check(raw.bytes.length === bench.value.records.bytes, 'cost gate raw evidence size differs');
    const records = raw.bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    validateBenchInventory(records, r.value, contract.microbench, modules);
    const recomputed = benchAnalysis(records, contract.microbench);
    check(stable(recomputed.byBudget) === stable(bench.value.byBudget) && recomputed.costGatePassed === true,
      'raw benchmark does not reproduce the frozen cost gate');
    check(bench.value.records.rows === records.length, 'raw benchmark row count differs');
    for (const [filename, wanted] of Object.entries(bench.value.inputs)) inputs.push(snapshot(filename, wanted));
    inputs.push(bench, raw); benchBinding = { path: bench.path, sha256: bench.sha256 };
  }
  return { contract, registration: r.value, modules, inputs, canonicalOrigin,
    bindings: { contract: { path: c.path, sha256: c.sha256 }, registration: { path: r.path, sha256: r.sha256 },
      buildReceipt: { path: b.path, sha256: b.sha256 }, ...(benchBinding ? { benchSummary: benchBinding } : {}) } };
}
class Writer {
  constructor(file) { this.file = file; this.fd = fs.openSync(file, 'wx'); this.initial = fs.fstatSync(this.fd); this.bytes = 0; this.rows = 0; this.hash = crypto.createHash('sha256'); }
  intact() {
    const held = fs.fstatSync(this.fd), named = fs.lstatSync(this.file);
    check(named.isFile() && held.dev === this.initial.dev && held.ino === this.initial.ino && named.dev === held.dev && named.ino === held.ino &&
      held.size === this.bytes && named.size === this.bytes, 'runtime output path/descriptor identity changed');
  }
  append(row) {
    this.intact(); const bytes = Buffer.from(stable(row) + '\n'); let offset = 0;
    while (offset < bytes.length) { const written = fs.writeSync(this.fd, bytes, offset); check(written > 0, 'short output write'); offset += written; }
    this.bytes += bytes.length; this.rows++; this.hash.update(bytes); this.intact();
  }
  close() {
    this.intact(); fs.fsyncSync(this.fd); const wanted = this.hash.digest('hex');
    check(sha(fs.readFileSync(this.file)) === wanted, 'persisted runtime output hash differs'); fs.closeSync(this.fd);
    return { path: path.basename(this.file), sha256: wanted, bytes: this.bytes, rows: this.rows };
  }
}
function validateSearchResult(result, maxDepth, budget) {
  check(result && result.move && Number.isSafeInteger(result.nodes) && result.nodes > 0 &&
    Number.isSafeInteger(result.qnodes) && result.qnodes >= 0 && result.qnodes <= result.nodes &&
    Number.isSafeInteger(result.score) && result.scorePov === 'white' && Number.isSafeInteger(result.depth) && result.depth >= 0 && result.depth <= maxDepth &&
    (result.attemptedDepth === null || (Number.isSafeInteger(result.attemptedDepth) && result.attemptedDepth >= 1 && result.attemptedDepth <= maxDepth && result.attemptedDepth === result.depth + 1)), 'incoherent WASM search result');
  for (const field of ['cutoffs', 'researches']) check(Number.isSafeInteger(result[field]) && result[field] >= 0, 'incoherent search counter');
  check(result.cutoffs <= result.nodes, 'incoherent search cutoff count');
  if (result.stopReason === 'mate') check(result.depth >= 1 && result.attemptedDepth === null && Math.abs(result.score) >= 999000, 'incoherent mate result');
  if (result.stopReason === 'time-limit' || result.stopReason === 'node-limit') check(result.depth < maxDepth && (result.depth >= 1 || result.attemptedDepth === 1), 'incoherent interrupted depth');
  const allowed = budget.nodeLimit ? ['node-limit', 'max-depth', 'mate'] : ['time-limit', 'max-depth', 'mate'];
  check(allowed.includes(result.stopReason), 'unexpected search stop reason');
  if (budget.nodeLimit) check(result.nodes <= budget.nodeLimit && (result.stopReason !== 'node-limit' || result.nodes === budget.nodeLimit), 'fixed node budget violated');
  if (result.stopReason === 'max-depth') check(result.depth === maxDepth && result.attemptedDepth === null, 'incoherent completed depth');
}
function timedSearch(engine, moduleId, moduleSha256, state, requested, emit) {
  const fen = Chess.toFen(state), positions = { ...state.positions };
  emit({ control: 'search-start' });
  const start = performance.now();
  const result = engine.search(fen, { ...requested, positions });
  const elapsedMs = performance.now() - start;
  validateSearchResult(result, requested.maxDepth, requested);
  const moveUci = moveName(result.move);
  check(Chess.legalMoves(state).some(m => moveName(m) === moveUci), 'WASM returned an illegal move');
  check(Number.isFinite(elapsedMs) && elapsedMs > 0, 'invalid actual elapsed time');
  return { moduleId, moduleSha256, fenBefore: fen, positions, requested, result: { ...result, moveUci }, elapsedMs };
}
function makeTasks(registration, contract) {
  const tasks = [];
  for (const timeMs of contract.matches.timeBudgetsMs) for (const opening of registration.openings) for (const candidateColor of ['w', 'b']) {
    tasks.push({ taskId: `b${timeMs}-o${opening.index}-${candidateColor}`, timeMs, opening, candidateColor });
  }
  return tasks;
}
function playGame(task, engines, modules, config, emit) {
  let state = replay(task.opening.prefixUci), plies = 0;
  check(Chess.toFen(state) === task.opening.fen, 'opening replay changed');
  emit({ schema: 'chessy.natural-runtime-game-header.v1', taskId: task.taskId,
    openingIndex: task.opening.index, openingName: task.opening.name, prefixUci: task.opening.prefixUci,
    timeMs: task.timeMs, candidateColor: task.candidateColor, maxPlies: config.maxSearchedPlies,
    maxDepth: config.maxDepth, modules: Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, { sha256: value.sha256 }])) });
  while (plies < config.maxSearchedPlies && !Chess.gameStatus(state).over) {
    const color = state.turn, moduleId = color === task.candidateColor ? 'candidate' : 'baseline';
    const requested = { maxDepth: config.maxDepth, timeMs: task.timeMs, nodeLimit: 0, quiesce: config.quiesce };
    const record = timedSearch(engines[moduleId], moduleId, modules[moduleId].sha256, state, requested, emit);
    state = play(state, record.result.moveUci);
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
function runBench(registration, engines, modules, config, emit) {
  for (const nodeLimit of config.nodeBudgets) for (const [positionIndex, item] of registration.benchPositions.entries()) {
    const state = replay(item.prefixUci);
    for (let repeat = 0; repeat < config.warmupPairsPerPositionBudget + config.measuredPairsPerPositionBudget; repeat++) {
      const order = (positionIndex + repeat) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const moduleId of order) {
        const requested = { maxDepth: config.maxDepth, timeMs: 0, nodeLimit, quiesce: config.quiesce };
        const record = timedSearch(engines[moduleId], moduleId, modules[moduleId].sha256, state, requested, emit);
        emit({ schema: 'chessy.natural-runtime-bench-record.v1', positionId: item.id, positionIndex,
          phase: item.phase, prefixUci: item.prefixUci, repeat, warmup: repeat < config.warmupPairsPerPositionBudget, ...record });
      }
    }
  }
}
function quantile(values, probability) {
  const a = values.slice().sort((x, y) => x-y), p = (a.length-1)*probability, i = Math.floor(p);
  return a[i] + (a[Math.min(i+1,a.length-1)]-a[i])*(p-i);
}
function validateBenchInventory(records, registration, config, modules) {
  let serial = 0;
  for (const nodeLimit of config.nodeBudgets) for (const [positionIndex, item] of registration.benchPositions.entries()) {
    const state = replay(item.prefixUci);
    for (let repeat=0; repeat<config.warmupPairsPerPositionBudget+config.measuredPairsPerPositionBudget; repeat++) {
      const order = (positionIndex+repeat)%2 ? ['candidate','baseline'] : ['baseline','candidate'];
      for (const moduleId of order) {
        const row = records[serial++];
        check(row && row.schema === 'chessy.natural-runtime-bench-record.v1' && row.positionId === item.id && row.positionIndex === positionIndex &&
          row.phase === item.phase && row.repeat === repeat && row.warmup === (repeat < config.warmupPairsPerPositionBudget) &&
          row.moduleId === moduleId && row.moduleSha256 === modules[moduleId].sha256 && row.fenBefore === item.fen &&
          stable(row.prefixUci) === stable(item.prefixUci) && stable(row.positions) === stable(state.positions) &&
          stable(row.requested) === stable({maxDepth:config.maxDepth,timeMs:0,nodeLimit,quiesce:config.quiesce}) &&
          Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, 'benchmark raw cell/order/history differs from registration');
        validateSearchResult(row.result,config.maxDepth,row.requested);
        check(row.result.moveUci === moveName(row.result.move) && Chess.legalMoves(state).some(m=>moveName(m)===row.result.moveUci), 'benchmark returned illegal/mismatched move');
      }
    }
  }
  check(serial === records.length, 'benchmark has unregistered extra rows');
}
function benchAnalysis(records, config) {
  const byBudget = {};
  for (const nodeLimit of config.nodeBudgets) {
    const measured = records.filter(row => !row.warmup && row.requested.nodeLimit === nodeLimit);
    check(measured.length === config.positions * config.measuredPairsPerPositionBudget * 2, 'incomplete measured benchmark inventory');
    const pairs = new Map(), sides = { baseline: { nodes: 0, ms: 0, times: [] }, candidate: { nodes: 0, ms: 0, times: [] } };
    for (const row of measured) {
      const key = row.positionId + '|' + row.repeat, pair = pairs.get(key) || {};
      check(!pair[row.moduleId], 'duplicate benchmark pair cell'); pair[row.moduleId] = row; pairs.set(key, pair);
      const side = sides[row.moduleId]; side.nodes += row.result.nodes; side.ms += row.elapsedMs; side.times.push(row.elapsedMs);
    }
    const ratios = [...pairs.values()].map(pair => { check(pair.baseline && pair.candidate, 'missing benchmark pair side');
      return (pair.candidate.result.nodes/pair.candidate.elapsedMs)/(pair.baseline.result.nodes/pair.baseline.elapsedMs); });
    const medianPairedNpsRatio = quantile(ratios, .5);
    const aggregateNpsRatio = (sides.candidate.nodes/sides.candidate.ms)/(sides.baseline.nodes/sides.baseline.ms);
    byBudget[nodeLimit] = { pairs: ratios.length, medianPairedNpsRatio, aggregateNpsRatio,
      baseline: { totalNodes: sides.baseline.nodes, totalElapsedMs: sides.baseline.ms, p90ElapsedMs: quantile(sides.baseline.times,.9) },
      candidate: { totalNodes: sides.candidate.nodes, totalElapsedMs: sides.candidate.ms, p90ElapsedMs: quantile(sides.candidate.times,.9) },
      pass: medianPairedNpsRatio >= config.minimumMedianPairedNpsRatio && aggregateNpsRatio >= config.minimumAggregateNpsRatio };
  }
  return { byBudget, costGatePassed: Object.values(byBudget).every(item => item.pass) };
}
function supervised(data, writer, record) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: data });
    let timer, completed=false, failure=null, outputBroken=false;
    const stop = error => { failure ||= error; clearTimeout(timer); worker.terminate().catch(e=>{failure ||= e;}); };
    const arm = () => { if(failure)return; clearTimeout(timer); timer=setTimeout(()=>stop(new Error('runtime search/startup watchdog expired')),WATCHDOG_MS); };
    arm();
    worker.on('message', message => {
      if(message.control==='search-start')return arm();
      if(message.control==='complete'){completed=true;clearTimeout(timer);return;}
      if(message.control==='failed')return stop(new Error(message.error));
      if(outputBroken)return;
      try{writer.append(message);record(message);arm();}catch(error){outputBroken=true;stop(error);}
    });
    worker.on('error',error=>{failure ||= error;clearTimeout(timer);});
    worker.on('exit',code=>{clearTimeout(timer);if(failure)reject(failure);else if(code===0&&completed)resolve();else reject(new Error('runtime worker exited without complete evidence'));});
  });
}
function closeObserved(writer) {
  try { return {status:'complete',...writer.close()}; }
  catch(error){
    try{fs.closeSync(writer.fd);}catch(_){}
    let observed={};
    try{const bytes=fs.readFileSync(writer.file);observed={sha256:sha(bytes),bytes:bytes.length};}catch(_){}
    return {path:path.basename(writer.file),status:'invalid',rows:writer.rows,error:error.message,...observed};
  }
}
async function run(args) {
  const input = preflight(args), { contract, registration, modules } = input;
  check(!fs.existsSync(args.output), 'runtime output directory must be new');
  const stateDirectory = path.join(input.canonicalOrigin, 'runtime', '.runtime-state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const attemptKey = sha(stable([input.bindings.contract.sha256, args.command]));
  const activePath=path.join(stateDirectory,'active-workload.lock'),activeFd=fs.openSync(activePath,'wx'),activeIdentity=fs.fstatSync(activeFd);
  try {
  const attempt = new Writer(path.join(stateDirectory, attemptKey + '.started.json'));
  attempt.append({ phase: args.command, startedAtUtc: new Date().toISOString(), ...input.bindings, output: args.output,
    rerunAllowed: false }); attempt.close();
  fs.mkdirSync(args.output, { recursive: false });
  const moduleInfo = Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, { path: value.path, sha256: value.sha256, rawBytes: value.rawBytes, brotliBytes: value.brotliBytes }]));
  const common = { ...input.bindings, modules: moduleInfo, contractSha256: input.bindings.contract.sha256,
    registrationSha256: input.bindings.registration.sha256, researchOnly: true, shippingOrEloClaimAllowed: false,
    startedAtUtc: new Date().toISOString(), environment: { node: process.versions.node, platform: process.platform,
      arch: process.arch, cpus: os.cpus().map(cpu => cpu.model), watchdogMs: WATCHDOG_MS },
    inputs: Object.fromEntries(input.inputs.map(item => [item.path, item.sha256])) };
  let summary;
  if (args.command === 'bench') {
    const writer = new Writer(path.join(args.output, 'bench-records.jsonl')), records = []; let failure = null;
    try { await supervised({ kind: 'bench', registration, modules, config: contract.microbench }, writer, row => records.push(row)); }
    catch (error) { failure = error.message; }
    const binding = closeObserved(writer); if(binding.status!=='complete')failure ||= binding.error;
    let analysis={costGatePassed:false};
    if(!failure)try{validateBenchInventory(records,registration,contract.microbench,modules);analysis=benchAnalysis(records,contract.microbench);}catch(error){failure=error.message;}
    summary = { ...common, schema: 'chessy.natural-runtime-bench-summary.v1', status: failure ? 'failed' : 'completed', records: binding,
      failure, ...analysis };
  } else {
    const tasks = makeTasks(registration, contract), games = [], outcomes = [], moves = [], failures = [];
    check(tasks.length === contract.matches.totalGames, 'registered game count differs');
    for (let first = 0; first < tasks.length && !failures.length; first += contract.matches.concurrentGames) {
      const wave = tasks.slice(first, first + contract.matches.concurrentGames);
      const results = await Promise.allSettled(wave.map(async task => {
        const writer = new Writer(path.join(args.output, task.taskId + '.jsonl'));
        try { await supervised({ kind: 'game', task, modules, config: contract.matches }, writer, row => {
          if (row.schema === 'chessy.natural-runtime-game-result.v1') outcomes.push(row);
          if (row.schema === 'chessy.natural-runtime-move.v1') moves.push({ taskId: row.taskId, moduleId: row.moduleId, elapsedMs: row.elapsedMs, nodes: row.result.nodes });
        }); } finally { const closed=closeObserved(writer);games.push({taskId:task.taskId,...closed});if(closed.status!=='complete')failures.push({taskId:task.taskId,error:closed.error}); }
      }));
      results.forEach((result, i) => { if (result.status === 'rejected') failures.push({ taskId: wave[i].taskId, error: result.reason.message }); });
    }
    summary = { ...common, schema: 'chessy.natural-runtime-match-summary.v1', status: failures.length ? 'failed' : 'completed',
      games: games.sort((a,b) => tasks.findIndex(t => t.taskId === a.taskId)-tasks.findIndex(t => t.taskId === b.taskId)),
      outcomes: outcomes.sort((a,b) => a.taskId.localeCompare(b.taskId)), failures,
      plannedTaskIds: tasks.map(task=>task.taskId),unattemptedTaskIds: tasks.filter(task=>!games.some(game=>game.taskId===task.taskId)).map(task=>task.taskId),
      analysisStatus: 'requires-independent-complete-game-audit-before-score-analysis', searchedMoves: moves.length,
      timing: Object.fromEntries(['baseline','candidate'].map(side => { const rows = moves.filter(row => row.moduleId === side);
        return [side, { moves: rows.length, totalElapsedMs: rows.reduce((s,row) => s+row.elapsedMs,0), totalNodes: rows.reduce((s,row) => s+row.nodes,0) }]; })) };
  }
  try { rehash(input.inputs); } catch (error) { summary.status = 'failed'; summary.integrityFailure = error.message; summary.costGatePassed = false; }
  summary.completedAtUtc = new Date().toISOString();
  const writer = new Writer(path.join(args.output, 'summary.json')); writer.append(summary); writer.close();
  return summary;
  } finally {
    try{const current=fs.lstatSync(activePath);if(current.dev===activeIdentity.dev&&current.ino===activeIdentity.ino)fs.unlinkSync(activePath);}catch(_){}
    fs.closeSync(activeFd);
  }
}
function parseArgs(argv) {
  const command = argv[0]; check(['bench','match'].includes(command), 'command must be bench or match');
  const names = ['contract','contract-sha256','registration','registration-sha256','build-receipt','build-receipt-sha256','output',
    ...(command === 'match' ? ['bench-summary','bench-summary-sha256'] : [])];
  const args = { command };
  for (let i=1;i<argv.length;i+=2) { const name=argv[i].replace(/^--/,'');
    check(argv[i].startsWith('--') && names.includes(name) && !Object.hasOwn(args,name) && argv[i+1], 'invalid/duplicate/missing CLI option'); args[name]=argv[i+1]; }
  check(names.every(name => Object.hasOwn(args,name)), 'all frozen artifact paths and external hashes are required');
  for (const name of names) if (!name.endsWith('sha256')) args[name]=path.resolve(args[name]);
  return args;
}
async function workerMain(data) {
  const emit = value => parentPort.postMessage(value), engines = {};
  for (const key of ['baseline','candidate']) { check(sha(data.modules[key].bytes) === data.modules[key].sha256, 'worker module bytes differ'); engines[key]=await WasmEngine.load(data.modules[key].bytes); }
  if (data.kind === 'bench') runBench(data.registration,engines,data.modules,data.config,emit);
  else playGame(data.task,engines,data.modules,data.config,emit);
  emit({ control:'complete' });
}
if (!isMainThread) workerMain(workerData).catch(error => parentPort.postMessage({ control:'failed',error:error.message }));
else if (require.main === module) run(parseArgs(process.argv.slice(2))).then(summary => {
  console.log(stable({ status:summary.status, schema:summary.schema, costGatePassed:summary.costGatePassed ?? null }));
  if(summary.status!=='completed')process.exitCode=1;
}).catch(error => { console.error('natural-runtime-run: '+error.message); process.exitCode=1; });
module.exports = { sha, stable, snapshot, rehash, replay, play, openingPrefix, expectedOpeningIndices, validateRegistration,
  validateReceipt, validateSearchResult, validateBenchInventory, closeObserved, timedSearch, makeTasks, playGame, runBench, benchAnalysis, Writer, parseArgs, preflight, run };
