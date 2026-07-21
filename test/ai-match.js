/*
 * AI self-play match — working-tree candidate vs a git ref, run manually or
 * via workflow_dispatch (deliberately NOT part of PR CI: a full match takes
 * minutes to hours depending on --nodes).
 *
 * Usage:
 *   node test/ai-match.js --base claude/ai-3-tests        # full 200-game match
 *   node test/ai-match.js --base HEAD~1 --nodes 3000      # cheaper run
 *   node test/ai-match.js --base claude/ai-3-tests --pairs 20   # first N pairs
 *
 * The base ref MUST honor the per-move node budget (nodeLimit). Pre-nodeLimit
 * refs (e.g. an old origin/main) would search toward depth 30 unbounded and
 * hang the match, so both engines are probed up front and the run refuses a
 * base that ignores the budget. The 'origin/main' default is kept only as a
 * convenience for when main itself carries the budget; otherwise pass an
 * explicit ref at or after the node-budget fix.
 *
 * Design (paired match):
 *   25 balanced openings x 4 deterministic seeds x both colors = 200 games.
 *   Fixed nodes per move (default 10000) with quiescence; 180-ply cap, an
 *   unfinished game is a draw (but a game decided ON the cap move is scored).
 *   Both engines get an identically seeded Math.random per game, so the whole
 *   match is reproducible. Reported: W/D/L, score, and a paired 95% confidence
 *   interval over the (opening, seed) pairs — if it crosses 50%, inconclusive.
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
// An explicit `--base` with no value (or an empty string) makes opt() return
// undefined/'' — which loadEngine treats as the working tree, silently playing
// the candidate against itself and emitting a plausible but meaningless result.
// Require a non-empty ref (the default 'origin/main' only applies when --base
// is absent entirely).
if (!BASE) {
  console.error('--base requires a non-empty git ref');
  process.exit(2);
}
// Positive SAFE integer: node/ply/seed/pair counts index integer loops, so a
// decimal (`--plies 1.1` -> 2 plies) or non-numeric value silently runs a
// different experiment than requested. A non-numeric --nodes would become NaN,
// and `ctx.nodes >= NaN` is always false — turning the per-move budget OFF and
// letting the search run toward depth 30 unbounded. Number.isSafeInteger (not
// just isInteger) also rejects magnitudes past 2^53, where `n++` in a loop can
// stop advancing (float rounding) and spin forever.
function posInt(name, dflt) {
  const raw = opt(name, String(dflt));
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.error('--' + name + ' must be a positive safe integer (got "' + raw + '")');
    process.exit(2);
  }
  return n;
}
const NODES = posInt('nodes', 10000);
const MAX_PLIES = posInt('plies', 180);
const SEEDS = posInt('seeds', 4);
// Seed base (shard offset): a safe integer >= 0. A typo like `--seedbase nope`
// becomes NaN, making the seed loop `s < NaN + SEEDS` false from the start —
// exiting successfully with an empty, inconclusive result and silently
// dropping the shard. A value beyond 2^53 would make the loop counter's `s++`
// stop advancing and run the match forever, hence isSafeInteger.
const SEED_BASE = (function () {
  const raw = opt('seedbase', '0');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    console.error('--seedbase must be a non-negative safe integer (got "' + raw + '")');
    process.exit(2);
  }
  return n;
})();
// The seed loop runs `for (s = SEED_BASE; s < SEED_BASE + SEEDS; s++)`: even
// with both operands safe, their SUM (the loop bound, against which `s++` is
// compared) must also stay safe, or the final increments lose precision and
// the loop never terminates.
if (!Number.isSafeInteger(SEED_BASE + SEEDS)) {
  console.error('--seedbase + --seeds must stay within the safe-integer range (got ' +
    SEED_BASE + ' + ' + SEEDS + ')');
  process.exit(2);
}
// Pair limit: absent = whole match (Infinity); present must be a positive
// safe integer. `--pairs nope` would otherwise become NaN, making the limit
// check permanently false and running the full match unexpectedly.
const PAIRS_LIMIT = args.includes('--pairs') ? posInt('pairs', 0) : Infinity;

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
    // execFileSync (argv array, no shell) so a ref with shell metacharacters
    // can't be interpolated into a command line.
    return cp.execFileSync('git', ['show', ref + ':' + file],
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

// Candidate-only LMR activity, accumulated across every match game (the base
// ref predates LMR and reports no counters). Emitted in the artifact so a
// verdict records how much the reductions actually fired.
let candLmr = 0, candLmrRe = 0;

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
    // `cand` is the working-tree engine (assigned below, before any game runs).
    if (ctx === cand) { candLmr += r.lmr || 0; candLmrRe += r.lmrRe || 0; }
    const legal = Chess.legalMoves(state);
    const local = r.move && legal.find(function (m) {
      return m.from === r.move.from && m.to === r.move.to && m.promotion === r.move.promotion;
    });
    if (!local) throw new Error('engine returned no legal move at ' + Chess.toFen(state));
    state = Chess.playMove(state, local);
    plies++;
  }
  // The last move at the ply cap may itself be checkmate/stalemate/50-move —
  // score the final position rather than blindly calling a decided game a draw.
  const finalStatus = Chess.gameStatus(state);
  if (finalStatus.over) {
    return finalStatus.result === '1-0' ? 1 : finalStatus.result === '0-1' ? 0 : 0.5;
  }
  return 0.5; // genuinely unfinished games are draws
}

// A base engine that ignores nodeLimit would search toward depth 30 with no
// bound, so every move would hang the match. Probe it BEFORE playing: give a
// tiny node budget plus a time backstop (all engine versions honor timeMs, so
// this can't hang); if it blows past the node budget, it doesn't support the
// per-move budget and the match would be unfair — refuse loudly.
const PROBE_NODES = 3000;
function assertBounded(ctx, label) {
  const probe = ctx.ChessAI.think(ctx.Chess.parseFen(Chess.START_FEN),
    { maxDepth: 30, nodeLimit: PROBE_NODES, timeMs: 5000, quiesce: true, randomize: false });
  // A compliant engine evaluates AT MOST the requested budget (the node-budget
  // fix makes it exactly nodeLimit). Allow only a 1-node slack for an older
  // ref's documented off-by-one; anything beyond that means the ref enforces
  // the budget late or at a multiple of the request, so every match move would
  // give it materially more computation than its opponent — an unfair,
  // invalid fixed-node result.
  if (probe.nodes > PROBE_NODES + 1) {
    console.error('base "' + label + '" does not honor nodeLimit (searched ' + probe.nodes +
      ' nodes for a ' + PROBE_NODES + '-node probe). Pick a ref that supports the per-move ' +
      'node budget (any ref at or after the node-budget fix, e.g. claude/ai-3-tests), not ' +
      'pre-nodeLimit main.');
    process.exit(3);
  }
}

const cand = loadEngine(null);
const base = loadEngine(BASE);
assertBounded(cand, 'candidate (working tree)');
assertBounded(base, BASE);

let w = 0, d = 0, l = 0, games = 0;
const pairScores = []; // candidate score per (opening, seed) pair, in [0, 1]
const t0 = Date.now();
outer:
for (let s = SEED_BASE; s < SEED_BASE + SEEDS; s++) {
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

// 95% two-sided Student's t critical value by degrees of freedom.
function tCrit95(df) {
  const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df <= 0) return Infinity;
  return df <= 30 ? T[df - 1] : 1.96 + 2.4 / df;
}

const n = pairScores.length;
const mean = n ? pairScores.reduce(function (a, b) { return a + b; }, 0) / n : NaN;

console.log('pair-scores: ' + JSON.stringify(pairScores)); // for aggregating sharded runs
console.log('lmr-activity: reductions ' + candLmr + ', researches ' + candLmrRe + ' (candidate only)');
console.log('candidate vs ' + BASE + ': ' + games + ' games, ' + NODES + ' nodes/move');
// A paired CI needs the sample variance, which is undefined for n < 2 (the
// n-1 denominator is 0). Report the raw score but no interval/verdict rather
// than printing a NaN CB.
if (n < 2) {
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    (n ? '  score ' + (mean * 100).toFixed(1) + '%' : '') +
    '  (' + n + ' pair' + (n === 1 ? '' : 's') + ' — too few for a confidence interval)');
  console.log('RESULT: inconclusive (need at least 2 pairs for a CI)');
} else {
  let sd = Math.sqrt(pairScores.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1));
  // A zero sample variance (every observed pair scored identically) does NOT
  // prove the true per-pair variance is zero — with few pairs it is a common
  // artifact, e.g. two swept pairs occur 6.25% of the time under a fair,
  // independent-game null, yet would otherwise print a [100%, 100%] interval
  // and declare the candidate stronger. Treating the estimate as known-zero is
  // false certainty. Fall back to the LARGEST standard deviation a [0,1]-
  // bounded pair score can have (0.5, attained by a 0/1 split), so the
  // interval reflects genuine small-sample uncertainty; a real, sustained
  // sweep still narrows the CI as n grows and can reach significance honestly.
  if (sd === 0) sd = 0.5;
  // The standard deviation is ESTIMATED from these same n pairs, so a small
  // match needs Student's t, not the normal 1.96 — otherwise the interval is
  // too narrow and a borderline candidate can be wrongly called stronger. df
  // = n-1; the table is exact for df<=30 and the approximation 1.96 + 2.4/df
  // is within ~0.001 of the true 95% two-sided value for df>30 (df=99 ->
  // 1.984, df=∞ -> 1.96).
  const half = tCrit95(n - 1) * sd / Math.sqrt(n);
  // Clamp the reported bounds to the [0,1] a score can occupy (the verdict
  // comparisons below are unaffected: clamping never crosses 0.5).
  const lo = Math.max(0, mean - half), hi = Math.min(1, mean + half);
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    '  score ' + (mean * 100).toFixed(1) + '%' +
    '  95% CI [' + (lo * 100).toFixed(1) + '%, ' + (hi * 100).toFixed(1) + '%] over ' + n + ' pairs');
  console.log(lo > 0.5 ? 'RESULT: candidate is stronger (CI above 50%)'
    : hi < 0.5 ? 'RESULT: candidate is weaker (CI below 50%)'
    : 'RESULT: inconclusive (CI crosses 50%)');
}
