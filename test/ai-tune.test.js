/*
 * Regression test for the evaluation tuner (test/ai-tune.js). Fast and
 * deterministic, so it runs in PR CI even though the tuner's full experiment
 * does not — CI must exercise the deliverable, not just the engine it tunes.
 *
 * Covers the four things the tuner's correctness rests on:
 *   1. feature fidelity — the reconstructed evaluation equals ai.js evaluate();
 *   2. grouped splitting — no game straddles the train/val/test boundary, and
 *      every sample is placed exactly once;
 *   3. dataset cache round-trip — a serialized position reconstructs identically;
 *   4. optimizer recovery — on synthetic, noiseless data generated from a known
 *      weight vector, the fit recovers those weights.
 *
 * Run: node test/ai-tune.test.js
 */
'use strict';
const T = require('./ai-tune.js');
const Chess = T.Chess;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

// ---- 1. feature fidelity ----
// The tuner's fidelityCheck walks fresh random positions and compares its linear
// reconstruction to ai.js's own evaluate(); zero mismatches is the contract.
{
  const r = T.fidelityCheck(600, 0x1337);
  check(r.bad === 0 && r.checked > 100,
    'feature reconstruction equals ai.js evaluate() on all ' + r.checked + ' fresh positions',
    r.bad + ' mismatches');
}

// ---- 1b. feature IDENTITY via distinct weights ----
// The baseline check can't catch a coefficient wired to the wrong term (mobN and
// mobB are both 3, doubled and isolated both 12 — swapping those features is
// invisible at baseline). perturbedFidelityCheck loads a fresh engine realm with
// 19 DISTINCT tuned constants and requires evalFeat to match it, so any swap or
// mis-scaling diverges.
{
  const r = T.perturbedFidelityCheck(600, 0x2468);
  check(r.bad === 0 && r.checked > 100,
    'feature identity holds under 19 distinct weights on all ' + r.checked + ' fresh positions',
    r.bad + ' mismatches');
  // Guard the guard: if the distinct-weights engine and evalFeat were somehow the
  // SAME function as baseline, the check would be vacuous. Confirm the perturbed
  // evaluator actually differs from baseline on a real position.
  let st = Chess.newGameState();
  const rng = T.mulberry32(7);
  for (let i = 0; i < 20 && !Chess.gameStatus(st).over; i++) {
    const legal = Chess.legalMoves(st); st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
  }
  const ctx = T.loadEngineWithWeights(T.PERTURB_W);
  check(ctx.ChessAI.evaluate(st.board) !== T.ChessAI.evaluate(st.board),
    'distinct-weights evaluator actually differs from the shipped one (check is not vacuous)');
}

// ---- 2. grouped splitting ----
// Build synthetic samples tagged by game, split, and assert disjointness by game
// plus exact coverage (every sample placed once, none dropped or duplicated).
{
  // Each sample carries a UNIQUE id, so coverage can assert exact identities
  // (a routing bug that drops one sample and duplicates another from the same
  // game would preserve lengths and game-sets but change the id multiset).
  const samples = [];
  let uid = 0;
  for (let g = 0; g < 40; g++) {
    const n = 1 + (g % 7); // uneven group sizes
    for (let k = 0; k < n; k++) samples.push({ id: uid++, game: g, base: 0, c: new Float64Array(T.NW), y: 0.5 });
  }
  const sp = T.groupedSplit(samples, 0.15, 0.15, 42);
  const gid = function (arr) { return new Set(arr.map(function (s) { return s.game; })); };
  const tr = gid(sp.train), va = gid(sp.val), te = gid(sp.test);
  const overlap = function (a, b) { return [...a].some(function (x) { return b.has(x); }); };
  check(!overlap(tr, va) && !overlap(tr, te) && !overlap(va, te),
    'train/val/test game sets are pairwise disjoint (no leakage)');
  // Exact coverage by IDENTITY: the union of ids equals {0..N-1}, each once.
  const ids = sp.train.concat(sp.val, sp.test).map(function (s) { return s.id; }).sort(function (a, b) { return a - b; });
  let exact = ids.length === samples.length;
  for (let i = 0; i < ids.length; i++) if (ids[i] !== i) exact = false;
  check(exact, 'every sample placed exactly once, by identity (' + samples.length + ' unique ids)');
  check(tr.size + va.size + te.size === 40 && va.size > 0 && te.size > 0,
    'all 40 games partitioned, val and test non-empty (' + tr.size + '/' + va.size + '/' + te.size + ')');
  // Determinism: same seed -> identical MEMBERSHIP (not just equal sizes, which
  // an unseeded shuffle would also satisfy).
  const sp2 = T.groupedSplit(samples, 0.15, 0.15, 42);
  const sameMembership = function (a, b) {
    const A = new Set(a.map(function (s) { return s.id; }));
    return a.length === b.length && b.every(function (s) { return A.has(s.id); });
  };
  check(sameMembership(sp.train, sp2.train) && sameMembership(sp.val, sp2.val) && sameMembership(sp.test, sp2.test),
    'grouped split is deterministic under a fixed seed (identical membership)');
  // A different seed must change membership (guards against an ignored seed).
  const sp3 = T.groupedSplit(samples, 0.15, 0.15, 43);
  check(!sameMembership(sp.test, sp3.test),
    'a different seed produces a different partition (seed is actually used)');
}

