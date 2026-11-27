/*
 * Independently reproduce new, unapproved signature proposals in CI.
 *
 * This adds no approval authority. The production verifier still requires
 * evidence already present in its independently selected trusted base.
 * Usage: node test/engine-signature-proposal.js REPO TRUSTED_BASE_FULL_SHA
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const DIRECTORY = 'test/fixtures/engine-signatures';
const ACTIVE = DIRECTORY + '/active.json';
const GENERATOR = 'test/engine-signatures-v2.js';
const IMPLEMENTATION = [GENERATOR, 'experiments/wasm/bench.js',
  'assets/wasm-engine.js', 'assets/engine.js', 'test/fixtures/wasm-r69-signatures.json'];
const PRODUCTION = ['experiments/wasm/src', 'experiments/wasm/Cargo.toml',
  'experiments/wasm/Cargo.lock', 'experiments/wasm/rust-toolchain.toml',
  'experiments/wasm/build.sh', 'assets/chessy-ai-fast.wasm', ACTIVE];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const git = (root, args) => cp.execFileSync('git', ['--no-replace-objects', '-C', root, ...args],
  { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const blob = (root, ref, file) => git(root, ['show', ref + ':' + file]);

function commit(root, ref) {
  assert.match(ref || '', /^[0-9a-f]{40}$/, 'require full immutable commit SHA');
  assert.equal(git(root, ['rev-parse', ref + '^{commit}']).toString().trim(), ref);
  return ref;
}

function trackedClean(root) {
  // The WASM CI job downloads tools into untracked paths. Proposals are read
  // only from committed Git blobs; unchanged prepare runs in clean worktrees.
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).length, 0,
    'tracked source changed outside the reviewed commit');
}

function inspect(root, trustedBase) {
  root = fs.realpathSync(root);
  commit(root, trustedBase);
  trackedClean(root);
  const head = commit(root, git(root, ['rev-parse', 'HEAD']).toString().trim());
  git(root, ['merge-base', '--is-ancestor', trustedBase, head]);
  const changes = git(root, ['diff', '--no-renames', '--name-status', '-z', trustedBase, head, '--', DIRECTORY])
    .toString().split('\0');
  const proposals = [];
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index], file = changes[index + 1];
    if (!file.startsWith(DIRECTORY + '/wasm-v2-')) continue;
    assert.match(file, /^test\/fixtures\/engine-signatures\/wasm-v2-[0-9a-f]{64}\.json$/,
      'proposal filename must be content-addressed');
    assert.equal(status, 'A', 'previous signature evidence must remain unchanged');
    assert.match(git(root, ['ls-tree', head, '--', file]).toString(), /^100(644|755) blob /,
      'proposal must be an ordinary tracked file');
    const bytes = blob(root, head, file), digest = sha(bytes), bundle = JSON.parse(bytes);
    assert.equal(file, DIRECTORY + '/wasm-v2-' + digest + '.json', 'proposal filename digest differs');
    assert.equal(bundle.schema, 2); assert.equal(bundle.protocol, 'chessy-engine-signatures-v2.1');
    assert.equal(bundle.abi, 2);
    const generator = commit(root, bundle.generator.commit);
    // A commit supplied by the proposed candidate is not a reviewed generator.
    git(root, ['merge-base', '--is-ancestor', generator, trustedBase]);
    assert.deepEqual(Object.keys(bundle.generator.files).sort(), IMPLEMENTATION.slice().sort(),
      'unexpected generator input inventory');
    for (const input of IMPLEMENTATION) {
      const generatorBytes = blob(root, generator, input);
      assert.equal(sha(generatorBytes), bundle.generator.files[input], 'generator identity differs: ' + input);
      assert.deepEqual(generatorBytes, blob(root, trustedBase, input), 'generator differs from trusted base: ' + input);
    }
    for (const role of ['old', 'new']) {
      commit(root, bundle[role].source.commit);
      assert.equal(sha(blob(root, bundle[role].source.commit, 'assets/chessy-ai-fast.wasm')),
        bundle[role].source.shippedWasmSha256, role + ' source/module binding differs');
    }
    assert.equal(bundle.old.source.shippedWasmSha256,
      sha(blob(root, trustedBase, 'assets/chessy-ai-fast.wasm')), 'proposal does not start from trusted runtime');
    proposals.push({ file, bytes, sha256: digest, generator,
      oldCommit: bundle.old.source.commit, newCommit: bundle.new.source.commit });
  }
  if (proposals.length) {
    assert.equal(git(root, ['diff', '--name-only', trustedBase, head, '--', ...PRODUCTION]).length, 0,
      'an evidence-only proposal must retain production Rust/module/active pointer');
  }
  return { root, trustedBase, head, proposals };
}

function compareProposal(expected, reproduced) {
  assert.deepEqual(reproduced, expected, 'independent preparation did not reproduce exact proposal bytes');
}

function reproduce(root, trustedBase) {
  const inspected = inspect(root, trustedBase);
  const report = { schema: 'chessy.signature-proposal-reproduction.v1',
    authority: 'reproduction-only; no approval or production activation',
    productionIntegrationAllowed: false, trustedBase: inspected.trustedBase, head: inspected.head, proposals: [] };
  if (!inspected.proposals.length) return { ...report, status: 'no-new-proposal' };

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-proposal-reproduction-'));
  const worktrees = [];
  function checkout(name, ref) {
    const directory = path.join(temporary, name);
    git(inspected.root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', directory, ref]);
    worktrees.push(directory);
    assert.equal(git(directory, ['rev-parse', 'HEAD']).toString().trim(), ref);
    assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']).length, 0);
    return directory;
  }
  try {
    const source = checkout('source', inspected.head);
    for (const [index, proposal] of inspected.proposals.entries()) {
      const generator = checkout('generator-' + index, proposal.generator);
      const output = path.join(temporary, 'output-' + index);
      // The unchanged reviewed generator rebuilds old and new independently
      // twice each, replays all 144 cases/PVs and emits its original metadata.
      cp.execFileSync(process.execPath, [path.join(generator, GENERATOR), 'prepare', source,
        proposal.oldCommit, proposal.newCommit, output], {
        cwd: generator, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024
      });
      const complete = JSON.parse(fs.readFileSync(path.join(output, 'complete.json')));
      assert.equal(complete.status, 'unapproved-proposal');
      assert.equal(complete.bundle, path.basename(proposal.file));
      assert.equal(complete.sha256, proposal.sha256);
      const reproduced = fs.readFileSync(path.join(output, complete.bundle));
      assert.equal(sha(reproduced), complete.sha256);
      compareProposal(proposal.bytes, reproduced);
      report.proposals.push({ path: proposal.file, sha256: proposal.sha256, generatorCommit: proposal.generator,
        oldCommit: proposal.oldCommit, newCommit: proposal.newCommit, independentBuilds: 4, exactBytes: true });
    }
    trackedClean(inspected.root);
    assert.equal(git(inspected.root, ['rev-parse', 'HEAD']).toString().trim(), inspected.head,
      'source head changed during reproduction');
    return { ...report, status: 'reproduced' };
  } finally {
    for (const directory of worktrees.reverse()) git(inspected.root, ['worktree', 'remove', '--force', directory]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { IMPLEMENTATION, PRODUCTION, sha, inspect, compareProposal, reproduce };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 4, 'usage: engine-signature-proposal.js REPO TRUSTED_BASE_FULL_SHA');
    console.log(json(reproduce(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.stack || error);
    if (error.stdout) console.error(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    process.exitCode = 1;
  }
}
