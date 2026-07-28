/*
 * Browser probe worker — runs the JS engine and the Zig/WASM experiment
 * module through the same differential protocol as
 * experiments/wasm/bench.js, inside a real Web Worker (the production
 * execution context for both engines).
 *
 * The comparison signature matches the bench harness exactly: move, score,
 * completed/attempted depth, nodes, qnodes, cutoffs, re-searches, and stop
 * reason. (Root order is not part of the raw ABI, and the module embeds the
 * bench's fixed 0xC0FFEE shuffle seed internally.)
 *
 * Config message: { depth, parityDepth, reps, minMs, abortNodes, five,
 *                   wasmUrl, assetsBase }
 * Posts: { type: 'progress', phase, detail } and { type: 'final', report }.
 */
'use strict';

const SEED = 0xC0FFEE;

function mkRand(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILIES = [
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending (zugzwang)', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  ['tactical defence (chessy202607240238)', 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27']
];

function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) { return /\d/.test(c) ? c : swap(c); }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}

const POSITIONS = [];
for (const pair of FAMILIES) {
  POSITIONS.push([pair[0], pair[1]]);
  POSITIONS.push([pair[0] + ' (mirrored)', mirrorFen(pair[1])]);
}
const HARD_FIVE = [1, 2, 3, 8];

// Mirrors SIGNATURE_FIELDS in experiments/wasm/bench.js (moveStr <-> move).
const COMPARE_FIELDS = ['moveStr', 'score', 'depth', 'attemptedDepth', 'nodes',
  'qnodes', 'cutoffs', 'researches', 'stopReason'];

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
}

function jsHeap() {
  try {
    if (typeof performance !== 'undefined' && performance.memory) {
      return performance.memory.usedJSHeapSize;
    }
  } catch (e) { /* not available */ }
  return null;
}

let post = function (msg) { self.postMessage(msg); };

// Yield the worker event loop between positions. Every timed measurement is
// taken inside jsThink/wasmThink, so these idle gaps never enter a sample;
// they exist to give the JS engine GC/idle opportunities so a multi-minute
// synchronous burst cannot ratchet the renderer into a low-memory kill
// (observed with Chrome on a 2.5 GB Android emulator).
function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function jsThink(fen, opts) {
  Math.random = mkRand(SEED);
  const state = Chess.parseFen(fen);
  const t0 = performance.now();
  const r = ChessAI.think(state, opts);
  const ms = performance.now() - t0;
  return {
    ms: ms,
    moveStr: r.move
      ? Chess.sqName(r.move.from) + Chess.sqName(r.move.to) + (r.move.promotion || '')
      : '-',
    score: r.score,
    depth: r.depth,
    attemptedDepth: r.attemptedDepth,
    nodes: r.nodes,
    qnodes: r.qnodes,
    cutoffs: r.cutoffs,
    researches: r.researches,
    stopReason: r.stopReason
  };
}

function wasmThink(wasm, fen, opts) {
  const t0 = performance.now();
  const r = wasm.search(fen, opts);
  r.ms = performance.now() - t0;
  return r;
}

function compare(j, w) {
  return COMPARE_FIELDS.filter(function (f) { return j[f] !== w[f]; });
}

function batchRun(run, batch) {
  let total = 0;
  let first = null;
  for (let i = 0; i < batch; i++) {
    const r = run();
    if (!first) first = r;
    total += r.ms;
  }
  first.ms = total / batch;
  return first;
}

