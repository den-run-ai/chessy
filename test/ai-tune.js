/*
 * Evaluation weight tuner (development only) — a Texel-style logistic fit of
 * the existing evaluation constants in assets/ai.js. NOT part of any runtime
 * path and NOT wired into PR CI: it is a research tool, run by hand when an
 * evaluation-tuning experiment is on the table.
 *
 *   node test/ai-tune.js                       # default experiment (lambda sweep)
 *   node test/ai-tune.js --games 600 --nodes 1200 --sample-stride 4
 *   node test/ai-tune.js --lambdas 0,0.05,0.1,0.2,0.5 --seed 7 --emit candidate.json
 *
 * What it does (the disciplined loop the evaluation-tuning plan calls for):
 *   1. Generate a large, diverse labelled position set by self-play: random
 *      opening plies for spread, then an engine playout at a low node budget;
 *      every quiet (not-in-check) sampled position is labelled with the game's
 *      final result from White's point of view (1 / 0.5 / 0). Each position
 *      carries its GAME id — the split's grouping key.
 *   2. Extract, per position, the exact linear features of the evaluation terms
 *      this experiment is allowed to move — knight/bishop/rook/queen mobility,
 *      doubled and isolated pawn penalties, the pawn shield, and the passed-pawn
 *      midgame/endgame arrays — plus the fixed material+PST base. A fidelity
 *      self-check proves the reconstructed evaluation equals assets/ai.js's own
 *      evaluate() at the baseline weights (checked on fresh random positions
 *      independent of the dataset), so the fit optimises the SAME function the
 *      engine plays.
 *   3. GROUPED split by game into train / validation / test (default 70/15/15).
 *      A whole game stays on one side, so a game's correlated, identically-
 *      labelled positions never leak across the boundary (a position-level
 *      shuffle would).
 *   4. Fit the sigmoid scale K on the baseline (held fixed), then, for each
 *      lambda in a grid, fit the weights by RMSProp gradient descent + integer
 *      polish on the TRAIN split's mean-squared Texel loss, regularised (L2)
 *      toward the shipped values.
 *   5. SELECT lambda by VALIDATION loss, then report the winner against the
 *      baseline on the UNTOUCHED TEST split — the only unbiased loss comparison
 *      (val was spent on selection, so quoting val as the final number would be
 *      reuse, not a holdout).
 *
 * The tuner NEVER writes assets/ai.js. It prints the selected candidate (and,
 * with --emit, writes a JSON file). A lower test loss is a HYPOTHESIS, not a
 * green light: the outcome-labelled Texel objective is not the playing objective,
 * so a candidate is admissible only if it ALSO clears the tactics suite, the
 * benchmark, and the predeclared clustered self-play match. Conclusions are
 * specific to the low-budget self-play distribution the data comes from, not a
 * universal evaluation optimum.
 *
 * The recorded outcome is in test/ai-tune-findings.md (the canonical log): on a
 * large grouped-split self-play set with rounded scoring, this experiment
 * produced NO ADMISSIBLE CANDIDATE. The validation-selected fit differs from the
 * shipped weights by a single centipawn on one endgame passed-pawn term (a
 * noise-floor change that does not clear the strength gate), while the only
 * substantially-moved fit (lambda 0) OVERFITS — its held-out loss is worse. No
 * weight change shipped. See the findings file for the exact numbers.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
function num(name, dflt) {
  const raw = opt(name, String(dflt));
  const n = Number(raw);
  if (!Number.isFinite(n)) { console.error('--' + name + ' must be numeric (got "' + raw + '")'); process.exit(2); }
  return n;
}
function posInt(name, dflt) {
  const n = num(name, dflt);
  if (!Number.isSafeInteger(n) || n <= 0) { console.error('--' + name + ' must be a positive integer (got ' + n + ')'); process.exit(2); }
  return n;
}
function nonNegInt(name, dflt) {
  const n = num(name, dflt);
  if (!Number.isSafeInteger(n) || n < 0) { console.error('--' + name + ' must be a non-negative integer (got ' + n + ')'); process.exit(2); }
  return n;
}
function fracIn(name, dflt, lo, hi) { // strictly inside (lo, hi)
  const n = num(name, dflt);
  if (!(n > lo && n < hi)) { console.error('--' + name + ' must be in (' + lo + ', ' + hi + ') (got ' + n + ')'); process.exit(2); }
  return n;
}
function nonNegNum(name, dflt) {
  const n = num(name, dflt);
  if (!(n >= 0)) { console.error('--' + name + ' must be >= 0 (got ' + n + ')'); process.exit(2); }
  return n;
}
function posNum(name, dflt) {
  const n = num(name, dflt);
  if (!(n > 0)) { console.error('--' + name + ' must be > 0 (got ' + n + ')'); process.exit(2); }
  return n;
}

const GAMES = posInt('games', 400);        // self-play games to generate
const PLAY_NODES = posInt('nodes', 1000);  // node budget per playout move
const RAND_PLIES = posInt('rand-plies', 6);// random opening plies for diversity
const MAX_PLIES = posInt('max-plies', 200);// playout ply cap (unfinished = draw)
const SAMPLE_STRIDE = posInt('sample-stride', 4); // keep 1 of every N quiet plies
const SKIP_PLIES = nonNegInt('skip-plies', 0);// extra plies to skip after the opening
// Held-out fractions of the GAME set (grouped split — see groupedSplit). test is
// the final, untouched holdout; val is used to pick lambda/lr. train = the rest.
const VAL_FRAC = fracIn('val-frac', 0.15, 0, 1);
const TEST_FRAC = fracIn('test-frac', 0.15, 0, 1);
const LAMBDA = nonNegNum('lambda', 0.5);   // L2 regularisation strength toward baseline
const LR = posNum('lr', 0.1);              // RMSProp learning rate (centipawns/step)
const ITERS = posInt('iters', 3000);       // RMSProp iterations
const SEED = posInt('seed', 1);            // master seed (data + split, reproducible)
const PASSES = posInt('passes', 6);        // integer-polish passes
const EMIT = opt('emit', null);            // optional candidate JSON output path
const DATA = opt('data', null);            // optional dataset cache (generate once, sweep cheaply)
if (VAL_FRAC + TEST_FRAC >= 1) { console.error('--val-frac + --test-frac must be < 1 (leave games for training)'); process.exit(2); }

// ---- seeded PRNG (mulberry32, matching the engine's own) ----
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Baseline weights — the SHIPPED values in assets/ai.js. Kept here as the
// regularisation target and the fidelity-check reference. If ai.js changes,
// the fidelity self-check (below) fails loudly rather than tuning stale values.
// ============================================================================
const BASE_W = {
  mobN: 3, mobB: 3, mobR: 2, mobQ: 1,
  doubled: 12, isolated: 12, shield: 8,
  // passed-pawn arrays are indexed by ranks advanced 1..6 (index 0 in ai.js is
  // always 0 and never contributes, so it is not a free parameter here).
  passedMg: [5, 10, 20, 35, 60, 80],
  passedEg: [15, 30, 50, 80, 130, 180]
};

// Material + PST, copied from assets/ai.js so the base (untuned) contribution
// can be computed here exactly as the engine does. These are NOT tuned.
const VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
const PST = {
  P: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  N: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  B: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  R: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  Q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  K: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20]
};
const PST_EG = {
  P: [0,0,0,0,0,0,0,0, 80,80,80,80,80,80,80,80, 50,50,50,50,50,50,50,50, 30,30,30,30,30,30,30,30, 15,15,15,15,15,15,15,15, 5,5,5,5,5,5,5,5, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0],
  N: PST.N, B: PST.B, R: PST.R, Q: PST.Q,
  K: [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50]
};
const PHASE = { P: 0, N: 1, B: 1, R: 2, Q: 4, K: 0 };
const PHASE_MAX = 24;

const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ORTHO = [[-1,0],[1,0],[0,-1],[0,1]];
const ALL_DIRS = DIAG.concat(ORTHO);
const N_JUMPS = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];

// Mobility count — a byte-for-byte port of assets/ai.js mobility().
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

// ============================================================================
// Feature extraction. Every tuned term enters the evaluation LINEARLY, so a
// position reduces to (base_mg, base_eg, phase) plus one coefficient per tuned
// weight. eval(w) is then a dot product — the fit never re-walks the board.
//   mg(w) = base_mg + mobN*fN + mobB*fB + mobR*fR + mobQ*fQ
//                   + doubled*fD + isolated*fI + shield*fS
//                   + Σ passedMg[k]*fp[k]
//   eg(w) = base_eg + mobN*fN + mobB*fB + mobR*fR + mobQ*fQ
//                   + doubled*fD + isolated*fI + Σ passedEg[k]*fp[k]   (no shield)
//   q     = (mg*ph + eg*(24-ph)) / 24
// Signs are folded into the features so every weight stays a positive magnitude
// exactly as shipped: a doubled/isolated feature is negative (a penalty), a
// passed/shield/mobility feature is positive for White.
// ============================================================================
function features(board) {
  let baseMg = 0, baseEg = 0, phase = 0;
  let fN = 0, fB = 0, fR = 0, fQ = 0, fD = 0, fI = 0, fS = 0;
  const fp = [0, 0, 0, 0, 0, 0];
  const pawnFiles = { w: [0,0,0,0,0,0,0,0], b: [0,0,0,0,0,0,0,0] };
  const pawnSquares = { w: [], b: [] };
  const kings = { w: -1, b: -1 };

  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const color = p[0], type = p[1];
    const sign = color === 'w' ? 1 : -1;
    const sq = color === 'w' ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
    phase += PHASE[type];
    baseMg += sign * (VALUES[type] + PST[type][sq]);
    baseEg += sign * (VALUES[type] + PST_EG[type][sq]);
    if (type === 'P') {
      pawnFiles[color][i % 8]++;
      pawnSquares[color].push(i);
    } else if (type === 'K') {
      kings[color] = i;
    } else {
      const m = sign * mobility(board, i, type, color);
      if (type === 'N') fN += m; else if (type === 'B') fB += m;
      else if (type === 'R') fR += m; else fQ += m;
    }
  }

  for (const color of ['w', 'b']) {
    const sign = color === 'w' ? 1 : -1;
    const files = pawnFiles[color];
    const enemyPawns = pawnSquares[color === 'w' ? 'b' : 'w'];
    for (let f = 0; f < 8; f++) {
      if (files[f] > 1) fD += -sign * (files[f] - 1);
    }
    for (const i of pawnSquares[color]) {
      const f = i % 8, r = Math.floor(i / 8);
      if (!(f > 0 && files[f - 1]) && !(f < 7 && files[f + 1])) fI += -sign;
      let passed = true;
      for (const e2 of enemyPawns) {
        const ef = e2 % 8, er = Math.floor(e2 / 8);
        if (Math.abs(ef - f) <= 1 && (color === 'w' ? er < r : er > r)) { passed = false; break; }
      }
      if (passed) {
        const rr = Math.min(Math.max(color === 'w' ? 6 - r : r - 1, 0), 6);
        if (rr >= 1) fp[rr - 1] += sign; // rr==0 maps to PASSED[0]==0, no free weight
      }
    }
    const k = kings[color];
    if (k >= 0) {
      const kr = Math.floor(k / 8) + (color === 'w' ? -1 : 1), kc = k % 8;
      if (kr >= 0 && kr < 8) {
        for (let dc = -1; dc <= 1; dc++) {
          const cc = kc + dc;
          if (cc >= 0 && cc < 8 && board[kr * 8 + cc] === color + 'P') fS += sign;
        }
      }
    }
  }

  return { baseMg: baseMg, baseEg: baseEg, ph: Math.min(phase, PHASE_MAX),
    fN: fN, fB: fB, fR: fR, fQ: fQ, fD: fD, fI: fI, fS: fS, fp: fp };
}

// eval(w) from a feature record — the tapered White-perspective score. `round`
// only for the fidelity check; the optimiser works on the raw real value.
function evalFeat(ft, w, round) {
  const mob = w.mobN * ft.fN + w.mobB * ft.fB + w.mobR * ft.fR + w.mobQ * ft.fQ;
  const pen = w.doubled * ft.fD + w.isolated * ft.fI;
  let mg = ft.baseMg + mob + pen + w.shield * ft.fS;
  let eg = ft.baseEg + mob + pen;
  for (let k = 0; k < 6; k++) { mg += w.passedMg[k] * ft.fp[k]; eg += w.passedEg[k] * ft.fp[k]; }
  const q = (mg * ft.ph + eg * (PHASE_MAX - ft.ph)) / PHASE_MAX;
  return round ? Math.round(q) : q;
}

// ---- linear/vector form of the evaluation ----
// 19 weight SLOTS in a fixed order (of which 17 are actually fitted — pMg5/pEg5
// are pinned, see PINNED below). Since the evaluation is linear in them, a
// position compiles to (base, coeff[19]) and eval = base + coeff·w. The
// coefficients FOLD IN the taper, so the optimiser and the fidelity path agree
// to the centipawn: a phase-independent term (mobility, doubled, isolated) has
// coefficient = its feature; a midgame-only term (shield, passedMg) is scaled by
// ph/24; an endgame term (passedEg) by (24-ph)/24.
const WORDER = ['mobN','mobB','mobR','mobQ','doubled','isolated','shield',
  'pMg0','pMg1','pMg2','pMg3','pMg4','pMg5','pEg0','pEg1','pEg2','pEg3','pEg4','pEg5'];
const NW = WORDER.length; // 19

function wToVec(w) {
  return Float64Array.from([w.mobN, w.mobB, w.mobR, w.mobQ, w.doubled, w.isolated, w.shield,
    w.passedMg[0], w.passedMg[1], w.passedMg[2], w.passedMg[3], w.passedMg[4], w.passedMg[5],
    w.passedEg[0], w.passedEg[1], w.passedEg[2], w.passedEg[3], w.passedEg[4], w.passedEg[5]]);
}
function vecToW(v) {
  return { mobN: v[0], mobB: v[1], mobR: v[2], mobQ: v[3], doubled: v[4], isolated: v[5], shield: v[6],
    passedMg: [v[7], v[8], v[9], v[10], v[11], v[12]],
    passedEg: [v[13], v[14], v[15], v[16], v[17], v[18]] };
}

// Compile a feature record into (base, coeff[19]) with the taper folded in.
function compile(ft, y) {
  const ph = ft.ph, mgw = ph / PHASE_MAX, egw = (PHASE_MAX - ph) / PHASE_MAX;
  const base = (ft.baseMg * ph + ft.baseEg * (PHASE_MAX - ph)) / PHASE_MAX;
  const c = new Float64Array(NW);
  c[0] = ft.fN; c[1] = ft.fB; c[2] = ft.fR; c[3] = ft.fQ; // mobility: both phases -> feature
  c[4] = ft.fD; c[5] = ft.fI;                              // doubled/isolated: both phases
  c[6] = ft.fS * mgw;                                      // shield: midgame only
  for (let k = 0; k < 6; k++) { c[7 + k] = ft.fp[k] * mgw; c[13 + k] = ft.fp[k] * egw; }
  return { base: base, c: c, y: y };
}
function qVec(s, v) {
  let q = s.base; const c = s.c;
  for (let j = 0; j < NW; j++) q += c[j] * v[j];
  return q;
}

// ---- data generation: random-opening self-play, outcome-labelled ----
function randomOpening(rng) {
  let state = Chess.newGameState();
  for (let i = 0; i < RAND_PLIES; i++) {
    if (Chess.gameStatus(state).over) return null; // opening ended too soon; retry
    const legal = Chess.legalMoves(state);
    state = Chess.playMove(state, legal[Math.floor(rng() * legal.length)]);
  }
  return Chess.gameStatus(state).over ? null : state;
}

function generate() {
  const rng = mulberry32(SEED);
  const samples = [];
  let games = 0, decisive = 0, whiteToMove = 0, attempts = 0;
  // Bound total attempts so a mistyped --rand-plies (longer than any game can
  // survive -> randomOpening always null) or an unsatisfiable sampling phase
  // fails with a diagnostic instead of spinning forever. Generous headroom over
  // the requested game count, plus a floor for tiny runs.
  const MAX_ATTEMPTS = Math.max(GAMES * 100, 1000);
  const t0 = Date.now();
  for (let g = 0; games < GAMES; g++) {
    if (++attempts > MAX_ATTEMPTS) {
      process.stderr.write('\n');
      console.error('generation gave up after ' + MAX_ATTEMPTS + ' attempts with only ' + games +
        '/' + GAMES + ' sampled games — --rand-plies (' + RAND_PLIES + ') may exceed what a game survives, ' +
        'or --sample-stride/--skip-plies/--max-plies leave no sampleable ply. Adjust the flags.');
      process.exit(1);
    }
    const gameSeed = (SEED * 1000003 + g * 2654435761) >>> 0;
    let state = randomOpening(rng);
    if (!state) continue;
    // Per-game sampling phase in [0, SAMPLE_STRIDE). Without it, a fixed even
    // opening length plus an even stride would sample only ONE side to move in
    // every game (e.g. 6 opening plies + stride 4 -> always White to move) — a
    // parity bias. A random per-game phase spreads sampled positions across
    // both sides; the white/black balance is reported below.
    const phase = Math.floor(rng() * SAMPLE_STRIDE);
    const pending = [];
    let ply = 0, status;
    while (ply < MAX_PLIES && !(status = Chess.gameStatus(state)).over) {
      if (ply >= SKIP_PLIES && !status.check && (ply % SAMPLE_STRIDE === phase)) {
        pending.push({ ft: features(state.board), stm: state.turn });
      }
      const r = ChessAI.think(state, { maxDepth: 30, nodeLimit: PLAY_NODES, quiesce: true, seed: (gameSeed + ply) >>> 0 });
      const legal = Chess.legalMoves(state);
      const local = r.move && legal.find(function (m) {
        return m.from === r.move.from && m.to === r.move.to && m.promotion === r.move.promotion;
      });
      if (!local) break;
      state = Chess.playMove(state, local);
      ply++;
    }
    // A game that contributed NO sampled position is not part of the fitted
    // dataset — it must not inflate the reported game/decisive counts (which
    // would then describe a different population than the split). Skip it
    // entirely; only represented games get an id and count toward statistics.
    if (pending.length === 0) continue;
    const gid = games;
    games++;
    const fin = Chess.gameStatus(state);
    // White-perspective result: decided games score 1/0; everything else (ply
    // cap, or a non-terminal break) is a half point.
    let result = 0.5;
    if (fin.over && fin.result === '1-0') { result = 1; decisive++; }
    else if (fin.over && fin.result === '0-1') { result = 0; decisive++; }
    // `game` (gid) is the group key: every sample from one game shares it, so the
    // split can keep a whole game on one side and never leak a game's correlated,
    // identically-labelled positions across the train/val/test boundary.
    for (const p of pending) {
      if (p.stm === 'w') whiteToMove++;
      samples.push({ ft: p.ft, y: result, game: gid, stm: p.stm });
    }
    if (games % 25 === 0) {
      process.stderr.write('\rgenerated ' + games + '/' + GAMES + ' sampled games, ' +
        samples.length + ' positions, ' + decisive + ' decisive, ' +
        Math.round((Date.now() - t0) / 1000) + 's   ');
    }
  }
  process.stderr.write('\n');
  return { samples: samples, games: games, decisive: decisive, whiteToMove: whiteToMove };
}

// ---- Texel loss (vector form) ----
// Predicted White score: sigmoid(K * q / 400), the standard Texel link. K is
// fitted once on the baseline weights, then held fixed while the weights move.
function sigmoid(q, K) { return 1 / (1 + Math.pow(10, -K * q / 400)); }

// The engine PLAYS with Math.round(evaluate()), so an integer candidate must be
// scored on rounded q — that is the value it will actually act on. `round` is
// true for every score of an INTEGER weight vector (baseline, polish, selection,
// final reporting) and false only inside the continuous RMSProp descent, whose
// gradient needs the smooth (unrounded) surface (Math.round is non-differentiable
// and its subgradient is zero almost everywhere).
function mse(samples, v, K, round) {
  let s = 0;
  for (const smp of samples) {
    const q = qVec(smp, v);
    const d = smp.y - sigmoid(round ? Math.round(q) : q, K);
    s += d * d;
  }
  return s / samples.length;
}

// Bounds on the fitted sigmoid scale. Real 600-game runs fit K ~ 0.4-0.5, well
// inside these. K < K_MIN: the sigmoid is so flat the data carries essentially no
// evaluation-weight signal (the optimum pushes predictions toward 0.5). K at the
// top of the coarse grid: the split is (near-)separable, so the true optimum runs
// off to saturation — a degenerate fit with negligible gradient. The caller
// rejects either boundary.
const K_MIN = 0.10, K_GRID_MAX = 3.0;

// K is fitted on the baseline weights, which are integers the engine rounds — so
// fit it on the rounded score, the quantity actually played. The search starts at
// K = 0 (predict 0.5 everywhere), so a near-zero optimum is visible (and rejected
// as no-signal). The fine pass refines a FIXED neighbourhood of the coarse optimum
// (captured in `coarse`) — using the live `best` as the bound would let a
// monotonically-improving (separable) split move the window every iteration and
// search up to sigmoid saturation (K in the hundreds) instead of a bounded step.
function fitK(samples, v) {
  let best = 0, bestE = Infinity;
  for (let K = 0.0; K <= K_GRID_MAX + 1e-9; K += 0.05) { const e = mse(samples, v, K, true); if (e < bestE) { bestE = e; best = K; } }
  const coarse = best;
  for (let K = coarse - 0.05; K <= coarse + 0.05 + 1e-9; K += 0.005) {
    if (K < 0) continue;
    const e = mse(samples, v, K, true); if (e < bestE) { bestE = e; best = K; }
  }
  return best;
}

// L2 regularisation toward the shipped weights, scaled per-parameter so a move
// of one REG_SCALE unit costs the same penalty for every weight regardless of
// its natural magnitude. This is what keeps the fit honest: it can only leave a
// shipped value when the data pays for the penalty.
const BASE_VEC = wToVec(BASE_W);
const REG_SCALE = Float64Array.from([3,3,2,2, 8,8, 6, 30,30,30,30,30,30, 40,40,40,40,40,40]);

// PINNED weights are held fixed at their shipped value and NOT fitted. Indices 12
// (passedMg[5]) and 18 (passedEg[5]) score a passed pawn six ranks advanced —
// which for either colour is the promotion rank. A pawn there is immediately
// replaced by its promotion piece (see Chess.playMove / applyMove), so NO legal
// position sampled here ever carries that feature: its coefficient is identically
// zero, the two weights are unidentifiable from this data, and the descent/polish
// gradients for them are zero. Fitting them would be dishonest (they cannot move
// on evidence), so the fit is over the 17 IDENTIFIABLE parameters; regularisation
// normalises by that count.
const PINNED = new Set([12, 18]);
const FIT_IDX = [];
for (let j = 0; j < NW; j++) if (!PINNED.has(j)) FIT_IDX.push(j);
const NFIT = FIT_IDX.length; // 17

function regPenalty(v, lambda) {
  let p = 0;
  for (const j of FIT_IDX) { const d = (v[j] - BASE_VEC[j]) / REG_SCALE[j]; p += d * d; }
  return lambda * p / NFIT;
}
function objective(samples, v, K, lambda, round) { return mse(samples, v, K, round) + regPenalty(v, lambda); }

// Integer bounds — domain sanity so the fit can't wander into nonsense.
const LO = Float64Array.from([0,0,0,0, 0,0, 0, 0,0,0,0,0,0, 0,0,0,0,0,0]);
const HI = Float64Array.from([12,12,12,12, 40,40, 30, 200,200,200,200,200,200, 300,300,300,300,300,300]);
function clampVec(v) {
  const out = Float64Array.from(v);
  for (let j = 0; j < NW; j++) out[j] = Math.max(LO[j], Math.min(HI[j], out[j]));
  return out;
}

// Analytic gradient of the regularised objective. The loss is smooth and the
// evaluation linear in the weights, so the gradient is exact and cheap:
//   d/dw_j  (1/N) Σ (y-p)²  = -(2/N) Σ (y-p)·a·p·(1-p)·c_j,  a = K·ln(10)/400
// plus the L2 term 2λ/(N_w)·(w_j-base_j)/scale_j². Descent preconditions each
// component by scale_j² so the very different weight magnitudes (a mobility unit
// vs a passed-pawn unit) take comparable steps.
function gradient(samples, v, K, lambda) {
  const a = K * Math.LN10 / 400;
  const g = new Float64Array(NW);
  const N = samples.length;
  for (const smp of samples) {
    const p = sigmoid(qVec(smp, v), K);
    const f = -2 * (smp.y - p) * a * p * (1 - p) / N;
    const c = smp.c;
    for (let j = 0; j < NW; j++) g[j] += f * c[j];
  }
  for (let j = 0; j < NW; j++) g[j] += (2 * lambda / NFIT) * (v[j] - BASE_VEC[j]) / (REG_SCALE[j] * REG_SCALE[j]);
  for (const j of PINNED) g[j] = 0; // pinned weights never move
  return g;
}

// RMSProp descent to the (regularised) continuous optimum. The tuned weights
// span two orders of magnitude (a mobility unit vs a passed-pawn unit), so their
// raw gradients do too; RMSProp normalises each parameter by its own running
// gradient magnitude, giving every weight a step of ~lr centipawns per iteration
// regardless of scale — the robust way to descend such an ill-conditioned but
// smooth objective. The best-seen (lowest-objective) vector is returned, so a
// noisy late step can never make the result worse than a point already visited.
function descend(train, K, lambda, opts) {
  opts = opts || {};
  const lr = opts.lr != null ? opts.lr : LR, iters = opts.iters != null ? opts.iters : ITERS;
  const start = opts.start ? Float64Array.from(opts.start) : Float64Array.from(BASE_VEC);
  const quiet = !!opts.quiet;
  let v = Float64Array.from(start);
  const cache = new Float64Array(NW);
  // Descent works the SMOOTH (unrounded) objective — the gradient is defined
  // there; rounding happens later, in polish and scoring.
  let best = Float64Array.from(v), bestObj = objective(train, v, K, lambda, false);
  for (let it = 0; it < iters; it++) {
    const g = gradient(train, v, K, lambda);
    for (let j = 0; j < NW; j++) {
      cache[j] = 0.9 * cache[j] + 0.1 * g[j] * g[j];
      v[j] = Math.max(LO[j], Math.min(HI[j], v[j] - lr * g[j] / (Math.sqrt(cache[j]) + 1e-8)));
    }
    const o = objective(train, v, K, lambda, false);
    if (o < bestObj) { bestObj = o; best = Float64Array.from(v); }
    if (!quiet && (it & 255) === 0) process.stderr.write('\rRMSProp it ' + it + '/' + iters + ', train obj ' + o.toFixed(6) + '   ');
  }
  if (!quiet) process.stderr.write('\n');
  return best;
}

// Integer coordinate-descent polish around a starting vector: nudge each weight
// ±1 (widening to ±step on success) while it lowers the ROUNDED regularised
// objective — the same quantity the engine plays. Applied to the rounded
// continuous optimum so the frozen candidate sits at an integer local optimum.
// Returns .converged=false (and warns) if it exhausted PASSES while still
// improving, so a truncated, non-locally-optimal candidate is never presented
// as final without notice.
function polish(train, v0, K, lambda, quiet) {
  const v = Float64Array.from(v0);
  let cur = objective(train, v, K, lambda, true);
  let converged = false;
  for (let pass = 0; pass < PASSES; pass++) {
    let improved = false;
    for (const j of FIT_IDX) { // pinned weights are unidentifiable — never polished
      for (const dir of [1, -1]) {
        let step = 1;
        for (;;) {
          const nv = Math.max(LO[j], Math.min(HI[j], v[j] + dir * step));
          if (nv === v[j]) break;
          const save = v[j]; v[j] = nv;
          const e = objective(train, v, K, lambda, true);
          if (e < cur - 1e-13) { cur = e; improved = true; step *= 2; }
          else { v[j] = save; break; }
        }
      }
    }
    if (!quiet) process.stderr.write('\rinteger polish pass ' + (pass + 1) + '/' + PASSES + ', train obj ' + cur.toFixed(6) + '   ');
    if (!improved) { converged = true; break; }
  }
  if (!quiet) process.stderr.write('\n');
  if (!converged) {
    // Surface non-convergence loudly even in quiet mode — this is a correctness
    // signal (the candidate is not a verified integer local optimum), not progress.
    process.stderr.write('WARNING: integer polish still improving after ' + PASSES +
      ' passes (lambda ' + lambda + ') — candidate is NOT a verified local optimum; raise --passes.\n');
  }
  return v;
}

// Grouped split: partition the GAMES (not the positions) into train / val / test
// by shuffling the distinct game ids under a seeded PRNG and slicing by fraction,
// then routing every sample to the split its game landed in. A whole game stays
// on one side, so correlated, identically-labelled positions never straddle the
// boundary (the leakage the position-level shuffle allowed). val selects
// lambda/lr; test is the final, untouched holdout.
function groupedSplit(samples, valFrac, testFrac, seed) {
  const ids = Array.from(new Set(samples.map(function (s) { return s.game; })));
  const rng = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
  // Round to game counts, but never let a requested split round down to zero
  // games: on a small custom run, Math.round(3 * 0.15) = 0 would silently make
  // val or test empty (a broken holdout that looks fine). Guarantee >= 1 game
  // for any positive fraction when enough games exist, and leave train non-empty.
  let nTest = Math.round(ids.length * testFrac), nVal = Math.round(ids.length * valFrac);
  if (testFrac > 0 && nTest === 0) nTest = 1;
  if (valFrac > 0 && nVal === 0) nVal = 1;
  if (nTest + nVal >= ids.length) {
    throw new Error('grouped split leaves no training games: ' + ids.length + ' games, ' +
      'val ' + nVal + ' + test ' + nTest + ' >= all. Raise --games or lower --val-frac/--test-frac.');
  }
  const testSet = new Set(ids.slice(0, nTest));
  const valSet = new Set(ids.slice(nTest, nTest + nVal));
  const train = [], val = [], test = [];
  for (const s of samples) {
    if (testSet.has(s.game)) test.push(s);
    else if (valSet.has(s.game)) val.push(s);
    else train.push(s);
  }
  return { train: train, val: val, test: test,
    nGames: { train: ids.length - nTest - nVal, val: nVal, test: nTest } };
}

// Fit a candidate at one lambda: continuous RMSProp optimum, rounded, then an
// integer polish. Returns the integer weight vector.
function fitCandidate(train, K, lambda, quiet) {
  const cont = descend(train, K, lambda, { quiet: quiet });
  const rounded = clampVec(Float64Array.from(cont, Math.round));
  return polish(train, rounded, K, lambda, quiet);
}

// Independent fidelity pass: on fresh random positions (NOT the dataset — a
// distribution-independent check), the reconstructed evaluation must equal
// assets/ai.js's own evaluate() at the baseline weights, or the fit is
// optimising the wrong function. Returns {checked, bad}.
function fidelityCheck(n, seed) {
  const rng = mulberry32(seed);
  let checked = 0, bad = 0;
  for (let t = 0; t < n; t++) {
    let st = Chess.newGameState();
    const plies = 4 + Math.floor(rng() * 40);
    let ok = true;
    for (let i = 0; i < plies; i++) {
      if (Chess.gameStatus(st).over) { ok = false; break; }
      const legal = Chess.legalMoves(st);
      st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
    }
    if (!ok) continue;
    checked++;
    if (evalFeat(features(st.board), BASE_W, true) !== ChessAI.evaluate(st.board)) bad++;
  }
  return { checked: checked, bad: bad };
}

// A distinct-weights fidelity oracle. The baseline check above cannot catch a
// feature/coefficient that is wired to the WRONG term, because several shipped
// weights are equal (mobN==mobB==3, doubled==isolated==12): swap those features
// and the baseline evaluation is unchanged. So load the engine with a set of 19
// DISTINCT tuned constants — a genuinely independent evaluator (ai.js's own
// evaluate() in a fresh realm) — and require it to match evalFeat() under the
// SAME distinct weights. Any swapped or mis-scaled coefficient then diverges.
const PERTURB_W = {
  mobN: 4, mobB: 5, mobR: 6, mobQ: 7, doubled: 9, isolated: 11, shield: 13,
  passedMg: [3, 17, 23, 29, 41, 53], passedEg: [8, 19, 31, 37, 47, 61]
};
function loadEngineWithWeights(w) {
  const read = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };
  let src = read('assets/ai.js');
  const subs = [
    [/const MOBILITY = \{[^}]*\};/, 'const MOBILITY = { N: ' + w.mobN + ', B: ' + w.mobB + ', R: ' + w.mobR + ', Q: ' + w.mobQ + ' };'],
    [/const DOUBLED = \d+, ISOLATED = \d+, SHIELD = \d+;/, 'const DOUBLED = ' + w.doubled + ', ISOLATED = ' + w.isolated + ', SHIELD = ' + w.shield + ';'],
    [/const PASSED_MG = \[[^\]]*\];/, 'const PASSED_MG = [0, ' + w.passedMg.join(', ') + '];'],
    [/const PASSED_EG = \[[^\]]*\];/, 'const PASSED_EG = [0, ' + w.passedEg.join(', ') + '];']
  ];
  for (const [re, rep] of subs) {
    if (!re.test(src)) throw new Error('perturbed fidelity: could not locate constant to patch: ' + re);
    src = src.replace(re, rep);
  }
  const ctx = vm.createContext({});
  vm.runInContext(read('assets/engine.js'), ctx, { filename: 'engine.js' });
  vm.runInContext(src, ctx, { filename: 'ai.js(perturbed)' });
  return ctx;
}
function perturbedFidelityCheck(n, seed) {
  const ctx = loadEngineWithWeights(PERTURB_W); // independent evaluator at DISTINCT weights
  const rng = mulberry32(seed);
  let checked = 0, bad = 0;
  for (let t = 0; t < n; t++) {
    let st = Chess.newGameState();
    const plies = 4 + Math.floor(rng() * 40);
    let ok = true;
    for (let i = 0; i < plies; i++) {
      if (Chess.gameStatus(st).over) { ok = false; break; }
      const legal = Chess.legalMoves(st);
      st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
    }
    if (!ok) continue;
    checked++;
    if (evalFeat(features(st.board), PERTURB_W, true) !== ctx.ChessAI.evaluate(st.board)) bad++;
  }
  return { checked: checked, bad: bad };
}

// Dataset cache/format version. Bump on ANY change to what generate() produces
// or how a position's features are encoded, so a stale cache (e.g. one built
// before the sampling-parity fix, or missing game ids / side-to-move) is refused
// rather than silently tuned on. It is part of the cache identity below.
const SCHEMA = 4;

function loadOrGenerate() {
  const want = { schema: SCHEMA, games: GAMES, nodes: PLAY_NODES, randPlies: RAND_PLIES, maxPlies: MAX_PLIES, sampleStride: SAMPLE_STRIDE, skipPlies: SKIP_PLIES, seed: SEED };
  if (DATA && fs.existsSync(path.resolve(DATA))) {
    const cached = JSON.parse(fs.readFileSync(path.resolve(DATA), 'utf8'));
    if (JSON.stringify(cached.config) !== JSON.stringify(want)) {
      console.error('cache ' + DATA + ' is stale or built with a different config (schema/flags mismatch); ' +
        'delete it or match the flags.\n  cache: ' + JSON.stringify(cached.config) + '\n  want:  ' + JSON.stringify(want));
      process.exit(1);
    }
    console.log('loaded ' + cached.data.samples.length + ' positions from ' + DATA +
      ' (' + cached.data.games + ' games, ' + cached.data.decisive + ' decisive)');
    return cached.data;
  }
  const data = generate();
  if (DATA) {
    fs.writeFileSync(path.resolve(DATA), JSON.stringify({ config: want, data: data }));
    console.log('cached dataset to ' + DATA);
  }
  return data;
}

// The lambda grid: an explicit --lambdas list, or a single explicit --lambda, or
// the default sweep. lambda is chosen on VALIDATION; the winner is reported on
// the untouched TEST set (nested selection — no test-set peeking).
const LAMBDA_GRID = (function () {
  if (args.includes('--lambdas')) return opt('lambdas', '').split(',').map(function (s) {
    const n = Number(s.trim());
    // Number.isFinite, not just n >= 0: "Infinity" passes n >= 0 but then the
    // penalty computes Infinity*0 = NaN at the baseline, silently freezing the
    // fit at the shipped weights and printing a plausible unchanged verdict.
    if (!(Number.isFinite(n) && n >= 0)) { console.error('--lambdas entries must be finite and >= 0 (got "' + s + '")'); process.exit(2); }
    return n;
  });
  if (args.includes('--lambda')) return [LAMBDA];
  return [0, 0.05, 0.1, 0.2, 0.5, 1.0];
})();

function main() {
  console.log('# Chessy evaluation tuner');
  console.log('config: games=' + GAMES + ' nodes=' + PLAY_NODES + ' rand-plies=' + RAND_PLIES +
    ' sample-stride=' + SAMPLE_STRIDE + ' skip-plies=' + SKIP_PLIES + ' max-plies=' + MAX_PLIES +
    ' seed=' + SEED + ' passes=' + PASSES + ' lr=' + LR + ' iters=' + ITERS +
    ' val-frac=' + VAL_FRAC + ' test-frac=' + TEST_FRAC);

  const data = loadOrGenerate();
  if (data.samples.length < 200) { console.error('too few positions (' + data.samples.length + ') — raise --games'); process.exit(1); }

  const fid = fidelityCheck(400, SEED ^ 0xdeadbeef);
  const pfid = perturbedFidelityCheck(400, SEED ^ 0xbeefcafe); // detects feature/coefficient swaps
  if (fid.bad > 0 || pfid.bad > 0) {
    console.error('FAIL: feature reconstruction diverges from ai.js evaluate() — baseline ' + fid.bad + '/' + fid.checked +
      ', distinct-weights ' + pfid.bad + '/' + pfid.checked + '. Feature code is out of sync with assets/ai.js.');
    process.exit(1);
  }
  console.log('fidelity: reconstruction matches ai.js evaluate() on all ' + fid.checked + ' baseline + ' +
    pfid.checked + ' distinct-weights fresh random positions (independent of the dataset; the ' +
    data.samples.length + ' dataset positions are not individually re-checked)');

  // Grouped split by GAME id — no game straddles a boundary, so correlated,
  // identically-labelled positions never leak across train/val/test.
  const compiled = data.samples.map(function (s) { const c = compile(s.ft, s.y); c.game = s.game; return c; });
  const sp = groupedSplit(compiled, VAL_FRAC, TEST_FRAC, SEED ^ 0x1234abcd);
  const train = sp.train, val = sp.val, test = sp.test;
  const decPct = (100 * data.decisive / data.games).toFixed(1);
  const wtm = data.whiteToMove != null ? data.whiteToMove : data.samples.filter(function (s) { return s.stm === 'w'; }).length;
  const wtmPct = (100 * wtm / data.samples.length).toFixed(1);
  console.log('data: ' + data.games + ' games (' + data.decisive + ' decisive, ' + decPct + '%), ' +
    data.samples.length + ' positions; side-to-move balance ' + wtmPct + '% White / ' +
    (100 - wtmPct).toFixed(1) + '% Black');
  console.log('grouped split (by game): train ' + sp.nGames.train + ' games/' + train.length + ' pos, ' +
    'val ' + sp.nGames.val + '/' + val.length + ', test ' + sp.nGames.test + '/' + test.length);

  // A training split with no decided game (every label 0.5) carries no
  // evaluation signal: the Texel optimum is K = 0 (predict 0.5 everywhere), and
  // any "fit" merely pushes evaluations toward zero. Refuse it rather than emit a
  // plausible but meaningless candidate.
  const trainDecisive = train.reduce(function (a, s) { return a + (s.y !== 0.5 ? 1 : 0); }, 0);
  if (trainDecisive === 0) {
    console.error('training split has no decided games (all labels 0.5) — no evaluation signal to fit. ' +
      'Raise --games / --nodes (or --max-plies) so games finish decisively.');
    process.exit(1);
  }

  const K = fitK(train, BASE_VEC);
  if (K < K_MIN) {
    console.error('fitted sigmoid scale K = ' + K.toFixed(4) + ' is below K_MIN = ' + K_MIN +
      ' — the training split carries too little decisive signal (its Texel optimum pushes predictions ' +
      'toward 0.5 rather than fitting evaluation structure). Raise --games / --nodes (or --max-plies).');
    process.exit(1);
  }
  if (K >= K_GRID_MAX) {
    console.error('fitted sigmoid scale K = ' + K.toFixed(4) + ' is at the search ceiling (' + K_GRID_MAX +
      ') — the training split is (near-)separable, so the optimum runs to sigmoid saturation and the fit is ' +
      'degenerate (negligible gradient). This only happens on tiny/pathological splits; raise --games.');
    process.exit(1);
  }
  console.log('sigmoid scale K (fitted on baseline, train split): ' + K.toFixed(4) +
    '  (train decisive ' + trainDecisive + '/' + train.length + ')');
  // All integer-vector scores are ROUNDED — the engine plays Math.round(eval).
  const baseTrain = mse(train, BASE_VEC, K, true), baseVal = mse(val, BASE_VEC, K, true), baseTest = mse(test, BASE_VEC, K, true);
  console.log('baseline loss (rounded): train ' + baseTrain.toFixed(6) + '  val ' + baseVal.toFixed(6) + '  test ' + baseTest.toFixed(6));

  // Sweep lambda; SELECT on validation loss. The BASELINE is a candidate in the
  // selection (seeded below), so a grid of only-worse fits still selects the
  // shipped weights instead of the least-bad move. Selection never looks at test.
  console.log('\nlambda sweep (fit on train, selected on val; rounded scores; ' + NFIT +
    ' fitted params, pMg5/pEg5 pinned — promotion rank unreachable):');
  console.log('  lambda   trainΔ%   valΔ%   moved  weights-off-baseline');
  let bestLam = 'baseline', bestValLoss = baseVal, bestVec = Float64Array.from(BASE_VEC);
  for (const lambda of LAMBDA_GRID) {
    const vec = fitCandidate(train, K, lambda, true);
    const vTrain = mse(train, vec, K, true), vVal = mse(val, vec, K, true);
    const nOff = WORDER.reduce(function (a, _, j) { return a + (vec[j] !== BASE_VEC[j] ? 1 : 0); }, 0);
    console.log('  ' + String(lambda).padEnd(7) +
      ' ' + (100 * (baseTrain - vTrain) / baseTrain).toFixed(3).padStart(8) +
      ' ' + (100 * (baseVal - vVal) / baseVal).toFixed(3).padStart(7) +
      '   ' + String(nOff).padStart(2) + '/' + NW +
      '   ' + (nOff ? WORDER.filter(function (_, j) { return vec[j] !== BASE_VEC[j]; }).join(',') : '(none)'));
    if (vVal < bestValLoss - 1e-15) { bestValLoss = vVal; bestLam = lambda; bestVec = vec; }
  }

  const candVec = bestVec, cand = vecToW(candVec);
  const candTrain = mse(train, candVec, K, true), candVal = mse(val, candVec, K, true), candTest = mse(test, candVec, K, true);
  const moved = WORDER.some(function (_, j) { return candVec[j] !== BASE_VEC[j]; });
  console.log('\nselected: ' + (moved ? 'lambda = ' + bestLam : 'BASELINE (no swept lambda beat the shipped weights on validation)') +
    ' — lowest validation loss');
  console.log('FINAL (untouched test set, rounded): baseline ' + baseTest.toFixed(6) + '  candidate ' + candTest.toFixed(6) +
    '  ->  ' + (100 * (baseTest - candTest) / baseTest).toFixed(3) + '% ' +
    (candTest < baseTest ? 'lower (better)' : candTest > baseTest ? 'higher (worse)' : 'equal'));

  function line(label, base, c) {
    const flag = base === c ? '' : '   <-- ' + (c > base ? '+' : '') + (c - base);
    return '  ' + label.padEnd(12) + String(base).padStart(4) + ' -> ' + String(c).padStart(4) + flag;
  }
  console.log('\nselected candidate weights (baseline -> candidate):');
  for (const k of ['mobN','mobB','mobR','mobQ','doubled','isolated','shield']) console.log(line(k, BASE_W[k], cand[k]));
  console.log('  passedMg    [' + BASE_W.passedMg.join(',') + '] -> [' + cand.passedMg.join(',') + ']');
  console.log('  passedEg    [' + BASE_W.passedEg.join(',') + '] -> [' + cand.passedEg.join(',') + ']');

  console.log('\nverdict: ' + (!moved
    ? 'at the validation-selected lambda the fit does not leave the shipped weights on THIS data — no candidate to ship'
    : candTest < baseTest
      ? 'candidate lowers the untouched test loss — a HYPOTHESIS only; admissible ONLY if it then clears tactics + benchmark + the predeclared clustered match'
      : 'candidate does not lower the untouched test loss — not admissible'));
  console.log('NOTE: a lower Texel loss is necessary, not sufficient — the outcome-labelled objective is not the');
  console.log('      playing objective. Gate a moved candidate in order: the tactics suite FIRST (a tactics');
  console.log('      failure is terminal — no match needed), then the benchmark and the predeclared clustered');
  console.log('      self-play match (lower bound > 50%). Results are specific to low-budget self-play from');
  console.log('      random ' + RAND_PLIES + '-ply openings, not a universal optimum.');

  console.log('\nassets/ai.js constants for the selected candidate:');
  console.log("  const MOBILITY = { N: " + cand.mobN + ", B: " + cand.mobB + ", R: " + cand.mobR + ", Q: " + cand.mobQ + " };");
  console.log('  const DOUBLED = ' + cand.doubled + ', ISOLATED = ' + cand.isolated + ', SHIELD = ' + cand.shield + ';');
  console.log('  const PASSED_MG = [0, ' + cand.passedMg.join(', ') + '];');
  console.log('  const PASSED_EG = [0, ' + cand.passedEg.join(', ') + '];');

  if (EMIT) {
    fs.writeFileSync(path.resolve(EMIT), JSON.stringify({
      // Every result-affecting option, so a candidate JSON fully reproduces its run.
      config: {
        games: GAMES, nodes: PLAY_NODES, randPlies: RAND_PLIES, maxPlies: MAX_PLIES,
        sampleStride: SAMPLE_STRIDE, skipPlies: SKIP_PLIES, seed: SEED,
        valFrac: VAL_FRAC, testFrac: TEST_FRAC, lr: LR, iters: ITERS, passes: PASSES,
        lambdaGrid: LAMBDA_GRID, schema: SCHEMA
      },
      K: K, selectedLambda: bestLam, moved: moved, baseline: BASE_W, candidate: cand,
      split: sp.nGames, rounded: true, fittedParams: NFIT, pinned: ['pMg5', 'pEg5'],
      loss: { baseTrain: baseTrain, baseVal: baseVal, baseTest: baseTest, candTrain: candTrain, candVal: candVal, candTest: candTest }
    }, null, 2) + '\n');
    console.log('\nwrote ' + EMIT);
  }
}

// ---- entry point / exports ----
// Running the file executes the experiment; requiring it (the regression test in
// test/ai-tune.test.js) gets the internals without side effects.
if (require.main === module) {
  main();
} else {
  module.exports = {
    BASE_W: BASE_W, WORDER: WORDER, NW: NW, BASE_VEC: BASE_VEC, LO: LO, HI: HI, REG_SCALE: REG_SCALE,
    mulberry32: mulberry32, features: features, evalFeat: evalFeat, compile: compile, qVec: qVec,
    wToVec: wToVec, vecToW: vecToW, clampVec: clampVec,
    sigmoid: sigmoid, mse: mse, fitK: fitK, K_MIN: K_MIN, K_GRID_MAX: K_GRID_MAX, regPenalty: regPenalty, objective: objective, gradient: gradient,
    descend: descend, polish: polish, groupedSplit: groupedSplit,
    PINNED: PINNED, FIT_IDX: FIT_IDX, NFIT: NFIT,
    fidelityCheck: fidelityCheck, perturbedFidelityCheck: perturbedFidelityCheck,
    loadEngineWithWeights: loadEngineWithWeights, PERTURB_W: PERTURB_W,
    Chess: Chess, ChessAI: ChessAI
  };
}
