#!/usr/bin/env node
// Actual production-loader ABI contracts for the isolated candidate artifacts.
// This is correctness evidence, not a timing or strength experiment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2] || process.env.EVAL_PIPELINE_BUILD;
assert.ok(output, 'usage: node test/training/eval-pipeline-abi.test.mjs PREPARED_BUILD [RECEIPT.json]');
const directory = fs.realpathSync(output);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const preparedBytes = fs.readFileSync(path.join(directory, 'PREPARED.json'));
const prepared = JSON.parse(preparedBytes);
const built = JSON.parse(fs.readFileSync(path.join(directory, 'BUILT.json')));
assert.equal(built.preparedSha256, digest(preparedBytes));
const variants = ['baseline', 'baseline-memory', 'hce-scalar', 'hce-simd', 'sparse-scalar', 'sparse-simd'];
assert.deepEqual(prepared.variants, variants);
assert.deepEqual(Object.keys(built.modules).sort(), variants.slice().sort());

function retained(name) {
  const bytes = fs.readFileSync(path.join(directory, name));
  assert.equal(bytes.byteLength, prepared.files[name].bytes, name + ' byte length');
  assert.equal(digest(bytes), prepared.files[name].sha256, name + ' digest');
  return bytes;
}

// Execute the captured bytes that were hashed, never reread a mutable path.
vm.runInThisContext(retained('runtime/engine.js').toString(), { filename: 'retained-engine.js' });
const moduleShim = { exports: {} };
vm.compileFunction(retained('runtime/wasm-engine.js').toString(), ['module', 'exports'],
  { filename: 'retained-wasm-engine.js' })(moduleShim, moduleShim.exports);
const WasmEngine = moduleShim.exports;
const Chess = globalThis.Chess;
assert.equal(WasmEngine.ABI_VERSION, 2);
assert.equal(WasmEngine.RESULT_BYTES, 64);

const allRootsBytes = fs.readFileSync(path.join(root, 'eval/sparse-pesto-v2/COST-ROOTS.json'));
const allRoots = JSON.parse(allRootsBytes);
assert.equal(allRoots.length, 72);
const specials = [
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
  '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
  '4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
  '4k3/P7/8/8/8/8/7p/4K3 w - - 0 1',
  '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
];
const expectedImports = [{ module: 'env', name: 'now_ms', kind: 'function' }];
const engines = {};
let expectedExports;
let comparisons = 0;
for (const name of variants) {
  const declared = built.modules[name];
  const bytes = fs.readFileSync(path.join(directory, declared.path));
  assert.equal(digest(bytes), declared.sha256, name + ' module digest');
  assert.equal(bytes.length, declared.bytes, name + ' module bytes');
  if (name === 'baseline') assert.deepEqual(bytes, retained('control/shipped.wasm'));
  const compiled = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(compiled), expectedImports, name + ' imports');
  const exports = WebAssembly.Module.exports(compiled).map(x => [x.name, x.kind]).sort();
  if (!expectedExports) expectedExports = exports;
  assert.deepEqual(exports, expectedExports, name + ' exact production export set');
  assert.ok(exports.some(([key]) => key === 'search_seeded'));
  assert.ok(exports.some(([key]) => key === 'analysis_root'));
  assert.ok(!exports.some(([key]) => /load_model|cache|batch|variant/.test(key)));
  const instance = new WebAssembly.Instance(compiled, { env: { now_ms: () => 0 } });
  assert.equal(instance.exports.memory.buffer.byteLength, declared.memoryBytes, name + ' capacity');
  assert.throws(() => instance.exports.memory.grow(1), RangeError, name + ' immutable maximum');
  engines[name] = WasmEngine.loadSync(compiled);
  assert.equal(engines[name].memoryBytes(), declared.memoryBytes);
  if (name !== 'baseline') assert.equal(declared.memoryBytes, built.candidateMemoryBytes);
}

