/*
 * AI self-play match — working-tree candidate vs a git ref, run manually or
 * via workflow_dispatch (deliberately NOT part of PR CI: a full match takes
 * minutes to hours depending on --nodes).
 *
 * Usage:
 *   node test/ai-match.js --base origin/main            # full 200-game match
 *   node test/ai-match.js --base HEAD~1 --nodes 3000    # cheaper run
 *   node test/ai-match.js --base main --pairs 20        # first N (opening,seed) pairs
 *
 * Design (paired match):
 *   25 balanced openings x 4 deterministic seeds x both colors = 200 games.
 *   Fixed nodes per move (default 10000) with quiescence; 180-ply cap, an
 *   unfinished game is a draw. Both engines get an identically seeded
 *   Math.random per game, so the whole match is reproducible.
 *   Reported: W/D/L, score, and a paired 95% confidence interval over the
 *   (opening, seed) pairs — if it crosses 50%, the result is inconclusive.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
require('../assets/engine.js'); // arbiter rules (host realm)
const Chess = globalThis.Chess;

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = opt('base', 'origin/main');
const NODES = Number(opt('nodes', 10000));
const MAX_PLIES = Number(opt('plies', 180));
const SEEDS = Number(opt('seeds', 4));
const PAIRS_LIMIT = Number(opt('pairs', Infinity));

// 25 balanced openings as SAN lines from the start position.
const OPENINGS = [
  ['Italian', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Ruy Lopez', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6'],
  ['Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Taimanov', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6'],
  ['French', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['Caro-Kann', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Scandinavian', 'e4 d5 exd5 Qxd5 Nc3 Qa5'],
  ['Pirc', 'e4 d6 d4 Nf6 Nc3 g6'],
  ['Alekhine', 'e4 Nf6 e5 Nd5 d4 d6'],
  ['Scotch', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4'],
  ['Petrov', 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4'],
  ['Vienna', 'e4 e5 Nc3 Nf6 f4 d5'],
  ['QGD', 'd4 d5 c4 e6 Nc3 Nf6'],
  ['Slav', 'd4 d5 c4 c6 Nf3 Nf6'],
  ['QGA', 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6'],
  ['Nimzo-Indian', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Queens Indian', 'd4 Nf6 c4 e6 Nf3 b6'],
  ['KID', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['Grunfeld', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['Benoni', 'd4 Nf6 c4 c5 d5 e6'],
  ['Dutch', 'd4 f5 g3 Nf6 Bg2 e6'],
  ['London', 'd4 d5 Bf4 Nf6 e3 c5'],
  ['Catalan', 'd4 Nf6 c4 e6 g3 d5 Bg2'],
  ['English', 'c4 e5 Nc3 Nf6 Nf3 Nc6'],
  ['Reti', 'Nf3 d5 c4 e6 g3 Nf6']
];

const MK_RAND = 'function __mkRand(seed) {\n' +
  '  return function () {\n' +
  '    seed = (seed + 0x6D2B79F5) | 0;\n' +
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);\n' +
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
  '  };\n' +
  '}';

function loadEngine(ref) {
  const read = function (file) {
    if (!ref) return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    return cp.execSync('git show ' + ref + ':' + file,
      { encoding: 'utf8', maxBuffer: 1 << 24, cwd: path.join(__dirname, '..') });
  };
  const ctx = vm.createContext({ console: console });
  vm.runInContext(MK_RAND, ctx);
  vm.runInContext(read('assets/engine.js'), ctx, { filename: 'engine.js' });
  vm.runInContext(read('assets/ai.js'), ctx, { filename: 'ai.js' });
  return ctx;
}

function openingState(sans) {
  let state = Chess.newGameState();
  for (const san of sans.split(' ')) {
    const legal = Chess.legalMoves(state);
    const m = legal.find(function (x) { return Chess.toSan(state, x, legal) === san; });
    if (!m) throw new Error('bad opening SAN: ' + san + ' in "' + sans + '"');
    state = Chess.playMove(state, m);
  }
  return state;
}

// One game: engines[0] plays White. Returns 1 / 0.5 / 0 from White's view.
function playGame(engines, sans, seed) {
  for (const ctx of engines) vm.runInContext('Math.random = __mkRand(' + seed + ')', ctx);
  let state = openingState(sans);
  let plies = 0;
  while (plies < MAX_PLIES) {
    const status = Chess.gameStatus(state);
    if (status.over) {
      return status.result === '1-0' ? 1 : status.result === '0-1' ? 0 : 0.5;
    }
    const ctx = engines[state.turn === 'w' ? 0 : 1];
    const r = ctx.ChessAI.think(ctx.Chess.parseFen(Chess.toFen(state)), {
      maxDepth: 30, nodeLimit: NODES, quiesce: true, positions: state.positions
    });
    const legal = Chess.legalMoves(state);
    const local = r.move && legal.find(function (m) {
      return m.from === r.move.from && m.to === r.move.to && m.promotion === r.move.promotion;
    });
    if (!local) throw new Error('engine returned no legal move at ' + Chess.toFen(state));
    state = Chess.playMove(state, local);
    plies++;
  }
  return 0.5; // unfinished games are draws
}

const cand = loadEngine(null);
const base = loadEngine(BASE);

let w = 0, d = 0, l = 0, games = 0;
const pairScores = []; // candidate score per (opening, seed) pair, in [0, 1]
const t0 = Date.now();
outer:
for (let s = 0; s < SEEDS; s++) {
  for (let o = 0; o < OPENINGS.length; o++) {
    if (pairScores.length >= PAIRS_LIMIT) break outer;
    const seed = (o * 977 + s * 7919 + 1) | 0;
    let pair = 0;
    // candidate as White, then colors swapped — same opening, same seed.
    const asWhite = playGame([cand, base], OPENINGS[o][1], seed);
    const asBlack = 1 - playGame([base, cand], OPENINGS[o][1], seed);
    for (const sc of [asWhite, asBlack]) {
      games++;
      if (sc === 1) w++; else if (sc === 0) l++; else d++;
      pair += sc;
    }
    pairScores.push(pair / 2);
    process.stderr.write('\r' + games + ' games (' + OPENINGS[o][0] + ', seed ' + s + ')  ' +
      'W' + w + ' D' + d + ' L' + l + '  ' + Math.round((Date.now() - t0) / 1000) + 's   ');
  }
}
process.stderr.write('\n');

const n = pairScores.length;
const mean = pairScores.reduce(function (a, b) { return a + b; }, 0) / n;
const sd = Math.sqrt(pairScores.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1));
const half = 1.96 * sd / Math.sqrt(n);
const lo = mean - half, hi = mean + half;

console.log('candidate vs ' + BASE + ': ' + games + ' games, ' + NODES + ' nodes/move');
console.log('W ' + w + ' / D ' + d + ' / L ' + l +
  '  score ' + (mean * 100).toFixed(1) + '%' +
  '  95% CI [' + (lo * 100).toFixed(1) + '%, ' + (hi * 100).toFixed(1) + '%] over ' + n + ' pairs');
console.log(lo > 0.5 ? 'RESULT: candidate is stronger (CI above 50%)'
  : hi < 0.5 ? 'RESULT: candidate is weaker (CI below 50%)'
  : 'RESULT: inconclusive (CI crosses 50%)');
