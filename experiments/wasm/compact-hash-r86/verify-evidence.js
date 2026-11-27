#!/usr/bin/env node
'use strict';
// Independent post-run verifier. It never imports or executes measure.js and
// never searches; the measured implementation and protocol stay unchanged.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process'), vm = require('node:vm'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const IDENTITY_SHA256 = 'bbebcef8270d5c81ed1ced8fb2305f8b96c998380b4b603ef624fb8b1a4741cc';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const CODE_PREFIX = 'experiments/wasm/compact-hash-r86/';
const SOURCE_PATHS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.sh', 'src/engine.rs', 'src/eval.rs', 'src/lib.rs', 'src/search.rs'];
const ARTIFACT_PATHS = [
  'prepare.js', 'seeded-parity.rs.in', 'validate.js', 'measure.js', 'protocol.json', 'probe.test.js',
  'evidence/source.json', 'evidence/validation.json', 'evidence/registration.json', 'evidence/native.log', 'evidence/build.log',
  'evidence/measurement.json', 'evidence/rows.jsonl', 'evidence/measurement.log', 'evidence/raw-logs.json', 'evidence/summary.json',
  'evidence/compression-diagnostic.json'
];
function authenticate(identityBytes, read) {
  assert.equal(sha(identityBytes), IDENTITY_SHA256, 'committed evidence identity changed');
  const identity = JSON.parse(identityBytes);
  assert.deepEqual(identity.files.map(f => f.path), ARTIFACT_PATHS, 'complete evidence inventory');
  const bytes = Object.fromEntries(identity.files.map(entry => {
    const content = Buffer.from(read(entry.path));
    assert.equal(content.length, entry.bytes, 'evidence byte count: ' + entry.path);
    assert.equal(sha(content), entry.sha256, 'evidence hash: ' + entry.path);
    return [entry.path, content];
  }));
  return { identity, bytes };
}
function capture() {
  const identityBytes = Buffer.from(fs.readFileSync(path.join(__dirname, 'evidence/identity.json')));
  const { identity, bytes } = authenticate(identityBytes, p => fs.readFileSync(path.join(__dirname, p)));
  const parse = p => JSON.parse(bytes[p]);
  const protocol = parse('protocol.json');
  const runtime = {};
  for (const [p, digest] of [
    ['assets/engine.js', '897bf4047c301b125bebff1d587c9407b9a8a5b5501ea38254ceff028c9ca8fa'],
    ['test/fixtures/wasm-r69-signatures.json', 'd500dece3ed9bfc83da5139cabf075734c1f1f465f295f9c8be7be23eccc6b6b']
  ]) {
    const content = cp.execFileSync('git', ['--no-replace-objects', 'show', protocol.baseCommit + ':' + p], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(sha(content), digest, 'pinned independent rules/fixture identity');
    runtime[p] = content;
  }
  const context = {}; vm.createContext(context);
  vm.runInContext(runtime['assets/engine.js'].toString(), context, { filename: 'retained-r85-rules.js' });
  return { identity, bytes, protocol, Chess: context.Chess, fixture: JSON.parse(runtime['test/fixtures/wasm-r69-signatures.json']),
    source: parse('evidence/source.json'), validation: parse('evidence/validation.json'), registration: parse('evidence/registration.json'),
    report: parse('evidence/measurement.json'), storedSummary: parse('evidence/summary.json'),
    journal: bytes['evidence/rows.jsonl'].toString().trimEnd().split('\n').map(line => JSON.parse(line)) };
}
const midpoint = values => { const sorted = [...values].sort((a, b) => a - b); assert.equal(sorted.length % 2, 0); return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const geometric = values => Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length);
function aggregatePanel(rows, cases, settings) {
  const budgets = {};
  for (const nodeLimit of settings.nodeLimits) {
    const positions = cases.map((item, position) => {
      const ratios = [], nodeCounts = [];
      for (let repetition = 0; repetition < settings.repetitions; repetition++) {
        const a = rows.find(r => r.position === position && r.repetition === repetition && r.nodeLimit === nodeLimit && r.engine === 0);
        const b = rows.find(r => r.position === position && r.repetition === repetition && r.nodeLimit === nodeLimit && r.engine === 1);
        assert.ok(a && b, 'missing aggregate pair'); assert.deepEqual(a.result, b.result, 'complete paired signature');
        const ratio = a.elapsedMs / b.elapsedMs; assert.ok(Number.isFinite(ratio) && ratio > 0);
        ratios.push(ratio); nodeCounts.push(a.result.nodes);
      }
      return { name: item.name, phase: item.phase, rootSeed: item.rootSeed == null ? null : item.rootSeed,
        ratios, nodeCounts, declaredBudgetFullyUsed: nodeCounts.every(n => n === nodeLimit), medianRatio: midpoint(ratios) };
    });
    const phaseMedians = Object.fromEntries([...new Set(cases.map(p => p.phase))]
      .map(phase => [phase, midpoint(positions.filter(p => p.phase === phase).map(p => p.medianRatio))]));
    budgets[nodeLimit] = { positions, geomeanRatio: geometric(positions.map(p => p.medianRatio)), phaseMedians,
      allDeclaredBudgetsFullyUsed: positions.every(p => p.declaredBudgetFullyUsed) };
  }
  return budgets;
}
function inspect(data) {
  const { identity, bytes, protocol, source, validation, registration, report, journal, Chess, fixture } = data;
  assert.equal(identity.schema, 'chessy.compact-hash-r86.evidence-identity.v1');
  assert.equal(identity.protocolSha256, sha(bytes['protocol.json']));
  assert.equal(report.schema, 'chessy.compact-hash-r86.measurement.v1'); assert.equal(report.status, 'complete');
  for (const object of [report, registration, validation]) {
    assert.equal(object.researchOnly, true); assert.equal(object.productionIntegrationAllowed, false); assert.equal(object.strengthClaimAllowed, false);
  }
  assert.deepEqual(report.registration, registration, 'complete registered plan');
  assert.equal(report.registrationSha256, sha(bytes['evidence/registration.json']));
  assert.equal(report.reservation.registrationSha256, report.registrationSha256);
  assert.equal(report.reservation.schema, 'chessy.research-started.v1');
  const experimentIdentity = sha(json({ schema: 'chessy.compact-hash-r86.one-shot.v1', protocol }));
  for (const value of [identity.experimentIdentity, registration.experimentIdentity, report.reservation.experimentIdentity]) assert.equal(value, experimentIdentity);
  assert.ok(Date.parse(report.reservation.started) >= Date.parse(registration.created), 'registration must precede the run');
  assert.deepEqual(registration.protocol, protocol); assert.deepEqual(registration.modules, protocol.modules);
  const digests = new Map(identity.files.map(f => [CODE_PREFIX + f.path, f.sha256]));
  const expectedImplementation = names => names.map(name => ({ path: CODE_PREFIX + name, sha256: digests.get(CODE_PREFIX + name) }));
  assert.deepEqual(registration.dependencies, expectedImplementation(['measure.js', 'protocol.json', 'validate.js', 'prepare.js', 'seeded-parity.rs.in']));
  assert.deepEqual(validation.implementation, expectedImplementation(['validate.js', 'prepare.js', 'seeded-parity.rs.in', 'protocol.json']));
  assert.equal(registration.validation.sha256, sha(bytes['evidence/validation.json']));
  for (const digest of [registration.sourceReceipt.sha256, validation.sourceReceiptSha256]) assert.equal(digest, sha(bytes['evidence/source.json']));
  assert.deepEqual(validation.sourceReceipt, source); assert.equal(validation.protocolSha256, sha(bytes['protocol.json']));
  assert.deepEqual(source.source.map(f => f.path), SOURCE_PATHS); assert.deepEqual(source.generated.map(f => f.path), SOURCE_PATHS);
  assert.equal(source.baseCommit, protocol.sourceBaselineCommit); assert.equal(source.variant, 'threaded');
  assert.equal(source.generated.find(f => f.path === 'src/search.rs').sha256, protocol.candidateSearchSha256);
  assert.equal(validation.complete, true); assert.equal(validation.exactFiniteParity, true); assert.equal(validation.universalEquivalenceProven, false);
  assert.equal(validation.baseCommit, protocol.baseCommit);
  assert.deepEqual(validation.modules, protocol.modules.map(m => ({ ...m, memoryBytes: 26542080 })));
  const legalCache = new Map();
  const uci = move => move ? Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '') : '-';
  function legalMove(fen, move) {
    if (!legalCache.has(fen)) legalCache.set(fen, new Set(Chess.legalMoves(Chess.newGameState(fen)).map(uci)));
    assert.ok(legalCache.get(fen).has(typeof move === 'string' ? move : uci(move)), 'retained move must be legal');
  }
  function legalPv(fen, pv) {
    let state = Chess.newGameState(fen);
    for (const move of pv) {
      const found = Chess.legalMoves(state).find(m => uci(m) === move); assert.ok(found, 'retained exact-root PV must replay legally');
      state = Chess.applyMove(state, found);
    }
  }
  assert.equal(validation.signatureCases, 144); assert.equal(validation.rows.length, 144); assert.equal(fixture.cases.length, 144);
  for (let i = 0; i < fixture.cases.length; i++) {
    const recorded = validation.rows[i], frozen = fixture.cases[i];
    assert.equal(recorded.name, frozen.name); assert.deepEqual(recorded.config, frozen.config);
    assert.deepEqual(Object.fromEntries(fixture.fields.map(k => [k, recorded.result[k]])), frozen.result, 'immutable frozen signature');
    const fen = protocol.positions.find(p => p.name === recorded.name).fen;
    if (recorded.result.move !== '-') { legalMove(fen, recorded.result.move); assert.ok(recorded.root); legalPv(fen, recorded.root.pv); }
    else assert.equal(recorded.root, null);
  }
  for (const [countField, rowsField, count] of [
    ['historyCases', 'historyRows', 2], ['seededCases', 'seededRows', 16],
    ['defaultSeedCases', 'defaultSeedRows', 4], ['seededHistoryCases', 'seededHistoryRows', 16]
  ]) { assert.equal(validation[countField], count); assert.equal(validation[rowsField].length, count); }
  assert.equal(validation.seedExportVerified, true); assert.equal(validation.seedEffectObserved, true);
  for (const row of validation.seededRows) {
    assert.deepEqual(row.results[0], row.results[1], 'preflight paired seeded result');
    assert.equal(row.exports.length, 2);
    for (const call of row.exports) assert.deepEqual(call, { name: 'search_seeded', args: [111, row.nodeLimit, 0, 1, row.rootSeed] }, 'observed seeded export call');
    legalMove(row.fen, row.results[0].move);
  }
  for (const row of validation.seededHistoryRows) {
    assert.deepEqual(row.results[0], row.results[1]);
    for (const call of row.exports) assert.deepEqual(call, { name: 'search_seeded', args: [6, row.nodeLimit, 0, 1, row.rootSeed] });
  }
  for (const row of validation.defaultSeedRows) assert.deepEqual(row.ordinary, row.explicitHistoricalSeed, 'default-seed preservation');
  const effect = protocol.seeded.positions.flatMap((_, position) => protocol.seeded.fixed.nodeLimits.map(nodeLimit => {
    const sample = validation.seededRows.filter(r => r.position === position && r.nodeLimit === nodeLimit);
    assert.deepEqual(sample.map(r => r.rootSeed), protocol.seeded.seeds);
    return { position, nodeLimit, distinctFullResults: new Set(sample.map(r => JSON.stringify(r.results[0]))).size,
      distinctMoves: new Set(sample.map(r => r.results[0].move)).size };
  }));
  assert.deepEqual(validation.seedEffect, effect); assert.ok(effect.some(e => e.distinctFullResults > 1));
  const seeded = protocol.seeded.positions.flatMap((p, position) => protocol.seeded.seeds.map(rootSeed => ({ ...p, position, rootSeed })));
  let journalIndex = 0;
  function checkStage(stage, cases, settings, warmup) {
    const rows = report[stage], expected = [];
    for (let repetition = 0; repetition < (warmup ? settings.rounds : settings.repetitions); repetition++) {
      for (let position = 0; position < cases.length; position++) {
        for (const nodeLimit of warmup ? [settings.nodeLimit] : settings.nodeLimits) {
          const first = (position + repetition) % 2;
          for (const engine of [first, 1 - first]) expected.push({ position, repetition, engine, nodeLimit });
        }
      }
    }
    assert.equal(rows.length, expected.length, 'complete ' + stage + ' schedule');
    for (let i = 0; i < expected.length; i++) {
      const row = rows[i], descriptor = expected[i], item = cases[descriptor.position];
      for (const [key, value] of Object.entries(descriptor)) assert.equal(row[key], value, stage + ' row schedule: ' + key);
      assert.equal(row.name, item.name); assert.equal(row.phase, item.phase); assert.equal(row.rootSeed, item.rootSeed == null ? null : item.rootSeed);
      assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, 'finite positive elapsed time');
      assert.equal(row.result.nodes, row.nodeLimit, 'every recorded fixed search used its full declared cap');
      assert.equal(row.result.scorePov, 'white'); assert.ok(Number.isSafeInteger(row.result.score));
      assert.ok(Number.isSafeInteger(row.result.depth) && row.result.depth >= 0 && row.result.depth <= settings.maxDepth);
      for (const k of ['nodes', 'qnodes', 'cutoffs', 'researches']) assert.ok(Number.isSafeInteger(row.result[k]) && row.result[k] >= 0);
      assert.ok(row.result.qnodes <= row.result.nodes); legalMove(item.fen, row.result.move);
      assert.deepEqual(journal[journalIndex++], { stage, ...row }, 'journal/report row identity and order');
      if (i % 2) assert.deepEqual(rows[i - 1].result, row.result, 'every paired complete result must match');
      if (stage === 'seeded') {
        const preflight = validation.seededRows.find(p => p.position === item.position && p.rootSeed === item.rootSeed && p.nodeLimit === row.nodeLimit);
        assert.ok(preflight);
        assert.deepEqual({ ...row.result, move: uci(row.result.move) }, preflight.results[row.engine], 'timed seed result differs from actual-export preflight');
      }
    }
  }
  checkStage('warmups', protocol.positions, protocol.warmup, true);
  checkStage('seededWarmups', seeded, protocol.seeded.warmup, true);
  checkStage('fixed', protocol.positions, protocol.fixed, false);
  checkStage('seeded', seeded, protocol.seeded.fixed, false);
  const budgets = aggregatePanel(report.fixed, protocol.positions, protocol.fixed);
  const seededBudgets = aggregatePanel(report.seeded, seeded, protocol.seeded.fixed);
  const condition = protocol.master.condition, eligible = budgets[condition.fixedNodeLimit];
  const masterRoute = eligible.geomeanRatio >= condition.minGeometricSpeedRatio && Object.values(eligible.phaseMedians).every(r => r >= condition.minEachPhaseMedianSpeedRatio);
  const summary = { ratioMeaning: 'baseline elapsed time divided by candidate elapsed time for paired equal-result searches; descriptive cost ratios, not Elo',
    budgets, seededBudgets, masterRoute };
  assert.deepEqual(report.summary, summary, 'independently recomputed summary arithmetic');
  assert.deepEqual(data.storedSummary, summary, 'standalone summary identity');
  const expectedMaster = [];
  if (masterRoute) for (const position of protocol.master.positionIndices) for (let repetition = 0; repetition < protocol.master.repetitions; repetition++) {
    const first = (position + repetition) % 2;
    for (const engine of [first, 1 - first]) expectedMaster.push({ position, repetition, engine });
  }
  assert.equal(report.master.length, expectedMaster.length, 'only prospectively routed Master searches');
  for (let i = 0; i < expectedMaster.length; i++) {
    const row = report.master[i], descriptor = expectedMaster[i], item = protocol.positions[descriptor.position];
    for (const [key, value] of Object.entries(descriptor)) assert.equal(row[key], value, 'Master schedule');
    assert.equal(row.name, item.name); assert.equal(row.phase, item.phase); assert.equal(row.rootSeed, null); assert.equal(row.nodeLimit, 0);
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0); assert.equal(row.result.stopReason, 'time-limit');
    assert.ok(Number.isSafeInteger(row.result.nodes) && row.result.nodes > 0); legalMove(item.fen, row.result.move);
    assert.deepEqual(journal[journalIndex++], { stage: 'master', ...row }, 'Master journal/report row identity');
    if (i % 2) for (const key of ['move', 'score', 'depth']) assert.deepEqual(row.result[key], report.master[i - 1].result[key], 'recorded Master completed result');
  }
  assert.equal(journalIndex, journal.length, 'no extra or missing journal rows'); assert.equal(journal.length, 672);
  return { complete: true, journalRows: journal.length, pairedFixedSearches: (report.fixed.length + report.seeded.length) / 2,
    fixedCapsFullyUsed: Object.values(budgets).every(b => b.allDeclaredBudgetsFullyUsed) && Object.values(seededBudgets).every(b => b.allDeclaredBudgetsFullyUsed),
    masterSearches: report.master.length, primary230kRatio: budgets[230000].geomeanRatio, seeded230kRatio: seededBudgets[230000].geomeanRatio,
    measuredNodeVersion: registration.runtime.versions.node, timingRepeated: false };
}
function verify() { return inspect(capture()); }
module.exports = { authenticate, capture, inspect, verify, aggregatePanel, IDENTITY_SHA256 };
if (require.main === module) {
  assert.equal(process.argv.length, 2, 'usage: node verify-evidence.js');
  console.log(json(verify()));
}
