#!/usr/bin/env node
/*
 * Development match runner for NNUE prototype candidates (research only).
 *
 * Plays candidate-WASM vs base-WASM through the production loader
 * (assets/wasm-engine.js) on the historical 100-opening v1 bank
 * (test/ai-match-openings.js), both colours per opening, at either an equal
 * wall-clock budget per move or a fixed node budget. The 400-endpoint v2
 * manifest is a formal holdout and is deliberately NOT used here.
 *
 *   node tools/nnue/match.js --base assets/chessy-ai-fast.wasm \
 *     --candidate /data/nets/h32.wasm --time-ms 50 --pairs 100 --workers 2 \
 *     --out /data/matches/h32-t50.json
 *   node tools/nnue/match.js ... --nodes 10000 --workers 4
 *
 * Output: per-game and per-move records plus opening-clustered statistics
 * (test/match-stats.js). These are development diagnostics: no formal
 * admission, no Elo certification.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const Chess = globalThis.Chess;
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));
const Openings = require(path.join(ROOT, 'test', 'ai-match-openings.js'));
const { clusterStats } = require(path.join(ROOT, 'test', 'match-stats.js'));

function check(ok, message) { if (!ok) throw new Error(message); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function moveName(move) { return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase(); }
function play(state, uci) {
  const move = Chess.legalMoves(state).find(m => moveName(m) === uci);
  check(move, 'illegal move ' + uci);
  const next = Chess.applyMove(state, move);
  next.positions = { ...state.positions };
  const key = Chess.positionKey(next);
  next.positions[key] = (next.positions[key] || 0) + 1;
  return next;
}
function openingPrefix(san) {
  let state = Chess.newGameState();
  const prefix = [];
  const strip = s => s.replace(/[+#]$/, '');
  for (const token of san.split(' ')) {
    const legal = Chess.legalMoves(state);
    const matches = legal.filter(move => strip(Chess.toSan(state, move, legal)) === strip(token));
    check(matches.length === 1, 'opening SAN ambiguous/illegal: ' + token);
    const uci = moveName(matches[0]);
    prefix.push(uci);
    state = play(state, uci);
  }
  return { prefix, fen: Chess.toFen(state) };
}
function replay(prefix) {
  let state = Chess.newGameState();
  for (const uci of prefix) state = play(state, uci);
  return state;
}

function playGame(task, engines, budget, maxPlies) {
  let state = replay(task.prefix);
  const moves = [];
  let plies = 0;
  while (plies < maxPlies && !Chess.gameStatus(state).over) {
    const side = state.turn === task.candidateColor ? 'candidate' : 'base';
    const fen = Chess.toFen(state);
    const requested = { maxDepth: 30, timeMs: budget.timeMs, nodeLimit: budget.nodes, quiesce: true, positions: { ...state.positions } };
    const start = performance.now();
    const result = engines[side].search(fen, requested);
    const elapsedMs = performance.now() - start;
    check(result && result.move, 'engine returned no move');
    const uci = moveName(result.move);
    moves.push({ ply: plies, side, elapsedMs: Math.round(elapsedMs * 1000) / 1000, nodes: result.nodes, depth: result.depth,
      score: result.score, stopReason: result.stopReason });
    state = play(state, uci);
    plies++;
  }
  const status = Chess.gameStatus(state);
  const result = status.over ? status.result : '1/2-1/2';
  const whitePoints = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  return { opening: task.opening, name: task.name, candidateColor: task.candidateColor, result,
    reason: status.over ? status.reason : 'ply-cap', plies, finalFen: Chess.toFen(state),
    candidateScore: task.candidateColor === 'w' ? whitePoints : 1 - whitePoints, moves };
}

async function workerMain() {
  const { baseBytes, candidateBytes, tasks, budget, maxPlies } = workerData;
  const engines = { base: await WasmEngine.load(baseBytes), candidate: await WasmEngine.load(candidateBytes) };
  for (const task of tasks) {
    const game = playGame(task, engines, budget, maxPlies);
    parentPort.postMessage({ type: 'game', game });
  }
  parentPort.postMessage({ type: 'done' });
}

function parseArgs(argv) {
  const out = { pairs: 0, workers: 2, maxPlies: 180, timeMs: 0, nodes: 0, out: null, label: null, openings: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    check(value !== undefined, 'missing value for --' + key);
    if (key === 'base' || key === 'candidate' || key === 'out' || key === 'label' || key === 'openings') out[key] = value;
    else if (key === 'time-ms') out.timeMs = Number(value);
    else if (key === 'nodes') out.nodes = Number(value);
    else if (key === 'pairs') out.pairs = Number(value);
    else if (key === 'workers') out.workers = Number(value);
    else if (key === 'max-plies') out.maxPlies = Number(value);
    else throw new Error('unknown option --' + key);
  }
  check(out.base && out.candidate, '--base and --candidate are required');
  check((out.timeMs > 0) !== (out.nodes > 0), 'exactly one of --time-ms / --nodes');
  return out;
}

function summarize(games, budget) {
  const byOpening = new Map();
  let wins = 0, draws = 0, losses = 0;
  const side = { candidate: { ms: 0, nodes: 0, depth: 0, moves: 0 }, base: { ms: 0, nodes: 0, depth: 0, moves: 0 } };
  const reasons = {};
  for (const game of games) {
    if (game.candidateScore === 1) wins++; else if (game.candidateScore === 0) losses++; else draws++;
    reasons[game.reason] = (reasons[game.reason] || 0) + 1;
    if (!byOpening.has(game.opening)) byOpening.set(game.opening, []);
    byOpening.get(game.opening).push(game.candidateScore);
    for (const move of game.moves) {
      const s = side[move.side];
      s.ms += move.elapsedMs; s.nodes += move.nodes; s.depth += move.depth; s.moves++;
    }
  }
  const records = [...byOpening.entries()].map(([op, scores]) => ({ op, pair: scores.reduce((a, b) => a + b, 0) / scores.length }));
  const stats = clusterStats(records);
  const means = records.map(r => r.pair);
  const n = means.length;
  const mean = means.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const t = n - 1 <= 30 ? [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042][n - 2] || 12.706 : 1.96 + 2.4 / (n - 1);
  const elo = p => (p <= 0 || p >= 1) ? null : Math.round(-400 * Math.log10(1 / p - 1) * 10) / 10;
  const timing = {};
  for (const key of ['candidate', 'base']) {
    const s = side[key];
    timing[key] = { moves: s.moves, meanMs: s.ms / s.moves, meanNodes: s.nodes / s.moves, meanDepth: s.depth / s.moves,
      nps: s.nodes / (s.ms / 1000) };
  }
  return {
    games: games.length, openings: n, wins, draws, losses, score: (wins + 0.5 * draws) / games.length,
    openingClustered: { mean, sd, se, ci95: [mean - t * se, mean + t * se], oneSidedLower95: stats.lower, clusterStats: stats },
    eloEstimate: { point: elo(mean), ci95: [elo(mean - t * se), elo(mean + t * se)] },
    reasons, timing, npsRatio: timing.candidate.nps / timing.base.nps, budget,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseBytes = fs.readFileSync(args.base);
  const candidateBytes = fs.readFileSync(args.candidate);
  const budget = { timeMs: args.timeMs, nodes: args.nodes };
  const tasks = [];
  let bank;
  if (args.openings) {
    const manifest = JSON.parse(fs.readFileSync(args.openings, 'utf8'));
    check(manifest.schema === 'chessy.nnue-proto-dev-openings.v1', 'unexpected opening bank schema');
    bank = { path: path.resolve(args.openings), sha256: sha(fs.readFileSync(args.openings)), schema: manifest.schema,
      note: 'development-only bank generated by tools/nnue/gen-dev-openings.py; disjoint from the frozen quarantine boundary' };
    const entries = args.pairs ? manifest.openings.slice(0, args.pairs) : manifest.openings;
    entries.forEach(entry => {
      const state = replay(entry.uci);
      check(Chess.toFen(state) === entry.fen, 'dev opening replay mismatch at index ' + entry.index);
      for (const candidateColor of ['w', 'b']) tasks.push({ opening: entry.index, name: entry.name, prefix: entry.uci, candidateColor });
    });
  } else {
    const entries = args.pairs ? Openings.slice(0, args.pairs) : Openings;
    bank = { path: 'test/ai-match-openings.js', note: 'historical exposed v1 bank; the v2 formal holdout is not used' };
    entries.forEach(([name, san], index) => {
      const { prefix } = openingPrefix(san);
      for (const candidateColor of ['w', 'b']) tasks.push({ opening: index, name, prefix, candidateColor });
    });
  }
  bank.pairs = tasks.length / 2;
  // Interleave so each worker sees both colours of each opening in sequence.
  const buckets = Array.from({ length: args.workers }, () => []);
  tasks.forEach((task, index) => buckets[Math.floor(index / 2) % args.workers].push(task));
  const started = Date.now();
  const games = [];
  await Promise.all(buckets.filter(b => b.length).map(bucket => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { baseBytes, candidateBytes, tasks: bucket, budget, maxPlies: args.maxPlies } });
    worker.on('message', message => {
      if (message.type === 'game') {
        games.push(message.game);
        if (games.length % 20 === 0) console.error(JSON.stringify({ stage: 'progress', games: games.length, of: tasks.length, elapsedS: Math.round((Date.now() - started) / 1000) }));
      } else if (message.type === 'done') resolve();
    });
    worker.on('error', reject);
    worker.on('exit', code => { if (code !== 0) reject(new Error('worker exit ' + code)); });
  })));
  games.sort((a, b) => a.opening - b.opening || (a.candidateColor === 'w' ? -1 : 1));
  const summary = summarize(games, budget);
  const output = {
    schema: 'chessy.nnue-proto-match.v1', label: args.label, researchOnly: true, formalPass: false,
    modules: { base: { path: path.resolve(args.base), sha256: sha(baseBytes), bytes: baseBytes.length },
      candidate: { path: path.resolve(args.candidate), sha256: sha(candidateBytes), bytes: candidateBytes.length } },
    openingBank: bank,
    protocol: { budget, maxPlies: args.maxPlies, workers: args.workers, quiesce: true, maxDepth: 30, node: process.version, cpus: os.cpus().length },
    startedAtUtc: new Date(started).toISOString(), elapsedSeconds: (Date.now() - started) / 1000,
    summary, games,
  };
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(output));
  }
  const { games: _g, ...rest } = output;
  console.log(JSON.stringify({ ...rest, summary: { ...summary, timing: summary.timing } }, null, 1));
}

if (isMainThread) main().catch(error => { console.error(error); process.exit(1); });
else workerMain().catch(error => { console.error(error); process.exit(1); });
