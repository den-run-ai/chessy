#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const screen = require('./level-screen.js');
const directory = path.resolve(__dirname, '../../eval/easy-depth-screen-2026-09-25');
const entry = path.join(directory, 'verify.js');
const { verify, validateIdentities } = require(entry);
const files = ['control-depth2.ndjson', 'candidate-depth1.ndjson'];
const expected = JSON.parse(fs.readFileSync(path.join(directory, 'analysis.json'), 'utf8'));
const actual = verify(...files.map(file => path.join(directory, file)));
assert.deepEqual(actual, expected, 'verified regeneration preserves every registered result');

// Mutate the actual sealed report, independently of the validator's key list.
// Mutating both blocks together catches a gate that only compares them with
// each other instead of enforcing the exact preregistered input identities.
const fields = ['schema', 'level', 'anchor', 'openings', 'concurrency',
  'stockfishSha256', 'wasmSha256', 'loaderSha256', 'rulesSha256',
  'presetsSha256', 'bridgeSha256', 'openingsSha256', 'openingProtocolSha256',
  'runnerSha256', 'host.node', 'host.cpu', 'host.cpus', 'host.os',
  'host.release', 'host.arch'];
let mutations = 0;
for (const field of fields) {
  for (const roles of [['control'], ['candidate'], ['control', 'candidate']]) {
    const changed = JSON.parse(JSON.stringify(actual));
    for (const role of roles) {
      const keys = field.split('.');
      const key = keys.pop();
      let owner = changed[role].receipt.identity;
      for (const parent of keys) owner = owner[parent];
      owner[key] = typeof owner[key] === 'number' ? owner[key] + 1 : 'changed';
    }
    assert.throws(() => validateIdentities(changed), /preregistered inputs/,
      roles.join('+') + ':' + field);
    mutations++;
  }
}
for (const role of ['control', 'candidate']) {
  for (const mutate of [
    receipt => { delete receipt.identity.runnerSha256; },
    receipt => { receipt.identity.extraInput = 'unregistered'; },
    receipt => { receipt.identityComplete = false; }
  ]) {
    const changed = JSON.parse(JSON.stringify(actual));
    mutate(changed[role].receipt);
    assert.throws(() => validateIdentities(changed));
    mutations++;
  }
}

// End-to-end reproduction of the review finding: the blocks are individually
// valid and sealed, and agree with each other, but use an unregistered runner.
// The public entrypoint must reject them without publishing any JSON.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-easy-identities-'));
try {
  for (const file of files) {
    const out = path.join(temporary, file);
    fs.copyFileSync(path.join(directory, file), out);
    const header = JSON.parse(fs.readFileSync(path.join(directory, file + '.runs'), 'utf8'));
    header.runnerSha256 = '0'.repeat(64);
    fs.writeFileSync(out + '.runs', JSON.stringify(header) + '\n');
    screen.sealBlock(out, screen.sourceOpenings(), 'runner');
  }
  const rejected = cp.spawnSync(process.execPath,
    [entry, ...files.map(file => path.join(temporary, file))],
    { encoding: 'utf8', timeout: 60000 });
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '', 'mismatched inputs must publish no result');
  assert.match(rejected.stderr, /preregistered inputs/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('easy-depth verification: regeneration, ' + mutations +
  ' identity mutations, and sealed-block rejection passed');
