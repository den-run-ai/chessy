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
function key(move) { return move.from + '-' + move.to; }
function is(a, b) { return key(a) === key(b); }
// A depth-aware mock of the WASM exact-root ABI. `scores(move, depth)` gives
// White-POV root scores; `stopAt(depth, index)` aborts that root (budget) and
// `saturateAt` throws the loader's tagged TT-saturation error instead.
function mockEngine(options) {
  options = options || {};
  const calls = [];
  let roots = 0;
  let spent = 0;
  let indexInDepth = 0;
  let lastDepth = 0;
  function nodes() { return options.nodeCost ? spent : roots * 11; }
  return {
    calls: calls,
    search: function (fen, opts) {
      calls.push(['scan', opts]);
      return { depth: options.scanDepth || 3, move: options.scanMove || winner,
        score: 27, nodes: 123, qnodes: 23 };
    },
    beginAnalysis: function (fen, opts) { roots = 0; spent = 0; calls.push(['begin', opts]); },
    searchRoot: function (move, depth) {
      if (depth !== lastDepth) { lastDepth = depth; indexInDepth = 0; }
      const index = indexInDepth++;
      roots++;
      if (options.nodeCost) spent += options.nodeCost(depth);
      calls.push(['root', move, depth]);
      if (options.saturateAt && options.saturateAt(depth, index)) {
        const error = new Error('analysis_root() failed with status 2');
        error.code = Core.TT_SATURATED;
        error.result = { nodes: roots * 11 + 5, qnodes: roots * 2 };
        throw error;
      }
      if (options.throwAt && options.throwAt(depth, index)) throw new Error('corrupt ABI');
      if ((options.stopAt && options.stopAt(depth, index)) ||
          (options.stopWhenSpent && spent > options.stopWhenSpent)) {
        return { complete: false, score: 0, pv: [], nodes: nodes(), qnodes: roots * 2 };
      }
      const score = options.scores ? options.scores(move, depth)
        : (is(move, winner) ? 27 : 0);
      return { complete: true, score: score, pv: [move], nodes: nodes(), qnodes: roots * 2 };
    }
  };
}
function deep(extra) {
  return Object.assign({}, Core.PROFILES.deep, { playedMove: played }, extra || {});
}
function rootCalls(engine) {
  return engine.calls.filter(function (c) { return c[0] === 'root'; });
}

test('deadline reaches WASM; one phase verifies every root at each depth to the scan cap', function () {
  const engine = mockEngine();
  const out = Core.analyse(state, deep(), engine);
  const scan = engine.calls[0][1];
  assert.equal(scan.timeMs, 16000);
  assert.equal(scan.nodeLimit, 0);
  assert.equal(scan.maxDepth, 111);
  const begins = engine.calls.filter(function (c) { return c[0] === 'begin'; });
  assert.equal(begins.length, 1);
  assert.equal(begins[0][1].nodeLimit, 16000000);
  const roots = rootCalls(engine);
  assert.equal(roots.length, legal.length * 3);
  for (let depth = 1; depth <= 3; depth++) {
    const atDepth = roots.filter(function (c) { return c[2] === depth; });
    assert.equal(new Set(atDepth.map(function (c) { return key(c[1]); })).size, legal.length);
  }
  // The first iteration visits the scan winner and the played move first.
  assert.deepEqual(roots[0][1], winner);
  assert.deepEqual(roots[1][1], played);
  assert.equal(out.complete, true);
  assert.equal(out.depth, 3);
  assert.deepEqual(out.stability, { depths: [2, 3], bestMoveStable: true });
  assert.equal(out.nodes, 123 + legal.length * 3 * 11);
  assert.ok(is(out.bestLines[0].move, winner));
  assert.equal(out.scoreCpWhite, 27);
  // Every other root ties at 0, so canonical order ranks the played move last.
  assert.equal(out.playedLine.rank, legal.length);
  assert.equal(out.classification, 'unknown-equivalence');
  const checked = Result.validate(out, state, { identity: Core.identity(state, deep()),
    requireComplete: true, requireStability: true, minDepth: 3, requirePlayed: true,
    playedMove: played });
  assert.equal(checked.ok, true, checked.reason);
});

