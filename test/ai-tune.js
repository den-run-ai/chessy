/*
 * Evaluation weight tuner v2 (development only) — a convex logistic fit of the
 * FULL evaluation weight vector in assets/ai.js. NOT part of any runtime path
 * and NOT wired into PR CI: it is a research tool, run by hand when an
 * evaluation-tuning experiment is on the table.
 *
 *   node test/ai-tune-gen.js --games 1600 --nodes 2500 --out tune-data.json
 *   node test/ai-tune.js --data tune-data.json --emit candidate.json
 *
 * History: the first evaluation-tuning experiment (PR #63, closed unmerged)
 * tuned only the 19 auxiliary constants over 13k positions of 700-node
 * random-opening self-play labelled by game outcome alone, and produced NO
 * admissible candidate: the regularised fits stayed at the shipped weights,
 * and the only fit that lowered held-out loss (lambda 0) was chess-nonsensical
 * — it could not mate with K+Q, the canonical objective-misalignment failure.
 * Its findings log called out the data (small, noisy, thin coverage) and the
 * tiny tunable surface. This v2 keeps every piece of #63's discipline and
 * changes exactly the two things its findings blamed:
 *
 *   - THE WHOLE EVALUATION IS ON THE TABLE: all twelve piece-square tables
 *     (736 identifiable entries — pawn first/last ranks are unreachable) plus
 *     the 17 identifiable auxiliary weights, 753 parameters in all. Piece
 *     VALUES_MG/VALUES_EG stay fixed: a uniform shift of a piece's table is
 *     indistinguishable from its material value (perfect collinearity), so
 *     the tables absorb any material retune without loss of generality.
 *   - BETTER LABELS ON BETTER DATA: real-opening self-play at a higher node
 *     budget (see test/ai-tune-gen.js), each quiet position carrying BOTH the
 *     game outcome and the White-POV root search score computed at play time.
 *     The training target blends them (--mix-out, default 0.5): the score
 *     term gives every position its own label — including won-ending
 *     positions whose outcome bit alone taught #63's fit nothing — which is
 *     the standard cure for the exact failure #63 recorded.
 *
 * The objective is the log-loss (cross-entropy) of sigmoid(K·q/400) against
 * the blended target, plus an L2 pull toward the shipped weights. The
 * evaluation is LINEAR in every tuned weight, so this is regularised logistic
 * regression: a CONVEX problem with (for lambda > 0) a unique optimum — the
 * deterministic, no-local-minima setting that motivated tuning the HCE
 * instead of an NNUE (issue #105 discussion). #63 used a squared-error loss,
 * which is not convex through a sigmoid; the log-loss is, and its gradient is
 * simpler. The lambda grid deliberately EXCLUDES 0: #63's inadmissible
 * candidate came from the unregularised corner, and the baseline is always in
 * the candidate set anyway, so "no change" never needs lambda 0 to win.
 *
 * Discipline carried over from #63 unchanged:
 *   - exact linear-feature reconstruction with fidelity self-checks against
 *     ai.js's own evaluate() — baseline AND distinct-weights oracle (now
 *     covering the tables, which also catches a1/a8 orientation errors);
 *   - GROUPED train/val/test split by game — no game straddles a boundary;
 *   - rounded scoring for every integer candidate (the engine plays
 *     Math.round(evaluate()));
 *   - lambda selected on VALIDATION with the baseline seeded into the
 *     candidate set; the winner reported on the UNTOUCHED test split;
 *   - the tuner NEVER writes assets/ai.js (see test/ai-tune-apply.js for the
 *     explicit, separate apply step).
 *
 * A lower held-out loss is a HYPOTHESIS, not a green light. Admissibility is
 * gated in order: the tactics suite FIRST (a failure there is terminal — the
 * #63 lesson), then the node benchmark, then the predeclared 800-game
 * clustered strict-strength match (one-sided 95% lower bound strictly above
 * 50%, per #104). Shipping additionally requires the Rust/WASM evaluator
 * (experiments/wasm/src/eval.rs, shipped as assets/chessy-ai-fast.wasm) to be
 * retuned in lockstep and rebuilt with the pinned toolchain, plus a release
 * bump — see test/ai-tune-findings.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const GEN = require('./ai-tune-gen.js');
const Chess = GEN.Chess;
const ChessAI = GEN.ChessAI;

// ---- CLI ----
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
  if (!Number.isSafeInteger(n) || n <= 0) { console.error('--' + name + ' must be a positive integer'); process.exit(2); }
  return n;
}
function fracIn(name, dflt, lo, hi) {
  const n = num(name, dflt);
  if (!(n > lo && n < hi)) { console.error('--' + name + ' must be in (' + lo + ', ' + hi + ')'); process.exit(2); }
  return n;
}

const DATA = opt('data', null);
const MIX_OUT = (function () {
  const n = num('mix-out', 0.5); // outcome weight in the blended target
  if (!(n >= 0 && n <= 1)) { console.error('--mix-out must be in [0, 1]'); process.exit(2); }
  return n;
})();
const VAL_FRAC = fracIn('val-frac', 0.15, 0, 1);
const TEST_FRAC = fracIn('test-frac', 0.15, 0, 1);
const LR = num('lr', 0.3);
const ITERS = posInt('iters', 1500);
const PASSES = posInt('passes', 3);
const SEED = posInt('seed', 1); // split/fidelity seed (data seed lives in the dataset)
const EMIT = opt('emit', null);

// The lambda grid EXCLUDES 0 by design (see header). --lambdas overrides for
// research, but 0 is still refused: the unregularised corner is exactly where
// #63 manufactured its inadmissible candidate, and the baseline is always a
// candidate, so nothing is lost.
const LAMBDA_GRID = (function () {
  const dflt = [0.02, 0.05, 0.1, 0.2, 0.5, 1.0];
  if (!args.includes('--lambdas')) return dflt;
  return opt('lambdas', '').split(',').map(function (s) {
    const n = Number(s.trim());
    if (!(Number.isFinite(n) && n > 0)) { console.error('--lambdas entries must be finite and > 0 (got "' + s + '")'); process.exit(2); }
    return n;
  });
})();

const mulberry32 = GEN.mulberry32;

// ============================================================================
// Shipped evaluation constants, extracted from assets/ai.js SOURCE at load
// time — a single source of truth instead of #63's hand-copied tables (which
// went stale the moment #79 landed PeSTO). The extraction is validated twice:
// structurally here, and semantically by the fidelity checks below (the
// reconstruction must equal evaluate() on fresh positions, so a partial or
// drifted extraction cannot silently tune the wrong function).
// ============================================================================
function extractShipped() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'ai.js'), 'utf8');
  const pieces = [
    /const VALUES_MG = \{[^}]*\};/,
    /const VALUES_EG = \{[^}]*\};/,
    /const PST = \{[\s\S]*?\n  \};/,
    /const PST_EG = \{[\s\S]*?\n  \};/,
    /const PHASE = \{[^}]*\};/,
    /const PHASE_MAX = \d+;/,
    /const MOBILITY = \{[^}]*\};/,
    /const DOUBLED = \d+, ISOLATED = \d+, SHIELD = \d+;/,
    /const PASSED_MG = \[[^\]]*\];/,
    /const PASSED_EG = \[[^\]]*\];/
  ];
  let decls = '';
  for (const re of pieces) {
    const m = src.match(re);
    if (!m) throw new Error('could not extract shipped constant matching ' + re + ' from assets/ai.js — the tuner needs updating');
    decls += m[0] + '\n';
  }
  return new Function(decls +
    'return { VALUES_MG: VALUES_MG, VALUES_EG: VALUES_EG, PST: PST, PST_EG: PST_EG, PHASE: PHASE, ' +
    'PHASE_MAX: PHASE_MAX, MOBILITY: MOBILITY, DOUBLED: DOUBLED, ISOLATED: ISOLATED, SHIELD: SHIELD, ' +
    'PASSED_MG: PASSED_MG, PASSED_EG: PASSED_EG };')();
}
const S = extractShipped();
if (S.PHASE_MAX !== 24) throw new Error('PHASE_MAX changed — retune the taper folding');
const PHASE_MAX = S.PHASE_MAX;

// ============================================================================
// Weight vector layout: 17 auxiliary + 2 x 368 piece-square entries = 753.
//
// Auxiliary (17): mobN mobB mobR mobQ doubled isolated shield pMg1..pMg5
// pEg1..pEg5. PASSED[0] is structurally 0 (a pawn zero ranks advanced is on
// its home rank) and PASSED[6] is the promotion rank, where no pawn can stand
// (applyMove promotes immediately) — both unidentifiable, both left at their
// shipped values (the #63 pinning, now simply outside the vector).
//
// Piece-square (368 per phase): P over squares 8..55 only — a pawn can never
// stand on rank 8 or rank 1, so those 16 entries per table are unidentifiable
// and stay at their shipped (zero) values — then N, B, R, Q, K over all 64.
// Material VALUES_MG/EG are NOT in the vector: a constant added to all of a
// piece's table entries is exactly a material change (collinear), so the
// tables absorb material retuning and the explicit values stay fixed.
// ============================================================================
const AUX_ORDER = ['mobN', 'mobB', 'mobR', 'mobQ', 'doubled', 'isolated', 'shield',
  'pMg1', 'pMg2', 'pMg3', 'pMg4', 'pMg5', 'pEg1', 'pEg2', 'pEg3', 'pEg4', 'pEg5'];
const NAUX = AUX_ORDER.length; // 17
const TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
const PST_SQUARES = { P: 48, N: 64, B: 64, R: 64, Q: 64, K: 64 }; // per phase
const NPST = 368;
const PST_MG_BASE = NAUX;
const PST_EG_BASE = NAUX + NPST;
const NW = NAUX + 2 * NPST; // 753

// slot of (phase, type, relative square) in the vector, or -1 if unidentifiable.
const TYPE_OFF = (function () {
  const off = {};
  let o = 0;
  for (const t of TYPES) { off[t] = o; o += PST_SQUARES[t]; }
  return off;
})();
function pstSlot(eg, type, sq) {
  let s = sq;
  if (type === 'P') {
    if (sq < 8 || sq >= 56) return -1; // unreachable pawn ranks
    s = sq - 8;
  }
  return (eg ? PST_EG_BASE : PST_MG_BASE) + TYPE_OFF[type] + s;
}

// Full-weights dict <-> vector. The dict carries complete shipped-shape
// tables (unidentifiable entries at their shipped values), which is what the
// fidelity oracle, the emit format, and test/ai-tune-apply.js consume.
function wToVec(w) {
  const v = new Float64Array(NW);
  v[0] = w.mobN; v[1] = w.mobB; v[2] = w.mobR; v[3] = w.mobQ;
  v[4] = w.doubled; v[5] = w.isolated; v[6] = w.shield;
  for (let k = 1; k <= 5; k++) { v[6 + k] = w.passedMg[k]; v[11 + k] = w.passedEg[k]; }
  for (const t of TYPES) {
    for (let sq = 0; sq < 64; sq++) {
      const mg = pstSlot(false, t, sq), eg = pstSlot(true, t, sq);
      if (mg >= 0) v[mg] = w.pstMg[t][sq];
      if (eg >= 0) v[eg] = w.pstEg[t][sq];
    }
  }
  return v;
}
function vecToW(v) {
  const w = {
    mobN: v[0], mobB: v[1], mobR: v[2], mobQ: v[3],
    doubled: v[4], isolated: v[5], shield: v[6],
    passedMg: S.PASSED_MG.slice(), passedEg: S.PASSED_EG.slice(),
    pstMg: {}, pstEg: {}
  };
  for (let k = 1; k <= 5; k++) { w.passedMg[k] = v[6 + k]; w.passedEg[k] = v[11 + k]; }
  for (const t of TYPES) {
    w.pstMg[t] = S.PST[t].slice();
    w.pstEg[t] = S.PST_EG[t].slice();
    for (let sq = 0; sq < 64; sq++) {
      const mg = pstSlot(false, t, sq), eg = pstSlot(true, t, sq);
      if (mg >= 0) w.pstMg[t][sq] = v[mg];
      if (eg >= 0) w.pstEg[t][sq] = v[eg];
    }
  }
  return w;
}
const BASE_W = {
  mobN: S.MOBILITY.N, mobB: S.MOBILITY.B, mobR: S.MOBILITY.R, mobQ: S.MOBILITY.Q,
  doubled: S.DOUBLED, isolated: S.ISOLATED, shield: S.SHIELD,
  passedMg: S.PASSED_MG.slice(), passedEg: S.PASSED_EG.slice(),
  pstMg: { P: S.PST.P, N: S.PST.N, B: S.PST.B, R: S.PST.R, Q: S.PST.Q, K: S.PST.K },
  pstEg: { P: S.PST_EG.P, N: S.PST_EG.N, B: S.PST_EG.B, R: S.PST_EG.R, Q: S.PST_EG.Q, K: S.PST_EG.K }
};
const BASE_VEC = wToVec(BASE_W);

// Per-parameter regularisation scale: a move of one scale unit costs the same
// penalty everywhere. Aux scales are #63's; table entries get 20 cp — a real
// positional repricing, well below a pawn.
const REG_SCALE = (function () {
  const s = new Float64Array(NW);
  const aux = [3, 3, 2, 2, 8, 8, 6, 30, 30, 30, 30, 30, 40, 40, 40, 40, 40];
  for (let j = 0; j < NAUX; j++) s[j] = aux[j];
  for (let j = NAUX; j < NW; j++) s[j] = 20;
  return s;
})();

// Domain bounds: aux ranges as #63; every table entry may move at most ±80 cp
// from its shipped value — wide enough to matter, narrow enough that the fit
// cannot wander into a different game.
const LO = (function () {
  const v = new Float64Array(NW);
  const aux = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let j = 0; j < NAUX; j++) v[j] = aux[j];
  for (let j = NAUX; j < NW; j++) v[j] = BASE_VEC[j] - 80;
  return v;
})();
const HI = (function () {
  const v = new Float64Array(NW);
  const aux = [12, 12, 12, 12, 40, 40, 30, 200, 200, 200, 200, 200, 300, 300, 300, 300, 300];
  for (let j = 0; j < NAUX; j++) v[j] = aux[j];
  for (let j = NAUX; j < NW; j++) v[j] = BASE_VEC[j] + 80;
  return v;
})();
function clampVec(v) {
  const out = Float64Array.from(v);
  for (let j = 0; j < NW; j++) out[j] = Math.max(LO[j], Math.min(HI[j], out[j]));
  return out;
}

// ============================================================================
// Feature extraction — mirrors assets/ai.js evaluate() term by term. A
// position reduces to a fixed base (material taper + mop-up), the phase, a
// sparse list of piece-square incidences, and the auxiliary features. The
// fidelity checks below prove the reconstruction equals evaluate() exactly.
// ============================================================================
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const ALL_DIRS = DIAG.concat(ORTHO);
const N_JUMPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

function mobility(board, i, type, color) { // byte-for-byte port of ai.js mobility()
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

function mopUp(loser, winner) { // byte-for-byte port of ai.js mopUp()
  const lr = loser >> 3, lf = loser & 7;
  const wr = winner >> 3, wf = winner & 7;
  const cmd = Math.max(3 - lf, lf - 4) + Math.max(3 - lr, lr - 4);
  const kd = Math.abs(lr - wr) + Math.abs(lf - wf);
  return 8 * cmd + 2 * (14 - kd);
}

// features(board) -> { ph, baseMg, baseEg, mop, pst:[{t, sq, sign}...],
//   fN,fB,fR,fQ,fD,fI,fS, fp:[5] }. `sign` is +1 White / -1 Black; `sq` is the
// piece's RELATIVE square (Black mirrored, exactly as evaluate() indexes).
function features(board) {
  let ph = 0, baseMg = 0, baseEg = 0;
  let fN = 0, fB = 0, fR = 0, fQ = 0, fD = 0, fI = 0, fS = 0;
  const fp = [0, 0, 0, 0, 0];
  const pst = [];
  const pawnFiles = { w: [0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0, 0] };
  const pawnSquares = { w: [], b: [] };
  const kings = { w: -1, b: -1 };
  const force = { w: 0, b: 0 };
  const pieces = { w: 0, b: 0 };

  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const color = p[0], type = p[1];
    const sign = color === 'w' ? 1 : -1;
    const sq = color === 'w' ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
    ph += S.PHASE[type];
    baseMg += sign * S.VALUES_MG[type];
    baseEg += sign * S.VALUES_EG[type];
    pst.push({ t: type, sq: sq, sign: sign });
    if (type !== 'K') force[color]++;
    if (type === 'P') {
      pawnFiles[color][i % 8]++;
      pawnSquares[color].push(i);
    } else if (type === 'K') {
      kings[color] = i;
    } else {
      pieces[color]++;
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
        if (rr === 6) throw new Error('promotion-rank passed pawn in a sampled position — impossible');
        if (rr >= 1) fp[rr - 1] += sign;
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

  // Mop-up is untuned and enters AFTER the taper is rounded; since it is an
  // integer, round(taper)+mop == round(taper+mop) and it folds into the base.
  let mop = 0;
  if (kings.w >= 0 && kings.b >= 0) {
    if (pieces.w > 0 && force.b === 0) mop = mopUp(kings.b, kings.w);
    else if (pieces.b > 0 && force.w === 0) mop = -mopUp(kings.w, kings.b);
  }

  return { ph: Math.min(ph, PHASE_MAX), baseMg: baseMg, baseEg: baseEg, mop: mop,
    pst: pst, fN: fN, fB: fB, fR: fR, fQ: fQ, fD: fD, fI: fI, fS: fS, fp: fp };
}

// Exact evaluation of a feature record under a full-weights dict: integer
// mg/eg accumulation and the engine's own single rounded division, so the
// fidelity comparison is exact (no float-order drift). `round` false only for
// smooth diagnostics.
function evalFeat(ft, w, round) {
  let mg = ft.baseMg, eg = ft.baseEg;
  for (const e of ft.pst) {
    mg += e.sign * w.pstMg[e.t][e.sq];
    eg += e.sign * w.pstEg[e.t][e.sq];
  }
  const mob = w.mobN * ft.fN + w.mobB * ft.fB + w.mobR * ft.fR + w.mobQ * ft.fQ;
  const pen = w.doubled * ft.fD + w.isolated * ft.fI;
  mg += mob + pen + w.shield * ft.fS;
  eg += mob + pen;
  for (let k = 0; k < 5; k++) { mg += w.passedMg[k + 1] * ft.fp[k]; eg += w.passedEg[k + 1] * ft.fp[k]; }
  const q = (mg * ft.ph + eg * (PHASE_MAX - ft.ph)) / PHASE_MAX;
  return (round ? Math.round(q) : q) + ft.mop;
}

// Compile a feature record to the sparse linear form q(w) = base + c·w with
// the taper folded into each coefficient. Same-slot incidences accumulate.
function compile(ft) {
  const ph = ft.ph, mgw = ph / PHASE_MAX, egw = (PHASE_MAX - ph) / PHASE_MAX;
  const acc = new Map();
  function add(j, v) { if (j >= 0 && v !== 0) acc.set(j, (acc.get(j) || 0) + v); }
  add(0, ft.fN); add(1, ft.fB); add(2, ft.fR); add(3, ft.fQ);
  add(4, ft.fD); add(5, ft.fI);
  add(6, ft.fS * mgw);
  for (let k = 0; k < 5; k++) { add(7 + k, ft.fp[k] * mgw); add(12 + k, ft.fp[k] * egw); }
  for (const e of ft.pst) {
    add(pstSlot(false, e.t, e.sq), e.sign * mgw);
    add(pstSlot(true, e.t, e.sq), e.sign * egw);
  }
  const idx = new Int32Array(acc.size);
  const val = new Float64Array(acc.size);
  let n = 0;
  for (const [j, v] of acc) { idx[n] = j; val[n] = v; n++; }
  const base = (ft.baseMg * ph + ft.baseEg * (PHASE_MAX - ph)) / PHASE_MAX + ft.mop;
  return { base: base, idx: idx, val: val };
}
function qVec(s, v) {
  let q = s.base;
  for (let n = 0; n < s.idx.length; n++) q += s.val[n] * v[s.idx[n]];
  return q;
}

// ============================================================================
// Loss: cross-entropy of sigmoid(K·q/400) against a (possibly soft) target in
// [0, 1] — convex in q, hence in w (q is affine in w). Rounded scoring for
// integer candidates, exactly as #63: the engine plays Math.round(evaluate()).
// ============================================================================
function sigmoid(q, K) { return 1 / (1 + Math.pow(10, -K * q / 400)); }
const P_EPS = 1e-12;
function ceLoss(samples, v, K, round) {
  let s = 0;
  for (const smp of samples) {
    const q = qVec(smp, v);
    const p = Math.min(1 - P_EPS, Math.max(P_EPS, sigmoid(round ? Math.round(q) : q, K)));
    s -= smp.y * Math.log(p) + (1 - smp.y) * Math.log(1 - p);
  }
  return s / samples.length;
}
// Squared-error reference (the #63 metric) — reported for comparability only.
function mseLoss(samples, v, K, round) {
  let s = 0;
  for (const smp of samples) {
    const d = smp.y - sigmoid(round ? Math.round(qVec(smp, v)) : qVec(smp, v), K);
    s += d * d;
  }
  return s / samples.length;
}

function regPenalty(v, lambda) {
  let p = 0;
  for (let j = 0; j < NW; j++) { const d = (v[j] - BASE_VEC[j]) / REG_SCALE[j]; p += d * d; }
  return lambda * p / NW;
}
function objective(samples, v, K, lambda, round) { return ceLoss(samples, v, K, round) + regPenalty(v, lambda); }

// Analytic gradient of the smooth objective. For the cross-entropy link,
// dCE/dq = a·(p - y) with a = K·ln10/400 — exact, cheap, and convex.
function gradient(samples, v, K, lambda) {
  const a = K * Math.LN10 / 400;
  const g = new Float64Array(NW);
  const N = samples.length;
  for (const smp of samples) {
    const p = sigmoid(qVec(smp, v), K);
    const f = a * (p - smp.y) / N;
    for (let n = 0; n < smp.idx.length; n++) g[smp.idx[n]] += f * smp.val[n];
  }
  for (let j = 0; j < NW; j++) g[j] += (2 * lambda / NW) * (v[j] - BASE_VEC[j]) / (REG_SCALE[j] * REG_SCALE[j]);
  return g;
}

// K is fitted ONCE, on the baseline weights against PURE OUTCOME labels
// (rounded scoring), before any target blending: K is the engine's own
// cp-to-win-probability calibration on this data, and the blended targets
// then use the same K so score targets and the link function agree.
function fitK(samples, v) {
  function lossAt(K) {
    let s = 0;
    for (const smp of samples) {
      const p = Math.min(1 - P_EPS, Math.max(P_EPS, sigmoid(Math.round(qVec(smp, v)), K)));
      s -= smp.out * Math.log(p) + (1 - smp.out) * Math.log(1 - p);
    }
    return s / samples.length;
  }
  let best = 0, bestE = Infinity;
  for (let K = 0.0; K <= 3.0; K += 0.05) { const e = lossAt(K); if (e < bestE) { bestE = e; best = K; } }
  for (let K = Math.max(0, best - 0.05); K <= best + 0.05; K += 0.005) {
    const e = lossAt(K); if (e < bestE) { bestE = e; best = K; }
  }
  return best;
}
const K_MIN = 0.10;

// Deterministic full-batch RMSProp on the smooth convex objective (best-seen
// returned). RMSProp here is a per-parameter preconditioner for a badly
// scaled but CONVEX problem — with lambda > 0 the optimum is unique, so this
// is a deterministic descent to it, not a stochastic search.
function descend(train, K, lambda, opts) {
  opts = opts || {};
  const lr = opts.lr != null ? opts.lr : LR, iters = opts.iters != null ? opts.iters : ITERS;
  const quiet = !!opts.quiet;
  let v = opts.start ? clampVec(opts.start) : Float64Array.from(BASE_VEC);
  const cache = new Float64Array(NW);
  let best = Float64Array.from(v), bestObj = objective(train, v, K, lambda, false);
  for (let it = 0; it < iters; it++) {
    const g = gradient(train, v, K, lambda);
    for (let j = 0; j < NW; j++) {
      cache[j] = 0.9 * cache[j] + 0.1 * g[j] * g[j];
      v[j] = Math.max(LO[j], Math.min(HI[j], v[j] - lr * g[j] / (Math.sqrt(cache[j]) + 1e-8)));
    }
    const o = objective(train, v, K, lambda, false);
    if (o < bestObj) { bestObj = o; best = Float64Array.from(v); }
    if (!quiet && (it & 127) === 0) process.stderr.write('\rRMSProp it ' + it + '/' + iters + ', train obj ' + o.toFixed(6) + '   ');
  }
  if (!quiet) process.stderr.write('\n');
  return best;
}

// Integer coordinate-descent polish on the ROUNDED objective, made tractable
// at 753 dimensions by an inverted (per-parameter) sample index and running
// per-sample q values: probing one weight touches only the samples whose
// coefficient for it is nonzero.
function polish(train, v0, K, lambda, opts) {
  opts = opts || {};
  const passes = opts.passes != null ? opts.passes : PASSES;
  const quiet = !!opts.quiet;
  const v = Float64Array.from(v0);
  const N = train.length;

  const colSamples = [], colCoefs = [];
  for (let j = 0; j < NW; j++) { colSamples.push([]); colCoefs.push([]); }
  const q = new Float64Array(N);
  for (let s = 0; s < N; s++) {
    const smp = train[s];
    q[s] = qVec(smp, v);
    for (let n = 0; n < smp.idx.length; n++) {
      colSamples[smp.idx[n]].push(s);
      colCoefs[smp.idx[n]].push(smp.val[n]);
    }
  }
  function ceAt(s, qs) {
    const p = Math.min(1 - P_EPS, Math.max(P_EPS, sigmoid(Math.round(qs), K)));
    return -(train[s].y * Math.log(p) + (1 - train[s].y) * Math.log(1 - p));
  }
  function probe(j, nv) {
    const d = nv - v[j];
    let delta = 0;
    const ss = colSamples[j], cc = colCoefs[j];
    for (let n = 0; n < ss.length; n++) delta += ceAt(ss[n], q[ss[n]] + d * cc[n]) - ceAt(ss[n], q[ss[n]]);
    const rOld = (v[j] - BASE_VEC[j]) / REG_SCALE[j], rNew = (nv - BASE_VEC[j]) / REG_SCALE[j];
    return delta / N + lambda * (rNew * rNew - rOld * rOld) / NW;
  }
  function commit(j, nv) {
    const d = nv - v[j];
    const ss = colSamples[j], cc = colCoefs[j];
    for (let n = 0; n < ss.length; n++) q[ss[n]] += d * cc[n];
    v[j] = nv;
  }

  let converged = false;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (let j = 0; j < NW; j++) {
      for (const dir of [1, -1]) {
        let step = 1;
        for (;;) {
          const nv = Math.max(LO[j], Math.min(HI[j], v[j] + dir * step));
          if (nv === v[j]) break;
          if (probe(j, nv) < -1e-13) { commit(j, nv); improved = true; step *= 2; }
          else break;
        }
      }
    }
    if (!quiet) process.stderr.write('\rinteger polish pass ' + (pass + 1) + '/' + passes + '   ');
    if (!improved) { converged = true; break; }
  }
  if (!quiet) process.stderr.write('\n');
  if (!converged) {
    process.stderr.write('WARNING: integer polish still improving after ' + passes +
      ' passes (lambda ' + lambda + ') — candidate is NOT a verified integer local optimum; raise --passes.\n');
  }
  return v;
}

function fitCandidate(train, K, lambda, opts) {
  opts = opts || {};
  const cont = descend(train, K, lambda, opts);
  const rounded = clampVec(Float64Array.from(cont, Math.round));
  return polish(train, rounded, K, lambda, opts);
}

// ---- grouped split by game (verbatim #63 semantics) ----
function groupedSplit(samples, valFrac, testFrac, seed) {
  const ids = Array.from(new Set(samples.map(function (s) { return s.game; })));
  const rng = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
  let nTest = Math.round(ids.length * testFrac), nVal = Math.round(ids.length * valFrac);
  if (testFrac > 0 && nTest === 0) nTest = 1;
  if (valFrac > 0 && nVal === 0) nVal = 1;
  if (nTest + nVal >= ids.length) {
    throw new Error('grouped split leaves no training games: ' + ids.length + ' games, val ' +
      nVal + ' + test ' + nTest + ' >= all.');
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

// ---- fidelity: baseline and distinct-weights oracle ----
function randomPosition(rng, maxPlies) {
  let st = Chess.newGameState();
  const plies = 4 + Math.floor(rng() * maxPlies);
  for (let i = 0; i < plies; i++) {
    if (Chess.gameStatus(st).over) return null;
    const legal = Chess.legalMoves(st);
    st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
  }
  return st;
}

function fidelityCheck(n, seed) {
  const rng = mulberry32(seed);
  let checked = 0, bad = 0;
  for (let t = 0; t < n; t++) {
    const st = randomPosition(rng, 60);
    if (!st) continue;
    checked++;
    if (evalFeat(features(st.board), BASE_W, true) !== ChessAI.evaluate(st.board)) bad++;
  }
  // Bare-king fixtures: random playouts rarely reach the mop-up branch, so it
  // is exercised explicitly — both colors, winning piece vs winning pawn
  // (the pawn case must NOT engage mop-up, per the gate in evaluate()).
  const fens = [
    '8/8/3k4/8/8/3QK3/8/8 w - - 0 1',   // W: K+Q vs bare K -> mop-up for White
    '8/8/3K4/8/8/3qk3/8/8 b - - 0 1',   // mirrored for Black
    '8/8/3k4/8/8/3RK3/8/8 w - - 0 1',
    '8/8/3k4/8/8/3PK3/8/8 w - - 0 1',   // pawn only: mop-up must stay OFF
    '8/8/8/4k3/8/8/4PK2/4r3 b - - 4 30' // K+P vs K+R: nobody bare
  ];
  for (const fen of fens) {
    const st = Chess.parseFen(fen);
    checked++;
    if (evalFeat(features(st.board), BASE_W, true) !== ChessAI.evaluate(st.board)) bad++;
  }
  return { checked: checked, bad: bad };
}

// Distinct-weights oracle: load assets/ai.js in a fresh realm with EVERY
// tunable constant replaced by a distinct perturbed value — tables included —
// and require evalFeat to match that engine under the same weights. Equal
// shipped values can hide a swapped wire (mobN==mobB, doubled==isolated) and
// symmetric-ish tables can hide an orientation slip; distinct per-entry
// values catch a1/a8 mirroring, color-swap, mg/eg swaps, and wrong-piece
// wiring. Deterministic pseudo-random deltas keep every entry distinct.
function makePerturbedW(seed) {
  const rng = mulberry32(seed);
  const d = function (span) { return Math.floor(rng() * (2 * span + 1)) - span; };
  const w = {
    mobN: 4, mobB: 5, mobR: 6, mobQ: 7, doubled: 9, isolated: 11, shield: 13,
    passedMg: [0, 3, 17, 23, 29, 41, S.PASSED_MG[6]],
    passedEg: [0, 8, 19, 31, 37, 47, S.PASSED_EG[6]],
    pstMg: {}, pstEg: {}
  };
  for (const t of TYPES) {
    w.pstMg[t] = S.PST[t].map(function (x, sq) { return (t === 'P' && (sq < 8 || sq >= 56)) ? x : x + d(9); });
    w.pstEg[t] = S.PST_EG[t].map(function (x, sq) { return (t === 'P' && (sq < 8 || sq >= 56)) ? x : x + d(9); });
  }
  return w;
}
function tableSrc(tables) {
  return '{\n' + TYPES.map(function (t) { return '    ' + t + ': [' + tables[t].join(',') + ']'; }).join(',\n') + '\n  };';
}
function loadEngineWithWeights(w) {
  const read = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };
  let src = read('assets/ai.js');
  const subs = [
    [/const MOBILITY = \{[^}]*\};/, 'const MOBILITY = { N: ' + w.mobN + ', B: ' + w.mobB + ', R: ' + w.mobR + ', Q: ' + w.mobQ + ' };'],
    [/const DOUBLED = \d+, ISOLATED = \d+, SHIELD = \d+;/, 'const DOUBLED = ' + w.doubled + ', ISOLATED = ' + w.isolated + ', SHIELD = ' + w.shield + ';'],
    [/const PASSED_MG = \[[^\]]*\];/, 'const PASSED_MG = [' + w.passedMg.join(', ') + '];'],
    [/const PASSED_EG = \[[^\]]*\];/, 'const PASSED_EG = [' + w.passedEg.join(', ') + '];'],
    [/const PST = \{[\s\S]*?\n  \};/, 'const PST = ' + tableSrc(w.pstMg)],
    [/const PST_EG = \{[\s\S]*?\n  \};/, 'const PST_EG = ' + tableSrc(w.pstEg)]
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
  const w = makePerturbedW(seed ^ 0x5A5A5A5A);
  const ctx = loadEngineWithWeights(w);
  const rng = mulberry32(seed);
  let checked = 0, bad = 0;
  for (let t = 0; t < n; t++) {
    const st = randomPosition(rng, 60);
    if (!st) continue;
    checked++;
    if (evalFeat(features(st.board), w, true) !== ctx.ChessAI.evaluate(st.board)) bad++;
  }
  return { checked: checked, bad: bad, w: w };
}

// ---- dataset loading: decode boards, extract features, dedup, compile ----
function loadDataset(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!raw || raw.config == null || raw.config.schema !== GEN.SCHEMA) {
    console.error('dataset ' + file + ' has schema ' + (raw && raw.config && raw.config.schema) +
      ', expected ' + GEN.SCHEMA + ' — regenerate with test/ai-tune-gen.js');
    process.exit(1);
  }
  // Exact-duplicate positions (same board, same side to move) can appear when
  // two games share a book truncation; keep the first so a position can never
  // sit on both sides of the split with two labels.
  const seen = new Set();
  const out = [];
  let dups = 0;
  for (const s of raw.samples) {
    const key = s.b + s.stm;
    if (seen.has(key)) { dups++; continue; }
    seen.add(key);
    out.push(s);
  }
  return { config: raw.config, games: raw.games, decisive: raw.decisive,
    whiteToMove: raw.whiteToMove, samples: out, dups: dups };
}

// ---- candidate sanity report (the #63 "chess-nonsensical" guard) ----
function sanityReport(w) {
  const notes = [];
  const mono = function (arr, label) {
    for (let k = 1; k < 6; k++) {
      if (arr[k] < arr[k - 1]) { notes.push(label + ' is non-monotonic at rank ' + k + ' (' + arr.join(',') + ')'); return; }
    }
  };
  mono(w.passedMg, 'passedMg'); mono(w.passedEg, 'passedEg');
  if (w.mobN < 1 || w.mobB < 1 || w.mobR < 1) notes.push('a mobility weight fell below 1 (N ' + w.mobN + ', B ' + w.mobB + ', R ' + w.mobR + ')');
  if (w.shield >= 25) notes.push('shield near its cap (' + w.shield + ')');
  let maxD = 0, moved = 0, movedPst = 0;
  const v = wToVec(w);
  for (let j = 0; j < NW; j++) {
    const d = Math.abs(v[j] - BASE_VEC[j]);
    if (d > 0) { moved++; if (j >= NAUX) movedPst++; }
    if (j >= NAUX && d > maxD) maxD = d;
  }
  return { notes: notes, moved: moved, movedPst: movedPst, maxPstDelta: maxD };
}

// ============================================================================
function main() {
  if (!DATA) { console.error('--data <dataset.json> is required (generate with test/ai-tune-gen.js)'); process.exit(2); }
  console.log('# Chessy evaluation tuner v2 (full weight vector, convex log-loss)');
  console.log('config: mix-out=' + MIX_OUT + ' lambdas=' + LAMBDA_GRID.join(',') + ' lr=' + LR +
    ' iters=' + ITERS + ' passes=' + PASSES + ' val-frac=' + VAL_FRAC + ' test-frac=' + TEST_FRAC + ' seed=' + SEED);

  const data = loadDataset(DATA);
  console.log('data: ' + data.games + ' games (' + data.decisive + ' decisive, ' +
    (100 * data.decisive / data.games).toFixed(1) + '%), ' + data.samples.length + ' positions after dedup (' +
    data.dups + ' duplicates dropped), generated with ' + JSON.stringify(data.config));
  if (data.samples.length < 1000) { console.error('too few positions (' + data.samples.length + ') — raise --games'); process.exit(1); }

  const fid = fidelityCheck(400, SEED ^ 0xdeadbeef);
  const pfid = perturbedFidelityCheck(400, SEED ^ 0xbeefcafe);
  if (fid.bad > 0 || pfid.bad > 0) {
    console.error('FAIL: feature reconstruction diverges from ai.js evaluate() — baseline ' + fid.bad + '/' + fid.checked +
      ', distinct-weights ' + pfid.bad + '/' + pfid.checked + '. Feature code is out of sync with assets/ai.js.');
    process.exit(1);
  }
  console.log('fidelity: reconstruction matches ai.js evaluate() on ' + fid.checked + ' baseline + ' +
    pfid.checked + ' distinct-weights fresh random positions (tables perturbed per entry)');

  // Features/compile, then the grouped split BEFORE any statistic that could
  // influence selection is looked at on val/test.
  const t0 = Date.now();
  const compiled = data.samples.map(function (s) {
    const c = compile(features(GEN.decodeBoard(s.b)));
    c.game = s.game; c.out = s.out; c.cp = s.cp;
    return c;
  });
  console.log('compiled ' + compiled.length + ' positions in ' + Math.round((Date.now() - t0) / 1000) + 's');
  const sp = groupedSplit(compiled, VAL_FRAC, TEST_FRAC, SEED ^ 0x1234abcd);
  console.log('grouped split (by game): train ' + sp.nGames.train + ' games/' + sp.train.length + ' pos, val ' +
    sp.nGames.val + '/' + sp.val.length + ', test ' + sp.nGames.test + '/' + sp.test.length);

  const trainDecisive = sp.train.reduce(function (a, s) { return a + (s.out !== 0.5 ? 1 : 0); }, 0);
  if (trainDecisive === 0) { console.error('training split has no decided games — no outcome signal.'); process.exit(1); }

  // K on pure outcomes at baseline (the cp<->probability calibration), THEN
  // blend the targets with that same K.
  const K = fitK(sp.train, BASE_VEC);
  if (K < K_MIN) {
    console.error('fitted sigmoid scale K = ' + K.toFixed(4) + ' < ' + K_MIN + ' — too little decisive signal.');
    process.exit(1);
  }
  console.log('sigmoid scale K (baseline, train outcomes): ' + K.toFixed(4) +
    ' (train decisive positions ' + trainDecisive + '/' + sp.train.length + ')');
  for (const part of [sp.train, sp.val, sp.test]) {
    for (const s of part) s.y = MIX_OUT * s.out + (1 - MIX_OUT) * sigmoid(s.cp, K);
  }

  const baseTrain = ceLoss(sp.train, BASE_VEC, K, true);
  const baseVal = ceLoss(sp.val, BASE_VEC, K, true);
  const baseTest = ceLoss(sp.test, BASE_VEC, K, true);
  console.log('baseline CE loss (rounded, blended targets): train ' + baseTrain.toFixed(6) +
    '  val ' + baseVal.toFixed(6) + '  test ' + baseTest.toFixed(6));

  console.log('\nlambda sweep (fit on train, selected on val; baseline in the candidate set; ' + NW + ' parameters):');
  console.log('  lambda   trainΔ%   valΔ%    moved(aux/pst)');
  let bestLam = 'baseline', bestValLoss = baseVal, bestVec = Float64Array.from(BASE_VEC);
  const sweep = [];
  for (const lambda of LAMBDA_GRID) {
    const vec = fitCandidate(sp.train, K, lambda, { quiet: true });
    const vTrain = ceLoss(sp.train, vec, K, true), vVal = ceLoss(sp.val, vec, K, true);
    let movedAux = 0, movedPst = 0;
    for (let j = 0; j < NW; j++) if (vec[j] !== BASE_VEC[j]) { if (j < NAUX) movedAux++; else movedPst++; }
    console.log('  ' + String(lambda).padEnd(7) +
      ' ' + (100 * (baseTrain - vTrain) / baseTrain).toFixed(3).padStart(8) +
      ' ' + (100 * (baseVal - vVal) / baseVal).toFixed(3).padStart(8) +
      '    ' + movedAux + '/' + movedPst);
    sweep.push({ lambda: lambda, trainCe: vTrain, valCe: vVal, movedAux: movedAux, movedPst: movedPst });
    if (vVal < bestValLoss - 1e-15) { bestValLoss = vVal; bestLam = lambda; bestVec = vec; }
  }

  const candVec = bestVec, cand = vecToW(candVec);
  const candTest = ceLoss(sp.test, candVec, K, true);
  const moved = candVec.some(function (x, j) { return x !== BASE_VEC[j]; });
  console.log('\nselected: ' + (moved ? 'lambda = ' + bestLam : 'BASELINE (no swept lambda beat the shipped weights on validation)'));
  console.log('FINAL (untouched test set, rounded): baseline CE ' + baseTest.toFixed(6) + '  candidate CE ' + candTest.toFixed(6) +
    '  ->  ' + (100 * (baseTest - candTest) / baseTest).toFixed(3) + '% ' +
    (candTest < baseTest ? 'lower (better)' : candTest > baseTest ? 'higher (worse)' : 'equal'));
  console.log('reference (same test set): baseline MSE ' + mseLoss(sp.test, BASE_VEC, K, true).toFixed(6) +
    '  candidate MSE ' + mseLoss(sp.test, candVec, K, true).toFixed(6));

  const sane = sanityReport(cand);
  console.log('\nsanity: ' + sane.moved + '/' + NW + ' weights moved (' + sane.movedPst + ' table entries, max |Δ| ' +
    sane.maxPstDelta + ' cp)' + (sane.notes.length ? '\n  ' + sane.notes.join('\n  ') : ' — no flags'));
  if (moved) {
    console.log('aux weights (baseline -> candidate):');
    const fmt = function (x) { return String(Math.round(x)); };
    console.log('  MOBILITY { N: ' + fmt(cand.mobN) + ', B: ' + fmt(cand.mobB) + ', R: ' + fmt(cand.mobR) + ', Q: ' + fmt(cand.mobQ) + ' }' +
      '   DOUBLED ' + fmt(cand.doubled) + ', ISOLATED ' + fmt(cand.isolated) + ', SHIELD ' + fmt(cand.shield));
    console.log('  PASSED_MG [' + cand.passedMg.map(fmt).join(', ') + ']');
    console.log('  PASSED_EG [' + cand.passedEg.map(fmt).join(', ') + ']');
  }

  console.log('\nverdict: ' + (!moved
    ? 'the validation-selected fit does not leave the shipped weights on THIS data — no candidate to ship'
    : candTest < baseTest
      ? 'candidate lowers the untouched test loss — a HYPOTHESIS only; admissible ONLY if it then clears, in order: the tactics suite, the node benchmark, and the predeclared 800-game clustered match (#104)'
      : 'candidate does not lower the untouched test loss — not admissible'));
  console.log('NOTE: shipping any evaluation change additionally requires the Rust/WASM evaluator to be retuned in');
  console.log('      lockstep and rebuilt with the pinned toolchain (assets/chessy-ai-fast.wasm is hash-gated), plus');
  console.log('      a release bump. See test/ai-tune-findings.md.');

  if (EMIT) {
    const intW = vecToW(Float64Array.from(candVec, Math.round));
    fs.writeFileSync(path.resolve(EMIT), JSON.stringify({
      tool: 'ai-tune v2', dataConfig: data.config,
      fitConfig: { mixOut: MIX_OUT, lambdaGrid: LAMBDA_GRID, lr: LR, iters: ITERS, passes: PASSES,
        valFrac: VAL_FRAC, testFrac: TEST_FRAC, seed: SEED },
      K: K, selectedLambda: bestLam, moved: moved,
      loss: { baseTrain: baseTrain, baseVal: baseVal, baseTest: baseTest, candTest: candTest, sweep: sweep },
      sanity: sane,
      candidate: {
        MOBILITY: { N: intW.mobN, B: intW.mobB, R: intW.mobR, Q: intW.mobQ },
        DOUBLED: intW.doubled, ISOLATED: intW.isolated, SHIELD: intW.shield,
        PASSED_MG: intW.passedMg.map(Math.round), PASSED_EG: intW.passedEg.map(Math.round),
        PST: TYPES.reduce(function (o, t) { o[t] = intW.pstMg[t].map(Math.round); return o; }, {}),
        PST_EG: TYPES.reduce(function (o, t) { o[t] = intW.pstEg[t].map(Math.round); return o; }, {})
      }
    }, null, 1) + '\n');
    console.log('\nwrote ' + EMIT);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    S: S, NW: NW, NAUX: NAUX, AUX_ORDER: AUX_ORDER, TYPES: TYPES,
    PST_MG_BASE: PST_MG_BASE, PST_EG_BASE: PST_EG_BASE, pstSlot: pstSlot,
    BASE_W: BASE_W, BASE_VEC: BASE_VEC, REG_SCALE: REG_SCALE, LO: LO, HI: HI, clampVec: clampVec,
    mulberry32: mulberry32, features: features, evalFeat: evalFeat, compile: compile, qVec: qVec,
    wToVec: wToVec, vecToW: vecToW,
    sigmoid: sigmoid, ceLoss: ceLoss, mseLoss: mseLoss, fitK: fitK, K_MIN: K_MIN,
    regPenalty: regPenalty, objective: objective, gradient: gradient,
    descend: descend, polish: polish, fitCandidate: fitCandidate, groupedSplit: groupedSplit,
    fidelityCheck: fidelityCheck, perturbedFidelityCheck: perturbedFidelityCheck,
    makePerturbedW: makePerturbedW, loadEngineWithWeights: loadEngineWithWeights,
    sanityReport: sanityReport, loadDataset: loadDataset,
    Chess: Chess, ChessAI: ChessAI
  };
}
