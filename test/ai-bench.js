/*
 * AI search benchmark — measures nodes/time over 18 positions (9 families,
 * each also mirrored/color-swapped) and optionally compares the working
 * tree against a git ref loaded from that revision's shipped WASM assets.
 * Multi-repetition
 * timing uses separate persistent Node processes, so each engine has its own
 * WASM instance and linear memory.
 *
 * Beyond the geometric-mean node ratio it reports WORST-CASE and p90 node
 * ratios and the total re-search count. The geometric mean alone hid the
 * depth-6 tail-cost outlier on the game chessy202607240238 defence (nodes to
 * resolve that position roughly doubled across an eval change while the d5
 * geomean barely moved); the worst-case/p90 lines and the tracked 9th family
 * surface that class of regression. Re-run with `--depth 6` to see the
 * depth-transition cost the d5 default does not exercise.
 *
 * Usage:
 *   node test/ai-bench.js                  # candidate numbers only
 *   node test/ai-bench.js --base main      # candidate vs ref: node ratios
 *   node test/ai-bench.js --depth 6        # fixed search depth (default 5)
 *   node test/ai-bench.js --exact          # fail if the fixed search diverges
 *   node test/ai-bench.js --base main --reps 4  # isolated, paired median NPS
 *
 * The Rust engine uses deterministic embedded root ordering, so identical
 * fixed-depth searches are reproducible without a JavaScript PRNG shim.
 */
'use strict';
const path = require('path');
const cp = require('child_process');
const WasmHarness = require('./wasm-harness-engine');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = opt('base', null);
const DEPTH = Number(opt('depth', 5));
const REPS = Number(opt('reps', 1));
const EXACT = args.includes('--exact');
if (!Number.isInteger(DEPTH) || DEPTH < 1 ||
    !Number.isInteger(REPS) || REPS < 1 || REPS > 20 ||
    (REPS > 1 && REPS % 2 !== 0)) {
  console.error('FAIL: --depth must be positive; --reps must be 1 or an even integer from 2 to 20');
  process.exit(1);
}
const MIN_TIMED_MS = 250;
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;

// 8 base positions: opening, open middlegame, closed middlegame, tactical
// middlegame, rook ending, minor-piece ending, promotion race, pawn ending.
const FAMILIES = [
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending (zugzwang)', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  // Real-game tactical defence (game chessy202607240238, Black to move at move
  // 27) — the position whose depth-5→6 tail cost the geometric mean originally
  // hid. Appended (never inserted) so the existing 0–15 indices, and the
  // determinism self-check on POSITIONS[3], stay put. At --depth 6 Black must
  // find g6, not the mate-allowing Rxa2; the exact move gate lives in
  // test/ai-tactics.js — here it only feeds the worst-case/p90 tail metrics.
  ['tactical defence (chessy202607240238)', 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27']
];

// Mirror a FEN vertically and swap colors (a1<->a8, White<->Black).
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

function loadEngine(ref) {
  return WasmHarness.loadRevision(ref);
}

function bench(engine, fen, depth) {
  const t0 = process.hrtime.bigint();
  const r = engine.search(fen, { maxDepth: depth || DEPTH, quiesce: true });
  return {
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    cutoffs: r.cutoffs || 0,
    researches: r.researches || 0,
    depth: r.depth,
    score: r.score,
    move: WasmHarness.moveName(r.move)
  };
}

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples, label) {
  const first = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const other = samples[i];
    if (other.nodes !== first.nodes || other.qnodes !== first.qnodes ||
        other.cutoffs !== first.cutoffs || other.researches !== first.researches ||
        other.depth !== first.depth || other.score !== first.score ||
        other.move !== first.move) {
      throw new Error(label + ' search changed across identical timed repetitions');
    }
  }
  const times = samples.map(function (sample) { return sample.ms; });
  const med = median(times);
  return Object.assign({}, first, {
    ms: med,
    madMs: median(times.map(function (value) { return Math.abs(value - med); })),
    sampleMs: times
  });
}

