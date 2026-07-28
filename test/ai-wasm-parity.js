/*
 * Exact-tree contract for the isolated Rust/WASM feasibility experiment.
 *
 * Run after building experiments/wasm/dist/chessy-ai-fast.wasm:
 *   node test/ai-wasm-parity.js
 *   node test/ai-wasm-parity.js --wasm /path/to/chessy-ai.wasm --depth 5
 */
'use strict';

const path = require('path');
const WasmBench = require('../experiments/wasm/bench.js');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf('--' + name);
  return index < 0 ? fallback : args[index + 1];
}

const depth = Number(option('depth', 5));
const wasmPath = path.resolve(option(
  'wasm',
  path.join(__dirname, '..', 'experiments', 'wasm', 'dist', 'chessy-ai-fast.wasm')
));
const referenceWasmOption = option('reference-wasm', null);
const referenceWasmPath = referenceWasmOption
  ? path.resolve(referenceWasmOption)
  : null;
if (!Number.isInteger(depth) || depth < 1 || depth > 64) {
  console.error('FAIL: --depth must be an integer from 1 to 64');
  process.exit(1);
}

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
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    check(expected.test(String(error && error.message || error)), label,
      String(error && error.message || error));
  }
}

function syntheticResultMemory() {
  const memory = { buffer: new ArrayBuffer(128) };
  const view = new DataView(memory.buffer, 32, WasmBench.RESULT_BYTES);
  view.setUint32(0, WasmBench.ABI_VERSION, true);
  view.setUint32(4, WasmBench.RESULT_BYTES, true);
  // e7-e8=Q with Chessy's a8=0 square numbering.
  view.setUint32(8, 12 | (4 << 6) | (1 << 12), true);
  view.setInt32(12, -123, true);
  view.setUint32(16, 7, true);
  view.setUint32(20, WasmBench.NONE_U32, true);
  view.setBigUint64(24, 4294967301n, true);
  view.setBigUint64(32, 19n, true);
  view.setBigUint64(40, 17n, true);
  view.setBigUint64(48, 3n, true);
  view.setUint32(56, 1, true);
  return memory;
}

console.log('packed WASM result decoder');
{
  let memory = syntheticResultMemory();
  const decoded = WasmBench.decodeResult(memory, 32);
  check(decoded.move === 'e7e8Q' && decoded.score === -123 &&
      decoded.depth === 7 && decoded.attemptedDepth === null &&
      decoded.nodes === 4294967301 && decoded.qnodes === 19 &&
      decoded.cutoffs === 17 && decoded.researches === 3 &&
      decoded.stopReason === 'max-depth',
    'decodes the 64-byte little-endian result without truncating u64 counters',
    JSON.stringify(decoded));

  new DataView(memory.buffer, 32).setUint32(0, 99, true);
  expectThrow('rejects an ABI-version mismatch', /ABI version 99/,
    function () { WasmBench.decodeResult(memory, 32); });

  memory = syntheticResultMemory();
  new DataView(memory.buffer, 32).setUint32(4, 60, true);
  expectThrow('rejects a result-size mismatch', /struct is 60 bytes/,
    function () { WasmBench.decodeResult(memory, 32); });
}

async function main() {
  const wasm = await WasmBench.loadWasmEngine(wasmPath);
  const js = WasmBench.loadJsEngine();
  const searchOptions = {
    maxDepth: depth,
    nodeLimit: 0,
    timeMs: 0,
    quiesce: true
  };

  console.log('host-to-module boundary');
  expectThrow('rejects an oversized FEN before writing linear memory',
    /exceeds WASM input capacity/,
    function () { wasm.search('x'.repeat(1025), searchOptions); });
  expectThrow('rejects a depth beyond fixed search storage',
    /maxDepth must be an integer from 0 through 111/,
    function () {
      wasm.search(WasmBench.POSITIONS[0][1], Object.assign({}, searchOptions, {
        maxDepth: 112
      }));
    });

  console.log('fixed-depth exact parity');
  for (const position of WasmBench.POSITIONS) {
    const baseline = js.search(position[1], searchOptions);
    const candidate = wasm.search(position[1], searchOptions);
    const differences = WasmBench.signatureDifferences(candidate, baseline);
    check(differences.length === 0, position[0],
      differences.length ? differences.join('; ') : null);
  }

  console.log('fixed-node abort parity');
  const nodeLimitedOptions = {
    maxDepth: 30,
    nodeLimit: 5000,
    timeMs: 0,
    quiesce: true
  };
  for (const position of WasmBench.POSITIONS) {
    const baseline = js.search(position[1], nodeLimitedOptions);
    const candidate = wasm.search(position[1], nodeLimitedOptions);
    const differences = WasmBench.signatureDifferences(candidate, baseline);
    check(differences.length === 0, position[0] + ' at 5,000 nodes',
      differences.length ? differences.join('; ') : null);
  }

  // load_position() must also reset all per-search state, including the TT,
  // fixed root RNG and counters. A warm repeat cannot inherit hidden state.
  const firstFen = WasmBench.POSITIONS[0][1];
  const first = wasm.search(firstFen, searchOptions);
  const repeated = wasm.search(firstFen, searchOptions);
  const repeatDifferences = WasmBench.signatureDifferences(repeated, first);
  check(repeatDifferences.length === 0,
    'reloading a FEN resets deterministic per-search state',
    repeatDifferences.length ? repeatDifferences.join('; ') : null);

  if (referenceWasmPath) {
    const reference = await WasmBench.loadWasmEngine(referenceWasmPath);
    console.log('extended candidate/reference differential');
    for (const position of WasmBench.POSITIONS) {
      for (const options of [
        { maxDepth: 6, nodeLimit: 0, timeMs: 0, quiesce: true },
        { maxDepth: 30, nodeLimit: 100000, timeMs: 0, quiesce: true }
      ]) {
        const baseline = reference.search(position[1], options);
        const candidate = wasm.search(position[1], options);
        const differences = WasmBench.signatureDifferences(candidate, baseline);
        const workload = options.nodeLimit
          ? ' at 100,000 nodes'
          : ' through depth 6';
        check(differences.length === 0, position[0] + workload,
          differences.length ? differences.join('; ') : null);
      }
    }

    console.log('special-move and edge-position differential');
    const edgeFens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
      '8/8/8/3pP3/8/8/8/K6k w - d6 0 1',
      'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
      '8/8/8/8/8/8/3k4/R3K3 w - - 0 1',
      '8/8/8/8/8/8/4K3/r3k3 b - - 0 1',
      'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    ];
    for (let index = 0; index < edgeFens.length; index++) {
      const fen = edgeFens[index];
      const jsResult = js.search(fen, searchOptions);
      for (const engine of [
        ['candidate', wasm],
        ['reference', reference]
      ]) {
        const actual = engine[1].search(fen, searchOptions);
        const differences = WasmBench.signatureDifferences(actual, jsResult);
        check(differences.length === 0,
          'edge position ' + (index + 1) + ' (' + engine[0] + ')',
          differences.length ? differences.join('; ') : null);
      }
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
