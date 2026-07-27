/*
 * Coaching-analysis service (Phase 3a) — run with:
 *   node test/analysis-service.test.js
 *
 * The service is the transport/cancellation/watchdog/cache layer around the
 * analysis contract. These tests inject a FAKE worker (so the "worker thread"
 * is observable and controllable in-process) and a FAKE CoachStore (in-memory),
 * exercising: worker-result-matches-core, supersede/cancel/stale suppression,
 * watchdog retry + graceful final failure, cache identity separation, partial
 * (complete:false) preservation, and the guarantee that the heavy search never
 * runs on the main thread.
 *
 * The E3b runtime tranche (#87) extends this with the service-level
 * contracts the eval scorecard deliberately does not grade:
 *   cache    — a persisted record is served bit-identically with provenance
 *              intact and no recompute, and only after re-passing the same
 *              validation gate as a live worker reply (a corrupted record is
 *              recomputed, never served);
 *   cancel   — a superseded or cancelled job never publishes: its promise is
 *              null, its late replies write neither the persistent cache nor
 *              the in-memory handoff, and one interactive job holds under a
 *              rapid re-request storm.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
require('../assets/analysis-core.js');
require('../assets/analysis-service.js');
const Chess = globalThis.Chess;
const Core = globalThis.ChessyAnalysisCore;
const Svc = globalThis.ChessyAnalysisService;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function norm(r) { if (!r) return r; const c = JSON.parse(JSON.stringify(r)); c.elapsedMs = 0; return JSON.stringify(c); }

const FAST = { maxDepth: 3, nodeLimit: 8000, multiPV: 3, nodeBudget: 200000 };
const START = Chess.START_FEN;

// ---- Fake worker: mirrors assets/analysis-worker.js, but the test drives it.
const PROTOCOL = Svc.PROTOCOL;
let made = [];
function FakeWorker(behavior) {
  this.behavior = behavior || {};
  this.onmessage = null; this.onerror = null;
  this.terminated = false; this.posts = [];
  made.push(this);
}
FakeWorker.prototype.postMessage = function (msg) {
  this.posts.push(msg);
  const self = this;
  const b = this.behavior;
  if (b.mode === 'normal' || b.mode === 'wrongfp') {
    setTimeout(function () {
      if (self.terminated) return;
      const state = Chess.parseFen(msg.fen);
      const opts = Object.assign({}, msg.opts);
      if (msg.positions) opts.positions = msg.positions;
      const result = Core.analyse(state, opts);
      if (b.mode === 'wrongfp') result.positionFingerprint = 'TAMPERED';
      self.deliver({ v: PROTOCOL, jobId: msg.jobId, result: result });
    }, 0);
  } else if (b.mode === 'error') {
    setTimeout(function () { self.deliver({ v: PROTOCOL, jobId: msg.jobId, error: 'boom' }); }, 0);
  } else if (b.mode === 'crash') {
    setTimeout(function () { self.crash(); }, 0);
  } /* 'stall': never replies */
};
FakeWorker.prototype.terminate = function () { this.terminated = true; };
FakeWorker.prototype.deliver = function (reply) { if (!this.terminated && this.onmessage) this.onmessage({ data: reply }); };
FakeWorker.prototype.crash = function () { if (!this.terminated && this.onerror) this.onerror({}); };

function factoryOf() {
  const behaviors = Array.prototype.slice.call(arguments);
  let i = 0;
  return function () { const b = behaviors[Math.min(i, behaviors.length - 1)]; i++; return new FakeWorker(b); };
}

// ---- Fake in-memory CoachStore (analyses only).
function makeStore() {
  const map = new Map();
  return {
    _map: map,
    analysisKey: function (g, p, f, e, c) { return [g, p, f, e, c].join('|'); },
    getAnalysis: function (k) { return Promise.resolve(map.get(k)); },
    putAnalysis: function (rec) { map.set(rec.key, rec); return Promise.resolve(); }
  };
}