test('a cut-off deeper iteration is discarded whole; the last full depth is reported', function () {
  // Scores differ by depth so a mixed-depth result would be detectable.
  const engine = mockEngine({
    scanDepth: 5,
    scores: function (move, depth) {
      if (is(move, winner)) return 10 * depth;
      if (is(move, played)) return depth === 3 ? -50 : 5;
      return 0;
    },
    stopAt: function (depth, index) { return depth === 4 && index === 3; }
  });
  const out = Core.analyse(state, deep(), engine);
  assert.equal(out.complete, true);
  assert.equal(out.depth, 3);
  assert.deepEqual(out.stability, { depths: [2, 3], bestMoveStable: true });
  assert.equal(out.scoreCpWhite, 30);
  assert.equal(out.playedLine.scoreCpWhite, -50);
  assert.equal(out.playedLine.rank, legal.length);
  assert.equal(out.classification, 'unknown-equivalence');
  // The aborted root's cumulative counters are included exactly once.
  assert.equal(out.nodes, 123 + (legal.length * 3 + 4) * 11);
});

test('an iteration the budget cannot finish is not started (two-ply average growth)', function () {
  // Per-root costs alternate by depth parity (×4, ×2, ×4): the last two
  // growth ratios are 2 and 4, so the two-ply average predicts √8 ≈ 2.83×.
  const perRoot = [10, 40, 80, 320];
  const cost = function (depth) { return perRoot[depth - 1]; };
  const n = legal.length;
  const spentThrough3 = n * (10 + 40 + 80);
  function run(remaining) {
    const budget = spentThrough3 + remaining;
    const engine = mockEngine({ scanDepth: 4, nodeCost: cost,
      stopWhenSpent: budget });
    const out = Core.analyse(state, deep({ nodeBudget: budget }), engine);
    return { out: out, depth4: rootCalls(engine).filter(function (c) { return c[2] === 4; }).length };
  }
  // 200n left: the average predicts 226n, so depth 4 is skipped (the
  // optimistic ×2 rule would have started it and wasted the work).
  const skipped = run(200 * n);
  assert.equal(skipped.depth4, 0);
  assert.equal(skipped.out.depth, 3);
  assert.equal(skipped.out.complete, true);
  assert.equal(skipped.out.nodes, 123 + spentThrough3);
  // 250n left: the average predicts 226n, so depth 4 is attempted (the
  // pessimistic ×4 rule would have skipped it) and discarded when cut.
  const attempted = run(250 * n);
  assert.ok(attempted.depth4 > 0 && attempted.depth4 < n);
  assert.equal(attempted.out.depth, 3);
  assert.equal(attempted.out.complete, true);
  // Enough budget verifies depth 4 in full.
  const fits = run(320 * n);
  assert.equal(fits.depth4, n);
  assert.equal(fits.out.depth, 4);
});

test('timed verification reaches depth 3 even when the scan stopped shallower', function () {
  const engine = mockEngine({ scanDepth: 1 });
  const out = Core.analyse(state, deep(), engine);
  assert.equal(out.depth, 3);
  assert.deepEqual(out.stability, { depths: [2, 3], bestMoveStable: true });
  // A request that caps depth lower keeps its own cap.
  const capped = Core.analyse(state, deep({ maxDepth: 2 }), mockEngine({ scanDepth: 1 }));
  assert.equal(capped.depth, 2);
});

test('TT saturation ends verification at the last full depth; other errors propagate', function () {
  const saturated = mockEngine({ scanDepth: 6,
    saturateAt: function (depth, index) { return depth === 3 && index === 7; } });
  const out = Core.analyse(state, deep(), saturated);
  assert.equal(out.complete, true);
  assert.equal(out.depth, 2);
  assert.deepEqual(out.stability, { depths: [1, 2], bestMoveStable: true });
  assert.equal(out.nodes, 123 + (legal.length * 2 + 8) * 11 + 5);
  const corrupt = mockEngine({ throwAt: function (depth, index) { return depth === 2 && index === 1; } });
  assert.throws(function () { Core.analyse(state, deep(), corrupt); }, /corrupt ABI/);
});

