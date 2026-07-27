/*
 * Allocation / GC probe — the #84/#113 allocation evidence for search
 * optimizations, working tree vs a git ref.
 *
 * The driver re-execs itself per engine with --expose-gc (child mode), so
 * each engine is measured in a fresh V8 heap with a forced-GC baseline. The
 * base engine always runs first: any warm-host advantage then favors BASE,
 * keeping candidate deltas conservative. Three workloads:
 *
 *   fixed  two passes of seeded depth-5 searches over the 18 bench
 *          positions. For an exact-tree candidate this is IDENTICAL search
 *          work to the base, so GC-event deltas (minor GCs are scavenges,
 *          i.e. young-allocation churn) measure allocation directly.
 *   timed  one shipped-budget think (maxDepth 30, quiesce, 5000 ms) per
 *          canonical hard position x4. Work differs by throughput, so
 *          compare GC per searched node, not raw counts.
 *   soak   continuous shipped-budget thinks cycling the canonical positions
 *          for --seconds. Heap is sampled per think: reusable per-ply
 *          buffers and high-water pools must PLATEAU, not grow — a leaking
 *          pool shows up as a rising floor, and NPS drift across the soak
 *          approximates sustained-load stability. This is NOT a physical
 *          thermal test; device soak stays a #113 phase-1 hardware task.
 *
 * Memory metrics: the search is a single synchronous call, so JS heap can
 * only be sampled BETWEEN thinks — those samples are reported as
 * postThinkHeapMB, never as a peak. The genuine high-water covering the
 * search itself is peakRssMB (Linux VmHWM for the whole engine process;
 * null on other platforms). NPS uses the engine's `nodes` counter alone:
 * it already includes every quiescence node, qnodes being its quiescence
 * share.
 *
 * Usage:
 *   node test/ai-gc-probe.js --base origin/main --mode fixed
 *   node test/ai-gc-probe.js --base origin/main --mode timed
 *   node test/ai-gc-probe.js --base origin/main --mode soak --seconds 300
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}

const MK_RAND = 'function __mkRand(seed) {\n' +
  '  return function () {\n' +
  '    seed = (seed + 0x6D2B79F5) | 0;\n' +
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);\n' +
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
  '  };\n' +
  '}';

// Frozen copy of the test/ai-bench.js FAMILIES table (keep in sync).
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
// The four canonical hard positions used by the shipped-budget screens:
// Dragon, KID, Kiwipete, and the real-game tactical defence.
const CANONICAL = [POSITIONS[2], POSITIONS[4], POSITIONS[6], POSITIONS[16]];

// ---------------------------------------------------------------- child mode
if (args[0] === '--child') {
  const ref = args[1] === '__worktree__' ? null : args[1];
  const mode = args[2];
  const seconds = Number(args[3] || 0);
  if (typeof global.gc !== 'function') {
    console.error('child must run with --expose-gc');
    process.exit(2);
  }
  const { PerformanceObserver, constants } = require('perf_hooks');
  const v8 = require('v8');

  const read = function (file) {
    if (!ref) return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    return cp.execFileSync('git', ['show', ref + ':' + file],
      { encoding: 'utf8', maxBuffer: 1 << 24, cwd: path.join(__dirname, '..') });
  };
  const ctx = vm.createContext({ console: console });
  vm.runInContext(MK_RAND, ctx);
  vm.runInContext(read('assets/engine.js'), ctx, { filename: 'engine.js' });
  vm.runInContext(read('assets/ai.js'), ctx, { filename: 'ai.js' });

  const gcTally = { minor: 0, major: 0, incremental: 0, weakcb: 0, pauseMs: 0 };
  const observer = new PerformanceObserver(function (list) {
    for (const entry of list.getEntries()) {
      const kind = (entry.detail && entry.detail.kind) != null
        ? entry.detail.kind : entry.kind;
      if (kind === constants.NODE_PERFORMANCE_GC_MINOR) gcTally.minor++;
      else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcTally.major++;
      else if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) gcTally.incremental++;
      else gcTally.weakcb++;
      gcTally.pauseMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ['gc'] });

  function think(fen, opts, seed) {
    vm.runInContext('Math.random = __mkRand(' + (seed | 0) + ')', ctx);
    const state = ctx.Chess.parseFen(fen);
    const t0 = process.hrtime.bigint();
    const r = ctx.ChessAI.think(state, opts);
    return {
      wallMs: Number(process.hrtime.bigint() - t0) / 1e6,
      nodes: r.nodes, qnodes: r.qnodes || 0, depth: r.depth
    };
  }
  function snap() { return Object.assign({}, gcTally); }
  function delta(before, after) {
    return {
      minor: after.minor - before.minor,
      major: after.major - before.major,
      incremental: after.incremental - before.incremental,
      weakcb: after.weakcb - before.weakcb,
      pauseMs: +(after.pauseMs - before.pauseMs).toFixed(2)
    };
  }
  // True process high-water mark (Linux VmHWM, kB). heapUsed can only be
  // sampled BETWEEN synchronous thinks, after in-search allocation may
  // already have been collected — so post-think samples are reported under
  // an explicit postThinkHeapMB label, and VmHWM supplies the genuine peak
  // covering the search itself (V8 heap + JIT + buffers). Null off-Linux.
  function peakRssMB() {
    try {
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const m = status.match(/^VmHWM:\s*(\d+)\s*kB$/m);
      return m ? +(Number(m[1]) / 1024).toFixed(1) : null;
    } catch (e) {
      return null;
    }
  }
  // GC performance entries are delivered to the observer callback on later
  // event-loop turns. A fully synchronous workload would reach its snapshot
  // (and process exit) with every entry still undelivered and the tally at
  // zero, so every snap() below is preceded by a few timer turns.
  function settleGc() {
    let turns = Promise.resolve();
    for (let i = 0; i < 4; i++) {
      turns = turns.then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 5); });
      });
    }
    return turns;
  }

  (async function childMain() {
    const out = { ref: ref || 'worktree', mode: mode, node: process.version };
    global.gc();
    await settleGc();
    out.baselineHeapMB = +(process.memoryUsage().heapUsed / 1048576).toFixed(1);

    if (mode === 'fixed') {
      out.passes = [];
      for (let pass = 0; pass < 2; pass++) {
        await settleGc();
        const before = snap();
        let nodes = 0, qnodes = 0, wall = 0, peakHeap = 0;
        for (const [, fen] of POSITIONS) {
          const r = think(fen, { maxDepth: 5, quiesce: true }, 0xC0FFEE);
          nodes += r.nodes; qnodes += r.qnodes; wall += r.wallMs;
          const h = process.memoryUsage().heapUsed;
          if (h > peakHeap) peakHeap = h;
        }
        await settleGc();
        out.passes.push({
          pass: pass, wallMs: +wall.toFixed(1), nodes: nodes, qnodes: qnodes,
          gc: delta(before, snap()),
          postThinkHeapMB: +(peakHeap / 1048576).toFixed(1)
        });
      }
    } else if (mode === 'timed') {
      think(CANONICAL[0][1], { maxDepth: 30, timeMs: 1000, quiesce: true }, 0xC0FFEE);
      await settleGc();
      const before = snap();
      let nodes = 0, qnodes = 0, peakHeap = 0;
      out.thinks = [];
      for (const [name, fen] of CANONICAL) {
        const r = think(fen, { maxDepth: 30, timeMs: 5000, quiesce: true }, 0xC0FFEE);
        nodes += r.nodes; qnodes += r.qnodes;
        const h = process.memoryUsage().heapUsed;
        if (h > peakHeap) peakHeap = h;
        out.thinks.push({
          name: name, depth: r.depth, nodes: r.nodes,
          overshootMs: +(r.wallMs - 5000).toFixed(1)
        });
      }
      await settleGc();
      out.gc = delta(before, snap());
      out.nodes = nodes;
      out.qnodes = qnodes;
      out.postThinkHeapMB = +(peakHeap / 1048576).toFixed(1);
    } else if (mode === 'soak') {
      const startedAt = Date.now();
      const endAt = startedAt + seconds * 1000;
      await settleGc();
      const before = snap();
      out.samples = [];
      for (let i = 0; Date.now() < endAt; i++) {
        const [, fen] = CANONICAL[i % CANONICAL.length];
        const r = think(fen, { maxDepth: 30, timeMs: 5000, quiesce: true }, 0xC0FFEE + i);
        // `nodes` already counts every quiescence node (checkTime increments
        // it before qnodes) — qnodes is the quiescence SHARE of the total, so
        // adding the two would double-count and skew NPS by q-fraction.
        out.samples.push({
          t: +((Date.now() - startedAt) / 1000).toFixed(0),
          nps: Math.round((r.nodes / r.wallMs) * 1000),
          depth: r.depth,
          postThinkHeapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1)
        });
      }
      await settleGc();
      out.gc = delta(before, snap());
    } else {
      console.error('unknown --mode "' + mode + '"');
      process.exit(2);
    }

    global.gc();
    await settleGc();
    out.retainedHeapMB = +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
    out.totalHeapMB = +(v8.getHeapStatistics().total_heap_size / 1048576).toFixed(1);
    out.peakRssMB = peakRssMB();
    console.log(JSON.stringify(out));
    observer.disconnect();
    process.exit(0);
  })().catch(function (error) {
    console.error(error && error.stack || String(error));
    process.exit(1);
  });
  return;
}

// --------------------------------------------------------------- driver mode
const BASE = opt('base', null);
if (!BASE) {
  console.error('usage: node test/ai-gc-probe.js --base <git-ref> ' +
    '--mode fixed|timed|soak [--seconds N]');
  process.exit(2);
}
const MODE = opt('mode', 'fixed');
const SECONDS = opt('seconds', '300');

function runChild(refArg) {
  const stdout = cp.execFileSync(process.execPath,
    ['--expose-gc', __filename, '--child', refArg, MODE, SECONDS],
    { encoding: 'utf8', maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

const baseResult = runChild(BASE);
const candResult = runChild('__worktree__');
console.log(JSON.stringify({
  mode: MODE, node: process.version, base: baseResult, cand: candResult
}, null, 1));
