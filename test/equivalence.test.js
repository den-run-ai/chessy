/*
 * Accepted-move criterion (Train v2 E1) — run with:
 *   node test/equivalence.test.js
 *
 * Two layers:
 *   1. synthetic contract fixtures pinning the CP/mate case matrix, the
 *      fail-closed rules, and the evidence shape;
 *   2. real analysis-core integration proving grade() agrees with the
 *      documented criterion on live engine output without pinning any
 *      engine-specific score.
 */
'use strict';

require('../assets/engine.js');
require('../assets/analysis-core.js');
require('./wasm-test-engine.js').installAnalysisEngine();
const AnalysisResult = require('../assets/analysis-result.js');
const Equivalence = require('../assets/equivalence.js');
require('../assets/store.js');
const Chess = globalThis.Chess;
const AC = globalThis.ChessyAnalysisCore;
const Store = globalThis.CoachStore;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function cpLine(state, move, score) {
  const legal = Chess.legalMoves(state);
  const san = Chess.toSan(state, move, legal);
  return {
    move: { from: move.from, to: move.to, promotion: move.promotion || null },
    uci: uci(move),
    san: san,
    scoreCpWhite: score,
    scoreCpPlayer: state.turn === 'w' ? score : -score,
    mate: null,
    pv: [san],
    pvUci: [uci(move)]
  };
}

function mateLine(state, move, mate) {
  const legal = Chess.legalMoves(state);
  const san = Chess.toSan(state, move, legal);
  return {
    move: { from: move.from, to: move.to, promotion: move.promotion || null },
    uci: uci(move),
    san: san,
    scoreCpWhite: null,
    scoreCpPlayer: null,
    mate: mate,
    pv: [san],
    pvUci: [uci(move)]
  };
}

const IDENTITY = {
  engineId: 'chessy-test',
  version: '5.0.0',
  configHash: 'cfg-e1',
  positionFingerprint: 'fp-start'
};

/*
 * Contract-legal result. opts:
 *   playedIndex  — playedLine cloned from bestLines[playedIndex];
 *   playedLine   — an explicit outside-candidates played line (with rank);
 *   stable       — true/false emits a stability pair, undefined omits it.
 */
function fixture(state, lines, opts) {
  opts = opts || {};
  const result = {
    engine: {
      id: IDENTITY.engineId,
      version: IDENTITY.version,
      configHash: IDENTITY.configHash
    },
    turn: state.turn,
    positionFingerprint: IDENTITY.positionFingerprint,
    complete: true,
    depth: 4,
    nodes: 1234,
    elapsedMs: 12,
    scoreCpWhite: lines[0].scoreCpWhite,
    scoreCpPlayer: lines[0].scoreCpPlayer,
    mate: clone(lines[0].mate),
    bestLines: clone(lines),
    playedLine: null,
    classification: null,
    stability: opts.stable === undefined ? null :
      { depths: [3, 4], bestMoveStable: opts.stable }
  };
  if (opts.playedIndex !== undefined) {
    const played = clone(lines[opts.playedIndex]);
    played.rank = opts.playedIndex + 1;
    played.amongCandidates = true;
    result.playedLine = played;
    result.classification =
      opts.playedIndex === 0 ? 'same' : 'different-candidate';
  } else if (opts.playedLine) {
    const played = clone(opts.playedLine);
    played.amongCandidates = false;
    result.playedLine = played;
    result.classification = 'unknown-equivalence';
  }
  return result;
}

function grade(result, state, attemptUci, expected) {
  return Equivalence.grade(result, state, expected || { identity: IDENTITY }, attemptUci);
}

// ---------------------------------------------------------------------------
console.log('criterion identity');
// ---------------------------------------------------------------------------
// The criterion IS the versioned contract: any edit here changes what
// "equivalent" means, so this pin forces the edit to bump `version` and
// consciously re-baseline the E3 scorecard.
check(JSON.stringify(Equivalence.CRITERION) === JSON.stringify({
  id: 'chessy-equivalence',
  version: 1,
  basis: 'cp-mate-fallback',
  params: { cpTolerance: 30 }
}), 'CRITERION v1 is pinned exactly (a change must bump version)',
  JSON.stringify(Equivalence.CRITERION));
