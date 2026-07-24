/*
 * Phase 5 resumable scan orchestration — run with:
 *   node test/moment-scan.test.js
 *
 * The engine-result validator and selector have their own pure suites. These
 * tests isolate ownership, cursor/checkpoint, retry and side-to-move behavior
 * with controlled async analysis responses.
 */
'use strict';
require('../assets/engine.js');

const Chess = globalThis.Chess;
let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

const jobs = new Map();
const games = new Map();
let puts = 0;
globalThis.CoachStore = {
  getGame: function (id) { return Promise.resolve(clone(games.get(id))); },
  getJob: function (id) { return Promise.resolve(clone(jobs.get(id))); },
  putJob: function (job) {
    puts++;
    jobs.set(job.gameId, clone(job));
    return Promise.resolve(job.gameId);
  },
  putJobIfGame: function (job, expected) {
    const game = games.get(job.gameId);
    const same = !!game && !!expected &&
      JSON.stringify({
        id: game.id,
        setupFen: game.setupFen || null,
        playerColor: game.playerColor || null,
        sans: game.sans || [],
        clocks: game.clocks || [],
        timeControl: game.timeControl || null
      }) === JSON.stringify(expected);
    if (!same) return Promise.resolve(false);
    puts++;
    jobs.set(job.gameId, clone(job));
    return Promise.resolve(true);
  },
  deleteJob: function (id) { jobs.delete(id); return Promise.resolve(); }
};

globalThis.ChessyAnalysisCore = {
  identity: function (state, opts) {
    return {
      engineId: 'test',
      version: '1',
      configHash: String(opts.nodeLimit) + ':' + String(opts.multiPV),
      positionFingerprint: Chess.positionKey(state)
    };
  }
};

globalThis.ChessyAnalysisResult = {
  validate: function (result) {
    return result && result.valid === true && result.complete === true
      ? { ok: true } : { ok: false, reason: result && result.reason || 'bad-result' };
  }
};

let quickMetas = [];
globalThis.ChessyMomentSelector = {
  quickCandidate: function (result, meta) {
    quickMetas.push(clone(meta));
    if (!meta.validated || result.nominate === false) return null;
    return { ply: meta.ply, playedSan: meta.playedSan, loss: result.loss || 100 };
  },
  shortlist: function (candidates, limit) { return candidates.slice(0, limit); },
  acceptDeep: function (quick, result, meta) {
    return meta.validated && result.stability &&
      result.stability.bestMoveStable === true
      ? { ply: quick.ply, playedSan: quick.playedSan } : null;
  }
};

let replies = [];
let requests = [];
let activeDeferred = null;
function defaultResult(req) {
  return {
    valid: true,
    complete: true,
    loss: 120,
    stability: req.opts.nodeLimit === 80000 ? { bestMoveStable: true } : null
  };
}
globalThis.ChessyAnalysisService = {
  analyse: function (req) {
    requests.push(clone(req));
    if (replies.length) {
      const next = replies.shift();
      if (next && next.deferred) {
        activeDeferred = next;
        return next.promise;
      }
      return Promise.resolve(next);
    }
    return Promise.resolve(defaultResult(req));
  },
  cancel: function () {
    // Real service resolves an abandoned request null. Individual race tests
    // deliberately retain their controlled promise to simulate a late reply.
  }
};

require('../assets/moment-scan.js');
const Scan = globalThis.ChessyMomentScan;

function initial(fen) {
  const s = fen ? Chess.parseFen(fen) : Chess.newGameState();
  if (!s.history) s.history = [];
  if (!s.positions) {
    s.positions = {};
    s.positions[Chess.positionKey(s)] = 1;
  }
  return s;
}

function autoReview(id, count, playerColor, fen, clocks) {
  let s = initial(fen);
  const states = [s], fens = [Chess.toFen(s)], sans = [];
  for (let i = 0; i < count; i++) {
    const legal = Chess.legalMoves(s);
    if (!legal.length) break;
    const move = legal[0];
    sans.push(Chess.toSan(s, move, legal));
    s = Chess.playMove(s, move);
    states.push(s);
    fens.push(Chess.toFen(s));
  }
  const game = {
    id: id,
    setupFen: fen || null,
    sans: sans,
    playerColor: playerColor,
    clocks: clocks || sans.map(function () { return null; }),
    timeControl: 'none'
  };
  games.set(id, clone(game));
  return { game: game, gs: s, states: states, fens: fens, ply: 0 };
}

function deferred() {
  let resolve;
  const promise = new Promise(function (r) { resolve = r; });
  return { deferred: true, promise: promise, resolve: resolve };
}

function reset() {
  Scan.invalidate();
  jobs.clear();
  games.clear();
  puts = 0;
  replies = [];
  requests = [];
  activeDeferred = null;
  quickMetas = [];
}

