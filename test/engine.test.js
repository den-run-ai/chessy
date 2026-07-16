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

// Expert depth: force a two-rook ladder mate in two (mate is at ply 3, so
// only a deeper search sees it as forced; play both sides and require mate).
let ladder = Chess.newGameState('7k/8/8/7p/8/8/8/RR4K1 w - - 0 1');
for (let ply = 0; ply < 4 && !Chess.gameStatus(ladder).over; ply++) {
  ladder = Chess.playMove(ladder, ChessAI.bestMove(ladder, 5));
}
assertEqual(Chess.gameStatus(ladder).reason, 'checkmate', 'depth-5 AI forces mate in two');
assertEqual(Chess.gameStatus(ladder).result, '1-0', 'ladder mate: White wins');

// Quiescence (Master): a pawn on e5 is defended by the d6 pawn. A fixed-depth
// search at its horizon grabs it; quiescence resolves the recapture and declines.
const poisoned = Chess.parseFen('6k1/8/3p4/4p2Q/8/8/8/6K1 w - - 0 1');
assertEqual(Chess.sqName(ChessAI.bestMove(poisoned, 1, false).to), 'e5',
  'plain search at horizon takes the poisoned pawn');
assertEqual(Chess.sqName(ChessAI.bestMove(poisoned, 1, true).to) !== 'e5', true,
  'quiescent search declines the poisoned pawn');

// Quiescence must still handle in-check positions (evasion search).
const mustEvade = Chess.parseFen('6k1/5ppp/8/8/8/8/6PP/r5K1 w - - 0 1');
const evasion = ChessAI.bestMove(mustEvade, 3, true);
assertEqual(Chess.sqName(evasion.to), 'f2', 'quiescent search evades check (Kf2)');

// Root-pruning regression (bug shipped with the depth speedup): with a
// narrowed root window, fail-low moves return BOUNDS that can equal the best
// score; treating them as ties made the AI pick near-random moves. bestMove
// must always return a move whose exact full-window score is optimal.
console.log('root move selection');
const openPos = Chess.parseFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
const refScores = {};
let refBest = Infinity; // Black to move minimizes
for (const m of Chess.legalMoves(openPos)) {
  const sc = ChessAI.search(Chess.applyMove(openPos, m), 2, -Infinity, Infinity, false);
  refScores[m.from + '-' + m.to] = sc;
  if (sc < refBest) refBest = sc;
}
let optimalPicks = 0;
for (let i = 0; i < 12; i++) {
  const m = ChessAI.bestMove(openPos, 3, false);
  if (refScores[m.from + '-' + m.to] === refBest) optimalPicks++;
}
assertEqual(optimalPicks, 12, 'bestMove always returns a truly-optimal root move (12/12)');

// --- PGN export ---
console.log('PGN export');
const pgnGame = playSans(['f3', 'e5', 'g4', 'Qh4']);
pgnGame.history[3].ai = { depth: 5, quiesce: true, ms: 123 };
const pgn = Chess.toPgn(pgnGame, { White: 'Human', Black: 'Chessy AI (Master)', Date: '2026.07.15' });
assertEqual(pgn.includes('[Result "0-1"]'), true, 'PGN result tag');
assertEqual(pgn.includes('[White "Human"]'), true, 'PGN custom tag override');
assertEqual(pgn.includes('1. f3 e5 2. g4 Qh4# {checkmate} 0-1'), true, 'PGN movetext with result');
assertEqual(pgn.includes('{engine'), false, 'clean PGN has no log comments');
const pgnLog = Chess.toPgn(pgnGame, {}, true);
assertEqual(pgnLog.includes('{engine depth 5+quiescence, 123 ms; before: '), true,
  'debug PGN embeds engine info + FEN comments');
assertEqual(pgnLog.includes('before: ' + Chess.START_FEN), true, 'debug PGN logs starting FEN');
const pgnOngoing = Chess.toPgn(playSans(['e4']), {});
assertEqual(pgnOngoing.includes('[Result "*"]'), true, 'ongoing game marked *');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