test('a deeper scan preferring a strictly worse-ranked move makes the best move unstable', function () {
  const other = legal[0];
  function scores(tieAtThree) {
    return function (move, depth) {
      if (is(move, other)) return 40;
      if (is(move, winner)) return tieAtThree ? 40 : 30;
      return 0;
    };
  }
  // Verified depth 3 prefers `other`, but the depth-6 scan chose `winner`.
  const contrary = Core.analyse(state, deep(), mockEngine({ scanDepth: 6,
    scores: scores(false), stopAt: function (depth) { return depth === 4; } }));
  assert.equal(contrary.depth, 3);
  assert.deepEqual(contrary.bestLines[0].move,
    { from: other.from, to: other.to, promotion: null });
  assert.deepEqual(contrary.stability, { depths: [2, 3], bestMoveStable: false });
  // An exact tie with the scan winner is not contrary evidence.
  const tied = Core.analyse(state, deep(), mockEngine({ scanDepth: 6,
    scores: scores(true), stopAt: function (depth) { return depth === 4; } }));
  assert.equal(tied.stability.bestMoveStable, true);
  // At the scan's own depth the exact verification is authoritative.
  const reached = Core.analyse(state, deep(), mockEngine({ scanDepth: 3, scores: scores(false) }));
  assert.equal(reached.depth, 3);
  assert.equal(reached.stability.bestMoveStable, true);
});

test('ties rank by canonical legal order, never by the search order', function () {
  const flat = Core.analyse(state, deep(), mockEngine({ scores: function () { return 0; } }));
  // The scan winner and played move were searched first, yet legal[0] leads.
  assert.deepEqual(flat.bestLines[0].move,
    { from: legal[0].from, to: legal[0].to, promotion: null });
  assert.notEqual(flat.classification, 'same');
  assert.equal(flat.playedLine.rank, legal.length - 1);
});

test('iterative progress spans roots × depths and is described per depth', function () {
  const events = [];
  const engine = mockEngine({ scanDepth: 3 });
  Core.analyse(state, deep({ onProgress: function (e) { events.push(e); } }), engine);
  const roots = events.filter(function (e) { return e.phase === 'root-verification'; });
  const n = legal.length;
  assert.deepEqual(roots.map(function (e) { return e.completedRoots; }),
    Array.from({ length: 3 * n + 1 }, function (_, i) { return i; }));
  assert.ok(roots.every(function (e) { return e.totalRoots === 3 * n; }));
  assert.deepEqual(Core.progressView(0, 3 * n, n),
    { depth: 1, cap: 3, verified: 0, roots: n, done: false });
  assert.deepEqual(Core.progressView(n + 5, 3 * n, n),
    { depth: 2, cap: 3, verified: 5, roots: n, done: false });
  assert.deepEqual(Core.progressView(3 * n, 3 * n, n),
    { depth: 3, cap: 3, verified: n, roots: n, done: true });
  // Fixed-node progress counts each root once.
  assert.equal(Core.progressView(4, n, n).cap, 1);
  for (const bad of [[1, 3 * n + 1, n], [-1, 3 * n, n], [1, 3 * n, 0], [1, 7, 3], [5, 4, 4]]) {
    assert.equal(Core.progressView(bad[0], bad[1], bad[2]), null);
  }
});

test('first-root exhaustion retains only a legal, explicitly partial scan winner', function () {
  const engine = mockEngine({ stopAt: function () { return true; } });
  const opts = deep();
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
  const engine = mockEngine();
  const fixed = Core.analyse(state, { nodeLimit: 5000, maxDepth: 3 }, engine);
  const roots = rootCalls(engine);
  assert.deepEqual(roots[0][1], legal[0]);
  // Two phases at the scan depth and one below it; no iterative schedule.
  assert.equal(engine.calls.filter(function (c) { return c[0] === 'begin'; }).length, 2);
  assert.deepEqual(roots.map(function (c) { return c[2]; }),
    legal.map(function () { return 3; }).concat(legal.map(function () { return 2; })));
  assert.equal(fixed.depth, 3);
  const partial = Core.analyse(state, { nodeLimit: 5000 },
    mockEngine({ stopAt: function () { return true; } }));
  assert.equal(partial.complete, false);
  assert.equal(partial.bestLines.length, 0);
  // Fixed-node cache identities are exactly r79's (literal, not derived).
  assert.equal(Core.configHashOf(Core.PROFILES.quick), 'd3984af1');
  assert.equal(Core.configHashOf(Core.PROFILES.quickFallback), 'c0c102dc');
});
console.log(passed + ' search-policy tests passed');
