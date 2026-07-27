/*
 * Guard and isolation tests for the experimental verified null-move search.
 * Run with: node test/ai-null-move.js
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');

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

function mirrorFen(fen) {
  const p = fen.split(' ');
  function swap(ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  }
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (ch) {
      return /\d/.test(ch) ? ch : swap(ch);
    }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}

function run(fen, depth, alpha, beta, enabled, ctx) {
  const state = Chess.parseFen(fen);
  const before = Chess.toFen(state);
  ctx = ctx || ChessAI.makeCtx(true, Infinity, Infinity, enabled);
  const score = ChessAI.search(
    state, depth, alpha, beta, true, { ctx: ctx });
  check(Chess.toFen(state) === before,
    'search leaves its input state unchanged');
  return { score: score, ctx: ctx };
}

const KID =
  'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1';
const DEFENCE =
  'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27';

console.log('depth, check and material guards');
const below = run(KID, 4, 44, 45, true);
const belowBase = run(KID, 4, 44, 45, false);
check(below.score === belowBase.score && below.ctx.nullProbes === 0,
  'depth below five is exact and never probes',
  JSON.stringify({ on: below.score, off: belowBase.score,
    probes: below.ctx.nullProbes }));

const inCheck =
  '6k1/5ppp/8/8/8/2N5/6PP/r5K1 w - - 0 1';
const checkOn = run(inCheck, 5, -1000, -999, true);
const checkOff = run(inCheck, 5, -1000, -999, false);
check(checkOn.score === checkOff.score && checkOn.ctx.nullProbes === 0,
  'side in check is never null-pruned',
  JSON.stringify({ on: checkOn.score, off: checkOff.score,
    probes: checkOn.ctx.nullProbes }));

for (const fen of [
  '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1',
  '8/8/4k3/4p3/4P3/4K3/8/8 b - - 0 1'
]) {
  const white = fen.split(' ')[1] === 'w';
  const alpha = white ? -200 : 199;
  const beta = white ? -199 : 200;
  const on = run(fen, 6, alpha, beta, true);
  const off = run(fen, 6, alpha, beta, false);
  check(on.score === off.score && on.ctx.nullProbes === 0,
    'pawn-only zugzwang is excluded (' + (white ? 'White' : 'Black') + ')',
    JSON.stringify({ on: on.score, off: off.score,
      probes: on.ctx.nullProbes }));
}

console.log('fifty-move boundary');
const kid80 = KID.replace(' 0 1', ' 80 1');
const kid81 = KID.replace(' 0 1', ' 81 1');
const hm80 = run(kid80, 5, 44, 45, true);
const hm81 = run(kid81, 5, 44, 45, true);
check(hm80.ctx.nullProbes === 1 &&
    hm80.ctx.nullVerifiedCutoffs === 1,
  'last safe synthetic horizon remains eligible',
  JSON.stringify({ probes: hm80.ctx.nullProbes,
    cutoffs: hm80.ctx.nullVerifiedCutoffs }));
check(hm81.ctx.nullProbes === 0,
  'first synthetic horizon that can cross halfmove 100 is excluded',
  JSON.stringify({ probes: hm81.ctx.nullProbes }));

console.log('static-confidence tactical guard');
for (const item of [
  [DEFENCE, -70, -69, 'Black'],
  [mirrorFen(DEFENCE), 69, 70, 'White']
]) {
  const on = run(item[0], 5, item[1], item[2], true);
  const off = run(item[0], 5, item[1], item[2], false);
  check(on.score === off.score && on.ctx.nullProbes === 0,
    'tracked tactical defence stays outside NMP (' + item[3] + ')',
    JSON.stringify({ on: on.score, off: off.score,
      probes: on.ctx.nullProbes }));
}

console.log('verified cutoffs in both score directions');
for (const item of [
  [KID, 44, 45, 'maximizing', true],
  [mirrorFen(KID), -45, -44, 'minimizing', false]
]) {
  const on = run(item[0], 5, item[1], item[2], true);
  const off = run(item[0], 5, item[1], item[2], false);
  const sameBound = item[4]
    ? on.score >= item[2] && off.score >= item[2]
    : on.score <= item[1] && off.score <= item[1];
  check(sameBound &&
      on.ctx.nullProbes === 1 &&
      on.ctx.nullTriggers === 1 &&
      on.ctx.nullVerifiedCutoffs === 1 &&
      on.ctx.nullVerificationRejects === 0,
    'real reduced search verifies the ' + item[3] + ' cutoff',
    JSON.stringify({ on: on.score, off: off.score,
      probes: on.ctx.nullProbes, triggers: on.ctx.nullTriggers,
      cutoffs: on.ctx.nullVerifiedCutoffs,
      rejects: on.ctx.nullVerificationRejects }));
}

console.log('synthetic repetition and TT isolation');
const kidState = Chess.parseFen(KID);
const artificial = Object.assign({}, kidState, {
  turn: 'b', ep: null, halfmove: kidState.halfmove + 1
});
const repCtx = ChessAI.makeCtx(true, Infinity, Infinity, true);
repCtx.gameCounts.set(ChessAI.repKey(artificial), 2);
const repResult = run(KID, 5, 44, 45, true, repCtx);
check(repResult.score === 45 &&
    repResult.ctx.nullProbes === 1 &&
    repResult.ctx.nullVerifiedCutoffs === 1,
  'an artificial-pass repetition cannot turn the null probe into a draw',
  JSON.stringify({ score: repResult.score,
    probes: repResult.ctx.nullProbes,
    cutoffs: repResult.ctx.nullVerifiedCutoffs }));

const warmCtx = ChessAI.makeCtx(true, Infinity, Infinity, true);
run(KID, 5, 44, 45, true, warmCtx);
warmCtx.useNull = false;
const warmExact = run(KID, 4, -Infinity, Infinity, false, warmCtx);
const freshExact = run(KID, 4, -Infinity, Infinity, false);
check(warmExact.score === freshExact.score,
  'NMP scout cannot poison a later exact shared-TT search',
  JSON.stringify({ warm: warmExact.score, fresh: freshExact.score }));

console.log('abort unwinding');
const abortCtx = ChessAI.makeCtx(true, Infinity, 500, true);
let aborted = false;
try {
  ChessAI.search(Chess.parseFen(KID), 5, 44, 45, true, { ctx: abortCtx });
} catch (error) {
  aborted = true;
}
check(aborted && abortCtx.nullProbes === 1 &&
    abortCtx.nullTriggers === 1,
  'finite budget aborts inside mandatory verification',
  JSON.stringify({ aborted: aborted, probes: abortCtx.nullProbes,
    triggers: abortCtx.nullTriggers, nodes: abortCtx.nodes }));
check(abortCtx.inNull === 0 && abortCtx.nmpDisabled === 0 &&
    abortCtx.path1.length === 0 && abortCtx.path2.length === 0,
  'abort restores NMP mode flags and repetition paths',
  JSON.stringify({ inNull: abortCtx.inNull,
    nmpDisabled: abortCtx.nmpDisabled,
    path1: abortCtx.path1.length, path2: abortCtx.path2.length }));

console.log('analysis opt-out');
const originalThink = ChessAI.think;
const originalMakeCtx = ChessAI.makeCtx;
let scanNullMove = null;
const analysisContexts = [];
ChessAI.think = function (state, opts) {
  scanNullMove = opts && opts.nullMove;
  return originalThink(state, opts);
};
ChessAI.makeCtx = function (quiesce, deadline, nodeLimit, useNull) {
  const ctx = originalMakeCtx(quiesce, deadline, nodeLimit, useNull);
  analysisContexts.push(ctx.useNull);
  return ctx;
};
require('../assets/analysis-core.js');
ChessyAnalysisCore.analyse(Chess.parseFen(KID), {
  maxDepth: 2, nodeLimit: 2000, nodeBudget: 30000,
  multiPV: 1, pvLen: 2, quiesce: true
});
ChessAI.think = originalThink;
ChessAI.makeCtx = originalMakeCtx;
check(scanNullMove === false,
  'analysis scan explicitly disables NMP',
  JSON.stringify({ nullMove: scanNullMove }));
check(analysisContexts.length === 2 &&
    analysisContexts.every(function (enabled) { return enabled === false; }),
  'analysis deep and shallow contexts explicitly disable NMP',
  JSON.stringify(analysisContexts));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
