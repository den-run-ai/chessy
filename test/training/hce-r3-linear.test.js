#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const H = require('./hce-r3-features');
const Baseline = require('./hce-r3-baseline');
const Linear = require('./hce-r3-linear');

require(path.join(__dirname, '..', '..', 'assets', 'engine.js'));
require(path.join(__dirname, '..', '..', 'assets', 'ai.js'));
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;
const center = Baseline.baselineCenter();
let checks = 0;

function checkPosition(fen, label) {
  const compiled = Linear.compile(fen);
  const state = Chess.parseFen(fen);
  const reconstructed = Linear.runtimeRoundedScore(compiled, center);
  const shipped = ChessAI.evaluate(state.board);
  assert.strictEqual(reconstructed, shipped,
    label + ': affine reconstruction differs from shipped r69 evaluator');
  assert.strictEqual(compiled.dense.length, 965);
  assert.strictEqual(compiled.scoreDenominator, 24);
  assert.ok(Number.isFinite(Linear.smoothScore(compiled, center)));
  assert.ok(compiled.sparse.every(function (entry, index, values) {
    return entry[0] >= 0 && entry[0] < 965 &&
      Number.isFinite(entry[1]) &&
      (index === 0 || values[index - 1][0] < entry[0]);
  }));
  checks += 5;
}

for (const fen of [
  Chess.START_FEN,
  'r3k2r/pp1n1ppp/2p1p3/8/3P4/2N2N2/PP3PPP/R3K2R w KQkq - 0 1',
  '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1',
  '8/8/8/8/8/5k2/8/6RK w - - 0 1',
  'r4rk1/ppp2ppp/2n5/2b2b2/4p3/1P1P1N2/q1PBBPPP/1R1Q1RK1 w - - 0 12'
]) {
  checkPosition(fen, fen);
}

let state = Chess.newGameState();
for (let ply = 0; ply < 120; ply++) {
  checkPosition(Chess.toFen(state), 'deterministic legal trajectory ply ' + ply);
  const moves = Chess.legalMoves(state);
  if (!moves.length) {
    state = Chess.newGameState();
    continue;
  }
  state = Chess.playMove(state, moves[(ply * 37 + 11) % moves.length]);
  if (Chess.gameStatus(state).over) state = Chess.newGameState();
}

const e4Fen =
  'r4rk1/ppp2ppp/2n5/2b2b2/4p3/1P1P1N2/q1PBBPPP/1R1Q1RK1 w - - 0 12';
const e4 = Linear.compile(e4Fen);
const attack = H.feature('pawn_attack_enemy_minor.mg');
assert.strictEqual(e4.dense[attack.id],
  H.extractWithMeta(e4Fen).dense[attack.offset] / 24);
assert.ok(e4.dense[attack.id] < 0,
  'the held-out-like ...e4 child must expose a Black pawn/minor interaction');
checks += 2;

assert.deepStrictEqual([
  Linear.pstSlot('mg', 'P', 8),
  Linear.pstSlot('mg', 'K', 63),
  Linear.pstSlot('eg', 'P', 8),
  Linear.pstSlot('eg', 'K', 63)
], [17, 384, 385, 752]);
checks++;

console.log(checks + ' HCE R3 complete-linear-form checks passed');