check(Object.isFrozen(Equivalence.CRITERION) &&
  Object.isFrozen(Equivalence.CRITERION.params), 'CRITERION is deeply frozen');
check(AnalysisResult.MAX_CP_ABS === globalThis.ChessyAnalysisCore.MATE_NEAR,
  'analysis CP trust band stays aligned with the engine mate boundary');

// ---------------------------------------------------------------------------
console.log('cp case matrix');
// ---------------------------------------------------------------------------
const start = Chess.newGameState();
const legal = Chess.legalMoves(start);
const cp = function (score, i) { return cpLine(start, legal[i], score); };

{
  const best = cp(30, 0);
  const within = cp(0, 1);
  const outside = cp(-10, 2);
  const accepted = Equivalence.comparePersisted(
    clone(Equivalence.CRITERION), best, within, start.turn);
  const rejected = Equivalence.comparePersisted(
    clone(Equivalence.CRITERION), best, outside, start.turn);
  const changed = clone(Equivalence.CRITERION);
  changed.params.cpTolerance = 300;
  const unsupported = Equivalence.comparePersisted(
    changed, best, outside, start.turn);
  const outranking = Equivalence.comparePersisted(
    clone(Equivalence.CRITERION), within, best, start.turn);
  check(accepted.ok && accepted.acceptable && accepted.gapCp === 30 &&
        accepted.bestNotWorse,
    'persisted-pair validation accepts the exact inclusive v1 boundary');
  check(rejected.ok && !rejected.acceptable && rejected.gapCp === 40,
    'persisted-pair validation rejects a legal line outside v1 tolerance');
  check(!unsupported.ok && unsupported.reason === 'criterion',
    'persisted-pair validation fails closed on changed criterion parameters');
  check(outranking.ok && outranking.acceptable && !outranking.bestNotWorse,
    'persisted-pair validation detects a line outranking the claimed best');
}

{
  const result = fixture(start, [cp(30, 0), cp(10, 1), cp(0, 2), cp(-10, 3)],
    { stable: true });
  const best = grade(result, start, result.bestLines[0].uci);
  check(best.ok && best.verdict === 'best' && best.reason === 'engine-best' &&
    best.attempt.gapCp === 0 && best.attempt.rank === 1,
    'the engine best move grades as best with gap 0',
    best.ok ? best.verdict + '/' + best.reason : best.reason);
  check(best.coverage === 'candidates',
    'a 4-line result over ' + legal.length + ' legal roots reports candidates coverage',
    best.coverage);
  check(best.wdl === null && best.criterion.version === 1 &&
    best.criterion.basis === 'cp-mate-fallback' &&
    best.provider.engineId === 'chessy-test' &&
    best.provider.configHash === 'cfg-e1' &&
    best.positionFingerprint === 'fp-start' && best.depth === 4 &&
    best.complete === true && best.legalRootCount === legal.length &&
    best.candidateLineCount === 4 && best.coveredRootCount === 4 &&
    best.playedProbe === null &&
    best.attempt.rankBasis === 'candidate-index' &&
    best.attempt.rankLowerBound === 1 &&
    best.stability.bestMoveStable === true,
    'evidence carries provenance, coverage counts, stability, and null WDL');

  const within = grade(result, start, result.bestLines[1].uci);
  check(within.ok && within.verdict === 'equivalent' &&
    within.reason === 'within-tolerance' && within.attempt.gapCp === 20,
    'a 20 cp gap is equivalent (within the 30 cp tolerance)',
    within.ok ? within.verdict + '/' + within.attempt.gapCp : within.reason);

  const boundary = grade(result, start, result.bestLines[2].uci);
  check(boundary.ok && boundary.verdict === 'equivalent' &&
    boundary.attempt.gapCp === 30,
    'a gap of exactly 30 cp is still equivalent (inclusive boundary)',
    boundary.ok ? boundary.verdict + '/' + boundary.attempt.gapCp : boundary.reason);

  const over = grade(result, start, result.bestLines[3].uci);
  check(over.ok && over.verdict === 'not-equivalent' && over.reason === 'cp-gap' &&
    over.attempt.gapCp === 40,
    'a 40 cp gap with a stable best move is not-equivalent',
    over.ok ? over.verdict + '/' + over.reason : over.reason);

  check(over.accepted.length === 3 &&
    over.accepted.map(function (l) { return l.uci; }).join(',') ===
      result.bestLines.slice(0, 3).map(function (l) { return l.uci; }).join(','),
    'the accepted set is exactly the lines within tolerance',
    over.accepted.map(function (l) { return l.uci; }).join(','));
}

