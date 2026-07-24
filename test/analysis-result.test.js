/*
 * Analysis-result trust boundary — run with:
 *   node test/analysis-result.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('../assets/engine.js');
const Result = require('../assets/analysis-result.js');
const Chess = globalThis.Chess;

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
    move: {
      from: move.from,
      to: move.to,
      promotion: move.promotion || null
    },
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
    move: {
      from: move.from,
      to: move.to,
      promotion: move.promotion || null
    },
    uci: uci(move),
    san: san,
    scoreCpWhite: null,
    scoreCpPlayer: null,
    mate: mate,
    pv: [san],
    pvUci: [uci(move)]
  };
}

function fixture(state, identity, lines, playedIndex) {
  const played = clone(lines[playedIndex]);
  played.rank = playedIndex + 1;
  played.amongCandidates = true;
  return {
    engine: {
      id: identity.engineId,
      version: identity.version,
      configHash: identity.configHash
    },
    turn: state.turn,
    positionFingerprint: identity.positionFingerprint,
    complete: true,
    depth: 4,
    nodes: 1234,
    elapsedMs: 12,
    scoreCpWhite: lines[0].scoreCpWhite,
    scoreCpPlayer: lines[0].scoreCpPlayer,
    mate: clone(lines[0].mate),
    bestLines: clone(lines),
    playedLine: played,
    classification: playedIndex === 0 ? 'same' : 'different-candidate'
  };
}

function expectReject(label, source, state, expected, reason) {
  const verdict = Result.validate(source, state, expected);
  check(!verdict.ok && (!reason || verdict.reason === reason), label,
    verdict.ok ? 'accepted' : verdict.reason);
}

const state = Chess.newGameState();
const legal = Chess.legalMoves(state);
const lines = [
  cpLine(state, legal[0], 30),
  cpLine(state, legal[1], 20),
  cpLine(state, legal[2], 10)
];
const identity = {
  engineId: 'chessy-test',
  version: '5.0.0',
  configHash: 'cfg-phase5',
  positionFingerprint: 'fp-start'
};
const expected = {
  identity: identity,
  requireComplete: true,
  requirePlayed: true,
  playedMove: lines[1].move,
  minDepth: 3
};
const good = fixture(state, identity, lines, 1);

const accepted = Result.validate(good, state, expected);
check(accepted.ok && Result.sameMove(accepted.topMove, lines[0].move) &&
  Result.sameMove(accepted.playedMove, lines[1].move),
  'accepts a complete, provenanced result and resolves top/played moves',
  accepted.reason);
check(accepted.bestMoves && accepted.bestMoves.length === 3,
  'returns every resolved candidate move');
check(Result.resolveLine(state, lines[0]).ok,
  'resolveLine accepts canonical legal UCI/SAN/PV');
check(Result.validEval(lines[0], 'w') &&
  !Result.validEval(Object.assign({}, lines[0], { scoreCpPlayer: -30 }), 'w'),
  'validEval enforces finite, side-correct centipawn scores');
check(Result.uciOf(lines[0].move) === lines[0].uci,
  'uciOf emits canonical lower-case UCI');

let bad = clone(good);
bad.complete = false;
expectReject('rejects incomplete results', bad, state, expected, 'incomplete');
bad = clone(good);
bad.complete = 'true';
expectReject('requires explicit boolean complete=true', bad, state, expected, 'incomplete');
const optionalComplete = clone(good);
optionalComplete.complete = false;
check(Result.validate(optionalComplete, state, {
  identity: identity, requireComplete: false, requirePlayed: true
}).ok, 'requireComplete=false permits an explicitly incomplete result');

for (const field of ['version', 'configHash', 'positionFingerprint']) {
  const changed = clone(expected);
  changed.identity[field] += '-other';
  expectReject('rejects mismatched ' + field, good, state, changed, 'provenance');
}
const changedEngine = clone(expected);
changedEngine.identity.engineId = 'other-engine';
expectReject('rejects mismatched engine id', good, state, changedEngine, 'provenance');
const changedTurn = clone(expected);
changedTurn.turn = 'b';
expectReject('rejects expected/source turn disagreement', good, state,
  changedTurn, 'expected-turn');
bad = clone(good);
bad.turn = 'b';
expectReject('rejects result turn disagreement', bad, state, expected, 'turn');

bad = clone(good);
bad.depth = Infinity;
expectReject('rejects non-finite depth', bad, state, expected, 'depth');
bad = clone(good);
bad.depth = 2;
expectReject('enforces minimum depth', bad, state, expected, 'min-depth');
const stable = clone(good);
stable.stability = { depths: [3, 4], bestMoveStable: true };
check(Result.validate(stable, state, Object.assign({}, expected, {
  requireStability: true
})).ok, 'accepts contract-shaped stability when the caller requires it');
expectReject('required stability cannot be omitted', good, state,
  Object.assign({}, expected, { requireStability: true }), 'stability-required');
bad = clone(stable);
bad.stability.depths = [2, 4];
expectReject('stability depths must be the reported depth pair', bad, state,
  Object.assign({}, expected, { requireStability: true }), 'stability');
bad = clone(stable);
bad.stability.bestMoveStable = 'true';
expectReject('stability bestMoveStable must be an explicit boolean', bad, state,
  Object.assign({}, expected, { requireStability: true }), 'stability');
bad = clone(good);
bad.nodes = NaN;
expectReject('rejects non-finite nodes', bad, state, expected, 'nodes');
bad = clone(good);
bad.elapsedMs = Infinity;
expectReject('rejects non-finite elapsed time', bad, state, expected, 'elapsed');
bad = clone(good);
bad.elapsedMs = -1;
expectReject('rejects negative elapsed time', bad, state, expected, 'elapsed');

const terminal = Chess.newGameState(
  'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
expectReject('rejects a terminal source state', good, terminal, expected,
  'source-terminal');
const repetition = Chess.newGameState();
repetition.positions[Chess.positionKey(repetition)] = 3;
expectReject('rejects source state terminal by repetition', good, repetition,
  expected, 'source-terminal');
expectReject('rejects a bare position without full history/repetition state',
  good, Chess.parseFen(Chess.START_FEN), expected, 'source-state');

bad = clone(good);
bad.bestLines[0].move.to = bad.bestLines[0].move.from;
expectReject('rejects an illegal root move object', bad, state, expected,
  'best-line-line-root');
bad = clone(good);
bad.bestLines[0].move.promotion = '';
expectReject('rejects a non-contract empty promotion', bad, state, expected,
  'best-line-line-move');
bad = clone(good);
bad.bestLines[0].uci = 'e2e5';
bad.bestLines[0].pvUci[0] = 'e2e5';
expectReject('rejects an illegal root UCI', bad, state, expected,
  'best-line-line-uci');
bad = clone(good);
bad.bestLines[0].san = 'not-SAN';
bad.bestLines[0].pv[0] = 'not-SAN';
expectReject('rejects non-canonical SAN', bad, state, expected,
  'best-line-line-san');
bad = clone(good);
bad.bestLines[0].pv = [];
bad.bestLines[0].pvUci = [];
expectReject('rejects an empty PV', bad, state, expected,
  'best-line-line-pv-shape');
bad = clone(good);
bad.bestLines[2].pvUci[0] = 'a1a1';
bad.bestLines[2].uci = 'a1a1';
expectReject('validates every best line, not only the first', bad, state,
  expected, 'best-line-line-uci');
bad = clone(good);
bad.bestLines[2] = clone(bad.bestLines[0]);
expectReject('rejects duplicate best root moves', bad, state, expected,
  'best-line-duplicate');
bad = clone(good);
bad.bestLines[1].scoreCpWhite = 40;
bad.bestLines[1].scoreCpPlayer = 40;
expectReject('rejects candidate lines that are not best-first', bad, state,
  expected, 'best-lines-order');

bad = clone(good);
bad.playedLine.rank = 0;
expectReject('requires a positive playedLine rank', bad, state, expected,
  'played-rank');
bad = clone(good);
bad.playedLine.rank = 1.5;
expectReject('requires an integer playedLine rank', bad, state, expected,
  'played-rank');
bad = clone(good);
bad.playedLine.rank = Chess.legalMoves(state).length + 1;
expectReject('played rank cannot exceed the legal root count', bad, state,
  expected, 'played-rank');
bad = clone(good);
bad.playedLine.rank = 1;
expectReject('played rank must agree with its candidate position', bad, state,
  expected, 'played-rank');
bad = clone(good);
bad.playedLine.amongCandidates = false;
expectReject('amongCandidates must agree with rank and membership', bad, state,
  expected, 'played-candidates');
bad = clone(good);
delete bad.playedLine.amongCandidates;
expectReject('played candidate membership must be explicit', bad, state,
  expected, 'played-candidates');
bad = clone(good);
bad.classification = 'same';
expectReject('classification must agree with top/played membership', bad, state,
  expected, 'classification');
const wrongPlayed = clone(expected);
wrongPlayed.playedMove = lines[2].move;
expectReject('playedLine must resolve to the expected played move', good, state,
  wrongPlayed, 'played-move');
bad = clone(good);
bad.playedLine.uci = 'h1h8';
bad.playedLine.pvUci[0] = 'h1h8';
expectReject('validates the played line independently', bad, state, expected,
  'played-line-uci');
bad = clone(good);
bad.playedLine = null;
expectReject('requirePlayed rejects a missing played line', bad, state,
  expected, 'played-required');

bad = clone(good);
bad.bestLines[1].scoreCpWhite = Infinity;
expectReject('rejects a non-finite line score', bad, state, expected,
  'best-line-eval');
bad = clone(good);
bad.bestLines[1].scoreCpPlayer *= -1;
expectReject('rejects a line with inconsistent player POV', bad, state,
  expected, 'best-line-eval');
bad = clone(good);
bad.scoreCpWhite = 999;
bad.scoreCpPlayer = 999;
expectReject('top-level evaluation must match the first best line', bad, state,
  expected, 'top-line-eval');
const hostile = {};
Object.defineProperty(hostile, 'engine', {
  get: function () { throw new Error('hostile record'); }
});
expectReject('malformed accessors cannot escape the trust boundary', hostile,
  state, expected, 'validation-error');

const mateState = Chess.newGameState(
  'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2');
const qh4 = Chess.legalMoves(mateState).find(function (move) {
  return uci(move) === 'd8h4';
});
const mateIdentity = {
  engineId: 'chessy-test',
  version: '5.0.0',
  configHash: 'cfg-mate',
  positionFingerprint: 'fp-mate'
};
const mating = mateLine(mateState, qh4, { forWhite: false, inPlies: 1 });
const mateResult = fixture(mateState, mateIdentity, [mating], 0);
check(Result.validMate(mating.mate) &&
  Result.validate(mateResult, mateState, {
  identity: mateIdentity, requirePlayed: true
}).ok, 'accepts a legal mate evaluation with explicit null cp fields');
bad = clone(mateResult);
bad.bestLines[0].mate.inPlies = 0;
expectReject('rejects an invalid mate distance', bad, mateState, {
  identity: mateIdentity, requirePlayed: true
}, 'best-line-eval');
bad = clone(mateResult);
bad.bestLines[0].scoreCpWhite = 1;
expectReject('rejects mixed mate and centipawn representations', bad,
  mateState, { identity: mateIdentity, requirePlayed: true },
  'best-line-eval');
bad = clone(mateResult);
bad.bestLines[0].pv.push('a6');
bad.bestLines[0].pvUci.push('a7a6');
expectReject('a PV cannot continue after checkmate', bad, mateState, {
  identity: mateIdentity, requirePlayed: true
}, 'best-line-line-past-terminal');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'analysis-result.js'), 'utf8');
const context = vm.createContext({ Chess: Chess });
vm.runInContext(source, context, { filename: 'analysis-result.js' });
check(context.ChessyAnalysisResult &&
  typeof context.ChessyAnalysisResult.validate === 'function',
  'loads as a DOM-independent global in a Node VM');
check(Result === globalThis.ChessyAnalysisResult,
  'CommonJS and globalThis expose the same API');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
