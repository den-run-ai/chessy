'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');
const m = require('./engine-signatures-v2.js');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'd56a745c3bdb373e9fa23fca0d48b2b6e9f21114';
let count = 0;
function test(name, fn) { fn(); count++; console.log('ok ' + name); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-signature-tests-'));
function git(...args) { return cp.execFileSync('git', ['-C', tmp, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
try {
  cp.execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', ROOT, tmp]);
  git('checkout', '--quiet', '--detach', BASE);
  git('config', 'user.name', 'Signature mechanism test');
  git('config', 'user.email', 'signature-test@invalid.example');
  test('immutable historical fixture and generator', () => m.historical(ROOT));
  test('complete corpus and unique IDs', () => {
    const cases = m.corpus(); assert.equal(cases.length, 144);
    assert.equal(new Set(cases.map(x => x.id)).size, 144);
  });
  test('exact historical r69 bytes regenerate the immutable 144-case fixture', () => {
    const frozen = cp.execFileSync('git', ['-C', ROOT, 'show', '8b887c4a69f8b06bb50ad8d77be896f26938ed42:assets/chessy-ai-fast.wasm']);
    const wasmPath = path.join(tmp, 'r69-smoke.wasm'); fs.writeFileSync(wasmPath, frozen);
    try {
      cp.execFileSync(process.execPath, ['test/gen-wasm-signatures.js', '--wasm', wasmPath], { cwd: tmp });
      assert.equal(m.sha(fs.readFileSync(path.join(tmp, m.LEGACY))), m.sha(fs.readFileSync(path.join(ROOT, m.LEGACY))));
    } finally { fs.unlinkSync(wasmPath); }
  });
  test('legacy generator still rejects current non-r69 bytes', () => {
    const result = cp.spawnSync(process.execPath, ['test/gen-wasm-signatures.js', '--wasm', 'assets/chessy-ai-fast.wasm'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /refusing to label non-r69 bytes/);
  });
  test('commit aliases and abbreviated references rejected', () => {
    for (const ref of ['HEAD', 'main', BASE.slice(0, 12)]) assert.throws(() => m.source(tmp, ref), /full immutable/);
  });
  test('source matches exact tracked build inputs and module', () => {
    const result = m.source(tmp, BASE); assert.equal(result.release, 'r79');
    assert.equal(result.shippedWasmSha256, m.sha(fs.readFileSync(path.join(tmp, 'assets/chessy-ai-fast.wasm'))));
  });
  test('dirty and untracked trees rejected', () => {
    m.clean(tmp); fs.writeFileSync(path.join(tmp, 'untracked.txt'), 'x');
    assert.throws(() => m.clean(tmp), /dirty or untracked/); fs.unlinkSync(path.join(tmp, 'untracked.txt'));
    fs.appendFileSync(path.join(tmp, 'experiments/wasm/src/eval.rs'), '\n// dirty\n');
    assert.throws(() => m.clean(tmp), /dirty or untracked/); git('checkout', '--', 'experiments/wasm/src/eval.rs');
  });
  test('unpinned committed build contract rejected', () => {
    fs.appendFileSync(path.join(tmp, 'experiments/wasm/build.sh'), '\n# altered\n');
    git('add', 'experiments/wasm/build.sh'); git('commit', '--quiet', '-m', 'unpinned test');
    assert.throws(() => m.source(tmp, git('rev-parse', 'HEAD')), /unpinned build contract/);
    const altered = git('rev-parse', 'HEAD');
    git('replace', BASE, altered);
    try { assert.equal(m.source(tmp, BASE).commit, BASE, 'replacement objects must not reinterpret source SHA'); }
    finally { git('replace', '-d', BASE); }

    git('reset', '--hard', BASE);
  });
  test('ambient compiler overrides rejected', () => {
    const old = process.env.RUSTC_WRAPPER; process.env.RUSTC_WRAPPER = '/tmp/not-reviewed';
    try { assert.throws(() => m.pinnedEnvironment(), /clear ambient RUSTC_WRAPPER/); }
    finally { if (old === undefined) delete process.env.RUSTC_WRAPPER; else process.env.RUSTC_WRAPPER = old; }
  });
  const bytes = fs.readFileSync(path.join(ROOT, 'assets/chessy-ai-fast.wasm'));
  const cases = m.signatures(bytes);
  test('mate tagging follows the shipped million-point score encoding', () => {
    for (const score of [0, 29997, -40000, 998999]) assert.equal(m.mate(score), null);
    assert.deepEqual(m.mate(999997), { sign: 1, encodedScore: 999997, plies: 3 });
    assert.deepEqual(m.mate(-1000000), { sign: -1, encodedScore: -1000000, plies: 0 });
    assert.throws(() => m.mate(1000001), /invalid engine score/);
  });
  test('all 144 ABI-v2 signatures include replay-legal root PV evidence', () => {
    assert.equal(cases.length, 144); assert.ok(cases.some(x => x.rootAnalysis && x.rootAnalysis.pv.length > 1));
    assert.ok(cases.every(x => x.mate !== undefined && x.rootAnalysis !== undefined));
  });
  test('unchanged modules have 144 explicit empty diff records', () => {
    const result = m.diff(cases, m.signatures(bytes)); assert.equal(result.length, 144);
    assert.ok(result.every(x => !x.changes.length));
  });
  test('move score counters mate and PV changes are independently visible', () => {
    const changed = JSON.parse(JSON.stringify(cases));
    changed[0].result.move = 'a1a2'; changed[0].result.score++;
    changed[0].result.nodes++; changed[0].result.depth++;
    changed[0].mate = { sign: 1, encodedScore: 29997 };
    changed[0].rootAnalysis.pv = ['a1a2'];
    const fields = m.diff(cases, changed)[0].changes.map(x => x.field);
    for (const field of ['result.move', 'result.score', 'result.nodes', 'result.depth', 'mate', 'rootAnalysis.pv']) assert.ok(fields.includes(field), field);
  });
  test('missing cases, reordered IDs, and changed configurations fail', () => {
    assert.throws(() => m.diff(cases, cases.slice(1)));
    const changed = JSON.parse(JSON.stringify(cases)); changed[0].config.maxDepth++;
    assert.throws(() => m.diff(cases, changed), /case inventory mismatch/);
    changed[0] = changed[1]; assert.throws(() => m.diff(cases, changed), /case inventory mismatch/);
  });
  test('evidence path cannot escape or alias an old fixture', () => {
    for (const value of ['../x', m.LEGACY, 'test/fixtures/engine-signatures/wasm-v2-abc.json']) assert.throws(() => m.evidencePath(value));
  });
  fs.mkdirSync(path.join(tmp, path.dirname(m.ACTIVE)), { recursive: true });
  const manifest = fs.readFileSync(path.join(ROOT, m.ACTIVE));
  fs.writeFileSync(path.join(tmp, m.ACTIVE), manifest);
  test('legacy active contract verifies exact shipped module and 144 cases', () => assert.equal(m.verify(tmp).cases, 144));
  test('candidate cannot claim its own approval in a JSON field', () => {
    fs.writeFileSync(path.join(tmp, m.ACTIVE), JSON.stringify({ schema: 1, kind: 'reviewed-abi-v2', approved: true }));
    assert.throws(() => m.verify(tmp), /independently selected trusted base/);
    fs.writeFileSync(path.join(tmp, m.ACTIVE), manifest);
  });
  test('new candidate evidence absent from trusted base cannot activate', () => {
    const fake = Buffer.from('{}\n'), digest = m.sha(fake);
    const evidence = 'test/fixtures/engine-signatures/wasm-v2-' + digest + '.json';
    fs.writeFileSync(path.join(tmp, evidence), fake);
    assert.throws(() => m.trustedEvidence(tmp, BASE, { evidence, evidenceSha256: digest }));
  });
  test('prior-reviewed evidence can activate and remains verifiable afterward', () => {
    // A temporary repository commit models the independent evidence-review
    // merge. No production fixture or active pointer is written by this test.
    const identityFiles = ['test/engine-signatures-v2.js', 'experiments/wasm/bench.js', 'assets/wasm-engine.js', 'assets/engine.js', m.LEGACY];
    const record = m.source(tmp, BASE);
    const bundle = {
      schema: 2, protocol: m.VERSION, abi: 2,
      corpusSha256: m.sha(m.json(m.corpus())),
      generator: { commit: cp.execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim(), files: Object.fromEntries(identityFiles.map(file => [file, m.sha(fs.readFileSync(path.join(ROOT, file)))])) },
      toolchain: { rust: '1.97.1', rustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452', binaryen: 131, target: 'wasm32-unknown-unknown' },
      old: { source: record, buildSha256: [record.shippedWasmSha256, record.shippedWasmSha256], cases },
      new: { source: record, buildSha256: [record.shippedWasmSha256, record.shippedWasmSha256], cases },
      diff: m.diff(cases, cases)
    };
    const encoded = m.json(bundle), digest = m.sha(encoded);
    const evidence = 'test/fixtures/engine-signatures/wasm-v2-' + digest + '.json';
    fs.writeFileSync(path.join(tmp, evidence), encoded);
    git('add', m.ACTIVE, evidence); git('commit', '--quiet', '-m', 'simulate prior evidence review');
    const reviewedBase = git('rev-parse', 'HEAD');
    const pointer = { schema: 1, kind: 'reviewed-abi-v2', evidence, evidenceSha256: digest, sourceCommit: BASE, sourceRelease: 'r79', abi: 2 };
    fs.writeFileSync(path.join(tmp, m.ACTIVE), m.json(pointer));
    assert.equal(m.verify(tmp, reviewedBase).cases, 144);
    git('add', m.ACTIVE); git('commit', '--quiet', '-m', 'simulate later pointer review');
    assert.equal(m.verify(tmp, git('rev-parse', 'HEAD')).cases, 144);
    git('reset', '--hard', BASE);
    fs.mkdirSync(path.join(tmp, path.dirname(m.ACTIVE)), { recursive: true });
    fs.writeFileSync(path.join(tmp, m.ACTIVE), manifest);
  });
  test('changed runtime source is rejected even with identical binary', () => {
    fs.appendFileSync(path.join(tmp, 'experiments/wasm/src/eval.rs'), '\n// mutation\n');
    assert.throws(() => m.verify(tmp), /engine source changed/);
    git('checkout', '--', 'experiments/wasm/src/eval.rs');
  });
  test('changed module and immutable history fail closed', () => {
    fs.appendFileSync(path.join(tmp, 'assets/chessy-ai-fast.wasm'), Buffer.from([0]));
    assert.throws(() => m.verify(tmp), /module changed without reviewed rotation/);
    git('checkout', '--', 'assets/chessy-ai-fast.wasm');
    fs.appendFileSync(path.join(tmp, m.LEGACY), '\n');
    assert.throws(() => m.verify(tmp), /immutable r69 fixture changed/);
  });
  console.log(count + ' mechanism tests passed; no candidate activated');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
