#!/usr/bin/env node
'use strict';
// This integration uses the already measured checked hash recipe on the exact
// seeded r85 source. Historical recipes and receipts remain unchanged.
if (typeof __seededHashPrepare === 'undefined') {
  const fs = require('node:fs'), path = require('node:path');
  const captured = [__filename, path.join(__dirname, 'seeded-parity.rs.in')]
    .map(file => ({ file, bytes: Buffer.from(fs.readFileSync(file)) }));
  require('node:vm').compileFunction(captured[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__seededHashPrepare'], { filename: __filename })
    (require, module, module.exports, __filename, __dirname, captured);
} else {
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const BASE = '3b32d2e7c23341d2245003c5324aa2ee6d07aa08';
const FILES = {
  'Cargo.toml': 'ce1d19882ccb2f19397ff0d35de49186a5e95b8fbe55764688479c32b86aec1c',
  'Cargo.lock': 'ea3c9270c862d324c05b5154683a064b19a165d69b38c905506e479de19a5a32',
  'rust-toolchain.toml': '9cbeb062ec3a97a5b5b76aacde94f5dcb034ed98f32af151480764de2e03d6f9',
  'build.sh': '68852d6684eb69c2dc6fd59947f6e88450aa298fb13be96d48f09e6c79612489',
  'src/engine.rs': '7bd7126c39fad50fe4fa7527fe857996391e46378491a21171b3928cf3d60103',
  'src/eval.rs': '3a107218a6d7a42f771022956fab04b28935a39867b74eaea911d27b2598a6b7',
  'src/lib.rs': 'c05fa66c239fdf4e38bf4912cd1491be1c57146b0670e71a340af8e586e8cd15',
  'src/search.rs': '9f8f2a798c26e7c4ff22cbc8b4605ed72fd17eadfc8bf9305747bf7ec40194b5'
};
const RECIPE = {
  'prepare.js': 'f2897609873e707ed67561e77d932b61db5fdb833305e128628114dcb2251277',
  'paired-hash.rs.in': 'e3740877481dcfcbad9b984da9661790ffb6d34f9d72b923760e395ea503ade7',
  'parity.rs.in': '6cafc8b53351d4f55e246ce1bf8a242c4c87c3845f2772a61ca55cd9be9ad386'
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function git(args) {
  return cp.execFileSync('git', ['--no-replace-objects', ...args], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
}
function capture() {
  const tracked = git(['ls-tree', '-r', '--name-only', BASE, '--', 'experiments/wasm/src/'])
    .toString().trim().split('\n').map(p => p.replace(/^experiments\/wasm\//, '')).sort();
  assert.deepEqual(tracked, Object.keys(FILES).filter(p => p.startsWith('src/')).sort(), 'unexpected source inventory');
  const source = Object.fromEntries(Object.entries(FILES).map(([p, digest]) => {
    const bytes = git(['show', BASE + ':experiments/wasm/' + p]);
    assert.equal(sha(bytes), digest, 'pinned source changed: ' + p);
    return [p, bytes];
  }));
  const recipe = Object.entries(RECIPE).map(([name, digest]) => {
    const bytes = git(['show', BASE + ':experiments/wasm/compact-hash/' + name]);
    assert.equal(sha(bytes), digest, 'pinned checked recipe changed: ' + name);
    return { name, file: path.join(ROOT, 'experiments/wasm/compact-hash', name), bytes };
  });
  const helper = { exports: {} };
  vm.compileFunction(recipe[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__capturedCompactHash'],
    { filename: 'pinned-compact-hash-generator.js' })(require, helper, helper.exports,
      recipe[0].file, path.dirname(recipe[0].file), recipe);
  const implementation = __seededHashPrepare[0].bytes;
  const parity = __seededHashPrepare[1].bytes;
  const generated = { ...source, 'src/search.rs': Buffer.from(
    helper.exports.render(source['src/search.rs'].toString(), 'threaded') + parity.toString()) };
  const receipt = {
    schema: 'chessy.compact-hash-r86.source.v1', baseCommit: BASE, variant: 'threaded',
    purpose: 'Checked compact hashing integrated with unchanged r85 seeded root ordering',
    timingPerformed: false, strengthClaimAllowed: false, universalEquivalenceProven: false,
    source: Object.entries(source).map(([p, bytes]) => ({ path: p, sha256: sha(bytes) })),
    generated: Object.entries(generated).map(([p, bytes]) => ({ path: p, sha256: sha(bytes) })),
    historicalRecipe: recipe.map(f => ({ path: f.name, sha256: sha(f.bytes) })),
    implementation: [{ path: 'prepare.js', sha256: sha(implementation) }, { path: 'seeded-parity.rs.in', sha256: sha(parity) }]
  };
  return { source, generated, receipt };
}
function prepare(destination) {
  destination = path.resolve(destination);
  destination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  assert.ok(destination !== ROOT && !destination.startsWith(ROOT + path.sep), 'output must be outside repository');
  const result = capture();
  fs.mkdirSync(destination);
  fs.mkdirSync(path.join(destination, 'src'));
  for (const [p, bytes] of Object.entries(result.generated)) fs.writeFileSync(path.join(destination, p), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(destination, 'source.json'), JSON.stringify(result.receipt, null, 2) + '\n', { flag: 'wx' });
  return result.receipt;
}
module.exports = { capture, prepare, BASE, ROOT, FILES, sha };
if (require.main === module) {
  assert.equal(process.argv.length, 3, 'usage: node prepare.js NEW_CRATE_OUTSIDE_REPOSITORY');
  console.log(JSON.stringify(prepare(process.argv[2]), null, 2));
}
}
