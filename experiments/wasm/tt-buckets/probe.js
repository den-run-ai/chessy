'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');
const os = require('os');
const { performance } = require('perf_hooks');
const { prepare, SOURCE, sha } = require('./prepare.js');
const IMPLEMENTATION = ['probe.js', 'prepare.js', 'candidate.js', 'source.json', 'protocol.json', 'table.rs', 'tests.rs'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = (directory, file) => fs.readFileSync(path.join(directory, file));
const publish = (directory, file, value) => fs.writeFileSync(path.join(directory, file), json(value), { flag: 'wx' });

function snapshot(directory) {
  const registration = JSON.parse(read(directory, 'source-registration.json'));
  assert.deepEqual(registration.source, SOURCE);
  for (const mode of ['baseline', 'candidate']) {
    for (const [file, expected] of Object.entries(SOURCE.files)) {
      const digest = mode === 'candidate' && file === 'src/search.rs'
        ? registration.candidateSearchSha256 : expected;
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
  return { registration, modules, scripts };
}

function tools(rustRoot, binaryenRoot) {
  const binaries = { cargo: path.join(rustRoot, 'bin/cargo'), rustc: path.join(rustRoot, 'bin/rustc'),
    wasmOpt: path.join(binaryenRoot, 'bin/wasm-opt') };
  const versions = Object.fromEntries(Object.entries(binaries).map(([name, file]) =>
    [name, cp.execFileSync(file, name === 'rustc' ? ['--version', '--verbose'] : ['--version']).toString().trim()]));
  assert.match(versions.rustc, /release: 1\.97\.1\n/);
  assert.match(versions.rustc, /commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\n/);
  assert.match(versions.cargo, /^cargo 1\.97\.1 /);
  assert.match(versions.wasmOpt, /^wasm-opt version 131(?: \(version_131\))?$/);
  return { binaries, versions, sha256: Object.fromEntries(Object.entries(binaries).map(([name, file]) => [name, sha(fs.readFileSync(file))])) };
}

function build(directory, selectedTools) {
  for (const mode of ['baseline', 'candidate']) {
    for (let parent = path.join(directory, mode);; parent = path.dirname(parent)) {
      for (const file of ['.cargo/config', '.cargo/config.toml']) {
        assert.equal(fs.existsSync(path.join(parent, file)), false, 'ambient Cargo configuration: ' + parent);
      }
      if (parent === path.dirname(parent)) break;
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C',
      RUSTC: selectedTools.binaries.rustc, CARGO_HOME: path.join(directory, 'cargo-' + mode),
      CARGO_TARGET_DIR: path.join(directory, 'native-target-' + mode),
      CHESSY_CARGO_TARGET_DIR: path.join(directory, 'target-' + mode),
      CHESSY_CARGO_BIN: selectedTools.binaries.cargo, CHESSY_RUSTC_BIN: selectedTools.binaries.rustc,
      CHESSY_WASM_OPT_BIN: selectedTools.binaries.wasmOpt };
    const log = fs.openSync(path.join(directory, mode + '-build.log'), 'wx');
    try {
      const opts = { cwd: path.join(directory, mode), env, stdio: ['ignore', log, log], timeout: 180000 };
      cp.execFileSync(selectedTools.binaries.cargo, ['test', '--locked', '--offline'], opts);
      cp.execFileSync('sh', ['build.sh'], opts);
    } finally { fs.closeSync(log); }
  }
}

function harness(scripts) {
  const context = { WebAssembly, TextEncoder, performance, console, module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(scripts['engine.js'].toString('utf8'), context, { filename: 'retained-engine.js' });
  vm.runInContext(scripts['wasm-engine.js'].toString('utf8'), context, { filename: 'retained-wasm-engine.js' });
  return { Chess: context.Chess, Wasm: context.module.exports };
}

function mirror(fen) {
  const fields = fen.split(' '), swap = c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
  fields[0] = fields[0].split('/').reverse().map(row => row.replace(/[a-z]/gi, swap)).join('/');
  fields[1] = fields[1] === 'w' ? 'b' : 'w';
  if (fields[2] !== '-') fields[2] = fields[2].split('').map(swap).sort().join('');
  if (fields[3] !== '-') fields[3] = fields[3][0] + (9 - Number(fields[3][1]));
  return fields.join(' ');
}

function verify(engines, leaf, Chess, protocol, positions) {
  const uci = move => move && Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '');
  function oracle(state, depth, ply = 0, alpha = -2000000, beta = 2000000) {
    const moves = Chess.legalMoves(state);
    if (!moves.length) return Chess.inCheck(state, state.turn) ? (state.turn === 'w' ? -1 : 1) * (1000000 - ply) : 0;
    if (state.halfmove >= 100 || Chess.insufficientMaterial(state.board)) return 0;
    if (depth === 0) return leaf.evaluate(Chess.toFen(state));
    let best = state.turn === 'w' ? -2000000 : 2000000;
    for (const move of moves) {
      const score = oracle(Chess.applyMove(state, move), depth - 1, ply + 1, alpha, beta);
      if (state.turn === 'w') { best = Math.max(best, score); alpha = Math.max(alpha, best); }
      else { best = Math.min(best, score); beta = Math.min(beta, best); }
      if (alpha >= beta) break;
    }
    return best;
  }
  const specials = ['k7/8/8/8/8/8/R7/K7 b - - 100 1', 'k7/1Q6/2K5/8/8/8/8/8 b - - 100 1',
    '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', '4k3/8/8/r4pPK/8/8/8/8 w - f6 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1'];
  const fens = positions.map(x => x[1]).concat(specials);
  const result = { oracleComparisons: 0, fullWindowComparisons: 0, exactRoots: 0, budgetChecks: 0 };
  for (const fen of fens) for (const depth of protocol.oracleDepths) {
    const expected = oracle(Chess.parseFen(fen), depth);
    for (const [name, engine] of Object.entries(engines)) {
      const actual = engine.fixedSearch(fen, { depth, nodeLimit: 0, quiesce: false });
      assert.ok(actual.complete, name + ' incomplete oracle search');
      assert.equal(actual.score, expected, name + ' oracle mismatch: ' + fen + ' depth ' + depth);
      result.oracleComparisons++;
    }
  }
  for (const [name, fen] of positions) {
    const opts = { depth: protocol.completedComparisonDepth, nodeLimit: protocol.completedComparisonNodeLimit, quiesce: true };
    const baseline = engines.baseline.fixedSearch(fen, opts), candidate = engines.candidate.fixedSearch(fen, opts);
    assert.ok(baseline.complete && candidate.complete, 'comparison exceeded predeclared work cap: ' + name);
    assert.equal(candidate.score, baseline.score, 'completed full-window score mismatch: ' + name);
    result.fullWindowComparisons++;
  }
  for (const fen of [protocol.families[3][1], ...specials.slice(3)]) {
    const root = Chess.parseFen(fen), legal = Chess.legalMoves(root);
    for (const engine of Object.values(engines)) engine.beginAnalysis(fen, { nodeLimit: 0, quiesce: false });
    for (const move of legal) {
      const expected = oracle(Chess.applyMove(root, move), 2, 1);
      for (const [name, engine] of Object.entries(engines)) {
        const actual = engine.searchRoot(move, 3, 3);
        assert.ok(actual.complete);
        assert.equal(actual.score, expected, name + ' forced-root mismatch ' + uci(move));
        assert.equal(uci(actual.pv[0]), uci(move));
        let replay = root;
        for (const step of actual.pv) {
          const found = Chess.legalMoves(replay).find(m => uci(m) === uci(step));
          assert.ok(found, name + ' illegal PV');
          replay = Chess.applyMove(replay, found);
        }
        result.exactRoots++;
      }
    }
  }
  for (const engine of Object.values(engines)) for (const quiesce of [false, true]) {
    const opts = { depth: 2, nodeLimit: 0, quiesce }, full = engine.fixedSearch(Chess.START_FEN, opts);
    assert.ok(full.complete && full.nodes > 1);
    const exact = engine.fixedSearch(Chess.START_FEN, { ...opts, nodeLimit: full.nodes });
    assert.deepEqual(exact, full);
    const short = engine.fixedSearch(Chess.START_FEN, { ...opts, nodeLimit: full.nodes - 1 });
    assert.equal(short.complete, false); assert.equal(short.nodes, full.nodes - 1);
    result.budgetChecks++;
  }
  return result;
}

function measure(directory, selectedTools) {
  const frozen = snapshot(directory), implementation = Object.fromEntries(IMPLEMENTATION.map(file => [file, read(__dirname, file)]));
  const protocol = JSON.parse(implementation['protocol.json']);
  const registration = { source: frozen.registration, protocol,
    implementationSha256: Object.fromEntries(Object.entries(implementation).map(([file, bytes]) => [file, sha(bytes)])),
    tools: selectedTools, modules: Object.fromEntries(Object.entries(frozen.modules).map(([name, bytes]) => [name, sha(bytes)])),
    host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().map(x => x.model) } };
  publish(directory, 'measurement-registration.json', registration); // Must precede correctness and timing; cannot rerun.
  const report = { registrationSha256: sha(Buffer.from(json(registration))), status: 'started', fixedNodes: [], pressure: [] };
  try {
    const { Chess, Wasm } = harness(frozen.scripts);
    const engines = Object.fromEntries(Object.entries(frozen.modules).map(([name, bytes]) => [name, Wasm.loadSync(bytes)]));
    for (const engine of Object.values(engines)) assert.equal(engine.memoryBytes(), 26542080);
    const positions = protocol.families.flatMap(([name, fen]) => [[name, fen], [name + ' mirrored', mirror(fen)]]);
    report.correctness = verify(engines, Wasm.loadSync(frozen.modules.baseline), Chess, protocol, positions);
    console.log('Correctness passed:', JSON.stringify(report.correctness));
    for (const [, fen] of positions) for (const engine of Object.values(engines)) {
      engine.search(fen, { maxDepth: protocol.maxDepth, nodeLimit: protocol.warmupNodeLimit, timeMs: 0, quiesce: true });
    }
    for (let repeat = 0; repeat < protocol.fixedNodeRepetitions; repeat++) {
      for (let index = 0; index < positions.length; index++) {
        const [position, fen] = positions[index];
        const order = (repeat + index) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        for (const name of order) {
          const started = performance.now();
          const result = engines[name].search(fen, { maxDepth: protocol.maxDepth, nodeLimit: protocol.fixedNodeLimit, timeMs: 0, quiesce: true });
          report.fixedNodes.push({ position, repeat, engine: name, elapsedMs: performance.now() - started, result });
        }
      }
      console.log('Completed fixed-node repetition', repeat + 1);
    }
    for (const [index, familyIndex] of protocol.pressureFamilyIndices.entries()) {
      const [position, fen] = protocol.families[familyIndex];
      for (const name of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const started = performance.now();
        const result = engines[name].search(fen, { maxDepth: protocol.maxDepth, nodeLimit: 0, timeMs: protocol.pressureTimeMs, quiesce: true });
        report.pressure.push({ position, engine: name, elapsedMs: performance.now() - started, result });
        console.log('Completed pressure search:', position, name, result.depth, result.nodes, result.ttSaturated || false);
      }
    }
    const ratios = report.fixedNodes.filter(x => x.engine === 'baseline').map(base => {
      const candidate = report.fixedNodes.find(x => x.position === base.position && x.repeat === base.repeat && x.engine === 'candidate');
      return base.elapsedMs / candidate.elapsedMs;
    });
    report.fixedNodeElapsedRatioGeomean = Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length);
    report.moduleBytes = Object.fromEntries(Object.entries(frozen.modules).map(([name, bytes]) => [name, bytes.length]));
    for (const [file, bytes] of Object.entries(implementation)) assert.equal(sha(read(__dirname, file)), sha(bytes), 'implementation changed during run');
    for (const [name, file] of Object.entries(selectedTools.binaries)) assert.equal(sha(fs.readFileSync(file)), selectedTools.sha256[name], 'tool changed during run');
    snapshot(directory);
    report.status = 'complete';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error);
    throw error;
  } finally { publish(directory, 'report.json', report); }
  return report;
}

