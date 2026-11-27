/* Independent game replay through pinned Chessy JavaScript rules; no search. */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const readline = require('node:readline');

function check(ok, message) { if (!ok) throw new Error(message); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function moveName(Chess, move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase();
}
function replay(Chess, game) {
  let state = Chess.newGameState(game.initialFen);
  function play(name) {
    const move = Chess.legalMoves(state).find(item => moveName(Chess, item) === name);
    check(move, 'illegal independent replay move ' + name);
    state = Chess.playMove(state, move);
  }
  function ending(plies) {
    const status = Chess.gameStatus(state);
    if (status.over) {
      const names = { 'checkmate': 'checkmate', 'stalemate': 'stalemate',
        'fifty-move rule': 'current-fifty-move', 'insufficient material': 'insufficient-material',
        'threefold repetition': 'current-threefold' };
      check(Object.hasOwn(names, status.reason), 'unknown rules termination');
      return { result: status.result, reason: names[status.reason] };
    }
    return plies >= game.cap ? { result: '1/2-1/2', reason: 'ply-cap' } : null;
  }
  for (const token of game.prefixUci) play(token);
  check(Chess.toFen(state) === game.rootFen, 'independent opening FEN mismatch');
  for (let ply = 0; ply < game.moves.length; ply++) {
    const row = game.moves[ply];
    check(!ending(ply), 'move after independently terminal game');
    check(row.fen === Chess.toFen(state), 'independent searched FEN mismatch');
    const candidate = state.turn === (game.candidateColor === 'white' ? 'w' : 'b');
    check(row.mode === (candidate ? 'candidate' : 'hce'), 'candidate color mismatch');
    play(row.move);
  }
  const result = ending(game.moves.length);
  check(result, 'unfinished replay claimed complete');
  return { gameId: game.gameId, plies: game.moves.length, fen: Chess.toFen(state), ...result };
}

async function main() {
  const [rulesPath, expectedHash] = process.argv.slice(2);
  const bytes = fs.readFileSync(rulesPath);
  check(sha(bytes) === expectedHash, 'independent rules identity mismatch');
  const context = vm.createContext({});
  vm.runInContext(bytes.toString('utf8'), context, { filename: 'authenticated-rules.js' });
  check(context.Chess, 'rules did not export Chess');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    check(line.length > 0, 'empty replay record');
    process.stdout.write(JSON.stringify(replay(context.Chess, JSON.parse(line))) + '\n');
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { replay };
