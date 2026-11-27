#!/usr/bin/env node
/*
 * Static White-POV evaluation of newline-delimited FENs on stdin through a
 * WASM module's `evaluate_loaded` export (production loader). Prints one
 * integer per line. Used to compare the shipped HCE's teacher loss with the
 * prototype nets on the same validation rows.
 *
 *   node tools/nnue/hce-eval.js --wasm assets/chessy-ai-fast.wasm < fens.txt
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));

async function main() {
  const index = process.argv.indexOf('--wasm');
  const wasmPath = index >= 0 ? process.argv[index + 1] : path.join(ROOT, 'assets', 'chessy-ai-fast.wasm');
  const engine = await WasmEngine.load(fs.readFileSync(wasmPath));
  const input = fs.readFileSync(0, 'utf8').split('\n');
  const out = [];
  for (const line of input) {
    const fen = line.trim();
    if (!fen) continue;
    const full = fen.split(' ').length === 4 ? fen + ' 0 1' : fen;
    out.push(String(engine.evaluate(full)));
  }
  process.stdout.write(out.join('\n') + '\n');
}

main().catch(error => { console.error(error); process.exit(1); });
