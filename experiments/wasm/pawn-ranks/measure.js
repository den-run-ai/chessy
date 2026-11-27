'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { snapshot, harness, verify, json, plain, sha } = require('./validate.js');
const IMPLEMENTATION = ['candidate.js', 'tests.rs', 'source.json', 'protocol.json', 'prepare.js', 'build.js', 'validate.js', 'measure.js', 'probe.test.js'];
const read = (directory, file) => fs.readFileSync(path.join(directory, file));
const publish = (directory, file, value) => fs.writeFileSync(path.join(directory, file), json(value), { flag: 'wx' });
const median = items => {
  const values = items.slice().sort((a, b) => a - b), half = Math.floor(values.length / 2);
  assert.ok(values.length);
  return values.length % 2 ? values[half] : (values[half - 1] + values[half]) / 2;
};
const geomean = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);

function summarize(rows, protocol) {
  const byBudget = {};
  for (const nodeLimit of protocol.fixedNodeLimits) {
    const positions = protocol.positions.map(({ name, phase }) => {
      const pairedRatios = [];
      for (let repeat = 0; repeat < protocol.fixedNodeRepetitions; repeat++) {
        const pair = rows.filter(row => row.position === name && row.nodeLimit === nodeLimit && row.repeat === repeat);
        assert.equal(pair.length, 2);
        const base = pair.find(row => row.engine === 'baseline'), candidate = pair.find(row => row.engine === 'candidate');
        assert.deepEqual(candidate.result, base.result, 'timed search changed complete signature');
        pairedRatios.push(base.elapsedMs / candidate.elapsedMs);
      }
      return { position: name, phase, pairedRatios, medianRatio: median(pairedRatios) };
    });
    const phaseMedians = Object.fromEntries(['opening', 'middlegame', 'endgame'].map(phase =>
      [phase, median(positions.filter(item => item.phase === phase).map(item => item.medianRatio))]));
    byBudget[nodeLimit] = { positions, geomeanRatio: geomean(positions.map(item => item.medianRatio)), phaseMedians };
  }
  const routing = byBudget[protocol.masterRouting.budget];
  return { byBudget, masterRoute: routing.geomeanRatio >= protocol.masterRouting.geomeanMinimum &&
    Object.values(routing.phaseMedians).every(value => value >= protocol.masterRouting.eachPhaseMedianMinimum),
  allPairsIdenticalNodesAndSignatures: true,
  allSearchesConsumeDeclaredNodeLimit: rows.every(row => row.result.nodes === row.nodeLimit) };
}

