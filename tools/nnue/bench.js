#!/usr/bin/env node
/*
 * Paired NPS benchmark for NNUE prototype candidates (research only).
 *
 * Searches the 18-position mirrored corpus from experiments/wasm/bench.js at
 * a fixed node budget, alternating candidate/base order, and reports the
 * median paired NPS ratio plus per-position ratios. Different evaluators
 * visit different trees, so this measures throughput (nodes per second),
 * not time-to-depth.
 *
 *   node tools/nnue/bench.js --base assets/chessy-ai-fast.wasm \
 *     --candidate /data/nets/h32.wasm [--nodes 16384] [--reps 8]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));

const FAMILIES = [
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  ['queen vs rook', '8/8/8/8/8/8/3k4/R3K3 w - - 0 1'],
];

function mirror(fen) {
  const [board, turn, castling, ep, half, full] = fen.split(' ');
  const swapped = board.split('/').reverse().map(rank => rank.split('').map(c => /[a-z]/.test(c) ? c.toUpperCase() : c.toLowerCase()).join('')).join('/');
  const castle = castling === '-' ? '-' : castling.split('').map(c => /[a-z]/.test(c) ? c.toUpperCase() : c.toLowerCase()).sort((a, b) => 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b)).join('');
  const epSquare = ep === '-' ? '-' : ep[0] + (9 - Number(ep[1]));
  return [swapped, turn === 'w' ? 'b' : 'w', castle, epSquare, half, full].join(' ');
}

function opt(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }

async function main() {
  const basePath = opt('base'), candPath = opt('candidate');
  const nodes = Number(opt('nodes', 16384)), reps = Number(opt('reps', 8));
  const baseBytes = fs.readFileSync(basePath), candBytes = fs.readFileSync(candPath);
  const engines = { base: await WasmEngine.load(baseBytes), candidate: await WasmEngine.load(candBytes) };
  const positions = FAMILIES.flatMap(([name, fen]) => [[name, fen], [name + ' (mirror)', mirror(fen)]]);
  const search = (engine, fen) => {
    const start = performance.now();
    const result = engine.search(fen, { maxDepth: 30, nodeLimit: nodes, timeMs: 0, quiesce: true });
    return { ms: performance.now() - start, nodes: result.nodes, depth: result.depth };
  };
  // Warm-up.
  for (const [, fen] of positions) { search(engines.base, fen); search(engines.candidate, fen); }
  const perPosition = [];
  const ratios = [];
  for (const [name, fen] of positions) {
    const rows = [];
    for (let rep = 0; rep < reps; rep++) {
      const order = rep % 2 === 0 ? ['candidate', 'base'] : ['base', 'candidate'];
      const got = {};
      for (const side of order) got[side] = search(engines[side], fen);
      const ratio = (got.candidate.nodes / got.candidate.ms) / (got.base.nodes / got.base.ms);
      rows.push({ rep, order: order.join('>'), candidate: got.candidate, base: got.base, npsRatio: ratio });
      ratios.push(ratio);
    }
    const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    perPosition.push({ name, fen, medianNpsRatio: median(rows.map(r => r.npsRatio)), candidateDepth: rows[0].candidate.depth, baseDepth: rows[0].base.depth });
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  console.log(JSON.stringify({
    schema: 'chessy.nnue-proto-bench.v1', nodes, reps, node: process.version,
    modules: { base: { sha256: sha(baseBytes), bytes: baseBytes.length }, candidate: { sha256: sha(candBytes), bytes: candBytes.length } },
    medianNpsRatio: median, p25: sorted[Math.floor(sorted.length * 0.25)], p75: sorted[Math.floor(sorted.length * 0.75)],
    perPosition,
  }, null, 1));
}

main().catch(error => { console.error(error); process.exit(1); });