// ---------------------------------------------------------------------------
console.log('persisted source binding');
// ---------------------------------------------------------------------------
{
  const fp = AC.positionFingerprint(start, start.positions);
  const result = fixture(start, [cp(30, 0), cp(10, 1)], { stable: true });
  result.positionFingerprint = fp;
  const expected = {
    identity: Object.assign({}, IDENTITY, { positionFingerprint: fp })
  };
  const ev = grade(result, start, result.bestLines[0].uci, expected);
  const card = {
    gameId: 'source-game',
    ply: 0,
    fenBefore: Chess.toFen(start),
    playedSan: result.bestLines[0].san,
    bestSan: result.bestLines[0].san,
    bestMove: {
      from: result.bestLines[0].move.from,
      to: result.bestLines[0].move.to,
      promotion: result.bestLines[0].move.promotion || null
    },
    due: 1,
    step: -1,
    attempts: [],
    equivalence: {
      criterion: clone(ev.criterion),
      provider: clone(ev.provider),
      positionFingerprint: ev.positionFingerprint,
      turn: ev.turn,
      depth: ev.depth,
      complete: ev.complete,
      coverage: ev.coverage,
      legalRootCount: ev.legalRootCount,
      candidateLineCount: ev.candidateLineCount,
      coveredRootCount: ev.coveredRootCount,
      stability: clone(ev.stability),
      best: clone(ev.best),
      accepted: clone(ev.accepted)
    }
  };
  const game = {
    id: 'source-game',
    setupFen: null,
    sans: [result.bestLines[0].san]
  };
  check(Store.validateCardRecord(card, null, game) === null,
    'persisted evidence reproduces from its archived game and ply');
  const transplanted = clone(card);
  const otherPositions = {};
  otherPositions[Chess.positionKey(start)] = 2;
  transplanted.equivalence.positionFingerprint =
    AC.positionFingerprint(start, otherPositions);
  check(/repetition history/.test(
    Store.validateCardRecord(transplanted, null, game) || ''),
  'same-FEN evidence from a different repetition history fails closed');
  check(/without its source game/.test(
    Store.validateCardRecord(card) || ''),
  'positive evidence cannot validate without its referenced source game');

  const alt = result.bestLines[1];
  const enriched = {
    at: 2,
    grade: 'good',
    correct: false,
    attemptedUci: alt.uci,
    attemptedSan: alt.san,
    verdict: 'equivalent',
    verdictReason: 'accepted-set',
    equivalent: true,
    gapCp: 20,
    evidenceSource: 'card-evidence',
    criterion: { id: ev.criterion.id, version: ev.criterion.version },
    provider: clone(ev.provider),
    recommendedGrade: 'good',
    presentedDue: 1,
    priorStep: -1
  };
  const attemptCard = clone(card);
  attemptCard.attempts = [enriched];
  check(Store.validateCardRecord(attemptCard, null, game) === null,
    'a complete enriched attempt binds canonical move, verdict and card provenance');

  function attemptVariant(mutator) {
    const candidate = clone(attemptCard);
    mutator(candidate.attempts[0], candidate);
    return candidate;
  }
  const exact = attemptVariant(function (a, candidate) {
    candidate.equivalence = null;
    a.correct = true;
    a.attemptedUci = result.bestLines[0].uci;
    a.attemptedSan = result.bestLines[0].san;
    a.verdict = null;
    a.verdictReason = null;
    a.equivalent = null;
    a.gapCp = null;
    a.evidenceSource = null;
    a.criterion = null;
    a.provider = null;
  });
  const pending = attemptVariant(function (a) {
    a.verdict = 'unknown';
    a.verdictReason = 'not-covered';
    a.equivalent = null;
    a.gapCp = null;
    a.evidenceSource = null;
    a.criterion = null;
    a.provider = null;
    a.recommendedGrade = null;
  });
  const liveRejected = attemptVariant(function (a) {
    a.verdict = 'not-equivalent';
    a.verdictReason = 'cp-gap';
    a.equivalent = false;
    a.gapCp = 40;
    a.evidenceSource = 'live-analysis';
    a.recommendedGrade = 'again';
  });
  const legacy = clone(card);
  legacy.attempts = [{ at: 2, grade: 'hard', correct: false }];
  check([exact, pending, liveRejected, legacy].every(function (candidate) {
    return Store.validateCardRecord(candidate, null, game) === null;
  }), 'legacy, exact, pending-unknown and live-analysis attempt shapes stay valid');

  const rejectedAttempts = [
    attemptVariant(function (a) { delete a.provider; }),
    attemptVariant(function (a) { a.grade = 'easy'; }),
    attemptVariant(function (a) { a.attemptedUci = 'a1a1'; }),
    attemptVariant(function (a) { a.attemptedSan = 'forged'; }),
    attemptVariant(function (a) { a.correct = true; }),
    attemptVariant(function (a) { a.equivalent = false; }),
    attemptVariant(function (a) { a.verdictReason = 'cp-gap'; }),
    attemptVariant(function (a) { a.evidenceSource = 'live-analysis'; }),
    attemptVariant(function (a) { a.criterion.version += 1; }),
    attemptVariant(function (a) { a.provider.configHash = 'other'; }),
    attemptVariant(function (a) { a.gapCp = 20.5; }),
    attemptVariant(function (a) { a.recommendedGrade = 'again'; })
  ];
  check(rejectedAttempts.every(function (candidate) {
    return !!Store.validateCardRecord(candidate, null, game);
  }), 'partial, forged and cross-field contradictory attempt evidence fails closed');
}

