#!/usr/bin/env node
/*
 * Pure-function contract for the exploratory level-screen runner. No
 * Stockfish process or game is started here.
 */
'use strict';

const assert = require('assert');
const Screen = require('./level-screen');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

check('levels map to the durable product IDs, including Master', function () {
  assert.deepStrictEqual(Screen.LEVEL_IDS,
    { easy: '1', medium: '2', hard: '3', expert: '5', master: 'master' });
});

check('anchor settings match the frozen E4-v1 anchor UCI contract', function () {
  const protocol = require('../../eval/e4/protocol-v1.json');
  const uci = protocol.anchor.uci;
  const options = Object.fromEntries(Screen.ANCHOR_OPTIONS);
  assert.strictEqual(options.UCI_LimitStrength, String(uci.UCI_LimitStrength));
  assert.strictEqual(options.Threads, String(uci.Threads));
  assert.strictEqual(options.Hash, String(uci.Hash));
  assert.strictEqual(options.Ponder, String(uci.Ponder));
  assert.strictEqual(options.MultiPV, String(uci.MultiPV));
  assert.strictEqual(options.SyzygyPath, uci.SyzygyPath);
  assert.strictEqual(options['Move Overhead'], String(uci['Move Overhead']));
  assert.strictEqual(Screen.ANCHOR_MOVETIME_MS, protocol.anchor.go.movetimeMs);
  assert.strictEqual(Screen.DRAW_AT_PLIES, protocol.adjudication.drawAtPlies);
});

check('opening lines replay to UCI and reject ambiguous tokens', function () {
  const line = Screen.openingLine('e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6');
  assert.deepStrictEqual(line.uci,
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6', 'd7c6']);
  assert.strictEqual(line.state.turn, 'w');
  assert.throws(function () { Screen.openingLine('e4 e5 N'); }, /matched 0 moves/);
});

check('anchor moves must be well-formed and legal in the current position', function () {
  const state = Screen.openingLine('e4 e5').state;
  assert.ok(Screen.legalFromUci(state, 'g1f3'));
  assert.strictEqual(Screen.legalFromUci(state, 'e4e5'), null);
  assert.strictEqual(Screen.legalFromUci(state, '(none)'), null);
  assert.strictEqual(Screen.legalFromUci(state, undefined), null);
  const promo = globalThis.Chess.parseFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.strictEqual(Screen.uciOf(Screen.legalFromUci(promo, 'a7a8n')), 'a7a8n');
  assert.strictEqual(Screen.legalFromUci(promo, 'a7a8'), null);
});

check('results are scored from the Chessy side', function () {
  assert.strictEqual(Screen.chessyScore('1-0', 'white'), 1);
  assert.strictEqual(Screen.chessyScore('1-0', 'black'), 0);
  assert.strictEqual(Screen.chessyScore('0-1', 'black'), 1);
  assert.strictEqual(Screen.chessyScore('0-1', 'white'), 0);
  assert.strictEqual(Screen.chessyScore('1/2-1/2', 'white'), 0.5);
  assert.throws(function () { Screen.chessyScore('*', 'white'); });
});

check('even and odd opening blocks are disjoint and cover the list', function () {
  const even = Screen.selectOpenings('even', 100);
  const odd = Screen.selectOpenings('odd', 100);
  assert.strictEqual(even.length, 50);
  assert.strictEqual(odd.length, 50);
  assert.ok(even.every(function (i) { return odd.indexOf(i) < 0; }));
  assert.deepStrictEqual(even.concat(odd).sort(function (a, b) { return a - b; }),
    Array.from({ length: 100 }, function (_, i) { return i; }));
  assert.deepStrictEqual(Screen.selectOpenings('3-5', 100), [3, 4, 5]);
  assert.throws(function () { Screen.selectOpenings('5-3', 100); });
  assert.throws(function () { Screen.selectOpenings('0-100', 100); });
});

check('logistic Elo is symmetric and anchored at 50%', function () {
  assert.ok(Screen.eloFromScore(0.5) === 0);
  assert.ok(Math.abs(Screen.eloFromScore(0.75) - 190.85) < 0.01);
  assert.ok(Math.abs(Screen.eloFromScore(0.25) + Screen.eloFromScore(0.75)) < 1e-9);
  assert.ok(Number.isFinite(Screen.eloFromScore(1)));
  assert.ok(Number.isFinite(Screen.eloFromScore(0)));
});

check('summaries count W-D-L, colors and a reproducible clustered interval', function () {
  const records = [];
  for (let id = 0; id < 20; id++) {
    records.push({ openingId: id, chessyColor: 'white', score: id % 4 === 0 ? 0 : 1 });
    records.push({ openingId: id, chessyColor: 'black', score: id % 5 === 0 ? 1 : 0.5 });
  }
  const a = Screen.summarize(records, { anchor: 1500, replicates: 2000 });
  const b = Screen.summarize(records, { anchor: 1500, replicates: 2000 });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.games, 40);
  assert.strictEqual(a.openingClusters, 20);
  assert.strictEqual(a.win, 15 + 4);
  assert.strictEqual(a.draw, 16);
  assert.strictEqual(a.loss, 5);
  assert.strictEqual(a.score, (19 + 8) / 40);
  assert.strictEqual(a.scoreWhite, 15 / 20);
  assert.strictEqual(a.scoreBlack, (4 + 8) / 20);
  assert.ok(Math.abs(a.ratingEstimate - (1500 + Screen.eloFromScore(a.score))) < 1e-9);
  const [lo, hi] = a.bootstrap.score95;
  assert.ok(lo < a.score && a.score < hi);
  assert.ok(a.bootstrap.rating95[0] < a.ratingEstimate && a.ratingEstimate < a.bootstrap.rating95[1]);
  assert.ok(a.bootstrap.oneSidedLower95Rating > a.bootstrap.rating95[0]);
});

console.log('\nlevel-screen: ' + passed + ' passed');