module.exports = { snapshot, tools, build, mirror, verify, measure };
if (require.main === module) {
  const [, , command, directory, rustRoot, binaryenRoot] = process.argv;
  if (!['run', 'measure'].includes(command) || !directory || !rustRoot || !binaryenRoot) {
    throw Error('usage: probe.js run|measure ABS_OUTPUT ABS_RUST_INSTALL ABS_BINARYEN_INSTALL');
  }
  const selectedTools = tools(path.resolve(rustRoot), path.resolve(binaryenRoot));
  const output = path.resolve(directory);
  if (process.argv[6] === '--retained-snapshot') {
    assert.equal(__dirname, path.join(output, 'implementation'), 'execute the retained snapshot');
    const result = measure(output, selectedTools);
    console.log(JSON.stringify({ status: result.status, correctness: result.correctness, elapsedRatio: result.fixedNodeElapsedRatioGeomean }));
  } else {
    if (command === 'run') { prepare(output); build(output, selectedTools); }
    const retained = Object.fromEntries(IMPLEMENTATION.map(file => [file, read(__dirname, file)]));
    const implementationDirectory = path.join(output, 'implementation');
    fs.mkdirSync(implementationDirectory);
    for (const [file, bytes] of Object.entries(retained)) {
      fs.writeFileSync(path.join(implementationDirectory, file), bytes, { flag: 'wx', mode: 0o444 });
    }
    fs.chmodSync(implementationDirectory, 0o555);
    // Node executes the same retained implementation bytes that are hashed in
    // the registration, with no require of mutable checkout dependencies.
    cp.execFileSync(process.execPath, [path.join(implementationDirectory, 'probe.js'), 'measure',
      output, path.resolve(rustRoot), path.resolve(binaryenRoot), '--retained-snapshot'], { stdio: 'inherit' });
  }
}
