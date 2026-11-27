/* Seeded Play searches: evaluated moves, deterministic retries, and bounded
 * work. The independent shallow oracle uses JS legal moves and minimax; only
 * leaf evaluation comes from a separate WASM instance. No score jitter, book,
 * strength claim, or locked evaluation positions are involved. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const Wasm = require('../assets/wasm-engine.js');
const bytes = fs.readFileSync(process.env.CHESSY_OPENING_WASM ||
  path.join(__dirname, '../assets/chessy-ai-fast.wasm'));
const engine = Wasm.loadSync(bytes);
const leaf = Wasm.loadSync(bytes);
const tests = [];
function test(name, run) { tests.push([name, run]); }
function uci(move) {
  return move && Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion || '');
}
function legal(state, move) {
  const found = Chess.legalMoves(state).find(candidate => uci(candidate) === uci(move));
  assert.ok(found, 'illegal selected move ' + uci(move));
  return found;
}
const start = Chess.newGameState();
const openings = [
  ['initial position', start],
  ['after e4', Chess.playMove(start, Chess.legalMoves(start).find(m => uci(m) === 'e2e4'))],
  ['after d4', Chess.playMove(start, Chess.legalMoves(start).find(m => uci(m) === 'd2d4'))]
];

test('omitted/null seeds retain the original default and do not inherit a prior seed', () => {
  for (const [, state] of openings) {
    const fen = Chess.toFen(state);
    const opts = { maxDepth: 4, nodeLimit: 10000, quiesce: true };
    const original = engine.search(fen, opts);
    assert.deepEqual(engine.search(fen, { ...opts, rootSeed: 0x00C0FFEE }), original);
    engine.search(fen, { ...opts, rootSeed: 12345 });
    assert.deepEqual(engine.search(fen, opts), original);
    assert.deepEqual(engine.search(fen, { ...opts, rootSeed: null }), original);
  }
});

test('a fixed seed reproduces complete fixed-node output in a fresh worker instance', () => {
  const fresh = Wasm.loadSync(bytes);
  for (const rootSeed of [0, 1, 0x80000000, 0xffffffff]) {
    const opts = { maxDepth: 111, nodeLimit: 10000, quiesce: true, rootSeed };
    const first = engine.search(Chess.START_FEN, opts);
    assert.deepEqual(fresh.search(Chess.START_FEN, opts), first);
    engine.search(Chess.toFen(openings[1][1]), { ...opts, rootSeed: (rootSeed ^ 123) >>> 0 });
    assert.deepEqual(engine.search(Chess.START_FEN, opts), first);
  }
});

for (const [name, state] of openings) {
  test(name + ': distinct seeds select different calculated opening moves', () => {
    const selected = new Set();
    for (let rootSeed = 0; rootSeed < 16; rootSeed++) {
      const result = engine.search(Chess.toFen(state), {
        maxDepth: 2, nodeLimit: 10000, quiesce: true, rootSeed
      });
      legal(state, result.move);
      assert.equal(result.depth, 2);
      assert.equal(result.stopReason, 'max-depth');
      assert.ok(result.nodes <= 10000);
      selected.add(uci(result.move));
    }
    assert.ok(selected.size > 1, 'seed ignored: every opening was identical');
  });
}

test('variety remains present at all shipped fixed-node levels without exceeding caps', () => {
  for (const nodeLimit of [10000, 36000, 230000]) {
    const selected = new Set();
    for (let rootSeed = 0; rootSeed < 8; rootSeed++) {
      const result = engine.search(Chess.START_FEN, {
        maxDepth: 111, nodeLimit, quiesce: true, rootSeed
      });
      assert.ok(result.depth >= 1);
      assert.ok(result.nodes <= nodeLimit);
      assert.equal(result.stopReason, 'node-limit');
      selected.add(uci(legal(start, result.move)));
    }
    assert.ok(selected.size > 1, 'no initial-position variety at ' + nodeLimit);
  }
});

// Full minimax with no TT, PVS, aspiration windows, or move ordering. The
// tested horizon is too short for a fresh position to repeat.
function oracle(state, depth, ply) {
  const moves = Chess.legalMoves(state);
  if (!moves.length) return Chess.inCheck(state, state.turn)
    ? (state.turn === 'w' ? -1 : 1) * (1000000 - ply) : 0;
  if (state.halfmove >= 100 || Chess.insufficientMaterial(state.board)) return 0;
  if (!depth) return leaf.evaluate(Chess.toFen(state));
  const scores = moves.map(move => oracle(Chess.applyMove(state, move), depth - 1, ply + 1));
  return state.turn === 'w' ? Math.max(...scores) : Math.min(...scores);
}

test('different root orders still choose exact best moves against independent minimax', () => {
  const positions = openings.map(([name, state]) => [name, Chess.toFen(state)]).concat([
    ['mate in one', '7k/8/5KQ1/8/8/8/8/8 w - - 0 1'],
    ['underpromotion', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1'],
    ['en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'],
    ['hanging queen', '4k3/8/8/8/4q3/8/4R3/4K3 w - - 0 1']
  ]);
  for (const [name, fen] of positions) {
    const state = Chess.parseFen(fen);
    for (const maxDepth of [1, 2, 3]) {
      const expected = oracle(state, maxDepth, 0);
      for (const rootSeed of [0, 1, 0xffffffff]) {
        const result = engine.search(fen, { maxDepth, nodeLimit: 0, quiesce: false, rootSeed });
        const move = legal(state, result.move);
        // A proven mate may terminate iterative deepening before maxDepth.
        const atCompletedDepth = result.depth === maxDepth
          ? expected : oracle(state, result.depth, 0);
        assert.equal(result.score, atCompletedDepth, name + ': root score');
        assert.equal(oracle(Chess.applyMove(state, move), result.depth - 1, 1),
          atCompletedDepth, name + ': selected root must be exact best, not a PVS bound');
      }
    }
  }
});

test('seeded searches preserve completed iterations at the exact node boundary', () => {
  for (const quiesce of [false, true]) {
    for (const rootSeed of [0, 1, 0xffffffff]) {
      const opts = { maxDepth: 2, nodeLimit: 0, quiesce, rootSeed };
      const full = engine.search(Chess.START_FEN, opts);
      const shallow = engine.search(Chess.START_FEN, { ...opts, maxDepth: 1 });
      assert.deepEqual(engine.search(Chess.START_FEN, { ...opts, nodeLimit: full.nodes }), full);
      const partial = engine.search(Chess.START_FEN, { ...opts, nodeLimit: full.nodes - 1 });
      assert.equal(partial.nodes, full.nodes - 1);
      assert.equal(partial.depth, 1);
      assert.equal(partial.attemptedDepth, 2);
      assert.equal(partial.stopReason, 'node-limit');
      assert.equal(partial.score, shallow.score);
      assert.deepEqual(partial.move, shallow.move);
    }
  }
});

test('seeded terminal searches retain repetition and game-over semantics', () => {
  for (const rootSeed of [0, 0xffffffff]) {
    const result = engine.search(Chess.START_FEN, {
      maxDepth: 3, quiesce: true, rootSeed, positions: { [Chess.START_FEN]: 3 }
    });
    assert.equal(result.move, null);
    assert.equal(result.stopReason, 'game-over');
    assert.equal(result.nodes, 0);
  }
});

test('invalid seed values fail closed and retire old analysis phases', () => {
  const root = Chess.legalMoves(start)[0];
  for (const rootSeed of [-1, 0x100000000, 1.5, '7', NaN, Infinity, true, {}]) {
    engine.beginAnalysis(Chess.START_FEN, { nodeLimit: 1000 });
    assert.throws(() => engine.search(Chess.START_FEN, { maxDepth: 2, rootSeed }), /rootSeed/);
    assert.throws(() => engine.searchRoot(root, 1, 1), /analysis phase is not ready/);
  }
});

test('a seed cannot be silently ignored by a module without the optional export', () => {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { now_ms: () => 0 } });
  const exports = Object.fromEntries(Object.entries(instance.exports).filter(([key]) => key !== 'search_seeded'));
  const context = {
    module: { exports: {} }, TextEncoder,
    WebAssembly: { Memory: WebAssembly.Memory, Module: WebAssembly.Module,
      Instance: function () { return { exports }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/wasm-engine.js'), 'utf8'), context);
  const older = context.module.exports.loadSync(bytes);
  assert.ok(older.search(Chess.START_FEN, { maxDepth: 1 }).move);
  assert.throws(() => older.search(Chess.START_FEN, { maxDepth: 1, rootSeed: 0 }), /search_seeded/);
});

test('Play worker forwards the exact request seed through queued requests', async () => {
  const requests = [], replies = [];
  const self = { location: { search: '?r=test' }, postMessage: message => replies.push(message) };
  const context = {
    self, importScripts: () => {}, Date,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    WasmEngine: { load: async () => ({ search: (fen, opts) => {
      requests.push({ fen, ...opts });
      return { move: { from: 12, to: 28, promotion: null } };
    } }) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/ai-worker.js'), 'utf8'), context);
  for (const [id, rootSeed] of [[1, 0], [2, 0xffffffff], [3, undefined]]) {
    self.onmessage({ data: { id, wasmUrl: 'module.wasm', fen: Chess.START_FEN, maxDepth: 2, rootSeed } });
  }
  for (let count = 0; count < 30 && replies.length !== 3; count++) await Promise.resolve();
  assert.equal(replies.length, 3);
  assert.deepEqual(requests.map(item => item.rootSeed), [0, 0xffffffff, undefined]);
  assert.deepEqual(replies.map(item => item.id), [1, 2, 3]);
});

(async () => {
  for (const [name, run] of tests) { await run(); console.log('  ok  ' + name); }
  console.log(tests.length + ' passed, 0 failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
