/*
 * Difficulty-preset contract: stable storage IDs, explicit target bands,
 * monotonic work budgets, no depth-0 Easy case on the frozen position family,
 * and frozen pre-removal WASM signatures below the first shipped budget.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const bench = require('../experiments/wasm/bench.js');
const Presets = require('../assets/level-presets.js');

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

(async function () {
  const expected = [
    ['1', 'Easy', '1500', 10000],
    ['2', 'Medium', '1700', 36000],
    ['3', 'Hard', '1900', 230000],
    ['5', 'Expert', '2100', 1440000],
    ['master', 'Master', '2300+', null]
  ];
  check(JSON.stringify(Presets.ORDER) ===
      JSON.stringify(expected.map(function (row) { return row[0]; })),
    'legacy difficulty IDs and display order stay stable');
  check(expected.every(function (row) {
    const preset = Presets.get(row[0]);
    return preset && Object.isFrozen(preset) &&
      preset.label === row[1] && preset.target === row[2] &&
      preset.nodeLimit === row[3] && preset.maxDepth === 30 &&
      preset.timeMs === 5000 && preset.quiesce === true;
  }), 'all five target bands map to the declared immutable search presets');
  check(Presets.get('unknown') === null && Object.isFrozen(Presets.LEVELS),
    'unknown IDs fail closed and the preset table is immutable');

  const wasmPath = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
  const wasm = await bench.loadWasmEngine(wasmPath, 'shipped');
  const easy = Presets.get('1');
  const shallow = [];
  const nondeterministic = [];
  const frozenRegressions = [];
  for (const [name, fen] of bench.POSITIONS) {
    const opts = {
      maxDepth: easy.maxDepth,
      nodeLimit: easy.nodeLimit,
      timeMs: easy.timeMs,
      quiesce: easy.quiesce
    };
    const wasmResult = wasm.search(fen, opts);
    if (wasmResult.depth < 1 || !wasmResult.move) shallow.push(name);
    const repeatDiffs = bench.signatureDifferences(
      wasm.search(fen, opts), wasmResult);
    if (repeatDiffs.length) {
      nondeterministic.push(name + ': ' + repeatDiffs.join('; '));
    }

    // The first shipped level starts at 10k nodes. Preserve the reviewed r69
    // tree at a 5k checkpoint without retaining a second search
    // implementation solely as an oracle.
    const frozenOpts = {
      maxDepth: easy.maxDepth,
      nodeLimit: 5000,
      timeMs: 0,
      quiesce: easy.quiesce
    };
    const expectedFrozen = bench.frozenSignature(name, frozenOpts);
    const frozenDiffs = expectedFrozen
      ? bench.signatureDifferences(
        wasm.search(fen, frozenOpts), expectedFrozen)
      : ['missing frozen signature'];
    if (frozenDiffs.length) {
      frozenRegressions.push(name + ': ' + frozenDiffs.join('; '));
    }
  }
  check(shallow.length === 0,
    'Easy completes at least depth 1 across all frozen position families',
    shallow.join(', '));
  check(nondeterministic.length === 0,
    'Easy is deterministic across repeated WASM searches',
    nondeterministic.slice(0, 3).join(' | '));
  check(frozenRegressions.length === 0,
    'the 5k checkpoint matches frozen r69 signatures across all families',
    frozenRegressions.slice(0, 3).join(' | '));

  const expert = Presets.get('5');
  const expertShortfalls = [];
  for (const [name, fen] of bench.POSITIONS) {
    const result = wasm.search(fen, {
      maxDepth: expert.maxDepth,
      nodeLimit: expert.nodeLimit,
      timeMs: expert.timeMs,
      quiesce: expert.quiesce
    });
    if (!result.move || result.nodes !== expert.nodeLimit ||
        result.stopReason !== 'node-limit') {
      expertShortfalls.push(name + ': ' + result.stopReason +
        ' at ' + result.nodes + ' nodes');
    }
  }
  check(expertShortfalls.length === 0,
    'Expert reaches its full node target across the frozen WASM families',
    expertShortfalls.slice(0, 3).join(' | '));

  const kiwipete = bench.POSITIONS.find(function (row) {
    return row[0].toLowerCase().includes('kiwipete');
  }) || bench.POSITIONS[0];
  let previousNodes = 0;
  let monotonic = true;
  for (const id of Presets.ORDER.slice(0, 4)) {
    const preset = Presets.get(id);
    const result = wasm.search(kiwipete[1], {
      maxDepth: preset.maxDepth,
      nodeLimit: preset.nodeLimit,
      timeMs: preset.timeMs,
      quiesce: preset.quiesce
    });
    if (result.nodes <= previousNodes || result.nodes > preset.nodeLimit) {
      monotonic = false;
    }
    previousNodes = result.nodes;
  }
  check(monotonic, 'Easy through Expert perform strictly increasing bounded work');

  // Keep the binary read in this contract so a missing release asset fails
  // here even if the separate digest test is accidentally omitted.
  check(fs.statSync(wasmPath).size > 0, 'the default backend asset is present');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