// ---------------------------------------------------------------------------
console.log('fail-closed rejection needs a stable best');
// ---------------------------------------------------------------------------
{
  const noStability = fixture(start, [cp(30, 0), cp(-10, 1)]);
  const g1 = grade(noStability, start, noStability.bestLines[1].uci);
  check(g1.ok && g1.verdict === 'unknown' && g1.reason === 'unstable-best',
    'without a stability record a 40 cp gap downgrades to unknown, not rejected',
    g1.ok ? g1.verdict + '/' + g1.reason : g1.reason);

  const unstable = fixture(start, [cp(30, 0), cp(-10, 1)], { stable: false });
  const g2 = grade(unstable, start, unstable.bestLines[1].uci);
  check(g2.ok && g2.verdict === 'unknown' && g2.reason === 'unstable-best',
    'with bestMoveStable false the rejection also downgrades to unknown');

  const g3 = grade(unstable, start, unstable.bestLines[0].uci);
  check(g3.ok && g3.verdict === 'best',
    'instability never blocks accepting the best move itself');

  const nearMiss = fixture(start, [cp(30, 0), cp(10, 1)], { stable: false });
  const g4 = grade(nearMiss, start, nearMiss.bestLines[1].uci);
  check(g4.ok && g4.verdict === 'equivalent',
    'instability never blocks accepting a within-tolerance move');
}

