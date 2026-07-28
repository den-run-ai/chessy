/*
 * Regression test for the evaluation tuner v2 (test/ai-tune.js and its data
 * generator test/ai-tune-gen.js). Fast and deterministic, so it can run in PR
 * CI even though the tuner's full experiment does not — CI must exercise the
 * deliverable, not just the engine it tunes.
 *
 * Covers what the tuner's correctness rests on:
 *   1. feature fidelity — the reconstruction equals ai.js evaluate(), at the
 *      shipped weights AND under fully-distinct perturbed weights (tables
 *      included), with explicit mop-up fixtures;
 *   2. orientation — under asymmetric perturbed tables, a color-mirrored
 *      board evaluates to the exact negation (catches a1/a8 and color-swap
 *      wiring errors, the class #105 calls out for any evaluator work);
 *   3. the compiled sparse form agrees with the exact evaluation;
 *   4. the analytic gradient matches finite differences, and the loss is
 *      convex along random segments (the property the whole "convex tuning"
 *      design rests on);
 *   5. grouped splitting — disjoint by game, exact coverage, deterministic;
 *   6. optimizer recovery of known weights (aux AND table entries) on
 *      synthetic noiseless data;
 *   7. the data pipeline — board codec round-trip, quietness probe, per-game
 *      determinism, duplicate-position dedup.
 *
 * Run: node test/ai-tune.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./ai-tune.js');
const G = require('./ai-tune-gen.js');
const Chess = T.Chess;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

function randomState(rng, maxPlies) {
  let st = Chess.newGameState();
  const plies = 4 + Math.floor(rng() * maxPlies);
  for (let i = 0; i < plies; i++) {
    if (Chess.gameStatus(st).over) return null;
    const legal = Chess.legalMoves(st);
    st = Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
  }
  return st;
}

// ---- 1. feature fidelity ----
{
  const r = T.fidelityCheck(500, 0x1337);
  check(r.bad === 0 && r.checked > 100,
    'reconstruction equals ai.js evaluate() on all ' + r.checked + ' baseline positions (incl. mop-up fixtures)',
    r.bad + ' mismatches');
  const p = T.perturbedFidelityCheck(500, 0x2468);
  check(p.bad === 0 && p.checked > 100,
    'feature identity holds under fully-distinct perturbed weights on all ' + p.checked + ' positions',
    p.bad + ' mismatches');
  // Guard the guard: the perturbed evaluator must actually differ from the
  // shipped one, or the distinct-weights check is vacuous.
  const ctx = T.loadEngineWithWeights(p.w);
  const rng = T.mulberry32(7);
  const st = randomState(rng, 24);
  check(ctx.ChessAI.evaluate(st.board) !== T.ChessAI.evaluate(st.board),
    'perturbed evaluator actually differs from the shipped one (check is not vacuous)');
}

// ---- 2. orientation witness: exact negation under color-mirroring ----
// Flip ranks (i ^ 56) and swap colors; with per-entry-distinct tables any
// mirroring or color-swap slip in the feature extraction breaks the exact
// antisymmetry. Compared unrounded: the smooth values negate exactly in IEEE
// (Math.round itself is asymmetric at exact-half values, which is the
// engine's own knife-edge behavior, not an extraction property).
{
  const w = T.makePerturbedW(0xfeed);
  const rng = T.mulberry32(0xace);
  let checked = 0, bad = 0;
  for (let t = 0; t < 200; t++) {
    const st = randomState(rng, 50);
    if (!st) continue;
    const mirror = new Array(64).fill(null);
    for (let i = 0; i < 64; i++) {
      const p = st.board[i];
      if (p) mirror[i ^ 56] = (p[0] === 'w' ? 'b' : 'w') + p[1];
    }
    checked++;
    const a = T.evalFeat(T.features(st.board), w, false);
    const b = T.evalFeat(T.features(mirror), w, false);
    if (a !== -b) bad++;
  }
  check(checked > 100 && bad === 0,
    'color-mirrored boards evaluate to the exact negation under asymmetric tables (' + checked + ' positions)',
    bad + ' asymmetries');
}

// ---- 3. compiled sparse form agrees with the exact evaluation ----
{
  const w = T.makePerturbedW(0xbead);
  const v = T.wToVec(w);
  const rng = T.mulberry32(0xd00d);
  let checked = 0, worst = 0;
  for (let t = 0; t < 200; t++) {
    const st = randomState(rng, 50);
    if (!st) continue;
    checked++;
    const ft = T.features(st.board);
    const exact = T.evalFeat(ft, w, false);
    const viaVec = T.qVec(T.compile(ft), v);
    worst = Math.max(worst, Math.abs(exact - viaVec));
  }
  check(checked > 100 && worst < 1e-9,
    'compiled sparse q(w) equals the exact evaluation on ' + checked + ' positions (worst |Δ| ' + worst.toExponential(1) + ')');
}

// ---- 4. gradient correctness and convexity ----
{
  // Small synthetic sample set with sparse coefficients over BOTH aux and
  // table dimensions.
  const rng = T.mulberry32(0x600d);
  const samples = [];
  for (let i = 0; i < 300; i++) {
    const nnz = 8 + Math.floor(rng() * 12);
    const seen = new Set();
    const idx = [], val = [];
    for (let n = 0; n < nnz; n++) {
      const j = Math.floor(rng() * T.NW);
      if (seen.has(j)) continue;
      seen.add(j);
      idx.push(j); val.push(Math.round((rng() - 0.5) * 6));
    }
    samples.push({ base: (rng() - 0.5) * 300, idx: Int32Array.from(idx), val: Float64Array.from(val),
      y: rng(), game: i });
  }
  const K = 0.6, lambda = 0.1;
  const v = Float64Array.from(T.BASE_VEC);
  for (let j = 0; j < T.NW; j += 61) v[j] += ((j % 5) - 2); // move off baseline
  const g = T.gradient(samples, v, K, lambda);
  const h = 1e-4;
  let worstRel = 0;
  for (const j of [0, 4, 6, 9, T.NAUX + 3, T.NAUX + 100, T.PST_EG_BASE + 200, T.NW - 1]) {
    const vp = Float64Array.from(v), vm = Float64Array.from(v);
    vp[j] += h; vm[j] -= h;
    const fd = (T.objective(samples, vp, K, lambda, false) - T.objective(samples, vm, K, lambda, false)) / (2 * h);
    const rel = Math.abs(fd - g[j]) / Math.max(1e-12, Math.abs(fd) + Math.abs(g[j]));
    worstRel = Math.max(worstRel, rel);
  }
  check(worstRel < 1e-5, 'analytic gradient matches finite differences (worst rel err ' + worstRel.toExponential(1) + ')');

  // Convexity along random segments: CE(midpoint) <= mean of endpoint CEs.
  let convexOk = true;
  for (let t = 0; t < 20; t++) {
    const a = Float64Array.from(T.BASE_VEC), b = Float64Array.from(T.BASE_VEC);
    for (let j = 0; j < T.NW; j++) {
      a[j] += (rng() - 0.5) * 20;
      b[j] += (rng() - 0.5) * 20;
    }
    const mid = new Float64Array(T.NW);
    for (let j = 0; j < T.NW; j++) mid[j] = (a[j] + b[j]) / 2;
    const ca = T.ceLoss(samples, a, K, false), cb = T.ceLoss(samples, b, K, false), cm = T.ceLoss(samples, mid, K, false);
    if (cm > (ca + cb) / 2 + 1e-12) convexOk = false;
  }
  check(convexOk, 'log-loss is convex along random segments (midpoint never above the chord)');
}

// ---- 5. grouped splitting ----
{
  const samples = [];
  let uid = 0;
  for (let g = 0; g < 40; g++) {
    const n = 1 + (g % 7);
    for (let k = 0; k < n; k++) samples.push({ id: uid++, game: g, base: 0, idx: new Int32Array(0), val: new Float64Array(0), y: 0.5 });
  }
  const sp = T.groupedSplit(samples, 0.15, 0.15, 42);
  const gid = function (arr) { return new Set(arr.map(function (s) { return s.game; })); };
  const tr = gid(sp.train), va = gid(sp.val), te = gid(sp.test);
  const overlap = function (a, b) { return [...a].some(function (x) { return b.has(x); }); };
  check(!overlap(tr, va) && !overlap(tr, te) && !overlap(va, te),
    'train/val/test game sets are pairwise disjoint (no leakage)');
  const ids = sp.train.concat(sp.val, sp.test).map(function (s) { return s.id; }).sort(function (a, b) { return a - b; });
  let exact = ids.length === samples.length;
  for (let i = 0; i < ids.length; i++) if (ids[i] !== i) exact = false;
  check(exact, 'every sample placed exactly once, by identity (' + samples.length + ' unique ids)');
  const sp2 = T.groupedSplit(samples, 0.15, 0.15, 42);
  const sameMembership = function (a, b) {
    const A = new Set(a.map(function (s) { return s.id; }));
    return a.length === b.length && b.every(function (s) { return A.has(s.id); });
  };
  check(sameMembership(sp.train, sp2.train) && sameMembership(sp.val, sp2.val) && sameMembership(sp.test, sp2.test),
    'grouped split is deterministic under a fixed seed (identical membership)');
  const sp3 = T.groupedSplit(samples, 0.15, 0.15, 43);
  check(!sameMembership(sp.test, sp3.test),
    'a different seed produces a different partition (seed is actually used)');
}

// ---- 6. optimizer recovery on synthetic, noiseless data ----
// Known true weights moving BOTH aux and table entries; labels are the smooth
// sigmoid of the true rounded score, so the CE global minimum sits at the
// true weights. A tiny lambda keeps the objective strictly convex without
// biasing the optimum visibly.
{
  const K = 0.5;
  const wTrue = Float64Array.from(T.BASE_VEC);
  const movedDims = [0, 4, 6, 8, T.NAUX + 5, T.NAUX + 70, T.PST_EG_BASE + 33, T.PST_EG_BASE + 150];
  const deltas = [2, -6, 5, 10, -12, 9, -11, 14];
  movedDims.forEach(function (j, k) {
    wTrue[j] = Math.max(T.LO[j], Math.min(T.HI[j], wTrue[j] + deltas[k]));
  });

  const rng = T.mulberry32(2024);
  const samples = [];
  for (let i = 0; i < 1500; i++) {
    // Sparse coefficients concentrated on the moved dims (all excited), plus
    // background dims so the fit must also KEEP everything else at baseline.
    const idx = [], val = [];
    for (const j of movedDims) { idx.push(j); val.push(Math.round((rng() - 0.5) * 6)); }
    for (let n = 0; n < 8; n++) { idx.push(Math.floor(rng() * T.NW)); val.push(Math.round((rng() - 0.5) * 4)); }
    const uniq = new Map();
    idx.forEach(function (j, n) { uniq.set(j, (uniq.get(j) || 0) + val[n]); });
    const s = { base: (rng() - 0.5) * 200, idx: Int32Array.from([...uniq.keys()]),
      val: Float64Array.from([...uniq.values()]), y: 0, game: i };
    s.y = T.sigmoid(Math.round(T.qVec(s, wTrue)), K);
    samples.push(s);
  }

  // With soft targets the CE floor is the label entropy, not zero, so descent
  // progress is measured on the EXCESS loss over the true-weights optimum.
  // Requiring most of the excess to vanish BEFORE polish keeps the continuous
  // stage honestly covered (polish alone could also solve this fixture).
  const optObj = T.objective(samples, wTrue, K, 0.001, false);
  const startExcess = T.objective(samples, T.BASE_VEC, K, 0.001, false) - optObj;
  const cont = T.descend(samples, K, 0.001, { quiet: true, iters: 3000, lr: 0.25 });
  const contExcess = T.objective(samples, cont, K, 0.001, false) - optObj;
  check(startExcess > 0 && contExcess < startExcess * 0.25,
    'continuous descent removes most of the excess loss before polish (' +
    startExcess.toExponential(2) + ' -> ' + contExcess.toExponential(2) + ')');
  const rec = T.polish(samples, T.clampVec(Float64Array.from(cont, Math.round)), K, 0.001, { quiet: true, passes: 6 });
  let maxErr = 0;
  for (let j = 0; j < T.NW; j++) maxErr = Math.max(maxErr, Math.abs(rec[j] - wTrue[j]));
  check(maxErr <= 2,
    'optimizer recovers the known weights within ±2 on every parameter, aux and tables alike (max error ' + maxErr + ')');
}

// ---- 7. data pipeline ----
{
  // Board codec round-trip on a real position.
  const rng = T.mulberry32(99);
  const st = randomState(rng, 40);
  const enc = G.encodeBoard(st.board);
  const back = G.decodeBoard(enc);
  let same = true;
  for (let i = 0; i < 64; i++) if ((st.board[i] || null) !== (back[i] || null)) same = false;
  check(same && enc.length === 64, 'board codec round-trips a real position');

  // Quietness probe: capture, en passant, promotion, quiet move.
  const cap = Chess.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  const capMove = Chess.legalMoves(cap).find(function (m) { return m.from === 36 && m.to === 27; });
  check(capMove && G.isCapturePromotion(cap, capMove), 'capture detected as non-quiet');
  const ep = Chess.parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const epMove = Chess.legalMoves(ep).find(function (m) { return m.from === 28 && m.to === 19; });
  check(epMove && G.isCapturePromotion(ep, epMove), 'en passant detected as non-quiet');
  const promo = Chess.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const promoMove = Chess.legalMoves(promo).find(function (m) { return m.promotion === 'Q'; });
  check(promoMove && G.isCapturePromotion(promo, promoMove), 'promotion detected as non-quiet');
  const quiet = Chess.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  const quietMove = Chess.legalMoves(quiet).find(function (m) { return m.from === 36 && m.to === 28; });
  check(quietMove && !G.isCapturePromotion(quiet, quietMove), 'quiet pawn push detected as quiet');

  // Per-game determinism: the same (config, game id) yields identical samples.
  const cfg = { schema: G.SCHEMA, games: 1, nodes: 250, stride: 2, skipPlies: 2,
    maxPlies: 40, bookMin: 4, randExtra: 2, cpExclude: 2000, seed: 7 };
  const book = G.loadBook();
  const a = G.playOneGame(cfg, 3, book);
  const b = G.playOneGame(cfg, 3, book);
  check(JSON.stringify(a) === JSON.stringify(b), 'playOneGame is deterministic for a fixed (config, game id)');
  check(a && a.samples.every(function (s) { return s.b.length === 64 && Math.abs(s.cp) <= cfg.cpExclude; }),
    'sampled positions respect the codec and the cp-exclude filter (' + (a ? a.samples.length : 0) + ' samples)');

  // The opening book loads and is disjoint from the frozen match manifest
  // (training openings must never touch the formal-gate openings; the corpus
  // and the manifest are different files, this pins that they stay disjoint).
  const matchSrc = fs.readFileSync(path.join(__dirname, 'ai-match.js'), 'utf8');
  const manifest = new Set();
  const re = /\['(?:[^'\\]|\\.)+',\s*'((?:[^'\\]|\\.)+)'\]/g;
  let m;
  while ((m = re.exec(matchSrc)) !== null) manifest.add(m[1]);
  check(manifest.size === 100, 'frozen match manifest parsed (' + manifest.size + ' openings)');
  const bookLines = new Set(book.map(function (l) { return l.sans.join(' '); }));
  let overlaps = 0;
  for (const line of bookLines) if (manifest.has(line)) overlaps++;
  check(overlaps === 0, 'training opening book is disjoint from the frozen match manifest');

  // Dataset loader dedup: a duplicated (board, stm) sample is dropped.
  const tmp = path.join(os.tmpdir(), 'ai-tune-test-dedup-' + process.pid + '.json');
  const sample = { b: enc, stm: 'w', cp: 12, out: 1, game: 0, ply: 10 };
  fs.writeFileSync(tmp, JSON.stringify({
    config: cfg, games: 2, decisive: 1, whiteToMove: 2,
    samples: [sample, Object.assign({}, sample, { game: 1, out: 0 })]
  }));
  const loaded = T.loadDataset(tmp);
  fs.unlinkSync(tmp);
  check(loaded.samples.length === 1 && loaded.dups === 1,
    'duplicate (board, side-to-move) positions are dropped at load (kept ' + loaded.samples.length + ', dropped ' + loaded.dups + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
