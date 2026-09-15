/* Shared legal replay and position-cluster helpers for match protocol v2. */
'use strict';

require('../assets/engine.js');
const Chess = globalThis.Chess;

function sanTokens(pgn) {
  const tokens = pgn.trim().split(/\s+/).filter(function (token) {
    return !/^\d+\.$/.test(token);
  });
  if (!tokens.length) throw new Error('empty PGN line');
  return tokens;
}

function replayPgn(pgn, where) {
  const strip = function (san) { return san.replace(/[+#]$/, ''); };
  let state = Chess.newGameState();
  const tokens = sanTokens(pgn);
  const uci = [];
  for (let ply = 0; ply < tokens.length; ply++) {
    const legal = Chess.legalMoves(state);
    const matches = legal.filter(function (move) {
      return strip(Chess.toSan(state, move, legal)) === strip(tokens[ply]);
    });
    if (matches.length !== 1) {
      throw new Error((where || 'opening') + ': SAN ' +
        JSON.stringify(tokens[ply]) + ' at ply ' + (ply + 1) + ' matched ' +
        matches.length + ' moves');
    }
    uci.push(Chess.sqName(matches[0].from) + Chess.sqName(matches[0].to) +
      (matches[0].promotion || ''));
    state = Chess.playMove(state, matches[0]);
  }
  return { state: state, plies: tokens.length, uci: uci.join(' ') };
}

function expandBoard(placement) {
  const squares = [];
  for (const rank of placement.split('/')) {
    for (const char of rank) {
      if (/^[1-8]$/.test(char)) {
        for (let i = 0; i < Number(char); i++) squares.push(null);
      } else {
        squares.push(char);
      }
    }
  }
  if (squares.length !== 64) throw new Error('invalid FEN placement ' + placement);
  return squares;
}

function compressBoard(squares) {
  const ranks = [];
  for (let rank = 0; rank < 8; rank++) {
    let text = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = squares[rank * 8 + file];
      if (!piece) empty++;
      else {
        if (empty) text += empty;
        empty = 0;
        text += piece;
      }
    }
    if (empty) text += empty;
    ranks.push(text);
  }
  return ranks.join('/');
}

// Vertical rank reflection plus colour swap is the natural colour symmetry of
// a chess position. Canonicalising it prevents a position and its colour-rank
// mirror from being counted as two independent opening clusters.
function colourRankMirror(fen4) {
  const parts = fen4.split(' ');
  const board = expandBoard(parts[0]);
  const mirrored = new Array(64);
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (piece) {
        mirrored[(7 - rank) * 8 + file] = piece === piece.toUpperCase()
          ? piece.toLowerCase() : piece.toUpperCase();
      }
    }
  }
  const castlingMap = { K: 'k', Q: 'q', k: 'K', q: 'Q' };
  const castling = parts[2] === '-' ? '-' : parts[2].split('').map(function (x) {
    return castlingMap[x];
  }).sort(function (a, b) {
    return 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b);
  }).join('');
  const ep = parts[3] === '-' ? '-' :
    parts[3][0] + String(9 - Number(parts[3][1]));
  return [compressBoard(mirrored), parts[1] === 'w' ? 'b' : 'w',
    castling, ep].join(' ');
}

function positionCluster(fen) {
  // positionKey removes an en-passant target when no legal capture exists,
  // matching the engine/FIDE repetition identity rather than raw FEN syntax.
  const fen4 = Chess.positionKey(Chess.parseFen(fen));
  const mirror = colourRankMirror(fen4);
  return fen4 < mirror ? fen4 : mirror;
}

module.exports = Object.freeze({
  sanTokens: sanTokens,
  replayPgn: replayPgn,
  colourRankMirror: colourRankMirror,
  positionCluster: positionCluster
});
