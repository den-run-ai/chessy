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

// ---- 2. grouped splitting ----
// Build synthetic samples tagged by game, split, and assert disjointness by game
// plus exact coverage (every sample placed once, none dropped or duplicated).
{
  const samples = [];
  for (let g = 0; g < 40; g++) {
    const n = 1 + (g % 7); // uneven group sizes
    for (let k = 0; k < n; k++) samples.push({ game: g, base: 0, c: new Float64Array(T.NW), y: 0.5 });
  }
  const sp = T.groupedSplit(samples, 0.15, 0.15, 42);
  const gid = function (arr) { return new Set(arr.map(function (s) { return s.game; })); };
  const tr = gid(sp.train), va = gid(sp.val), te = gid(sp.test);
  const overlap = function (a, b) { return [...a].some(function (x) { return b.has(x); }); };
  check(!overlap(tr, va) && !overlap(tr, te) && !overlap(va, te),
    'train/val/test game sets are pairwise disjoint (no leakage)');
  check(sp.train.length + sp.val.length + sp.test.length === samples.length,
    'every sample placed exactly once (' + samples.length + ' total)');
  check(tr.size + va.size + te.size === 40 && va.size > 0 && te.size > 0,
    'all 40 games partitioned, val and test non-empty (' + tr.size + '/' + va.size + '/' + te.size + ')');
  // Determinism: same seed -> same partition.
  const sp2 = T.groupedSplit(samples, 0.15, 0.15, 42);
  check(sp2.train.length === sp.train.length && sp2.test.length === sp.test.length,
    'grouped split is deterministic under a fixed seed');
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
    s.y = T.sigmoid(T.qVec(s, wTrue), K); // noiseless label from the true weights
    samples.push(s);
  }

  const baseMse = T.mse(samples, T.BASE_VEC, K);
  const cont = T.descend(samples, K, 0, { quiet: true, iters: 4000, lr: 0.2 });
  const rec = T.polish(samples, T.clampVec(Float64Array.from(cont, Math.round)), 0, 0, true);
  const recMse = T.mse(samples, rec, K);

  let maxErr = 0;
  for (let j = 0; j < T.NW; j++) maxErr = Math.max(maxErr, Math.abs(rec[j] - wTrue[j]));
  check(recMse < baseMse * 0.05,
    'optimizer drives synthetic MSE far below baseline (' + recMse.toExponential(2) + ' vs ' + baseMse.toExponential(2) + ')');
  check(maxErr <= 2,
    'optimizer recovers the known weights within ±2 on every parameter (max error ' + maxErr + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
