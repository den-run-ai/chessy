/*
 * Exact replay fixture for the Master screenshot incident supplied in the
 * 2026-07-24 backup. This deliberately starts from that backup's SAN list,
 * not the earlier chessy202607240238 debug PGN: the two games are distinct.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../assets/engine.js');

const game = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'master-incident-20260724.json'), 'utf8'));
const critical = new Map(game.critical.map(function (c) { return [c.ply, c]; }));
let state = Chess.newGameState();
let passed = 0, failed = 0;
let replayError = null;

function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

check(game.id === 'dd608f7d-4a6d-416a-a773-0c7515e14898' &&
    game.difficulty === 'master' && game.playerColor === 'w' &&
    game.plies === 123 && game.sans.length === game.plies,
  'fixture identity matches the supplied Master screenshot game');

for (let ply = 0; ply < game.sans.length; ply++) {
  const marker = critical.get(ply);
  if (marker) {
    check(Chess.toFen(state) === marker.fen && game.sans[ply] === marker.san,
      'critical position before ' + (Math.floor(ply / 2) + 1) + '...' + marker.san,
      'got ' + Chess.toFen(state) + ' before ' + game.sans[ply]);
  }
  const legal = Chess.legalMoves(state);
  const move = legal.find(function (m) {
    return Chess.toSan(state, m, legal) === game.sans[ply];
  });
  if (!move) {
    replayError = 'ply ' + (ply + 1) + ' (' + game.sans[ply] + ') from ' +
      Chess.toFen(state) + '; legal: ' +
      legal.map(function (m) { return Chess.toSan(state, m, legal); }).join(' ');
    break;
  }
  state = Chess.playMove(state, move);
}

const status = Chess.gameStatus(state);
check(replayError === null, 'all SAN moves replay legally', replayError);
check(state.history.length === game.plies, 'all 123 screenshot-game plies replay');
const sanHash = crypto.createHash('sha256')
  .update(state.history.map(function (h) { return h.san; }).join('\n'), 'utf8')
  .digest('hex');
check(sanHash === game.sanSha256, 'canonical SAN SHA-256 matches the frozen game',
  sanHash);
check(Chess.toFen(state) === game.finalFen, 'final FEN matches the screenshot board',
  Chess.toFen(state));
check(status.over && status.result === game.result && status.reason === game.reason,
  'replay ends in the recorded checkmate');
check(state.history[state.history.length - 1].san === 'Bd5#',
  'final move is Bd5#');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