(async function () {
  check(!!Scan, 'controller exports only after all required boundaries exist');

  // A custom setup with Black to move proves eligibility follows the replayed
  // state's turn, not ply parity.
  reset();
  const blackStart =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
  const black = autoReview('black-first', 4, 'b', blackStart);
  const done = await Scan.start(black, { restart: true });
  const quickPlies = requests.filter(function (r) {
    return r.opts.nodeLimit !== 80000;
  }).map(function (r) { return r.ply; });
  const deepPlies = requests.filter(function (r) {
    return r.opts.nodeLimit === 80000;
  }).map(function (r) { return r.ply; });
  check(quickPlies.join(',') === '0,2',
    'only the chosen side decisions are scanned from full-state side-to-move',
    quickPlies.join(','));
  check(deepPlies.join(',') === '0,2' && done.moments.length === 2,
    'at most two shortlisted decisions receive the exact deep profile');
  check(done.state === 'done' && done.checked === 2 && done.total === 2,
    'a finished two-pass scan persists exact player-decision progress');
  check(requests.filter(function (r) { return r.opts.nodeLimit === 80000; })
    .every(function (r) {
      return r.opts.maxDepth === 10 && r.opts.nodeBudget === 1200000 &&
        r.opts.multiPV === 3 && r.opts.pvLen === 6;
    }), 'deep verification is byte-aligned with the manual reflection profile');
  const pub = Scan.state();
  check(Object.keys(pub.moments[0]).sort().join(',') === 'playedSan,ply' &&
    pub.candidates === undefined && pub.shortlist === undefined &&
    done.candidates === undefined && done.shortlist === undefined,
    'state() and start() expose no scores, labels, better moves or internal candidates');

  reset();
  const both = autoReview('two-clocks', 4, 'both', null, [
    { thinkMs: 1000 }, { thinkMs: 10000 },
    { thinkMs: 3000 }, { thinkMs: 30000 }
  ]);
  await Scan.start(both, { restart: true });
  check(quickMetas.map(function (m) { return m.typicalThinkMs; }).join(',') ===
      '2000,20000,2000,20000',
    'local PvP computes a separate exact think-time median for each side');

  // A partial/malformed shallow answer retries once under the bounded fallback
  // profile, at the same cursor, before progress advances.
  reset();
  const retryReview = autoReview('retry', 2, 'b');
  replies = [
    { valid: false, complete: false, reason: 'partial' },
    { valid: true, complete: true, loss: 150 },
    { valid: true, complete: true, stability: { bestMoveStable: true } }
  ];
  const retried = await Scan.start(retryReview, { restart: true });
  check(requests.length === 3 && requests[0].ply === 1 && requests[1].ply === 1 &&
    requests[1].fresh === true && requests[1].opts.nodeLimit === 12000 &&
    requests[1].opts.nodeBudget === 300000,
    'an unusable quick result gets exactly one stronger fresh retry at the same ply');
  check(retried.state === 'done' && retried.cursorPly === 2 &&
    retried.unresolvedCount === 0,
    'a successful fallback advances and checkpoints the next absolute ply');

  // Two unusable answers are recorded as unresolved, then the cursor advances;
  // a single bad position never traps the whole resumable job.
  reset();
  const badReview = autoReview('bad', 2, 'b');
  replies = [
    { valid: false, complete: false, reason: 'partial' },
    { valid: false, complete: true, reason: 'illegal-line' }
  ];
  const partialDone = await Scan.start(badReview, { restart: true });
  check(requests.length === 2 && partialDone.state === 'done' &&
    partialDone.unresolvedCount === 1 &&
    jobs.get('bad').unresolved[0].ply === 1 && partialDone.cursorPly === 2,
    'a twice-unusable decision is marked unresolved and does not loop forever');
  check(partialDone.moments.length === 0,
    'zero reliable moments is a valid completed result');

  // A null result means superseded/interrupted. It pauses without advancing;
  // resume repeats that exact ply and then completes.
  reset();
  const pausedReview = autoReview('paused', 2, 'b');
  replies = [null];
  const paused = await Scan.start(pausedReview, { restart: true });
  check(paused.state === 'paused' && paused.cursorPly === 1 &&
    paused.checked === 0 && jobs.get('paused').cursorPly === 1,
    'an interrupted analysis pauses at the unchanged next-decision cursor');
  requests = [];
  const resumed = await Scan.resume(pausedReview);
  check(requests[0].ply === 1 && resumed.state === 'done' && resumed.checked === 1,
    'resume restarts the exact interrupted ply and finishes from its checkpoint');

  // A process that dies while marked running has no live owner on reload.
  // load() normalizes and persists it as paused without dispatching analysis.
  reset();
  const reloadReview = autoReview('reload', 2, 'b');
  const seeded = {
    schema: 1,
    algorithm: 'critical-moments-v1',
    gameId: 'reload',
    sourceRev: Scan.sourceRevision(reloadReview.game, 'b'),
    analysisRev: Scan.analysisRevision(reloadReview.game),
    scanColor: 'b',
    state: 'running',
    pass: 1,
    cursorPly: 1,
    checked: 0,
    total: 1,
    candidates: [],
    shortlist: [{
      ply: 1, playedSan: reloadReview.gs.history[1].san, turn: 'w'
    }],
    verifyIndex: 0,
    moments: [
      { ply: 0, playedSan: reloadReview.gs.history[0].san },
      { ply: 1, playedSan: reloadReview.gs.history[1].san }
    ],
    unresolved: []
  };
  jobs.set('reload', clone(seeded));
  const loaded = await Scan.load(reloadReview);
  check(loaded.state === 'paused' && jobs.get('reload').state === 'paused' &&
    requests.length === 0,
    'a persisted running job reloads as an honestly paused checkpoint');
  check(loaded.moments.length === 1 && loaded.moments[0].ply === 1 &&
    loaded.verifyTotal === 0,
    'reload drops opponent moments and wrong-mover shortlist entries');

  // Generation invalidation must beat an already-resolving callback. No
  // checkpoint may appear after destructive controls have taken ownership.
  reset();
  const raceReview = autoReview('race', 2, 'b');
  const late = deferred();
  replies = [late];
  const racing = Scan.start(raceReview, { restart: true });
  while (!activeDeferred) await new Promise(function (r) { setTimeout(r, 0); });
  const beforeInvalidate = puts;
  const durableBeforeInvalidate = clone(jobs.get('race'));
  Scan.invalidate();
  late.resolve({ valid: true, complete: true, loss: 300 });
  await racing;
  await new Promise(function (r) { setTimeout(r, 0); });
  check(puts === beforeInvalidate &&
    JSON.stringify(jobs.get('race')) === JSON.stringify(durableBeforeInvalidate),
    'a late callback after generation invalidation cannot write scan progress');
  check(Scan.state() === null,
    'destructive invalidation clears the in-memory owner and public state');

  // Pause also owns the asynchronous preparation window before getJob()
  // resolves. Navigation can happen there while no job is current/running;
  // the deferred read must not later dispatch analysis or write checkpoints.
  reset();
  const preparingReview = autoReview('preparing', 2, 'b');
  const realGetJob = CoachStore.getJob;
  let releaseGetJob;
  let getJobStarted = false;
  CoachStore.getJob = function () {
    getJobStarted = true;
    return new Promise(function (resolve) { releaseGetJob = resolve; });
  };
  const preparing = Scan.start(preparingReview);
  while (!getJobStarted) await new Promise(function (r) { setTimeout(r, 0); });
  const pausedPreparing = await Scan.pause();
  releaseGetJob(null);
  const cancelledPrepare = await preparing;
  CoachStore.getJob = realGetJob;
  check(pausedPreparing === null && cancelledPrepare === null &&
      requests.length === 0 && puts === 0 && Scan.state() === null,
    'pause during deferred job preparation prevents later dispatch and checkpoint');

  // Even without a direct invalidate signal, every result re-checks its source
  // record before writing. A same-id replacement cannot receive an orphan job.
  reset();
  const staleReview = autoReview('stale', 2, 'b');
  const staleReply = deferred();
  replies = [staleReply];
  const staleRun = Scan.start(staleReview, { restart: true });
  while (!activeDeferred) await new Promise(function (r) { setTimeout(r, 0); });
  const putsBeforeReplace = puts;
  const replacement = clone(staleReview.game);
  replacement.sans = replacement.sans.concat('a3');
  games.set('stale', replacement);
  staleReply.resolve({ valid: true, complete: true, loss: 300 });
  await staleRun;
  check(puts === putsBeforeReplace && Scan.state() === null,
    'a changed source revision is detected before checkpointing a worker result');

  // Imported games with unknown ownership require an explicit choice.
  reset();
  const unknown = autoReview('unknown', 2, null);
  let rejected = false;
  try { await Scan.start(unknown, { restart: true }); }
  catch (e) { rejected = /choose White, Black or both/.test(e.message); }
  check(rejected && requests.length === 0,
    'unknown imported ownership never silently scans both sides');
  const chosen = await Scan.start(unknown, { restart: true, scanColor: 'w' });
  check(chosen.state === 'done' && jobs.get('unknown').scanColor === 'w',
    'an explicit imported-side choice enables a deterministic scan');
  Scan.invalidate();
  const remembered = await Scan.load(unknown);
  check(remembered.state === 'done' && jobs.get('unknown').scanColor === 'w',
    'the explicit imported-side choice survives reload in the durable job');
  Scan.invalidate();
  requests = [];
  const restarted = await Scan.start(unknown, { restart: true });
  check(restarted.state === 'done' && jobs.get('unknown').scanColor === 'w' &&
      requests.length > 0,
    'restart discards old work but reuses the imported-side choice after reload');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
