#!/usr/bin/env node
/*
 * Diagnostic D2: label FENs with a WASM module's own quiescent search at a
 * fixed node budget. Reads newline-delimited FENs, writes one line per FEN:
 * the White-POV score, or the literal "x" for a terminal root (no legal
 * move / already over). Mate scores are clamped to +/-3000. Uses worker
 * threads, each owning one module instance; output order matches input.
 *
 *   node tools/nnue/relabel-search.js --wasm assets/chessy-ai-fast.wasm \
 *     --nodes 2000 --workers 4 < fens.txt > labels.txt
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));
const MATE_CP = 3000;

function opt(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }

async function workerMain() {
  const engine = await WasmEngine.load(workerData.bytes);
  const out = new Array(workerData.fens.length);
  for (let i = 0; i < workerData.fens.length; i++) {
    const fen = workerData.fens[i].split(' ').length === 4 ? workerData.fens[i] + ' 0 1' : workerData.fens[i];
    let result;
    try {
      result = engine.search(fen, { maxDepth: 30, nodeLimit: workerData.nodes, timeMs: 0, quiesce: true });
    } catch (error) {
      out[i] = 'x';
      continue;
    }
    if (!result.move || result.stopReason === 'game-over') { out[i] = 'x'; continue; }
    out[i] = String(Math.max(-MATE_CP, Math.min(MATE_CP, result.score)));
  }
  parentPort.postMessage(out);
}

async function main() {
  const wasmPath = opt('wasm', path.join(ROOT, 'assets', 'chessy-ai-fast.wasm'));
  const nodes = Number(opt('nodes', 2000));
  const workers = Number(opt('workers', 4));
  const bytes = fs.readFileSync(wasmPath);
  const fens = fs.readFileSync(0, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const chunk = Math.ceil(fens.length / workers);
  const parts = await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const slice = fens.slice(w * chunk, (w + 1) * chunk);
    if (!slice.length) return resolve([]);
    const worker = new Worker(__filename, { workerData: { bytes, fens: slice, nodes } });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', code => { if (code !== 0) reject(new Error('worker exit ' + code)); });
  })));
  process.stdout.write(parts.flat().join('\n') + '\n');
}

if (isMainThread) main().catch(error => { console.error(error); process.exit(1); });
else workerMain().catch(error => { console.error(error); process.exit(1); });