// ---- E3b helpers: seeded persistent records, gated lookups.
function cloneJson(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// The cache identity EXACTLY as the service computes it before dispatch
// (buildOpts folds req.positions into opts, then ChessyAnalysisCore.identity).
function identOf(req) {
  const opts = Object.assign({}, req.opts || {});
  if (req.positions) opts.positions = req.positions;
  return Core.identity(Chess.parseFen(req.fen), opts);
}

// A record shaped exactly like the service's persist() would write it,
// simulating a prior session's validated write (or, when `result` is
// deliberately mismatched, a corrupted/miswritten row under a correct key).
function recordFor(store, req, result) {
  const ident = identOf(req);
  const key = store.analysisKey(
    req.gameId, req.ply, ident.positionFingerprint, ident.engineId, ident.configHash);
  return { key: key, ident: ident, rec: {
    key: key, gameId: req.gameId, ply: req.ply, gameRev: req.gameRev,
    fingerprint: ident.positionFingerprint,
    engineId: ident.engineId, configHash: ident.configHash,
    complete: result.complete !== false, result: result, createdAt: 1
  } };
}

function seedRecord(store, req, result) {
  const r = recordFor(store, req, result);
  store._map.set(r.key, r.rec);
  return r;
}

// A store whose getAnalysis promises resolve only when the test releases them,
// so a cancel/supersede can be interleaved INSIDE the lookup window.
function gatedStore() {
  const map = new Map(), gates = [];
  return {
    _map: map, _gates: gates,
    analysisKey: function (g, p, f, e, c) { return [g, p, f, e, c].join('|'); },
    getAnalysis: function () {
      const gate = {};
      gate.promise = new Promise(function (r) { gate.release = r; });
      gates.push(gate);
      return gate.promise;
    },
    putAnalysis: function (rec) { map.set(rec.key, rec); return Promise.resolve(); }
  };
}

function reset(opts) {
  made = [];
  Svc.cancel();
  global.CoachStore = (opts && 'store' in opts) ? opts.store : undefined;
  global.CHESSY_ANALYSIS_WORKER_FACTORY = opts && opts.factory;
  global.CHESSY_ANALYSIS_WATCHDOG_MS = opts && opts.watchdog;
}

const REQ = { gameId: 'g1', ply: 4, gameRev: 1, fen: START, positions: null, opts: FAST };

(async function () {
  // --- Worker result matches direct analysis-core output (apart from elapsed) ---
  reset({ factory: factoryOf({ mode: 'normal' }) });
  const viaWorker = await Svc.analyse(Object.assign({}, REQ));
  const direct = Core.analyse(Chess.parseFen(START), FAST);
  check(viaWorker && norm(viaWorker) === norm(direct),
    'the worker result is byte-identical to a direct analysis-core call (excluding elapsed)');

  // --- Cache: a second identical request is a hit and dispatches no worker ---
  const store = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: store });
  const first = await Svc.analyse(Object.assign({}, REQ));
  const dAfterFirst = Svc.stats().dispatches;
  const second = await Svc.analyse(Object.assign({}, REQ));
  check(first && second && norm(first) === norm(second) && Svc.stats().dispatches === dAfterFirst,
    'an identical repeat request is served from cache with no new worker dispatch');
  check(store._map.size === 1, 'the validated result was persisted to the cache');

  // A broken cache adapter must not hold the interactive lane forever. Keep a
  // bounded in-memory handoff so an immediate reflection still reuses the scan
  // result without a second worker dispatch while putAnalysis never settles.
  const heldStore = makeStore();
  heldStore.putAnalysis = function () { return new Promise(function () {}); };
  reset({ factory: factoryOf({ mode: 'normal' }), store: heldStore });
  const heldRace = await Promise.race([
    Svc.analyse(Object.assign({}, REQ, { gameId: 'held-cache' })),
    delay(100).then(function () { return 'timed-out'; })
  ]);
  check(heldRace !== 'timed-out' && heldRace !== null,
    'a never-settling best-effort cache write cannot hang analysis');
  const cachedFirst = heldRace;
  const dHeld = Svc.stats().dispatches;
  const cachedSecond = await Svc.analyse(Object.assign({}, REQ, { gameId: 'held-cache' }));
  check(cachedFirst && cachedSecond && Svc.stats().dispatches === dHeld,
    'an immediate follow-up reuses the in-memory handoff without redispatch');

  const failingStore = makeStore();
  failingStore.putAnalysis = function () { return Promise.reject(new Error('quota')); };
  reset({ factory: factoryOf({ mode: 'normal' }), store: failingStore });
  check((await Svc.analyse(Object.assign({}, REQ, { gameId: 'cache-fails' }))) !== null,
    'a failed best-effort cache write does not hide a valid analysis result');

  // --- Cache separates configurations, halfmove clocks and repetition histories ---
  reset({ factory: factoryOf({ mode: 'normal' }), store: store });
  await Svc.analyse(Object.assign({}, REQ, { opts: Object.assign({}, FAST, { multiPV: 2 }) }));
  await Svc.analyse(Object.assign({}, REQ, { fen: '8/8/8/8/8/5k2/8/R6K w - - 40 1' }));
  await Svc.analyse(Object.assign({}, REQ, { positions: (function () { const r = {}; r[Chess.positionKey(Chess.parseFen(START))] = 2; return r; })() }));
  check(store._map.size === 4,
    'a differing config, halfmove clock or repetition history each key a distinct cache entry');

  // --- Cache separates the played move: playedLine/classification are derived
  //     from playedMove, so the same position with a different played move must
  //     re-dispatch and return its OWN verdict, not the first request's. ---
  const storePM = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }, { mode: 'normal' }), store: storePM });
  const e2e4 = { from: Chess.sqIndex('e2'), to: Chess.sqIndex('e4'), promotion: null };
  const d2d4 = { from: Chess.sqIndex('d2'), to: Chess.sqIndex('d4'), promotion: null };
  const pmFirst = await Svc.analyse(Object.assign({}, REQ, { gameId: 'pm', opts: Object.assign({}, FAST, { playedMove: e2e4 }) }));
  const dPM = Svc.stats().dispatches;
  const pmSecond = await Svc.analyse(Object.assign({}, REQ, { gameId: 'pm', opts: Object.assign({}, FAST, { playedMove: d2d4 }) }));
  check(Svc.stats().dispatches === dPM + 1 && storePM._map.size === 2 &&
    pmFirst.playedLine && pmSecond.playedLine &&
    pmFirst.playedLine.uci === 'e2e4' && pmSecond.playedLine.uci === 'd2d4',
    'a different played move keys a distinct cache entry (its own playedLine, not the first\'s)');

  // --- Game revision: a stale-revision cache record is NOT a hit (re-dispatch) ---
  const store2 = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }, { mode: 'normal' }), store: store2 });
  await Svc.analyse(Object.assign({}, REQ, { gameRev: 1 }));
  const dRev = Svc.stats().dispatches;
  await Svc.analyse(Object.assign({}, REQ, { gameRev: 2 })); // same position, revised game
  check(Svc.stats().dispatches === dRev + 1,
    'a cache record from a superseded game revision is ignored and the analysis re-runs');

  // --- complete:false is preserved through the worker and the cache ---
  const store3 = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: store3 });
  // A tiny nodeBudget forces the deep-verify to abort → complete:false.
  const partialReq = Object.assign({}, REQ, { gameId: 'gp', opts: { maxDepth: 4, nodeLimit: 8000, multiPV: 3, nodeBudget: 1 } });
  const partial = await Svc.analyse(partialReq);
  const storedPartial = Array.from(store3._map.values())[0];
  check(partial && partial.complete === false && storedPartial && storedPartial.complete === false &&
    storedPartial.result.complete === false,
    'a partial (complete:false) result is preserved and never stored as complete');

  // --- Supersede: a newer request cancels the previous, whose promise is null ---
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'normal' }) });
  const abandoned = Svc.analyse(Object.assign({}, REQ, { gameId: 'A' }));
  const winner = Svc.analyse(Object.assign({}, REQ, { gameId: 'B' }));
  const aRes = await abandoned;
  const bRes = await winner;
  check(aRes === null && bRes && bRes.turn === 'w',
    'a superseding request cancels the in-flight one (its promise resolves null)');
  check(made[0].terminated === true, 'the superseded job\'s worker was terminated');

  // --- Stale reply suppression: a superseded/foreign reply arriving WHILE the
  //     new job is still in flight must not settle or corrupt it; the new job
  //     completes on its own reply. ---
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'stall' }) });
  const s1 = Svc.analyse(Object.assign({}, REQ, { gameId: 'S1' }));
  const staleWorker = made[0];
  const p2 = Svc.analyse(Object.assign({}, REQ, { gameId: 'S2' })); // supersedes S1
  const activeWorker = made[1];
  const staleId = staleWorker.posts[0].jobId;   // the superseded job's real id
  const activeId = activeWorker.posts[0].jobId;  // the active job's real id
  const goodResult = Core.analyse(Chess.parseFen(START), FAST);
  check((await s1) === null, 'the superseded job resolves null');
  // (a) a late, otherwise-valid reply carrying the SUPERSEDED job's id
  staleWorker.terminated = false;
  staleWorker.deliver({ v: PROTOCOL, jobId: staleId, result: goodResult });
  // (b) a well-formed reply with a FOREIGN id on the active worker
  activeWorker.deliver({ v: PROTOCOL, jobId: activeId + 1000, result: goodResult });
  // (c) a wrong-protocol reply carrying the active id
  activeWorker.deliver({ v: PROTOCOL + 998, jobId: activeId, result: goodResult });
  await delay(5);
  let settledEarly = false;
  p2.then(function () { settledEarly = true; });
  await delay(5);
  check(settledEarly === false,
    'superseded-id, foreign-id and wrong-protocol replies never settle the active job');
  // The active job settles ONLY on its own valid reply.
  activeWorker.deliver({ v: PROTOCOL, jobId: activeId, result: goodResult });
  const okB = await p2;
  check(okB && okB.turn === 'w',
    'the active job completes on its OWN reply, uncorrupted by the stale/foreign ones');

  // --- Cancel: an explicit cancel resolves the in-flight promise null ---
  reset({ factory: factoryOf({ mode: 'stall' }) });
  const cancelled = Svc.analyse(Object.assign({}, REQ, { gameId: 'C' }));
  Svc.cancel();
  check((await cancelled) === null && made[0].terminated === true,
    'cancel() terminates the worker and resolves the in-flight promise null');

  // --- Owner-scoped cancel: a stale scan pause cannot kill a newer reflection.
  //     Global cancel remains available to destructive data controls. ---
  reset({ factory: factoryOf({ mode: 'stall' }) });
  const owned = Svc.analyse(Object.assign({}, REQ, { gameId: 'owned' }), 'reflection');
  const ownedWorker = made[0];
  Svc.cancel('moment-scan');
  let ownedSettled = false;
  owned.then(function () { ownedSettled = true; });
  await delay(5);
  check(!ownedSettled && ownedWorker.terminated === false,
    'cancel(owner) leaves another subsystem owner running');
  Svc.cancel('reflection');
  check((await owned) === null && ownedWorker.terminated === true,
    'cancel(owner) terminates and settles only its matching job');

  // Starting a new request still supersedes regardless of owners: interactive
  // reflection must never queue behind a background scan.
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'normal' }) });
  const scanJob = Svc.analyse(Object.assign({}, REQ, { gameId: 'scan' }), 'moment-scan');
  const reflectionJob = Svc.analyse(
    Object.assign({}, REQ, { gameId: 'reflection' }), 'reflection');
  check((await scanJob) === null && (await reflectionJob) !== null &&
    made[0].terminated === true,
    'a newer owner supersedes the active job instead of waiting in a queue');

  // --- Watchdog: a wedged worker is retried once in a fresh worker ---
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'normal' }), watchdog: 25 });
  const recovered = await Svc.analyse(Object.assign({}, REQ, { gameId: 'W' }));
  check(recovered && recovered.turn === 'w' && made.length === 2 && made[0].terminated === true,
    'a wedged worker trips the watchdog and the analysis succeeds on a fresh-worker retry');

  // --- Crash: a worker onerror also triggers the one retry ---
  reset({ factory: factoryOf({ mode: 'crash' }, { mode: 'normal' }) });
  const afterCrash = await Svc.analyse(Object.assign({}, REQ, { gameId: 'X' }));
  check(afterCrash && afterCrash.turn === 'w' && made.length === 2,
    'a crashing worker is recovered by the single fresh-worker retry');

  // --- Graceful final failure: repeated wedging exhausts the retry → null ---
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'stall' }, { mode: 'stall' }), watchdog: 20 });
  const gaveUp = await Svc.analyse(Object.assign({}, REQ, { gameId: 'F' }));
  check(gaveUp === null, 'after the initial worker and its one retry both wedge, the probe resolves null');

  // --- No synchronous main-thread fallback: with no worker at all, the heavy
  //     search is NEVER run on the main thread; the probe resolves null. ---
  reset({}); // no factory, and Node has no global Worker
  let coreCalls = 0;
  const origAnalyse = Core.analyse;
  Core.analyse = function () { coreCalls++; return origAnalyse.apply(this, arguments); };
  const noWorker = await Svc.analyse(Object.assign({}, REQ, { gameId: 'N' }));
  Core.analyse = origAnalyse;
  check(noWorker === null && coreCalls === 0,
    'with no worker available the search never runs on the main thread (contract not invoked)');

  // --- A validation-failing reply (wrong fingerprint) is neither shown nor cached ---
  const store4 = makeStore();
  reset({ factory: factoryOf({ mode: 'wrongfp' }), store: store4 });
  const tampered = await Svc.analyse(Object.assign({}, REQ, { gameId: 'T' }));
  check(tampered === null && store4._map.size === 0,
    'a reply that does not match the requested position is rejected and not cached');

  // ====================== E3b §1 — cache (#87) ======================

  // --- Cold persistent hit: a record from a PRIOR SESSION (fresh gameId, so
  //     the in-memory handoff is cold) is served without recompute — the very
  //     object the store returned, provenance intact — and no worker is even
  //     constructed. ---
  const coldStore = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: coldStore });
  const coldReq = Object.assign({}, REQ, { gameId: 'e3b-cold' });
  const coldTruth = Core.analyse(Chess.parseFen(START), FAST);
  const coldSeed = seedRecord(coldStore, coldReq, coldTruth);
  const dCold = Svc.stats().dispatches;
  const coldRes = await Svc.analyse(Object.assign({}, coldReq));
  check(coldRes === coldTruth && Svc.stats().dispatches === dCold && made.length === 0,
    'a validated record from a prior session is served as-is: no dispatch, no worker, no recompute');
  check(!!coldRes && coldRes.engine.id === Core.ENGINE_ID &&
    coldRes.engine.version === Core.ENGINE_VERSION &&
    coldRes.engine.configHash === coldSeed.ident.configHash &&
    coldRes.positionFingerprint === coldSeed.ident.positionFingerprint,
    'the served result keeps its provenance (engine id/version/configHash, fingerprint) intact');

  // A budget-capped partial that was honestly persisted is served back still
  // partial: the data half of the reflection-panel rule (assets/reflection.js
  // shows a partial as visibly partial — the transport must never let a
  // complete:false result resurface dressed up as complete).
  const coldPartialStore = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: coldPartialStore });
  const coldPartialOpts = { maxDepth: 4, nodeLimit: 8000, multiPV: 3, nodeBudget: 1 };
  const coldPartialReq = Object.assign({}, REQ, { gameId: 'e3b-cold-partial', opts: coldPartialOpts });
  const coldPartialTruth = Core.analyse(Chess.parseFen(START), coldPartialOpts);
  seedRecord(coldPartialStore, coldPartialReq, coldPartialTruth);
  const coldPartialRes = await Svc.analyse(Object.assign({}, coldPartialReq));
  check(coldPartialRes === coldPartialTruth && coldPartialRes.complete === false && made.length === 0,
    'a persisted partial (complete:false) is re-served still visibly partial, never as complete');

  // --- Corruption: a record under a CORRECT key whose payload does not match
  //     the request is rejected and recomputed, never served. The read side
  //     reuses the same validMatch gate as a live worker reply; each of its
  //     three legs (fingerprint, config, turn) is proven able to turn the
  //     gate red, and the recompute overwrites the bad entry via persist. ---
  const foreignFen = START.replace(' 0 1', ' 40 1'); // same board, foreign halfmove history
  const corruptions = [
    { id: 'e3b-corrupt-fp', label: 'a foreign-position payload (fingerprint mismatch)',
      make: function () { return Core.analyse(Chess.parseFen(foreignFen), FAST); } },
    { id: 'e3b-corrupt-cfg', label: 'a foreign-config payload (configHash mismatch)',
      make: function () { return Core.analyse(Chess.parseFen(START), Object.assign({}, FAST, { multiPV: 2 })); } },
    { id: 'e3b-corrupt-turn', label: 'a turn-corrupted payload',
      make: function () { const c = cloneJson(coldTruth); c.turn = 'b'; return c; } }
  ];
  for (const corruption of corruptions) {
    const badStore = makeStore();
    reset({ factory: factoryOf({ mode: 'normal' }), store: badStore });
    // Distinct gameIds keep every case's key cold in the module-private
    // in-memory handoff, so each one exercises the persistent read path.
    const badReq = Object.assign({}, REQ, { gameId: corruption.id });
    const badSeed = seedRecord(badStore, badReq, corruption.make());
    const badRes = await Svc.analyse(Object.assign({}, badReq));
    await delay(5); // let the recompute's best-effort persist settle
    const overwritten = badStore._map.get(badSeed.key);
    check(!!badRes && made.length === 1 && norm(badRes) === norm(coldTruth),
      corruption.label + ' is rejected and recomputed, never served');
    check(!!overwritten && norm(overwritten.result) === norm(coldTruth) && overwritten.complete === true,
      'the recompute overwrites the corrupted entry: ' + corruption.label);
  }

  // ====================== E3b §2 — cancel (#87) ======================

  // --- A superseded job's late reply, and a cancelled job's own late reply,
  //     never publish: no promise value, no persistent write, no in-memory
  //     handoff entry — the next identical request misses and recomputes. ---
  const lateStore = makeStore();
  reset({ factory: factoryOf({ mode: 'stall' }, { mode: 'stall' }, { mode: 'normal' }), store: lateStore });
  const late1 = Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-late' }));
  await delay(1); // let the lookup miss and dispatch the stalled worker
  const late2 = Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-late' }));
  check((await late1) === null, 'the superseded twin request resolves null');
  await delay(1); // the active job's own lookup misses and dispatches too
  const lateW1 = made[0], lateW2 = made[1];
  const lateGood = Core.analyse(Chess.parseFen(START), FAST);
  lateW1.terminated = false; // the terminate lost the race with an in-flight reply
  lateW1.deliver({ v: PROTOCOL, jobId: lateW1.posts[0].jobId, result: lateGood });
  let late2Settled = false;
  late2.then(function () { late2Settled = true; });
  await delay(5);
  check(lateStore._map.size === 0 && late2Settled === false,
    'a superseded job\'s late valid reply writes nothing and cannot settle the active job');
  Svc.cancel();
  check((await late2) === null, 'cancel() resolves the active job null');
  lateW2.terminated = false;
  lateW2.deliver({ v: PROTOCOL, jobId: lateW2.posts[0].jobId, result: lateGood });
  await delay(5);
  check(lateStore._map.size === 0,
    'a cancelled job\'s own late reply publishes nothing to the persistent cache');
  const dLate = Svc.stats().dispatches;
  const lateAfter = await Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-late' }));
  check(!!lateAfter && Svc.stats().dispatches === dLate + 1 && lateStore._map.size === 1,
    'after the cancelled work the identical request misses (no ghost handoff) and recomputes');

  // --- One interactive job under a rapid re-request storm: every predecessor
  //     resolves null, at most one worker is ever left alive, each dispatched
  //     worker got exactly one post, and only the winner publishes. ---
  reset({ factory: factoryOf({ mode: 'normal' }) }); // no store: dispatch is synchronous
  const dStorm = Svc.stats().dispatches;
  const storm = [];
  for (let i = 0; i < 5; i++) {
    storm.push(Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-storm' })));
  }
  const stormRes = await Promise.all(storm);
  const stormIds = made.map(function (w) { return w.posts[0] && w.posts[0].jobId; });
  check(stormRes.slice(0, 4).every(function (r) { return r === null; }) &&
    !!stormRes[4] && stormRes[4].turn === 'w',
    'under a rapid re-request storm every superseded promise is null and only the last wins');
  check(made.length === 5 && Svc.stats().dispatches === dStorm + 5 &&
    made.slice(0, 4).every(function (w) { return w.terminated; }) &&
    made[4].terminated === false &&
    made.every(function (w) { return w.posts.length === 1; }) &&
    new Set(stormIds).size === 5,
    'one-interactive-job holds under the storm: predecessors terminated, one alive, one post each');

  // --- Cancel and supersede INSIDE the persistent-lookup window: the late
  //     lookup result must neither dispatch nor publish nor pre-empt the
  //     successor, and the service is left healthy. ---
  const gateStore = gatedStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: gateStore });
  const gateReq = Object.assign({}, REQ, { gameId: 'e3b-gate' });
  const gateCancelled = Svc.analyse(Object.assign({}, gateReq));
  Svc.cancel();
  check((await gateCancelled) === null, 'cancel during the cache lookup resolves the job null');
  gateStore._gates[0].release(recordFor(gateStore, gateReq, coldTruth).rec);
  await delay(5);
  check(made.length === 0 && gateStore._map.size === 0,
    'a lookup resolving after cancel neither dispatches nor publishes');
  const gateB = Svc.analyse(Object.assign({}, gateReq));
  const gateC = Svc.analyse(Object.assign({}, gateReq)); // supersedes B mid-lookup
  check((await gateB) === null, 'the request superseded during its lookup resolves null');
  gateStore._gates[1].release(recordFor(gateStore, gateReq, coldTruth).rec);
  let gateCSettled = false;
  gateC.then(function () { gateCSettled = true; });
  await delay(5);
  check(gateCSettled === false && made.length === 0,
    'a predecessor\'s valid lookup record can never settle or pre-empt the successor');
  gateStore._gates[2].release(undefined); // the successor's own lookup: a miss
  const gateCRes = await gateC;
  check(!!gateCRes && gateCRes.turn === 'w' && made.length === 1,
    'the successor survives the stale lookup and completes on its own dispatch');

  // --- cancel() after completion is inert: published results stay published. ---
  const postStore = makeStore();
  reset({ factory: factoryOf({ mode: 'normal' }), store: postStore });
  const postFirst = await Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-post' }));
  Svc.cancel();
  const dPost = Svc.stats().dispatches;
  const postSecond = await Svc.analyse(Object.assign({}, REQ, { gameId: 'e3b-post' }));
  check(!!postFirst && postSecond === postFirst &&
    Svc.stats().dispatches === dPost && postStore._map.size === 1,
    'cancel() after completion unpublishes nothing: the identical request still hits');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
