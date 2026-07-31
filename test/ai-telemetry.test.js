/*
 * Engine-independent Play telemetry sanitizer and durable-store boundary.
 * Rust/WASM search behavior and counters live in the WASM signature/loader
 * suites; this file protects old save/backup/PGN provenance across migration.
 */
'use strict';
require('../assets/engine.js');
globalThis.ChessyAiTelemetry = require('../assets/ai-telemetry.js');
require('../assets/store.js');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}
function uci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

check(ChessyAiTelemetry.sanitizeTelemetry(null) === null &&
    ChessyAiTelemetry.sanitizeTelemetry([]) === null,
  'non-object telemetry is rejected');

const legacy = ChessyAiTelemetry.sanitizeTelemetry({
  depth: 5, quiesce: true, ms: 123
});
check(legacy && legacy.depth === 5 && legacy.quiesce && legacy.ms === 123 &&
    legacy.elapsedMs === 123 && legacy.nodes === null &&
    legacy.stopReason === 'unknown' &&
    !Object.prototype.hasOwnProperty.call(legacy, 'rootOrderUci'),
  'legacy evidence upgrades without inventing an empty captured root order');
check(legacy.engine === 'js' && legacy.engineFallback === null,
  'pre-WASM evidence keeps the JavaScript engine it actually used');

const initialRootOrder = Chess.legalMoves(Chess.newGameState()).map(uci);
const normalized = ChessyAiTelemetry.sanitizeTelemetry({
  release: 'r71', depth: 4, attemptedDepth: 5, maxDepth: 30,
  quiesce: true, timeMs: 5000, nodeLimit: 10000,
  elapsedMs: 5002, searchMs: 5000, nodes: 10000, qnodes: 6000,
  cutoffs: 10, researches: 2, score: -141, scorePov: 'white',
  pvUci: ['a2a3', 'bad'], rootOrderUci: initialRootOrder.slice().reverse(),
  stopReason: 'node-limit', source: 'worker', engine: 'wasm'
});
check(normalized.pvUci.join(' ') === 'a2a3' &&
    normalized.rootOrderUci.length === initialRootOrder.length &&
    normalized.attemptedDepth === 5 && normalized.source === 'worker' &&
    normalized.engine === 'wasm' && normalized.engineFallback === null &&
    normalized.scorePov === 'white',
  'current WASM telemetry is bounded and malformed UCI entries are dropped');

const contradictory = ChessyAiTelemetry.sanitizeTelemetry({
  depth: 1, quiesce: false, ms: 1, engine: 'wasm',
  engineFallback: 'wasm-load-error'
});
const unknown = ChessyAiTelemetry.sanitizeTelemetry({
  depth: 1, quiesce: false, ms: 1,
  engine: 'mystery', engineFallback: 'mystery'
});
check(contradictory.engine === 'wasm' &&
    contradictory.engineFallback === null &&
    unknown.engine === 'js' && unknown.engineFallback === null,
  'unknown engines collapse to legacy JS and contradictory WASM fallback is dropped');

const legacyFallback = ChessyAiTelemetry.sanitizeTelemetry({
  depth: 1, quiesce: false, ms: 1, source: 'sync-fallback',
  fallbackReason: 'watchdog', engine: 'js',
  engineFallback: 'wasm-search-error'
});
check(legacyFallback.engine === 'js' &&
    legacyFallback.source === 'sync-fallback' &&
    legacyFallback.fallbackReason === 'watchdog' &&
    legacyFallback.engineFallback === 'wasm-search-error',
  'historical JavaScript fallback provenance remains readable');

const injectedRelease = 'r54} 99. Qh8# {';
const hostile = ChessyAiTelemetry.sanitizeTelemetry({
  depth: 1, quiesce: false, ms: 1, release: injectedRelease
});
check(hostile.release === null,
  'telemetry drops a release token that could terminate a PGN comment');

const validGame = {
  id: 'telemetry', sans: ['e4'], result: '*', plies: 1, createdAt: 1,
  startedRelease: 'r71', ai: [normalized]
};
check(CoachStore.validateGameRecord(validGame) === null,
  'shared pending/backup boundary accepts canonical WASM provenance');