// ---- 3. dataset cache round-trip ----
// The cache is JSON of {config, data:{samples:[{ft,y,game}]}}. A serialized
// feature record must reconstruct to the identical evaluation and coefficients.
{
  const rng = T.mulberry32(99);
  let worst = 0, n = 0;
  for (let t = 0; t < 80; t++) {
    let st = Chess.newGameState();
    const plies = 4 + Math.floor(rng() * 30);
    let ok = true;
    for (let i = 0; i < plies; i++) {
      if (Chess.gameStatus(st).over) { ok = false; break; }
      const legal = Chess.legalMoves(st);
      st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
    }
    if (!ok) continue;
    n++;
    const ft = T.features(st.board);
    const back = JSON.parse(JSON.stringify(ft)); // simulate cache write/read
    const a = T.compile(ft, 0.5), b = T.compile(back, 0.5);
    const qa = T.qVec(a, T.BASE_VEC), qb = T.qVec(b, T.BASE_VEC);
    worst = Math.max(worst, Math.abs(qa - qb));
  }
  check(n > 20 && worst === 0, 'JSON round-trip of a feature record reconstructs an identical evaluation (worst Δ ' + worst + ')');
}

// ---- 4. optimizer recovery on synthetic, noiseless data ----
// Generate samples from a KNOWN integer weight vector: label = sigmoid(true q).
// The MSE global minimum is then at the true weights (loss 0), so a working
// optimizer must descend to them. This isolates the fit from data noise.
{
  const K = 0.5;
  const wTrue = Float64Array.from(T.BASE_VEC);
  const deltas = { 0: +2, 4: -6, 6: +5, 7: +10, 13: -8 }; // move a few, varied scales
  for (const j in deltas) wTrue[j] = Math.max(T.LO[j], Math.min(T.HI[j], wTrue[j] + deltas[j]));

  const rng = T.mulberry32(2024);
  const rand = function (lo, hi) { return lo + (hi - lo) * rng(); };
  const samples = [];
  for (let i = 0; i < 1200; i++) {
    const c = new Float64Array(T.NW);
    for (let j = 0; j < T.NW; j++) c[j] = Math.round(rand(-3, 3)); // all params excited -> identifiable
    const base = rand(-150, 150);
    const s = { base: base, c: c, game: i, y: 0 };
    // Labels from the ROUNDED score at the true weights — the exact quantity the
    // fit scores (rounded, as the engine plays), so the global optimum is wTrue.
    s.y = T.sigmoid(Math.round(T.qVec(s, wTrue)), K);
    samples.push(s);
  }

  const baseMse = T.mse(samples, T.BASE_VEC, K, true);
  const cont = T.descend(samples, K, 0, { quiet: true, iters: 4000, lr: 0.2 });
  const rec = T.polish(samples, T.clampVec(Float64Array.from(cont, Math.round)), K, 0, true);
  const recMse = T.mse(samples, rec, K, true);

  let maxErr = 0;
  for (let j = 0; j < T.NW; j++) maxErr = Math.max(maxErr, Math.abs(rec[j] - wTrue[j]));
  check(recMse < baseMse * 0.05,
    'optimizer drives synthetic (rounded) MSE far below baseline (' + recMse.toExponential(2) + ' vs ' + baseMse.toExponential(2) + ')');
  check(maxErr <= 2,
    'optimizer recovers the known weights within ±2 on every parameter (max error ' + maxErr + ')');

  // Dedicated polish check: from a deliberately-perturbed integer start, polish
  // must LOWER the rounded objective (K=0.5, so predictions are not the constant
  // 0.5 that a K=0 objective would give — that would make polish a no-op).
  const perturbed = Float64Array.from(wTrue);
  perturbed[4] = Math.max(T.LO[4], perturbed[4] + 3);
  perturbed[7] = Math.min(T.HI[7], perturbed[7] + 4);
  const beforeObj = T.objective(samples, perturbed, K, 0, true);
  const polished = T.polish(samples, perturbed, K, 0, true);
  const afterObj = T.objective(samples, polished, K, 0, true);
  check(afterObj < beforeObj && afterObj < 1e-9,
    'polish lowers the rounded objective from a perturbed start toward the optimum (' +
    beforeObj.toExponential(2) + ' -> ' + afterObj.toExponential(2) + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
