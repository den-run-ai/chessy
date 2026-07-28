/*
 * Play-search telemetry must be forensic but behavior-neutral. The signatures
 * below were frozen from main@1e7cbaec before telemetry existed: move, score,
 * completed depth and every search counter must remain byte-for-byte equal.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
require('../assets/store.js');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}
function uci(m) {
  return Chess.sqName(m.from) + Chess.sqName(m.to) +
    (m.promotion ? m.promotion.toLowerCase() : '');
}
function legalPv(fen, pv) {
  let s = Chess.parseFen(fen);
  for (const wanted of pv) {
    const legal = Chess.legalMoves(s);
    const m = legal.find(function (x) { return uci(x) === wanted; });
    if (!m) return false;
    s = Chess.applyMove(s, m);
  }
  return true;
}

const cases = [
  {
    name: 'start',
    fen: Chess.START_FEN,
    nodes: 12000,
    expected: {
      uci: 'd2d4', depth: 4, score: 0, nodes: 12000, qnodes: 6372,
      cutoffs: 1097, researches: 17
    }
  },
  {
    name: 'screenshot move 19',
    fen: 'r3r1k1/1pp2pp1/2nq3p/2b5/p4P2/2PpPQP1/PP1B2BP/R3R2K b - - 1 19',
    nodes: 50000,
    expected: {
      uci: 'a4a3', depth: 4, score: -141, nodes: 50000, qnodes: 38314,
      cutoffs: 2797, researches: 23
    }
  },
  {
    name: 'screenshot move 24',
    fen: '4r1k1/rpp2pp1/1bn4p/3B4/1PP2P2/p2pP1P1/P2B3P/1R2R2K b - - 0 24',
    nodes: 100000,
    expected: {
      uci: 'c6b4', depth: 5, score: -13, nodes: 100000, qnodes: 63025,
      cutoffs: 5872, researches: 41
    }
  }
];

console.log('behavior-neutral fixed-node signatures');
for (const c of cases) {
  const state = Chess.parseFen(c.fen);
  const r = ChessAI.think(state, {
    maxDepth: 30, nodeLimit: c.nodes, quiesce: true, randomize: false
  });
  const actual = {
    uci: uci(r.move), depth: r.depth, score: r.score, nodes: r.nodes,
    qnodes: r.qnodes, cutoffs: r.cutoffs, researches: r.researches
  };
  check(JSON.stringify(actual) === JSON.stringify(c.expected),
    c.name + ' search signature unchanged', JSON.stringify(actual));
  check(r.stopReason === 'node-limit' && r.attemptedDepth === r.depth + 1,
    c.name + ' distinguishes completed and aborted drafts',
    r.stopReason + ' d' + r.depth + '/attempted ' + r.attemptedDepth);
  check(Array.isArray(r.pvUci) && r.pvUci[0] === actual.uci &&
      legalPv(c.fen, r.pvUci),
    c.name + ' best-effort PV is rooted in the selected move and legal',
    JSON.stringify(r.pvUci));
  const legalRoot = Chess.legalMoves(state).map(uci).sort();
  check(Array.isArray(r.rootOrderUci) &&
      JSON.stringify(r.rootOrderUci.slice().sort()) === JSON.stringify(legalRoot),
    c.name + ' captures the complete initial legal root order',
    JSON.stringify(r.rootOrderUci));
  check(r.pvSource === 'final-tt-best-effort' &&
      r.scorePov === 'white' && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0,
    c.name + ' labels PV, score POV and elapsed search time');
}

console.log('stop reasons and backwards-compatible normalization');
const casual = ChessAI.think(Chess.newGameState(), {
  maxDepth: 30, nodeLimit: 12000, quiesce: true
});
const replayed = ChessAI.think(Chess.newGameState(), {
  maxDepth: 30, nodeLimit: 12000, quiesce: true,
  rootOrderUci: casual.rootOrderUci
});
function signature(r) {
  return {
    move: uci(r.move), depth: r.depth, score: r.score, nodes: r.nodes,
    qnodes: r.qnodes, cutoffs: r.cutoffs, researches: r.researches
  };
}
check(JSON.stringify(signature(replayed)) === JSON.stringify(signature(casual)),
  'captured casual root order exactly replays move, score, depth and counters',
  JSON.stringify({ original: signature(casual), replay: signature(replayed) }));

const fixed = ChessAI.think(Chess.newGameState(), {
  maxDepth: 1, quiesce: true, randomize: false
});
check(fixed.stopReason === 'max-depth' && fixed.attemptedDepth === null,
  'a fully completed fixed-depth search reports max-depth, with no aborted draft');
const exactFinalBudget = ChessAI.think(Chess.newGameState(), {
  maxDepth: 1, nodeLimit: fixed.nodes, quiesce: true, randomize: false
});
check(exactFinalBudget.nodes === fixed.nodes &&
    exactFinalBudget.stopReason === 'max-depth' &&
    exactFinalBudget.attemptedDepth === null,
  'an exactly exhausted final-draft node budget still reports max-depth',
  JSON.stringify({
    expectedNodes: fixed.nodes, nodes: exactFinalBudget.nodes,
    reason: exactFinalBudget.stopReason,
    attemptedDepth: exactFinalBudget.attemptedDepth
  }));
const promotion = ChessAI.think(
  Chess.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1'),
  { maxDepth: 1, randomize: false });
check(promotion.pvUci[0] === 'a7a8q',
  'PV uses canonical lowercase UCI promotion suffixes',
  JSON.stringify(promotion.pvUci));
const terminal = Chess.replaySans(['f3', 'e5', 'g4', 'Qh4#']);
const over = ChessAI.think(terminal, { maxDepth: 4 });
check(over.stopReason === 'game-over' && over.move === null &&
    over.attemptedDepth === null && Array.isArray(over.pvUci) &&
    Array.isArray(over.rootOrderUci) && over.scorePov === 'white',
  'an already-finished game has explicit terminal telemetry');

const savedNow = Date.now;
const dualBudgetCtx = ChessAI.makeCtx(false, 0, 1024);
let dualAborted = false;
Date.now = function () { return 1; };
try {
  ChessAI.search(Chess.newGameState(), 5, -Infinity, Infinity, false,
    { ctx: dualBudgetCtx });
} catch (e) {
  dualAborted = true;
} finally {
  Date.now = savedNow;
}
check(dualAborted && dualBudgetCtx.nodes === 1023 &&
    dualBudgetCtx.abortReason === 'time-limit',
  'deadline ABORT excludes the polled node whose body was never entered',
  JSON.stringify({ nodes: dualBudgetCtx.nodes, reason: dualBudgetCtx.abortReason }));

let deadlineClockCalls = 0;
let timedCutoff;
Date.now = function () {
  // startedAt, then two completed-draft checks, then the 1024th-node poll.
  return ++deadlineClockCalls >= 4 ? 1 : 0;
};
try {
  timedCutoff = ChessAI.think(Chess.newGameState(), {
    maxDepth: 30, timeMs: 1, quiesce: true, seed: 12345
  });
} finally {
  Date.now = savedNow;
}
const timedReplay = ChessAI.think(Chess.newGameState(), {
  maxDepth: 30, nodeLimit: timedCutoff.nodes, quiesce: true,
  rootOrderUci: timedCutoff.rootOrderUci
});
const timedSignature = Object.assign(signature(timedCutoff), {
  attemptedDepth: timedCutoff.attemptedDepth
});
const replaySignature = Object.assign(signature(timedReplay), {
  attemptedDepth: timedReplay.attemptedDepth
});
check(timedCutoff.stopReason === 'time-limit' &&
    timedCutoff.nodes === 1023 &&
    timedReplay.stopReason === 'node-limit' &&
    JSON.stringify(replaySignature) === JSON.stringify(timedSignature),
  'a timed cutoff replays exactly at its fully-entered node count and captured root order',
  JSON.stringify({ timed: timedSignature, replay: replaySignature }));

const legacy = ChessAI.sanitizeTelemetry({ depth: 5, quiesce: true, ms: 123 });
check(legacy && legacy.depth === 5 && legacy.quiesce && legacy.ms === 123 &&
    legacy.elapsedMs === 123 && legacy.nodes === null &&
    legacy.stopReason === 'unknown' &&
    !Object.prototype.hasOwnProperty.call(legacy, 'rootOrderUci'),
  'legacy evidence upgrades without inventing an empty captured root order');
check(legacy.engine === 'js' && legacy.engineFallback === null,
  'pre-WASM evidence normalizes to the JavaScript engine it actually used');
const normalized = ChessAI.sanitizeTelemetry({
  release: 'r54', depth: 4, attemptedDepth: 5, maxDepth: 30,
  quiesce: true, timeMs: 5000, seed: 4294967295, randomize: true,
  elapsedMs: 5002, searchMs: 5000, nodes: 50000, qnodes: 30000,
  cutoffs: 10, researches: 2, score: -141,
  scorePov: 'white',
  pvUci: ['a4a3', 'b2b4', 'bad'], pvSource: 'final-tt-best-effort',
  rootOrderUci: ['a4a3', 'a4b4'],
  stopReason: 'time-limit', source: 'sync-fallback', fallbackReason: 'watchdog',
  engine: 'wasm', engineFallback: 'wasm-load-error'
});
check(normalized.pvUci.join(' ') === 'a4a3 b2b4' &&
    normalized.rootOrderUci.join(' ') === 'a4a3 a4b4' &&
    normalized.attemptedDepth === 5 && normalized.source === 'sync-fallback' &&
    normalized.fallbackReason === 'watchdog' &&
    normalized.scorePov === 'white' && normalized.seed === -1,
  'new telemetry is bounded and malformed PV entries are dropped');
check(normalized.engine === 'wasm' && normalized.engineFallback === null &&
    ChessAI.sanitizeTelemetry({ depth: 1, quiesce: false, ms: 1,
      engine: 'mystery', engineFallback: 'mystery' }).engine === 'js' &&
    ChessAI.sanitizeTelemetry({ depth: 1, quiesce: false, ms: 1,
      engine: 'mystery', engineFallback: 'mystery' }).engineFallback === null,
  'engine provenance survives; unknown engines collapse to js and a ' +
  'contradictory wasm+fallback pair drops the fallback label');
const jsFallback = ChessAI.sanitizeTelemetry({ depth: 1, quiesce: false,
  ms: 1, engine: 'js', engineFallback: 'wasm-search-error' });
check(jsFallback.engine === 'js' &&
    jsFallback.engineFallback === 'wasm-search-error',
  'a JavaScript answer keeps its wasm-fallback label (the real worker shape)');

const injectedRelease = 'r54} 99. Qh8# {';
const hostile = ChessAI.sanitizeTelemetry({
  depth: 1, quiesce: false, ms: 1, release: injectedRelease
});
check(hostile.release === null,
  'telemetry drops a release token that could terminate a PGN comment');

const initialRootOrder = Chess.legalMoves(Chess.newGameState()).map(uci);
const positionNormalized = Object.assign({}, normalized, {
  rootOrderUci: initialRootOrder.slice().reverse()
});
const validGame = {
  id: 'telemetry', sans: ['e4'], result: '*', plies: 1, createdAt: 1,
  startedRelease: 'r54', ai: [positionNormalized]
};
check(CoachStore.validateGameRecord(validGame) === null,
  'shared pending/backup boundary accepts canonical provenance');
check(CoachStore.validateGameRecord(
  Object.assign({}, validGame, { ai: [legacy] })) === null,
  'shared boundary keeps rootless legacy telemetry compatible');
const badStarted = Object.assign({}, validGame, { startedRelease: injectedRelease });
const badAi = Object.assign({}, validGame, {
  ai: [Object.assign({}, positionNormalized, { release: injectedRelease })]
});
check(/startedRelease/.test(CoachStore.validateGameRecord(badStarted) || '') &&
    /AI telemetry/.test(CoachStore.validateGameRecord(badAi) || ''),
  'shared pending/backup boundary rejects malformed game and move releases');
const badEvidence = [
  Object.assign({}, positionNormalized, { rootOrderUci: ['a4a3', 'a4a3'] }),
  Object.assign({}, positionNormalized, { rootOrderUci: undefined }),
  Object.assign({}, positionNormalized, { scorePov: 'side-to-move' }),
  Object.assign({}, positionNormalized, { fallbackReason: 'mystery' }),
  Object.assign({}, positionNormalized, { engine: 'mystery' }),
  Object.assign({}, positionNormalized, { engineFallback: 'mystery' }),
  Object.assign({}, positionNormalized,
    { engine: 'wasm', engineFallback: 'wasm-load-error' })
];
check(badEvidence.every(function (ai) {
  return /AI telemetry/.test(CoachStore.validateGameRecord(
    Object.assign({}, validGame, { ai: [ai] })) || '');
}), 'shared boundary rejects duplicate/undefined roots and unknown score/fallback provenance');
const substitutedRoot = initialRootOrder.slice();
substitutedRoot[0] = 'a1a8';
const mismatchedRoots = [
  initialRootOrder.slice(1),
  substitutedRoot,
  []
].map(function (rootOrderUci) {
  return Object.assign({}, positionNormalized, { rootOrderUci: rootOrderUci });
});
check(mismatchedRoots.every(function (ai) {
  const error = CoachStore.validateGameRecord(
    Object.assign({}, validGame, { ai: [ai] })) || '';
  return /root order/.test(error) && /position/.test(error);
}), 'shared boundary rejects truncated, substituted and explicitly empty root orders');
const damagedTelemetryGame = Object.assign({}, validGame, {
  ai: [mismatchedRoots[0]]
});
check(CoachStore.validateGameReplayRecord(damagedTelemetryGame) === null &&
    /root order/.test(CoachStore.validateGameRecord(damagedTelemetryGame) || ''),
  'clean replay boundary preserves a valid score when only forensic telemetry is damaged');

const afterE4 = Chess.replaySans(['e4']);
const blackRootOrder = Chess.legalMoves(afterE4).map(uci).reverse();
const twoPlyGame = {
  id: 'telemetry-two-ply', sans: ['e4', 'e5'], result: '*',
  plies: 2, createdAt: 2, ai: [
    null,
    Object.assign({}, positionNormalized, { rootOrderUci: blackRootOrder })
  ]
};
check(CoachStore.validateGameRecord(twoPlyGame) === null &&
    /root order/.test(CoachStore.validateGameRecord(Object.assign({}, twoPlyGame, {
      ai: [null, positionNormalized]
    })) || ''),
  'root-order validation replays the SAN prefix and checks the matching ply');

const promotionFen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
const promotionRoots = Chess.legalMoves(Chess.parseFen(promotionFen))
  .map(uci).reverse();
const promotionGame = {
  id: 'telemetry-promotion', setupFen: promotionFen,
  sans: ['a8=Q+'], result: '*', plies: 1, createdAt: 3,
  ai: [Object.assign({}, positionNormalized, {
    rootOrderUci: promotionRoots
  })]
};
check(promotionRoots.indexOf('a7a8q') !== -1 &&
    promotionRoots.indexOf('a7a8n') !== -1 &&
    CoachStore.validateGameRecord(promotionGame) === null,
  'custom-position root validation preserves canonical promotion suffixes');
const badEnvelope = {
  format: 'chessy-coach-backup', version: 1, dbVersion: 6,
  release: injectedRelease, stores: { games: [], cards: [] }
};
check(/invalid release/.test(CoachStore.validateBackup(badEnvelope) || ''),
  'backup envelope rejects a malformed-brace release');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
