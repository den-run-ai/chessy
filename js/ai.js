/*
 * Chessy AI — iterative-deepening minimax with alpha-beta pruning over the
 * Chess engine, with a Zobrist-keyed transposition table, hash/killer/history
 * move ordering, piece-square evaluation, and (bounded) quiescence search.
 *
 * Entry points:
 *   think(state, {maxDepth, timeMs, quiesce, positions}) — iterative
 *     deepening from depth 1 up to maxDepth, stopping early when the timeMs
 *     budget runs out (the move from the last COMPLETED iteration is used)
 *     or a forced mate is found. Returns {move, depth, score, nodes}.
 *   bestMove(state, depth, quiesce, positions) — fixed-depth wrapper.
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

  // Mate scores are MATE minus the ply at which mate is delivered, so nearer
  // mates always outrank farther ones. Anything beyond MATE_NEAR is a mate.
  const MATE = 1000000;
  const MATE_NEAR = MATE - 1000;
  const QMAX = 16;          // quiescence ply bound: cut off runaway lines
  const TT_MAX = 1 << 21;   // transposition table entry cap
  const ABORT = { timeUp: true }; // thrown to unwind when the budget expires

  // ---- Zobrist hashing ----
  // Two independent 32-bit hashes per position: h1 keys the table, h2 guards
  // against collisions. The halfmove clock is NOT hashed — probing/storing is
  // skipped near the 50-move horizon instead (see searchNode).
  const PIECE_IDX = {
    wP: 0, wN: 1, wB: 2, wR: 3, wQ: 4, wK: 5,
    bP: 6, bN: 7, bB: 8, bR: 9, bQ: 10, bK: 11
  };
  // Layout: 12*64 piece-square, then turn, 4 castling flags, 8 ep files.
  const Z_TURN = 768, Z_CASTLE = 769, Z_EP = 773, Z_SIZE = 781;

  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  function zobristTable(seed) {
    const rand = mulberry32(seed);
    const table = new Uint32Array(Z_SIZE);
    for (let i = 0; i < Z_SIZE; i++) table[i] = rand();
    return table;
  }
  const Z1 = zobristTable(0x9E3779B9);
  const Z2 = zobristTable(0x85EBCA6B);

  // Module-level result slots so hashing allocates nothing per node.
  let H1 = 0, H2 = 0;
  function hashState(state) {
    let h1 = 0, h2 = 0;
    const board = state.board;
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const z = PIECE_IDX[p] * 64 + i;
      h1 ^= Z1[z]; h2 ^= Z2[z];
    }
    if (state.turn === 'w') { h1 ^= Z1[Z_TURN]; h2 ^= Z2[Z_TURN]; }
    if (state.castling.wK) { h1 ^= Z1[Z_CASTLE]; h2 ^= Z2[Z_CASTLE]; }
    if (state.castling.wQ) { h1 ^= Z1[Z_CASTLE + 1]; h2 ^= Z2[Z_CASTLE + 1]; }
    if (state.castling.bK) { h1 ^= Z1[Z_CASTLE + 2]; h2 ^= Z2[Z_CASTLE + 2]; }
    if (state.castling.bQ) { h1 ^= Z1[Z_CASTLE + 3]; h2 ^= Z2[Z_CASTLE + 3]; }
    if (state.ep !== null) { const z = Z_EP + state.ep % 8; h1 ^= Z1[z]; h2 ^= Z2[z]; }
    H1 = h1 >>> 0; H2 = h2 >>> 0;
  }

  function hashKey(state) {
    hashState(state);
    return H1 + ':' + H2;
  }

  // ---- Transposition table ----
  const EXACT = 0, LOWER = 1, UPPER = 2;

  function ttStore(ctx, h1, h2, depth, ply, score, flag, movePk) {
    // Mate scores are stored relative to THIS node (distance-to-mate), so an
    // entry stays correct no matter what ply the position recurs at.
    if (score > MATE_NEAR) score += ply;
    else if (score < -MATE_NEAR) score -= ply;
    if (ctx.tt.size >= TT_MAX && !ctx.tt.has(h1)) return;
    ctx.tt.set(h1, { h2: h2, depth: depth, score: score, flag: flag, move: movePk });
  }

  // Pack a move into one int for TT/killer storage and identity checks.
  const PROMO_IDX = { Q: 1, R: 2, B: 3, N: 4 };
  function packMove(m) {
    return (m.from << 9) | (m.to << 3) | (m.promotion ? PROMO_IDX[m.promotion] : 0);
  }

  function makeCtx(quiesce, deadline) {
    return {
      quiesce: !!quiesce,
      deadline: deadline,
      nodes: 0,
      tt: new Map(),
      killers: [],                    // per-ply [primary, secondary] packed quiet moves
      histW: new Int32Array(4096),    // history heuristic: cutoff counts by from*64+to
      histB: new Int32Array(4096)
    };
  }

  function checkTime(ctx) {
    ctx.nodes++;
    if ((ctx.nodes & 1023) === 0 && Date.now() >= ctx.deadline) throw ABORT;
  }

  // Move ordering: hash move, promotions, captures (MVV-LVA), killer moves,
  // then quiet moves by history score.
  function orderMoves(moves, ttPk, ply, ctx, turn) {
    const killers = ctx.killers[ply];
    const hist = turn === 'w' ? ctx.histW : ctx.histB;
    for (const m of moves) {
      const pk = packMove(m);
      let s;
      if (pk === ttPk) s = 2e9;
      else if (m.promotion) s = 1e9 + VALUES[m.promotion];
      else if (m.captured) s = 1e8 + 10 * VALUES[m.captured[1]] - VALUES[m.piece[1]];
      else if (killers && pk === killers[0]) s = 1e7;
      else if (killers && pk === killers[1]) s = 1e7 - 1;
      else s = hist[m.from * 64 + m.to];
      m.order = s;
    }
    return moves.sort(function (a, b) { return b.order - a.order; });
  }

  function recordQuietCutoff(ctx, m, ply, depth, turn) {
    const pk = packMove(m);
    const killers = ctx.killers[ply] || (ctx.killers[ply] = [0, 0]);
    if (killers[0] !== pk) { killers[1] = killers[0]; killers[0] = pk; }
    const hist = turn === 'w' ? ctx.histW : ctx.histB;
    hist[m.from * 64 + m.to] += depth * depth;
  }

  // Quiescence search: at the horizon, keep resolving captures/promotions
  // (and check evasions) until the position is quiet, so the evaluation never
  // stops in the middle of an exchange (the "horizon effect"). Bounded to
  // QMAX plies so pathological lines can't run away.
  function quiesceNode(state, alpha, beta, ply, qply, ctx) {
    checkTime(ctx);
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    if (qply >= QMAX) return evaluate(state.board);
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
    for (const m of orderMoves(moves, 0, ply, ctx, turn)) {
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
      const score = quiesceNode(next, alpha, beta, ply + 1, qply + 1, ctx);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    if (inChk && !anyLegal) return maximizing ? -(MATE - ply) : (MATE - ply); // checkmated
    return best;
  }

  // Alpha-beta over pseudo-legal moves: each move is applied exactly once and
  // legality is checked by attack lookup on the mover's king (much cheaper
  // than generating fully-legal move lists at every node).
  function searchNode(state, depth, alpha, beta, ply, ctx) {
    checkTime(ctx);
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    // 50-move rule — but checkmate takes precedence: a mate delivered on the
    // 100th halfmove wins, so when in check we must first look for evasions.
    const fifty = state.halfmove >= 100;
    if (fifty && !Chess.isAttacked(state.board, kingSq, enemy)) return 0;

    // Transposition table. The halfmove clock is not part of the hash, so the
    // table is bypassed near the 50-move horizon where the clock changes the
    // score. Scores are only trusted at the SAME draft (entry.depth === depth):
    // depth-pure values keep the search exactly equivalent to plain minimax;
    // the stored best move is useful for ordering at any draft.
    const useTT = state.halfmove < 90;
    let h1 = 0, h2 = 0, ttPk = 0;
    if (useTT) {
      hashState(state);
      h1 = H1; h2 = H2;
      const e = ctx.tt.get(h1);
      if (e && e.h2 === h2) {
        ttPk = e.move;
        if (e.depth === depth) {
          let s = e.score;
          if (s > MATE_NEAR) s -= ply;
          else if (s < -MATE_NEAR) s += ply;
          if (e.flag === EXACT) return s;
          if (e.flag === LOWER) { if (s >= beta) return s; if (s > alpha) alpha = s; }
          else { if (s <= alpha) return s; if (s < beta) beta = s; }
          if (alpha >= beta) return s;
        }
      }
    }

    const alphaOrig = alpha, betaOrig = beta;
    let best = maximizing ? -Infinity : Infinity;
    let bestPk = 0;
    let anyLegal = false;

    for (const m of orderMoves(Chess.pseudoMoves(state), ttPk, ply, ctx, turn)) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue; // illegal: king left in check
      anyLegal = true;
      const score = depth <= 1
        ? (ctx.quiesce ? quiesceNode(next, alpha, beta, ply + 1, 0, ctx) : evaluate(next.board))
        : searchNode(next, depth - 1, alpha, beta, ply + 1, ctx);
      if (maximizing ? score > best : score < best) {
        best = score;
        bestPk = packMove(m);
      }
      if (maximizing) { if (best > alpha) alpha = best; }
      else { if (best < beta) beta = best; }
      if (beta <= alpha) {
        if (!m.captured && !m.promotion) recordQuietCutoff(ctx, m, ply, depth, turn);
        break;
      }
    }

    if (!anyLegal) {
      if (Chess.isAttacked(state.board, kingSq, enemy)) {
        return maximizing ? -(MATE - ply) : (MATE - ply); // checkmated (nearer mates score higher)
      }
      return 0; // stalemate
    }
    if (fifty) return 0; // in check but escapable: the 50-move draw stands

    if (useTT) {
      const flag = best <= alphaOrig ? UPPER : best >= betaOrig ? LOWER : EXACT;
      ttStore(ctx, h1, h2, depth, ply, best, flag, bestPk);
    }
    return best;
  }

  // Terminal-aware evaluation of the position after a root move — needed at
  // depth 1 (Easy), where a bare evaluate() can't tell a mate from a
  // stalemate and would happily stalemate a won game.
  function rootLeafScore(next, ctx, alpha, beta) {
    if (Chess.legalMoves(next).length === 0) {
      return Chess.inCheck(next, next.turn) ? (next.turn === 'w' ? -(MATE - 1) : (MATE - 1)) : 0;
    }
    if (next.halfmove >= 100) return 0;
    return ctx.quiesce ? quiesceNode(next, alpha, beta, 1, 0, ctx) : evaluate(next.board);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Pick the best move for the side to move via iterative deepening.
  // opts: maxDepth (default 3), timeMs (per-move budget; omit for fixed
  // depth), quiesce (extend horizon nodes with capture resolution), positions
  // (the game's repetition table: a root move that immediately triggers
  // threefold repetition is scored as the draw it is, so the AI avoids
  // repeating when winning and heads for it when losing).
  //
  // With a pruned root window, a move that fails low returns a BOUND that can
  // exactly equal the best score, so "equal scores" at the root are NOT real
  // ties — collecting them and picking randomly plays near-random moves.
  // Instead, variety comes from shuffling before the (stable) ordering sort,
  // and only a STRICTLY better score replaces the best move: with an open
  // far window, any strictly better score is exact.
  //
  // When the budget expires mid-iteration, that iteration's partial result is
  // discarded (its "best so far" is biased toward the moves searched first)
  // and the last completed iteration's move is used.
  function think(state, opts) {
    opts = opts || {};
    const maxDepth = Math.max(1, opts.maxDepth || 3);
    const deadline = opts.timeMs ? Date.now() + opts.timeMs : Infinity;
    const moves = Chess.legalMoves(state);
    if (moves.length === 0) return { move: null, depth: 0, score: 0, nodes: 0 };
    const maximizing = state.turn === 'w';
    const ctx = makeCtx(opts.quiesce, deadline);

    const items = orderMoves(shuffle(moves), 0, 0, ctx, state.turn).map(function (m) {
      const next = Chess.applyMove(state, m);
      return {
        move: m,
        next: next,
        repDraw: !!(opts.positions && (opts.positions[Chess.positionKey(next)] || 0) >= 2)
      };
    });

    let best = null, bestScore = 0, completed = 0;

    for (let d = 1; d <= maxDepth; d++) {
      let alpha = -Infinity, beta = Infinity;
      let iterBest = null, iterScore = maximizing ? -Infinity : Infinity;
      let aborted = false;
      for (const it of items) {
        let score;
        try {
          score = it.repDraw ? 0
            : d <= 1 ? rootLeafScore(it.next, ctx, alpha, beta)
            : searchNode(it.next, d - 1, alpha, beta, 1, ctx);
        } catch (e) {
          if (e !== ABORT) throw e;
          aborted = true;
          break;
        }
        if (iterBest === null || (maximizing ? score > iterScore : score < iterScore)) {
          iterScore = score;
          iterBest = it;
        }
        if (maximizing) { if (iterScore > alpha) alpha = iterScore; }
        else { if (iterScore < beta) beta = iterScore; }
      }
      if (aborted) {
        if (best === null && iterBest !== null) { best = iterBest; bestScore = iterScore; }
        break;
      }
      best = iterBest;
      bestScore = iterScore;
      completed = d;
      // Search last iteration's best first: with the tight window it sets up,
      // the other moves usually fail low immediately.
      items.splice(items.indexOf(iterBest), 1);
      items.unshift(iterBest);
      if (Math.abs(bestScore) >= MATE_NEAR) break; // forced mate found — deeper won't help
      if (Date.now() >= deadline) break;
    }

    if (best === null) best = items[0]; // budget died inside depth 1: any legal move
    return { move: best.move, depth: completed || 1, score: bestScore, nodes: ctx.nodes };
  }

  // Fixed-depth compatibility wrappers.
  function bestMove(state, depth, useQuiesce, positions) {
    return think(state, { maxDepth: depth, quiesce: useQuiesce, positions: positions }).move;
  }

  function search(state, depth, alpha, beta, useQuiesce) {
    return searchNode(state, depth, alpha, beta, 0, makeCtx(useQuiesce, Infinity));
  }

  global.ChessAI = {
    bestMove: bestMove,
    think: think,
    evaluate: evaluate,
    search: search,
    hashKey: hashKey
  };
})(typeof window !== 'undefined' ? window : globalThis);
