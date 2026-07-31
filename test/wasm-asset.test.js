/*
 * Shipped Rust/WASM engine asset contract (#84/#113 flagged rollout).
 *
 * The committed assets/chessy-ai-fast.wasm must be byte-identical to the
 * canonical pinned-toolchain ABI-v2 build validated by PR #147 (Rust 1.97.1
 * commit 8bab26f4f, Binaryen 131), and the production loader
 * (assets/wasm-engine.js) must preserve the frozen r69 Rust/WASM signatures
 * for quiescent shipped Play and the legacy quiescence-off configuration
 * retained as a compatibility witness. No duplicate JavaScript search oracle
 * is loaded by this gate.
 *
 * Hermetic: runs against committed bytes, no toolchain required.
 *   node test/wasm-asset.test.js
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bench = require('../experiments/wasm/bench.js');
const WasmEngine = require('../assets/wasm-engine.js');

const ROOT = path.join(__dirname, '..');
const WASM_PATH = path.join(ROOT, 'assets', 'chessy-ai-fast.wasm');

// The optimized ABI-v2 fast-build digest produced by the pinned,
// byte-reproducible CI builder. A drifted binary must never ship under this
// release's provenance.
const CANONICAL_SHA256 =
  '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f';

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function expectThrow(label, expected, callback) {
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      throw new Error('async result not supported in expectThrow');
    }
    check(false, label, 'did not throw');
  } catch (error) {
    check(expected.test(String(error && error.message || error)), label,
      String(error && error.message || error));
  }
}

async function main() {
  // ---- Provenance pin ----
  const bytes = fs.readFileSync(WASM_PATH);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  check(digest === CANONICAL_SHA256,
    'assets/chessy-ai-fast.wasm matches the canonical ABI-v2 build digest',
    digest);

  // ---- Production loader contract (assets/wasm-engine.js) ----
  const engine = await WasmEngine.load(bytes);
  check(engine.memoryBytes() === 26542080,
    'module reserves the documented fixed linear memory (25.31 MiB)');

  require('../assets/engine.js');
  const startResult = engine.search(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    { maxDepth: 1, quiesce: false });
  const startLegal = Chess.legalMoves(Chess.parseFen(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
  check(!!startResult.move && startLegal.some(function (m) {
    return m.from === startResult.move.from && m.to === startResult.move.to &&
      m.promotion === startResult.move.promotion;
  }), 'loader returns a {from, to, promotion} move resolvable against Chess.legalMoves');
  check(startResult.depth === 1 && startResult.stopReason === 'max-depth' &&
      startResult.scorePov === 'white',
    'loader normalizes depth, stop reason and score POV to the Play result contract');

  // A saved game's aggregate position map can be much longer than the live
  // halfmove window. These valid but now-irrelevant positions all have a
  // different pawn placement/piece count; sending them would exceed the raw
  // 768-occurrence table, while lossless irreversible-history pruning keeps
  // the current search identical.
  const staleHistory = {};
  for (let i = 0; i < 769; i++) {
    staleHistory['7k/8/8/8/P7/8/8/K7 w - - ' + i + ' 1'] = 1;
  }
  const prunedHistoryResult = engine.search(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    { maxDepth: 1, quiesce: false, positions: staleHistory });
  check(prunedHistoryResult.move.from === startResult.move.from &&
      prunedHistoryResult.move.to === startResult.move.to &&
      prunedHistoryResult.score === startResult.score,
    'irreversible stale history is pruned losslessly before the fixed transport');

  // Promotion decode: e7e8=Q in Chessy numbering (a8 = 0) is
  // from 12 | to 4 << 6 | promotion 1 << 12.
  const synthetic = { buffer: new ArrayBuffer(128) };
  const view = new DataView(synthetic.buffer, 32, WasmEngine.RESULT_BYTES);
  view.setUint32(0, WasmEngine.ABI_VERSION, true);
  view.setUint32(4, WasmEngine.RESULT_BYTES, true);
  view.setUint32(8, 12 | (4 << 6) | (1 << 12), true);
  view.setUint32(56, 1, true); // max-depth
  const decoded = WasmEngine.decodeResult(synthetic, 32);
  check(decoded.move.from === 12 && decoded.move.to === 4 &&
      decoded.move.promotion === 'Q',
    'packed promotion moves decode to uppercase legalMoves promotion letters');

  view.setUint32(0, 999, true);
  expectThrow('a foreign ABI version is a hard failure', /ABI version/,
    function () { WasmEngine.decodeResult(synthetic, 32); });
  view.setUint32(0, WasmEngine.ABI_VERSION, true);
  view.setUint32(4, 32, true);
  expectThrow('a foreign result size is a hard failure', /64/,
    function () { WasmEngine.decodeResult(synthetic, 32); });
  view.setUint32(4, WasmEngine.RESULT_BYTES, true);
  view.setUint32(8, 1 << 15, true);
  expectThrow('reserved packed-move bits are a hard failure', /reserved bits/,
    function () { WasmEngine.decodeResult(synthetic, 32); });
  view.setUint32(8, 12 | (5 << 12), true);
  expectThrow('an invalid promotion code is a hard failure', /promotion code/,
    function () { WasmEngine.decodeResult(synthetic, 32); });
  view.setUint32(8, 12, true);
  view.setUint32(56, 99, true);
  expectThrow('an invalid stop-reason code is a hard failure', /stop-reason/,
    function () { WasmEngine.decodeResult(synthetic, 32); });

  expectThrow('maxDepth 0 is rejected before it can silently diverge',
    /maxDepth/, function () {
      engine.search('8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1',
        { maxDepth: 0, quiesce: true });
    });
  expectThrow('an oversized FEN is rejected before the memory write',
    /WASM capacity/, function () {
      engine.search('8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1 ' + 'x'.repeat(1024),
        { maxDepth: 1, quiesce: true });
    });

  // ---- Frozen exact signatures for shipped and legacy configurations ----
  // These results were recorded from the reviewed r69 WASM artifact before
  // the duplicate JavaScript search was removed. All current levels use
  // quiesce:true; false remains a useful pre-r69 compatibility witness.
  const wasm = await bench.loadWasmEngine(WASM_PATH, 'shipped');
  for (const quiesce of [true, false]) {
    let checked = 0;
    let diverged = 0;
    const details = [];
    for (let depth = 1; depth <= 3; depth++) {
      for (const [name, fen] of bench.POSITIONS) {
        const opts = { maxDepth: depth, quiesce: quiesce };
        const expected = bench.frozenSignature(name, opts);
        const diffs = expected
          ? bench.signatureDifferences(wasm.search(fen, opts), expected)
          : ['missing frozen signature'];
        checked++;
        if (diffs.length) {
          diverged++;
          if (details.length < 3) {
            details.push(name + ' d' + depth + ': ' + diffs.join('; '));
          }
        }
      }
    }
    check(diverged === 0,
      'frozen exact signatures, depths 1..3, quiesce ' +
      (quiesce ? 'on' : 'off') +
      ' (' + checked + ' searches)', details.join(' | '));
  }
  for (const quiesce of [true, false]) {
    let aborted = 0;
    for (const [name, fen] of bench.POSITIONS) {
      const opts = { maxDepth: 30, quiesce: quiesce, nodeLimit: 5000 };
      const expected = bench.frozenSignature(name, opts);
      if (!expected || bench.signatureDifferences(
        wasm.search(fen, opts), expected).length) aborted++;
    }
    check(aborted === 0,
      'frozen fixed-node (5000) signatures, quiesce ' +
      (quiesce ? 'on' : 'off') +
      ' (' + bench.POSITIONS.length + ' positions)');
  }

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