// ---------------------------------------------------------------------------
console.log('mate case matrix');
// ---------------------------------------------------------------------------
{
  const mateFor = function (plies, i) {
    return mateLine(start, legal[i], { forWhite: true, inPlies: plies });
  };
  const mateAgainst = function (plies, i) {
    return mateLine(start, legal[i], { forWhite: false, inPlies: plies });
  };

  const bothMate = fixture(start, [mateFor(3, 0), mateFor(7, 1), cp(50, 2)],
    { stable: true });
  const slower = grade(bothMate, start, bothMate.bestLines[1].uci);
  check(slower.ok && slower.verdict === 'equivalent' &&
    slower.reason === 'forced-mate-either-way' && slower.attempt.gapCp === null,
    'a slower forced mate is equivalent when the best line forces mate',
    slower.ok ? slower.verdict + '/' + slower.reason : slower.reason);

  const missed = grade(bothMate, start, bothMate.bestLines[2].uci);
  check(missed.ok && missed.verdict === 'not-equivalent' &&
    missed.reason === 'missed-forced-mate',
    'a centipawn line is rejected when the best line forces mate (stable)',
    missed.ok ? missed.verdict + '/' + missed.reason : missed.reason);

  check(bothMate.bestLines &&
    grade(bothMate, start, bothMate.bestLines[0].uci).attempt.gapCp === null,
    'a mate best move reports no centipawn gap (null, not a converted number)');

  const allLosing = fixture(start,
    [mateAgainst(9, 0), mateAgainst(9, 1), mateAgainst(5, 2)], { stable: true });
  const equalResist = grade(allLosing, start, allLosing.bestLines[1].uci);
  check(equalResist.ok && equalResist.verdict === 'equivalent' &&
    equalResist.reason === 'equal-resistance',
    'equal resistance against a forced mate is equivalent');
  const faster = grade(allLosing, start, allLosing.bestLines[2].uci);
  check(faster.ok && faster.verdict === 'not-equivalent' &&
    faster.reason === 'faster-mate-against',
    'hastening the mate against the player is not-equivalent');

  const walksIn = fixture(start, [cp(30, 0), cp(20, 1), cp(10, 2)], {
    stable: true,
    playedLine: Object.assign(mateAgainst(4, 9), { rank: 12 })
  });
  const walked = grade(walksIn, start, walksIn.playedLine.uci);
  check(walked.ok && walked.verdict === 'not-equivalent' &&
    walked.reason === 'walks-into-mate' && walked.attempt.covered &&
    walked.attempt.rank === 12,
    'an outside-candidates played line that walks into mate is rejected via ' +
    'its own validated evidence',
    walked.ok ? walked.verdict + '/' + walked.reason : walked.reason);
}