function sameMove(a, b) {
  return !!a && !!b && a.from === b.from && a.to === b.to && (a.promotion || null) === (b.promotion || null);
}
function legalMove(fen, move) {
  const state = Chess.parseFen(fen);
  return Chess.legalMoves(state).some(candidate => sameMove(candidate, move));
}
function compareGroups(results, label) {
  for (const name of ['baseline-memory', 'hce-scalar', 'hce-simd']) {
    assert.deepEqual(results[name], results.baseline, label + ' ' + name + ' HCE parity');
    comparisons++;
  }
  assert.deepEqual(results['sparse-simd'], results['sparse-scalar'], label + ' sparse SIMD parity');
  comparisons++;
}

for (const fen of [...allRoots.map(row => row.fen), ...specials]) {
  compareGroups(Object.fromEntries(variants.map(name => [name, engines[name].evaluate(fen)])), 'static ' + fen);
}

let searched = 0;
for (const fen of [...allRoots.filter((_, index) => index % 6 === 0).map(row => row.fen), ...specials]) {
  for (const seed of [0, 0xC0FFEE]) {
    const results = {};
    for (const name of variants) {
      const options = { maxDepth: 30, nodeLimit: 5000, timeMs: 0, quiesce: true, rootSeed: seed };
      results[name] = engines[name].search(fen, options);
      if (results[name].move) assert.ok(legalMove(fen, results[name].move), name + ' legal root');
      assert.deepEqual(engines[name].search(fen, options), results[name], name + ' repeat determinism');
      searched += 2;
    }
    compareGroups(results, 'seeded search ' + seed + ' ' + fen);
  }
}

const repetitionFen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 8 1';
const repeatedKey = Chess.positionKey(Chess.parseFen(repetitionFen));
for (const name of variants) {
  const result = engines[name].fixedSearch(repetitionFen, {
    depth: 2, nodeLimit: 10000, quiesce: true, positions: { [repeatedKey]: 3 }
  });
  assert.equal(result.score, 0, name + ' threefold score');
  // run_fixed resolves an already completed threefold before search_node.
  assert.equal(result.nodes, 0, name + ' terminal history avoids search');
  assert.equal(result.stopReason, 'game-over');
  assert.equal(result.complete, true);
  assert.ok(engines[name].fixedSearch(repetitionFen, {
    depth: 2, nodeLimit: 10000, quiesce: true
  }).nodes > 0, name + ' removing repetition restores search');
}

const exactFen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1';
const exactState = Chess.parseFen(exactFen);
const legal = Chess.legalMoves(exactState);
const exactResults = {};
for (const name of variants) {
  const engine = engines[name];
  engine.beginAnalysis(exactFen, { nodeLimit: 100000, quiesce: true });
  let previousNodes = 0;
  exactResults[name] = legal.map(move => {
    const result = engine.searchRoot(move, 2, 3);
    assert.equal(result.complete, true, name + ' full root verification');
    assert.ok(result.nodes > previousNodes, name + ' shared cumulative accounting');
    previousNodes = result.nodes;
    let cursor = exactState;
    for (const continuation of result.pv) {
      const resolved = Chess.legalMoves(cursor).find(candidate => sameMove(candidate, continuation));
      assert.ok(resolved, name + ' legal PV replay');
      cursor = Chess.applyMove(cursor, resolved);
    }
    return result;
  });
  engine.beginAnalysis(exactFen, { nodeLimit: 1, quiesce: true });
  const aborted = engine.searchRoot(legal[0], 4, 3);
  assert.equal(aborted.complete, false, name + ' bounded partial analysis');
  assert.deepEqual(aborted.pv, []);
  assert.throws(() => engine.beginAnalysis('invalid', {}));
  assert.throws(() => engine.searchRoot(legal[0], 2, 3), /phase is not ready/);
}
compareGroups(exactResults, 'exact-root shared-budget and PV');

