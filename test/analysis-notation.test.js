/*
 * Review score/annotation summary policy — run with:
 *   node test/analysis-notation.test.js
 */
'use strict';

const Selector = require('../assets/moment-selector.js');
const Notation = require('../assets/analysis-notation.js');

let passed = 0, failed = 0;
function check(ok, label) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label); }
}

function result(best, played, opts) {
  opts = opts || {};
  return {
    complete: opts.complete !== false,
    turn: opts.turn || 'w',
    depth: opts.depth || 8,
    engine: {
      id: 'chessy-wasm',
      version: '2.0.0',
      configHash: opts.configHash || 'cfg'
    },
    positionFingerprint: opts.fingerprint || 'position',
    stability: opts.stable === false
      ? { depths: [7, 8], bestMoveStable: false }
      : { depths: [7, 8], bestMoveStable: true },
    bestLines: [{
      san: 'e4',
      scoreCpWhite: best,
      scoreCpPlayer: (opts.turn || 'w') === 'w' ? best : -best,
      mate: null
    }],
    playedLine: {
      san: 'd4',
      scoreCpWhite: played,
      scoreCpPlayer: (opts.turn || 'w') === 'w' ? played : -played,
      mate: null
    }
  };
}

function summary(loss, opts) {
  opts = opts || {};
  return Notation.summarize(result(loss, 0, opts), {
    ply: opts.ply || 0,
    playedSan: opts.playedSan || 'd4',
    turn: opts.turn || 'w',
    profile: opts.profile || 'deep',
    accepted: opts.accepted !== false,
    validated: true
  });
}

check(!!Selector && !!Notation,
  'the pure notation policy loads with the selector evidence dependency');

const quick = summary(500, { profile: 'quick' });
check(quick && Notation.annotation(quick) === null &&
      Notation.publicEntry(quick).estimate === true,
  'a quick score remains an explicitly approximate value with no generated NAG');

[
  [99, null],
  [100, '?!'],
  [199, '?!'],
  [200, '?'],
  [399, '?'],
  [400, '??']
].forEach(function (pair) {
  check(Notation.annotation(summary(pair[0])) === pair[1],
    'deep annotation boundary ' + pair[0] + 'cp → ' + (pair[1] || 'no mark'));
});

check(Notation.annotation(summary(500, { stable: false })) === null,
  'an unstable deep result never receives punctuation');
check(Notation.annotation(summary(500, { accepted: false })) === null,
  'a deep result rejected by the critical-moment policy receives no punctuation');

const clockOnlyResult = result(20, 0);
const clockOnly = Notation.summarize(clockOnlyResult, {
  ply: 0, playedSan: 'd4', turn: 'w', profile: 'deep',
  accepted: true, validated: true, thinkMs: 30000, typicalThinkMs: 1000
});
check(clockOnly && clockOnly.accepted === true &&
      Notation.annotation(clockOnly) === null,
  'a stable clock-only coaching moment is retained without inventing punctuation');

const alreadyLost = Notation.summarize(result(-300, -800), {
  ply: 0, playedSan: 'd4', turn: 'w', profile: 'deep',
  accepted: true, validated: true
});
check(Notation.annotation(alreadyLost) === null,
  'already-lost tail positions suppress negative punctuation');

const black = Notation.summarize(result(-150, 0, { turn: 'b' }), {
  ply: 0, playedSan: 'd4', turn: 'b', profile: 'deep',
  accepted: true, validated: true
});
check(black && black.scoreCpWhite === 0 &&
      black.bestScoreCpWhite === -150 &&
      Notation.annotation(black) === '?!',
  'loss is mover-relative while the persisted row score remains White POV');

const mate = result(null, null);
mate.bestLines[0].mate = { forWhite: true, inPlies: 3 };
mate.playedLine.mate = { forWhite: false, inPlies: 2 };
const mateSummary = Notation.summarize(mate, {
  ply: 0, playedSan: 'd4', turn: 'w', profile: 'deep',
  accepted: true, validated: true
});
check(mateSummary && Notation.annotation(mateSummary) === '??' &&
      Notation.formatWhite(mateSummary) === '−M2',
  'an avoidable forced-mate reversal is a blunder and formats from White POV');

check(Notation.formatWhite({ scoreCpWhite: 34, mate: null }) === '+0.3' &&
      Notation.formatWhite({ scoreCpWhite: -35, mate: null }) === '-0.3',
  'centipawn scores use a stable one-decimal White-POV format');

const expected = {
  ply: 0,
  playedSan: 'd4',
  turn: 'w',
  thinkMs: null,
  typicalThinkMs: null,
  identity: {
    engineId: 'chessy-wasm',
    version: '2.0.0',
    configHash: 'cfg',
    positionFingerprint: 'position'
  }
};
const trusted = summary(150);
check(Notation.validate(trusted, expected),
  'a persisted summary rebinds to its exact replay and analysis identity');
check(!Notation.validate(Object.assign({}, trusted, { playedSan: 'e4' }), expected) &&
      !Notation.validate(Object.assign({}, trusted, { scoreCpWhite: Infinity }), expected) &&
      !Notation.validate(Object.assign({}, trusted, { scoreCpWhite: 999 }), expected) &&
      !Notation.validate(Object.assign({}, trusted, {
        bestScoreCpWhite: Infinity, accepted: true
      }), expected) &&
      !Notation.validate(Object.assign({}, trusted, {
        stability: { depths: [1, 99], bestMoveStable: true }
      }), expected) &&
      !Notation.validate(Object.assign({}, trusted, { configHash: 'foreign' }), expected),
  'SAN, score/utility and provenance corruption fail the reload boundary');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
