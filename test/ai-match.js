/*
 * AI self-play match — working-tree candidate vs a git ref, run manually or
 * via workflow_dispatch (deliberately NOT part of PR CI: a full match takes
 * minutes to hours depending on its per-move budget).
 *
 * Usage:
 *   node test/ai-match.js --formal --base HEAD~1          # formal 800-game gate
 *   node test/ai-match.js --base HEAD~1 --nodes 3000      # cheaper run
 *   node test/ai-match.js --base HEAD~1 --time 5000 --seeds 1
 *   node test/ai-match.js --base claude/ai-3-tests --pairs 20   # first N pairs
 *
 * Exactly one budget is active: fixed nodes (`--nodes`, default 10000) or
 * equal wall-clock time (`--time MS`). Supplying both is an error. Fixed-node
 * runs are diagnostic unless `--formal` explicitly requests and validates the
 * frozen gate contract. In fixed-node mode the base ref MUST honor nodeLimit.
 * Pre-nodeLimit refs would search toward depth 30 unbounded and hang the match,
 * so both engines are probed up front and the run refuses an incompatible base.
 *
 * Design (paired match):
 *   Formal fixed-node gate (`--formal`): exactly 10,000 nodes/move, 100 frozen
 *   openings x 4 deterministic seeds x both colors = 800 games, and a 180-ply
 *   cap. Other fixed-node configurations have a distinct diagnostic protocol
 *   identity. Draft equal-time diagnostic: the same openings x 1 seed x both
 *   colors = 200 games at the production 5000ms budget.
 *   Both engines get an identically seeded Math.random per game. Fixed-node
 *   results are exactly reproducible; equal-time runs preserve root variety
 *   but naturally retain scheduler/JIT timing noise. Equal-time records do not
 *   yet contain per-move timing evidence, so they are not independently
 *   auditable and cannot replace the formal fixed-node merge gate.
 *
 * Shard a large match by seed (--seeds/--seedbase) and/or by opening range
 * (--openbase/--opencount) so any single shard fits the workflow timeout; the
 * aggregator (test/ai-match-agg.js) checks the shards tile the full manifest.
 *
 * Output includes a canonical, exactly-once metadata envelope (protocol,
 * acceptance class/threshold, commits, budget, max plies, opening-manifest
 * identity, Node runtime and optional workflow run), plus:
 *   pair-scores:     the raw per-(opening, seed) pair scores;
 *   records:         one structured JSON record per pair {op, name, seed,
 *                    gseed, white, black, pair} — enough to recompute any
 *                    verdict and to concatenate disjoint shards;
 *   openings-total:  the opening-list size (aggregator cross-check);
 *   shard:           this shard's opening and seed ranges;
 *   depth-dist /     the completed-depth histogram and the fraction of moves
 *   completed-depth: returned from a depth >= 5 search (search-depth telemetry,
 *                    e.g. for calibrating either per-move budget);
 *   RESULT:          the opening-CLUSTER non-inferiority verdict for
 *                    diagnostic runs (see test/match-stats.js). Formal shards
 *                    deliberately emit no verdict; only the complete 800-game
 *                    aggregation may pass or fail the strict-strength gate.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
require('../assets/engine.js'); // arbiter rules (host realm)
const Chess = globalThis.Chess;
const { clusterStats } = require('./match-stats'); // opening-cluster verdict
const MatchProtocol = require('./ai-match-protocol');
const OPENINGS = require('./ai-match-openings');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
function flagCount(name) {
  return args.filter(function (arg) { return arg === '--' + name; }).length;
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
// Positive SAFE integer: budget/ply/seed/pair counts index integer loops, so a
// decimal (`--plies 1.1` -> 2 plies) or non-numeric value silently runs a
// different experiment than requested. A non-numeric --nodes would become
// NaN, and `ctx.nodes >= NaN` is always false — turning that budget OFF and
// letting the search run toward depth 30 unbounded. Number.isSafeInteger (not
// just isInteger) also rejects magnitudes past 2^53, where integer loops can
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
const HAS_NODES = args.includes('--nodes');
const HAS_TIME = args.includes('--time');
if (flagCount('nodes') > 1 || flagCount('time') > 1) {
  console.error('--nodes and --time may each be supplied at most once');
  process.exit(2);
}
if (HAS_NODES && HAS_TIME) {
  console.error('--nodes and --time are mutually exclusive per-move budgets');
  process.exit(2);
}
const NODES = HAS_TIME ? null : posInt('nodes', 10000);
const TIME_MS = HAS_TIME ? posInt('time', 0) : null;
const BUDGET_MODE = TIME_MS == null ? 'nodes' : 'time';
const BUDGET_VALUE = TIME_MS == null ? NODES : TIME_MS;
const BUDGET_LABEL = BUDGET_VALUE + (BUDGET_MODE === 'nodes' ? ' nodes/move' : ' ms/move');
const WORKFLOW_RUN = process.env.CHESSY_WORKFLOW_RUN || null;
if (WORKFLOW_RUN &&
    !/^https:\/\/[^\s]+\/actions\/runs\/[0-9]+$/.test(WORKFLOW_RUN)) {
  console.error('CHESSY_WORKFLOW_RUN must be a canonical Actions run URL');
  process.exit(2);
}
const MAX_PLIES = posInt('plies', 180);
const SEEDS = posInt('seeds', 4);
const FORMAL_REQUESTED = args.includes('--formal');
if (flagCount('formal') > 1) {
  console.error('--formal may be supplied at most once');
  process.exit(2);
}
let PROTOCOL;
if (FORMAL_REQUESTED) {
  PROTOCOL = MatchProtocol.PROTOCOLS.formalFixedNode;
  if (BUDGET_MODE !== PROTOCOL.budgetMode ||
      BUDGET_VALUE !== PROTOCOL.budgetValue ||
      MAX_PLIES !== PROTOCOL.maxPlies) {
    console.error('--formal requires exactly --nodes ' + PROTOCOL.budgetValue +
      ' and --plies ' + PROTOCOL.maxPlies);
    process.exit(2);
  }
} else {
  PROTOCOL = BUDGET_MODE === 'nodes'
    ? MatchProtocol.PROTOCOLS.nodeDiagnostic
    : MatchProtocol.PROTOCOLS.timeDiagnostic;
}
const PROTOCOL_ID = PROTOCOL.id;
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
// search actually reached at the chosen per-move budget — useful for
// calibrating it (a budget that only ever completes depth 2-3 exercises far less
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
    const searchOpts = {
      maxDepth: 30, quiesce: true, positions: state.positions
    };
    if (TIME_MS == null) searchOpts.nodeLimit = NODES;
    else searchOpts.timeMs = TIME_MS;
    const r = ctx.ChessAI.think(
      ctx.Chess.parseFen(Chess.toFen(state)), searchOpts);
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
// tiny node budget plus the long-standing time backstop. If it blows past the
// node budget, it doesn't support the per-move budget and the match would be
// unfair — refuse loudly.
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
    console.error('engine "' + label + '" does not honor nodeLimit (searched ' + probe.nodes +
      ' nodes for a ' + PROBE_NODES + '-node probe). Pick a ref that supports the per-move ' +
      'node budget (any ref at or after the node-budget fix, e.g. claude/ai-3-tests), not ' +
      'pre-nodeLimit main.');
    process.exit(3);
  }
}

// Equal-time fairness has the symmetric compatibility requirement: both refs
// must actually stop on timeMs. A per-VM fake clock makes the probe independent
// of host speed: call 1 starts at 1000, every later call is the exact deadline.
// maxDepth stays finite so a ref that ignores time returns and is rejected.
// Legacy main honors the deadline but predates stopReason telemetry, so an
// early abort is authoritative and a missing reason is accepted.
const PROBE_TIME_MS = 5;
const PROBE_TIME_DEPTH = 2;
const PROBE_TIME_FEN =
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
function assertTimed(ctx, label) {
  vm.runInContext(
    'globalThis.__matchRealNow = Date.now;' +
    'globalThis.__matchClockCalls = 0;' +
    'Date.now = function () {' +
    ' return globalThis.__matchClockCalls++ === 0 ? 1000 : 1005;' +
    '};', ctx);
  let probe;
  try {
    probe = ctx.ChessAI.think(ctx.Chess.parseFen(PROBE_TIME_FEN),
      { maxDepth: PROBE_TIME_DEPTH, timeMs: PROBE_TIME_MS,
        quiesce: true, randomize: false });
  } finally {
    vm.runInContext(
      'Date.now = globalThis.__matchRealNow;' +
      'delete globalThis.__matchRealNow;' +
      'delete globalThis.__matchClockCalls;', ctx);
  }
  const reasonKnown = probe && probe.stopReason != null;
  if (!probe || !Number.isInteger(probe.depth) ||
      probe.depth >= PROBE_TIME_DEPTH ||
      (reasonKnown && probe.stopReason !== 'time-limit')) {
    console.error('engine "' + label + '" does not honor/report timeMs (returned d' +
      (probe && probe.depth) + ', stopReason ' +
      JSON.stringify(probe && probe.stopReason) +
      ' for a deterministic ' + PROBE_TIME_MS + 'ms probe).');
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

function gitSha(ref, label) {
  try {
    const sha = cp.execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'],
      { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('non-canonical SHA "' + sha + '"');
    return sha;
  } catch (e) {
    console.error('cannot resolve canonical ' + label + ' SHA from "' + ref + '": ' +
      e.message);
    process.exit(2);
  }
}
const CANDIDATE_SHA = gitSha('HEAD', 'candidate');
const BASE_SHA = gitSha(BASE, 'base');
if (PROTOCOL.formal && CANDIDATE_SHA === BASE_SHA) {
  console.error('formal fixed-node gate requires distinct candidate and base commits');
  process.exit(2);
}
const cand = loadEngine(null);
const base = loadEngine(BASE);
if (TIME_MS == null) {
  assertBounded(cand, 'candidate (working tree)');
  assertBounded(base, BASE);
} else {
  assertTimed(cand, 'candidate (working tree)');
  assertTimed(base, BASE);
}

let w = 0, d = 0, l = 0, games = 0;
const pairScores = []; // candidate score per (opening, seed) pair, in [0, 1]
const records = [];    // structured per-pair records for clustering/aggregation
const t0 = Date.now();
outer:
for (let s = SEED_BASE; s < SEED_BASE + SEEDS; s++) {
  for (let o = OPEN_LO; o < OPEN_HI; o++) {
    if (pairScores.length >= PAIRS_LIMIT) break outer;
    const seed = MatchProtocol.deriveGameSeed(o, s);
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
function printVerdict(stats) {
  if (PROTOCOL.formal) {
    console.log('FORMAL SHARD: no verdict — strict-strength verdict is reserved ' +
      'for the complete 800-game aggregation');
    return;
  }
  console.log('RESULT: ' + stats.verdict);
}

// Completed-depth histogram and the fraction of candidate moves returned from a
// depth >= 5 search — search-depth telemetry for calibrating the chosen budget.
const ge5Pct = candMoves ? (100 * candDepthGe5 / candMoves) : 0;

// Canonical artifact metadata. A dirty local tree remains the caller's
// responsibility; workflow checkouts are clean and therefore identified by
// CANDIDATE_SHA exactly.
console.log('protocol-id: ' + PROTOCOL_ID);
console.log('acceptance-class: ' + PROTOCOL.acceptanceClass);
console.log('lower-bound-threshold: ' + PROTOCOL.lowerBoundThreshold);
console.log('candidate-sha: ' + CANDIDATE_SHA);
console.log('base-sha: ' + BASE_SHA);
console.log('budget-mode: ' + BUDGET_MODE);
console.log('budget-value: ' + BUDGET_VALUE);
console.log('max-plies: ' + MAX_PLIES);
console.log('openings-manifest-version: ' +
  MatchProtocol.OPENINGS_MANIFEST_VERSION);
console.log('openings-manifest-sha256: ' +
  MatchProtocol.OPENINGS_MANIFEST_SHA256);
console.log('node-runtime: ' + process.version);
if (WORKFLOW_RUN) console.log('workflow-run: ' + WORKFLOW_RUN);
console.log('pair-scores: ' + JSON.stringify(pairScores)); // for aggregating sharded runs
console.log('records: ' + JSON.stringify(records));        // structured, for the cluster aggregator
console.log('openings-total: ' + OPENINGS.length);         // opening-list size (aggregator cross-check)
console.log('shard: openings [' + OPEN_LO + ',' + OPEN_HI + ') seeds [' +
  SEED_BASE + ',' + (SEED_BASE + SEEDS) + ')');
console.log('depth-dist: ' + JSON.stringify(candDepths));  // completed-depth histogram (candidate moves)
console.log('completed-depth: ' + candDepthGe5 + '/' + candMoves + ' candidate moves reached depth >= 5 (' +
  ge5Pct.toFixed(1) + '%)');
console.log('candidate vs ' + BASE + ': ' + games + ' games, ' + BUDGET_LABEL);
// The verdict is the opening-CLUSTER one-sided non-inferiority bound (mean and
// 95% lower bound over the per-opening means, NOT the raw pairs — see
// test/match-stats.js). A single --seeds 1 shard has one pair per opening, so
// its cluster bound equals the pair bound. The authoritative formal result is
// the aggregate of all 800 fixed-node games. Equal-time aggregation remains
// diagnostic. Both are computed from all protocol shards' `records:` with
// test/ai-match-agg.js.
if (cs.nClusters < 2) {
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    (cs.nClusters ? '  score ' + (cs.mean * 100).toFixed(1) + '%' : '') +
    '  (' + cs.nClusters + ' opening' + (cs.nClusters === 1 ? '' : 's') + ')');
  printVerdict(cs);
} else {
  console.log('W ' + w + ' / D ' + d + ' / L ' + l +
    '  score ' + (cs.mean * 100).toFixed(2) + '%' +
    '  one-sided 95% lower bound ' + (cs.lo95 * 100).toFixed(2) + '%' +
    '  over ' + cs.nClusters + ' openings (' + cs.nPairs + ' pairs)');
  printVerdict(cs);
}
