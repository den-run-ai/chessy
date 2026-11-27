#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
const requests = [
  { id: 0, op: 'info' },
  { id: 1, op: 'search', engine: 'base', fen, historyFens: [], maxDepth: 3, nodeLimit: 1000, timeMs: 0, rootSeed: 0 },
  { id: 2, op: 'search', engine: 'base', fen, historyFens: [fen], maxDepth: 3, nodeLimit: 1000, timeMs: 0, rootSeed: 0 },
  { id: 3, op: 'search', engine: 'base', fen, historyFens: [fen], maxDepth: 3, nodeLimit: 1000, timeMs: 0, rootSeed: 0 },
  { id: 4, op: 'replay', moves },
  { id: 5, op: 'replay', moves: [...moves, 'e2e4'] },
  { id: 6, op: 'replay', moves: ['e2e5'] },
  { id: 7, op: 'evaluate', engine: 'base', fen },
  { id: 8, op: 'root', engine: 'base', fen, historyFens: [fen], uci: 'e2e4', maxDepth: 2, nodeLimit: 10000, timeMs: 0, pvLen: 2 }
];
const child = spawnSync(process.execPath, [path.join(root, 'tools/eval_pipeline/host.mjs'),
  '--loader', path.join(root, 'assets/wasm-engine.js'), '--rules', path.join(root, 'assets/engine.js'),
  '--wasm', 'base=' + path.join(root, 'assets/chessy-ai-fast.wasm')], {
  input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 15000
});
assert.equal(child.status, 0, child.stderr);
const rows = child.stdout.trim().split('\n').map(JSON.parse);
assert.equal(rows.length, requests.length);
assert.deepEqual(rows.map(r => r.id), requests.map(r => r.id));
assert.equal(rows[0].result.abiVersion, 2);
assert.equal(rows[0].result.engines.base.memoryBytes, 26542080);
assert.match(rows[0].result.engines.base.sha256, /^[0-9a-f]{64}$/);
assert.equal(rows[1].ok, false);
assert.match(rows[1].error.message, /history/);
assert.equal(rows[2].ok, true);
assert.ok(rows[2].rules.legalUcis.includes(rows[2].result.uci));
assert.equal(rows[2].rules.legalUcis.length, 20);
assert.ok(rows[2].result.engineCallMs > 0);
const signature = row => { const { engineCallMs, ...result } = row.result; return result; };
assert.deepEqual(signature(rows[2]), signature(rows[3]));
assert.equal(rows[4].result.status.reason, 'threefold repetition');
assert.equal(rows[4].result.historyFens.length, moves.length + 1);
assert.equal(rows[5].ok, false);
assert.match(rows[5].error.message, /terminal/);
assert.equal(rows[6].ok, false);
assert.match(rows[6].error.message, /illegal/);
assert.equal(rows[7].result.score, 0);
assert.equal(rows[8].result.uci, 'e2e4');
assert.equal(rows[8].result.complete, true);
assert.equal(rows[8].result.pv.length, 2);
console.log('ABI-v2 persistent host: 9 protocol, history, replay, legality and exact-root contracts passed');
