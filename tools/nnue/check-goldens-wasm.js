#!/usr/bin/env node
/*
 * Verifies a built candidate module against the exporter's integer goldens
 * through the production loader's static `evaluate` path (evaluate_loaded ->
 * nnue::evaluate_fresh), so the trainer, the Rust unit test and the actual
 * WASM artifact all agree on the same integers.
 *
 *   node tools/nnue/check-goldens-wasm.js --wasm /data/nets/h32.wasm --goldens /data/nets/h32.goldens.txt
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));

function opt(name) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const engine = await WasmEngine.load(fs.readFileSync(opt('wasm')));
  const lines = fs.readFileSync(opt('goldens'), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
  let checked = 0, mismatches = 0;
  for (const line of lines) {
    const at = line.lastIndexOf('|');
    const fen = line.slice(0, at).trim();
    const expected = Number(line.slice(at + 1));
    const got = engine.evaluate(fen);
    checked++;
    if (got !== expected) { mismatches++; if (mismatches <= 5) console.error('mismatch', fen, expected, got); }
  }
  console.log(JSON.stringify({ schema: 'chessy.nnue-proto-wasm-goldens.v1', wasm: path.resolve(opt('wasm')), checked, mismatches }));
  process.exit(mismatches === 0 && checked > 0 ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(1); });
