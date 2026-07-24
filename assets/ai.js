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

  // Material for MOVE ORDERING (MVV-LVA). Deliberately a single representative
  // value per type: ordering only needs a stable ranking, so keeping these
  // constant isolates the evaluation change below to eval alone (the ordering
  // that reads VALUES is unchanged).
  const VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

  // Phase-specific material for EVALUATION. The endgame revalues pieces the
  // way real endgames do: pawns and rooks gain, minor pieces lose a little,
  // the queen drops. Interpolated with the piece-square tables below by the
  // same game-phase weight, so material and placement taper coherently.
  const VALUES_MG = { P: 82, N: 337, B: 365, R: 477, Q: 1025, K: 0 };
  const VALUES_EG = { P: 94, N: 281, B: 297, R: 512, Q: 936, K: 0 };

  // Piece-square tables from White's perspective, index 0 = a8. A coherent,
  // tuned tapered set: every piece — not just pawns and the king — now has a
  // distinct endgame table, and the two phases are blended by remaining
  // non-pawn material. Values are centipawns and already include their
  // phase-specific piece value's positional intent; the raw material value
  // (VALUES_MG / VALUES_EG) is added on top in evaluate().
  //
  // PROVENANCE / ATTRIBUTION: these twelve tables and the VALUES_MG/VALUES_EG
  // piece values are the "PeSTO" coefficients by Ronald Friederich (author of
  // the RofChade engine), originally published by him on the TalkChess forum
  // and mirrored on the Chess Programming Wiki. They are used here as functional
  // numerical tuning outputs in a dictated piece×square layout — facts/data,
  // not copyrightable expression — with attribution retained (see
  // THIRD_PARTY_NOTICES.md). The CPW page is a secondary reference only, NOT the
  // licensing source (its sitewide CC BY-SA 3.0 marking is not MIT-compatible
  // and does not govern this reuse). Decision and rationale recorded in #72.
  const PST = {
    P: [
        0,   0,   0,   0,   0,   0,   0,   0,
       98, 134,  61,  95,  68, 126,  34, -11,
       -6,   7,  26,  31,  65,  56,  25, -20,
      -14,  13,   6,  21,  23,  12,  17, -23,
      -27,  -2,  -5,  12,  17,   6,  10, -25,
      -26,  -4,  -4, -10,   3,   3,  33, -12,
      -35,  -1, -20, -23, -15,  24,  38, -22,
        0,   0,   0,   0,   0,   0,   0,   0
    ],
    N: [
      -167, -89, -34, -49,  61, -97, -15,-107,
       -73, -41,  72,  36,  23,  62,   7, -17,
       -47,  60,  37,  65,  84, 129,  73,  44,
        -9,  17,  19,  53,  37,  69,  18,  22,
       -13,   4,  16,  13,  28,  19,  21,  -8,
       -23,  -9,  12,  10,  19,  17,  25, -16,
       -29, -53, -12,  -3,  -1,  18, -14, -19,
      -105, -21, -58, -33, -17, -28, -19, -23
    ],
    B: [
      -29,   4, -82, -37, -25, -42,   7,  -8,
      -26,  16, -18, -13,  30,  59,  18, -47,
      -16,  37,  43,  40,  35,  50,  37,  -2,
       -4,   5,  19,  50,  37,  37,   7,  -2,
       -6,  13,  13,  26,  34,  12,  10,   4,
        0,  15,  15,  15,  14,  27,  18,  10,
        4,  15,  16,   0,   7,  21,  33,   1,
      -33,  -3, -14, -21, -13, -12, -39, -21
    ],
    R: [
       32,  42,  32,  51,  63,   9,  31,  43,
       27,  32,  58,  62,  80,  67,  26,  44,
       -5,  19,  26,  36,  17,  45,  61,  16,
      -24, -11,   7,  26,  24,  35,  -8, -20,
      -36, -26, -12,  -1,   9,  -7,   6, -23,
      -45, -25, -16, -17,   3,   0,  -5, -33,
      -44, -16, -20,  -9,  -1,  11,  -6, -71,
      -19, -13,   1,  17,  16,   7, -37, -26
    ],
    Q: [
      -28,   0,  29,  12,  59,  44,  43,  45,
      -24, -39,  -5,   1, -16,  57,  28,  54,
      -13, -17,   7,   8,  29,  56,  47,  57,
      -27, -27, -16, -16,  -1,  17,  -2,   1,
       -9, -26,  -9, -10,  -2,  -4,   3,  -3,
      -14,   2, -11,  -2,  -5,   2,  14,   5,
      -35,  -8,  11,   2,   8,  15,  -3,   1,
       -1, -18,  -9,  10, -15, -25, -31, -50
    ],
    K: [
      -65,  23,  16, -15, -56, -34,   2,  13,
       29,  -1, -20,  -7,  -8,  -4, -38, -29,
       -9,  24,   2, -16, -20,   6,  22, -22,
      -17, -20, -12, -27, -30, -25, -14, -36,
      -49,  -1, -27, -39, -46, -44, -33, -51,
      -14, -14, -22, -46, -44, -30, -15, -27,
        1,   7,  -8, -64, -43, -16,   9,   8,
      -15,  36,  12, -54,   8, -28,  24,  14
    ]
  };

  // Endgame piece-square tables — a distinct, tuned table per piece (the
  // midgame set's endgame counterpart). The king centralizes instead of
  // hiding, pawns weight toward promotion, and minor/major pieces shift toward
  // their endgame squares.
  const PST_EG = {
    P: [
        0,   0,   0,   0,   0,   0,   0,   0,
      178, 173, 158, 134, 147, 132, 165, 187,
       94, 100,  85,  67,  56,  53,  82,  84,
       32,  24,  13,   5,  -2,   4,  17,  17,
       13,   9,  -3,  -7,  -7,  -8,   3,  -1,
        4,   7,  -6,   1,   0,  -5,  -1,  -8,
       13,   8,   8,  10,  13,   0,   2,  -7,
        0,   0,   0,   0,   0,   0,   0,   0
    ],
    N: [
      -58, -38, -13, -28, -31, -27, -63, -99,
      -25,  -8, -25,  -2,  -9, -25, -24, -52,
      -24, -20,  10,   9,  -1,  -9, -19, -41,
      -17,   3,  22,  22,  22,  11,   8, -18,
      -18,  -6,  16,  25,  16,  17,   4, -18,
      -23,  -3,  -1,  15,  10,  -3, -20, -22,
      -42, -20, -10,  -5,  -2, -20, -23, -44,
      -29, -51, -23, -15, -22, -18, -50, -64
    ],
    B: [
      -14, -21, -11,  -8,  -7,  -9, -17, -24,
       -8,  -4,   7, -12,  -3, -13,  -4, -14,
        2,  -8,   0,  -1,  -2,   6,   0,   4,
       -3,   9,  12,   9,  14,  10,   3,   2,
       -6,   3,  13,  19,   7,  10,  -3,  -9,
      -12,  -3,   8,  10,  13,   3,  -7, -15,
      -14, -18,  -7,  -1,   4,  -9, -15, -27,
      -23,  -9, -23,  -5,  -9, -16,  -5, -17
    ],
    R: [
       13,  10,  18,  15,  12,  12,   8,   5,
       11,  13,  13,  11,  -3,   3,   8,   3,
        7,   7,   7,   5,   4,  -3,  -5,  -3,
        4,   3,  13,   1,   2,   1,  -1,   2,
        3,   5,   8,   4,  -5,  -6,  -8, -11,
       -4,   0,  -5,  -1,  -7, -12,  -8, -16,
       -6,  -6,   0,   2,  -9,  -9, -11,  -3,
       -9,   2,   3,  -1,  -5, -13,   4, -20
    ],
    Q: [
       -9,  22,  22,  27,  27,  19,  10,  20,
      -17,  20,  32,  41,  58,  25,  30,   0,
      -20,   6,   9,  49,  47,  35,  19,   9,
        3,  22,  24,  45,  57,  40,  57,  36,
      -18,  28,  19,  47,  31,  34,  39,  23,
      -16, -27,  15,   6,   9,  17,  10,   5,
      -22, -23, -30, -16, -16, -23, -36, -32,
      -33, -28, -22, -43,  -5, -32, -20, -41
    ],
    K: [
      -74, -35, -18, -18, -11,  15,   4, -17,
      -12,  17,  14,  17,  17,  38,  23,  11,
       10,  17,  23,  15,  20,  45,  44,  13,
       -8,  22,  24,  27,  26,  33,  26,   3,
      -18,  -4,  21,  24,  27,  23,   9, -11,
      -19,  -3,  11,  21,  23,  16,   7,  -9,
      -27, -11,   4,  13,  14,   4,  -5, -17,
      -53, -34, -21, -11, -28, -14, -24, -43
    ]
  };

  // Game phase from non-pawn material: 24 = full midgame, 0 = pawn endgame.
  const PHASE = { P: 0, N: 1, B: 1, R: 2, Q: 4, K: 0 };
  const PHASE_MAX = 24;

  const MOBILITY = { N: 3, B: 3, R: 2, Q: 1 };  // centipawns per reachable square
  const DOUBLED = 12, ISOLATED = 12, SHIELD = 8;
  const PASSED_MG = [0, 5, 10, 20, 35, 60, 80];   // by ranks advanced from home
  const PASSED_EG = [0, 15, 30, 50, 80, 130, 180];

  // ---- King safety (bounded midgame terms; #72) ----
  // Ring pressure weights king-zone attacks by piece and coordinated attacker
  // count; a lone attacker scores zero and the cap stays below half a minor.
  const KING_ATK_WEIGHT = { P: 0, N: 2, B: 2, R: 3, Q: 5, K: 0 };
  // Percent multiplier by distinct attacker count; saturates at seven.
  const KING_ATK_COUNT_MUL = [0, 0, 50, 75, 88, 94, 97, 99];
  const KING_ATK_SCALE = 6;
  const KING_ATK_CAP = 150;
  // Open/semi-open shelter covers the king file and its neighbours; a clear
  // enemy heavy-piece ray through the front ring adds danger.
  const SHELTER_OPEN = 10;     // per king-adjacent file lacking a friendly pawn
  const SHELTER_RAY = 12;      // extra for a clear enemy rook/queen ray
  const SHELTER_CAP = 60;

  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const ALL_DIRS = DIAG.concat(ORTHO);
  const N_JUMPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  // Count mobility and, through RING, attacked enemy-king-ring squares in one
  // walk. Pawns/kings are excluded; `ekr`/`ekc` use -8 to disable ring tallying.
  let RING = 0;
  function mobility(board, i, type, color, ekr, ekc) {
    const r = Math.floor(i / 8), c = i % 8;
    let count = 0, ring = 0;
    if (type === 'N') {
      for (const [dr, dc] of N_JUMPS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const p = board[nr * 8 + nc];
        if (!p || p[0] !== color) count++;
        if (nr >= ekr - 1 && nr <= ekr + 1 && nc >= ekc - 1 && nc <= ekc + 1) ring++;
      }
      RING = ring;
      return count;
    }
    const dirs = type === 'B' ? DIAG : type === 'R' ? ORTHO : ALL_DIRS;
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        // A slider attacks a ring square only up to (and including) the first
        // blocker on the ray — so count ring membership BEFORE the break.
        if (nr >= ekr - 1 && nr <= ekr + 1 && nc >= ekc - 1 && nc <= ekc + 1) ring++;
        const p = board[nr * 8 + nc];
        if (p) { if (p[0] !== color) count++; break; }
        count++;
        nr += dr; nc += dc;
      }
    }
    RING = ring;
    return count;
  }

  // Evaluate from White's point of view (positive = good for White).
  // Tapered: midgame and endgame scores are computed side by side and
  // interpolated by remaining material, so the king hides while queens are
  // on and centralizes when they come off, and passed pawns grow as the
  // board empties. Both phases now use a full, distinct piece-square table
  // per piece and phase-specific material values (VALUES_MG/VALUES_EG), so
  // the taper covers material and placement coherently rather than reusing
  // midgame tables in the endgame. Terms: phase material + PST, mobility,
  // doubled/isolated/passed pawns, a midgame pawn shield in front of the
  // king, and a lone-king mop-up gradient so basic mates convert.
  // `out` is an optional caller-owned trace used by feature-sensitive tests.
  // Normal search omits it, so tracing adds no allocation on the eval hot path.
  function evaluate(board, out) {
    let mg = 0, eg = 0, phase = 0;
    const pawnFiles = { w: [0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0, 0] };
    const pawnSquares = { w: [], b: [] };
    const kings = { w: -1, b: -1 };
    const force = { w: 0, b: 0 };  // count of non-king men (pawns + pieces)
    const pieces = { w: 0, b: 0 }; // count of non-king, non-pawn material (mating force)
    // Allocation-free king-safety accumulators, indexed by defending color.
    let ringWeightW = 0, ringWeightB = 0;
    let ringCountW = 0, ringCountB = 0;
    let shelterW = 0, shelterB = 0;
    // Locate both kings before the mobility walk; -8 disables malformed boards.
    const wk = board.indexOf('wK'), bk = board.indexOf('bK');
    const bkr = bk >= 0 ? bk >> 3 : -8, bkc = bk >= 0 ? bk & 7 : -8;
    const wkr = wk >= 0 ? wk >> 3 : -8, wkc = wk >= 0 ? wk & 7 : -8;

    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const color = p[0], type = p[1];
      const def = color === 'w' ? 'b' : 'w';  // king this piece could threaten
      // Mirror the square vertically for Black.
      const sq = color === 'w' ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
      phase += PHASE[type];
      let m = VALUES_MG[type] + PST[type][sq];
      let e = VALUES_EG[type] + PST_EG[type][sq];
      if (type !== 'K') force[color]++;
      if (type === 'P') {
        pawnFiles[color][i % 8]++;
        pawnSquares[color].push(i);
      } else if (type === 'K') {
        kings[color] = i;
      } else {
        pieces[color]++;
        const mob = mobility(board, i, type, color,
          color === 'w' ? bkr : wkr, color === 'w' ? bkc : wkc) * MOBILITY[type];
        m += mob; e += mob;
        // RING is this piece's attacked-square count on the enemy king ring.
        if (RING > 0) {
          if (def === 'w') { ringWeightW += KING_ATK_WEIGHT[type] * RING; ringCountW++; }
          else { ringWeightB += KING_ATK_WEIGHT[type] * RING; ringCountB++; }
        }
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
        const kc = k % 8;
        const kr = Math.floor(k / 8) + (color === 'w' ? -1 : 1);
        if (kr >= 0 && kr < 8) {
          for (let dc = -1; dc <= 1; dc++) {
            const cc = kc + dc;
            if (cc >= 0 && cc < 8 && board[kr * 8 + cc] === color + 'P') mg += sign * SHIELD;
          }
        }
        // From the king outward, only the first blocker can shelter a file.
        let shelter = 0;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = kc + dc;
          if (cc >= 0 && cc < 8) shelter += shelterFilePenalty(board, k, cc, color);
        }
        if (shelter > SHELTER_CAP) shelter = SHELTER_CAP;
        if (color === 'w') shelterW = shelter; else shelterB = shelter;
        mg -= sign * shelter;
      }
    }

    // Apply capped ring pressure from White's perspective.
    const ringPenaltyW = kingAttackPenalty(ringWeightW, ringCountW);
    const ringPenaltyB = kingAttackPenalty(ringWeightB, ringCountB);
    mg += ringPenaltyB;
    mg -= ringPenaltyW;

    const ph = Math.min(phase, PHASE_MAX);
    if (out) {
      out.phase = ph;
      out.wRingWeight = ringWeightW;
      out.bRingWeight = ringWeightB;
      out.wRingCount = ringCountW;
      out.bRingCount = ringCountB;
      out.wRingPenalty = ringPenaltyW;
      out.bRingPenalty = ringPenaltyB;
      out.wShelter = shelterW;
      out.bShelter = shelterB;
    }
    // Half-away-from-zero rounding preserves exact color antisymmetry.
    const tapered = (mg * ph + eg * (PHASE_MAX - ph)) / PHASE_MAX;
    let score = tapered < 0 ? -Math.round(-tapered) : Math.round(tapered);

    // Mop-up: when one side is reduced to a bare king, add the classic mating
    // gradient — drive the lone king toward a corner and march the winning king
    // in. Material + piece-square tables alone give no such gradient, so a
    // winning side can shuffle a basic K+R-vs-K into the fifty-move rule; this
    // term restores the drive. It activates ONLY when the STRONG side has a
    // real mating PIECE (pieces > 0) and the weak side is a bare king
    // (force === 0). Requiring a piece — not just any non-king material —
    // excludes K+P-vs-K, where the win is to escort and promote the pawn, not
    // to chase the enemy king (chasing there can even lose the pawn); once the
    // pawn queens, the queen is a piece and the gradient re-engages. Not
    // tapered — a bare-king position is always deep endgame; added on top of
    // the (endgame-dominated) score.
    if (kings.w >= 0 && kings.b >= 0) {
      if (pieces.w > 0 && force.b === 0) score += mopUp(kings.b, kings.w);
      else if (pieces.b > 0 && force.w === 0) score -= mopUp(kings.w, kings.b);
    }
    return score;
  }

  // Linear coordinated ring pressure, count-gated and capped.
  function kingAttackPenalty(weight, count) {
    if (count < 2) return 0;
    const mul = KING_ATK_COUNT_MUL[count < 7 ? count : 7];
    const v = Math.round(weight * KING_ATK_SCALE * mul / 100);
    return v > KING_ATK_CAP ? KING_ATK_CAP : v;
  }

  // Shelter on one file: the nearest piece is all that can block a direct ray.
  function shelterFilePenalty(board, king, file, color) {
    const step = color === 'w' ? -1 : 1;
    for (let r = (king >> 3) + step; r >= 0 && r < 8; r += step) {
      const p = board[r * 8 + file];
      if (!p) continue;
      if (p === color + 'P') return 0;
      return SHELTER_OPEN +
        (p[0] !== color && (p[1] === 'R' || p[1] === 'Q') ? SHELTER_RAY : 0);
    }
    return SHELTER_OPEN;
  }

  // Mating gradient for a lone king (loser) hunted by the winner's king.
  // Rewards pushing the loser off-center and closing the kings' distance —
  // the standard "mop-up" heuristic. Magnitudes (up to ~48 + ~24 cp) are large
  // enough to steer the search yet far below a piece, so they never distort
  // material judgement in the rare non-lone-king positions they could reach.
  function mopUp(loser, winner) {
    const lr = loser >> 3, lf = loser & 7;
    const wr = winner >> 3, wf = winner & 7;
    const cmd = Math.max(3 - lf, lf - 4) + Math.max(3 - lr, lr - 4); // center dist 0..6
    const kd = Math.abs(lr - wr) + Math.abs(lf - wf);               // king manhattan 2..14
    return 8 * cmd + 2 * (14 - kd);
  }

  // Mate scores are MATE minus the ply at which mate is delivered, so nearer
  // mates always outrank farther ones. Anything beyond MATE_NEAR is a mate.
  const MATE = 1000000;
  const MATE_NEAR = MATE - 1000;
  const QMAX = 16;          // quiescence ply bound: cut off runaway lines
  // At most two forcing quiet checks and their single-reply evasions.
  const QCHECK_PLIES = 4;
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
  // Classify zero, one, or multiple legal replies, stopping at `limit`.
  function legalMoveCountUpTo(state, pseudo, limit, ctx) {
    const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const timed = ctx && ctx.deadline !== Infinity;
    let found = 0;
    if (timed && Date.now() >= ctx.deadline) throw ABORT;
    for (const m of (pseudo || Chess.pseudoMoves(state))) {
      // Uncounted move generation must still honor the real deadline.
      if (timed && Date.now() >= ctx.deadline) throw ABORT;
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue;
      found++;
      if (found >= limit) return found;
    }
    return found;
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

  // Move ordering: hash move, promotions, forcing quiescence checks, captures
  // (MVV-LVA), killer moves, then quiet moves by history score.
  function orderMoves(moves, ttPk, ply, ctx, turn) {
    const killers = ctx.killers[ply];
    const hist = turn === 'w' ? ctx.histW : ctx.histB;
    for (const m of moves) {
      const pk = packMove(m);
      let s;
      if (pk === ttPk) s = 2e9;
      else if (m.promotion) s = 1e9 + VALUES[m.promotion];
      else if (m.qcheck) s = 5e8;
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
  function quiesceNode(state, alpha, beta, ply, qply, ctx, afterCheck) {
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

    let best;
    if (inChk) {
      best = maximizing ? -Infinity : Infinity; // must evade — no stand-pat
    } else {
      best = evaluate(state.board); // stand pat: may decline all captures
      if (maximizing) { if (best >= beta) return best; if (best > alpha) alpha = best; }
      else { if (best <= alpha) return best; if (best < beta) beta = best; }
    }

    // Only a node that survives to explore children joins the search path, so a
    // deeper quiescence line can detect a cycle back to here.
    if (trackRep) { ctx.path1.push(rr1); ctx.path2.push(rr2); }
    let repMin = Infinity;

    // Move set. In check: every evasion (the full pseudo list; the loop filters
    // illegals). Otherwise captures and promotions — plus a bounded quiet-check
    // extension.
    //
    // No delta (futility) pruning: with the tapered evaluation a single
    // capture's score swing is dominated by positional terms (an advanced or
    // passed pawn's endgame value, the mover's placement, freed mobility, the
    // lone-king mop-up gradient), not the captured piece's material, so a
    // material-based delta margin cannot be both sound and useful — any margin
    // large enough to never discard a window-crossing capture (~1700 cp over
    // material) effectively never fires. Every capture is searched, which also
    // makes quiescence scores exact (no window-sensitive pruning artifacts).
    //
    // Within QCHECK_PLIES, search an immediate quiet mate or a quiet check with
    // exactly one legal reply. One follow-up is admitted after the first check
    // evasion; later layers admit only mate. This proves the tracked
    // 27...Rxa2?? 28.Ne7+ Rxe7 29.Qh7+ Kf8 30.Qh8# without ordinary checks.
    // Preferred over a stand-pat mate scan: the recursion is counted as nodes
    // and alpha-beta-pruned, where a per-leaf mate scan's movegen is uncounted
    // work that roughly quartered the node rate under the same time budget.
    let moves;
    if (inChk) {
      moves = pseudo;
    } else {
      moves = [];
      // At the horizon and after the first evasion, admit a non-mating quiet
      // check only when it has one legal reply; later layers admit only mate.
      const genChecks = qply < QCHECK_PLIES && (qply === 0 || afterCheck);
      for (const m of pseudo) {
        if (m.captured || m.promotion) { moves.push(m); continue; }
        if (!genChecks) continue;
        const nb = Chess.applyMove(state, m);
        if (!Chess.isAttacked(nb.board, nb.board.indexOf(enemy + 'K'), turn)) continue;
        const replies = legalMoveCountUpTo(nb, null, 2, ctx);
        const forceLayer = qply === 0 || (afterCheck && qply === 1);
        if (replies === 0 || (forceLayer && replies === 1)) {
          m.qcheck = 1;
          moves.push(m);
        }
      }
    }

    for (const m of orderMoves(moves, 0, ply, ctx, turn)) {
      const next = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(next.board, ks, enemy)) continue;
      const score = quiesceNode(next, alpha, beta, ply + 1, qply + 1, ctx, inChk);
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
      if (ctx.quiesce) return quiesceNode(state, alpha, beta, ply, 0, ctx, false);
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
    // (up to path-dependent repetition draws inside subtrees); the stored best
    // move is useful for ordering at any draft. With delta pruning removed,
    // quiescence-derived scores are sound alpha-beta bounds, so — like main-
    // search entries — they are served to any window, including null scouts.
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
      // With no delta pruning anywhere, every leaf (main search and
      // quiescence) is a plain alpha-beta bound, so PVS here is a sound
      // transform of alpha-beta: a scout never silently discards a better move
      // (an earlier quiescent-delta-pruning variant did — depth-2 PVS picked
      // b8c6 -7 over the true best d7d5 -307, pinned in test/ai-tactics.js
      // against an independent minimax oracle; removing delta pruning removes
      // that whole failure mode). Move selection is confirmed by the 16-position
      // bench (--exact) and the tactics suite. The only remaining path
      // dependence is repetition draws, tracked via childRep/repPly below.
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
      ttStore(ctx, h1, h2, depth, ply, best, flag, bestPk);
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
      // near the previous one. A wrong guess fails the whole root, which never
      // trusts the bound — the failed side widens (doubling) and re-searches,
      // eventually falling back to the full window. Sitting on top of a
      // now-exact PVS (delta pruning removed), aspiration reproduces the
      // full-window result — the reviewer's FEN
      // r1b1kr2/p4pp1/np6/2pqp2P/P3PBBP/NPP1PN2/5P2/R3K2R b KQq - 2 15 gives the
      // same value as an independent full-window search, and the 16-position
      // --exact bench shows 0 move/score divergences vs no aspiration. Mate
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

  // --- Analysis hook. Orchestration (MultiPV, PV walk, provenance) lives in
  // analysis-core.js; the engine exposes only two minimal seams. (1) ctx.noDelta
  // requested that quiescence be searched without delta pruning for exact,
  // comparable full-window scores; delta pruning has since been removed
  // entirely, so quiescence is always exact and the flag is a retained no-op
  // (a defensive seam should selective pruning ever return). (2)
  // ttPackedMove() returns the raw PACKED best move stored for `state`
  // (from<<9 | to<<3 | promoIdx, with promoIdx Q=1 R=2 B=3 N=4), or 0 — the
  // PV walk (decode, legal replay, cycle termination) is done by the caller,
  // so no move-legality or PV logic leaks into the hot engine file. ---
  function ttPackedMove(ctx, state) {
    hashState(state);
    const e = ctx.tt.get(H1);
    return (e && e.h2 === H2 && e.move) ? e.move : 0;
  }

  global.ChessAI = {
    bestMove: bestMove,
    think: think,
    evaluate: evaluate,
    search: search,
    makeCtx: makeCtx,
    ttPackedMove: ttPackedMove,
    hashKey: hashKey,
    repKey: repKey,
    MATE: MATE,
    MATE_NEAR: MATE_NEAR,
    _test: Object.freeze({
      kingAttackPenalty: kingAttackPenalty,
      shelterFilePenalty: shelterFilePenalty
    })
  };
})(typeof window !== 'undefined' ? window : globalThis);
