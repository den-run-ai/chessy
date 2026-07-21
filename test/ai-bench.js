/*
 * AI search benchmark — measures nodes/time over 16 positions (8 families,
 * each also mirrored/color-swapped) and optionally compares the working
 * tree against a git ref loaded in an isolated vm context.
 *
 * Usage:
 *   node test/ai-bench.js                  # candidate numbers only
 *   node test/ai-bench.js --base main      # candidate vs ref: node ratio
 *   node test/ai-bench.js --depth 5        # fixed search depth (default 5)
 *   node test/ai-bench.js --exact          # fail if move/score diverge from base
 *
 * Both engines get an identical seeded Math.random (re-seeded per position),
 * so the root shuffle — and therefore the whole search — is reproducible
 * even for engine versions without a deterministic mode.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = opt('base', null);
const DEPTH = Number(opt('depth', 5));
const EXACT = args.includes('--exact');

// 8 base positions: opening, open middlegame, closed middlegame, tactical
// middlegame, rook ending, minor-piece ending, promotion race, pawn ending.
const FAMILIES = [
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending (zugzwang)', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1']
];

// Mirror a FEN vertically and swap colors (a1<->a8, White<->Black).
function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) { return /\d/.test(c) ? c : swap(c); }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}

const POSITIONS = [];
for (const [name, fen] of FAMILIES) {
  POSITIONS.push([name, fen]);
  POSITIONS.push([name + ' (mirrored)', mirrorFen(fen)]);
}

// Seedable PRNG installed INSIDE each vm context (realm globals are not
// reachable as properties of the sandbox object from the host side).
const MK_RAND = 'function __mkRand(seed) {\n' +
  '  return function () {\n' +
  '    seed = (seed + 0x6D2B79F5) | 0;\n' +
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);\n' +
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
  '  };\n' +
  '}';

// Load engine.js + ai.js into a fresh vm context, from the working tree or
// from a git ref ("git show ref:file").
function loadEngine(ref) {
  const read = function (file) {
    if (!ref) return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // execFileSync (argv array, no shell) so a ref string can't be interpolated
    // into a shell command line.
    return cp.execFileSync('git', ['show', ref + ':' + file],
      { encoding: 'utf8', maxBuffer: 1 << 24, cwd: path.join(__dirname, '..') });
  };
  const ctx = vm.createContext({ console: console });
  vm.runInContext(MK_RAND, ctx);
  vm.runInContext(read('assets/engine.js'), ctx, { filename: 'engine.js' });
  vm.runInContext(read('assets/ai.js'), ctx, { filename: 'ai.js' });
  return ctx;
}

function bench(ctx, fen) {
  // Identical shuffle for every engine version: seed the sandbox's
  // Math.random deterministically per position.
  vm.runInContext('Math.random = __mkRand(0xC0FFEE)', ctx);
  const state = ctx.Chess.parseFen(fen);
  const t0 = Date.now();
  const r = ctx.ChessAI.think(state, { maxDepth: DEPTH, quiesce: true });
  return {
    ms: Date.now() - t0,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    cutoffs: r.cutoffs || 0,
    researches: r.researches || 0,
    depth: r.depth,
    score: r.score,
    move: r.move ? ctx.Chess.sqName(r.move.from) + ctx.Chess.sqName(r.move.to) + (r.move.promotion || '') : '-'
  };
}

const cand = loadEngine(null);
const base = BASE ? loadEngine(BASE) : null;

// Determinism self-check: two identical runs must agree exactly.
{
  const a = bench(cand, POSITIONS[3][1]);
  const b = bench(cand, POSITIONS[3][1]);
  if (a.nodes !== b.nodes || a.move !== b.move || a.score !== b.score) {
    console.error('FAIL: candidate search is not deterministic under a fixed seed');
    process.exit(1);
  }
}

let logRatioSum = 0, flagged = 0, mismatches = 0;
let totC = 0, totB = 0, msC = 0, msB = 0;
console.log('depth ' + DEPTH + (BASE ? ', base ' + BASE : '') + '\n');
for (const [name, fen] of POSITIONS) {
  const c = bench(cand, fen);
  let line = name.padEnd(34) + ' cand ' + String(c.nodes).padStart(8) +
    ' n  d' + c.depth + ' ' + String(c.score).padStart(6) + ' ' + c.move.padEnd(6);
  totC += c.nodes; msC += c.ms;
  if (base) {
    const b = bench(base, fen);
    totB += b.nodes; msB += b.ms;
    const ratio = c.nodes / b.nodes;
    logRatioSum += Math.log(ratio);
    line += ' | base ' + String(b.nodes).padStart(8) + ' n  ratio ' + ratio.toFixed(3);
    if (ratio > 1.25) { line += '  <-- >1.25x'; flagged++; }
    if (c.move !== b.move || c.score !== b.score || c.depth !== b.depth) {
      line += '  [diverges: base ' + b.move + ' ' + b.score + ' d' + b.depth + ']';
      mismatches++;
    }
  }
  console.log(line);
}
console.log('\ncandidate: ' + totC + ' nodes, ' + msC + ' ms');
if (base) {
  const geo = Math.exp(logRatioSum / POSITIONS.length);
  console.log('base:      ' + totB + ' nodes, ' + msB + ' ms');
  console.log('geometric mean node ratio (cand/base): ' + geo.toFixed(4));
  console.log('positions over 1.25x: ' + flagged + ', move/score divergences: ' + mismatches);
  if (EXACT && mismatches > 0) {
    console.error('FAIL: --exact requires identical move/score/depth on every position');
    process.exit(1);
  }
}
