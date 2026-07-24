/*
 * Literal Master wall-clock regression for game chessy202607240238.
 *
 * CI runs this file with `node --jitless` to exercise a deliberately slow,
 * cold runtime. Unlike the deterministic node gates in ai-tactics.js, this
 * uses the shipped Master limits exactly: 5 seconds with quiescence. A fixed
 * seed makes the production root shuffle repeatable.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

const FEN = 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27';
const WATCHDOG_MS = 8000; // assets/app.js: cfg.timeMs + 3000
// Exhaustive independent mate-in-5 enumeration: every other legal move lets
// White force 28.Ne7+ ... 29.Qh7+ ... 30.Qh8# (or an equivalent mate).
const SAFE = new Set(['f7f6', 'g7g6', 'g7g5', 'e6f8', 'e6g5']);

function uci(move) {
  return move ? Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '') : '-';
}
function legal(state, move) {
  return !!move && Chess.legalMoves(state).some(function (m) {
    return m.from === move.from && m.to === move.to && m.promotion === move.promotion;
  });
}

const state = Chess.parseFen(FEN);
const started = Date.now();
const result = ChessAI.think(state, {
  maxDepth: 30,
  timeMs: 5000,
  quiesce: true,
  seed: 0xC0FFEE
});
const elapsed = Date.now() - started;
const move = uci(result.move);

let failed = 0;
if (!legal(state, result.move)) {
  failed++;
  console.error('FAIL  Master returns a legal move — got ' + move);
} else {
  console.log('  ok  Master returns a legal move');
}
if (!SAFE.has(move)) {
  failed++;
  console.error('FAIL  Master avoids the forced mate — got ' + move +
    ' (d' + result.depth + ', ' + result.nodes + ' nodes)');
} else {
  console.log('  ok  Master avoids the forced mate with ' + move);
}
if (elapsed >= WATCHDOG_MS) {
  failed++;
  console.error('FAIL  Master returns before the production watchdog — took ' +
    elapsed + ' ms (limit ' + WATCHDOG_MS + ' ms)');
} else {
  console.log('  ok  Master returns before the production watchdog');
}

// Depth and node count are telemetry; the move and watchdog are the contracts.
console.log('Master telemetry: ' + move + ', depth ' + result.depth +
  ', score ' + result.score + ', nodes ' + result.nodes +
  ', qnodes ' + result.qnodes + ', researches ' + result.researches +
  ', elapsed ' + elapsed + ' ms');
if (failed) process.exit(1);
