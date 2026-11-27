'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const prepare = require('./prepare.js'), validate = require('./validate.js'), measure = require('./measure.js');
const protocol = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json')));
const sourceBytes = fs.readFileSync(path.join(__dirname, 'evidence/source.json'));
const validationBytes = fs.readFileSync(path.join(__dirname, 'evidence/validation.json'));
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
const implementation = ['measure.js', 'protocol.json', 'validate.js', 'prepare.js', 'seeded-parity.rs.in'].map(name => ({
  path: 'experiments/wasm/compact-hash-r86/' + name, sha256: prepare.sha(fs.readFileSync(path.join(__dirname, name)))
}));
const plan = { protocol, modules: protocol.modules, dependencies: implementation };
test('frozen preflight binds exact source, module pair and seed-aware implementation', () => measure.assertReceiptBindings(plan, sourceBytes, validationBytes));
test('retained checked recipe regenerates the exact published seeded search', () => {
  const frozen = prepare.capture();
  assert.equal(prepare.sha(frozen.generated['src/search.rs']), protocol.candidateSearchSha256);
  assert.deepEqual(frozen.receipt, JSON.parse(sourceBytes));
  assert.equal(Object.keys(frozen.generated).length, 8);
});
for (const [name, change] of [
  ['candidate module', p => p.modules[1].sha256 = '0'.repeat(64)],
  ['candidate size', p => p.modules[1].rawBytes++],
  ['protocol', p => p.protocol.seeded.seeds[0] = 2],
  ['runner bytes', p => p.dependencies[0].sha256 = '0'.repeat(64)]
]) test('registration rejects changed ' + name, () => {
  const mutated = clone(plan); change(mutated);
  assert.throws(() => measure.assertReceiptBindings(mutated, sourceBytes, validationBytes));
});
for (const [name, change] of [
  ['missing signature', v => v.signatureCases--],
  ['missing seeded case', v => v.seededCases--],
  ['missing explicit-default case', v => v.defaultSeedCases--],
  ['missing seeded history', v => v.seededHistoryCases--],
  ['unverified export forwarding', v => v.seedExportVerified = false],
  ['no observed seed effect', v => v.seedEffectObserved = false],
  ['unearned production authority', v => v.productionIntegrationAllowed = true],
  ['claimed universal proof', v => v.universalEquivalenceProven = true]
]) test('registration rejects ' + name, () => {
  const mutated = JSON.parse(validationBytes); change(mutated);
  assert.throws(() => measure.assertReceiptBindings(plan, sourceBytes, Buffer.from(JSON.stringify(mutated))));
});
function rows(cases, settings) {
  const result = [];
  for (let repetition = 0; repetition < settings.repetitions; repetition++) {
    for (const [position, item] of cases.entries()) for (const nodeLimit of settings.nodeLimits) for (const engine of [0, 1]) {
      result.push({ position, repetition, nodeLimit, engine, rootSeed: item.rootSeed == null ? null : item.rootSeed,
        elapsedMs: 1, result: { move: null, score: 0, nodes: nodeLimit } });
    }
  }
  return result;
}
const fixed = rows(protocol.positions, protocol.fixed), seeded = rows(measure.seededCases(), protocol.seeded.fixed);
test('both complete panels are required and only the declared primary panel routes Master', () => {
  const neutral = measure.summary(fixed, seeded); assert.equal(neutral.masterRoute, false);
  assert.equal(neutral.budgets[230000].geomeanRatio, 1);
  const fastSeeds = clone(seeded); fastSeeds.filter(r => r.engine === 0).forEach(r => { r.elapsedMs = 10; });
  assert.equal(measure.summary(fixed, fastSeeds).masterRoute, false);
  assert.throws(() => measure.summary(fixed.slice(1), seeded));
  assert.throws(() => measure.summary(fixed, seeded.slice(1)));
});
test('a timed signature mismatch, changed seed or duplicate engine fails closed', () => {
  const changed = clone(seeded); changed[0].result.score = 1;
  assert.throws(() => measure.summary(fixed, changed), /signature mismatch/);
  changed[0].result.score = 0; changed[0].rootSeed = 2;
  assert.throws(() => measure.summary(fixed, changed), /seed identity/);
  changed[0].rootSeed = 0; changed[0].engine = 1;
  assert.throws(() => measure.summary(fixed, changed), /one row per engine/);
});
test('early finite stops are retained and do not masquerade as using the full cap', () => {
  const changed = clone(fixed); changed[0].result.nodes = 20; changed[1].result.nodes = 20;
  const result = measure.summary(changed, seeded);
  assert.equal(result.budgets[10000].allDeclaredBudgetsFullyUsed, false);
  assert.equal(result.budgets[10000].positions[0].nodeCounts[0], 20);
});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-r86-probe-'));
try {
  const directory = path.join(temporary, 'crate'); prepare.prepare(directory);
  for (const file of ['src/search.rs', 'Cargo.toml']) test('rejects coherent source and receipt changes to ' + file, () => {
    const target = path.join(directory, file), original = fs.readFileSync(target);
    const receiptFile = path.join(directory, 'source.json'), originalReceipt = fs.readFileSync(receiptFile), receipt = JSON.parse(originalReceipt);
    const modified = Buffer.concat([original, Buffer.from(file.endsWith('.rs') ? '\n// changed source\n' : '\n# changed source\n')]);
    receipt.generated.find(e => e.path === file).sha256 = prepare.sha(modified);
    fs.writeFileSync(target, modified); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    try { assert.throws(() => validate.snapshot(directory), /exact retained generator output/); }
    finally { fs.writeFileSync(target, original); fs.writeFileSync(receiptFile, originalReceipt); }
  });
  test('rejects undeclared Rust source inventory', () => {
    const file = path.join(directory, 'src/extra.rs'); fs.writeFileSync(file, '// extra');
    try { assert.throws(() => validate.snapshot(directory)); } finally { fs.unlinkSync(file); }
  });
  if (process.argv[2]) test('freshly built module and all source bytes match the frozen candidate', () => {
    const frozen = validate.snapshot(path.resolve(process.argv[2])); frozen.unchanged();
    assert.equal(prepare.sha(frozen.modules[1]), protocol.modules[1].sha256);
  });
} finally { fs.rmSync(temporary, { recursive: true }); }
console.log(checks + ' checks passed; no timing or search executed');
