/*
 * Freeze the shipped r69 Rust/WASM search signatures before removing the
 * duplicate JavaScript search oracle. Run only when intentionally refreshing
 * the engine contract:
 *
 *   node test/gen-wasm-signatures.js --wasm /path/to/exact-r69.wasm
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bench = require('../experiments/wasm/bench.js');

const ROOT = path.join(__dirname, '..');
const wasmArg = process.argv.indexOf('--wasm');
if (wasmArg < 0 || !process.argv[wasmArg + 1]) {
  throw new Error('provide the exact frozen r69 module with --wasm <path>');
}
const WASM = path.resolve(process.argv[wasmArg + 1]);
const OUT = path.join(__dirname, 'fixtures', 'wasm-r69-signatures.json');
const SOURCE_WASM_SHA256 =
  'dab3d6025d507b2c93218616f3871cb7c13d7542e848ea741a750485b5cef6db';
const FIELDS = [
  'move', 'score', 'depth', 'attemptedDepth', 'nodes', 'qnodes',
  'cutoffs', 'researches', 'stopReason'
];

function signature(result) {
  const out = {};
  for (const field of FIELDS) out[field] = result[field];
  return out;
}

(async function () {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(WASM)).digest('hex');
  if (digest !== SOURCE_WASM_SHA256) {
    throw new Error('refusing to label non-r69 bytes as the frozen source: ' + digest);
  }
  const engine = await bench.loadWasmEngine(WASM, 'r69');
  const cases = [];
  for (const pair of bench.POSITIONS) {
    const name = pair[0], fen = pair[1];
    for (const quiesce of [false, true]) {
      for (let depth = 1; depth <= 3; depth++) {
        const opts = { maxDepth: depth, quiesce: quiesce };
        cases.push({
          name: name,
          config: opts,
          result: signature(engine.search(fen, opts))
        });
      }
      const abort = { maxDepth: 30, nodeLimit: 5000, quiesce: quiesce };
      cases.push({
        name: name,
        config: abort,
        result: signature(engine.search(fen, abort))
      });
    }
  }
  const artifact = {
    schema: 1,
    source: 'r69 shipped Rust/WASM search contract',
    sourceCommit: '8b887c4a69f8b06bb50ad8d77be896f26938ed42',
    sourceWasmSha256: SOURCE_WASM_SHA256,
    fields: FIELDS,
    cases: cases
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n');
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + cases.length + ' cases)');
})().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
