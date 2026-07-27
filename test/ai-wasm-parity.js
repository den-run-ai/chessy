/*
 * Exact-tree contract for the isolated Zig/WASM feasibility experiment.
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
  console.log('fixed-depth exact parity');
  const wasm = await WasmBench.loadWasmEngine(wasmPath);
  const js = WasmBench.loadJsEngine();
  const searchOptions = {
    maxDepth: depth,
    nodeLimit: 0,
    timeMs: 0,
    quiesce: true
  };

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

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
