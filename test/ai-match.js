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
 *   100 frozen openings x 4 deterministic seeds x both colors = 800 games.
 *   Fixed nodes per move (default 10000) with quiescence; 180-ply cap, an
 *   unfinished game is a draw (but a game decided ON the cap move is scored).
 *   Both engines get an identically seeded Math.random per game, so the whole
 *   match is reproducible.
 *
 * Shard a large match by seed (--seeds/--seedbase) and/or by opening range
 * (--openbase/--opencount) so any single shard fits the workflow timeout; the
 * aggregator (test/ai-match-agg.js) checks the shards tile the full manifest.
 *
 * Output (all machine-readable, captured into the workflow artifact):
 *   pair-scores:     the raw per-(opening, seed) pair scores;
 *   records:         one structured JSON record per pair {op, name, seed,
 *                    gseed, white, black, pair} — enough to recompute any
 *                    verdict and to concatenate disjoint shards;
 *   openings-total:  the opening-list size (aggregator cross-check);
 *   shard:           this shard's opening and seed ranges;
 *   depth-dist /     the completed-depth histogram and the fraction of moves
 *   completed-depth: returned from a depth >= 5 search (search-depth telemetry,
 *                    e.g. for calibrating the node budget);
 *   RESULT:          the opening-CLUSTER non-inferiority verdict (see
 *                    test/match-stats.js) — the 95% lower bound is over the
 *                    per-opening means, not the individual pairs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
require('../assets/engine.js'); // arbiter rules (host realm)
const Chess = globalThis.Chess;
const { clusterStats } = require('./match-stats'); // opening-cluster verdict

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
// Opening-range shard: [--openbase, --openbase + --opencount) into OPENINGS.
// Lets a high-budget match be split by OPENING (not only by seed) so a shard
// stays under the workflow timeout; the aggregator checks that the shards'
// (opening, seed) cells tile the full manifest exactly. openbase is a
// non-negative safe int (same NaN/overflow hazards as seedbase); opencount
// absent = to the end of the list.
const OPEN_BASE = (function () {
  const raw = opt('openbase', '0');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    console.error('--openbase must be a non-negative safe integer (got "' + raw + '")');
    process.exit(2);
  }
  return n;
})();
const OPEN_COUNT = args.includes('--opencount') ? posInt('opencount', 0) : Infinity;