async function runProbe(config) {
  const report = {
    config: config,
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
    hardwareConcurrency: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null,
    startedAt: new Date().toISOString(),
    module: {},
    parity: null,
    abortParity: null,
    nps: null,
    fiveSecond: null,
    memory: {},
    failures: []
  };

  // Load engines.
  importScripts(config.assetsBase + '/assets/engine.js');
  importScripts(config.assetsBase + '/assets/ai.js');
  importScripts(config.assetsBase + '/experiments/wasm/probe/spike-abi.js');
  const resp = await fetch(config.wasmUrl);
  if (!resp.ok) throw new Error('wasm fetch failed: ' + resp.status);
  const bytes = await resp.arrayBuffer();
  report.module.bytes = bytes.byteLength;
  const tInst = performance.now();
  const wasm = await SpikeAbi.load(bytes);
  report.module.instantiationMs = performance.now() - tInst;
  report.module.linearMemoryBytes = wasm.memoryBytes();
  post({ type: 'progress', phase: 'loaded', detail: report.module });

  // 1. Exact parity, depths 1..parityDepth.
  let checked = 0, diverged = 0;
  const divergences = [];
  for (let d = 1; d <= config.parityDepth; d++) {
    for (const [name, fen] of POSITIONS) {
      const j = jsThink(fen, { maxDepth: d, quiesce: true });
      const w = wasmThink(wasm, fen, { maxDepth: d, quiesce: true });
      const diffs = compare(j, w);
      checked++;
      if (diffs.length) {
        diverged++;
        divergences.push({ depth: d, name: name, fields: diffs });
      }
      await tick();
    }
    post({ type: 'progress', phase: 'parity', detail: { depth: d, checked: checked, diverged: diverged } });
  }
  report.parity = { checked: checked, diverged: diverged, depths: config.parityDepth, divergences: divergences.slice(0, 20) };
  if (diverged) report.failures.push('parity');

  // 2. Fixed-node abort parity.
  let abortDiverged = 0;
  for (const [name, fen] of POSITIONS) {
    const j = jsThink(fen, { maxDepth: 30, quiesce: true, nodeLimit: config.abortNodes });
    const w = wasmThink(wasm, fen, { maxDepth: 30, quiesce: true, nodeLimit: config.abortNodes });
    if (compare(j, w).length) abortDiverged++;
    await tick();
  }
  report.abortParity = { nodeLimit: config.abortNodes, diverged: abortDiverged, positions: POSITIONS.length };
  if (abortDiverged) report.failures.push('abort-parity');
  report.memory.afterParityJsHeap = jsHeap();
  post({ type: 'progress', phase: 'abort-parity', detail: report.abortParity });

  // 3. Order-balanced paired NPS at config.depth.
  const perPosition = [];
  for (let pi = 0; pi < POSITIONS.length; pi++) {
    const name = POSITIONS[pi][0];
    const fen = POSITIONS[pi][1];
    const jsRun = function () { return jsThink(fen, { maxDepth: config.depth, quiesce: true }); };
    const wasmRun = function () { return wasmThink(wasm, fen, { maxDepth: config.depth, quiesce: true }); };
    const warmW = wasmRun();
    const warmJ = jsRun();
    const batch = Math.max(1, Math.ceil(
      config.minMs / Math.max(0.01, Math.min(warmW.ms, warmJ.ms))));
    const ratios = [];
    for (let rep = 0; rep < config.reps; rep++) {
      let w, j;
      if ((pi + rep) % 2 === 0) {
        w = batchRun(wasmRun, batch);
        j = batchRun(jsRun, batch);
      } else {
        j = batchRun(jsRun, batch);
        w = batchRun(wasmRun, batch);
      }
      ratios.push((w.nodes / w.ms) / (j.nodes / j.ms));
    }
    const ratio = Math.exp(median(ratios.map(Math.log)));
    perPosition.push({ name: name, ratio: ratio, batch: batch });
    post({ type: 'progress', phase: 'nps', detail: { position: name, ratio: ratio } });
    await tick();
  }
  const familyRatios = [];
  for (let i = 0; i < perPosition.length; i += 2) {
    familyRatios.push({
      name: FAMILIES[i / 2][0],
      ratio: Math.sqrt(perPosition[i].ratio * perPosition[i + 1].ratio)
    });
  }
  const geo = Math.exp(perPosition.reduce(function (s, p) {
    return s + Math.log(p.ratio);
  }, 0) / perPosition.length);
  const sortedFam = familyRatios.slice().sort(function (a, b) { return a.ratio - b.ratio; });
  report.nps = {
    geomean: geo,
    worstFamily: sortedFam[0],
    p10Family: sortedFam[Math.max(0, Math.ceil(0.1 * sortedFam.length) - 1)],
    slowerFamilies: sortedFam.filter(function (f) { return f.ratio < 1; }).length,
    families: familyRatios,
    perPosition: perPosition
  };
  report.memory.afterNpsJsHeap = jsHeap();

  // 4. Five-second diagnostics (order-balanced single pairs).
  if (config.five > 0) {
    const targets = HARD_FIVE.slice(0, config.five);
    const five = [];
    for (let i = 0; i < targets.length; i++) {
      const name = FAMILIES[targets[i]][0];
      const fen = FAMILIES[targets[i]][1];
      let w, j;
      if (i % 2 === 0) {
        w = wasmThink(wasm, fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
        j = jsThink(fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
      } else {
        j = jsThink(fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
        w = wasmThink(wasm, fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
      }
      five.push({
        name: name,
        wasm: { depth: w.depth, attemptedDepth: w.attemptedDepth, nodes: w.nodes, ms: w.ms },
        js: { depth: j.depth, attemptedDepth: j.attemptedDepth, nodes: j.nodes, ms: j.ms }
      });
      post({ type: 'progress', phase: 'five-second', detail: five[five.length - 1] });
      await tick();
    }
    report.fiveSecond = five;
  }

  report.memory.finalJsHeap = jsHeap();
  report.memory.wasmLinearBytes = wasm.memoryBytes();
  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  return report;
}

self.onmessage = function (e) {
  const config = e.data;
  runProbe(config).then(function (report) {
    post({ type: 'final', report: report });
  }).catch(function (err) {
    post({ type: 'final', report: { ok: false, failures: ['exception'], error: String(err && err.stack || err) } });
  });
};
