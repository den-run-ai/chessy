/* Engine correctness tests — run with: node test/engine.test.js */
'use strict';
require('../js/engine.js');
require('../js/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

let passed = 0, failed = 0;
function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + ' — expected ' + expected + ', got ' + actual);
  }
}

function perft(state, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const m of Chess.legalMoves(state)) {
    nodes += perft(Chess.applyMove(state, m), depth - 1);
  }
  return nodes;
}

// --- Perft: known-good node counts validate the whole move generator ---
console.log('perft — initial position');
const start = Chess.parseFen(Chess.START_FEN);
assertEqual(perft(start, 1), 20, 'perft(1) = 20');
assertEqual(perft(start, 2), 400, 'perft(2) = 400');
assertEqual(perft(start, 3), 8902, 'perft(3) = 8902');
assertEqual(perft(start, 4), 197281, 'perft(4) = 197281');

console.log('perft — Kiwipete (castling, en passant, pins, promotions)');
const kiwipete = Chess.parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
assertEqual(perft(kiwipete, 1), 48, 'perft(1) = 48');
assertEqual(perft(kiwipete, 2), 2039, 'perft(2) = 2039');
assertEqual(perft(kiwipete, 3), 97862, 'perft(3) = 97862');

console.log('perft — position 3 (en passant discovered check)');
const pos3 = Chess.parseFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
assertEqual(perft(pos3, 1), 14, 'perft(1) = 14');
assertEqual(perft(pos3, 2), 191, 'perft(2) = 191');
assertEqual(perft(pos3, 3), 2812, 'perft(3) = 2812');
assertEqual(perft(pos3, 4), 43238, 'perft(4) = 43238');

console.log('perft — position 5 (promotion-heavy)');
const pos5 = Chess.parseFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
assertEqual(perft(pos5, 1), 44, 'perft(1) = 44');
assertEqual(perft(pos5, 2), 1486, 'perft(2) = 1486');
assertEqual(perft(pos5, 3), 62379, 'perft(3) = 62379');

// --- FEN round-trip ---
console.log('FEN round-trip');
for (const fen of [
  Chess.START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 b - c3 4 20'
]) {
  assertEqual(Chess.toFen(Chess.parseFen(fen)), fen, fen.slice(0, 25) + '…');
}

// --- Game endings ---
console.log('game endings');
function playSans(sans) {
  let s = Chess.newGameState();
  for (const san of sans) {
    const legal = Chess.legalMoves(s);
    const move = legal.find((m) => Chess.toSan(s, m, legal).replace(/[+#]/, '') === san.replace(/[+#]/, ''));
    if (!move) throw new Error('illegal move in test: ' + san);
    s = Chess.playMove(s, move);
  }
  return s;
}

const foolsMate = playSans(['f3', 'e5', 'g4', 'Qh4']);
assertEqual(Chess.gameStatus(foolsMate).reason, 'checkmate', "fool's mate is checkmate");
assertEqual(Chess.gameStatus(foolsMate).result, '0-1', "fool's mate: Black wins");
assertEqual(foolsMate.history[3].san, 'Qh4#', 'mate SAN gets # suffix');

const stalemate = Chess.parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
stalemate.positions = {};
assertEqual(Chess.gameStatus(stalemate).reason, 'stalemate', 'stalemate detected');

const bareKings = Chess.parseFen('7k/8/6K1/8/8/8/8/8 w - - 0 1');
bareKings.positions = {};
assertEqual(Chess.gameStatus(bareKings).reason, 'insufficient material', 'K vs K is a draw');

const knightOnly = Chess.parseFen('7k/8/6K1/8/3N4/8/8/8 w - - 0 1');
knightOnly.positions = {};
assertEqual(Chess.gameStatus(knightOnly).reason, 'insufficient material', 'K+N vs K is a draw');

const rookLeft = Chess.parseFen('7k/8/6K1/8/3R4/8/8/8 w - - 0 1');
rookLeft.positions = {};
assertEqual(Chess.gameStatus(rookLeft).over, false, 'K+R vs K is not a draw');

const repetition = playSans(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
assertEqual(Chess.gameStatus(repetition).reason, 'threefold repetition', 'threefold repetition detected');

const fifty = Chess.parseFen('7k/8/6K1/8/3R4/8/8/8 w - - 100 80');
fifty.positions = {};
assertEqual(Chess.gameStatus(fifty).reason, 'fifty-move rule', '50-move rule detected');

// --- Special moves ---
console.log('special moves');
const castled = playSans(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
assertEqual(castled.board[Chess.sqIndex('g1')], 'wK', 'castling places king on g1');
assertEqual(castled.board[Chess.sqIndex('f1')], 'wR', 'castling places rook on f1');
assertEqual(castled.castling.wK || castled.castling.wQ, false, 'castling rights consumed');

const epState = playSans(['e4', 'a6', 'e5', 'd5']);
const epLegal = Chess.legalMoves(epState);
const epMove = epLegal.find((m) => m.ep);
assertEqual(!!epMove, true, 'en passant available after double push');
const afterEp = Chess.playMove(epState, epMove);
assertEqual(afterEp.board[Chess.sqIndex('d5')], null, 'en passant removes captured pawn');
assertEqual(epState.history.concat().length + 1, afterEp.history.length, 'ep recorded in history');
assertEqual(afterEp.history[afterEp.history.length - 1].san, 'exd6', 'en passant SAN');

const promoState = Chess.parseFen('8/P6k/8/8/8/8/6K1/8 w - - 0 1');
promoState.positions = {};
promoState.history = [];
const promos = Chess.legalMoves(promoState).filter((m) => m.promotion);
assertEqual(promos.length, 4, 'four promotion choices');
const promoQ = promos.find((m) => m.promotion === 'Q');
assertEqual(Chess.toSan(promoState, promoQ), 'a8=Q', 'promotion SAN');

// --- Undo ---
console.log('undo');
let g = Chess.newGameState();
const fen0 = Chess.toFen(g);
const legal0 = Chess.legalMoves(g);
g = Chess.playMove(g, legal0[0]);
g = Chess.undoMove(g);
assertEqual(Chess.toFen(g), fen0, 'undo restores exact position');
assertEqual(g.history.length, 0, 'undo pops history');

// --- SAN disambiguation ---
console.log('SAN disambiguation');
const twoKnights = Chess.parseFen('7k/8/8/8/8/2N1N3/8/6K1 w - - 0 1');
const nMoves = Chess.legalMoves(twoKnights);
const toD5 = nMoves.filter((m) => Chess.sqName(m.to) === 'd5');
assertEqual(toD5.length, 2, 'two knights reach d5');
const sans = toD5.map((m) => Chess.toSan(twoKnights, m, nMoves)).sort().join(' ');
assertEqual(sans, 'Ncd5 Ned5', 'file disambiguation');

// --- AI sanity ---
console.log('AI');
const mateInOne = Chess.parseFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
const aiMove = ChessAI.bestMove(mateInOne, 2);
const aiSan = Chess.toSan(mateInOne, aiMove);
assertEqual(aiSan, 'Ra8#', 'AI finds mate in one');

const hangingQueen = Chess.parseFen('k7/8/8/3q4/8/8/3Q4/K7 w - - 0 1');
const capture = ChessAI.bestMove(hangingQueen, 2);
assertEqual(Chess.sqName(capture.to), 'd5', 'AI captures hanging queen');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