// ---------------------------------------------------------------------------
console.log('coverage and the played line');
// ---------------------------------------------------------------------------
{
  const outside = fixture(start, [cp(50, 0), cp(40, 1), cp(30, 2)], {
    stable: true,
    playedLine: Object.assign(cpLine(start, legal[9], 20), { rank: 4 })
  });
  const g = grade(outside, start, outside.playedLine.uci);
  check(g.ok && g.verdict === 'equivalent' && g.attempt.gapCp === 30 &&
    g.attempt.rankBasis === 'provider-reported' &&
    g.attempt.rankLowerBound === 4 &&
    g.candidateLineCount === 3 && g.coveredRootCount === 4 &&
    g.playedProbe && g.playedProbe.uci === outside.playedLine.uci &&
    g.playedProbe.rankBasis === 'provider-reported' &&
    g.accepted.some(function (item) {
      return item.uci === outside.playedLine.uci;
    }),
    'an equivalent outside-candidates line joins the persisted accepted set',
    g.ok ? g.verdict + '/' + g.attempt.gapCp : g.reason);
  const sameResultDifferentAttempt =
    grade(outside, start, outside.bestLines[0].uci);
  check(sameResultDifferentAttempt.ok &&
    JSON.stringify(sameResultDifferentAttempt.accepted) ===
      JSON.stringify(g.accepted) &&
    sameResultDifferentAttempt.playedProbe.uci === outside.playedLine.uci &&
    sameResultDifferentAttempt.coveredRootCount === 4,
    'accepted and covered-root evidence is result-stable across attempts');

  const rejectedProbe = fixture(start, [cp(50, 0), cp(40, 1), cp(30, 2)], {
    stable: true,
    playedLine: Object.assign(cpLine(start, legal[9], -100), { rank: 4 })
  });
  const candidateGrade =
    grade(rejectedProbe, start, rejectedProbe.bestLines[0].uci);
  check(candidateGrade.ok &&
    !candidateGrade.accepted.some(function (item) {
      return item.uci === rejectedProbe.playedLine.uci;
    }) &&
    candidateGrade.playedProbe &&
    candidateGrade.playedProbe.uci === rejectedProbe.playedLine.uci &&
    candidateGrade.coveredRootCount === 4,
    'a non-accepted outside probe remains auditable while grading a candidate');

  const impossible = clone(outside);
  impossible.playedLine.scoreCpWhite = 60;
  impossible.playedLine.scoreCpPlayer = 60;
  const rejected = grade(impossible, start, impossible.playedLine.uci);
  check(!rejected.ok && rejected.reason === 'analysis-played-order',
    'an outside line whose score contradicts its claimed rank fails closed',
    rejected.reason);

  const overflowGap = fixture(start,
    [cp(AnalysisResult.MAX_CP_ABS, 0),
     cp(-AnalysisResult.MAX_CP_ABS - 1, 1)], { stable: true });
  const overflowRejected =
    grade(overflowGap, start, overflowGap.bestLines[1].uci);
  check(!overflowRejected.ok &&
    overflowRejected.reason === 'analysis-best-line-eval',
    'an out-of-band finite cp gap fails closed before evidence serialization',
    overflowRejected.reason);

  const uncovered = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });
  const u = grade(uncovered, start, uci(legal[9]));
  check(u.ok && u.verdict === 'unknown' && u.reason === 'not-covered' &&
    u.attempt.covered === false && u.attempt.rank === null &&
    u.attempt.eval === null && typeof u.attempt.san === 'string',
    'a legal attempt outside the returned lines is unknown, never rejected',
    u.ok ? u.verdict + '/' + u.reason : u.reason);

  const covered = fixture(start, [cp(30, 0), cp(20, 1)],
    { stable: true, playedIndex: 1 });
  const c = grade(covered, start, covered.bestLines[1].uci);
  check(c.ok && c.verdict === 'equivalent' && c.attempt.rank === 2 &&
    c.attempt.rankBasis === 'candidate-index' &&
    c.playedProbe.rankBasis === 'candidate-index' &&
    c.coveredRootCount === 2,
    'an among-candidates played line grades through its candidate evidence');
}

// ---------------------------------------------------------------------------
console.log('fail-closed boundaries');
// ---------------------------------------------------------------------------
{
  const base = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });

  const incomplete = clone(base);
  incomplete.complete = false;
  const inc = grade(incomplete, start, incomplete.bestLines[0].uci);
  check(!inc.ok && inc.reason === 'analysis-incomplete' && inc.verdict === null,
    'an incomplete result produces no evidence', inc.reason);

  const waived = grade(incomplete, start, incomplete.bestLines[0].uci,
    { identity: IDENTITY, requireComplete: false });
  check(!waived.ok && waived.reason === 'analysis-incomplete',
    'callers cannot waive completeness the way scan orchestration can',
    waived.reason);

  const tampered = clone(base);
  tampered.engine.version = 'tampered';
  const t = grade(tampered, start, tampered.bestLines[0].uci);
  check(!t.ok && t.reason === 'analysis-provenance',
    'a provenance mismatch produces no evidence', t.reason);

  const illegal = grade(base, start, 'e2e5');
  check(!illegal.ok && illegal.reason === 'attempt-illegal',
    'an illegal attempt UCI fails closed', illegal.reason);
  const nonString = grade(base, start, null);
  check(!nonString.ok && nonString.reason === 'attempt-illegal',
    'a non-string attempt fails closed', nonString.reason);
}