check(CoachStore.validateGameRecord(
  Object.assign({}, validGame, { ai: [legacy] })) === null,
  'shared boundary keeps rootless legacy telemetry compatible');

const badStarted = Object.assign({}, validGame, {
  startedRelease: injectedRelease
});
const badAi = Object.assign({}, validGame, {
  ai: [Object.assign({}, normalized, { release: injectedRelease })]
});
check(/startedRelease/.test(CoachStore.validateGameRecord(badStarted) || '') &&
    /AI telemetry/.test(CoachStore.validateGameRecord(badAi) || ''),
  'shared boundary rejects malformed game and move releases');

const badEvidence = [
  Object.assign({}, normalized, { rootOrderUci: ['a2a3', 'a2a3'] }),
  Object.assign({}, normalized, { rootOrderUci: undefined }),
  Object.assign({}, normalized, { scorePov: 'side-to-move' }),
  Object.assign({}, normalized, { fallbackReason: 'mystery' }),
  Object.assign({}, normalized, { engine: 'mystery' }),
  Object.assign({}, normalized, { engineFallback: 'mystery' }),
  Object.assign({}, normalized,
    { engine: 'wasm', engineFallback: 'wasm-load-error' })
];
check(badEvidence.every(function (ai) {
  return /AI telemetry/.test(CoachStore.validateGameRecord(
    Object.assign({}, validGame, { ai: [ai] })) || '');
}), 'shared boundary rejects duplicate/undefined roots and unknown provenance');

const substitutedRoot = initialRootOrder.slice();
substitutedRoot[0] = 'a1a8';
const mismatchedRoots = [
  initialRootOrder.slice(1),
  substitutedRoot,
  []
].map(function (rootOrderUci) {
  return Object.assign({}, normalized, { rootOrderUci: rootOrderUci });
});
check(mismatchedRoots.every(function (ai) {
  const error = CoachStore.validateGameRecord(
    Object.assign({}, validGame, { ai: [ai] })) || '';
  return /root order/.test(error) && /position/.test(error);
}), 'shared boundary rejects truncated, substituted and empty root orders');

const damagedTelemetryGame = Object.assign({}, validGame, {
  ai: [mismatchedRoots[0]]
});
check(CoachStore.validateGameReplayRecord(damagedTelemetryGame) === null &&
    /root order/.test(CoachStore.validateGameRecord(damagedTelemetryGame) || ''),
  'clean replay boundary preserves a valid score when telemetry is damaged');

const afterE4 = Chess.replaySans(['e4']);
const blackRootOrder = Chess.legalMoves(afterE4).map(uci).reverse();
const twoPlyGame = {
  id: 'telemetry-two-ply', sans: ['e4', 'e5'], result: '*',
  plies: 2, createdAt: 2, ai: [
    null,
    Object.assign({}, normalized, { rootOrderUci: blackRootOrder })
  ]
};
check(CoachStore.validateGameRecord(twoPlyGame) === null &&
    /root order/.test(CoachStore.validateGameRecord(Object.assign({}, twoPlyGame, {
      ai: [null, normalized]
    })) || ''),
  'root-order validation checks the matching replayed ply');

const promotionFen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
const promotionRoots = Chess.legalMoves(Chess.parseFen(promotionFen))
  .map(uci).reverse();
const promotionGame = {
  id: 'telemetry-promotion', setupFen: promotionFen,
  sans: ['a8=Q+'], result: '*', plies: 1, createdAt: 3,
  ai: [Object.assign({}, normalized, { rootOrderUci: promotionRoots })]
};
check(promotionRoots.indexOf('a7a8q') !== -1 &&
    promotionRoots.indexOf('a7a8n') !== -1 &&
    CoachStore.validateGameRecord(promotionGame) === null,
  'custom-position root validation preserves promotion suffixes');

const badEnvelope = {
  format: 'chessy-coach-backup', version: 1, dbVersion: 6,
  release: injectedRelease, stores: { games: [], cards: [] }
};
check(/invalid release/.test(CoachStore.validateBackup(badEnvelope) || ''),
  'backup envelope rejects a malformed-brace release');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
