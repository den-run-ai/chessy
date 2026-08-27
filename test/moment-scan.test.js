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
require('../assets/calculation.js');

const Chess = globalThis.Chess;
let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

const jobs = new Map();
const games = new Map();
const receipts = new Map();
let puts = 0;
function sourceOf(game) {
  return {
    id: game.id,
    setupFen: game.setupFen || null,
    playerColor: game.playerColor || null,
    sans: game.sans || [],
    timeControl: game.timeControl || null,
    clocks: game.clocks || []
  };
}
function receiptKey(game, ply) {
  return JSON.stringify([sourceOf(game), ply]);
}
function replay(game, ply) {
  let state = initial(game.setupFen);
  for (let i = 0; i < ply; i++) {
    const legal = Chess.legalMoves(state);
    const move = legal.find(function (candidate) {
      return Chess.toSan(state, candidate, legal) === game.sans[i];
    });
    if (!move) return null;
    state = Chess.playMove(state, move);
  }
  return state;
}
globalThis.CoachStore = {
  sameReflectionSource: function (a, b) {
    return !!a && !!b &&
      JSON.stringify(sourceOf(a)) === JSON.stringify(sourceOf(b));
  },
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
  deleteJob: function (id) { jobs.delete(id); return Promise.resolve(); },
  putReflectionReceipt: function (expected, ply, reflection) {
    const game = games.get(expected.id);
    if (!game || JSON.stringify(sourceOf(game)) !== JSON.stringify(sourceOf(expected))) {
      return Promise.resolve(false);
    }
    const state = replay(game, ply);
    if (!state || globalThis.ChessyCalculation.validate(reflection, state)) {
      return Promise.resolve(false);
    }
    receipts.set(receiptKey(game, ply), {
      gameId: game.id, source: clone(sourceOf(game)),
      ply: ply, playedSan: game.sans[ply]
    });
    return Promise.resolve(true);
  },
  listValidReflectionReceipts: function (expected) {
    const game = games.get(expected.id);
    if (!game || JSON.stringify(sourceOf(game)) !== JSON.stringify(sourceOf(expected))) {
      return Promise.resolve([]);
    }
    return Promise.resolve(Array.from(receipts.values()).filter(function (receipt) {
      return receipt.gameId === game.id &&
        JSON.stringify(receipt.source) === JSON.stringify(sourceOf(game));
    }).map(clone));
  }
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
  constants: { lost: -300, mateUtility: 4000, deepRegret: 100 },
  utility: function (line, turn) {
    if (line.mate) {
      return line.mate.forWhite === (turn === 'w') ? 4000 : -4000;
    }
    const mover = turn === 'w' ? line.scoreCpWhite : -line.scoreCpWhite;
    return Math.max(-2000, Math.min(2000, mover));
  },
  clockFlags: function (meta) {
    return {
      anomaly: !!meta && Number.isFinite(meta.thinkMs) &&
        Number.isFinite(meta.typicalThinkMs) &&
        meta.thinkMs >= Math.max(30000, meta.typicalThinkMs * 3)
    };
  },
  evidence: function (result, meta) {
    if (!meta.validated || !Number.isFinite(result.bestUtility) ||
        !Number.isFinite(result.playedUtility)) return null;
    return {
      bestUtility: result.bestUtility,
      playedUtility: result.playedUtility,
      loss: Math.max(0, result.bestUtility - result.playedUtility),
      clockAnomaly: result.clockOnly === true
    };
  },
  quickCandidate: function (result, meta) {
    quickMetas.push(clone(meta));
    if (!meta.validated || result.nominate === false) return null;
    return {
      ply: meta.ply,
      playedSan: meta.playedSan,
      turn: meta.turn,
      loss: result.loss || 100
    };
  },
  shortlist: function (candidates, limit) { return candidates.slice(0, limit); },
  acceptDeep: function (quick, result, meta) {
    return meta.validated &&
      (result.loss >= 100 || result.clockOnly === true) &&
      result.stability &&
      result.stability.bestMoveStable === true
      ? { ply: quick.ply, playedSan: quick.playedSan } : null;
  }
};