// 100 frozen, diverse opening lines spanning the ECO range. The match plays
// each as candidate-White AND candidate-Black (paired), so opening and color
// bias cancel in the pair score. FROZEN: the order is the opening ID that the
// structured records and the cluster analysis index into — do not reorder.
const OPENINGS = [
  ['Italian', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Two Knights', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['Two Knights Fried Liver', 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5'],
  ['Ruy Lopez Morphy', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6'],
  ['Ruy Lopez Berlin', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Ruy Lopez Exchange', 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6'],
  ['Ruy Lopez Steinitz', 'e4 e5 Nf3 Nc6 Bb5 d6'],
  ['Scotch', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4'],
  ['Scotch Gambit', 'e4 e5 Nf3 Nc6 d4 exd4 Bc4'],
  ['Four Knights', 'e4 e5 Nf3 Nc6 Nc3 Nf6'],
  ['Petrov Classical', 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4'],
  ['Philidor', 'e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6'],
  ['Vienna Gambit', 'e4 e5 Nc3 Nf6 f4 d5'],
  ['Vienna Bishop', 'e4 e5 Nc3 Nf6 Bc4 Nc6'],
  ['King\'s Gambit Accepted', 'e4 e5 f4 exf4 Nf3 g5'],
  ['King\'s Gambit Declined', 'e4 e5 f4 Bc5'],
  ['Bishop\'s Opening', 'e4 e5 Bc4 Nf6 d3 c6'],
  ['Center Game', 'e4 e5 d4 exd4 Qxd4 Nc6'],
  ['Ponziani', 'e4 e5 Nf3 Nc6 c3 Nf6'],
  ['Sicilian Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Sicilian Dragon', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'],
  ['Sicilian Scheveningen', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6'],
  ['Sicilian Classical', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6'],
  ['Sicilian Taimanov', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6'],
  ['Sicilian Kan', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6'],
  ['Sicilian Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5'],
  ['Sicilian Accelerated Dragon', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6'],
  ['Sicilian Rossolimo', 'e4 c5 Nf3 Nc6 Bb5 g6'],
  ['Sicilian Moscow', 'e4 c5 Nf3 d6 Bb5 Bd7'],
  ['Sicilian Alapin', 'e4 c5 c3 Nf6 e5 Nd5'],
  ['Sicilian Alapin d5', 'e4 c5 c3 d5 exd5 Qxd5'],
  ['Sicilian Closed', 'e4 c5 Nc3 Nc6 g3 g6'],
  ['Sicilian Grand Prix', 'e4 c5 Nc3 Nc6 f4 g6'],
  ['Sicilian Smith-Morra', 'e4 c5 d4 cxd4 c3 dxc3 Nxc3'],
  ['Sicilian Kalashnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5'],
  ['Sicilian Hyperaccelerated', 'e4 c5 Nf3 g6'],
  ['French Winawer', 'e4 e6 d4 d5 Nc3 Bb4'],
  ['French Classical', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['French Tarrasch', 'e4 e6 d4 d5 Nd2 Nf6'],
  ['French Advance', 'e4 e6 d4 d5 e5 c5'],
  ['French Exchange', 'e4 e6 d4 d5 exd5 exd5'],
  ['French Rubinstein', 'e4 e6 d4 d5 Nc3 dxe4 Nxe4'],
  ['Caro-Kann Classical', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Caro-Kann Advance', 'e4 c6 d4 d5 e5 Bf5'],
  ['Caro-Kann Exchange', 'e4 c6 d4 d5 exd5 cxd5'],
  ['Caro-Kann Panov', 'e4 c6 d4 d5 exd5 cxd5 c4 Nf6'],
  ['Caro-Kann Two Knights', 'e4 c6 Nc3 d5 Nf3 Bg4'],
  ['Caro-Kann Fantasy', 'e4 c6 d4 d5 f3 e6'],
  ['Scandinavian Main', 'e4 d5 exd5 Qxd5 Nc3 Qa5'],
  ['Scandinavian Modern', 'e4 d5 exd5 Nf6'],
  ['Pirc', 'e4 d6 d4 Nf6 Nc3 g6'],
  ['Pirc Austrian', 'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7'],
  ['Modern Defense', 'e4 g6 d4 Bg7 Nc3 d6'],
  ['Alekhine', 'e4 Nf6 e5 Nd5 d4 d6'],
  ['Alekhine Exchange', 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 exd6'],
  ['Nimzowitsch Defense', 'e4 Nc6 d4 d5'],
  ['Owen Defense', 'e4 b6 d4 Bb7'],
  ['QGD Main', 'd4 d5 c4 e6 Nc3 Nf6'],
  ['QGD Exchange', 'd4 d5 c4 e6 Nc3 Nf6 cxd5 exd5'],
  ['QGD Tartakower', 'd4 d5 c4 e6 Nf3 Nf6 Nc3 Be7'],
  ['Slav', 'd4 d5 c4 c6 Nf3 Nf6'],
  ['Slav Nc3', 'd4 d5 c4 c6 Nc3 Nf6'],
  ['Semi-Slav', 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6'],
  ['QGA', 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6'],
  ['QGA Classical', 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5'],
  ['Tarrasch Defense', 'd4 d5 c4 e6 Nc3 c5'],
  ['Chigorin Defense', 'd4 d5 c4 Nc6'],
  ['Albin Counter-Gambit', 'd4 d5 c4 e5 dxe5 d4'],
  ['Nimzo-Indian', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Nimzo-Indian Rubinstein', 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O'],
  ['Queen\'s Indian', 'd4 Nf6 c4 e6 Nf3 b6'],
  ['Bogo-Indian', 'd4 Nf6 c4 e6 Nf3 Bb4'],
  ['KID Main', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['KID Classical', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O'],
  ['KID Fianchetto', 'd4 Nf6 c4 g6 Nf3 Bg7 g3 O-O'],
  ['Grunfeld', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['Grunfeld Exchange', 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3'],
  ['Benoni Modern', 'd4 Nf6 c4 c5 d5 e6'],
  ['Benko Gambit', 'd4 Nf6 c4 c5 d5 b5'],
  ['Old Benoni', 'd4 c5 d5 e5'],
  ['Dutch Stonewall', 'd4 f5 g3 Nf6 Bg2 e6'],
  ['Dutch Leningrad', 'd4 f5 g3 Nf6 Bg2 g6'],
  ['Dutch Classical', 'd4 f5 c4 Nf6 Nc3 e6'],
  ['London System', 'd4 d5 Bf4 Nf6 e3 c5'],
  ['London vs KID', 'd4 Nf6 Bf4 g6 e3 Bg7'],
  ['Torre Attack', 'd4 Nf6 Nf3 e6 Bg5 c5'],
  ['Colle System', 'd4 d5 Nf3 Nf6 e3 e6'],
  ['Catalan', 'd4 Nf6 c4 e6 g3 d5 Bg2'],
  ['Catalan Open', 'd4 Nf6 c4 e6 g3 d5 Bg2 dxc4'],
  ['Trompowsky', 'd4 Nf6 Bg5 Ne4'],
  ['Veresov', 'd4 Nf6 Nc3 d5 Bg5'],
  ['English Symmetrical', 'c4 c5 Nc3 Nc6 g3 g6'],
  ['English Four Knights', 'c4 e5 Nc3 Nf6 Nf3 Nc6'],
  ['English Anglo-Indian', 'c4 Nf6 Nc3 e6 Nf3 b6'],
  ['Reti', 'Nf3 d5 c4 e6 g3 Nf6'],
  ['Reti KIA', 'Nf3 d5 g3 Nf6 Bg2 e6'],
  ['King\'s Indian Attack', 'Nf3 Nf6 g3 g6 Bg2 Bg7'],
  ['Bird Opening', 'f4 d5 Nf3 Nf6 e3 g6'],
  ['Larsen Attack', 'b3 e5 Bb2 Nc6'],
  ['Nimzo-Larsen', 'Nf3 Nf6 b3 g6']
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

// Match an opening SAN token to its move. Trailing check/mate marks are
// stripped from both the token and the engine's canonical SAN, so a frozen
// line need not carry '+'/'#' exactly; a token that matches zero or more than
// one legal move is a fatal (ambiguous/illegal) opening definition.
function openingState(sans) {
  const strip = function (s) { return s.replace(/[+#]$/, ''); };
  let state = Chess.newGameState();
  for (const san of sans.split(' ')) {
    const legal = Chess.legalMoves(state);
    const hits = legal.filter(function (x) { return strip(Chess.toSan(state, x, legal)) === strip(san); });
    if (hits.length !== 1) {
      throw new Error('opening token "' + san + '" matched ' + hits.length + ' moves in "' + sans + '"');
    }
    state = Chess.playMove(state, hits[0]);
  }
  return state;
}

// Candidate-only search-depth telemetry, accumulated across every match move
// the candidate makes. Emitted in the artifact so a run records how deep the
// search actually reached at the chosen node budget — useful for calibrating
// that budget (a budget that only ever completes depth 2-3 exercises far less
// of the search than one reaching depth 5-6). candDepthGe5 counts moves whose
// last COMPLETED iteration reached depth >= 5.
let candMoves = 0, candDepthGe5 = 0;
const candDepths = {}; // completed-depth histogram: depth -> count

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
    if (ctx === cand) {
      candMoves++;
      const dp = r.depth || 0;
      candDepths[dp] = (candDepths[dp] || 0) + 1;
      if (dp >= 5) candDepthGe5++;
    }
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

// Fast CI guard: validate every frozen opening (legal, non-terminal, distinct)
// without loading a base ref or playing a game, then exit. Keeps the 100-line
// opening table honest on every PR.
if (args.includes('--check-openings')) {
  const seen = new Map();
  let bad = 0;
  for (let o = 0; o < OPENINGS.length; o++) {
    const name = OPENINGS[o][0], line = OPENINGS[o][1];
    try {
      const st = openingState(line);
      if (Chess.gameStatus(st).over) { console.error('FAIL ' + name + ': terminal after opening'); bad++; continue; }
      const fen4 = Chess.toFen(st).split(' ').slice(0, 4).join(' ');
      if (seen.has(fen4)) { console.error('FAIL ' + name + ': duplicate of ' + seen.get(fen4)); bad++; continue; }
      seen.set(fen4, name);
    } catch (e) { console.error('FAIL ' + name + ': ' + e.message); bad++; }
  }
  console.log(OPENINGS.length + ' openings checked, ' + bad + ' bad');
  process.exit(bad ? 1 : 0);
}

// Resolve the opening-range shard against the frozen list.
const OPEN_LO = OPEN_BASE;
const OPEN_HI = Math.min(OPENINGS.length,
  OPEN_BASE + (OPEN_COUNT === Infinity ? OPENINGS.length : OPEN_COUNT));
if (OPEN_LO >= OPENINGS.length) {
  console.error('--openbase ' + OPEN_BASE + ' is past the last opening index (' +
    (OPENINGS.length - 1) + ')');
  process.exit(2);
}

const cand = loadEngine(null);
const base = loadEngine(BASE);
assertBounded(cand, 'candidate (working tree)');
assertBounded(base, BASE);

let w = 0, d = 0, l = 0, games = 0;
const pairScores = []; // candidate score per (opening, seed) pair, in [0, 1]
const records = [];    // structured per-pair records for clustering/aggregation
const t0 = Date.now();
outer:
for (let s = SEED_BASE; s < SEED_BASE + SEEDS; s++) {
  for (let o = OPEN_LO; o < OPEN_HI; o++) {
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
    // `op` is the frozen opening index — the cluster unit. `seed` is the seed
    // slot (shard coordinate); `gseed` the derived game seed. Both game scores
    // are kept from the candidate's view so any verdict can be recomputed.
    records.push({ op: o, name: OPENINGS[o][0], seed: s, gseed: seed,
      white: asWhite, black: asBlack, pair: pair / 2 });
    process.stderr.write('\r' + games + ' games (' + OPENINGS[o][0] + ', seed ' + s + ')  ' +
      'W' + w + ' D' + d + ' L' + l + '  ' + Math.round((Date.now() - t0) / 1000) + 's   ');
  }
}
process.stderr.write('\n');

const cs = clusterStats(records);

// Completed-depth histogram and the fraction of candidate moves returned from a
// depth >= 5 search — search-depth telemetry for calibrating the node budget.
const ge5Pct = candMoves ? (100 * candDepthGe5 / candMoves) : 0;

console.log('pair-scores: ' + JSON.stringify(pairScores)); // for aggregating sharded runs
console.log('records: ' + JSON.stringify(records));        // structured, for the cluster aggregator
console.log('openings-total: ' + OPENINGS.length);         // opening-list size (aggregator cross-check)
console.log('shard: openings [' + OPEN_LO + ',' + OPEN_HI + ') seeds [' +
  SEED_BASE + ',' + (SEED_BASE + SEEDS) + ')');
console.log('depth-dist: ' + JSON.stringify(candDepths));  // completed-depth histogram (candidate moves)
console.log('completed-depth: ' + candDepthGe5 + '/' + candMoves + ' candidate moves reached depth >= 5 (' +
  ge5Pct.toFixed(1) + '%)');
console.log('candidate vs ' + BASE + ': ' + games + ' games, ' + NODES + ' nodes/move');
// The verdict is the opening-CLUSTER one-sided non-inferiority bound (mean and
// 95% lower bound over the per-opening means, NOT the raw pairs — see
// test/match-stats.js). A single --seeds 1 shard has one pair per opening, so
// its cluster bound equals the pair bound; the authoritative 800-game bound
// comes from aggregating the shards' `records:` with test/ai-match-agg.js.
if (cs.nClusters < 2) {
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    (cs.nClusters ? '  score ' + (cs.mean * 100).toFixed(1) + '%' : '') +
    '  (' + cs.nClusters + ' opening' + (cs.nClusters === 1 ? '' : 's') + ')');
  console.log('RESULT: ' + cs.verdict);
} else {
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    '  score ' + (cs.mean * 100).toFixed(2) + '%' +
    '  one-sided 95% lower bound ' + (cs.lo95 * 100).toFixed(2) + '%' +
    '  over ' + cs.nClusters + ' openings (' + cs.nPairs + ' pairs)');
  console.log('RESULT: ' + cs.verdict);
}
