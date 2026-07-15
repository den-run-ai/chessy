/*
 * Chessy AI — minimax with alpha-beta pruning over the Chess engine.
 * Difficulty = search depth (1..3), with capture-first move ordering and
 * piece-square tables for positional evaluation.
 */
(function (global) {
  'use strict';

  const VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

  // Piece-square tables from White's perspective, index 0 = a8.
  const PST = {
    P: [
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0
    ],
    N: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    B: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    R: [
       0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0
    ],
    Q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ],
    K: [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ]
  };

  // Evaluate from White's point of view (positive = good for White).
  function evaluate(board) {
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const type = p[1];
      if (p[0] === 'w') {
        score += VALUES[type] + PST[type][i];
      } else {
        // Mirror the square vertically for Black.
        const mirrored = (7 - Math.floor(i / 8)) * 8 + (i % 8);
        score -= VALUES[type] + PST[type][mirrored];
      }
    }
    return score;
  }

  function orderMoves(moves) {
    // MVV-LVA-ish: captures of big pieces by small pieces first, promotions high.
    return moves.slice().sort(function (a, b) {
      const av = (a.captured ? 10 * VALUES[a.captured[1]] - VALUES[a.piece[1]] : 0) +
                 (a.promotion ? VALUES[a.promotion] : 0);
      const bv = (b.captured ? 10 * VALUES[b.captured[1]] - VALUES[b.piece[1]] : 0) +
                 (b.promotion ? VALUES[b.promotion] : 0);
      return bv - av;
    });
  }

  const MATE = 1000000;

  function search(state, depth, alpha, beta) {
    const moves = Chess.legalMoves(state);
    if (moves.length === 0) {
      if (Chess.inCheck(state, state.turn)) {
        return state.turn === 'w' ? -MATE - depth : MATE + depth;
      }
      return 0; // stalemate
    }
    if (state.halfmove >= 100) return 0;
    if (depth === 0) return evaluate(state.board);

    if (state.turn === 'w') {
      let best = -Infinity;
      for (const m of orderMoves(moves)) {
        best = Math.max(best, search(Chess.applyMove(state, m), depth - 1, alpha, beta));
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const m of orderMoves(moves)) {
        best = Math.min(best, search(Chess.applyMove(state, m), depth - 1, alpha, beta));
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  // Pick the best move for the side to move. Returns null if game over.
  function bestMove(state, depth) {
    const moves = Chess.legalMoves(state);
    if (moves.length === 0) return null;
    const maximizing = state.turn === 'w';
    let best = null;
    let bestScore = maximizing ? -Infinity : Infinity;
    const candidates = [];

    for (const m of orderMoves(moves)) {
      const next = Chess.applyMove(state, m);
      // Avoid walking into threefold repetition when clearly ahead is out of
      // scope for this small AI; just search.
      const score = search(next, depth - 1, -Infinity, Infinity);
      if (maximizing ? score > bestScore : score < bestScore) {
        bestScore = score;
        best = m;
        candidates.length = 0;
        candidates.push(m);
      } else if (score === bestScore) {
        candidates.push(m);
      }
    }
    // Tie-break randomly among equal-best moves so games vary.
    return candidates[Math.floor(Math.random() * candidates.length)] || best;
  }

  global.ChessAI = { bestMove: bestMove, evaluate: evaluate };
})(typeof window !== 'undefined' ? window : globalThis);
