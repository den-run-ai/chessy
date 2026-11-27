'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { prepare, SOURCE, ROOT, sha } = require('./prepare.js');
const { candidate } = require('./candidate.js');
const { snapshot, mirror } = require('./probe.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-tt-buckets-test-'));
try {
  const original = cp.execFileSync('git', ['--no-replace-objects', '-C', ROOT, 'show',
    SOURCE.baseCommit + ':experiments/wasm/src/search.rs']);
  const table = fs.readFileSync(path.join(__dirname, 'table.rs'));
  const tests = fs.readFileSync(path.join(__dirname, 'tests.rs'));
  const patched = candidate(original, table, tests);
  assert.notEqual(sha(patched), sha(original));
  assert.equal(sha(original), SOURCE.files['src/search.rs']);
  assert.throws(() => candidate(Buffer.concat([original, Buffer.from('\n')]), table, tests), /unknown Rust search source/);
  const before = original.toString().slice(0, original.toString().indexOf('#[inline]\nfn tt_start_index'));
  assert.ok(patched.toString().startsWith(before), 'only the declared TT span may change before check_budget');
  assert.equal(patched.toString().includes('while offset < TT_BUCKET_SIZE'), true);
  const output = path.join(scratch, 'prepared');
  const registration = prepare(output);
  assert.equal(registration.candidateSearchSha256, sha(patched));
  for (const mode of ['baseline', 'candidate']) for (const file of Object.keys(SOURCE.files)) {
    assert.equal(fs.statSync(path.join(output, mode, file)).mode & 0o222, 0, 'sources are read-only');
  }
  assert.throws(() => prepare(output), /EEXIST/);
  assert.throws(() => prepare(path.join(ROOT, 'unwanted-generated-probe')), /outside the repository/);
  assert.throws(() => snapshot(output), /ENOENT/, 'unbuilt snapshots cannot be measured');
  // A forged prebuilt module cannot bypass byte reproduction of the baseline.
  for (const mode of ['baseline', 'candidate']) {
    fs.mkdirSync(path.join(output, mode, 'dist'));
    fs.writeFileSync(path.join(output, mode, 'dist/chessy-ai-fast.wasm'), 'not a module');
  }
  assert.throws(() => snapshot(output), /baseline did not reproduce/);
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  assert.equal(mirror(mirror(fen)), fen);
  console.log('TT prototype preparation/hash/snapshot guards passed');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