function measure(directory) {
  const frozen = snapshot(directory);
  const implementation = Object.fromEntries(IMPLEMENTATION.map(file => [file, read(__dirname, file)]));
  const protocol = JSON.parse(implementation['protocol.json']);
  const selectedTools = JSON.parse(read(directory, 'tools.json'));
  for (const [name, file] of Object.entries(selectedTools.binaries)) {
    assert.equal(sha(fs.readFileSync(file)), selectedTools.sha256[name], 'tool changed before run');
  }
  assert.equal(protocol.fixedNodeRepetitions, 4);
  assert.equal(protocol.masterRepetitions, 2);
  assert.deepEqual(protocol.masterPositionIndices, [0, 8]);
  const registration = { registeredAt: new Date().toISOString(), source: frozen.registration, protocol,
    implementationSha256: Object.fromEntries(Object.entries(implementation).map(([file, bytes]) => [file, sha(bytes)])),
    tools: selectedTools,
    modules: Object.fromEntries(Object.entries(frozen.modules).map(([name, bytes]) => [name, sha(bytes)])),
    host: { platform: process.platform, arch: process.arch, versions: process.versions, cpus: os.cpus().map(item => item.model) } };
  publish(directory, 'measurement-registration.json', registration);
  const report = { registrationSha256: sha(Buffer.from(json(registration))), status: 'started', warmups: [], fixedNodes: [], master: [] };
  try {
    const correctness = { status: 'started' };
    try { verify(frozen, protocol, correctness); correctness.status = 'complete'; }
    catch (error) { correctness.status = 'failed'; correctness.error = String(error.stack || error); throw error; }
    finally {
      publish(directory, 'measured-correctness.json', correctness);
      report.correctnessSha256 = sha(Buffer.from(json(correctness)));
      report.correctness = correctness.summary;
    }
    console.log('Retained correctness passed:', JSON.stringify(report.correctness));
    const { Wasm } = harness(frozen.scripts);
    const engines = Object.fromEntries(Object.entries(frozen.modules).map(([mode, bytes]) => [mode, Wasm.loadSync(bytes)]));
    report.moduleSizes = { encoder: { node: process.version, brotli: process.versions.brotli, zlib: process.versions.zlib, quality: 11 },
      modules: Object.fromEntries(Object.entries(frozen.modules).map(([mode, bytes]) => [mode, { raw: bytes.length,
        brotli: zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length }])) };
    for (let repeat = 0; repeat < protocol.warmupRepetitions; repeat++) {
      for (const [index, position] of protocol.positions.entries()) {
        for (const mode of (repeat + index) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const result = engines[mode].search(position.fen, { maxDepth: protocol.maxDepth, nodeLimit: protocol.warmupNodeLimit,
            timeMs: 0, quiesce: protocol.quiesce });
          report.warmups.push({ repeat, position: position.name, engine: mode, result: plain(result) });
        }
      }
    }
    for (let repeat = 0; repeat < protocol.fixedNodeRepetitions; repeat++) {
      for (const [positionIndex, position] of protocol.positions.entries()) {
        for (const [budgetIndex, nodeLimit] of protocol.fixedNodeLimits.entries()) {
          const order = (repeat + positionIndex + budgetIndex) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
          const pair = [];
          for (const mode of order) {
            const start = performance.now();
            const result = engines[mode].search(position.fen, { maxDepth: protocol.maxDepth, nodeLimit,
              timeMs: 0, quiesce: protocol.quiesce });
            const elapsedMs = performance.now() - start;
            const row = { repeat, position: position.name, phase: position.phase, nodeLimit, engine: mode, elapsedMs, result: plain(result) };
            report.fixedNodes.push(row); pair.push(row);
          }
          assert.deepEqual(pair[0].result, pair[1].result, 'timed complete signature mismatch: ' + position.name);
        }
      }
      console.log('Completed balanced fixed-node repetition', repeat + 1);
    }
    report.fixedNodeSummary = summarize(report.fixedNodes, protocol);
    console.log('Fixed-node routing:', JSON.stringify({ master: report.fixedNodeSummary.masterRoute,
      ratio230k: report.fixedNodeSummary.byBudget[230000].geomeanRatio, phases: report.fixedNodeSummary.byBudget[230000].phaseMedians }));
    report.masterRouting = { run: report.fixedNodeSummary.masterRoute, rule: protocol.masterRouting, descriptiveOnly: true };
    if (report.masterRouting.run) {
      for (const positionIndex of protocol.masterPositionIndices) {
        const position = protocol.positions[positionIndex];
        for (let repeat = 0; repeat < protocol.masterRepetitions; repeat++) {
          for (const mode of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
            const start = performance.now();
            const result = engines[mode].search(position.fen, { maxDepth: protocol.maxDepth, nodeLimit: 0,
              timeMs: protocol.masterTimeMs, quiesce: protocol.quiesce });
            report.master.push({ repeat, position: position.name, engine: mode, elapsedMs: performance.now() - start, result: plain(result) });
            console.log('Completed Master diagnostic:', position.name, repeat + 1, mode, result.depth, result.nodes);
          }
        }
      }
    }
    for (const [file, bytes] of Object.entries(implementation)) assert.equal(sha(read(__dirname, file)), sha(bytes), 'implementation changed during run');
    for (const [name, file] of Object.entries(selectedTools.binaries)) assert.equal(sha(fs.readFileSync(file)), selectedTools.sha256[name], 'tool changed during run');
    const after = snapshot(directory);
    assert.deepEqual(after.registration, frozen.registration);
    for (const mode of Object.keys(frozen.modules)) assert.equal(sha(after.modules[mode]), sha(frozen.modules[mode]), 'module changed during run');
    report.status = 'complete';
  } catch (error) { report.status = 'failed'; report.error = String(error.stack || error); throw error; }
  finally { publish(directory, 'report.json', report); }
  return report;
}

module.exports = { IMPLEMENTATION, median, geomean, summarize, measure };
if (require.main === module) {
  assert.ok(process.argv[2], 'usage: measure.js ABS_PREPARED_BUILT_OUTPUT');
  const output = path.resolve(process.argv[2]);
  if (process.argv[3] === '--retained-snapshot') {
    assert.equal(__dirname, path.join(output, 'implementation'));
    const report = measure(output);
    console.log(JSON.stringify({ status: report.status, moduleSizes: report.moduleSizes, masterRouting: report.masterRouting }));
  } else {
    const implementationDirectory = path.join(output, 'implementation');
    fs.mkdirSync(implementationDirectory);
    for (const file of IMPLEMENTATION) fs.writeFileSync(path.join(implementationDirectory, file), read(__dirname, file), { flag: 'wx', mode: 0o444 });
    fs.chmodSync(implementationDirectory, 0o555);
    cp.execFileSync(process.execPath, [path.join(implementationDirectory, 'measure.js'), output, '--retained-snapshot'], { stdio: 'inherit' });
  }
}