let replies = [];
let requests = [];
let activeDeferred = null;
function completeResult(req, supplied) {
  supplied = supplied || {};
  if (supplied.valid !== true || supplied.complete !== true) return supplied;
  const state = Chess.parseFen(req.fen);
  const loss = Number.isFinite(supplied.loss) ? supplied.loss : 120;
  const turn = state.turn;
  const base = {
    valid: true,
    complete: true,
    loss: loss,
    bestUtility: loss,
    playedUtility: 0,
    turn: turn,
    depth: req.opts.nodeLimit === 80000 ? 4 : 2,
    engine: {
      id: 'test',
      version: '1',
      configHash: String(req.opts.nodeLimit) + ':' + String(req.opts.multiPV)
    },
    positionFingerprint: Chess.positionKey(state),
    bestLines: [{
      san: 'best',
      scoreCpWhite: turn === 'w' ? loss : -loss,
      scoreCpPlayer: loss,
      mate: null
    }],
    playedLine: {
      san: 'played',
      scoreCpWhite: 0,
      scoreCpPlayer: 0,
      mate: null
    },
    stability: req.opts.nodeLimit === 80000
      ? { depths: [3, 4], bestMoveStable: true } : null
  };
  return Object.assign(base, supplied);
}
function defaultResult(req) {
  return completeResult(req, { valid: true, complete: true, loss: 120 });
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
      if (next === null) return Promise.resolve(null);
      return Promise.resolve(completeResult(req, next));
    }
    return Promise.resolve(defaultResult(req));
  },
  cancel: function () {
    // Real service resolves an abandoned request null. Individual race tests
    // deliberately retain their controlled promise to simulate a late reply.
  }
};

require('../assets/analysis-notation.js');
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
  receipts.clear();
  puts = 0;
  replies = [];
  requests = [];
  activeDeferred = null;
  quickMetas = [];
}

function reflectionFor(review, ply) {
  return globalThis.ChessyCalculation.build(review.states[ply], {
    threatKind: 'none',
    candidateStatus: 'none',
    calculationStatus: 'none',
    evaluation: 'unclear'
  }).value;
}

