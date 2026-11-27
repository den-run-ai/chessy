#!/usr/bin/env node
'use strict';
if (typeof __seededHashValidation === 'undefined') {
  const fs = require('node:fs'), path = require('node:path');
  const captured = [__filename, ...['prepare.js', 'seeded-parity.rs.in', 'protocol.json'].map(p => path.join(__dirname, p))]
    .map(file => ({ file, bytes: Buffer.from(fs.readFileSync(file)) }));
  require('node:vm').compileFunction(captured[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__seededHashValidation'], { filename: __filename })
    (require, module, module.exports, __filename, __dirname, captured);
} else {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const { performance } = require('node:perf_hooks');
  const ROOT = path.resolve(__dirname, '../../..');
  const BASE = 'f27f05581c4be6bb35e230e1ffd01a62edf67541';
  const RUNTIME = {
    'assets/engine.js': '897bf4047c301b125bebff1d587c9407b9a8a5b5501ea38254ceff028c9ca8fa',
    'assets/wasm-engine.js': '39e52ff72c81c6c0340e0f593addfec3a23b1047baadc02a5888bbb0484e3b52',
    'assets/chessy-ai-fast.wasm': 'a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7',
    'test/fixtures/wasm-r69-signatures.json': 'd500dece3ed9bfc83da5139cabf075734c1f1f465f295f9c8be7be23eccc6b6b'
  };
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const json = value => JSON.stringify(value, null, 2) + '\n';
  const plain = value => JSON.parse(JSON.stringify(value));
  const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);
  const captured = __seededHashValidation;
  const get = name => captured.find(f => f.file.endsWith('/' + name));
  const protocol = JSON.parse(get('protocol.json').bytes);
  function pinnedRuntime() {
    return Object.fromEntries(Object.entries(RUNTIME).map(([p, digest]) => {
      const bytes = cp.execFileSync('git', ['--no-replace-objects', 'show', BASE + ':' + p], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(sha(bytes), digest, 'pinned runtime drift: ' + p);
      return [p, bytes];
    }));
  }
  function snapshot(directory) {
    directory = fs.realpathSync(directory);
    const helper = { exports: {} };
    vm.compileFunction(get('prepare.js').bytes.toString().replace(/^#![^\n]*/, ''),
      ['require', 'module', 'exports', '__filename', '__dirname', '__seededHashPrepare'], { filename: 'retained-r86-prepare.js' })
      (require, helper, helper.exports, get('prepare.js').file, __dirname, [get('prepare.js'), get('seeded-parity.rs.in')]);
    const expected = helper.exports.capture();
    assert.equal(expected.receipt.baseCommit, protocol.sourceBaselineCommit);
    assert.equal(protocol.baseCommit, BASE);
    assert.equal(sha(expected.generated['src/search.rs']), protocol.candidateSearchSha256);
    // The later r85 focus fix changed no engine inputs. Prove that relationship
    // and the published candidate source instead of relabeling the build's base.
    for (const [commit, inventory] of [[BASE, expected.source], [protocol.sourceCommit, expected.generated]]) {
      const tree = cp.execFileSync('git', ['--no-replace-objects', 'ls-tree', '-r', '--name-only', commit, '--', 'experiments/wasm/src/'], { cwd: ROOT })
        .toString().trim().split('\n').map(p => p.replace(/^experiments\/wasm\//, '')).sort();
      assert.deepEqual(tree, Object.keys(inventory).filter(p => p.startsWith('src/')).sort(), 'published source inventory');
      for (const [p, bytes] of Object.entries(inventory)) {
        const retained = cp.execFileSync('git', ['--no-replace-objects', 'show', commit + ':experiments/wasm/' + p], { cwd: ROOT });
        assert.equal(sha(retained), sha(bytes), 'published source differs: ' + commit + ':' + p);
      }
    }
    const sourceFile = path.join(directory, 'source.json'), sourceBytes = Buffer.from(fs.readFileSync(sourceFile));
    const source = JSON.parse(sourceBytes);
    same(source, expected.receipt, 'source receipt must describe the exact retained generator output');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'src')).sort(), ['engine.rs', 'eval.rs', 'lib.rs', 'search.rs']);
    const inputs = [{ file: sourceFile, bytes: sourceBytes }];
    for (const [p, bytes] of Object.entries(expected.generated)) {
      const file = path.join(directory, p), actual = Buffer.from(fs.readFileSync(file));
      assert.equal(sha(actual), sha(bytes), 'generated source differs from pinned recipe: ' + p);
      inputs.push({ file, bytes: actual });
    }
    const runtime = pinnedRuntime();
    const candidateFile = path.join(directory, 'dist/chessy-ai-fast.wasm');
    const modules = [runtime['assets/chessy-ai-fast.wasm'], Buffer.from(fs.readFileSync(candidateFile))];
    modules.forEach((bytes, i) => {
      assert.equal(sha(bytes), protocol.modules[i].sha256, 'module identity');
      assert.equal(bytes.length, protocol.modules[i].rawBytes, 'module byte count');
    });
    inputs.push({ file: candidateFile, bytes: modules[1] });
    const unchanged = () => [...captured, ...inputs].forEach(f => assert.equal(sha(fs.readFileSync(f.file)), sha(f.bytes), 'changed captured input: ' + f.file));
    return { directory, source, sourceBytes, runtime, modules, inputs, unchanged };
  }
  function validate(directory, output) {
    const frozen = snapshot(directory);
    const calls = [];
    // This untimed preflight observes the actual optional export invoked by the
    // unchanged pinned loader, rather than inferring seed forwarding from options.
    const tracedWasm = {
      Module: WebAssembly.Module, Memory: WebAssembly.Memory,
      Instance: function (module, imports) {
        const actual = new WebAssembly.Instance(module, imports);
        const exports = { ...actual.exports };
        for (const name of ['search', 'search_seeded']) {
          assert.equal(typeof exports[name], 'function');
          exports[name] = (...args) => { calls.push({ name, args }); return actual.exports[name](...args); };
        }
        return { exports };
      }
    };
    const context = { WebAssembly: tracedWasm, TextEncoder, performance, console, module: { exports: {} } };
    vm.createContext(context);
    vm.runInContext(frozen.runtime['assets/engine.js'].toString(), context, { filename: 'pinned-r85-engine.js' });
    vm.runInContext(frozen.runtime['assets/wasm-engine.js'].toString(), context, { filename: 'pinned-r85-wasm-engine.js' });
    const Chess = context.Chess, engines = frozen.modules.map(bytes => context.module.exports.loadSync(bytes));
    engines.forEach(e => assert.equal(e.memoryBytes(), 26542080));
    const uci = move => move ? Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '') : '-';
    const normalize = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'move' ? uci(v) : k === 'pv' ? v.map(uci) : v]));
    const legal = (fen, moves) => {
      let state = Chess.newGameState(fen);
      for (const move of moves) {
        const found = Chess.legalMoves(state).find(m => uci(m) === uci(move));
        assert.ok(found, 'illegal searched move or PV');
        state = Chess.applyMove(state, found);
      }
    };
    function search(engine, fen, options) {
      const before = calls.length, result = engines[engine].search(fen, options);
      assert.equal(calls.length, before + 1, 'exactly one ordinary/seeded WASM export call');
      const call = calls[before], seeded = options.rootSeed != null;
      assert.equal(call.name, seeded ? 'search_seeded' : 'search', 'rootSeed must select the optional seeded export');
      same(call.args.slice(0, 4), [options.maxDepth, options.nodeLimit || 0, options.timeMs || 0, options.quiesce ? 1 : 0], 'search limits changed in transport');
      if (seeded) assert.equal(call.args[4], options.rootSeed, 'root seed changed in transport');
      return { result, exportCall: plain(call) };
    }
    const fixture = JSON.parse(frozen.runtime['test/fixtures/wasm-r69-signatures.json']);
    assert.equal(fixture.cases.length, 144);
    const positions = new Map(protocol.positions.map(p => [p.name, p.fen])), rows = [];
    for (const item of fixture.cases) {
      const fen = positions.get(item.name); assert.ok(fen);
      const pair = engines.map((_, i) => search(i, fen, item.config).result);
      for (const result of pair) same(Object.fromEntries(fixture.fields.map(k => [k, k === 'move' ? uci(result.move) : result[k]])), item.result, 'immutable r69 signature');
      same(normalize(pair[0]), normalize(pair[1]), 'complete ordinary result');
      let roots = null;
      if (pair[0].move) {
        legal(fen, [pair[0].move]);
        roots = engines.map(e => {
          e.beginAnalysis(fen, { nodeLimit: 5000, quiesce: item.config.quiesce });
          const result = e.searchRoot(pair[0].move, Math.max(1, Math.min(3, pair[0].depth)), 16);
          legal(fen, result.pv); return normalize(result);
        });
        same(roots[0], roots[1], 'complete exact-root result and PV');
      }
      rows.push({ name: item.name, config: item.config, result: normalize(pair[1]), root: roots && roots[1] });
    }
    const historyRows = [];
    for (const count of [2, 3]) {
      const fen = '4k1n1/8/8/8/8/8/8/4K1N1 w - - 8 5';
      const options = { maxDepth: 5, nodeLimit: 10000, timeMs: 0, quiesce: true, positions: { [fen]: count } };
      const pair = engines.map((_, i) => normalize(search(i, fen, options).result));
      same(pair[0], pair[1], 'history-sensitive ordinary search');
      historyRows.push({ fen, count, result: pair[1] });
    }
    const seededRows = [], defaultSeedRows = [], seededHistoryRows = [];
    for (const [position, item] of protocol.seeded.positions.entries()) {
      for (const nodeLimit of protocol.seeded.fixed.nodeLimits) {
        for (const rootSeed of protocol.seeded.seeds) {
          const options = { ...protocol.seeded.fixed, nodeLimit, rootSeed };
          const pair = engines.map((_, i) => search(i, item.fen, options));
          same(normalize(pair[0].result), normalize(pair[1].result), 'complete seeded result');
          if (pair[0].result.move) legal(item.fen, [pair[0].result.move]);
          seededRows.push({ position, name: item.name, fen: item.fen, nodeLimit, rootSeed,
            results: pair.map(p => normalize(p.result)), exports: pair.map(p => p.exportCall) });
        }
        const options = { ...protocol.seeded.fixed, nodeLimit };
        const ordinary = engines.map((_, i) => normalize(search(i, item.fen, options).result));
        const historical = seededRows.find(r => r.position === position && r.nodeLimit === nodeLimit && r.rootSeed === 0x00C0FFEE);
        assert.ok(historical, 'explicit historical seed missing from protocol');
        same(ordinary, historical.results, 'explicit historical seed must preserve ordinary search');
        defaultSeedRows.push({ position, nodeLimit, ordinary, explicitHistoricalSeed: historical.results });
      }
    }
    for (const count of [2, 3]) for (const rootSeed of protocol.seeded.seeds) for (const nodeLimit of [64, 4096]) {
      const fen = '4k1n1/8/8/8/8/8/8/4K1N1 w - - 8 5';
      const options = { maxDepth: 6, nodeLimit, timeMs: 0, quiesce: true, rootSeed, positions: { [fen]: count } };
      const pair = engines.map((_, i) => search(i, fen, options));
      same(normalize(pair[0].result), normalize(pair[1].result), 'history-sensitive seeded search');
      seededHistoryRows.push({ count, rootSeed, nodeLimit, results: pair.map(p => normalize(p.result)), exports: pair.map(p => p.exportCall) });
    }
    assert.equal(seededRows.length, 16); assert.equal(defaultSeedRows.length, 4); assert.equal(seededHistoryRows.length, 16);
    const seedEffect = [];
    for (const [position] of protocol.seeded.positions.entries()) for (const nodeLimit of protocol.seeded.fixed.nodeLimits) {
      const sample = seededRows.filter(r => r.position === position && r.nodeLimit === nodeLimit);
      seedEffect.push({ position, nodeLimit, distinctFullResults: new Set(sample.map(r => JSON.stringify(r.results[0]))).size,
        distinctMoves: new Set(sample.map(r => r.results[0].move)).size });
    }
    assert.ok(seedEffect.some(row => row.distinctFullResults > 1), 'declared seeded schedule has no observed seed effect; no timings allowed');
    engines.forEach(e => assert.equal(e.memoryBytes(), 26542080)); frozen.unchanged();
    const report = {
      schema: 'chessy.compact-hash-r86.validation.v1', baseCommit: BASE, complete: true, exactFiniteParity: true,
      researchOnly: true, productionIntegrationAllowed: false, strengthClaimAllowed: false, universalEquivalenceProven: false,
      protocolSha256: sha(get('protocol.json').bytes), sourceReceiptSha256: sha(frozen.sourceBytes), sourceReceipt: frozen.source,
      implementation: captured.map(f => ({ path: path.relative(ROOT, f.file), sha256: sha(f.bytes) })),
      runtime: Object.entries(frozen.runtime).map(([p, b]) => ({ path: p, commit: BASE, sha256: sha(b) })),
      modules: protocol.modules.map(m => ({ ...m, memoryBytes: 26542080 })),
      signatureCases: rows.length, historyCases: historyRows.length, seededCases: seededRows.length,
      defaultSeedCases: defaultSeedRows.length, seededHistoryCases: seededHistoryRows.length,
      seedExportVerified: true, seedEffectObserved: true, seedEffect,
      rows, historyRows, seededRows, defaultSeedRows, seededHistoryRows
    };
    fs.writeFileSync(output, json(report), { flag: 'wx' }); return report;
  }
  module.exports = { snapshot, pinnedRuntime, validate, sha, protocol };
  if (require.main === module) {
    assert.equal(process.argv.length, 4, 'usage: node validate.js GENERATED_CRATE NEW_REPORT');
    const result = validate(...process.argv.slice(2));
    console.log(json({ complete: result.complete, signatureCases: result.signatureCases, seededCases: result.seededCases,
      seededHistoryCases: result.seededHistoryCases, seedEffect: result.seedEffect }));
  }
}
