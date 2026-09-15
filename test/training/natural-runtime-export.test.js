'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');
const B = require('./hce-r3-baseline');
const E = require('../../tools/training/natural-runtime-export');
const source = fs.readFileSync(path.resolve(__dirname, '../../experiments/wasm/src/eval.rs'), 'utf8');
const baseline = B.parseRustEvaluator(source);
const center = B.baselineCenter(baseline);

test('baseline inverse round-trips all 753 entries and preserves evaluation code', () => {
  const output = E.exportRust(source, center);
  assert.deepEqual(B.parseRustEvaluator(output), baseline);
  const after = text => text.slice(text.indexOf('    let tapered_phase ='));
  assert.equal(after(output), after(source)); // Includes exact rounding, fixed mop-up and old reference tests.
  assert.match(output, /const PAWN_ATTACK_MG: \[i32; 3\] = \[0, 0, 0\]/);
});

test('all inverse slots vary independently without touching omitted/fixed entries', () => {
  const weights = center.map((value, index) => {
    if (index < 17) return index % 2 ? Math.ceil(value * 0.75) : Math.floor(value * 1.25);
    if (index < 753) return value + (index % 21) - 10;
    return index < 759 ? index - 752 : 0;
  });
  const output = E.exportRust(source, weights);
  const result = B.parseRustEvaluator(output);
  assert.deepEqual(B.baselineCenter(result).slice(0, 753), weights.slice(0, 753));
  assert.match(output, /const PAWN_ATTACK_MG: \[i32; 3\] = \[1, 3, 5\]/);
  assert.match(output, /const PAWN_ATTACK_EG: \[i32; 3\] = \[2, 4, 6\]/);
  for (const key of ['VALUES_MG', 'VALUES_EG', 'PHASE', 'PHASE_MAX']) assert.deepEqual(result[key], baseline[key]);
  for (const stage of ['MG', 'EG']) {
    assert.deepEqual(result['PST_' + stage].P.slice(0, 8), baseline['PST_' + stage].P.slice(0, 8));
    assert.deepEqual(result['PST_' + stage].P.slice(56), baseline['PST_' + stage].P.slice(56));
    for (const rank of [0, 6]) assert.equal(result['PASSED_' + stage][rank], baseline['PASSED_' + stage][rank]);
  }
});

test('rejects fractions, unsupported features, relaxed bounds and duplicate integration', () => {
  for (const [index, value] of [[0, 4], [17, center[17] + 11], [753, 21], [758, -1], [759, 1], [400, 0.5]]) {
    const invalid = [...center]; invalid[index] = value;
    assert.throws(() => E.exportRust(source, invalid), /integer|bounds/);
  }
  assert.throws(() => E.exportRust(source, center.slice(1)), /965/);
  assert.throws(() => E.exportRust(E.exportRust(source, center), center), /already contains/);
  assert.throws(() => E.exportRust(source.replace('            let rank = square / 8;', '            let rank = square >> 3;'), center), /anchor/);
});

test('CLI authenticates passing evidence and refuses malformed evidence before writing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-export-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const filename = name => path.join(directory, name);
  const writeJson = (name, object) => {
    const bytes = JSON.stringify(object) + '\n'; fs.writeFileSync(filename(name), bytes); return E.sha256(bytes);
  };
  fs.writeFileSync(filename('baseline.rs'), source);
  fs.writeFileSync(filename('candidate.rs'), source);
  const selected = {surface: 'constrained753-plus-pawn-attacks', lambda: 0.2, weightsSha256: E.sha256(JSON.stringify(center))};
  const selection = {schema: 'chessy.natural-pilot-frozen-selection.v1',
    inputSha256: {'/synthetic/experiments/wasm/src/eval.rs': E.sha256(source)}, researchWeights: center,
    report: {selected}};
  const selectionSha = writeJson('selection.json', selection);
  const report = {schema: 'chessy.natural-pilot-fit-report.v1', status: 'test-completed-research-only',
    researchOnly: true, testOpened: true, scaleRecommended: true, shippingCandidateEmitted: false,
    eloOrTimeClaimAllowed: false, stopReasons: [], frozenSelectionSha256: selectionSha, selected};
  const run = reportSha => spawnSync(process.execPath, [path.resolve(__dirname, '../../tools/training/natural-runtime-export.js'),
    '--baseline', filename('baseline.rs'), '--baseline-sha256', E.sha256(source),
    '--selection', filename('selection.json'), '--selection-sha256', selectionSha,
    '--test-report', filename('report.json'), '--test-report-sha256', reportSha,
    '--output', filename('candidate.rs'), '--receipt', filename('receipt.json')], {encoding: 'utf8'});
  let result = run(writeJson('report.json', {...report, scaleRecommended: false}));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /passing/);
  assert.equal(fs.readFileSync(filename('candidate.rs'), 'utf8'), source);
  const goodSha = writeJson('report.json', report);
  result = run('0'.repeat(64)); assert.notEqual(result.status, 0); assert.match(result.stderr, /SHA-256 mismatch/);
  fs.unlinkSync(filename('candidate.rs')); fs.symlinkSync(filename('baseline.rs'), filename('candidate.rs'));
  result = run(goodSha); assert.notEqual(result.status, 0); assert.match(result.stderr, /symbolic link/);
  assert.equal(fs.readFileSync(filename('baseline.rs'), 'utf8'), source);
  fs.unlinkSync(filename('candidate.rs')); fs.linkSync(filename('baseline.rs'), filename('candidate.rs'));
  result = run(goodSha); assert.notEqual(result.status, 0); assert.match(result.stderr, /hard links/);
  assert.equal(fs.readFileSync(filename('baseline.rs'), 'utf8'), source);
  fs.unlinkSync(filename('candidate.rs')); fs.writeFileSync(filename('candidate.rs'), source);
  result = run(goodSha); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(filename('receipt.json')));
  assert.equal(receipt.outputRustSha256, E.sha256(fs.readFileSync(filename('candidate.rs'))));
  assert.equal(receipt.weightsSha256, selected.weightsSha256);
  assert.equal(receipt.productionIntegrationAllowed, false);
  result = run(goodSha); assert.notEqual(result.status, 0); assert.match(result.stderr, /receipt already exists/);
});
