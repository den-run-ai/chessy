'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const helper = require('./engine-signature-proposal.js');

// Synthetic Git objects exercise admission-independent preflight. They are
// never compiled, searched, published, or presented as real engine evidence.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-proposal-guards-'));
const git = (...args) => cp.execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (file, bytes) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); };
const save = message => { git('add', '--all'); git('commit', '--quiet', '-m', message); return git('rev-parse', 'HEAD'); };
const readAt = (ref, file) => cp.execFileSync('git', ['-C', root, 'show', ref + ':' + file]);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
let count = 0;
function test(name, run) { run(); count++; console.log('ok ' + name); }
try {
  git('init', '--quiet'); git('config', 'user.name', 'Proposal guard fixture'); git('config', 'user.email', 'fixture@invalid.example');
  for (const file of helper.IMPLEMENTATION) write(file, 'fixture ' + file + '\n');
  for (const file of helper.PRODUCTION) if (!file.endsWith('/src')) write(file, 'fixture ' + file + '\n');
  write('experiments/wasm/src/search.rs', '// baseline fixture\n');
  write('test/fixtures/engine-signatures/active.json', json({ schema: 1, kind: 'legacy-r69-behavior' }));
  const base = save('reviewed baseline fixture');
  write('experiments/wasm/src/search.rs', '// candidate fixture\n');
  write('assets/chessy-ai-fast.wasm', 'candidate module fixture\n');
  const candidate = save('unapproved candidate fixture');
  const reset = (ref = base) => git('reset', '--hard', ref);
  const bundle = (generator = base) => ({ schema: 2, protocol: 'chessy-engine-signatures-v2.1', abi: 2,
    generator: { commit: generator, files: Object.fromEntries(helper.IMPLEMENTATION.map(file => [file, helper.sha(readAt(generator, file))])) },
    old: { source: { commit: base, shippedWasmSha256: helper.sha(readAt(base, 'assets/chessy-ai-fast.wasm')) } },
    new: { source: { commit: candidate, shippedWasmSha256: helper.sha(readAt(candidate, 'assets/chessy-ai-fast.wasm')) } } });
  function publish(value = bundle(), filename) {
    const bytes = json(value);
    const file = filename || 'test/fixtures/engine-signatures/wasm-v2-' + helper.sha(bytes) + '.json';
    write(file, bytes); const commit = save('unapproved proposal fixture'); return { file, bytes, commit };
  }
  reset();
  test('no new proposal exits without generator worktrees or builds', () => {
    const before = git('worktree', 'list', '--porcelain');
    const report = helper.reproduce(root, base);
    assert.equal(report.status, 'no-new-proposal'); assert.equal(report.productionIntegrationAllowed, false);
    assert.deepEqual(report.proposals, []); assert.equal(git('worktree', 'list', '--porcelain'), before);
  });
  test('full immutable independently supplied base is required', () => {
    for (const alias of ['HEAD', base.slice(0, 12)]) assert.throws(() => helper.inspect(root, alias), /full immutable/);
  });
  test('new proposal reads committed bytes and allows untracked CI tools', () => {
    const proposal = publish(); write('downloaded-tool.tmp', 'not a tracked input');
    const inspected = helper.inspect(root, base);
    assert.equal(inspected.proposals.length, 1);
    assert.deepEqual(inspected.proposals[0].bytes, proposal.bytes);
    assert.equal(inspected.proposals[0].generator, base);
    fs.unlinkSync(path.join(root, 'downloaded-tool.tmp'));
  });
  test('tracked modifications cannot replace the committed proposal', () => {
    write('experiments/wasm/src/search.rs', '// uncommitted mutation\n');
    assert.throws(() => helper.inspect(root, base), /tracked source changed/); reset();
  });
  test('a candidate-authored generator is not a reviewed base ancestor', () => {
    // Identical generator bytes are insufficient if its claimed commit was
    // never in the reviewed base; this isolates the ancestry guard itself.
    write('candidate-only-note.txt', 'unreviewed commit with identical generator bytes\n');
    const unreviewed = save('candidate generator fixture'); reset(); publish(bundle(unreviewed));
    assert.throws(() => helper.inspect(root, base)); reset();
  });
  test('a stale generator cannot ignore a reviewed loader change', () => {
    write('assets/wasm-engine.js', '// later reviewed loader\n');
    const laterBase = save('later reviewed loader fixture'); publish();
    assert.throws(() => helper.inspect(root, laterBase), /generator differs from trusted base/); reset();
  });
  test('generator identity inventory and hashes are exact', () => {
    const altered = bundle(); altered.generator.files['assets/engine.js'] = '0'.repeat(64); publish(altered);
    assert.throws(() => helper.inspect(root, base), /generator identity differs/); reset();
    const missing = bundle(); delete missing.generator.files['assets/engine.js']; publish(missing);
    assert.throws(() => helper.inspect(root, base), /input inventory/); reset();
  });
  test('source commits must exist and match their declared module', () => {
    const absent = bundle(); absent.new.source.commit = 'f'.repeat(40); publish(absent);
    assert.throws(() => helper.inspect(root, base)); reset();
    const changed = bundle(); changed.new.source.shippedWasmSha256 = '0'.repeat(64); publish(changed);
    assert.throws(() => helper.inspect(root, base), /source\/module binding differs/); reset();
  });
  test('a later proposal binds the already rotated runtime, not the original module', () => {
    reset(candidate);
    const prior = publish();
    write('test/fixtures/engine-signatures/active.json', json({ schema: 1, kind: 'reviewed-abi-v2',
      evidence: prior.file, evidenceSha256: helper.sha(prior.bytes), sourceCommit: candidate, sourceRelease: 'r85', abi: 2 }));
    const rotatedBase = save('synthetic already rotated baseline');
    write('experiments/wasm/src/search.rs', '// second candidate fixture\n');
    write('assets/chessy-ai-fast.wasm', 'second candidate module fixture\n');
    const next = save('second unapproved source fixture');
    reset(rotatedBase);
    const subsequent = bundle();
    subsequent.old.source = { commit: rotatedBase,
      shippedWasmSha256: helper.sha(readAt(rotatedBase, 'assets/chessy-ai-fast.wasm')) };
    subsequent.new.source = { commit: next,
      shippedWasmSha256: helper.sha(readAt(next, 'assets/chessy-ai-fast.wasm')) };
    publish(subsequent);
    const inspected = helper.inspect(root, rotatedBase);
    assert.equal(inspected.proposals.length, 1);
    assert.equal(inspected.proposals[0].oldCommit, rotatedBase);
    assert.equal(inspected.proposals[0].newCommit, next);
    reset(rotatedBase);
    const stale = bundle(); stale.new.source = subsequent.new.source; publish(stale);
    assert.throws(() => helper.inspect(root, rotatedBase), /does not start from trusted runtime/);
    reset();
  });
  test('evidence-only PR cannot change production source, module or active pointer', () => {
    for (const file of ['experiments/wasm/src/search.rs', 'assets/chessy-ai-fast.wasm', 'test/fixtures/engine-signatures/active.json']) {
      publish(); write(file, 'activation mutation'); save('not evidence-only');
      assert.throws(() => helper.inspect(root, base), /evidence-only proposal must retain/); reset();
    }
  });
  test('content-addressed filename binds the exact proposal bytes', () => {
    publish(bundle(), 'test/fixtures/engine-signatures/wasm-v2-' + '0'.repeat(64) + '.json');
    assert.throws(() => helper.inspect(root, base), /filename digest differs/); reset();
    publish(bundle(), 'test/fixtures/engine-signatures/wasm-v2-short.json');
    assert.throws(() => helper.inspect(root, base), /content-addressed/); reset();
  });
  test('proposal symlinks are rejected before parsing or executing anything', () => {
    const proposed = publish(); fs.unlinkSync(path.join(root, proposed.file));
    // Git stores the link target as its blob. Retain the exact valid JSON blob
    // to ensure the regular-file guard, rather than JSON parsing, rejects it.
    fs.symlinkSync(proposed.bytes.toString(), path.join(root, proposed.file)); save('symlink mutation');
    assert.throws(() => helper.inspect(root, base), /ordinary tracked file/); reset();
  });
  test('previous proposals cannot be edited or deleted', () => {
    const original = publish(); write(original.file, '{}\n'); save('edited evidence');
    assert.throws(() => helper.inspect(root, original.commit), /previous signature evidence/);
    reset(original.commit); fs.unlinkSync(path.join(root, original.file)); save('deleted evidence');
    assert.throws(() => helper.inspect(root, original.commit), /previous signature evidence/); reset();
  });
  test('comparison rejects any independently regenerated byte difference', () => {
    const expected = json({ cases: [{ nodes: 1 }], authority: 'proposal-only' });
    helper.compareProposal(expected, Buffer.from(expected));
    assert.throws(() => helper.compareProposal(expected, json({ cases: [{ nodes: 2 }], authority: 'proposal-only' })), /exact proposal bytes/);
    assert.throws(() => helper.compareProposal(expected, Buffer.concat([expected, Buffer.from('\n')])), /exact proposal bytes/);
  });
  console.log(count + ' proposal preflight/comparison tests passed; no engine builds or activation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
