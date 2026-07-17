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

  // Quiescence search: at the horizon, keep resolving captures/promotions
  // (and check evasions) until the position is quiet, so the evaluation never
  // stops in the middle of an exchange (the "horizon effect").
  function quiesce(state, alpha, beta) {
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    const inChk = Chess.isAttacked(state.board, kingSq, enemy);

    let best, standPat = 0;
    if (inChk) {
      best = maximizing ? -Infinity : Infinity; // must evade — no stand-pat
    } else {
      best = standPat = evaluate(state.board); // stand pat: may decline all captures
      if (maximizing) { if (best >= beta) return best; if (best > alpha) alpha = best; }
      else { if (best <= alpha) return best; if (best < beta) beta = best; }
    }

    const DELTA = 200; // delta pruning margin
    let moves = Chess.pseudoMoves(state);
    if (!inChk) moves = moves.filter(function (m) { return m.captured || m.promotion; });

    let anyLegal = false;
    for (const m of orderMoves(moves)) {
      // Delta pruning: even winning this capture outright can't affect the
      // window, so don't bother searching it.
      if (!inChk && !m.promotion) {
        const gain = VALUES[m.captured[1]] + DELTA;
        if (maximizing ? standPat + gain <= alpha : standPat - gain >= beta) continue;
      }
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue;
      anyLegal = true;
      const score = quiesce(next, alpha, beta);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    if (inChk && !anyLegal) return maximizing ? -MATE : MATE; // checkmated
    return best;
  }

  // Alpha-beta over pseudo-legal moves: each move is applied exactly once and
  // legality is checked by attack lookup on the mover's king (much cheaper
  // than generating fully-legal move lists at every node).
  function search(state, depth, alpha, beta, useQuiesce) {
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    // 50-move rule — but checkmate takes precedence: a mate delivered on the
    // 100th halfmove wins, so when in check we must first look for evasions.
    const fifty = state.halfmove >= 100;
    if (fifty && !Chess.isAttacked(state.board, kingSq, enemy)) return 0;
    let best = maximizing ? -Infinity : Infinity;
    let anyLegal = false;

    for (const m of orderMoves(Chess.pseudoMoves(state))) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue; // illegal: king left in check
      anyLegal = true;
      const score = depth <= 1
        ? (useQuiesce ? quiesce(next, alpha, beta) : evaluate(next.board))
        : search(next, depth - 1, alpha, beta, useQuiesce);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }

    if (!anyLegal) {
      if (Chess.isAttacked(state.board, kingSq, enemy)) {
        return maximizing ? -MATE - depth : MATE + depth; // checkmated (prefer faster mates)
      }
      return 0; // stalemate
    }
    if (fifty) return 0; // in check but escapable: the 50-move draw stands
    return best;
  }

  // Terminal-aware evaluation of the position after a root move — needed at
  // depth 1 (Easy), where a bare evaluate() can't tell a mate from a
  // stalemate and would happily stalemate a won game.
  function rootLeafScore(next, useQuiesce, alpha, beta) {
    if (Chess.legalMoves(next).length === 0) {
      return Chess.inCheck(next, next.turn) ? (next.turn === 'w' ? -MATE : MATE) : 0;
    }
    if (next.halfmove >= 100) return 0;
    return useQuiesce ? quiesce(next, alpha, beta) : evaluate(next.board);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Pick the best move for the side to move. Returns null if game over.
  // useQuiesce extends horizon nodes with a capture-resolution search.
  // positions (optional) is the game's repetition table: a root move that
  // immediately triggers threefold repetition is scored as the draw it is, so
  // the AI avoids repeating when winning and heads for it when losing.
  //
  // With a pruned root window, a move that fails low returns a BOUND that can
  // exactly equal the best score, so "equal scores" at the root are NOT real
  // ties — collecting them and picking randomly plays near-random moves.
  // Instead, variety comes from shuffling before the (stable) ordering sort,
  // and only a STRICTLY better score replaces the best move: with an open
  // far window, any strictly better score is exact.
  function bestMove(state, depth, useQuiesce, positions) {
    const moves = Chess.legalMoves(state);
    if (moves.length === 0) return null;
    const maximizing = state.turn === 'w';
    let best = null;
    let bestScore = maximizing ? -Infinity : Infinity;
    let alpha = -Infinity, beta = Infinity;

    for (const m of orderMoves(shuffle(moves))) {
      const next = Chess.applyMove(state, m);
      const score = (positions && (positions[Chess.positionKey(next)] || 0) >= 2)
        ? 0 // this move makes the position's third occurrence: a draw
        : depth <= 1
          ? rootLeafScore(next, useQuiesce, alpha, beta)
          : search(next, depth - 1, alpha, beta, useQuiesce);
      if (best === null || (maximizing ? score > bestScore : score < bestScore)) {
        bestScore = score;
        best = m;
      }
      if (maximizing) { if (bestScore > alpha) alpha = bestScore; }
      else { if (bestScore < beta) beta = bestScore; }
    }
    return best;
  }

  global.ChessAI = { bestMove: bestMove, evaluate: evaluate, search: search };
})(typeof window !== 'undefined' ? window : globalThis);
