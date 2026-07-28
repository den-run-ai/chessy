/*
 * Node-host probe report — the browser probe's phases on the host, emitting
 * the same JSON schema the CI summary consumes. Engine loading, the raw-ABI
 * decoder, the position corpus, and the comparison signature are all reused
 * from experiments/wasm/bench.js (the canonical harness); this file adds no
 * engine or ABI logic of its own.
 *
 * Usage:
 *   node experiments/wasm/probe/host-report.js \
 *     [--wasm PATH] [--depth 5] [--reps 2] [--min-ms 100] [--five 4] \
 *     [--abort-nodes 5000] [--json out.json]
 * Exit: 0 when parity and abort screens pass, 1 otherwise.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const bench = require(path.join(__dirname, '..', 'bench.js'));

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const DEPTH = Number(opt('depth', 5));
const REPS = Number(opt('reps', 2));
const MIN_MS = Number(opt('min-ms', 100));
const FIVE = Number(opt('five', 4));
const ABORT_NODES = Number(opt('abort-nodes', 5000));
const WASM_PATH = opt('wasm', null);
const JSON_OUT = opt('json', null);
const HARD_FIVE = [1, 2, 3, 8];

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
}

function batchRun(engine, fen, opts, batch) {
  let total = 0;
  let first = null;
  for (let i = 0; i < batch; i++) {
    const r = engine.search(fen, opts);
    if (!first) first = r;
    total += r.ms;
  }
  first.ms = total / batch;
  return first;
}

async function main() {
  const wasm = await bench.loadWasmEngine(WASM_PATH);
  const js = bench.loadJsEngine();
  const POSITIONS = bench.POSITIONS;
  const report = {
    config: { target: 'node-host', depth: DEPTH, reps: REPS, minMs: MIN_MS, five: FIVE },
    node: process.version,
    startedAt: new Date().toISOString(),
    module: {
      bytes: wasm.binaryBytes,
      brotliBytes: wasm.brotliBytes,
      instantiationMs: wasm.initMs,
      linearMemoryBytes: wasm.initialMemoryBytes
    },
    parity: null,
    abortParity: null,
    nps: null,
    fiveSecond: null,
    failures: []
  };

  // 1. Exact parity, depths 1..DEPTH (bench signature comparison).
  let checked = 0, diverged = 0;
  const divergences = [];
  for (let d = 1; d <= DEPTH; d++) {
    for (const [name, fen] of POSITIONS) {
      const opts = { maxDepth: d, quiesce: true };
      const diffs = bench.signatureDifferences(
        wasm.search(fen, opts), js.search(fen, opts));
      checked++;
      if (diffs.length) {
        diverged++;
        divergences.push({ depth: d, name: name, fields: diffs });
      }
    }
  }
  report.parity = { checked: checked, diverged: diverged, depths: DEPTH, divergences: divergences.slice(0, 20) };
  console.log('exact-search parity: ' + (diverged ? 'FAIL ' + diverged + '/' + checked
    : 'PASS ' + checked + ' checks (depths 1..' + DEPTH + ')'));
  if (diverged) report.failures.push('parity');

  // 2. Fixed-node abort screen.
  let abortDiverged = 0;
  for (const [, fen] of POSITIONS) {
    const opts = { maxDepth: 30, quiesce: true, nodeLimit: ABORT_NODES };
    if (bench.signatureDifferences(wasm.search(fen, opts), js.search(fen, opts)).length) {
      abortDiverged++;
    }
  }
  report.abortParity = { nodeLimit: ABORT_NODES, diverged: abortDiverged, positions: POSITIONS.length };
  console.log('fixed-node (' + ABORT_NODES + ') abort parity: ' +
    (abortDiverged ? 'FAIL ' + abortDiverged : 'PASS ' + POSITIONS.length + '/' + POSITIONS.length));
  if (abortDiverged) report.failures.push('abort-parity');

  // 3. Order-balanced AB/BA paired NPS at DEPTH.
  const perPosition = [];
  for (let pi = 0; pi < POSITIONS.length; pi++) {
    const [name, fen] = POSITIONS[pi];
    const opts = { maxDepth: DEPTH, quiesce: true };
    const warmW = wasm.search(fen, opts);
    const warmJ = js.search(fen, opts);
    const batch = Math.max(1, Math.ceil(
      MIN_MS / Math.max(0.01, Math.min(warmW.ms, warmJ.ms))));
    const ratios = [];
    for (let rep = 0; rep < REPS; rep++) {
      let w, j;
      if ((pi + rep) % 2 === 0) {
        w = batchRun(wasm, fen, opts, batch);
        j = batchRun(js, fen, opts, batch);
      } else {
        j = batchRun(js, fen, opts, batch);
        w = batchRun(wasm, fen, opts, batch);
      }
      ratios.push((w.nodes / w.ms) / (j.nodes / j.ms));
    }
    perPosition.push({ name: name, ratio: Math.exp(median(ratios.map(Math.log))), batch: batch });
  }
  const familyRatios = [];
  for (let i = 0; i < perPosition.length; i += 2) {
    familyRatios.push({
      name: bench.FAMILIES[i / 2][0],
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
  console.log('paired NPS geomean ' + geo.toFixed(4) + ', worst family ' +
    sortedFam[0].ratio.toFixed(4) + ' (' + sortedFam[0].name + '), slower families ' +
    report.nps.slowerFamilies + '/9');

  // 4. Five-second diagnostics (order-balanced single pairs).
  if (FIVE > 0) {
    const five = [];
    const targets = HARD_FIVE.slice(0, FIVE);
    for (let i = 0; i < targets.length; i++) {
      const [name, fen] = bench.FAMILIES[targets[i]];
      const opts = { maxDepth: 30, quiesce: true, timeMs: 5000 };
      let w, j;
      if (i % 2 === 0) {
        w = wasm.search(fen, opts);
        j = js.search(fen, opts);
      } else {
        j = js.search(fen, opts);
        w = wasm.search(fen, opts);
      }
      five.push({
        name: name,
        wasm: { depth: w.depth, attemptedDepth: w.attemptedDepth, nodes: w.nodes, ms: w.ms },
        js: { depth: j.depth, attemptedDepth: j.attemptedDepth, nodes: j.nodes, ms: j.ms }
      });
      console.log('5s ' + name + ': wasm d' + w.depth + ' (' + w.nodes +
        ' n) vs js d' + j.depth + ' (' + j.nodes + ' n)');
    }
    report.fiveSecond = five;
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log('report written to ' + JSON_OUT);
  }
  console.log('RESULT: ' + (report.ok ? 'PASS' : 'FAIL'));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