// The production native fixture uses HCE's opening ties. The original full
// model has a different ranking; that golden is conditional on its identity.
// Every imported model must still select an independently verified best root
// and exercise deterministic seed variation on an actual equal-best witness.
function uci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase();
}
const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const tieFen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const originalFull = prepared.model.sha256 === '4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304';
const seedWitnesses = {};
for (const name of ['sparse-scalar', 'sparse-simd']) {
  const engine = engines[name];
  engine.beginAnalysis(startFen, { nodeLimit: 1000000, quiesce: false });
  const ranked = Chess.legalMoves(Chess.parseFen(startFen)).map(move => {
    const result = engine.searchRoot(move, 2, 3);
    assert.equal(result.complete, true);
    return { uci: uci(move), score: result.score };
  }).sort((a, b) => b.score - a.score);
  const startBestRoots = ranked.filter(row => row.score === ranked[0].score).map(row => row.uci).sort();
  if (originalFull) {
    assert.equal(ranked[0].uci, 'd2d4');
    assert.equal(ranked[0].score, 0);
    assert.equal(ranked[1].score, -5);
    assert.ok(ranked[0].score > ranked[1].score, name + ' original full model unique starting best');
  }
  engine.beginAnalysis(tieFen, { nodeLimit: 1000000, quiesce: false });
  const tieRanks = Chess.legalMoves(Chess.parseFen(tieFen)).map(move => {
    const result = engine.searchRoot(move, 2, 3);
    assert.equal(result.complete, true);
    return { uci: uci(move), score: result.score };
  });
  const best = Math.max(...tieRanks.map(row => row.score));
  const bestRoots = tieRanks.filter(row => row.score === best).map(row => row.uci).sort();
  assert.equal(best, 999999);
  assert.deepEqual(bestRoots, ['f7e8', 'f7f8', 'f7g7', 'f7h7']);
  const selected = new Set();
  for (let seed = 0; seed < 16; seed++) {
    const options = { maxDepth: 2, nodeLimit: 0, timeMs: 0, quiesce: false, rootSeed: seed };
    const start = engine.search(startFen, options);
    assert.ok(startBestRoots.includes(uci(start.move)), name + ' seed selects a verified initial best');
    assert.equal(start.score, ranked[0].score);
    const result = engine.search(tieFen, options);
    assert.ok(bestRoots.includes(uci(result.move)), name + ' seed selects a verified best tie');
    assert.equal(result.score, best);
    assert.deepEqual(engine.search(tieFen, options), result, name + ' seeded tie repeat determinism');
    selected.add(uci(result.move));
  }
  assert.ok(selected.size > 1, name + ' actual equal best moves vary across seeds');
  seedWitnesses[name] = { startingPositionDepth: 2, quiesce: false,
    originalFullGoldenChecked: originalFull, startBestRoots,
    startBestScore: ranked[0].score, secondRankedStartRoot: ranked[1], tieFen,
    verifiedBestRoots: bestRoots, bestScore: best, seedCount: 16,
    distinctSelectedBestRoots: [...selected].sort() };
}

const receipt = {
  schema: 'chessy.eval-pipeline-abi-check.v1', result: 'pass',
  researchOnly: true, abiVersion: 2, baseCommit: built.baseCommit,
  preparedSha256: digest(preparedBytes),
  costRootsSha256: digest(allRootsBytes),
  loaderSha256: prepared.files['runtime/wasm-engine.js'].sha256,
  rulesSha256: prepared.files['runtime/engine.js'].sha256,
  implementationSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  nodeVersion: process.version, v8Version: process.versions.v8,
  variants: built.modules, staticPositions: allRoots.length + specials.length,
  repeatedSearchExecutions: searched, exactRootsPerVariant: legal.length,
  exactGroupComparisons: comparisons,
  seedWitnesses,
  coverage: ['fixed memory and maximum', 'exact ABI/export/import set', 'original control bytes',
    'static HCE parity', 'sparse scalar/SIMD parity', 'seeded search and repeat determinism',
    'castling/en-passant/promotion/terminal positions', 'threefold prefix history',
    'exact-root shared-budget analysis', 'legal PV replay', 'abort and rejected-input invalidation',
    'verified initial best roots; original full golden only for its model identity',
    'verified equal-best-root seed variation'],
  strengthClaim: false, timingClaim: false
};
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
