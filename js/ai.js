/*
 * Chessy AI — iterative-deepening minimax with alpha-beta pruning over the
 * Chess engine, with a Zobrist-keyed transposition table, hash/killer/history
 * move ordering, draw awareness (repetitions against the game history and
 * the search path, dead positions), and (bounded) quiescence search.
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

  // Endgame piece-square tables where the endgame wants different placement
  // than the midgame: the king centralizes instead of hiding, pawns race for
  // promotion. Other piece types use the same table in both phases.
  const PST_EG = {
    P: [
       0,  0,  0,  0,  0,  0,  0,  0,
      80, 80, 80, 80, 80, 80, 80, 80,
      50, 50, 50, 50, 50, 50, 50, 50,
      30, 30, 30, 30, 30, 30, 30, 30,
      15, 15, 15, 15, 15, 15, 15, 15,
       5,  5,  5,  5,  5,  5,  5,  5,
       0,  0,  0,  0,  0,  0,  0,  0,
       0,  0,  0,  0,  0,  0,  0,  0
    ],
    N: PST.N,
    B: PST.B,
    R: PST.R,
    Q: PST.Q,
    K: [
      -50,-40,-30,-20,-20,-30,-40,-50,
      -30,-20,-10,  0,  0,-10,-20,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-30,  0,  0,  0,  0,-30,-30,
      -50,-30,-30,-30,-30,-30,-30,-50
    ]
  };

  // Game phase from non-pawn material: 24 = full midgame, 0 = pawn endgame.
  const PHASE = { P: 0, N: 1, B: 1, R: 2, Q: 4, K: 0 };
  const PHASE_MAX = 24;

  const MOBILITY = { N: 3, B: 3, R: 2, Q: 1 };  // centipawns per reachable square
  const DOUBLED = 12, ISOLATED = 12, SHIELD = 8;
  const PASSED_MG = [0, 5, 10, 20, 35, 60, 80];   // by ranks advanced from home
  const PASSED_EG = [0, 15, 30, 50, 80, 130, 180];

  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const ALL_DIRS = DIAG.concat(ORTHO);
  const N_JUMPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  // Squares a piece can move to (empty or enemy-occupied). Pawns and kings
  // are excluded: pawn play is scored by the structure terms, king freedom is
  // not a middlegame asset.
  function mobility(board, i, type, color) {
    const r = Math.floor(i / 8), c = i % 8;
    let count = 0;
    if (type === 'N') {
      for (const [dr, dc] of N_JUMPS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const p = board[nr * 8 + nc];
        if (!p || p[0] !== color) count++;
      }
      return count;
    }
    const dirs = type === 'B' ? DIAG : type === 'R' ? ORTHO : ALL_DIRS;
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const p = board[nr * 8 + nc];
        if (p) { if (p[0] !== color) count++; break; }
        count++;
        nr += dr; nc += dc;
      }
    }
    return count;
  }

  // Evaluate from White's point of view (positive = good for White).
  // Tapered: midgame and endgame scores are computed side by side and
  // interpolated by remaining material, so the king hides while queens are
  // on and centralizes when they come off, and passed pawns grow as the
  // board empties. Terms: material + PST, mobility, doubled/isolated/passed
  // pawns, and a midgame pawn shield in front of the king.
  function evaluate(board) {
    let mg = 0, eg = 0, phase = 0;
    const pawnFiles = { w: [0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0, 0] };
    const pawnSquares = { w: [], b: [] };
    const kings = { w: -1, b: -1 };

    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const color = p[0], type = p[1];
      // Mirror the square vertically for Black.
      const sq = color === 'w' ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
      phase += PHASE[type];
      let m = VALUES[type] + PST[type][sq];
      let e = VALUES[type] + PST_EG[type][sq];
      if (type === 'P') {
        pawnFiles[color][i % 8]++;
        pawnSquares[color].push(i);
      } else if (type === 'K') {
        kings[color] = i;
      } else {
        const mob = mobility(board, i, type, color) * MOBILITY[type];
        m += mob; e += mob;
      }
      if (color === 'w') { mg += m; eg += e; } else { mg -= m; eg -= e; }
    }

    for (const color of ['w', 'b']) {
      const sign = color === 'w' ? 1 : -1;
      const files = pawnFiles[color];
      const enemyPawns = pawnSquares[color === 'w' ? 'b' : 'w'];
      for (let f = 0; f < 8; f++) {
        if (files[f] > 1) {
          const extra = (files[f] - 1) * DOUBLED;
          mg -= sign * extra; eg -= sign * extra;
        }
      }
      for (const i of pawnSquares[color]) {
        const f = i % 8, r = Math.floor(i / 8);
        if (!(f > 0 && files[f - 1]) && !(f < 7 && files[f + 1])) {
          mg -= sign * ISOLATED; eg -= sign * ISOLATED;
        }
        let passed = true;
        for (const e2 of enemyPawns) {
          const ef = e2 % 8, er = Math.floor(e2 / 8);
          if (Math.abs(ef - f) <= 1 && (color === 'w' ? er < r : er > r)) {
            passed = false;
            break;
          }
        }
        if (passed) {
          const rr = Math.min(Math.max(color === 'w' ? 6 - r : r - 1, 0), 6);
          mg += sign * PASSED_MG[rr]; eg += sign * PASSED_EG[rr];
        }
      }
      // Pawn shield: friendly pawns directly in front of the king (midgame
      // only — the tapering itself retires the term as material comes off).
      const k = kings[color];
      if (k >= 0) {
        const kr = Math.floor(k / 8) + (color === 'w' ? -1 : 1), kc = k % 8;
        if (kr >= 0 && kr < 8) {
          for (let dc = -1; dc <= 1; dc++) {
            const cc = kc + dc;
            if (cc >= 0 && cc < 8 && board[kr * 8 + cc] === color + 'P') mg += sign * SHIELD;
          }
        }
      }
    }

    const ph = Math.min(phase, PHASE_MAX);
    return Math.round((mg * ph + eg * (PHASE_MAX - ph)) / PHASE_MAX);
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
  // skipped whenever the remaining search could cross the 100-halfmove
  // boundary instead (see searchNode).
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

  // Is an en-passant capture actually legal here? Decides whether the ep
  // right belongs to the position's repetition identity: FIDE 9.2.3 says a
  // phantom ep square must not distinguish otherwise-equal positions, but a
  // legally capturable one must. Mirrors Chess.positionKey()'s normalization
  // with a targeted check (only the two adjacent pawns can ever capture).
  function epLegalCapture(state) {
    const e = state.ep;
    const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
    const r = Math.floor(e / 8), c = e % 8;
    const fromRow = turn === 'w' ? r + 1 : r - 1;
    if (fromRow < 0 || fromRow > 7) return false;
    const kingSq = state.board.indexOf(turn + 'K');
    for (const dc of [-1, 1]) {
      const fc = c + dc;
      if (fc < 0 || fc > 7) continue;
      const from = fromRow * 8 + fc;
      if (state.board[from] !== turn + 'P') continue;
      const next = Chess.applyMove(state, {
        from: from, to: e, piece: turn + 'P', captured: enemy + 'P',
        promotion: null, ep: true, castle: null, double: false
      });
      if (!Chess.isAttacked(next.board, kingSq, enemy)) return true;
    }
    return false;
  }

  // Module-level result slots so hashing allocates nothing per node.
  // H1/H2 always include the en-passant file (transposition table identity —
  // conservative: never merges positions that could differ). R1/R2 include it
  // only when an ep capture is actually legal (repetition identity, matching
  // Chess.positionKey() per FIDE 9.2.3).
  let H1 = 0, H2 = 0, R1 = 0, R2 = 0;
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
    if (state.ep !== null) {
      const z = Z_EP + state.ep % 8;
      H1 = (h1 ^ Z1[z]) >>> 0; H2 = (h2 ^ Z2[z]) >>> 0;
      if (epLegalCapture(state)) { h1 ^= Z1[z]; h2 ^= Z2[z]; }
    } else {
      H1 = h1 >>> 0; H2 = h2 >>> 0;
    }
    R1 = h1 >>> 0; R2 = h2 >>> 0;
  }

  function hashKey(state) {
    hashState(state);
    return H1 + ':' + H2;
  }

  function repKey(state) {
    hashState(state);
    return R1 + ':' + R2;
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
      histB: new Int32Array(4096),
      gameCounts: new Map(),          // repetition key ("r1:r2") -> occurrences in the actual game
      path1: [], path2: []            // repetition keys of ancestors on the current search path
    };
  }

  // Does the side to move have at least one legal move? Scans pseudo-legal
  // moves and stops at the first that leaves the king safe — usually the very
  // first one, so this is far cheaper than a full legalMoves().
  function hasLegalMove(state, pseudo) {
    const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    for (const m of (pseudo || Chess.pseudoMoves(state))) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (!Chess.isAttacked(next.board, ks, enemy)) return true;
    }
    return false;
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
    if (Chess.insufficientMaterial(state.board)) return 0; // dead after captures
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    const inChk = Chess.isAttacked(state.board, kingSq, enemy);

    // Terminal states outrank the static evaluation: a stalemate must not
    // stand pat as if the material were live, and the 50-move draw stands
    // unless the position is checkmate (mate takes precedence).
    const pseudo = Chess.pseudoMoves(state);
    if (!hasLegalMove(state, pseudo)) {
      return inChk ? (maximizing ? -(MATE - ply) : (MATE - ply)) : 0;
    }
    if (state.halfmove >= 100) return 0;
    if (qply >= QMAX) return evaluate(state.board);

    let best, standPat = 0;
    if (inChk) {
      best = maximizing ? -Infinity : Infinity; // must evade — no stand-pat
    } else {
      best = standPat = evaluate(state.board); // stand pat: may decline all captures
      if (maximizing) { if (best >= beta) return best; if (best > alpha) alpha = best; }
      else { if (best <= alpha) return best; if (best < beta) beta = best; }
    }

    const DELTA = 200; // delta pruning margin
    const moves = inChk ? pseudo : pseudo.filter(function (m) { return m.captured || m.promotion; });

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
    const inChk = Chess.isAttacked(state.board, kingSq, enemy);
    // 50-move rule — but checkmate takes precedence: a mate delivered on the
    // 100th halfmove wins, so when in check we must first look for evasions.
    const fifty = state.halfmove >= 100;
    if (fifty && !inChk) return 0;

    // Dead position: no sequence of moves can produce mate, so the game is
    // drawn regardless of material count — e.g. capturing a defended rook
    // with the last piece is worth 0, not the rook.
    if (Chess.insufficientMaterial(state.board)) return 0;

    hashState(state);
    const h1 = H1, h2 = H2, r1 = R1, r2 = R2;

    // Repetition awareness. A position scores as a draw when the line makes
    // it the third occurrence overall, or when it closes a cycle within the
    // search itself (both occurrences inside the path — either side could
    // then repeat a third time; this is what makes perpetual check a real
    // resource). A single earlier occurrence in the game history alone is
    // NOT a draw: the position would have to recur twice more.
    for (let j = ctx.path1.length - 1; j >= 0; j--) {
      if (ctx.path1[j] === r1 && ctx.path2[j] === r2) return 0;
    }
    if ((ctx.gameCounts.get(r1 + ':' + r2) || 0) >= 2) return 0;

    // Horizon: evaluate the leaf terminal-aware. A bare evaluate() cannot
    // tell a checkmate from a quiet position or a stalemate from a won one,
    // which let shallow searches walk into (or refuse) forced mates.
    if (depth <= 0) {
      if (ctx.quiesce) return quiesceNode(state, alpha, beta, ply, 0, ctx);
      if (!hasLegalMove(state)) {
        return inChk ? (maximizing ? -(MATE - ply) : (MATE - ply)) : 0;
      }
      if (fifty) return 0; // in check but escapable: the 50-move draw stands
      return evaluate(state.board);
    }

    // Transposition table. The halfmove clock is not part of the hash, so the
    // table is bypassed whenever the remaining search (plus the quiescence
    // bound) could cross the 100-halfmove boundary, where the clock changes
    // the score. Scores are only trusted at the SAME draft (entry.depth ===
    // depth): depth-pure values keep the search equivalent to plain minimax
    // (up to path-dependent repetition draws inside subtrees); the stored
    // best move is useful for ordering at any draft.
    const useTT = state.halfmove + depth + (ctx.quiesce ? QMAX : 0) < 100;
    let ttPk = 0;
    if (useTT) {
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

    ctx.path1.push(r1); ctx.path2.push(r2);
    for (const m of orderMoves(Chess.pseudoMoves(state), ttPk, ply, ctx, turn)) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue; // illegal: king left in check
      anyLegal = true;
      const score = searchNode(next, depth - 1, alpha, beta, ply + 1, ctx);
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
    ctx.path1.pop(); ctx.path2.pop();

    if (!anyLegal) {
      if (inChk) {
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

    // Seed the game's actual occurrence counts (the keys of the repetition
    // table are 4-field FENs, already ep-normalized like our repetition
    // hash), so the search knows which recurrences would be true threefolds.
    if (opts.positions) {
      for (const key of Object.keys(opts.positions)) {
        if (opts.positions[key] > 0) {
          hashState(Chess.parseFen(key));
          ctx.gameCounts.set(R1 + ':' + R2, opts.positions[key]);
        }
      }
    }
    hashState(state);
    const rootRep = R1 + ':' + R2;
    if (!ctx.gameCounts.has(rootRep)) ctx.gameCounts.set(rootRep, 1);

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
          score = it.repDraw ? 0 : searchNode(it.next, d - 1, alpha, beta, 1, ctx);
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
    hashKey: hashKey,
    repKey: repKey
  };
})(typeof window !== 'undefined' ? window : globalThis);
