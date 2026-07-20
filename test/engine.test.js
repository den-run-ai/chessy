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

const sameShadeBishops = Chess.parseFen('7k/8/6K1/8/2B5/8/4B3/8 w - - 0 1');
sameShadeBishops.positions = {};
assertEqual(Chess.gameStatus(sameShadeBishops).reason, 'insufficient material',
  'multiple same-colored bishops vs bare king is dead');

const oppShadeBishops = Chess.parseFen('7k/8/6K1/8/2B5/4B3/8/8 w - - 0 1');
oppShadeBishops.positions = {};
assertEqual(Chess.gameStatus(oppShadeBishops).over, false,
  'opposite-colored bishops can still mate');

const knightsAlive = Chess.parseFen('7k/8/6K1/8/3N4/3N4/8/8 w - - 0 1');
knightsAlive.positions = {};
assertEqual(Chess.gameStatus(knightsAlive).over, false, 'K+2N vs K is not dead (helpmate exists)');

const repetition = playSans(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
assertEqual(Chess.gameStatus(repetition).reason, 'threefold repetition', 'threefold repetition detected');

// FIDE 9.2.3: a phantom en-passant square (no legal ep capture) must not
// distinguish positions. The post-a4 position recurs three times here even
// though its first occurrence carries "a3" in the FEN.
const epRep = playSans(['a4', 'Nf6', 'Nf3', 'Ng8', 'Ng1', 'Nf6', 'Nf3', 'Ng8', 'Ng1']);
assertEqual(Chess.gameStatus(epRep).reason, 'threefold repetition',
  'repetition counted across phantom ep rights');

// ...but a REAL en-passant possibility must still distinguish the position.
const epReal = Chess.parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
const epGone = Chess.parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
assertEqual(Chess.positionKey(epReal) !== Chess.positionKey(epGone), true,
  'capturable ep square still distinguishes positions');

// FIDE 6.9 flag-fall: the opponent of the flagger wins unless NO series of
// legal moves could let them checkmate. canMate() is that color-specific
// test on the FULL position — the flagger's pieces stay on the board.
console.log('canMate (FIDE 6.9 flag fall)');
function canMateFen(fen, color) { return Chess.canMate(Chess.parseFen(fen).board, color); }
// Regression: White (K+N) flags against Black (K+B). Removing the knight
// would call K+B vs K a draw — but the knight can block its own king's
// escape (…Kh2 Bf1 Kh1 Kg3 Ng1 Bg2#), so Black CAN mate and wins on time.
assertEqual(canMateFen('8/8/8/8/8/5k1N/6b1/7K w - - 0 1', 'b'), true,
  'K+B mates with help from an opposing knight (flagger keeps pieces)');
assertEqual(canMateFen('8/8/8/8/8/5k2/6b1/7K w - - 0 1', 'b'), false,
  'K+B vs bare K cannot mate');
assertEqual(canMateFen('8/8/8/8/8/5k2/6n1/7K w - - 0 1', 'b'), false,
  'K+N vs bare K cannot mate');
assertEqual(canMateFen('8/8/8/8/8/5k2/6n1/6RK w - - 0 1', 'b'), true,
  'K+N mates with an opposing rook to smother with');
assertEqual(canMateFen('8/8/8/8/8/5k2/6n1/6QK w - - 0 1', 'b'), false,
  'an opposing queen never enables the lone-knight helpmate');
assertEqual(canMateFen('8/8/8/8/8/5k2/5nn1/7K b - - 0 1', 'b'), true,
  'two knights can helpmate a bare king');
assertEqual(canMateFen('8/8/8/8/8/5k2/8/6PK w - - 0 1', 'w'), true,
  'a pawn can always mate (promotion)');
assertEqual(canMateFen('8/8/8/8/8/5k2/8/6RK w - - 0 1', 'w'), true,
  'a rook can always mate');
assertEqual(canMateFen('8/8/8/8/2b5/5k2/4b3/7K b - - 0 1', 'b'), false,
  'same-shade bishops cannot mate');
assertEqual(canMateFen('8/8/8/8/2b5/4bk2/8/7K b - - 0 1', 'b'), true,
  'opposite-shade bishops can mate');
assertEqual(canMateFen('8/8/8/8/2b5/5k2/8/6BK w - - 0 1', 'b'), true,
  'a light-square bishop mates with the OPPONENT dark-square bishop as blocker');
assertEqual(canMateFen('8/8/8/8/8/5k2/8/7K w - - 0 1', 'w'), false,
  'a bare king cannot mate');
// A dead position is exactly "neither side can mate".
assertEqual(canMateFen('7k/8/6K1/8/3N4/8/8/8 w - - 0 1', 'w') ||
            canMateFen('7k/8/6K1/8/3N4/8/8/8 w - - 0 1', 'b'), false,
  'K+N vs K: neither side can mate (consistent with the dead-position rule)');

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

// Delta pruning must never prune a CHECKING capture: Qxg7# only wins a pawn,
// so with a high alpha the prune condition holds — but it is mate. The
// window is set so the old prune skipped the move and returned stand-pat.
const checkCap = Chess.parseFen('r5k1/6p1/7Q/8/8/8/1B6/6K1 w - - 0 1');
assertEqual(ChessAI.search(checkCap, 0, 100000, 100001, true) > 999000, true,
  'delta pruning exempts checking captures (Qxg7# found)');

// Easy (depth 1) must recognize terminal positions after its own move: here
// Qa1 is mate, while most queen moves stalemate Black immediately.
const easyMate = Chess.parseFen('k1K5/8/8/8/8/8/8/6Q1 w - - 0 1');
const easyPick = ChessAI.bestMove(easyMate, 1, false);
assertEqual(Chess.toSan(easyMate, easyPick), 'Qa1#', 'Easy finds mate and avoids stalemate');

// Mate takes precedence over the 50-move rule: the mating move IS the 100th
// halfmove, so a search that checks the clock first would refuse Ra8#.
const mateOnClock = Chess.parseFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 99 1');
for (const [d, q] of [[1, false], [3, false], [3, true]]) {
  const m = ChessAI.bestMove(mateOnClock, d, q);
  assertEqual(Chess.toSan(mateOnClock, m), 'Ra8#', 'mate on the 100th halfmove (depth ' + d + (q ? '+q' : '') + ')');
}

// Terminal awareness at the search horizon (P0 regression): leaves used to
// be evaluated statically, so a depth-2 search missed mates two plies out —
// in this position Medium played Bxf3??, overlooking Qxd7#. Whatever move
// the engine picks, the opponent must not have a mate in one.
const horizon = Chess.parseFen('5bnr/1bppk1pp/np2Pp2/rN3P2/p1P3Pq/5N1P/PP1QP3/R1BK1B1R b - - 0 13');
for (const [d, q] of [[2, false], [2, true]]) {
  const hMove = ChessAI.bestMove(horizon, d, q);
  const afterH = Chess.applyMove(horizon, hMove);
  const allowsMate = Chess.legalMoves(afterH).some(function (m) {
    const nn = Chess.applyMove(afterH, m);
    return Chess.legalMoves(nn).length === 0 && Chess.inCheck(nn, nn.turn);
  });
  assertEqual(allowsMate, false,
    'depth-' + d + (q ? '+quiescence' : '') + ' search sees mate threats at the horizon');
}

// Exact repetition counting: a position seen ONCE before (here: every reply
// position, seeded with count 1) is not yet a draw. The old search scored
// any recurrence as 0, which would hide this forced mate behind a "draw".
const ladderRep = Chess.parseFen('7k/8/8/7p/8/8/8/RR4K1 w - - 0 1');
const onceSeen = {};
for (const m of Chess.legalMoves(ladderRep)) {
  onceSeen[Chess.positionKey(Chess.applyMove(ladderRep, m))] = 1;
}
const ladderThink = ChessAI.think(ladderRep, { maxDepth: 5, positions: onceSeen });
assertEqual(ladderThink.score > 999000, true,
  'single prior occurrence of a position is not scored as a draw (mate still found)');

// Repetition identity in the search hash mirrors Chess.positionKey():
// capturable ep rights distinguish positions, phantom ones do not.
assertEqual(ChessAI.repKey(epReal) !== ChessAI.repKey(epGone), true,
  'legal ep capture distinguishes the repetition hash');
const phantomA = Chess.parseFen('rnbqkbnr/pppppppp/8/8/P7/8/1PPPPPPP/RNBQKBNR b KQkq a3 0 1');
const phantomB = Chess.parseFen('rnbqkbnr/pppppppp/8/8/P7/8/1PPPPPPP/RNBQKBNR b KQkq - 0 1');
assertEqual(ChessAI.repKey(phantomA), ChessAI.repKey(phantomB),
  'phantom ep right does not change the repetition hash');

// Repetition-aware root: with the game's repetition table available, a move
// that triggers threefold scores as a draw — the winning side must avoid it,
// the losing side must head for it.
const winning = Chess.parseFen('7k/8/5K2/8/8/8/8/3Q4 w - - 0 1');
const winMoves = Chess.legalMoves(winning);
const keep = winMoves.find(function (m) { return Chess.sqName(m.to) === 'd2'; });
const repAll = {};
for (const m of winMoves) {
  if (m !== keep) repAll[Chess.positionKey(Chess.applyMove(winning, m))] = 2;
}
const avoided = ChessAI.bestMove(winning, 2, false, repAll);
assertEqual(avoided.from === keep.from && avoided.to === keep.to, true,
  'winning side avoids threefold repetition');

const losing = Chess.parseFen('7k/8/5K2/8/8/8/8/3Q4 b - - 0 1');
const loseMoves = Chess.legalMoves(losing);
const escapeRep = {};
escapeRep[Chess.positionKey(Chess.applyMove(losing, loseMoves[0]))] = 2;
const sought = ChessAI.bestMove(losing, 2, false, escapeRep);
assertEqual(sought.from === loseMoves[0].from && sought.to === loseMoves[0].to, true,
  'losing side heads for threefold repetition');

// --- Repetition-safe transposition table ---
// A score produced by a search-path repetition draw depends on the path's
// ancestors, not on the position itself. It must never be cached and served
// to a different path (P1 regression: the same position scored 0 with a
// repetition ancestor, cached it, and kept returning the stale 0 after the
// ancestor was gone).
console.log('repetition-safe transposition table');
const perpRoot = Chess.parseFen('6k1/p4pp1/8/5P2/7Q/8/rr6/6K1 w - - 0 1');
let perpX = perpRoot; // after Qd8+ Kh7 Qh4+: Black in check, only ...Kg8
for (const san of ['Qd8+', 'Kh7', 'Qh4+']) {
  const legal = Chess.legalMoves(perpX);
  perpX = Chess.applyMove(perpX, legal.find((m) => Chess.toSan(perpX, m, legal) === san));
}
const sharedCtx = ChessAI.makeCtx(false, Infinity);
const withAncestor = ChessAI.search(perpX, 3, -Infinity, Infinity, false,
  { ctx: sharedCtx, ancestors: [Chess.toFen(perpRoot)] });
assertEqual(withAncestor, 0, 'forced return to a seeded path ancestor scores 0');
const cleanScore = ChessAI.search(perpX, 3, -Infinity, Infinity, false, { ctx: sharedCtx });
assertEqual(cleanScore < -300, true,
  'same TT without the ancestor: path-dependent 0 was not cached (got ' + cleanScore + ')');
// Sanity: a fresh context agrees with the shared-context clean search.
assertEqual(ChessAI.search(perpX, 3, -Infinity, Infinity, false), cleanScore,
  'clean shared-ctx score matches a fresh-ctx search');

// think() must not return a "best move" from a game that is already over,
// even when legal moves exist (the 50-move rule, dead positions and
// completed threefolds end the game before the moves run out).
console.log('think on finished games');
const fiftyOver = Chess.parseFen('7k/8/6K1/8/3R4/8/8/8 w - - 100 80');
assertEqual(ChessAI.think(fiftyOver, { maxDepth: 3 }).move, null,
  'no move from a position drawn by the 50-move rule');
const deadOver = Chess.parseFen('7k/8/6K1/8/3N4/8/8/8 w - - 0 1');
assertEqual(ChessAI.think(deadOver, { maxDepth: 3 }).move, null,
  'no move from a dead position');
const repOver = Chess.parseFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
const repOverTable = {};
repOverTable[Chess.positionKey(repOver)] = 3;
assertEqual(ChessAI.think(repOver, { maxDepth: 3, positions: repOverTable }).move, null,
  'no move from a completed threefold repetition');
assertEqual(!!ChessAI.think(repOver, { maxDepth: 2 }).move, true,
  'the same position without the repetition table still yields a move');
// A full game state carries its own repetition table — think() must fall
// back to it when opts.positions is not passed (codex review, PR #33).
assertEqual(ChessAI.think(repetition, { maxDepth: 2 }).move, null,
  'no move from a finished threefold recorded in state.positions alone');

// --- Zobrist hashing (transposition table keys) ---
console.log('zobrist hashing');
const viaA = playSans(['Nf3', 'Nf6', 'Nc3', 'Nc6']);
const viaB = playSans(['Nc3', 'Nc6', 'Nf3', 'Nf6']);
assertEqual(ChessAI.hashKey(viaA), ChessAI.hashKey(viaB), 'transpositions hash equal');
assertEqual(ChessAI.hashKey(start) !== ChessAI.hashKey(viaA), true,
  'different positions hash differently');
const plainPos = Chess.parseFen('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2');
const epPos = Chess.parseFen('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 2');
assertEqual(ChessAI.hashKey(plainPos) !== ChessAI.hashKey(epPos), true,
  'en-passant square changes the hash');
const noCastle = Chess.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1');
assertEqual(ChessAI.hashKey(start) !== ChessAI.hashKey(noCastle), true,
  'castling rights change the hash');
const blackTurn = Chess.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
assertEqual(ChessAI.hashKey(start) !== ChessAI.hashKey(blackTurn), true,
  'side to move changes the hash');

// --- Tapered evaluation ---
console.log('tapered evaluation');
assertEqual(ChessAI.evaluate(Chess.parseFen(Chess.START_FEN).board), 0,
  'mirror-symmetric start position evaluates to 0');
// Endgame king: with no material left the king should centralize — the
// midgame table alone would score the central king NEGATIVE.
const kCenter = Chess.parseFen('7k/8/8/3K4/8/8/8/8 w - - 0 1').board;
const kCorner = Chess.parseFen('7k/8/8/8/8/8/8/K7 w - - 0 1').board;
assertEqual(ChessAI.evaluate(kCenter) > ChessAI.evaluate(kCorner), true,
  'endgame king centralization outweighs midgame king table');
// Pawn structure: connected pawns beat doubled+isolated ones (same material).
const doubledPawns = Chess.parseFen('4k3/8/8/8/8/3P4/3P4/4K3 w - - 0 1').board;
const connectedPawns = Chess.parseFen('4k3/8/8/8/8/8/2PP4/4K3 w - - 0 1').board;
assertEqual(ChessAI.evaluate(connectedPawns) > ChessAI.evaluate(doubledPawns), true,
  'doubled+isolated pawns are penalized');
// Passed pawn: an advanced passer scores clearly above a blockaded-file pawn.
const passer = Chess.parseFen('4k3/8/8/3P4/8/8/8/4K3 w - - 0 1').board;
const nonPasser = Chess.parseFen('4k3/3p4/8/3P4/8/8/8/4K3 w - - 0 1').board;
assertEqual(ChessAI.evaluate(passer) - ChessAI.evaluate(nonPasser) > 100, true,
  'passed pawn bonus (beyond the material difference)');
// Mobility: identical material, but one rook is boxed in behind its pawns.
const freeRook = Chess.parseFen('4k3/8/8/8/3R4/8/PP6/4K3 w - - 0 1').board;
const boxedRook = Chess.parseFen('4k3/8/8/8/8/8/PP6/R3K3 w - - 0 1').board;
assertEqual(ChessAI.evaluate(freeRook) > ChessAI.evaluate(boxedRook), true,
  'active rook out-scores boxed-in rook via mobility');

// --- Draw awareness inside the search ---
console.log('draw-aware search');
// Black is "winning a rook" — but KxR leaves K vs K, a dead draw worth 0.
const deadCap = Chess.parseFen('8/8/8/8/2k5/2R5/8/2K5 b - - 0 1');
assertEqual(ChessAI.search(deadCap, 2, -Infinity, Infinity, false), 0,
  'capturing the last piece into a dead position scores 0');
assertEqual(ChessAI.search(deadCap, 4, -Infinity, Infinity, false), 0,
  'dead-position draw holds at deeper drafts');
// Perpetual check: White is down two rooks, but Qd8+ Kh7 Qh4+ Kg8 repeats
// the root position. The root counts as a search-path ancestor, so the
// 4-ply line that lands exactly back on the root must already read as the
// cycle it is — depth 4 AND deeper searches score the perpetual as a draw.
const perpetual = Chess.parseFen('6k1/p4pp1/8/5P2/7Q/8/rr6/6K1 w - - 0 1');
for (const d of [4, 6]) {
  const perpR = ChessAI.think(perpetual, { maxDepth: d });
  const perpSan = Chess.toSan(perpetual, Chess.legalMoves(perpetual).find(
    (m) => m.from === perpR.move.from && m.to === perpR.move.to));
  assertEqual(perpSan, 'Qd8+', 'losing side heads for perpetual check (depth ' + d + ')');
  assertEqual(perpR.score, 0, 'perpetual check scores as a draw (depth ' + d + ')');
}

// --- Iterative deepening with a time budget ---
console.log('iterative deepening');
const midgame = Chess.parseFen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
const thinkStart = Date.now();
const timed = ChessAI.think(midgame, { maxDepth: 64, timeMs: 300, quiesce: true });
const thinkMs = Date.now() - thinkStart;
assertEqual(!!timed.move, true, 'timed think returns a move');
assertEqual(timed.depth >= 2, true, 'timed think completes at least depth 2 (got ' + timed.depth + ')');
assertEqual(timed.nodes > 0, true, 'timed think reports searched nodes');
assertEqual(thinkMs < 1500, true, 'timed think respects its budget (took ' + thinkMs + ' ms)');

// A timed search must still convert a win: play both sides of the two-rook
// ladder under a per-move budget and require checkmate.
let timedLadder = Chess.newGameState('7k/8/8/7p/8/8/8/RR4K1 w - - 0 1');
for (let ply = 0; ply < 4 && !Chess.gameStatus(timedLadder).over; ply++) {
  const r = ChessAI.think(timedLadder, {
    maxDepth: 64, timeMs: 500, quiesce: true, positions: timedLadder.positions
  });
  timedLadder = Chess.playMove(timedLadder, r.move);
}
assertEqual(Chess.gameStatus(timedLadder).reason, 'checkmate', 'timed search forces the ladder mate');

// Fixed-depth think (no budget) must reach exactly the requested depth.
const fixed = ChessAI.think(midgame, { maxDepth: 3 });
assertEqual(fixed.depth, 3, 'fixed-depth think completes the requested depth');

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

// --- PGN import (parsePgn + replaySans) ---
console.log('PGN import');
const pgnIn = Chess.parsePgn([
  '[Event "Test"]',
  '[White "A"]',
  '[Black "B"]',
  '[Result "0-1"]',
  '',
  '1. f3 e5 2. g4?? {a losing move} Qh4# 0-1'
].join('\n'));
assertEqual(pgnIn.length, 1, 'single game parsed');
assertEqual(pgnIn[0].tags.White, 'A', 'tags parsed');
assertEqual(pgnIn[0].sans.join(' '), 'f3 e5 g4?? Qh4#',
  'movetext tokens (comments/numbers stripped; suffixes kept for replay to normalize)');
assertEqual(pgnIn[0].result, '0-1', 'result parsed');
const replayed = Chess.replaySans(pgnIn[0].sans);
assertEqual(Chess.gameStatus(replayed).reason, 'checkmate', 'replayed game reaches checkmate');
assertEqual(replayed.history.length, 4, 'replayed history length');

// Round-trip: our own exporter parses back to the same moves.
const rt = Chess.parsePgn(Chess.toPgn(playSans(['e4', 'e5', 'Nf3', 'Nc6']), {}));
assertEqual(rt[0].sans.join(' '), 'e4 e5 Nf3 Nc6', 'toPgn output round-trips through parsePgn');

// Messy real-world movetext: nested variations, NAGs, ; comments,
// multi-line brace comments, 0-0 castling and suffix annotations.
const messy = Chess.parsePgn([
  '[Event "Messy"]',
  '',
  '1. e4 $1 e5 ; king pawn',
  '2. Nf3 (2. f4 {the gambit} exf4 (2... d5)) Nc6 3. Bc4 {two',
  'line comment} Bc5!? 4. 0-0 *'
].join('\n'));
assertEqual(messy[0].sans.join(' '), 'e4 e5 Nf3 Nc6 Bc4 Bc5!? 0-0',
  'variations/NAGs/comments stripped, 0-0 kept as a token');
assertEqual(!!Chess.replaySans(messy[0].sans), true, 'annotated SANs replay (suffixes normalized)');

// Some exporters spell out an en-passant capture with a standalone marker.
// It is notation metadata, not another move (codex review, PR #38).
const annotatedEp = Chess.parsePgn('1. e4 a6 2. e5 d5 3. exd6 e.p. *');
assertEqual(annotatedEp[0].sans.join(' '), 'e4 a6 e5 d5 exd6',
  'standalone e.p. annotation stripped');
assertEqual(Chess.replaySans(annotatedEp[0].sans).history.length, 5,
  'PGN with standalone e.p. annotation replays');
const annotatedEpPlain = Chess.parsePgn('1. e4 a6 2. e5 d5 3. exd6 ep *');
assertEqual(annotatedEpPlain[0].sans.join(' '), 'e4 a6 e5 d5 exd6',
  'standalone ep annotation stripped');
assertEqual(Chess.replaySans(annotatedEpPlain[0].sans).history.length, 5,
  'PGN with standalone ep annotation replays');

// Variations spanning line breaks stay variations (codex review, PR #38):
// depth must carry across lines, or the continuation leaks into the game.
const spanVar = Chess.parsePgn('[Event "Span"]\n\n1. e4 (1. d4\nd5 2. c4) e5 2. Nf3 *');
assertEqual(spanVar[0].sans.join(' '), 'e4 e5 Nf3',
  'multi-line variation fully skipped');

// Multiple concatenated games split on the tag section after movetext.
const multi = Chess.parsePgn('[Event "1"]\n\n1. e4 e5 1/2-1/2\n[Event "2"]\n\n1. d4 d5 *');
assertEqual(multi.length, 2, 'two concatenated games parsed');
assertEqual(multi[1].sans.join(' '), 'd4 d5', 'second game movetext');
assertEqual(multi[0].result, '1/2-1/2', 'first game result token');

// TAGLESS multi-game files have no tag section to split on: movetext
// resuming after a termination marker starts the next game.
const tagless = Chess.parsePgn('1. e4 e5 1-0\n\n1. d4 d5 1/2-1/2');
assertEqual(tagless.length, 2, 'tagless games split at the result marker');
assertEqual(tagless[0].sans.join(' '), 'e4 e5', 'first tagless game movetext');
assertEqual(tagless[0].result, '1-0', 'first tagless game result');
assertEqual(tagless[1].sans.join(' '), 'd4 d5', 'second tagless game movetext');
assertEqual(tagless[1].result, '1/2-1/2', 'second tagless game result');

// SetUp/FEN games are flagged unsupported; illegal SANs throw.
assertEqual(Chess.parsePgn('[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Ka2 *')[0].unsupported,
  true, 'SetUp/FEN game flagged unsupported');
let sanErr = null;
try { Chess.replaySans(['e4', 'e4']); } catch (e) { sanErr = String(e); }
assertEqual(sanErr !== null && sanErr.includes('ply 2'), true, 'illegal SAN reports its ply');

// Clock metadata: the debug PGN embeds the mover's remaining time as a
// standard %clk command (history[3] is Black's move, so bMs is shown).
pgnGame.history[3].clock = { thinkMs: 2000, wMs: 305000, bMs: 298000 };
const pgnClk = Chess.toPgn(pgnGame, { TimeControl: '300+3' }, true);
assertEqual(pgnClk.includes('[TimeControl "300+3"]'), true, 'PGN TimeControl tag');
assertEqual(pgnClk.includes('[%clk 0:04:58]'), true, 'debug PGN embeds %clk remaining time');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
