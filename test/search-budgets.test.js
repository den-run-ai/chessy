/* Search-policy regressions. No Elo is inferred from budgets or mock scores. */
'use strict';
const assert = require('assert/strict');
require('../assets/engine.js');
require('../assets/analysis-core.js');
const Result = require('../assets/analysis-result.js');
const Presets = require('../assets/level-presets.js');
const Core = globalThis.ChessyAnalysisCore;
const Chess = globalThis.Chess;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('untrusted saved IDs cannot resolve inherited properties or coerce objects', function () {
  for (const id of ['constructor', '__proto__', 'toString', '', null, undefined, {}, ['master']]) {
    assert.equal(Presets.get(id), null);
    assert.equal(Presets.forClock(id, null, 0), null);
  }
  assert.equal(Presets.get(1), Presets.get('1'));
});

test('Master uses the full supported depth and an uncapped eight-second Play scan', function () {
  const master = Presets.get('master');
  assert.equal(master.maxDepth, 111);
  assert.equal(master.timeMs, 8000);
  assert.equal(master.nodeLimit, null);
  assert.equal(master.quiesce, true);
  assert.equal(Presets.forClock('master', null, 0), master);
});

test('clock allocation leaves a delivery reserve and room for an identical retry', function () {
  for (const id of Presets.ORDER) {
    const original = Presets.get(id);
    for (const remaining of [10, 100, 1000, 2000, 5000, 30000, 300000]) {
      for (const increment of [0, 1000, 3000, 10000]) {
        const cfg = Presets.forClock(id, remaining, increment);
        assert.ok(Object.isFrozen(cfg));
        assert.ok(Number.isInteger(cfg.timeMs) && cfg.timeMs >= 1);
        assert.ok(cfg.timeMs <= original.timeMs);
        assert.ok(2 * cfg.timeMs + Math.min(1000, remaining / 2) <= remaining);
        assert.equal(cfg.maxDepth, original.maxDepth);
        assert.equal(cfg.nodeLimit, original.nodeLimit);
        assert.equal(cfg.quiesce, true);
      }
    }
  }
  assert.equal(Presets.get('master').timeMs, 8000);
  assert.equal(Presets.forClock('master', 2000, 3000).timeMs, 500);
  assert.equal(Presets.forClock('master', 30000, 0).timeMs, 1000);
});

test('near-empty clocks never become the WASM zero/unlimited sentinel', function () {
  for (const remaining of [0, 0.1, 1, 2, 3]) {
    assert.equal(Presets.forClock('master', remaining, 0).timeMs, 1);
  }
  for (const bad of [-1, NaN, Infinity, '1000']) {
    assert.throws(function () { Presets.forClock('master', bad, 0); }, RangeError);
    assert.throws(function () { Presets.forClock('master', 1000, bad); }, RangeError);
  }
});

test('deep analysis has genuine scan headroom; quick screening stays bounded', function () {
  assert.ok(Object.isFrozen(Core.PROFILES) && Object.isFrozen(Core.PROFILES.deep));
  assert.deepEqual(Core.scanConfig(Core.PROFILES.deep), { nodeLimit: 0, timeMs: 16000 });
  assert.equal(Core.PROFILES.deep.maxDepth, 111);
  assert.equal(Core.PROFILES.deep.nodeBudget, 16000000);
  assert.ok(Core.PROFILES.deep.scanTimeMs > Presets.get('master').timeMs);
  assert.deepEqual(Core.scanConfig(Core.PROFILES.quick), { nodeLimit: 5000, timeMs: 0 });
  assert.deepEqual(Core.scanConfig({ nodeLimit: 0 }), { nodeLimit: 150000, timeMs: 0 });
  assert.notEqual(Core.configHashOf(Core.PROFILES.deep), Core.configHashOf(
    Object.assign({}, Core.PROFILES.deep, { scanTimeMs: 8000 })));
  for (const bad of [-1, 1.5, 60001, Infinity, NaN, '16000']) {
    assert.throws(function () { Core.scanConfig({ scanTimeMs: bad }); }, RangeError);
  }
});

const state = Chess.newGameState();
const legal = Chess.legalMoves(state);
const winner = legal[legal.length - 1];
const played = legal[legal.length - 2];
function mockEngine(abort) {
  const calls = [];
  let roots = 0;
  return {
    calls: calls,
    search: function (fen, opts) {
      calls.push(['scan', opts]);
      return { depth: 3, move: winner, score: 27, nodes: 123, qnodes: 23 };
    },
    beginAnalysis: function (fen, opts) { roots = 0; calls.push(['begin', opts]); },
    searchRoot: function (move, depth) {
      roots++;
      calls.push(['root', move, depth]);
      return { complete: !abort, score: move === winner ? 27 : 0,
        pv: [move], nodes: roots * 11, qnodes: roots * 2 };
    }
  };
}

test('deadline reaches WASM; scan winner and played move are verified first', function () {
  const engine = mockEngine(false);
  const opts = Object.assign({}, Core.PROFILES.deep, { playedMove: played });
  const out = Core.analyse(state, opts, engine);
  const scan = engine.calls[0][1];
  assert.equal(scan.timeMs, 16000);
  assert.equal(scan.nodeLimit, 0);
  assert.equal(scan.maxDepth, 111);
  const roots = engine.calls.filter(function (c) { return c[0] === 'root'; });
  assert.deepEqual(roots[0][1], winner);
  assert.deepEqual(roots[1][1], played);
  assert.equal(roots.length, legal.length * 2);
  assert.equal(out.complete, true);
  assert.equal(out.nodes, 123 + 2 * legal.length * 11);
  const begins = engine.calls.filter(function (c) { return c[0] === 'begin'; });
  assert.ok(begins.every(function (c) { return c[1].nodeLimit === 16000000; }));
});

test('first-root exhaustion retains only a legal, explicitly partial scan winner', function () {
  const engine = mockEngine(true);
  const opts = Object.assign({}, Core.PROFILES.deep, { playedMove: played });
  const out = Core.analyse(state, opts, engine);
  assert.equal(out.complete, false);
  assert.equal(out.depth, 3);
  assert.equal(out.bestLines.length, 1);
  assert.deepEqual(out.bestLines[0].move, {
    from: winner.from, to: winner.to, promotion: winner.promotion || null
  });
  assert.equal(out.bestLines[0].pvUci.length, 1);
  assert.equal(out.scoreCpWhite, 27);
  assert.equal(out.playedLine, null);
  assert.equal(out.stability, null);
  assert.equal(out.classification, 'unknown-equivalence');
  assert.equal(out.nodes, 134);
  const expected = { identity: Core.identity(state, opts), requireComplete: false };
  const checked = Result.validate(out, state, expected);
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(Result.validate(out, state, Object.assign({}, expected,
    { requireComplete: true })).ok, false);
});

test('legacy fixed-node analysis keeps canonical root order and no scan fallback', function () {
  const engine = mockEngine(false);
  Core.analyse(state, { nodeLimit: 5000, maxDepth: 3 }, engine);
  assert.deepEqual(engine.calls.find(function (c) { return c[0] === 'root'; })[1], legal[0]);
  const partial = Core.analyse(state, { nodeLimit: 5000 }, mockEngine(true));
  assert.equal(partial.complete, false);
  assert.equal(partial.bestLines.length, 0);
});
console.log(passed + ' search-policy tests passed');
