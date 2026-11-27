#!/usr/bin/env node
'use strict';
if (typeof __seededHashMeasure === 'undefined') {
  const fs = require('node:fs'), path = require('node:path');
  const captured = [__filename, ...['protocol.json', 'validate.js', 'prepare.js', 'seeded-parity.rs.in'].map(p => path.join(__dirname, p))]
    .map(file => ({ file, bytes: Buffer.from(fs.readFileSync(file)) }));
  require('node:vm').compileFunction(captured[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__seededHashMeasure'], { filename: __filename })
    (require, module, module.exports, __filename, __dirname, captured);
} else {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const crypto = require('node:crypto'), assert = require('node:assert/strict'), { performance } = require('node:perf_hooks');
  const ROOT = path.resolve(__dirname, '../../..'), captured = __seededHashMeasure;
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const json = value => JSON.stringify(value, null, 2) + '\n', plain = value => JSON.parse(JSON.stringify(value));
  const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);
  const get = name => captured.find(f => f.file.endsWith('/' + name));
  const protocol = JSON.parse(get('protocol.json').bytes);
  const helper = { exports: {} };
  const validationFiles = ['validate.js', 'prepare.js', 'seeded-parity.rs.in', 'protocol.json'].map(get);
  vm.compileFunction(get('validate.js').bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__seededHashValidation'], { filename: 'retained-r86-validation.js' })
    (require, helper, helper.exports, get('validate.js').file, __dirname, validationFiles);
  const inventory = files => files.map(f => ({ path: path.relative(ROOT, f.file), sha256: sha(f.bytes) }));
  const runtime = () => ({ versions: process.versions, platform: process.platform, arch: process.arch, cpus: os.cpus().map(c => c.model) });
  const unchanged = () => captured.forEach(f => assert.equal(sha(fs.readFileSync(f.file)), sha(f.bytes), 'captured implementation changed'));
  const median = values => { const v = values.slice().sort((a, b) => a - b), n = v.length; assert.ok(n); return n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2; };
  const geomean = values => Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
  const seededCases = () => protocol.seeded.positions.flatMap((p, position) => protocol.seeded.seeds.map(rootSeed => ({ ...p, position, rootSeed })));
  const identity = () => sha(json({ schema: 'chessy.compact-hash-r86.one-shot.v1', protocol }));
  const ledgerFile = () => path.join(fs.realpathSync(os.homedir()), '.local/state/chessy-research/den-run-ai/chessy', identity() + '.started.json');
  function assertReceiptBindings(plan, sourceBytes, validationBytes) {
    const source = JSON.parse(sourceBytes), validation = JSON.parse(validationBytes);
    assert.equal(validation.schema, 'chessy.compact-hash-r86.validation.v1');
    assert.equal(validation.complete, true); assert.equal(validation.exactFiniteParity, true);
    for (const key of ['productionIntegrationAllowed', 'strengthClaimAllowed', 'universalEquivalenceProven']) assert.equal(validation[key], false);
    assert.equal(validation.researchOnly, true); assert.equal(validation.baseCommit, protocol.baseCommit);
    assert.equal(validation.signatureCases, 144); assert.equal(validation.historyCases, 2);
    assert.equal(validation.seededCases, 16); assert.equal(validation.defaultSeedCases, 4); assert.equal(validation.seededHistoryCases, 16);
    assert.equal(validation.seedExportVerified, true); assert.equal(validation.seedEffectObserved, true);
    assert.equal(validation.protocolSha256, sha(get('protocol.json').bytes));
    assert.equal(validation.sourceReceiptSha256, sha(sourceBytes)); same(validation.sourceReceipt, source, 'validated source receipt');
    same(validation.implementation, inventory(validationFiles), 'validated implementation identity');
    same(plan.modules, protocol.modules, 'registered exact module pair');
    same(validation.modules.map(({ memoryBytes, ...m }) => m), protocol.modules, 'validated exact module pair');
    assert.ok(validation.modules.every(m => m.memoryBytes === 26542080));
    same(plan.protocol, protocol, 'registered exact protocol');
    same(plan.dependencies, inventory(captured), 'registered measurement implementation');
    assert.equal(source.baseCommit, protocol.sourceBaselineCommit);
    assert.equal(source.generated.find(e => e.path === 'src/search.rs').sha256, protocol.candidateSearchSha256);
  }
  function summarizePanel(rows, cases, settings) {
    assert.equal(rows.length, cases.length * settings.nodeLimits.length * settings.repetitions * 2, 'complete timing panel required');
    const budgets = {};
    for (const nodeLimit of settings.nodeLimits) {
      const positions = cases.map((item, position) => {
        const ratios = [], nodeCounts = [];
        for (let repetition = 0; repetition < settings.repetitions; repetition++) {
          const pair = rows.filter(r => r.position === position && r.repetition === repetition && r.nodeLimit === nodeLimit);
          assert.equal(pair.length, 2, 'exact timing pair required');
          const a = pair.find(r => r.engine === 0), b = pair.find(r => r.engine === 1); assert.ok(a && b, 'one row per engine');
          same(a.result, b.result, 'timed complete signature mismatch');
          for (const row of pair) {
            assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0);
            assert.equal(row.rootSeed, item.rootSeed == null ? null : item.rootSeed, 'timed seed identity');
            assert.ok(row.result.nodes <= nodeLimit, 'node budget exceeded');
          }
          ratios.push(a.elapsedMs / b.elapsedMs); nodeCounts.push(a.result.nodes);
        }
        return { name: item.name, phase: item.phase, rootSeed: item.rootSeed == null ? null : item.rootSeed,
          ratios, nodeCounts, declaredBudgetFullyUsed: nodeCounts.every(n => n === nodeLimit), medianRatio: median(ratios) };
      });
      const phaseMedians = Object.fromEntries([...new Set(cases.map(p => p.phase))]
        .map(phase => [phase, median(positions.filter(p => p.phase === phase).map(p => p.medianRatio))]));
      budgets[nodeLimit] = { positions, geomeanRatio: geomean(positions.map(p => p.medianRatio)), phaseMedians,
        allDeclaredBudgetsFullyUsed: positions.every(p => p.declaredBudgetFullyUsed) };
    }
    return budgets;
  }
  function summary(fixedRows, seededRows) {
    const budgets = summarizePanel(fixedRows, protocol.positions, protocol.fixed);
    const seededBudgets = summarizePanel(seededRows, seededCases(), protocol.seeded.fixed);
    const gate = protocol.master.condition, routing = budgets[gate.fixedNodeLimit];
    return { ratioMeaning: 'baseline elapsed time divided by candidate elapsed time for paired equal-result searches; descriptive cost ratios, not Elo',
      budgets, seededBudgets,
      masterRoute: routing.geomeanRatio >= gate.minGeometricSpeedRatio && Object.values(routing.phaseMedians).every(v => v >= gate.minEachPhaseMedianSpeedRatio) };
  }
  function register(file, directory, validationFile) {
    directory = fs.realpathSync(directory); validationFile = fs.realpathSync(validationFile);
    const frozen = helper.exports.snapshot(directory), validationBytes = Buffer.from(fs.readFileSync(validationFile));
    const plan = {
      schema: 'chessy.compact-hash-r86.registration.v1', created: new Date().toISOString(), researchOnly: true,
      productionIntegrationAllowed: false, strengthClaimAllowed: false, experimentIdentity: identity(),
      protocol, modules: protocol.modules, directory, runtime: runtime(), dependencies: inventory(captured),
      sourceReceipt: { path: path.join(directory, 'source.json'), sha256: sha(frozen.sourceBytes) },
      validation: { path: validationFile, sha256: sha(validationBytes) }
    };
    assertReceiptBindings(plan, frozen.sourceBytes, validationBytes);
    assert.equal(fs.existsSync(ledgerFile()), false, 'experiment already started; no rerun');
    frozen.unchanged(); unchanged(); fs.writeFileSync(file, json(plan), { flag: 'wx' }); return plan;
  }
  function run(file, output) {
    file = fs.realpathSync(file); const registrationBytes = Buffer.from(fs.readFileSync(file)), plan = JSON.parse(registrationBytes);
    assert.equal(plan.schema, 'chessy.compact-hash-r86.registration.v1'); assert.equal(plan.experimentIdentity, identity());
    assert.equal(plan.researchOnly, true); assert.equal(plan.productionIntegrationAllowed, false); assert.equal(plan.strengthClaimAllowed, false);
    same(plan.runtime, runtime(), 'registered runtime changed');
    const frozen = helper.exports.snapshot(plan.directory), validationBytes = Buffer.from(fs.readFileSync(plan.validation.path));
    assert.equal(sha(frozen.sourceBytes), plan.sourceReceipt.sha256); assert.equal(sha(validationBytes), plan.validation.sha256);
    assertReceiptBindings(plan, frozen.sourceBytes, validationBytes);
    assert.equal(fs.existsSync(output), false, 'output already exists');
    const reservation = ledgerFile(); fs.mkdirSync(path.dirname(reservation), { recursive: true });
    const receipt = { schema: 'chessy.research-started.v1', experimentIdentity: identity(), registrationSha256: sha(registrationBytes), started: new Date().toISOString(), pid: process.pid };
    const fd = fs.openSync(reservation, 'wx', 0o600); try { fs.writeFileSync(fd, json(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(reservation), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    fs.mkdirSync(output); const journal = fs.openSync(path.join(output, 'rows.jsonl'), 'wx');
    const report = { schema: 'chessy.compact-hash-r86.measurement.v1', researchOnly: true, productionIntegrationAllowed: false, strengthClaimAllowed: false,
      registration: plan, registrationSha256: sha(registrationBytes), reservation: receipt, status: 'started', warmups: [], seededWarmups: [], fixed: [], seeded: [], master: [] };
    const append = (stage, row) => { report[stage].push(row); fs.writeSync(journal, JSON.stringify({ stage, ...row }) + '\n'); fs.fsyncSync(journal); };
    try {
      const context = { WebAssembly, TextEncoder, performance, console, module: { exports: {} } }; vm.createContext(context);
      vm.runInContext(frozen.runtime['assets/engine.js'].toString(), context, { filename: 'pinned-r85-engine.js' });
      vm.runInContext(frozen.runtime['assets/wasm-engine.js'].toString(), context, { filename: 'pinned-r85-wasm-engine.js' });
      const engines = frozen.modules.map(bytes => context.module.exports.loadSync(bytes)); engines.forEach(e => assert.equal(e.memoryBytes(), 26542080));
      const seeded = seededCases();
      function think(stage, cases, position, repetition, engine, options) {
        const start = performance.now(), result = engines[engine].search(cases[position].fen, options), elapsedMs = performance.now() - start;
        assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0);
        const row = { position, name: cases[position].name, phase: cases[position].phase, repetition, engine,
          rootSeed: options.rootSeed == null ? null : options.rootSeed, nodeLimit: options.nodeLimit, elapsedMs, result: plain(result) };
        append(stage, row); return row;
      }
      for (const [stage, cases, settings] of [['warmups', protocol.positions, protocol.warmup], ['seededWarmups', seeded, protocol.seeded.warmup]]) {
        for (let repetition = 0; repetition < settings.rounds; repetition++) for (let position = 0; position < cases.length; position++) {
          const first = (position + repetition) % 2, options = { ...settings };
          if (cases[position].rootSeed != null) options.rootSeed = cases[position].rootSeed;
          const a = think(stage, cases, position, repetition, first, options), b = think(stage, cases, position, repetition, 1 - first, options);
          same(a.result, b.result, 'warmup complete signature mismatch');
        }
      }
      for (const [stage, cases, settings] of [['fixed', protocol.positions, protocol.fixed], ['seeded', seeded, protocol.seeded.fixed]]) {
        for (let repetition = 0; repetition < settings.repetitions; repetition++) {
          for (let position = 0; position < cases.length; position++) for (const nodeLimit of settings.nodeLimits) {
            const first = (position + repetition) % 2, options = { ...settings, nodeLimit };
            if (cases[position].rootSeed != null) options.rootSeed = cases[position].rootSeed;
            const a = think(stage, cases, position, repetition, first, options), b = think(stage, cases, position, repetition, 1 - first, options);
            same(a.result, b.result, 'timed complete signature mismatch');
          }
          console.log('Completed ' + stage + ' repetition ' + (repetition + 1));
        }
      }
      report.summary = summary(report.fixed, report.seeded);
      console.log('Fixed-node routing ' + JSON.stringify({ master: report.summary.masterRoute, at230k: report.summary.budgets[230000].geomeanRatio,
        phases: report.summary.budgets[230000].phaseMedians, seeded230k: report.summary.seededBudgets[230000].geomeanRatio }));
      if (report.summary.masterRoute) for (const position of protocol.master.positionIndices) for (let repetition = 0; repetition < protocol.master.repetitions; repetition++) {
        const first = (position + repetition) % 2;
        think('master', protocol.positions, position, repetition, first, protocol.master);
        think('master', protocol.positions, position, repetition, 1 - first, protocol.master);
        console.log('Completed Master pair ' + position + '/' + repetition);
      }
      assert.equal(report.warmups.length, 72); assert.equal(report.seededWarmups.length, 32);
      assert.equal(report.master.length, report.summary.masterRoute ? 8 : 0);
      engines.forEach(e => assert.equal(e.memoryBytes(), 26542080)); frozen.unchanged(); unchanged();
      assert.equal(sha(fs.readFileSync(file)), sha(registrationBytes));
      assert.equal(sha(fs.readFileSync(plan.validation.path)), sha(validationBytes)); same(JSON.parse(fs.readFileSync(reservation)), receipt);
      report.status = 'complete';
    } catch (error) { report.status = 'failed'; report.error = String(error.stack || error); throw error; }
    finally { fs.closeSync(journal); fs.writeFileSync(path.join(output, 'report.json'), json(report), { flag: 'wx' }); }
    return report;
  }
  module.exports = { register, run, summary, summarizePanel, median, geomean, seededCases, assertReceiptBindings };
  if (require.main === module) {
    const [command, ...args] = process.argv.slice(2); let result;
    if (command === 'register' && args.length === 3) result = register(...args);
    else if (command === 'run' && args.length === 2) result = run(...args);
    else throw Error('usage: measure.js register PLAN GENERATED_CRATE VALIDATION | run PLAN NEW_OUTPUT_DIR');
    console.log(json({ status: result.status || 'registered', experimentIdentity: result.experimentIdentity || result.registration.experimentIdentity }));
  }
}
