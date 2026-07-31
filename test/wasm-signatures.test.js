/*
 * Search-regression gate after the JavaScript search implementation was
 * removed. The expected signatures were frozen from the shipped r69 WASM
 * artifact; this test compares move, score, completed/attempted depth, exact
 * counters and stop reason at fixed depth and fixed node budgets.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const bench = require('../experiments/wasm/bench.js');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wasm-r69-signatures.json'), 'utf8'));
const wasmPath = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
const positions = new Map(bench.POSITIONS);
let passed = 0, failed = 0;

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
  const engine = await bench.loadWasmEngine(wasmPath, 'shipped');
  for (const item of fixture.cases) {
    const result = engine.search(positions.get(item.name), item.config);
    const differences = fixture.fields.filter(function (field) {
      return result[field] !== item.result[field];
    }).map(function (field) {
      return field + '=' + result[field] + ' (expected ' + item.result[field] + ')';
    });
    check(differences.length === 0,
      item.name + ' · d' + item.config.maxDepth +
        ' · q=' + item.config.quiesce +
        (item.config.nodeLimit ? ' · n=' + item.config.nodeLimit : ''),
      differences.join(', '));
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (error) {
  console.error('FAIL: ' + (error && error.stack || error));
  process.exitCode = 1;
});