function startTimingWorker(ref) {
  const child = cp.fork(path.join(__dirname, 'ai-bench-worker.js'),
    [ref || '__worktree__'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let nextId = 1;
  let terminalError = null;
  let closing = false;
  let exited = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise(function (resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });
  function fail(error) {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    readyReject(terminalError);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(terminalError);
    }
    pending.clear();
  }
  child.on('message', function (message) {
    if (message.type === 'startup-error') {
      fail(new Error(message.error));
      return;
    }
    if (message.type === 'ready') {
      readyResolve();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.on('error', fail);
  child.on('disconnect', function () {
    if (!closing) fail(new Error('timing worker IPC disconnected'));
  });
  child.on('exit', function (code, signal) {
    exited = true;
    if (!closing || pending.size) {
      fail(new Error('timing worker exited early (code ' + code +
        (signal ? ', signal ' + signal : '') + ')'));
    }
  });
  return {
    ready: ready,
    run: async function (fen, depth, batch) {
      await ready;
      if (terminalError) throw terminalError;
      return new Promise(function (resolve, reject) {
        const id = nextId++;
        const timer = setTimeout(function () {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.reject(new Error('timing worker request timed out'));
        }, WORKER_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          child.send({
            type: 'bench', id: id, fen: fen, depth: depth, batch: batch || 1
          }, function (error) {
            if (!error) return;
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            clearTimeout(request.timer);
            request.reject(error);
          });
        } catch (error) {
          const request = pending.get(id);
          pending.delete(id);
          clearTimeout(request.timer);
          reject(error);
        }
      });
    },
    close: function () {
      closing = true;
      return new Promise(function (resolve) {
        if (exited) { resolve(); return; }
        const fallback = setTimeout(function () {
          if (!exited) child.kill();
        }, 2000);
        child.once('exit', function () {
          clearTimeout(fallback);
          resolve();
        });
        if (child.connected) child.disconnect();
        else child.kill();
      });
    }
  };
}

async function orderedPair(candWorker, baseWorker, fen, candidateFirst, batch) {
  if (candidateFirst) {
    const c = await candWorker.run(fen, DEPTH, batch);
    return [c, await baseWorker.run(fen, DEPTH, batch)];
  }
  const b = await baseWorker.run(fen, DEPTH, batch);
  return [await candWorker.run(fen, DEPTH, batch), b];
}

// Warm both engines at the measured depth, then alternate their execution
// order by repetition and position so host drift does not systematically favor
// either side. Separate worker processes prevent cross-engine GC attribution.
async function benchPair(candCtx, baseCtx, fen, positionIndex, workers) {
  if (REPS === 1) {
    const c = bench(candCtx, fen), b = bench(baseCtx, fen);
    return {
      cand: c,
      base: b,
      speedRatio: (c.nodes / c.ms) / (b.nodes / b.ms),
      speedMad: 0
    };
  }
  const warm = await orderedPair(
    workers.cand, workers.base, fen, positionIndex % 2 === 0, 1);
  const batch = Math.max(1, Math.ceil(
    MIN_TIMED_MS / Math.min(warm[0].ms, warm[1].ms)));
  const candSamples = [], baseSamples = [];
  const speedSamples = [];
  for (let i = 0; i < REPS; i++) {
    const pair = await orderedPair(
      workers.cand, workers.base, fen, (positionIndex + i) % 2 === 0, batch);
    candSamples.push(pair[0]);
    baseSamples.push(pair[1]);
    speedSamples.push((pair[0].nodes / pair[0].ms) /
      (pair[1].nodes / pair[1].ms));
  }
  const logSpeeds = speedSamples.map(Math.log);
  const medianLog = median(logSpeeds);
  return {
    cand: summarize(candSamples, 'candidate'),
    base: summarize(baseSamples, 'base'),
    speedRatio: Math.exp(medianLog),
    speedMad: median(logSpeeds.map(function (value) {
      return Math.abs(value - medianLog);
    })),
    batch: batch
  };
}

async function benchCandidate(ctx, fen, worker) {
  if (REPS === 1) return bench(ctx, fen);
  const warm = await worker.run(fen, DEPTH);
  const batch = Math.max(1, Math.ceil(MIN_TIMED_MS / warm.ms));
  const samples = [];
  for (let i = 0; i < REPS; i++) {
    samples.push(await worker.run(fen, DEPTH, batch));
  }
  return summarize(samples, 'candidate');
}

async function main() {
  const cand = REPS === 1 ? await loadEngine(null) : null;
  const base = REPS === 1 && BASE ? await loadEngine(BASE) : null;

  // Multi-repetition summarization checks every authoritative search counter.
  // Retain the explicit self-check for the single-sample mode.
  if (REPS === 1) {
    const a = bench(cand, POSITIONS[3][1]);
    const b = bench(cand, POSITIONS[3][1]);
    if (a.nodes !== b.nodes || a.qnodes !== b.qnodes ||
        a.cutoffs !== b.cutoffs || a.researches !== b.researches ||
        a.depth !== b.depth || a.move !== b.move || a.score !== b.score) {
      throw new Error('candidate fixed-depth WASM search is not deterministic');
    }
  }

  const workers = REPS > 1 ? {
    cand: startTimingWorker(null),
    base: BASE ? startTimingWorker(BASE) : null
  } : null;
  let logRatioSum = 0, flagged = 0, mismatches = 0;
  let logSpeedRatioSum = 0;
  let totC = 0, totB = 0, msC = 0, msB = 0, rsC = 0, rsB = 0;
  const ratios = []; // { ratio, name } per position, for worst-case / p90
  const speedRatios = []; // candidate/base NPS per position, for worst-case / p10
  console.log('depth ' + DEPTH + (BASE ? ', base ' + BASE : ''));
  console.log(REPS > 1
    ? 'timing: separate WASM instances; full-depth warm-up; ' + REPS +
      ' paired AB/BA repetitions; median paired ratios; short samples batched to >= ' +
      MIN_TIMED_MS + ' ms'
    : 'timing: one sample per engine (use --reps 4 or more for a speed gate)');
  console.log('');
  try {
    if (workers) {
      await Promise.all([
        workers.cand.ready,
        workers.base ? workers.base.ready : Promise.resolve()
      ]);
    }
    for (let positionIndex = 0; positionIndex < POSITIONS.length; positionIndex++) {
      const [name, fen] = POSITIONS[positionIndex];
      const pair = BASE
        ? await benchPair(cand, base, fen, positionIndex, workers)
        : null;
      const c = pair ? pair.cand : await benchCandidate(
        cand, fen, workers && workers.cand);
      let line = name.padEnd(34) + ' cand ' + String(c.nodes).padStart(8) +
        ' n ' + String(c.researches).padStart(4) + ' rs  d' + c.depth + ' ' +
        String(c.score).padStart(6) + ' ' + c.move.padEnd(6) +
        ' ' + c.ms.toFixed(1).padStart(8) + ' ms';
      totC += c.nodes; msC += c.ms; rsC += c.researches;
      if (BASE) {
        const b = pair.base;
        totB += b.nodes; msB += b.ms; rsB += b.researches;
        const ratio = c.nodes / b.nodes;
        const speedRatio = pair.speedRatio;
        logRatioSum += Math.log(ratio);
        logSpeedRatioSum += Math.log(speedRatio);
        ratios.push({ ratio: ratio, name: name });
        speedRatios.push({ ratio: speedRatio, name: name });
        line += ' | base ' + String(b.nodes).padStart(8) + ' n ' +
          b.ms.toFixed(1).padStart(8) + ' ms  node ' + ratio.toFixed(3) +
          '  paired NPS ' + speedRatio.toFixed(3) +
          (pair.batch > 1 ? '  x' + pair.batch : '');
        if (ratio > 1.25) { line += '  <-- >1.25x'; flagged++; }
        if (c.move !== b.move || c.score !== b.score || c.depth !== b.depth ||
            c.nodes !== b.nodes || c.qnodes !== b.qnodes ||
            c.cutoffs !== b.cutoffs || c.researches !== b.researches) {
          line += '  [search diverges: base ' + b.move + ' ' + b.score +
            ' d' + b.depth + ', ' + b.nodes + ' n, ' + b.qnodes + ' qn, ' +
            b.cutoffs + ' co, ' + b.researches + ' rs]';
          mismatches++;
        }
      }
      console.log(line);
    }
  } finally {
    if (workers) {
      await Promise.all([
        workers.cand.close(),
        workers.base ? workers.base.close() : Promise.resolve()
      ]);
    }
  }

  console.log('\ncandidate: ' + totC + ' nodes, ' + msC.toFixed(1) +
    ' ms, ' + rsC + ' re-searches');
  if (BASE) {
    const geo = Math.exp(logRatioSum / POSITIONS.length);
    const speedGeo = Math.exp(logSpeedRatioSum / POSITIONS.length);
    // Worst-case and p90 node ratio: the geometric mean averages the tail away,
    // so a single position doubling in cost barely moves it. These order
    // statistics expose that outlier explicitly. p90 uses the nearest-rank rule
    // on the ascending ratios (ceil(0.9*n)-1).
    const sorted = ratios.slice().sort(function (a, b) { return a.ratio - b.ratio; });
    const worst = sorted[sorted.length - 1];
    const p90 = sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
    // Mirror/color-swapped orientations are correlated members of one family.
    // Aggregate each pair geometrically before the roadmap's family-tail gate.
    const familySpeedRatios = [];
    for (let i = 0; i < speedRatios.length; i += 2) {
      familySpeedRatios.push({
        name: FAMILIES[i / 2][0],
        ratio: Math.sqrt(speedRatios[i].ratio * speedRatios[i + 1].ratio)
      });
    }
    const speedSorted = familySpeedRatios.slice().sort(function (a, b) {
      return a.ratio - b.ratio;
    });
    const speedWorst = speedSorted[0];
    const speedP10 = speedSorted[Math.max(0, Math.ceil(0.1 * speedSorted.length) - 1)];
    console.log('base:      ' + totB + ' nodes, ' + msB.toFixed(1) +
      ' ms, ' + rsB + ' re-searches');
    console.log('geometric mean node ratio (cand/base): ' + geo.toFixed(4));
    console.log('worst-case node ratio: ' + worst.ratio.toFixed(4) + '  (' + worst.name + ')');
    console.log('p90 node ratio:        ' + p90.ratio.toFixed(4) + '  (' + p90.name + ')');
    console.log('geometric mean paired NPS ratio (cand/base): ' + speedGeo.toFixed(4));
    console.log('worst-family paired NPS ratio: ' + speedWorst.ratio.toFixed(4) +
      '  (' + speedWorst.name + ')');
    console.log('p10 family paired NPS ratio:  ' + speedP10.ratio.toFixed(4) +
      '  (' + speedP10.name + ')');
    console.log('re-search ratio (cand/base): ' + (rsB ? (rsC / rsB).toFixed(3) : 'n/a'));
    console.log('positions over 1.25x: ' + flagged + ', exact-search divergences: ' + mismatches);
    if (EXACT && mismatches > 0) {
      throw new Error('--exact requires identical move, score, depth, nodes, qnodes, cutoffs and re-searches');
    }
  }
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