// ---------------------------------------------------------------------------
console.log('canonical trust snapshot');
// ---------------------------------------------------------------------------
{
  const base = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });

  let turnReads = 0;
  Object.defineProperty(base, 'turn', {
    enumerable: true,
    configurable: true,
    get: function () {
      turnReads++;
      if (turnReads > 1) throw new Error('turn was read outside the boundary');
      return 'w';
    }
  });
  const once = grade(base, start, base.bestLines[0].uci);
  check(once.ok && once.verdict === 'best' && once.turn === 'w' &&
    turnReads === 1,
    'an accessor-backed field is snapshotted once, then graded canonically',
    (once.ok ? once.verdict : once.reason) + '/reads=' + turnReads);

  const target = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });
  let proxyReads = 0;
  const proxied = new Proxy(target, {
    get: function (object, key) {
      if (key === 'bestLines') {
        proxyReads++;
        if (proxyReads > 1) throw new Error('bestLines escaped the snapshot');
      }
      return object[key];
    }
  });
  const viaProxy = grade(proxied, start, target.bestLines[1].uci);
  check(viaProxy.ok && viaProxy.verdict === 'equivalent' && proxyReads === 1,
    'a Proxy-backed result is never re-read after validation',
    (viaProxy.ok ? viaProxy.verdict : viaProxy.reason) +
      '/reads=' + proxyReads);

  const stateView = clone(start);
  let stateReads = 0;
  Object.defineProperty(stateView, 'turn', {
    enumerable: true,
    configurable: true,
    get: function () {
      stateReads++;
      if (stateReads > 1) throw new Error('state escaped the snapshot');
      return 'w';
    }
  });
  const fromState = grade(target, stateView, target.bestLines[0].uci);
  check(fromState.ok && fromState.turn === 'w' && stateReads === 1,
    'the source state shares the same one-read canonical boundary',
    (fromState.ok ? fromState.verdict : fromState.reason) +
      '/reads=' + stateReads);

  const throwing = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });
  Object.defineProperty(throwing, 'engine', {
    enumerable: true,
    configurable: true,
    get: function () { throw new Error('unreadable provider result'); }
  });
  const rejected = grade(throwing, start, throwing.bestLines[0].uci);
  check(!rejected.ok &&
    rejected.reason === 'analysis-validation-error' &&
    rejected.verdict === null,
    'a throwing snapshot trap fails closed instead of unwinding grade()',
    rejected.reason);

  const cyclic = fixture(start, [cp(30, 0), cp(20, 1)], { stable: true });
  cyclic.extraCycle = cyclic;
  const cycleRejected = grade(cyclic, start, cyclic.bestLines[0].uci);
  check(!cycleRejected.ok &&
    cycleRejected.reason === 'analysis-validation-error',
    'a cyclic provider value fails closed at the canonical boundary',
    cycleRejected.reason);
}

// ---------------------------------------------------------------------------
console.log('purity and determinism');
// ---------------------------------------------------------------------------
{
  const result = fixture(start, [cp(30, 0), cp(-10, 1)], { stable: true });
  const before = JSON.stringify(result);
  const a = grade(result, start, result.bestLines[1].uci);
  const b = grade(result, start, result.bestLines[1].uci);
  check(JSON.stringify(a) === JSON.stringify(b),
    'the same stored inputs always reproduce the same evidence');
  check(JSON.stringify(result) === before,
    'grading never mutates the analysis result');
  check(Object.isFrozen(a) && Object.isFrozen(a.attempt) &&
    Object.isFrozen(a.accepted) && Object.isFrozen(a.best) &&
    Object.isFrozen(a.stability) && Object.isFrozen(a.stability.depths),
    'evidence is deeply frozen');
  check(a.best.mate === null && a.accepted[0].scoreCpWhite === 30 &&
    a.accepted.length === 1,
    'evidence snapshots scores rather than aliasing result internals');
}

