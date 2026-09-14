#!/usr/bin/env node
'use strict';

// Static evaluation only. This program never calls a search entry point.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const W = require('../../assets/wasm-engine');
const B = require('../../test/training/hce-r3-baseline');
const L = require('../../test/training/hce-r3-linear');
const ROOT = path.resolve(__dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!/^--[a-z0-9-]+$/.test(argv[index]) || args[argv[index]] || !argv[index + 1]) throw new Error('invalid arguments');
    args[argv[index]] = argv[index + 1];
  }
  const required = ['contract', 'contract-sha256', 'selection', 'export-receipt', 'export-receipt-sha256',
    'baseline', 'candidate', 'fixtures', 'fixtures-sha256', 'output'];
  assert.equal(Object.keys(args).length, required.length);
  for (const name of required) assert.ok(args['--' + name], 'missing ' + name);
  const evidence = [];
  function read(filename, expected, bytesExpected) {
    filename = path.resolve(filename);
    const bytes = fs.readFileSync(filename);
    const hash = sha(bytes);
    if (expected) assert.equal(hash, expected, 'input SHA differs: ' + filename);
    if (bytesExpected != null) assert.equal(bytes.length, bytesExpected, 'input size differs: ' + filename);
    evidence.push({path: filename, sha256: hash, bytes: bytes.length});
    return bytes;
  }
  const json = (filename, expected) => JSON.parse(read(filename, expected));
  const contract = json(args['--contract'], args['--contract-sha256']);
  assert.equal(contract.schema, 'chessy.natural-runtime-private-contract.v1');
  assert.equal(contract.productionIntegrationAllowed, false);
  assert.equal(process.versions.node, contract.toolchain.node);
  assert.equal(process.versions.brotli, contract.toolchain.brotli);
  const selection = json(args['--selection'], contract.candidate.frozenSelectionSha256);
  assert.equal(sha(JSON.stringify(selection.researchWeights)), contract.candidate.weightsSha256);
  assert.deepEqual(selection.report.selected, {surface: contract.candidate.surface, lambda: contract.candidate.lambda,
    weightsSha256: contract.candidate.weightsSha256});
  const receipt = json(args['--export-receipt'], args['--export-receipt-sha256']);
  assert.equal(receipt.selectionSha256, contract.candidate.frozenSelectionSha256);
  assert.equal(receipt.weightsSha256, contract.candidate.weightsSha256);
  assert.equal(receipt.testReportSha256, contract.candidate.testReportSha256);
  read(path.join(ROOT, 'tools/training/natural-runtime-export.js'), receipt.exporterSha256);
  read(receipt.output, receipt.outputRustSha256);
  const baselineRust = read(path.join(ROOT, 'experiments/wasm/src/eval.rs'), receipt.baselineRustSha256);
  const center = B.baselineCenter(B.parseRustEvaluator(baselineRust.toString()));
  for (const relative of ['assets/wasm-engine.js', 'test/training/hce-r3-baseline.js', 'test/training/hce-r3-features.js',
    'test/training/hce-r3-linear.js', 'test/training/corpus.js']) {
    const filename = path.join(ROOT, relative);
    assert.ok(selection.inputSha256[filename], 'missing frozen oracle dependency: ' + relative);
    read(filename, selection.inputSha256[filename]);
  }
  const committed = read(path.join(ROOT, 'assets/chessy-ai-fast.wasm'), contract.baseline.wasmSha256);
  const modules = {};
  const engines = {committed: W.loadSync(committed)};
  for (const role of ['baseline', 'candidate']) {
    const bytes = read(args['--' + role]);
    engines[role] = W.loadSync(bytes);
    modules[role] = {path: path.resolve(args['--' + role]), sha256: sha(bytes), rawBytes: bytes.length,
      brotliBytes: zlib.brotliCompressSync(bytes, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11}}).length};
  }
  const summaryPath = path.resolve(selection.labelSummaryPath);
  const summary = json(summaryPath, selection.report.labelSummarySha256);
  assert.equal(summary.status, 'completed');
  const fixtures = json(args['--fixtures'], args['--fixtures-sha256']);
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0, 'authored fixtures required');
  const output = path.resolve(args['--output']);
  if (fs.existsSync(output) || fs.existsSync(output + '.rows.ndjson')) throw new Error('refusing to overwrite parity evidence');
  const fd = fs.openSync(output + '.rows.ndjson', 'wx');
  const counts = {naturalRows: 0, naturalMismatches: 0, authoredRows: 0, authoredMismatches: 0,
    baselineMismatches: 0, candidateMismatches: 0, byRole: {}};
  const seen = new Set();
  function compare(row, role) {
    assert.equal(typeof row.fen, 'string');
    assert.equal(typeof row.id, 'string');
    assert.ok(!seen.has(role + ':' + row.id), 'duplicate parity identity');
    seen.add(role + ':' + row.id);
    const compiled = L.compile(row.fen);
    const referenceBaseline = engines.committed.evaluate(row.fen);
    const baseline = engines.baseline.evaluate(row.fen);
    const affineBaseline = L.runtimeRoundedScore(compiled, center);
    const expectedCandidate = L.runtimeRoundedScore(compiled, selection.researchWeights);
    const candidate = engines.candidate.evaluate(row.fen);
    const baselineMismatch = baseline !== referenceBaseline || affineBaseline !== referenceBaseline;
    const candidateMismatch = candidate !== expectedCandidate;
    const mismatch = baselineMismatch || candidateMismatch;
    counts.baselineMismatches += Number(baselineMismatch);
    counts.candidateMismatches += Number(candidateMismatch);
    const prefix = role === 'authored' ? 'authored' : 'natural';
    counts[prefix + 'Rows']++;
    counts[prefix + 'Mismatches'] += Number(mismatch);
    counts.byRole[role] = (counts.byRole[role] || 0) + 1;
    fs.writeSync(fd, JSON.stringify({id: row.id, role, fen: row.fen, baseline, referenceBaseline,
      affineBaseline, candidate, expectedCandidate, mismatch}) + '\n');
  }
  try {
    for (const role of ['shared-train', 'hce-validation', 'hce-test']) {
      const matches = summary.output.files.filter(file => file.role === role);
      assert.equal(matches.length, 1);
      const entry = matches[0];
      const filename = path.resolve(path.dirname(summaryPath), entry.path);
      assert.equal(selection.inputSha256[filename], entry.sha256, 'role must be frozen in fit selection');
      const rows = read(filename, entry.sha256, entry.bytes).toString().trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.length, entry.rows);
      for (const row of rows) compare(row, role);
      process.stdout.write(role + ': ' + rows.length + ' static rows\n');
    }
    for (const row of fixtures) compare(row, 'authored');
  } finally { fs.closeSync(fd); }
  for (const entry of evidence) assert.equal(sha(fs.readFileSync(entry.path)), entry.sha256, 'input changed during parity');
  const rowBytes = fs.readFileSync(output + '.rows.ndjson');
  const gates = {
    baselineRebuildByteIdentical: modules.baseline.sha256 === contract.baseline.wasmSha256,
    parityRows: counts.naturalRows,
    parityMismatches: counts.naturalMismatches,
    authoredFixtureRows: counts.authoredRows,
    authoredFixtureMismatches: counts.authoredMismatches,
    sizePass: modules.candidate.rawBytes <= contract.privateSizeGate.maximumRawBytes &&
      modules.candidate.brotliBytes <= contract.privateSizeGate.maximumBrotliBytes
  };
  const pass = gates.baselineRebuildByteIdentical && gates.parityRows >= contract.parity.minimumNaturalRows &&
    gates.parityMismatches === 0 && gates.authoredFixtureMismatches === 0 && gates.sizePass;
  const report = {schema: 'chessy.natural-runtime-build-parity.v1', status: pass ? 'PASS' : 'FAIL', researchOnly: true,
    contractSha256: args['--contract-sha256'], frozenSelectionSha256: contract.candidate.frozenSelectionSha256,
    weightsSha256: contract.candidate.weightsSha256, testReportSha256: contract.candidate.testReportSha256,
    gates, modules, counts, evidence, implementation: {path: __filename, sha256: sha(fs.readFileSync(__filename))},
    rowEvidence: {path: output + '.rows.ndjson', sha256: sha(rowBytes), bytes: rowBytes.length},
    runtime: {node: process.versions.node, brotli: process.versions.brotli},
    calls: 'evaluate only; no search', productionIntegrationAllowed: false, shippingOrEloClaimAllowed: false};
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  process.stdout.write(JSON.stringify({status: report.status, gates, modules}, null, 2) + '\n');
  if (!pass) process.exitCode = 1;
}

module.exports = {main};
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
}
