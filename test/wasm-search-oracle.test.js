/*
 * Independent shallow-search and budget-boundary checks.
 *
 * The oracle uses the JavaScript rules engine for legal moves, make/undo-free
 * board copies, draws and terminal positions. Only static leaf evaluation is
 * delegated to a separate WASM instance. It has no transposition table, PVS,
 * aspiration windows or search heuristics, so matching results exercise the
 * Rust rules/search boundary rather than repeating its implementation.
 *
 * Quiescence is disabled for the exact-score differential. Its budget boundary
 * is checked separately. This is a correctness gate, not strength evidence or
 * a new signature baseline; no held-out evaluation data is used.
 */
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const Wasm = require('../assets/wasm-engine.js');
const bench = require('../experiments/wasm/bench.js');
const bytes = fs.readFileSync(path.join(__dirname, '../assets/chessy-ai-fast.wasm'));
const engine = Wasm.loadSync(bytes);
const leaf = Wasm.loadSync(bytes);
const MATE = 1000000;
const INF = 2000000;
let checks = 0;

function check(label, run) {
  run();
  checks++;
  console.log('  ok  ' + label);
}

function uci(move) {
  return move && Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion || '');
}

// Every differential search is at most three plies. A fresh position cannot
// repeat within that horizon; the loaded-history contract is tested below.
function oracle(state, depth, ply = 0, alpha = -INF, beta = INF) {
  const moves = Chess.legalMoves(state);
  if (!moves.length) {
    return Chess.inCheck(state, state.turn)
      ? (state.turn === 'w' ? -1 : 1) * (MATE - ply) : 0;
  }
  if (state.halfmove >= 100 || Chess.insufficientMaterial(state.board)) return 0;
  if (depth === 0) return leaf.evaluate(Chess.toFen(state));
  const maximizing = state.turn === 'w';
  let best = maximizing ? -INF : INF;
  for (const move of moves) {
    const score = oracle(Chess.applyMove(state, move), depth - 1, ply + 1, alpha, beta);
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (alpha >= beta) break;
  }
  return best;
}

