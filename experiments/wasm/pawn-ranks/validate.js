'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { SOURCE, sha } = require('./prepare.js');
const FIELDS = ['move', 'score', 'depth', 'attemptedDepth', 'nodes', 'qnodes', 'cutoffs', 'researches', 'stopReason'];
const read = (directory, file) => fs.readFileSync(path.join(directory, file));
const json = value => JSON.stringify(value, null, 2) + '\n';
const plain = value => JSON.parse(JSON.stringify(value));

function snapshot(directory) {
  const registration = JSON.parse(read(directory, 'source-registration.json'));
  assert.deepEqual(registration.source, SOURCE);
  for (const mode of ['baseline', 'candidate']) {
    assert.deepEqual(fs.readdirSync(path.join(directory, mode, 'src')).sort(),
      Object.keys(SOURCE.files).filter(file => file.startsWith('src/')).map(file => file.slice(4)).sort());
    for (const [file, expected] of Object.entries(SOURCE.files)) {
      const digest = mode === 'candidate' && file === 'src/eval.rs' ? registration.candidateEvalSha256 : expected;
      assert.equal(sha(read(path.join(directory, mode), file)), digest, mode + ' source changed: ' + file);
    }
  }
  const modules = Object.fromEntries(['baseline', 'candidate'].map(mode =>
    [mode, read(directory, mode + '/dist/chessy-ai-fast.wasm')]));
  assert.equal(sha(modules.baseline), SOURCE.shippedWasmSha256, 'baseline did not reproduce shipped bytes');
  const scripts = Object.fromEntries(Object.entries(registration.harness).map(([file, digest]) => {
    const bytes = read(directory, file);
    assert.equal(sha(bytes), digest, 'retained harness changed');
    return [file, bytes];
  }));
  const oracle = read(directory, 'search-oracle.test.js'), signatures = read(directory, 'signatures.json');
  assert.equal(sha(oracle), registration.oracleSha256);
  assert.equal(sha(signatures), registration.signaturesSha256);
  assert.equal(sha(signatures), 'd500dece3ed9bfc83da5139cabf075734c1f1f465f295f9c8be7be23eccc6b6b');
  return { registration, modules, scripts, oracle, signatures };
}

function harness(scripts, logger = console) {
  const context = vm.createContext({ WebAssembly, TextEncoder, performance, console: logger, module: { exports: {} } });
  vm.runInContext(scripts['engine.js'].toString('utf8'), context, { filename: 'retained-engine.js' });
  vm.runInContext(scripts['wasm-engine.js'].toString('utf8'), context, { filename: 'retained-wasm-engine.js' });
  return { context, Chess: context.Chess, Wasm: context.module.exports };
}

function normalize(result, Chess) {
  return Object.fromEntries(FIELDS.map(field => [field, field === 'move'
    ? (result.move ? Chess.sqName(result.move.from) + Chess.sqName(result.move.to) + (result.move.promotion || '').toUpperCase() : '-')
    : result[field]]));
}

function oracleCheck(frozen, bytes, positions) {
  const output = [];
  const { context, Wasm } = harness(frozen.scripts, { log: (...args) => output.push(args.join(' ')) });
  context.__dirname = '/retained/test';
  context.require = name => {
    if (name === 'assert/strict') return assert;
    if (name === 'path') return path;
    if (name === 'fs') return { readFileSync(file) {
      assert.equal(file, '/retained/assets/chessy-ai-fast.wasm');
      return bytes;
    } };
    if (name === '../assets/engine.js') return {};
    if (name === '../assets/wasm-engine.js') return Wasm;
    if (name === '../experiments/wasm/bench.js') return { POSITIONS: positions.map(item => [item.name, item.fen]) };
    throw Error('unexpected retained oracle dependency: ' + name);
  };
  vm.runInContext(frozen.oracle.toString('utf8') + '\n;globalThis.oracleChecks = checks;', context,
    { filename: 'retained-search-oracle.test.js', timeout: 120000 });
  assert.equal(context.oracleChecks, 174);
  return { checks: context.oracleChecks, output };
}

function verify(frozen, protocol, report = {}) {
  const fixture = JSON.parse(frozen.signatures);
  assert.deepEqual(fixture.fields, FIELDS);
  assert.equal(fixture.cases.length, 144);
  assert.equal(protocol.positions.length, 18);
  const positions = new Map(protocol.positions.map(item => [item.name, item.fen]));
  const { Chess, Wasm } = harness(frozen.scripts);
  const engines = Object.fromEntries(Object.entries(frozen.modules).map(([mode, bytes]) => [mode, Wasm.loadSync(bytes)]));
  report.memoryBytes = {};
  for (const [mode, engine] of Object.entries(engines)) {
    report.memoryBytes[mode] = engine.memoryBytes();
    assert.equal(engine.memoryBytes(), 26542080);
  }
  report.signatures = [];
  const uci = move => move && Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toUpperCase();
  for (const [index, item] of fixture.cases.entries()) {
    const fen = positions.get(item.name);
    assert.ok(fen, 'unknown frozen position: ' + item.name);
    const row = { index, name: item.name, fen, config: item.config, engines: {} };
    report.signatures.push(row);
    for (const [mode, engine] of Object.entries(engines)) {
      const raw = engine.search(fen, item.config), result = normalize(raw, Chess);
      row.engines[mode] = { result, raw: plain(raw), rootAnalysis: null };
      assert.deepEqual(result, item.result, mode + ' frozen signature mismatch: ' + index);
      if (raw.move) {
        let replay = Chess.newGameState(fen);
        assert.ok(Chess.legalMoves(replay).some(move => uci(move) === uci(raw.move)));
        const depth = Math.max(1, Math.min(3, raw.depth));
        engine.beginAnalysis(fen, { nodeLimit: 5000, quiesce: item.config.quiesce });
        const root = engine.searchRoot(raw.move, depth, 16);
        for (const move of root.pv) {
          const found = Chess.legalMoves(replay).find(step => uci(step) === uci(move));
          assert.ok(found, mode + ' illegal exact-root PV: ' + index);
          replay = Chess.applyMove(replay, found);
        }
        row.engines[mode].rootAnalysis = { config: { totalDepth: depth, nodeLimit: 5000, pvLen: 16 }, raw: plain(root) };
      }
    }
    assert.deepEqual(row.engines.candidate, row.engines.baseline, 'complete signature/root mismatch: ' + index);
  }
  report.oracle = {};
  for (const [mode, bytes] of Object.entries(frozen.modules)) {
    report.oracle[mode] = oracleCheck(frozen, bytes, protocol.positions);
  }
  report.summary = { frozenCasesPerEngine: 144, pairedCompleteSignaturesAndRoots: 144, oracleChecksPerEngine: 174 };
  return report;
}

module.exports = { snapshot, harness, normalize, oracleCheck, verify, FIELDS, json, plain, sha };
if (require.main === module) {
  const directory = path.resolve(process.argv[2] || '');
  const report = { status: 'started' };
  try {
    verify(snapshot(directory), JSON.parse(read(__dirname, 'protocol.json')), report);
    report.status = 'complete';
    console.log(JSON.stringify(report.summary));
  } catch (error) { report.status = 'failed'; report.error = String(error.stack || error); throw error; }
  finally { fs.writeFileSync(path.join(directory, 'correctness.json'), json(report), { flag: 'wx' }); }
}
