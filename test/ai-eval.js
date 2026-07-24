/*
 * Feature-sensitive king-safety evaluation tests.
 *
 * The optional evaluate(board, out) argument is a test-only trace seam. It
 * writes flat defending-king fields without allocating anything when omitted:
 * phase; w/bRingWeight; w/bRingCount; w/bRingPenalty; w/bShelter.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function equal(actual, expected, label) {
  check(actual === expected, label, 'got ' + actual + ', expected ' + expected);
}
function inspect(fen) {
  const out = {};
  out.score = ChessAI.evaluate(Chess.parseFen(fen).board, out);
  return out;
}
function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (ch) {
      return /\d/.test(ch) ? ch : swap(ch);
    }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[2] = '-'; p[3] = '-'; p[4] = '0'; p[5] = '1';
  return p.join(' ');
}

console.log('test seams');
const hooks = ChessAI._test || {};
check(typeof hooks.kingAttackPenalty === 'function',
  'kingAttackPenalty test seam is available');
check(typeof hooks.shelterFilePenalty === 'function',
  'shelterFilePenalty test seam is available');
if (failed) {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}

// Exact curve boundaries. A lone attacker is ordinary activity; coordination
// activates the linear pressure, and the result is bounded at 150 cp.
console.log('king-ring curve');
const penalty = hooks.kingAttackPenalty;
equal(penalty(12, 0), 0, 'zero attackers score zero');
equal(penalty(12, 1), 0, 'one attacker scores zero');
equal(penalty(12, 2), 36, 'two attackers activate king danger');
equal(penalty(12, 3), 54, 'three attackers use the count multiplier');
equal(penalty(3, 3), 14, 'fractional positive pressure rounds exactly');
equal(penalty(60, 4), 150, 'king-ring pressure is capped');

// Natural full-phase boards pin the accumulation walk as well as the pure
// curve. They differ only in how many White pieces reach Black's king ring.
console.log('king-ring board accumulation');
const RING_CASES = [
  ['zero',  'rnbqrbnk/pppppppp/8/Q7/8/8/PPPPPPPP/RNB1KBNR w - - 0 1', 0, 0, 0],
  ['one',   'rnbqrbnk/pppppppp/8/7Q/8/8/PPPPPPPP/RNB1KBNR w - - 0 1', 1, 5, 0],
  ['two',   'rnbqrbnk/pppppppp/8/7Q/8/3B4/PPPPPPPP/RNB1K1NR w - - 0 1', 2, 7, 21],
  ['three', 'rnbqrbnk/pppppppp/5N2/7Q/8/3B4/PPPPPPPP/RNB1K2R w - - 0 1', 3, 11, 50],
  ['cap',   '2rq3k/Q5pp/4B3/4Q1QQ/8/3Q4/PP6/K7 w - - 0 1', 6, 27, 150]
];
for (const [name, fen, count, weight, applied] of RING_CASES) {
  const t = inspect(fen);
  equal(t.phase, 24, name + ': full middlegame phase');
  equal(t.bRingCount, count, name + ': distinct attackers accumulated');
  equal(t.bRingWeight, weight, name + ': attacked-ring weight accumulated');
  equal(t.bRingPenalty, applied, name + ': exact penalty applied');
}

// The boards in each pair deliberately had equal scores before king safety.
// These differences therefore isolate application of the traced ring penalty;
// setting the term to zero makes the 21/29 assertions fail.
console.log('king-ring integration');
const ZERO_MATCH = 'rnb1rbnk/pppppppp/Rq6/Q7/8/8/PPPPPPPP/RNB1KBN1 w - - 0 1';
const ONE_MATCH  = 'rnb1rbnk/pppppppp/8/2R4Q/8/5q2/PPPPPPPP/RNB1KBN1 w - - 0 1';
equal(inspect(ONE_MATCH).score - inspect(ZERO_MATCH).score, 0,
  'zero and one attacker have the same contribution');

const ONE_FOR_TWO = 'rnb1rbnk/pppppppp/R1q5/7Q/8/8/PPPPPPPP/RNB1KBN1 w - - 0 1';
const TWO_MATCH    = 'rnb1rbnk/pppppppp/8/1R5Q/8/3Bq3/PPPPPPPP/RNB1K1N1 w - - 0 1';
equal(inspect(TWO_MATCH).score - inspect(ONE_FOR_TWO).score, 21,
  'second attacker contributes the exact board penalty');

const TWO_FOR_THREE = 'rnb1rbnk/pppppppp/q1R5/7Q/8/3B4/PPPPPPPP/RNB1K1N1 w - - 0 1';
const THREE_MATCH    = 'rnb1rbnk/pppppppp/5N2/7Q/8/R2B1q2/PPPPPPPP/RNB1K3 w - - 0 1';
equal(inspect(THREE_MATCH).score - inspect(TWO_FOR_THREE).score, 29,
  'third attacker raises 21 cp pressure to 50 cp');
equal(inspect(RING_CASES[4][1]).score, 4142,
  'capped ring penalty is included in the final evaluation');

console.log('open-file shelter and blocker semantics');
const CLOSED = '2qqq1k1/5ppp/R7/8/8/8/PP6/K1QQQ3 w - - 0 1';
const OPEN   = '2qqq1k1/5p1p/3R4/8/8/8/PPp5/K1QQQ3 w - - 0 1';
const closed = inspect(CLOSED), open = inspect(OPEN);
equal(closed.bShelter, 0, 'friendly pawn closes the king-adjacent file');
equal(open.bShelter, 10, 'missing friendly pawn incurs open-file shelter');
equal(open.score - closed.score, 10, 'open-file shelter reaches final evaluation');

// Black Kg8, open f-file. Rf3 has a clear ray to f8; Nf6 and ...Bf6
// separately prove that either attacker's or defender's piece blocks it.
const CLEAR      = '2qqq1k1/6pp/8/8/8/5R2/PP6/K1QQQ3 w - - 0 1';
const OFF_FILE   = '2qqq1k1/6pp/8/8/8/1R6/PP6/K1QQQ3 w - - 0 1';
const OWN_BLOCK  = '2qqq1k1/6pp/5N2/8/8/5R2/PP6/K1QQQ3 w - - 0 1';
const OWN_OFF    = '2qqq1k1/6pp/5N2/8/8/1R6/PP6/K1QQQ3 w - - 0 1';
const ENEMY_BLOCK= '2qqq1k1/6pp/5b2/8/8/5R2/PP6/K1QQQ3 w - - 0 1';
const ENEMY_OFF  = '2qqq1k1/6pp/5b2/8/8/1R6/PP6/K1QQQ3 w - - 0 1';
const DEEP_PAWN  = '2qqq1k1/5Rpp/8/8/8/8/5p2/K1QQQ3 w - - 0 1';
function filePenalty(fen) {
  const board = Chess.parseFen(fen).board;
  return hooks.shelterFilePenalty(board, Chess.sqIndex('g8'), 5, 'b');
}
const heavy = filePenalty(CLEAR) - 10;
check(heavy > 0, 'clear enemy heavy-piece ray adds shelter danger', 'bonus ' + heavy);
equal(filePenalty(OWN_BLOCK), 10, 'attacker-side blocker stops the heavy-piece ray');
equal(filePenalty(ENEMY_BLOCK), 10, 'defender-side blocker stops the heavy-piece ray');
equal(filePenalty(DEEP_PAWN), 22, 'enemy rook before a distant pawn keeps the ray open');
equal(inspect(DEEP_PAWN).bShelter, 22, 'distant pawn cannot suppress the shelter penalty');

const clear = inspect(CLEAR), off = inspect(OFF_FILE);
equal(clear.bShelter, 10 + heavy, 'clear heavy ray is included in shelter');
equal(off.bShelter, 10, 'off-file rook adds no heavy-ray shelter');
equal(clear.score - off.score, 28 + heavy,
  'clear heavy-ray bonus reaches final evaluation');
equal(inspect(OWN_BLOCK).bShelter, 10, 'attacker blocker leaves only open-file shelter');
equal(inspect(OWN_BLOCK).score - inspect(OWN_OFF).score, 22,
  'attacker blocker prevents the heavy-ray bonus in final evaluation');
equal(inspect(ENEMY_BLOCK).bShelter, 10, 'defender blocker leaves only open-file shelter');
equal(inspect(ENEMY_BLOCK).score - inspect(ENEMY_OFF).score, 24,
  'defender blocker prevents the heavy-ray bonus in final evaluation');

// Raw shelter still exists in a pawn ending, but phase zero must taper it
// entirely out of the returned score.
const PHASE_ZERO = '6k1/5p1p/8/8/8/8/PP6/K7 w - - 0 1';
const endgame = inspect(PHASE_ZERO);
equal(endgame.phase, 0, 'pawn ending has phase zero');
equal(endgame.bShelter, 10, 'phase-zero fixture contains raw shelter danger');
equal(endgame.score, 23, 'raw shelter is fully tapered out at phase zero');

console.log('exact colour symmetry and rounding');
const ROUND = '7k/8/8/8/8/1b6/8/K7 w - - 0 1';
equal(inspect(ROUND).score, -380, 'negative half rounds away from zero');
equal(inspect(mirrorFen(ROUND)).score, 380, 'positive mirror rounds away from zero');

for (const fen of [RING_CASES[2][1], RING_CASES[4][1], CLEAR, PHASE_ZERO]) {
  const a = inspect(fen), b = inspect(mirrorFen(fen));
  equal(a.score, -b.score, 'final score negates under colour mirror: ' + fen.slice(0, 18));
  equal(a.wRingCount, b.bRingCount, 'White/Black ring counts swap under mirror');
  equal(a.bRingCount, b.wRingCount, 'Black/White ring counts swap under mirror');
  equal(a.wRingWeight, b.bRingWeight, 'White/Black ring weights swap under mirror');
  equal(a.bRingWeight, b.wRingWeight, 'Black/White ring weights swap under mirror');
  equal(a.wRingPenalty, b.bRingPenalty, 'White/Black ring penalties swap under mirror');
  equal(a.bRingPenalty, b.wRingPenalty, 'Black/White ring penalties swap under mirror');
  equal(a.wShelter, b.bShelter, 'White/Black shelter swaps under mirror');
  equal(a.bShelter, b.wShelter, 'Black/White shelter swaps under mirror');
}
equal(inspect(Chess.START_FEN).score, 0, 'start position evaluates to exactly zero');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