// ---------------------------------------------------------------------------
console.log('real analysis-core integration');
// ---------------------------------------------------------------------------
// Mirror the E3 scorecard's reference configuration: complete scoring of
// every legal root at a small fixed node budget, deterministic and fast.
{
  const REF = { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 999, pvLen: 4, quiesce: true };
  const state = Chess.newGameState();
  const res = AC.analyse(state, REF);
  const expected = AC.identity(state, REF);
  const roots = Chess.legalMoves(state).length;

  const best = Equivalence.grade(res, state, expected, res.bestLines[0].uci);
  check(best.ok && best.verdict === 'best' && best.coverage === 'all-roots',
    'live all-roots analysis grades its own best move as best',
    best.ok ? best.verdict + '/' + best.coverage : best.reason);

  // Spec conformance over EVERY legal root, recomputed from the raw fields:
  // the module must agree with the documented case matrix on live output
  // without this test pinning a single engine-specific score.
  let agree = 0;
  for (let i = 0; i < res.bestLines.length; i++) {
    const line = res.bestLines[i];
    const g = Equivalence.grade(res, state, expected, line.uci);
    if (!g.ok) break;
    let want;
    if (i === 0) want = 'best';
    else {
      const bestLine = res.bestLines[0];
      let acceptable;
      if (line.mate) {
        acceptable = line.mate.forWhite === (res.turn === 'w') ? true :
          (bestLine.mate && bestLine.mate.forWhite !== (res.turn === 'w') &&
            line.mate.inPlies >= bestLine.mate.inPlies);
      } else if (bestLine.mate) {
        acceptable = bestLine.mate.forWhite !== (res.turn === 'w');
      } else {
        acceptable = bestLine.scoreCpPlayer - line.scoreCpPlayer <= 30;
      }
      const stable = !!res.stability && res.stability.bestMoveStable === true;
      want = acceptable ? 'equivalent' : (stable ? 'not-equivalent' : 'unknown');
    }
    if (g.verdict === want && g.attempt.rank === i + 1) agree++;
  }
  check(agree === res.bestLines.length && res.bestLines.length === roots,
    'grade() matches the documented case matrix on all ' + roots + ' live roots',
    agree + '/' + res.bestLines.length);

  // The shipped coaching shape: width-3 candidates plus a playedMove probe.
  // An attempt outside the candidates grades through its provider-reported
  // played-line rank; this integration fixture independently checks that rank
  // against a complete all-roots reference.
  const probe = res.bestLines[res.bestLines.length - 1];
  const SHIP = { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 3, pvLen: 4,
    quiesce: true, playedMove: probe.move };
  const shipRes = AC.analyse(state, SHIP);
  const shipExpected = AC.identity(state, SHIP);
  const viaPlayed = Equivalence.grade(shipRes, state, shipExpected, probe.uci);
  check(viaPlayed.ok && viaPlayed.attempt.covered &&
    viaPlayed.attempt.rank === roots &&
    viaPlayed.attempt.rankBasis === 'provider-reported' &&
    viaPlayed.attempt.rankLowerBound === 4 &&
    viaPlayed.coverage === 'candidates',
    'an outside rank is provider-reported and independently matches all roots',
    viaPlayed.ok ? viaPlayed.attempt.rank + ' vs ' + roots : viaPlayed.reason);

  const shipNoPlayed = AC.analyse(state,
    { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 3, pvLen: 4, quiesce: true });
  const unknown = Equivalence.grade(shipNoPlayed, state,
    AC.identity(state, { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 3, pvLen: 4, quiesce: true }),
    probe.uci);
  check(unknown.ok && unknown.verdict === 'unknown' &&
    unknown.reason === 'not-covered',
    'without a played-line probe the same attempt is unknown, never rejected',
    unknown.ok ? unknown.verdict + '/' + unknown.reason : unknown.reason);
}

// ---------------------------------------------------------------------------
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
