/*
 * Pure Phase-5 critical-moment selection — run with:
 *   node test/moment-selector.test.js
 *
 * No engine or browser is involved. Fixtures model already-validated analysis
 * contracts so utility, thresholds, clock evidence, causal clustering and deep
 * admission stay byte-deterministic and cheap to gate in CI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Selector = require('../assets/moment-selector.js');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(actual, expected, label) {
  check(actual === expected, label, 'expected ' + expected + ', got ' + actual);
}

function cp(score, san) {
  return {
    san: san || 'Nf3',
    scoreCpPlayer: score,
    scoreCpWhite: score,
    mate: null
  };
}
function whiteCp(score, san) {
  return { san: san || 'Nf3', scoreCpWhite: score, mate: null };
}
function mate(forWhite, san, inPlies) {
  return {
    san: san || 'Qh7#',
    scoreCpPlayer: null,
    scoreCpWhite: null,
    mate: { forWhite: forWhite, inPlies: inPlies || 1 }
  };
}
function result(best, played, opts) {
  opts = opts || {};
  return {
    turn: opts.turn || 'w',
    complete: opts.complete !== false,
    bestLines: best ? [best] : [],
    playedLine: played || null,
    stability: opts.noStability ? null : {
      depths: [7, 8],
      bestMoveStable: opts.stable !== false
    }
  };
}
function meta(ply, san, extra) {
  return Object.assign({
    ply: ply,
    playedSan: san,
    turn: 'w',
    validated: true
  }, extra || {});
}
function quick(ply, best, played, extraMeta, opts) {
  const san = (played && played.san) || 'h3';
  return Selector.quickCandidate(
    result(best, played, opts),
    meta(ply, san, extraMeta));
}

// ---- Browser-IIFE / Node export -----------------------------------------
const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'moment-selector.js'), 'utf8');
const browserContext = {};
vm.runInNewContext(source, browserContext, { filename: 'moment-selector.js' });
check(!!browserContext.ChessyMomentSelector &&
  typeof browserContext.ChessyMomentSelector.quickCandidate === 'function',
  'the dependency-free IIFE exports ChessyMomentSelector in a browser-like VM');
check(Selector === globalThis.ChessyMomentSelector &&
  typeof Selector.shortlist === 'function' &&
  typeof Selector.acceptDeep === 'function',
  'CommonJS and global exports expose the same selector API');

// ---- Bounded mover-POV utility ------------------------------------------
eq(Selector.utility(cp(2500), 'w'), 2000, 'centipawn utility clamps at +2000');
eq(Selector.utility(cp(-2501), 'w'), -2000, 'centipawn utility clamps at -2000');
eq(Selector.utility(mate(true), 'w'), 4000, 'White mate is +4000 for White to move');
eq(Selector.utility(mate(true), 'b'), -4000, 'White mate is -4000 for Black to move');
eq(Selector.utility(mate(false), 'b'), 4000, 'Black mate is +4000 for Black to move');
eq(Selector.utility(whiteCp(175), 'w'), 175,
  'white-POV fallback remains positive for White');
eq(Selector.utility(whiteCp(175), 'b'), -175,
  'white-POV fallback mirrors for Black');
eq(Selector.utility({ san: 'x', mate: { forWhite: true }, scoreCpPlayer: 42 }, 'w'), 42,
  'a malformed mate payload falls back to finite CP');
eq(Selector.utility({}, 'w'), null, 'a line without a usable evaluation is rejected');

eq(Selector.regret(300, 220), 80, 'regret is best minus played');
eq(Selector.regret(100, 120), 0, 'regret never becomes negative');
eq(Selector.regret(null, 0), null, 'regret rejects missing utility');
eq(Selector.regret(4000, 4000), 0,
  'two same-winner mating lines have no fake mate-distance regret');
eq(Selector.regret(4000, -4000), 8000,
  'switching from forced mate for to forced mate against is decisive');

// ---- Quick boundary and validation gates --------------------------------
eq(quick(2, cp(100), cp(21, 'h3')), null,
  '79 cp is below the quick nomination boundary');
const at80 = quick(2, cp(100), cp(20, 'h3'));
check(at80 && at80.loss === 80,
  '80 cp is included at the exact quick nomination boundary');
const blackMover = Selector.quickCandidate(
  result(whiteCp(-100, 'Nf6'), whiteCp(100, 'h6'), { turn: 'b' }),
  meta(3, 'h6', { turn: 'b' }));
check(blackMover && blackMover.bestUtility === 100 &&
  blackMover.playedUtility === -100 && blackMover.loss === 200,
  'quick regret uses mover POV for Black, not raw white-POV score');
eq(Selector.quickCandidate(
  result(cp(100), cp(0, 'h3')),
  meta(2, 'h3', { validated: false })), null,
  'complete quick analysis without explicit validation is rejected');
eq(Selector.quickCandidate(
  result(cp(100), cp(0, 'h3'), { complete: false }),
  meta(2, 'h3')), null,
  'validated but incomplete quick analysis is rejected');
eq(Selector.quickCandidate(
  result(cp(100), null),
  meta(2, 'h3')), null,
  'a complete result without a played line is rejected');
eq(Selector.quickCandidate(
  result(cp(100), cp(0, 'h3')),
  meta(-1, 'h3')), null,
  'an invalid ply cannot become a candidate');
eq(Selector.quickCandidate(
  result(cp(100), cp(0, 'h3')),
  meta(2, '')), null,
  'a missing played SAN cannot become a candidate');

// ---- Deterministic classifications and teaching score -------------------
const defensive = quick(4, cp(-100, 'Kd2'), cp(-250, 'Kf1'));
check(defensive && defensive.defensive && !defensive.conversion,
  'defensive boundary includes best -100 / played -250');
const notDefensive = quick(4, cp(-101, 'Kd2'), cp(-251, 'Kf1'));
check(notDefensive && !notDefensive.defensive,
  'best -101 is outside the defensive-save boundary');

const conversion = quick(6, cp(300, 'Re1'), cp(149, 'h3'));
check(conversion && conversion.conversion,
  'conversion boundary includes best +300 / played below +150');
const notConversion = quick(6, cp(300, 'Re1'), cp(150, 'h3'));
check(notConversion && !notConversion.conversion,
  'played +150 is outside the failed-conversion boundary');

const collapse = quick(8, cp(-299, 'Kf2'), cp(-400, 'Kh1'));
check(collapse && collapse.collapse && !collapse.alreadyLost,
  'crossing from above -300 to -300 or worse marks collapse onset');
const alreadyLost = quick(10, cp(-300, 'Kf2'), cp(-500, 'Kh1'));
check(alreadyLost && !alreadyLost.collapse && alreadyLost.alreadyLost,
  'best play already at -300 marks a downstream lost position');

const quiet = quick(12, cp(200, 'Nf3'), cp(100, 'h3'));
check(quiet && quiet.quiet,
  'candidate is quiet only when best and played SAN are both quiet');
const tactical = quick(12, cp(200, 'Bxh7+'), cp(100, 'h3'));
check(tactical && !tactical.quiet,
  'capture/check syntax prevents a tactical line being called quiet');

eq(at80.score, 155,
  '80 cp quiet candidate receives the exact +75 quiet teaching weight');
check(defensive.score > defensive.loss && conversion.score > conversion.loss &&
  collapse.score > collapse.loss,
  'defense, conversion and collapse each add deterministic teaching weight');

// ---- Exact thinkMs anomalies --------------------------------------------
let clock = Selector.clockFlags({ thinkMs: 3000, typicalThinkMs: 10000 }, 80);
check(clock.impulse && !clock.overthink && clock.anomaly,
  'impulse includes the exact min(3s, typical/3) boundary');
clock = Selector.clockFlags({ thinkMs: 3000.001, typicalThinkMs: 10000 }, 80);
check(!clock.impulse, 'impulse excludes a think just above 3 seconds');
clock = Selector.clockFlags({ thinkMs: 2000, typicalThinkMs: 6000 }, 79);
check(!clock.impulse, 'fast play without quick regret is not an impulse candidate');
clock = Selector.clockFlags({ thinkMs: 30000, typicalThinkMs: 10000 }, 0);
check(clock.overthink && clock.anomaly,
  'overthink includes the exact max(30s, 3x typical) boundary');
clock = Selector.clockFlags({ thinkMs: 29999, typicalThinkMs: 10000 }, 0);
check(!clock.overthink, 'overthink excludes one millisecond below 30 seconds');
clock = Selector.clockFlags({ thinkMs: 60000, typicalThinkMs: 20000 }, 0);
check(clock.overthink, 'three times a slower typical think sets the overthink boundary');
clock = Selector.clockFlags({ thinkMs: 59999, typicalThinkMs: 20000 }, 0);
check(!clock.overthink, 'three-times-typical boundary is exact');
clock = Selector.clockFlags({ thinkMs: 60000 }, 0);
check(!clock.anomaly, 'missing typical think time produces no clock claim');

const impulse = quick(14, cp(100, 'Nf3'), cp(20, 'h3'),
  { thinkMs: 1000, typicalThinkMs: 9000 });
check(impulse && impulse.impulse && impulse.clockAnomaly,
  'quick regret plus exact short think marks impulse');
const overthink = quick(16, cp(20, 'Nf3'), cp(20, 'h3'),
  { thinkMs: 45000, typicalThinkMs: 10000 });
check(overthink && overthink.loss === 0 && overthink.overthink &&
  overthink.score === 325,
  'a sound but abnormal overthink nominates with its exact base/bonus/quiet score');

// ---- Final-collapse suppression and deterministic clustering ------------
function internal(ply, score, bestUtility, playedUtility, flags) {
  return Object.assign({
    algorithm: Selector.constants.algorithm,
    ply: ply,
    playedSan: 'm' + ply,
    turn: 'w',
    bestUtility: bestUtility,
    playedUtility: playedUtility,
    loss: Math.max(0, bestUtility - playedUtility),
    defensive: false,
    conversion: false,
    collapse: false,
    quiet: false,
    impulse: false,
    overthink: false,
    clockAnomaly: false,
    alreadyLost: bestUtility <= Selector.constants.lost,
    score: score
  }, flags || {});
}

const collapseSequence = [
  internal(4, 500, 0, -400, { collapse: true }),
  internal(8, 900, -250, -900),
  internal(12, 300, -150, -300)
];
const collapseChosen = Selector.shortlist(collapseSequence, 2);
check(collapseChosen.length === 2 &&
  collapseChosen[0].ply === 4 && collapseChosen[1].ply === 12,
  'later final-collapse symptom is suppressed until best play recovers above -200');
const hopelessOnly = Selector.shortlist([
  internal(30, 1000, -300, -1000),
  internal(34, 1200, -500, -2000)
], 2);
eq(hopelessOnly.length, 0,
  'ordinary candidates whose before-position is already lost are suppressed');
const lateRecovery = Selector.shortlist([
  internal(20, 1000, -500, -1000, { turn: 'w' }),
  internal(26, 900, -250, -800, { turn: 'w' }),
  internal(32, 300, -150, -300, { turn: 'w' })
], 2);
check(lateRecovery.length === 1 && lateRecovery[0].ply === 32,
  'an already-lost episode stays suppressed until meaningful recovery');
const twoSides = Selector.shortlist([
  internal(0, 500, 0, -400, { turn: 'w', collapse: true }),
  internal(1, 100, 100, 0, { turn: 'b' }),
  internal(4, 900, -250, -900, { turn: 'w' }),
  internal(6, 300, -150, -300, { turn: 'w' })
], 2);
check(twoSides.every(function (c) { return c.ply !== 4; }),
  'the other side cannot clear a player’s collapse-tail suppression');
const alternating = Selector.shortlist([
  internal(0, 200, 100, 0, { turn: 'w' }),
  internal(1, 200, 100, 0, { turn: 'b' })
], 2);
check(alternating.length === 2,
  'opposite-side decisions form independent teaching clusters');

const ratioBoundary = Selector.shortlist([
  internal(0, 120, 100, 0),
  internal(5, 200, 100, 0),
  internal(6, 180, 100, 0)
], 2);
check(ratioBoundary.length === 2 &&
  ratioBoundary[0].ply === 0 && ratioBoundary[1].ply === 6,
  'within <6 plies the earliest candidate at exactly 60% of max represents the cluster');
const ratioBelow = Selector.shortlist([
  internal(0, 119.999, 100, 0),
  internal(5, 200, 100, 0)
], 2);
check(ratioBelow.length === 1 && ratioBelow[0].ply === 5,
  'earliest candidate below 60% yields to the later meaningful candidate');

const ranked = [
  internal(2, 200, 100, 0),
  internal(10, 900, 100, 0),
  internal(18, 500, 100, 0)
];
const rankedCopy = JSON.stringify(ranked);
const topTwo = Selector.shortlist(ranked, 99);
check(topTwo.length === 2 && topTwo[0].ply === 10 && topTwo[1].ply === 18,
  'shortlist caps at two highest-scoring episodes and returns them chronologically');
eq(JSON.stringify(ranked), rankedCopy, 'shortlist does not mutate its candidate input');
eq(JSON.stringify(Selector.shortlist(ranked, 2)), JSON.stringify(topTwo),
  'shortlisting the same inputs is byte-deterministic');
const tied = Selector.shortlist([
  internal(2, 500, 100, 0),
  internal(10, 500, 100, 0),
  internal(18, 400, 100, 0)
], 1);
check(tied.length === 1 && tied[0].ply === 2,
  'score ties select the earlier independent episode');
eq(Selector.shortlist(ranked, 0).length, 0, 'limit zero produces no shortlist');

// ---- Deep completeness, validation, stability and persistence -----------
const q = quick(20, cp(200, 'Nf3'), cp(100, 'h3')); // quick loss 100
const qMeta = meta(20, 'h3');
function deep(best, played, opts, extraMeta) {
  return Selector.acceptDeep(q, result(best, played, opts),
    Object.assign({}, qMeta, extraMeta || {}));
}

eq(deep(cp(250), cp(150, 'h3'), { complete: false }), null,
  'deep completeness is mandatory');
eq(Selector.acceptDeep(q, result(cp(250), cp(150, 'h3')),
  Object.assign({}, qMeta, { validated: false })), null,
  'deep explicit validation is mandatory even when complete');
eq(deep(cp(250), cp(150, 'h3'), { stable: false }), null,
  'deep best-move stability false rejects the proposal');
eq(deep(cp(250), cp(150, 'h3'), { noStability: true }), null,
  'missing deep stability rejects the proposal');
eq(deep(cp(250), cp(151, 'h3')), null,
  'deep regret of 99 does not persist at the 100 cp boundary');
const accepted = deep(cp(250), cp(150, 'h3'));
check(accepted && JSON.stringify(accepted) === '{"ply":20,"playedSan":"h3"}' &&
  Object.keys(accepted).sort().join(',') === 'playedSan,ply',
  'stable deep regret of exactly 100 returns only the spoiler-free public proposal');
eq(deep(cp(250), cp(150, 'h3'), {}, { ply: 22 }), null,
  'deep evidence for a different ply cannot verify the quick candidate');
eq(deep(cp(250), cp(150, 'h4'), {}, { playedSan: 'h4' }), null,
  'deep evidence for a different played move cannot verify the quick candidate');
eq(deep(cp(250), cp(150, 'h3'), {}, { turn: 'b' }), null,
  'deep evidence from the wrong mover cannot verify the quick candidate');
eq(deep(cp(500), cp(450, 'h3')), null,
  'complete and stable alone do not admit a proposal when regret fades');

const qOver = quick(22, cp(20, 'Nf3'), cp(20, 'h3'),
  { thinkMs: 45000, typicalThinkMs: 10000 });
function deepOver(loss, clockMeta) {
  return Selector.acceptDeep(qOver,
    result(cp(100), cp(100 - loss, 'h3')),
    Object.assign(meta(22, 'h3'), clockMeta));
}
check(!!deepOver(75, { thinkMs: 45000, typicalThinkMs: 10000 }),
  'stable exact overthink persists alongside a 75 cp deep estimate');
check(!!deepOver(76, { thinkMs: 45000, typicalThinkMs: 10000 }),
  'persistent exact clock anomaly is independent of a separate CP cap');
eq(deepOver(0, { thinkMs: 29999, typicalThinkMs: 10000 }), null,
  'a quick clock anomaly that does not persist exactly is rejected');
check(!!deepOver(100, { thinkMs: 45000, typicalThinkMs: 10000 }),
  'persistent 100 cp engine regret admits even when the quick candidate also overthought');

const qImpulse = quick(24, cp(100, 'Nf3'), cp(20, 'h3'),
  { thinkMs: 1000, typicalThinkMs: 9000 });
eq(Selector.acceptDeep(qImpulse, result(cp(100), cp(21, 'h3')),
  meta(24, 'h3', { thinkMs: 1000, typicalThinkMs: 9000 })), null,
  'deep impulse below its exact 80 cp anomaly boundary is rejected');
check(!!Selector.acceptDeep(qImpulse, result(cp(100), cp(1, 'h3')),
  meta(24, 'h3', { thinkMs: 1000, typicalThinkMs: 9000 })),
  'persistent exact impulse evidence can admit below the deep-regret boundary');
check(!!Selector.acceptDeep(qImpulse, result(cp(120), cp(20, 'h3')),
  meta(24, 'h3', { thinkMs: 1000, typicalThinkMs: 9000 })),
  'impulse candidate is admitted when its deep regret persists');

eq(Selector.acceptDeep(alreadyLost, result(cp(-250), cp(-500, 'Kh1')),
  meta(10, 'Kh1')), null,
  'an already-lost quick candidate cannot bypass tail suppression at deep admission');
eq(Selector.acceptDeep(q, result({}, cp(0, 'h3')), qMeta), null,
  'malformed deep evaluation cannot be accepted despite complete/stable flags');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
