#!/usr/bin/env node
/*
 * Lone-king conversion diagnostic for prototype evaluators (research only).
 *
 * The stronger side is played by the module under test against the shipped
 * base module (or itself) from textbook won endings at a fixed node budget.
 * Reports whether mate was delivered before the ply cap, the fifty-move
 * rule, or a draw claim. A net trained on quiet Lichess positions may lack
 * mop-up knowledge; this is the cheap way to find out.
 *
 *   node tools/nnue/mate-conversion.js --module /data/nets/h32.wasm \
 *     [--defender assets/chessy-ai-fast.wasm] [--nodes 36000] [--max-plies 200]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const Chess = globalThis.Chess;
const WasmEngine = require(path.join(ROOT, 'assets', 'wasm-engine.js'));

const CASES = [
  ['KQ vs K', '8/8/8/3k4/8/8/8/3QK3 w - - 0 1'],
  ['KR vs K', '8/8/8/3k4/8/8/8/R3K3 w - - 0 1'],
  ['KBB vs K', '8/8/8/3k4/8/8/8/2BBK3 w - - 0 1'],
  ['KBN vs K', '8/8/8/3k4/8/8/8/2B1KN2 w - - 0 1'],
  ['KP vs K (won)', '8/8/8/8/3k4/8/3P4/3K4 w - - 0 1'],
  ['KQ vs K (black)', '3qk3/8/8/8/3K4/8/8/8 b - - 0 1'],
  ['KR vs K (black)', 'r3k3/8/8/8/3K4/8/8/8 b - - 0 1'],
  ['KRR vs KR', '8/8/8/3k4/8/8/4r3/R2RK3 w - - 0 1'],
];

function moveName(move) { return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase(); }
function play(state, uci) {
  const move = Chess.legalMoves(state).find(m => moveName(m) === uci);
  if (!move) throw new Error('illegal move ' + uci);
  const next = Chess.applyMove(state, move);
  next.positions = { ...state.positions };
  const key = Chess.positionKey(next);
  next.positions[key] = (next.positions[key] || 0) + 1;
  return next;
}
function stateFromFen(fen) {
  return Chess.newGameState(fen);
}
function opt(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }

async function main() {
  const modulePath = opt('module');
  const defenderPath = opt('defender', path.join(ROOT, 'assets', 'chessy-ai-fast.wasm'));
  const nodes = Number(opt('nodes', 36000));
  const maxPlies = Number(opt('max-plies', 200));
  const attacker = await WasmEngine.load(fs.readFileSync(modulePath));
  const defender = await WasmEngine.load(fs.readFileSync(defenderPath));
  const rows = [];
  for (const [name, fen] of CASES) {
    let state = stateFromFen(fen);
    const strong = state.turn;
    let plies = 0;
    let status = Chess.gameStatus(state);
    const scores = [];
    while (!status.over && plies < maxPlies) {
      const engine = state.turn === strong ? attacker : defender;
      const result = engine.search(Chess.toFen(state), { maxDepth: 30, nodeLimit: nodes, timeMs: 0, quiesce: true, positions: { ...state.positions } });
      if (!result.move) break;
      if (state.turn === strong) scores.push(result.score);
      state = play(state, moveName(result.move));
      plies++;
      status = Chess.gameStatus(state);
    }
    const won = status.over && status.reason === 'checkmate';
    rows.push({ name, fen, won, plies, reason: status.over ? status.reason : 'ply-cap', firstScore: scores[0], lastScore: scores[scores.length - 1] });
    console.error(JSON.stringify(rows[rows.length - 1]));
  }
  console.log(JSON.stringify({ schema: 'chessy.nnue-proto-mate-conversion.v1', module: modulePath, defender: defenderPath, nodes, maxPlies,
    converted: rows.filter(r => r.won).length, total: rows.length, rows }, null, 1));
}

main().catch(error => { console.error(error); process.exit(1); });
