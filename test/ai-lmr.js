/*
 * Guarded Play-only late-move-reduction tests.
 * Run with: node test/ai-lmr.js
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
require('../assets/analysis-core.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail == null ? '' : ' — ' + detail));
  }
}
function find(state, predicate, label) {
  const move = Chess.legalMoves(state).find(predicate);
  if (!move) throw new Error('fixture has no ' + label + ': ' + Chess.toFen(state));
  return move;
}
function givesCheck(state, move) {
  const next = Chess.applyMove(state, move);
  const enemy = state.turn === 'w' ? 'b' : 'w';
  return Chess.isAttacked(
    next.board, next.board.indexOf(enemy + 'K'), state.turn);
}
function mirrorFen(fen) {
  const parts = fen.split(' ');
  function swap(ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  }
  parts[0] = parts[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (ch) {
      return /\d/.test(ch) ? ch : swap(ch);
    }).join('');
  }).join('/');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  if (parts[2] !== '-') parts[2] = parts[2].split('').map(swap).sort().join('');
  if (parts[3] !== '-') parts[3] = parts[3][0] + (9 - Number(parts[3][1]));
  return parts.join(' ');
}

const MID_FEN =
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1';
const mid = Chess.parseFen(MID_FEN);
const quiet = find(mid, function (m) {
  return !m.captured && !m.promotion && !m.castle &&
    m.piece[1] !== 'P' && !givesCheck(mid, m);
}, 'ordinary quiet move');
const capture = find(mid, function (m) { return !!m.captured; }, 'capture');
const castle = find(mid, function (m) { return !!m.castle; }, 'castle');

function reduces(state, move, overrides) {
  const o = overrides || {};
  const ctx = o.ctx || ChessAI.makeCtx(true, Infinity, null, true);
  return ChessAI.lmrReduces(
    state, Chess.applyMove(state, move), move,
    o.depth == null ? 5 : o.depth,
    o.quietCount == null ? 4 : o.quietCount,
    !!o.inCheck,
    o.ttPk == null ? 0 : o.ttPk,
    o.ply == null ? 0 : o.ply,
    o.nullNode == null ? true : o.nullNode,
    o.alpha == null ? 100 : o.alpha,
    o.beta == null ? 101 : o.beta,
    ctx);
}

console.log('guard predicate');
check(reduces(mid, quiet), 'fifth quiet at depth 5 in an entry null window is reduced');
check(!reduces(mid, quiet, { depth: 4 }), 'depth 4 is excluded');
check(!reduces(mid, quiet, { quietCount: 3 }), 'fourth quiet is excluded');
check(!reduces(mid, quiet, { nullNode: false }),
  'entry-wide/PV node is excluded even if its live window later narrows');
check(!reduces(mid, quiet, {
  ctx: ChessAI.makeCtx(true, Infinity, null, false)
}), 'LMR-disabled context is excluded');
check(!reduces(mid, quiet, {
  ctx: ChessAI.makeCtx(false, Infinity, null, true)
}), 'quiescence-off Expert context is excluded');
check(!reduces(mid, quiet, { inCheck: true }), 'check evasions are excluded');
check(!reduces(mid, capture), 'captures are excluded');
check(!reduces(mid, castle), 'castling is excluded');
check(!reduces(mid, quiet, { alpha: ChessAI.MATE_NEAR, beta: ChessAI.MATE_NEAR + 1 }),
  'mate-score windows are excluded');

const promoState = Chess.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
const promotion = find(
  promoState, function (m) { return m.promotion === 'Q'; }, 'promotion');
check(!reduces(promoState, promotion), 'promotions are excluded');

const rookState = Chess.parseFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
const checking = find(rookState, function (m) {
  return !m.captured && givesCheck(rookState, m);
}, 'quiet checking move');
check(!reduces(rookState, checking), 'quiet checks are excluded');

check(!reduces(mid, quiet, { ttPk: ChessAI.packMove(quiet) }),
  'TT move is excluded');
const killerCtx = ChessAI.makeCtx(true, Infinity, null, true);
killerCtx.killers[0] = [ChessAI.packMove(quiet), 0];
check(!reduces(mid, quiet, { ctx: killerCtx }), 'killer move is excluded');
const historyCtx = ChessAI.makeCtx(true, Infinity, null, true);
historyCtx.histW[quiet.from * 64 + quiet.to] = 1;
check(!reduces(mid, quiet, { ctx: historyCtx }), 'positive-history move is excluded');

const pawnState = Chess.parseFen('7k/8/4P3/8/8/8/8/K7 w - - 0 1');
const advancedPawn = find(pawnState, function (m) {
  return m.piece === 'wP' && Chess.sqName(m.to) === 'e7';
}, 'advanced pawn push');
check(!reduces(pawnState, advancedPawn), 'advanced pawn push is excluded');

const fiftyState = Chess.parseFen(MID_FEN.replace(' 0 1', ' 80 1'));
const fiftyQuiet = find(fiftyState, function (m) {
  return !m.captured && !m.promotion && !m.castle &&
    m.piece[1] !== 'P' && !givesCheck(fiftyState, m);
}, 'near-fifty quiet move');
check(!reduces(fiftyState, fiftyQuiet), '50-move-boundary horizon is excluded');

console.log('search integration');
for (const [label, fen, alpha, beta] of [
  ['maximizing', MID_FEN, 100, 101],
  ['minimizing', mirrorFen(MID_FEN), -101, -100]
]) {
  const state = Chess.parseFen(fen);
  const ctx = ChessAI.makeCtx(true, Infinity, null, true);
  ChessAI.search(state, 5, alpha, beta, true, { ctx: ctx });
  check(ctx.lmrApplied > 0, label + ' null-window search applies reductions',
    'applied=' + ctx.lmrApplied);
  check(ctx.lmrResearched <= ctx.lmrApplied,
    label + ' verifications never exceed reductions',
    ctx.lmrResearched + '/' + ctx.lmrApplied);
}

const inactive = ChessAI.think(mid, {
  maxDepth: 5, quiesce: true, randomize: false
});
check(inactive.lmrApplied === 0 && inactive.lmrResearched === 0,
  'completed root depth 5 is exactly below the active boundary');
const disabled = ChessAI.think(mid, {
  maxDepth: 6, quiesce: true, randomize: false, lmr: false
});
check(disabled.lmrApplied === 0 && disabled.lmrResearched === 0,
  'explicitly disabled Play search applies no reductions');

console.log('analysis isolation');
const realThink = ChessAI.think;
const realMakeCtx = ChessAI.makeCtx;
let scanOptOut = false;
const analysisCtxFlags = [];
ChessAI.think = function (state, opts) {
  scanOptOut = opts.lmr === false;
  return realThink(state, opts);
};
ChessAI.makeCtx = function (quiesce, deadline, nodeLimit, useLmr) {
  analysisCtxFlags.push(useLmr);
  return realMakeCtx(quiesce, deadline, nodeLimit, useLmr);
};
try {
  globalThis.ChessyAnalysisCore.analyse(mid, {
    maxDepth: 1, nodeLimit: 200, nodeBudget: 1000, multiPV: 1, pvLen: 1
  });
} finally {
  ChessAI.think = realThink;
  ChessAI.makeCtx = realMakeCtx;
}
check(scanOptOut, 'analysis scan explicitly opts out of LMR');
check(analysisCtxFlags.length === 2 &&
    analysisCtxFlags.every(function (flag) { return flag === false; }),
  'analysis deep/shallow contexts explicitly opt out of LMR',
  JSON.stringify(analysisCtxFlags));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