function manualDeepResult(review, ply, supplied) {
  const profile = Scan.profiles.deep;
  return completeResult({
    ply: ply,
    fen: review.fens[ply],
    opts: {
      playedMove: review.gs.history[ply].move,
      maxDepth: profile.maxDepth,
      nodeLimit: profile.nodeLimit,
      nodeBudget: profile.nodeBudget,
      multiPV: profile.multiPV,
      pvLen: profile.pvLen
    }
  }, Object.assign({ valid: true, complete: true }, supplied || {}));
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
  check(quickPlies.join(',') === '0,1,2,3',
    'the quick pass scores every nonterminal move in game order',
    quickPlies.join(','));
  check(deepPlies.join(',') === '0,2' && done.moments.length === 2,
    'only shortlisted chosen-side decisions receive the exact deep profile');
  check(done.state === 'done' && done.checked === 4 && done.total === 4,
    'a finished two-pass scan persists exact all-move progress');
  check(requests.filter(function (r) { return r.opts.nodeLimit === 80000; })
    .every(function (r) {
      return r.opts.maxDepth === 10 && r.opts.nodeBudget === 1200000 &&
        r.opts.multiPV === 3 && r.opts.pvLen === 6;
    }), 'deep verification is byte-aligned with the manual reflection profile');
  const pub = Scan.state();
  check(Object.keys(pub.moments[0]).sort().join(',') === 'playedSan,ply' &&
    pub.candidates === undefined && pub.shortlist === undefined &&
    done.candidates === undefined && done.shortlist === undefined &&
    pub.report === undefined &&
    !/(scoreCpWhite|lossCp|annotation)/.test(JSON.stringify(pub)),
    'state() and start() expose no scores, labels, better moves or internal candidates');
  const oneReceipt = await Scan.recordReflection(black, 0, reflectionFor(black, 0));
  const oneVisible = Scan.state();
  check(oneReceipt === true && oneVisible.reportUnlocked === false &&
      oneVisible.reflectionCompleted === 1 &&
      oneVisible.report.length === 1 && oneVisible.report[0].ply === 0,
    'a structured reflection reveals only its matching move score');
  await Scan.recordReflection(black, 2, reflectionFor(black, 2));
  const allVisible = Scan.state();
  check(allVisible.reportUnlocked === true &&
      allVisible.reflectionCompleted === allVisible.reflectionRequired &&
      allVisible.report.length === 4 &&
      allVisible.report.filter(function (entry) {
        return entry.ply === 0 || entry.ply === 2;
      }).every(function (entry) {
        return entry.estimate === false && entry.annotation === '?!';
      }) &&
      allVisible.report.filter(function (entry) {
        return entry.ply === 1 || entry.ply === 3;
      }).every(function (entry) {
        return entry.estimate === true && entry.annotation === null;
      }),
    'reflecting every suggested moment unlocks deep rows plus quick estimates');
  Scan.invalidate();
  const reloadedReport = await Scan.load(black);
  check(reloadedReport.reportUnlocked === true &&
      reloadedReport.report.length === 4,
    'reflection receipts and the unlocked report survive a same-game reload');

  reset();
  const forgedReview = autoReview('forged-job-receipts', 4, 'b');
  await Scan.start(forgedReview, { restart: true });
  const forgedReceiptJob = clone(jobs.get('forged-job-receipts'));
  forgedReceiptJob.reflected = forgedReceiptJob.moments.map(function (moment) {
    return { ply: moment.ply, playedSan: moment.playedSan };
  });
  Scan.invalidate();
  jobs.set('forged-job-receipts', forgedReceiptJob);
  const forgedReceiptState = await Scan.load(forgedReview);
  check(forgedReceiptState.reflectionCompleted === 0 &&
      forgedReceiptState.report === undefined &&
      !Object.prototype.hasOwnProperty.call(
        jobs.get('forged-job-receipts'), 'reflected'),
    'analysisJobs.reflected cannot forge Gate-0 authority on reload');

  // The receipt read may finish before a slower job read. A durable submit in
  // that preparation window must advance the epoch and force an exact re-read,
  // not leave this active load locked until another reload.
  reset();
  const prepareRaceReview = autoReview('prepare-receipt-race', 2, 'b');
  await Scan.start(prepareRaceReview, { restart: true });
  const prepareRaceJob = clone(jobs.get('prepare-receipt-race'));
  Scan.invalidate();
  const realRaceGetJob = CoachStore.getJob;
  const realRaceList = CoachStore.listValidReflectionReceipts;
  let releaseRaceJob;
  let raceJobRead = false;
  let receiptReads = 0;
  CoachStore.getJob = function () {
    raceJobRead = true;
    return new Promise(function (resolve) { releaseRaceJob = resolve; });
  };
  CoachStore.listValidReflectionReceipts = function (expected) {
    receiptReads++;
    return receiptReads === 1 ? Promise.resolve([]) : realRaceList(expected);
  };
  const racingLoad = Scan.load(prepareRaceReview);
  while (!raceJobRead || receiptReads < 1) {
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
  }
  const duringPrepare = await Scan.recordReflection(
    prepareRaceReview, 1, reflectionFor(prepareRaceReview, 1));
  releaseRaceJob(prepareRaceJob);
  const preparedWithReceipt = await racingLoad;
  CoachStore.getJob = realRaceGetJob;
  CoachStore.listValidReflectionReceipts = realRaceList;
  check(duringPrepare === true && receiptReads >= 3 &&
      preparedWithReceipt.reportUnlocked === true &&
      preparedWithReceipt.report.length === 2,
    'a receipt committed during prepare is re-read into the active report');

  // A structured reflection can finish before Scan analysis starts. The exact
  // revision/ply receipt is merged into the first compatible durable job.
  reset();
  const preStartReview = autoReview('pre-start-reflection', 2, 'b');
  const queuedReceipt = await Scan.recordReflection(
    preStartReview, 1, reflectionFor(preStartReview, 1));
  const preStartDone = await Scan.start(preStartReview, { restart: true });
  check(queuedReceipt === true && preStartDone.state === 'done' &&
      preStartDone.moments.length === 1 &&
      preStartDone.reflectionRequired === 1 &&
      preStartDone.reflectionCompleted === 1 &&
      preStartDone.reportUnlocked === true &&
      preStartDone.report.length === 2,
    'a pre-start reflection receipt unlocks its later compatible scan');

  // Review opens a known-side game by durably preparing an idle job. A
  // reflection receipt on that real UI path must survive normalization even
  // though the quick score row does not exist until Start.
  reset();
  const idleReview = autoReview('idle-reflection', 2, 'b');
  const idle = await Scan.load(idleReview);
  const idleReceipt = await Scan.recordReflection(
    idleReview, 1, reflectionFor(idleReview, 1));
  const idleDone = await Scan.start(idleReview);
  check(idle.state === 'idle' && idleReceipt === true &&
      idleDone.state === 'done' && idleDone.reportUnlocked === true &&
      idleDone.report.length === 2,
    'an idle-job reflection receipt survives the open → reflect → Start path');

  // Choosing one side narrows suggestions, not the archived all-game score
  // trail. A manual reflection on the other side still reveals/promotes that
  // analyzed row without generating a coaching NAG.
  reset();
  const otherSideReview = autoReview('other-side-reflection', 4, 'b');
  await Scan.start(otherSideReview, { restart: true });
  await Scan.recordReflection(
    otherSideReview, 0, reflectionFor(otherSideReview, 0));
  const otherSideVisible = Scan.state();
  const otherSideBefore = otherSideVisible.report.find(function (row) {
    return row.ply === 0;
  });
  const otherSidePromoted = await Scan.recordVerifiedSummary(
    otherSideReview, 0, manualDeepResult(otherSideReview, 0));
  const otherSideAfter = Scan.state().report.find(function (row) {
    return row.ply === 0;
  });
  check(otherSideVisible.reportUnlocked === false &&
      otherSideBefore.estimate === true &&
      otherSidePromoted === true && otherSideAfter.estimate === false &&
      otherSideAfter.annotation === null,
    'a nonselected-side manual reflection reveals and deepens only that row');

  reset();
  const both = autoReview('two-clocks', 4, 'both', null, [
    { thinkMs: 1000 }, { thinkMs: 10000 },
    { thinkMs: 3000 }, { thinkMs: 30000 }
  ]);
  await Scan.start(both, { restart: true });
  check(quickMetas.map(function (m) { return m.typicalThinkMs; }).join(',') ===
      '2000,20000,2000,20000',
    'local PvP computes a separate exact think-time median for each side');

  // Selector admission can be based on exact clock evidence below the 100cp
  // punctuation floor. Keep the moment, but never invent a generated NAG.
  reset();
  const clockReview = autoReview('clock-only', 6, 'b', null, [
    null, { thinkMs: 1000 }, null, { thinkMs: 1000 },
    null, { thinkMs: 30000 }
  ]);
  replies = [
    { valid: true, complete: true, loss: 20 },
    { valid: true, complete: true, loss: 20, nominate: false },
    { valid: true, complete: true, loss: 20 },
    { valid: true, complete: true, loss: 20, nominate: false },
    { valid: true, complete: true, loss: 20 },
    { valid: true, complete: true, loss: 75, clockOnly: true },
    { valid: true, complete: true, loss: 75, clockOnly: true }
  ];
  const clockDone = await Scan.start(clockReview, { restart: true });
  const clockSummary = jobs.get('clock-only').moveSummaries.find(function (row) {
    return row.ply === 5;
  });
  await Scan.recordReflection(clockReview, 5, reflectionFor(clockReview, 5));
  const clockVisible = Scan.state();
  const clockRow = clockVisible.report.find(function (row) {
    return row.ply === 5;
  });
  check(clockDone.moments.length === 1 &&
      clockDone.moments[0].ply === 5 &&
      clockSummary.accepted === true && clockSummary.clockAnomaly === true &&
      clockRow.estimate === false && clockRow.annotation === null,
    'a clock-only accepted moment survives without receiving a score-loss NAG');
  Scan.invalidate();
  const clockReloaded = await Scan.load(clockReview);
  check(clockReloaded.state === 'done' &&
      clockReloaded.moments.length === 1 &&
      clockReloaded.moments[0].ply === 5 &&
      clockReloaded.reportUnlocked === true &&
      clockReloaded.report.find(function (row) {
        return row.ply === 5;
      }).annotation === null,
    'exact clock evidence is recomputed and rebound on report reload');

  // A manual Verify on a non-shortlisted chosen-side move promotes its quick
  // ledger row to deep, without inheriting critical-moment punctuation.
  reset();
  const promotionReview = autoReview('manual-promotion', 6, 'b');
  const promotionDone = await Scan.start(promotionReview, { restart: true });
  await Scan.recordReflection(
    promotionReview, 5, reflectionFor(promotionReview, 5));
  const beforePromotion = Scan.state().report.find(function (row) {
    return row.ply === 5;
  });
  const promoted = await Scan.recordVerifiedSummary(
    promotionReview, 5, manualDeepResult(promotionReview, 5));
  const afterPromotion = Scan.state().report.find(function (row) {
    return row.ply === 5;
  });
  check(promotionDone.moments.every(function (moment) {
        return moment.ply !== 5;
      }) &&
      beforePromotion.estimate === true &&
      promoted === true && afterPromotion.estimate === false &&
      afterPromotion.annotation === null,
    'manual deep verification promotes a quick row without inventing a NAG');
  const promotionJob = clone(jobs.get('manual-promotion'));
  const forgedAccepted = clone(promotionJob);
  forgedAccepted.moveSummaries.find(function (row) {
    return row.ply === 5;
  }).accepted = true;
  Scan.invalidate();
  jobs.set('manual-promotion', forgedAccepted);
  const rejectedAcceptedBit = await Scan.load(promotionReview);
  check(rejectedAcceptedBit.state === 'idle' &&
      rejectedAcceptedBit.report === undefined,
    'reload rejects a forged accepted bit on a manually verified non-moment');
  const forgedMoment = clone(forgedAccepted);
  forgedMoment.moments.push({
    ply: 5,
    playedSan: promotionReview.gs.history[5].san
  });
  Scan.invalidate();
  jobs.set('manual-promotion', forgedMoment);
  const rejectedForgedMoment = await Scan.load(promotionReview);
  check(rejectedForgedMoment.state === 'idle' &&
      rejectedForgedMoment.moments.length === 0 &&
      rejectedForgedMoment.report === undefined,
    'reload rejects an admitted moment that did not originate in the shortlist');

  // A partial/malformed shallow answer retries once under the bounded fallback
  // profile, at the same cursor, before progress advances.
  reset();
  const retryReview = autoReview('retry', 2, 'b');
  replies = [
    { valid: true, complete: true, loss: 20 },
    { valid: false, complete: false, reason: 'partial' },
    { valid: true, complete: true, loss: 150 },
    { valid: true, complete: true }
  ];
  const retried = await Scan.start(retryReview, { restart: true });
  check(requests.length === 4 && requests[0].ply === 0 &&
    requests[1].ply === 1 && requests[2].ply === 1 &&
    requests[2].fresh === true && requests[2].opts.nodeLimit === 12000 &&
    requests[2].opts.nodeBudget === 300000,
    'an unusable quick result gets exactly one stronger fresh retry at the same ply');
  check(retried.state === 'done' && retried.cursorPly === 2 &&
    retried.checked === 2 && retried.unresolvedCount === 0,
    'a successful fallback advances and checkpoints the next absolute ply');

  // Two unusable answers are recorded as unresolved, then the cursor advances;
  // a single bad position never traps the whole resumable job.
  reset();
  const badReview = autoReview('bad', 2, 'b');
  replies = [
    { valid: true, complete: true, loss: 20 },
    { valid: false, complete: false, reason: 'partial' },
    { valid: false, complete: true, reason: 'illegal-line' }
  ];
  const partialDone = await Scan.start(badReview, { restart: true });
  check(requests.length === 3 && partialDone.state === 'done' &&
    partialDone.unresolvedCount === 1 &&
    jobs.get('bad').unresolved[0].ply === 1 && partialDone.cursorPly === 2,
    'a twice-unusable decision is marked unresolved and does not loop forever');
  check(partialDone.moments.length === 0,
    'zero reliable moments is a valid completed result');

  // A null result means superseded/interrupted. It pauses without advancing;
  // resume repeats that exact ply and then completes.
  reset();
  const pausedReview = autoReview('paused', 2, 'b');
  replies = [{ valid: true, complete: true, loss: 20 }, null];
  const paused = await Scan.start(pausedReview, { restart: true });
  check(paused.state === 'paused' && paused.cursorPly === 1 &&
    paused.checked === 1 && jobs.get('paused').cursorPly === 1,
    'an interrupted analysis pauses at the unchanged all-move cursor');
  requests = [];
  const resumed = await Scan.resume(pausedReview);
  check(requests[0].ply === 1 && resumed.state === 'done' && resumed.checked === 2,
    'resume restarts the exact interrupted ply and finishes from its checkpoint');

  // A process that dies while marked running has no live owner on reload.
  // load() normalizes and persists it as paused without dispatching analysis.
  reset();
  const reloadReview = autoReview('reload', 2, 'b');
  const seeded = {
    schema: 2,
    algorithm: 'critical-moments-v2',
    gameId: 'reload',
    sourceRev: Scan.sourceRevision(reloadReview.game, 'b'),
    analysisRev: Scan.analysisRevision(reloadReview.game),
    scanColor: 'b',
    state: 'running',
    pass: 1,
    cursorPly: 1,
    checked: 1,
    total: 2,
    candidates: [],
    shortlist: [{
      ply: 1, playedSan: reloadReview.gs.history[1].san, turn: 'w'
    }],
    verifyIndex: 0,
    moments: [],
    unresolved: [],
    moveSummaries: [],
    reflected: []
  };
  jobs.set('reload', clone(seeded));
  const loaded = await Scan.load(reloadReview);
  check(loaded.state === 'paused' && jobs.get('reload').state === 'paused' &&
    requests.length === 0,
    'a persisted running job reloads as an honestly paused checkpoint');
  check(loaded.total === 2 && loaded.checked === 1 &&
      loaded.moments.length === 0 && loaded.verifyTotal === 0,
    'reload restores all-move progress and drops wrong-mover shortlist entries');

  // A persisted required suggestion without its exact valid deep row cannot
  // ever satisfy the reveal gate. Treat that cache record as recomputable and
  // restart it instead of restoring a permanently locked report.
  reset();
  const malformedReview = autoReview('malformed-required', 2, 'b');
  await Scan.start(malformedReview, { restart: true });
  const malformed = clone(jobs.get('malformed-required'));
  const requiredPly = malformed.moments[0].ply;
  malformed.moveSummaries.find(function (summary) {
    return summary.ply === requiredPly;
  }).stability.depths = [1, 4];
  Scan.invalidate();
  jobs.set('malformed-required', malformed);
  requests = [];
  const restartedMalformed = await Scan.load(malformedReview);
  check(restartedMalformed.state === 'idle' &&
      restartedMalformed.moments.length === 0 &&
      restartedMalformed.report === undefined &&
      jobs.get('malformed-required').state === 'idle' &&
      requests.length === 0,
    'a malformed required-moment summary restarts as a fresh spoiler-free job');

  // Pass 2 itself proves the all-move pass claimed completion. A paused job
  // with a silently missing quick row must restart before Resume can finish
  // and unlock a partial ledger.
  reset();
  const partialPassTwoReview = autoReview('partial-pass-two', 4, 'b');
  await Scan.start(partialPassTwoReview, { restart: true });
  const partialPassTwo = clone(jobs.get('partial-pass-two'));
  partialPassTwo.state = 'paused';
  partialPassTwo.moveSummaries = partialPassTwo.moveSummaries.filter(
    function (row) { return row.ply !== 0; });
  Scan.invalidate();
  jobs.set('partial-pass-two', partialPassTwo);
  const restartedPartialPassTwo = await Scan.load(partialPassTwoReview);
  check(restartedPartialPassTwo.state === 'idle' &&
      restartedPartialPassTwo.report === undefined &&
      jobs.get('partial-pass-two').moveSummaries.length === 0,
    'a pass-two checkpoint missing an all-move score row restarts before Resume');

  // The summary schema is recomputable cache state. An earlier controller
  // version becomes a fresh, spoiler-free job instead of being half-migrated.
  reset();
  const legacyReview = autoReview('legacy', 2, 'b');
  const legacy = Object.assign({}, seeded, {
    schema: 1,
    algorithm: 'critical-moments-v1',
    gameId: 'legacy',
    sourceRev: Scan.sourceRevision(legacyReview.game, 'b'),
    analysisRev: Scan.analysisRevision(legacyReview.game),
    state: 'done'
  });
  jobs.set('legacy', clone(legacy));
  const replacedLegacy = await Scan.load(legacyReview);
  check(replacedLegacy.state === 'idle' && replacedLegacy.report === undefined &&
      jobs.get('legacy').schema === 2,
    'a legacy scan checkpoint restarts without exposing stale score state');

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
  const staleEvents = [];
  const realDocument = globalThis.document;
  const realCustomEvent = globalThis.CustomEvent;
  globalThis.document = {
    dispatchEvent: function (event) { staleEvents.push(event.detail); }
  };
  globalThis.CustomEvent = function (type, init) {
    this.type = type;
    this.detail = init.detail;
  };
  replies = [staleReply];
  const staleRun = Scan.start(staleReview, { restart: true });
  while (!activeDeferred) await new Promise(function (r) { setTimeout(r, 0); });
  const putsBeforeReplace = puts;
  const replacement = clone(staleReview.game);
  replacement.sans = replacement.sans.concat('a3');
  games.set('stale', replacement);
  staleReply.resolve({ valid: true, complete: true, loss: 300 });
  await staleRun;
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = realCustomEvent;
  check(puts === putsBeforeReplace && Scan.state() === null &&
      staleEvents[staleEvents.length - 1] === null,
    'a changed source revision clears subscribers before checkpointing a worker result');

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
