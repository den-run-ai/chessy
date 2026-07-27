/*
 * Zig/WASM vs JS host checkpoint — parity first, then paired NPS.
 *
 * Reproduces the 2026-07-27 spike's host screen (issues #84/#113):
 *   1. exact-search parity at every depth 1..--depth over the 18 frozen
 *      ai-bench positions (move, score, completed/attempted depth, nodes,
 *      qnodes, cutoffs, re-searches, stop reason, root order);
 *   2. a fixed-node (--abort-nodes, default 5000) abort-replay screen over
 *      the same positions — the abort path must match field-for-field;
 *   3. order-balanced AB/BA paired NPS at --depth with full-depth warm-up
 *      and batching of short searches to >= --min-ms per sample
 *      (ai-bench.js methodology: median of per-rep log ratios, mirror pairs
 *      aggregated geometrically into families, worst/p10 family reported);
 *   4. a five-second Kiwipete diagnostic (--five-second adds the other
 *      three hard positions).
 *
 * Both engines run in this one Node process (the WASM side allocates
 * nothing on the JS heap during search; the JS engine's GC cost is its own
 * real production cost). The root shuffle is the bench-standard seeded
 * mulberry32(0xC0FFEE) on both sides, so the searches are reproducible.
 *
 * Usage:
 *   node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100
 *   node experiments/wasm/bench.js --parity-only
 *   node experiments/wasm/bench.js --json out.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const wasmLoader = require(path.join(__dirname, 'js', 'wasm-engine.js'));

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const DEPTH = Number(opt('depth', 5));
const REPS = Number(opt('reps', 2));
const MIN_TIMED_MS = Number(opt('min-ms', 100));
const ABORT_NODES = Number(opt('abort-nodes', 5000));
const JSON_OUT = opt('json', null);
const PARITY_ONLY = args.includes('--parity-only');
const SKIP_PARITY = args.includes('--skip-parity');
const FIVE_SECOND = args.includes('--five-second');
const SEED = 0xC0FFEE;

if (!Number.isInteger(DEPTH) || DEPTH < 1 || !Number.isInteger(REPS) ||
    REPS < 1 || (REPS > 1 && REPS % 2 !== 0)) {
  console.error('FAIL: --depth must be positive; --reps must be 1 or even');
  process.exit(1);
}

// The 9 mirrored families from test/ai-bench.js (kept in lockstep manually;
// the experiment must not import from test/ to stay standalone).
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
for (const [name, fen] of FAMILIES) {
  POSITIONS.push([name, fen]);
  POSITIONS.push([name + ' (mirrored)', mirrorFen(fen)]);
}

const HARD_FIVE_SECOND = [1, 2, 3, 8].map(function (i) { return FAMILIES[i]; });

const MK_RAND = 'function __mkRand(seed) {\n' +
  '  return function () {\n' +
  '    seed = (seed + 0x6D2B79F5) | 0;\n' +
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);\n' +
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
  '  };\n' +
  '}';

function loadJsEngine() {
  const ctx = vm.createContext({ console: console });
  vm.runInContext(MK_RAND, ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/engine.js'), 'utf8'),
    ctx, { filename: 'engine.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/ai.js'), 'utf8'),
    ctx, { filename: 'ai.js' });
  return ctx;
}

const COMPARE_FIELDS = ['moveStr', 'score', 'depth', 'attemptedDepth', 'nodes',
  'qnodes', 'cutoffs', 'researches', 'stopReason'];

function jsThink(ctx, fen, opts) {
  vm.runInContext('Math.random = __mkRand(' + SEED + ')', ctx);
  const state = ctx.Chess.parseFen(fen);
  const t0 = process.hrtime.bigint();
  const r = ctx.ChessAI.think(state, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    ms: ms,
    moveStr: r.move
      ? ctx.Chess.sqName(r.move.from) + ctx.Chess.sqName(r.move.to) + (r.move.promotion || '')
      : '-',
    score: r.score,
    depth: r.depth,
    attemptedDepth: r.attemptedDepth,
    nodes: r.nodes,
    qnodes: r.qnodes,
    cutoffs: r.cutoffs,
    researches: r.researches,
    stopReason: r.stopReason,
    rootOrderUci: r.rootOrderUci
  };
}

function wasmThink(wasm, fen, opts) {
  const t0 = process.hrtime.bigint();
  const r = wasm.search(fen, Object.assign({ seed: SEED }, opts));
  r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return r;
}

function compare(j, w) {
  const diffs = COMPARE_FIELDS.filter(function (f) { return j[f] !== w[f]; });
  if (JSON.stringify(j.rootOrderUci) !== JSON.stringify(w.rootOrderUci)) {
    diffs.push('rootOrderUci');
  }
  return diffs;
}

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
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

async function main() {
  const wasmPath = path.join(__dirname, 'chessy.wasm');
  const bytes = fs.readFileSync(wasmPath);
  const tInst0 = process.hrtime.bigint();
  const wasm = await wasmLoader.load(bytes);
  const instMs = Number(process.hrtime.bigint() - tInst0) / 1e6;
  const ctx = loadJsEngine();
  const report = {
    when: new Date().toISOString(),
    node: process.version,
    depth: DEPTH,
    reps: REPS,
    minTimedMs: MIN_TIMED_MS,
    module: {
      bytes: bytes.length,
      brotliBytes: zlib.brotliCompressSync(bytes).length,
      instantiationMs: instMs,
      linearMemoryBytes: wasm.memoryBytes()
    },
    parity: null,
    abortParity: null,
    nps: null,
    fiveSecond: null
  };
  console.log('module: ' + bytes.length + ' B raw / ' +
    report.module.brotliBytes + ' B brotli, instantiation ' +
    instMs.toFixed(2) + ' ms, linear memory ' +
    (report.module.linearMemoryBytes / 1048576).toFixed(2) + ' MiB');

  let failures = 0;

  if (!SKIP_PARITY) {
    // 1. Fixed-depth exact parity, depths 1..DEPTH.
    let checked = 0, diverged = 0;
    for (let d = 1; d <= DEPTH; d++) {
      for (const [name, fen] of POSITIONS) {
        const j = jsThink(ctx, fen, { maxDepth: d, quiesce: true });
        const w = wasmThink(wasm, fen, { maxDepth: d, quiesce: true });
        const diffs = compare(j, w);
        checked++;
        if (diffs.length) {
          diverged++;
          console.log('DIVERGE d' + d + ' ' + name + ': ' + diffs.map(function (f) {
            return f + ' js=' + j[f] + ' wasm=' + w[f];
          }).join(', '));
        }
      }
    }
    report.parity = { checked: checked, diverged: diverged, depths: DEPTH, positions: POSITIONS.length };
    console.log('exact-search parity: ' + (diverged ? 'FAIL ' + diverged + '/' + checked
      : 'PASS ' + POSITIONS.length + '/' + POSITIONS.length +
        ' positions x depths 1..' + DEPTH));
    if (diverged) failures++;

    // 2. Fixed-node abort screen.
    let abortDiverged = 0;
    for (const [name, fen] of POSITIONS) {
      const j = jsThink(ctx, fen, { maxDepth: 30, quiesce: true, nodeLimit: ABORT_NODES });
      const w = wasmThink(wasm, fen, { maxDepth: 30, quiesce: true, nodeLimit: ABORT_NODES });
      const diffs = compare(j, w);
      if (diffs.length) {
        abortDiverged++;
        console.log('DIVERGE abort ' + name + ': ' + diffs.map(function (f) {
          return f + ' js=' + j[f] + ' wasm=' + w[f];
        }).join(', '));
      }
    }
    report.abortParity = {
      nodeLimit: ABORT_NODES,
      diverged: abortDiverged,
      positions: POSITIONS.length
    };
    console.log('fixed-node (' + ABORT_NODES + ') abort parity: ' +
      (abortDiverged ? 'FAIL ' + abortDiverged : 'PASS ' + POSITIONS.length + '/' +
        POSITIONS.length));
    if (abortDiverged) failures++;
  }

  if (!PARITY_ONLY) {
    // 3. Order-balanced paired NPS at DEPTH.
    const perPosition = [];
    let sumJsMs = 0, sumWasmMs = 0;
    for (let pi = 0; pi < POSITIONS.length; pi++) {
      const [name, fen] = POSITIONS[pi];
      const jsRun = function () { return jsThink(ctx, fen, { maxDepth: DEPTH, quiesce: true }); };
      const wasmRun = function () { return wasmThink(wasm, fen, { maxDepth: DEPTH, quiesce: true }); };
      // full-depth warm-up, both sides
      const warmW = wasmRun();
      const warmJ = jsRun();
      const batch = Math.max(1, Math.ceil(
        MIN_TIMED_MS / Math.max(0.01, Math.min(warmW.ms, warmJ.ms))));
      const ratios = [];
      let jMed = [], wMed = [];
      for (let rep = 0; rep < REPS; rep++) {
        let w, j;
        if ((pi + rep) % 2 === 0) {
          w = batchRun(wasmRun, batch);
          j = batchRun(jsRun, batch);
        } else {
          j = batchRun(jsRun, batch);
          w = batchRun(wasmRun, batch);
        }
        ratios.push((w.nodes / w.ms) / (j.nodes / j.ms));
        jMed.push(j.ms);
        wMed.push(w.ms);
      }
      const logRatios = ratios.map(Math.log);
      const ratio = Math.exp(median(logRatios));
      sumJsMs += median(jMed);
      sumWasmMs += median(wMed);
      perPosition.push({ name: name, ratio: ratio, batch: batch });
      console.log(name.padEnd(46) + ' paired NPS ' + ratio.toFixed(4) +
        (batch > 1 ? '  x' + batch : ''));
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
    const worst = sortedFam[0];
    const p10 = sortedFam[Math.max(0, Math.ceil(0.1 * sortedFam.length) - 1)];
    const slower = sortedFam.filter(function (f) { return f.ratio < 1; }).length;
    report.nps = {
      geomean: geo,
      worstFamily: worst,
      p10Family: p10,
      slowerFamilies: slower,
      families: familyRatios,
      perPosition: perPosition,
      sumMedianMs: { js: sumJsMs, wasm: sumWasmMs }
    };
    console.log('\ngeometric mean paired NPS ratio (wasm/js): ' + geo.toFixed(4));
    console.log('worst-family paired NPS ratio: ' + worst.ratio.toFixed(4) + '  (' + worst.name + ')');
    console.log('p10 family paired NPS ratio:   ' + p10.ratio.toFixed(4) + '  (' + p10.name + ')');
    console.log('slower families: ' + slower + '/' + familyRatios.length);
    console.log('summed median depth-' + DEPTH + ' time: wasm ' + sumWasmMs.toFixed(1) +
      ' ms vs js ' + sumJsMs.toFixed(1) + ' ms');

    // 4. Five-second diagnostic (Kiwipete always; --five-second adds the rest).
    const fiveTargets = FIVE_SECOND ? HARD_FIVE_SECOND : [FAMILIES[3]];
    const five = [];
    for (const [name, fen] of fiveTargets) {
      const w = wasmThink(wasm, fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
      const j = jsThink(ctx, fen, { maxDepth: 30, quiesce: true, timeMs: 5000 });
      five.push({
        name: name,
        wasm: { depth: w.depth, attemptedDepth: w.attemptedDepth, nodes: w.nodes, ms: w.ms },
        js: { depth: j.depth, attemptedDepth: j.attemptedDepth, nodes: j.nodes, ms: j.ms }
      });
      console.log('5s ' + name + ': wasm d' + w.depth + ' (attempted d' +
        w.attemptedDepth + ', ' + w.nodes + ' n) vs js d' + j.depth +
        ' (attempted d' + j.attemptedDepth + ', ' + j.nodes + ' n)');
    }
    report.fiveSecond = five;
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log('report written to ' + JSON_OUT);
  }
  if (failures) {
    console.log('RESULT: FAIL (' + failures + ' parity gate(s) failed)');
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
  }
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
