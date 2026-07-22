/*
 * Chessy AI — iterative-deepening minimax with alpha-beta pruning over the
 * Chess engine, with a Zobrist-keyed transposition table, hash/killer/history
 * move ordering, draw awareness (repetitions against the game history and
 * the search path, dead positions), and (bounded) quiescence search.
 *
 * Entry points:
 *   think(state, {maxDepth, timeMs, nodeLimit, quiesce, positions, seed,
 *     randomize}) — iterative deepening from depth 1 up to maxDepth,
 *     stopping early when the timeMs/nodeLimit budget runs out (the move
 *     from the last COMPLETED iteration is used) or a forced mate is found.
 *     seed makes the root shuffle reproducible; randomize:false disables it
 *     entirely (benchmarks/analysis). Returns {move, depth, score, nodes,
 *     qnodes, cutoffs, researches}.
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

  // Repetition prelude shared by the main search and quiescence. Writes two
  // module-level out-params (no per-node allocation on the hot path):
  //   REP_DRAW — the position scores as a draw;
  //   REP_PLY  — the shallowest search-path ancestor ply the draw closed on,
  //              or Infinity for a path-INDEPENDENT game-history threefold
  //              (which stays cacheable). Callers copy REP_PLY into ctx.repPly.
  // A path cycle fires on the FIRST recurrence (the deliberate twofold
  // heuristic that makes perpetuals visible at shallow depth); a true game-
  // history threefold needs the position to already stand at two occurrences.
  let REP_DRAW = false, REP_PLY = Infinity;
  function checkRep(ctx, r1, r2) {
    for (let j = ctx.path1.length - 1; j >= 0; j--) {
      if (ctx.path1[j] === r1 && ctx.path2[j] === r2) {
        REP_DRAW = true; REP_PLY = j; return;
      }
    }
    if ((ctx.gameCounts.get(r1 + ':' + r2) || 0) >= 2) { REP_DRAW = true; REP_PLY = Infinity; return; }
    REP_DRAW = false; REP_PLY = Infinity;
  }

  // ---- Transposition table ----
  const EXACT = 0, LOWER = 1, UPPER = 2;

  function ttStore(ctx, h1, h2, depth, ply, score, flag, movePk, nullSafe) {
    // Mate scores are stored relative to THIS node (distance-to-mate), so an
    // entry stays correct no matter what ply the position recurs at.
    if (score > MATE_NEAR) score += ply;
    else if (score < -MATE_NEAR) score -= ply;
    if (ctx.tt.size >= TT_MAX && !ctx.tt.has(h1)) return;
    // ns: the score is a sound null-window bound (see the probe/store notes).
    ctx.tt.set(h1, { h2: h2, depth: depth, score: score, flag: flag, move: movePk, ns: nullSafe });
  }

  // Pack a move into one int for TT/killer storage and identity checks.
  const PROMO_IDX = { Q: 1, R: 2, B: 3, N: 4 };
  function packMove(m) {
    return (m.from << 9) | (m.to << 3) | (m.promotion ? PROMO_IDX[m.promotion] : 0);
  }

  function makeCtx(quiesce, deadline, nodeLimit) {
    return {
      quiesce: !!quiesce,
      deadline: deadline,
      // Only a missing/null limit means "unbounded". An explicit 0 is a real
      // (already-exhausted) budget: it must return without searching, not be
      // silently promoted to Infinity by a falsy check.
      nodeLimit: nodeLimit == null ? Infinity : nodeLimit,
      nodes: 0,
      qnodes: 0,       // quiescence share of nodes
      cutoffs: 0,      // beta cutoffs in the main search
      researches: 0,   // scout/aspiration repeats at full window
      tt: new Map(),
      killers: [],                    // per-ply [primary, secondary] packed quiet moves
      histW: new Int32Array(4096),    // history heuristic: cutoff counts by from*64+to
      histB: new Int32Array(4096),
      gameCounts: new Map(),          // repetition key ("r1:r2") -> occurrences in the actual game
      path1: [], path2: [],           // repetition keys of ancestors on the current search path
      repPly: Infinity                // out-param: shallowest ancestor ply the last-searched subtree's score depended on
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
    // Check the node budget BEFORE counting this node, so exactly nodeLimit
    // nodes are actually evaluated (counting first would abort on entry to
    // node nodeLimit+1 while still incrementing it — an off-by-one that
    // reports one more node than was searched).
    if (ctx.nodes >= ctx.nodeLimit) throw ABORT;
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
    ctx.qnodes++;
    // Repetition-dependency out-param, same contract as searchNode: the
    // shallowest ancestor ply this node's score depended on (Infinity = safe).
    ctx.repPly = Infinity;
    if (Chess.insufficientMaterial(state.board)) return 0; // dead after captures
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const maximizing = turn === 'w';
    const inChk = Chess.isAttacked(state.board, kingSq, enemy);

    // Repetition awareness inside quiescence (shared prelude with searchNode).
    // A capture or promotion — quiescence's staple — is irreversible and resets
    // the halfmove clock, and no position can recur without a >=4-ply reversible
    // round trip, so below halfmove 4 no path cycle or game-history threefold is
    // possible and the hash/scan/push is skipped entirely. Above it (a check-
    // evasion chain) a repetition must score 0 exactly as in the main search:
    // otherwise a threefold first seen past the horizon (e.g. a check evasion
    // into it) is scored by its material, and a path-dependent draw would leave
    // repPly = Infinity and let an ancestor cache a score its history can't hold.
    let rr1 = 0, rr2 = 0;
    const trackRep = state.halfmove >= 4;
    if (trackRep) {
      hashState(state);
      rr1 = R1; rr2 = R2;
      checkRep(ctx, rr1, rr2);
      if (REP_DRAW) { ctx.repPly = REP_PLY; return 0; }
    }

    // Terminal states outrank the static evaluation: a stalemate must not
    // stand pat as if the material were live, and the 50-move draw stands
    // unless the position is checkmate (mate takes precedence). These are
    // position-intrinsic (repPly stays Infinity), so they return before the
    // path push below.
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

    // Only a node that survives to explore children joins the search path, so a
    // deeper quiescence line can detect a cycle back to here.
    if (trackRep) { ctx.path1.push(rr1); ctx.path2.push(rr2); }
    let repMin = Infinity;

    const DELTA = 200; // delta pruning margin
    const moves = inChk ? pseudo : pseudo.filter(function (m) { return m.captured || m.promotion; });

    for (const m of orderMoves(moves, 0, ply, ctx, turn)) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue;
      // Delta pruning: even winning this capture outright can't affect the
      // window, so don't bother searching it — UNLESS it gives check (a
      // checking capture can be mate, e.g. Qxg7#, regardless of material gain).
      // Only on a REAL window (width > 1): under a null window the delta-pruned
      // value is not a sound bound, so a PVS scout could miss a better move
      // (false fail-low). Disabling it there keeps the scout a plain, sound
      // alpha-beta bound (see the residual-unsoundness note in searchNode).
      if (!inChk && !m.promotion && beta - alpha > 1) {
        const gain = VALUES[m.captured[1]] + DELTA;
        if ((maximizing ? standPat + gain <= alpha : standPat - gain >= beta) &&
            !Chess.isAttacked(next.board, next.board.indexOf(enemy + 'K'), turn)) {
          continue;
        }
      }
      const score = quiesceNode(next, alpha, beta, ply + 1, qply + 1, ctx);
      if (ctx.repPly < repMin) repMin = ctx.repPly; // min over searched children
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    if (trackRep) { ctx.path1.pop(); ctx.path2.pop(); }
    ctx.repPly = repMin; // propagate the subtree's repetition dependency upward
    return best;
  }

  // Alpha-beta over pseudo-legal moves: each move is applied exactly once and
  // legality is checked by attack lookup on the mover's king (much cheaper
  // than generating fully-legal move lists at every node).
  function searchNode(state, depth, alpha, beta, ply, ctx) {
    checkTime(ctx);
    // Repetition-dependency out-param (read by the PARENT after this call
    // returns): the shallowest ancestor ply this node's score depended on.
    // Infinity = the score is position-intrinsic and safe to cache.
    ctx.repPly = Infinity;
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

    // Repetition awareness (shared with quiescence via checkRep). A position
    // scores as a draw when the line makes it the third occurrence against the
    // ACTUAL game history, or when it closes a cycle within the search path.
    // The cycle rule fires on the FIRST recurrence — the standard engine
    // "twofold" heuristic, NOT exact threefold counting — which is what makes
    // perpetual check a real resource at shallow depth. A path draw is a
    // property of the PATH (it closed on the ancestor at ply REP_PLY): flag it
    // via ctx.repPly so no ancestor above caches a score built on it. A true
    // game-history threefold is path-independent (REP_PLY = Infinity) and stays
    // cacheable.
    checkRep(ctx, r1, r2);
    if (REP_DRAW) { ctx.repPly = REP_PLY; return 0; }

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
    // (up to path-dependent repetition draws inside subtrees, and — with
    // quiescence on — the window-sensitivity of delta pruning, which makes
    // leaf values depend on the alpha/beta they were searched under); the
    // stored best move is useful for ordering at any draft.
    const useTT = state.halfmove + depth + (ctx.quiesce ? QMAX : 0) < 100;
    let ttPk = 0;
    if (useTT) {
      const e = ctx.tt.get(h1);
      if (e && e.h2 === h2) {
        ttPk = e.move;
        // Null-window-scout safety. A score a WIDER search produced with delta
        // pruning active is not a sound scout bound (delta pruning bounds a
        // capture by material + margin, which a null window's tight alpha can
        // expose as false — see quiesceNode). Withhold such a score from a
        // quiescent null scout; the hash move above is still used for ordering.
        const scoreSafe = e.ns || !(ctx.quiesce && beta - alpha <= 1);
        if (e.depth === depth && scoreSafe) {
          let s = e.score;
          if (s > MATE_NEAR) s -= ply;
          else if (s < -MATE_NEAR) s += ply;
          if (e.flag === EXACT) return s;
          // A TT bound that already satisfies the window ends the search at
          // this node exactly like an in-loop beta cutoff, so it must feed the
          // same counter — otherwise transposition-heavy positions under-report
          // cutoffs and benchmark deltas that shift TT hit rates are misleading.
          if (e.flag === LOWER) { if (s >= beta) { ctx.cutoffs++; return s; } if (s > alpha) alpha = s; }
          else { if (s <= alpha) { ctx.cutoffs++; return s; } if (s < beta) beta = s; }
          if (alpha >= beta) { ctx.cutoffs++; return s; }
        }
      }
    }

    const alphaOrig = alpha, betaOrig = beta;
    let best = maximizing ? -Infinity : Infinity;
    let bestPk = 0;
    let anyLegal = false;
    let repMin = Infinity; // shallowest ancestor ply any child's score depended on

    ctx.path1.push(r1); ctx.path2.push(r2);
    for (const m of orderMoves(Chess.pseudoMoves(state), ttPk, ply, ctx, turn)) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue; // illegal: king left in check
      // Principal variation search: the first legal move gets the full
      // window; later moves get a null-window scout ("can this beat the
      // bound at all?") and repeat at the full window only when the scout
      // says yes. The bound is always finite by then (the first move set
      // it), so the null window is well-formed. A child's repetition
      // dependency is the MINIMUM over its scout and re-search — a path-
      // dependent draw seen by either must reach the TT guard below.
      //
      // PVS is a SELECTIVE heuristic, not a bit-exact minimax transform, and
      // its exactness is validated empirically rather than proven. Two things
      // keep a scout from silently discarding a better move at the leaves it
      // searches itself: quiescence delta pruning is disabled under a null
      // window (see quiesceNode), so those leaves are plain alpha-beta bounds
      // (without that guard, depth-2 quiescent PVS picked b8c6 -7 over the true
      // best d7d5 -307 — pinned in test/ai-tactics.js against an independent
      // minimax oracle). The residual, deliberately-accepted unsoundness:
      //   (1) a scout may return a TT entry stored by a WIDER, delta-pruned
      //       search of the same node — that cached value is not a guaranteed
      //       sound bound, so the null-window guard does not make every scout
      //       exact, only the ones that reach their own leaves;
      //   (2) delta pruning's leaf values are window-sensitive in general (a
      //       value depends on the window a move was searched under — a
      //       property plain alpha-beta shares, not a PVS defect).
      // So exact centipawns can differ from a hypothetical no-delta-pruning
      // search. We keep the tradeoff (sound over fast) at the null-window
      // guard and do not restore delta pruning there; the 16-position bench
      // (--exact: 0 move/score divergences vs the no-PVS baseline) and the
      // tactics suite are the empirical evidence that move selection holds.
      let score, childRep;
      if (!anyLegal) {
        score = searchNode(next, depth - 1, alpha, beta, ply + 1, ctx);
        childRep = ctx.repPly;
      } else if (maximizing) {
        score = searchNode(next, depth - 1, alpha, alpha + 1, ply + 1, ctx);
        childRep = ctx.repPly;
        if (score > alpha && score < beta) {
          ctx.researches++;
          score = searchNode(next, depth - 1, alpha, beta, ply + 1, ctx);
          if (ctx.repPly < childRep) childRep = ctx.repPly;
        }
      } else {
        score = searchNode(next, depth - 1, beta - 1, beta, ply + 1, ctx);
        childRep = ctx.repPly;
        if (score < beta && score > alpha) {
          ctx.researches++;
          score = searchNode(next, depth - 1, alpha, beta, ply + 1, ctx);
          if (ctx.repPly < childRep) childRep = ctx.repPly;
        }
      }
      anyLegal = true;
      if (childRep < repMin) repMin = childRep;
      if (maximizing ? score > best : score < best) {
        best = score;
        bestPk = packMove(m);
      }
      if (maximizing) { if (best > alpha) alpha = best; }
      else { if (best < beta) beta = best; }
      if (beta <= alpha) {
        ctx.cutoffs++;
        if (!m.captured && !m.promotion) recordQuietCutoff(ctx, m, ply, depth, turn);
        break;
      }
    }
    ctx.path1.pop(); ctx.path2.pop();
    // Propagate the subtree's repetition dependency to the parent. A cycle
    // whose top is at or below THIS node (repMin >= ply) is contained in the
    // subtree — any path reaching this position again would contain the same
    // cycle, so the score is still position-intrinsic here.
    ctx.repPly = repMin;

    if (!anyLegal) {
      if (inChk) {
        return maximizing ? -(MATE - ply) : (MATE - ply); // checkmated (nearer mates score higher)
      }
      return 0; // stalemate
    }
    if (fifty) return 0; // in check but escapable: the 50-move draw stands

    // Never cache a score that depended on ancestors ABOVE this node: a
    // transposition reaching this position along a different path would
    // inherit a draw (or bound) that its own history does not justify.
    if (useTT && repMin >= ply) {
      const flag = best <= alphaOrig ? UPPER : best >= betaOrig ? LOWER : EXACT;
      // Null-window-safe only when no delta pruning could have shaped this
      // score: quiescence disabled, or this node itself ran under a (null)
      // window that disables delta pruning throughout its subtree.
      const nullSafe = !ctx.quiesce || betaOrig - alphaOrig <= 1;
      ttStore(ctx, h1, h2, depth, ply, best, flag, bestPk, nullSafe);
    }
    return best;
  }

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor((rand() / 4294967296) * (i + 1));
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
    // Root variety: seeded (reproducible), default Math.random, or none.
    // Deterministic modes exist for benchmarks, analysis and tests; casual
    // play keeps its randomness.
    const rand = opts.seed != null ? mulberry32(opts.seed | 0)
      : opts.randomize === false ? null
      : function () { return Math.random() * 4294967296; };
    // The game's repetition table: the explicit option wins, else a full
    // game state carries its own (bare parseFen() states have neither).
    const positions = opts.positions || state.positions || null;
    // A game that is already over — mate, stalemate, the 50-move rule, a
    // dead position, or a completed threefold — has no move to pick even
    // when legal moves exist. The UI never asks in that case, but analysis
    // callers must not get a "best move" from a finished game.
    const status = Chess.gameStatus(
      Object.assign({}, state, { positions: positions || {} }));
    if (status.over) return { move: null, depth: 0, score: 0, nodes: 0, qnodes: 0, cutoffs: 0, researches: 0 };
    const moves = Chess.legalMoves(state);
    const maximizing = state.turn === 'w';
    const ctx = makeCtx(opts.quiesce, deadline, opts.nodeLimit);

    // Seed the game's actual occurrence counts (the keys of the repetition
    // table are 4-field FENs, already ep-normalized like our repetition
    // hash), so the search knows which recurrences would be true threefolds.
    if (positions) {
      for (const key of Object.keys(positions)) {
        if (positions[key] > 0) {
          hashState(Chess.parseFen(key));
          ctx.gameCounts.set(R1 + ':' + R2, positions[key]);
        }
      }
    }
    hashState(state);
    const rootRep = R1 + ':' + R2;
    if (!ctx.gameCounts.has(rootRep)) ctx.gameCounts.set(rootRep, 1);
    // The root is a permanent search-path ancestor: a line that returns to
    // the current position closes a cycle and must score as the draw either
    // side could then force (otherwise a perpetual that lands exactly on
    // the root at the horizon is missed).
    ctx.path1.push(R1);
    ctx.path2.push(R2);

    const items = orderMoves(rand ? shuffle(moves, rand) : moves, 0, 0, ctx, state.turn).map(function (m) {
      const next = Chess.applyMove(state, m);
      return {
        move: m,
        next: next,
        score: 0,
        repDraw: !!(positions && (positions[Chess.positionKey(next)] || 0) >= 2)
      };
    });

    let best = null, bestScore = 0, completed = 0;

    for (let d = 1; d <= maxDepth; d++) {
      // Aspiration window: from depth 2, expect this iteration to score
      // near the previous one. A wrong guess fails the whole root — then
      // the failed side re-searches doubled, eventually falling back to
      // the full window; a root fail-low/high never trusts the bound, it
      // widens and re-searches. Like PVS (which it sits on top of),
      // aspiration is a SELECTIVE heuristic, not a proven-exact transform:
      // delta pruning still runs UNDER the finite aspiration window at PV
      // nodes, and that window is not null (delta pruning is disabled only
      // when beta - alpha <= 1). So an in-window value can be a delta-pruning
      // artifact that a full-window search would not produce, and aspiration
      // may accept it without widening — it reproduces the full-window RESULT
      // in practice, but that is validated empirically (on the reviewer's FEN
      // r1b1kr2/p4pp1/np6/2pqp2P/P3PBBP/NPP1PN2/5P2/R3K2R b KQq - 2 15 the
      // accepted value matches the independent full-window score; the
      // 16-position --exact bench shows 0 move/score divergences vs no
      // aspiration), not guaranteed. This window-sensitivity is a property of
      // delta pruning that plain alpha-beta shares, not an aspiration defect;
      // we keep it rather than restore faster, more aggressive pruning. Mate
      // scores never aspire.
      let delta = 50;
      let lo = -Infinity, hi = Infinity;
      if (d >= 2 && Math.abs(bestScore) < MATE_NEAR) {
        lo = bestScore - delta; hi = bestScore + delta;
      }
      let iterBest = null, iterScore = 0;
      let aborted = false;
      for (;;) { // aspiration attempts
        let alpha = lo, beta = hi;
        iterBest = null; iterScore = maximizing ? -Infinity : Infinity;
        for (const it of items) {
          let score;
          try {
            // Root PVS mirrors searchNode: full window until some move has
            // set a finite bound, then scout + re-search. A repDraw counts
            // as a searched move (its 0 tightened the bound).
            if (it.repDraw) score = 0;
            else if (iterBest === null) score = searchNode(it.next, d - 1, alpha, beta, 1, ctx);
            else if (maximizing) {
              score = searchNode(it.next, d - 1, alpha, alpha + 1, 1, ctx);
              if (score > alpha && score < beta) {
                ctx.researches++;
                score = searchNode(it.next, d - 1, alpha, beta, 1, ctx);
              }
            } else {
              score = searchNode(it.next, d - 1, beta - 1, beta, 1, ctx);
              if (score < beta && score > alpha) {
                ctx.researches++;
                score = searchNode(it.next, d - 1, alpha, beta, 1, ctx);
              }
            }
          } catch (e) {
            if (e !== ABORT) throw e;
            aborted = true;
            break;
          }
          it.score = score;
          if (iterBest === null || (maximizing ? score > iterScore : score < iterScore)) {
            iterScore = score;
            iterBest = it;
          }
          if (maximizing) { if (iterScore > alpha) alpha = iterScore; }
          else { if (iterScore < beta) beta = iterScore; }
        }
        if (aborted) break;
        // Root fail-low/high: every score is only a bound, so the "best"
        // is not trustworthy — widen the failed side, search the depth again.
        if (iterScore <= lo) { ctx.researches++; delta *= 2; lo = delta > 800 ? -Infinity : iterScore - delta; continue; }
        if (iterScore >= hi) { ctx.researches++; delta *= 2; hi = delta > 800 ? Infinity : iterScore + delta; continue; }
        break;
      }
      if (aborted) {
        // A partial (aborted) aspiration attempt is discarded like any
        // partial iteration; depth 1 never aspires, so the emergency
        // "budget died inside depth 1" result is still full-window.
        if (best === null && iterBest !== null) { best = iterBest; bestScore = iterScore; }
        break;
      }
      best = iterBest;
      bestScore = iterScore;
      completed = d;
      // Order the whole root by this iteration's scores (fail-low moves
      // carry bounds — fine as an ordering heuristic), best strictly first:
      // with the tight window the best sets up, later moves usually fail
      // low immediately.
      items.sort(function (a, b) { return maximizing ? b.score - a.score : a.score - b.score; });
      items.splice(items.indexOf(iterBest), 1);
      items.unshift(iterBest);
      if (Math.abs(bestScore) >= MATE_NEAR) break; // forced mate found — deeper won't help
      if (Date.now() >= deadline) break;
      if (ctx.nodes >= ctx.nodeLimit) break;
    }

    if (best === null) best = items[0]; // budget died inside depth 1: any legal move
    // Report the last FULLY completed depth (0 if even depth 1 was aborted):
    // a partial iteration's move is still returned, but must not be reported
    // as a completed search draft.
    return {
      move: best.move, depth: completed, score: bestScore, nodes: ctx.nodes,
      qnodes: ctx.qnodes, cutoffs: ctx.cutoffs, researches: ctx.researches
    };
  }

  // Fixed-depth compatibility wrappers.
  function bestMove(state, depth, useQuiesce, positions) {
    return think(state, { maxDepth: depth, quiesce: useQuiesce, positions: positions }).move;
  }

  // Bare alpha-beta entry point. opts (mainly for tests):
  //   ancestors — FENs seeded as search-path ancestors, so path-repetition
  //     handling can be exercised deterministically;
  //   ctx — reuse a context (and its transposition table) across calls.
  function search(state, depth, alpha, beta, useQuiesce, opts) {
    opts = opts || {};
    const ctx = opts.ctx || makeCtx(useQuiesce, Infinity);
    // Baseline path depth. searchNode pushes an ancestor key per ply and pops
    // it on the way out, but an ABORT thrown mid-search (a finite nodeLimit
    // running out) unwinds straight past those pops. Restoring the path to its
    // pre-call length — rather than blindly subtracting only the seeded count —
    // discards BOTH our seeded ancestors and any stragglers a partial search
    // left behind, so a reused context (search's `ctx` option) can't inherit
    // stale ancestors that turn a fresh, non-drawn search into a false
    // repetition draw.
    const base = ctx.path1.length;
    const seeded = opts.ancestors || [];
    for (const fen of seeded) {
      hashState(Chess.parseFen(fen));
      ctx.path1.push(R1);
      ctx.path2.push(R2);
    }
    try {
      return searchNode(state, depth, alpha, beta, seeded.length, ctx);
    } finally {
      ctx.path1.length = base;
      ctx.path2.length = base;
    }
  }

  global.ChessAI = {
    bestMove: bestMove,
    think: think,
    evaluate: evaluate,
    search: search,
    makeCtx: makeCtx,
    hashKey: hashKey,
    repKey: repKey
  };
})(typeof window !== 'undefined' ? window : globalThis);
