/* Fail-closed phase ownership at the production WASM loader boundary. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const WasmEngine = require('../assets/wasm-engine.js');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const engine = WasmEngine.loadSync(fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm')));
const fen = Chess.START_FEN;
const roots = Chess.legalMoves(Chess.parseFen(fen));
const root = roots[0];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
function begin() { engine.beginAnalysis(fen, { nodeLimit: 10000, quiesce: true }); }
function noOldPhase() {
  assert.throws(() => engine.searchRoot(root, 1, 1), /analysis phase is not ready/);
}

test('a root requires a successful explicit phase initialization', noOldPhase);

test('all legal roots share one successfully initialized phase and cumulative budget', () => {
  begin();
  let previousNodes = 0;
  for (const move of roots) {
    const result = engine.searchRoot(move, 1, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(result.move, {
      from: move.from, to: move.to, promotion: move.promotion || null
    });
    assert.deepEqual(result.pv[0], result.move);
    assert.ok(result.nodes > previousNodes);
    previousNodes = result.nodes;
  }
});

const rejectedReplacements = [
  ['a malformed FEN', () => engine.beginAnalysis('not a fen', { nodeLimit: 10000 }), /load_position/],
  ['an oversized FEN', () => engine.beginAnalysis(fen + ' '.repeat(1024), {}), /capacity/],
  ['a non-string FEN', () => engine.beginAnalysis(null, {}), /fen must be a string/],
  ['an invalid phase budget', () => engine.beginAnalysis(fen, { nodeLimit: -1 }), /nodeLimit/],
  ['invalid repetition counts', () => engine.beginAnalysis(fen, { positions: { [fen]: -1 } }), /occurrence/],
  ['an invalid ordinary-search depth', () => engine.search(fen, { maxDepth: 0 }), /maxDepth/],
  ['an invalid opening seed', () => engine.search(fen, { maxDepth: 2, rootSeed: -1 }), /rootSeed/],
  ['an invalid fixed-search depth', () => engine.fixedSearch(fen, { depth: -1 }), /depth/],
  ['a rejected evaluation position', () => engine.evaluate('not a fen'), /load_position/],
  ['a rejected explicit history replacement', () => engine.setHistory({ [fen]: -1 }, fen), /occurrence/]
];
for (const [name, replace, error] of rejectedReplacements) {
  test(name + ' cannot leave the previous analysis phase usable', () => {
    begin();
    assert.equal(engine.searchRoot(root, 1, 1).complete, true);
    assert.throws(replace, error);
    noOldPhase();
    begin();
    assert.equal(engine.searchRoot(root, 1, 1).complete, true);
  });
}

for (const [name, replace] of [
  ['ordinary search', () => engine.search(fen, { maxDepth: 1, nodeLimit: 10000 })],
  ['fixed search', () => engine.fixedSearch(fen, { depth: 1, nodeLimit: 10000 })],
  ['static evaluation', () => engine.evaluate(fen)],
  ['repetition-history replacement', () => engine.setHistory({}, fen)]
]) {
  test(name + ' invalidates a previous exact-root phase', () => {
    begin();
    replace();
    noOldPhase();
  });
}

test('a fresh phase after rejection uses the new position and a fresh budget', () => {
  begin();
  assert.throws(() => engine.beginAnalysis('bad fen', {}));
  const next = Chess.applyMove(Chess.parseFen(fen), root);
  const nextFen = Chess.toFen(next);
  const nextRoot = Chess.legalMoves(next)[0];
  engine.beginAnalysis(nextFen, { nodeLimit: 10000, quiesce: true });
  const actual = engine.searchRoot(nextRoot, 2, 2);
  const fresh = WasmEngine.loadSync(fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm')));
  fresh.beginAnalysis(nextFen, { nodeLimit: 10000, quiesce: true });
  assert.deepEqual(actual, fresh.searchRoot(nextRoot, 2, 2));
});

test('ABI-v2 reserved result word is zero or rejected, including the high bit', () => {
  const memory = { buffer: new ArrayBuffer(WasmEngine.RESULT_BYTES) };
  const view = new DataView(memory.buffer);
  view.setUint32(0, WasmEngine.ABI_VERSION, true);
  view.setUint32(4, WasmEngine.RESULT_BYTES, true);
  view.setUint32(8, 0xffffffff, true);
  view.setUint32(20, 0xffffffff, true);
  assert.equal(WasmEngine.decodeResult(memory, 0).move, null);
  for (const reserved of [1, 0x80000000, 0xffffffff]) {
    view.setUint32(60, reserved, true);
    assert.throws(() => WasmEngine.decodeResult(memory, 0), /reserved field/);
  }
  view.setUint32(60, 0, true);
  assert.equal(WasmEngine.decodeResult(memory, 0).attemptedDepth, null);
});

console.log(passed + ' passed, 0 failed');