const specials = [
  ['checked fifty-move draw', 'k7/8/8/8/8/8/R7/K7 b - - 100 1'],
  ['mate precedes fifty-move draw', 'k7/1Q6/2K5/8/8/8/8/8 b - - 100 1'],
  ['stalemate', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'],
  ['pinned en passant', '4k3/8/8/r4pPK/8/8/8/8 w - f6 0 1'],
  ['legal en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'],
  ['underpromotion avoids stalemate', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1'],
  ['bare kings', '7k/8/6K1/8/8/8/8/8 w - - 0 1']
];
const positions = bench.POSITIONS.map(item => item.slice()).concat(specials);
let state = Chess.newGameState();
let seed = 123456789;
for (let ply = 1; ply <= 64; ply++) {
  assert.equal(Chess.gameStatus(state).over, false, 'seeded walk ended before its declared coverage');
  const moves = Chess.legalMoves(state);
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  state = Chess.playMove(state, moves[seed % moves.length]);
  if (ply % 4 === 0) positions.push(['seeded legal walk ply ' + ply, Chess.toFen(state)]);
}
assert.equal(positions.length, 41, 'do not silently reduce differential coverage');

for (const [name, fen] of positions) {
  for (const depth of [0, 1, 2, 3]) {
    check(name + ' · exact depth ' + depth, function () {
      const expected = oracle(Chess.parseFen(fen), depth);
      const result = engine.fixedSearch(fen, { depth, nodeLimit: 0, quiesce: false });
      assert.equal(result.complete, true);
      assert.equal(result.depth, depth);
      assert.equal(result.score, expected, fen);
    });
  }
}

// Force every legal root on special-move positions. This checks move packing,
// promotion identity, ply-relative mate distances and the shared TT against
// the independent rules oracle, including roots that ordinary Play would skip.
for (const [name, fen] of [bench.POSITIONS[6], ...specials.slice(3, 6)]) {
  check(name + ' · every exact root agrees and PV replays legally', function () {
    const root = Chess.parseFen(fen);
    const legal = Chess.legalMoves(root);
    assert.ok(legal.length > 0);
    engine.beginAnalysis(fen, { nodeLimit: 0, quiesce: false });
    let previousNodes = 0;
    for (const move of legal) {
      const expected = oracle(Chess.applyMove(root, move), 2, 1);
      const result = engine.searchRoot(move, 3, 3);
      assert.equal(result.complete, true, uci(move));
      assert.equal(result.score, expected, name + ' ' + uci(move));
      assert.equal(result.depth, 3);
      assert.ok(result.nodes > previousNodes, 'exact roots must share cumulative counters');
      previousNodes = result.nodes;
      assert.equal(uci(result.move), uci(move));
      assert.equal(uci(result.pv[0]), uci(move));
      let replay = root;
      for (const step of result.pv) {
        const matched = Chess.legalMoves(replay).find(candidate => uci(candidate) === uci(step));
        assert.ok(matched, 'illegal PV move ' + uci(step));
        replay = Chess.applyMove(replay, matched);
      }
    }
  });
}

for (const quiesce of [false, true]) {
  check('fixed-search exact budget boundary · quiescence ' + quiesce, function () {
    const opts = { depth: 2, nodeLimit: 0, quiesce };
    const full = engine.fixedSearch(Chess.START_FEN, opts);
    assert.ok(full.complete && full.nodes > 1);
    const exact = engine.fixedSearch(Chess.START_FEN, { ...opts, nodeLimit: full.nodes });
    assert.deepEqual(exact, full, 'the final allowed node must be searchable');
    const short = engine.fixedSearch(Chess.START_FEN, { ...opts, nodeLimit: full.nodes - 1 });
    assert.equal(short.complete, false, 'an unfinished search must not be certified');
    assert.equal(short.nodes, full.nodes - 1);
    assert.equal(short.depth, 0);
    assert.equal(short.attemptedDepth, 2);
    assert.equal(short.stopReason, 'node-limit');
  });

  check('Play keeps the completed iteration on budget exhaustion · quiescence ' + quiesce, function () {
    const opts = { maxDepth: 2, nodeLimit: 0, timeMs: 0, quiesce };
    const shallow = engine.search(Chess.START_FEN, { ...opts, maxDepth: 1 });
    const full = engine.search(Chess.START_FEN, opts);
    const exact = engine.search(Chess.START_FEN, { ...opts, nodeLimit: full.nodes });
    assert.deepEqual(exact, full);
    const short = engine.search(Chess.START_FEN, { ...opts, nodeLimit: full.nodes - 1 });
    assert.equal(short.nodes, full.nodes - 1);
    assert.equal(short.depth, 1);
    assert.equal(short.attemptedDepth, 2);
    assert.equal(short.stopReason, 'node-limit');
    assert.equal(short.score, shallow.score);
    assert.equal(uci(short.move), uci(shallow.move));
  });
}

check('exact-root budget exhaustion stays shared and exposes no partial PV', function () {
  const legal = Chess.legalMoves(Chess.parseFen(Chess.START_FEN));
  engine.beginAnalysis(Chess.START_FEN, { nodeLimit: 1, quiesce: true });
  for (const move of legal.slice(0, 2)) {
    const result = engine.searchRoot(move, 3, 3);
    assert.equal(result.complete, false);
    assert.equal(result.nodes, 1);
    assert.equal(result.depth, 0);
    assert.equal(result.attemptedDepth, 3);
    assert.equal(result.stopReason, 'node-limit');
    assert.deepEqual(result.pv, []);
  }
  engine.beginAnalysis(Chess.START_FEN, { nodeLimit: 0, quiesce: false });
  const result = engine.searchRoot(legal[0], 3, 3);
  assert.equal(result.complete, true, 'a fresh phase must recover after an exhausted phase');
  assert.equal(result.score, oracle(Chess.applyMove(Chess.parseFen(Chess.START_FEN), legal[0]), 2, 1));
});

check('loaded history distinguishes the second occurrence from completed threefold', function () {
  const fen = 'k7/8/8/8/8/8/4R3/4K3 w - - 4 1';
  const root = Chess.newGameState(fen);
  const key = Chess.positionKey(root);
  const second = engine.fixedSearch(fen, { depth: 0, nodeLimit: 0, quiesce: false, positions: { [key]: 2 } });
  assert.equal(second.complete, true);
  assert.equal(second.score, leaf.evaluate(fen));
  assert.notEqual(second.score, 0);
  const third = engine.fixedSearch(fen, { depth: 0, nodeLimit: 0, quiesce: false, positions: { [key]: 3 } });
  assert.equal(third.complete, true);
  assert.equal(third.score, 0);
  assert.equal(third.stopReason, 'game-over');

  const move = Chess.legalMoves(root)[0];
  const child = Chess.applyMove(root, move);
  const childKey = Chess.positionKey(child);
  engine.beginAnalysis(fen, { nodeLimit: 0, quiesce: false, positions: { [key]: 1, [childKey]: 2 } });
  const repeated = engine.searchRoot(move, 3, 3);
  assert.equal(repeated.complete, true);
  assert.equal(repeated.score, 0);
  assert.deepEqual(repeated.pv.map(uci), [uci(move)]);
});

console.log(checks + ' passed, 0 failed');
