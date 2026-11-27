'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { candidate, sha } = require('./candidate.js');
const SOURCE = JSON.parse(fs.readFileSync(path.join(__dirname, 'source.json')));
const ROOT = path.resolve(__dirname, '../../..');
function git(root, args) {
  return cp.execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
}
function prepare(output, root = ROOT) {
  assert.ok(path.isAbsolute(output), 'use an absolute new output directory');
  const actualOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const actualRoot = fs.realpathSync(root);
  assert.ok(actualOutput !== actualRoot && !actualOutput.startsWith(actualRoot + path.sep),
    'generated files must stay outside the repository');
  const files = Object.keys(SOURCE.files);
  const tree = git(root, ['ls-tree', '-r', SOURCE.baseCommit, '--', 'experiments/wasm/src/'])
    .toString().trim().split('\n');
  assert.deepEqual(tree.map(x => x.split('\t')[1].replace('experiments/wasm/', '')).sort(),
    files.filter(x => x.startsWith('src/')).sort(), 'complete Rust inventory changed');
  const retained = Object.fromEntries(files.map(file => {
    const bytes = git(root, ['show', SOURCE.baseCommit + ':experiments/wasm/' + file]);
    assert.equal(sha(bytes), SOURCE.files[file], 'pinned source differs: ' + file);
    return [file, bytes];
  }));
  const table = fs.readFileSync(path.join(__dirname, 'table.rs'));
  const tests = fs.readFileSync(path.join(__dirname, 'tests.rs'));
  const patched = candidate(retained['src/search.rs'], table, tests);
  const shipped = git(root, ['show', SOURCE.baseCommit + ':assets/chessy-ai-fast.wasm']);
  assert.equal(sha(shipped), SOURCE.shippedWasmSha256);
  fs.mkdirSync(output); // Exclusive ownership: never reuse a measurement directory.
  for (const mode of ['baseline', 'candidate']) {
    for (const [file, bytes] of Object.entries(retained)) {
      const target = path.join(output, mode, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mode === 'candidate' && file === 'src/search.rs' ? patched : bytes,
        { flag: 'wx', mode: 0o444 });
    }
  }
  fs.writeFileSync(path.join(output, 'shipped.wasm'), shipped, { flag: 'wx', mode: 0o444 });
  // Execute the exact retained loaders, never path-reopen an unverified module.
  const harness = {};
  for (const name of ['engine.js', 'wasm-engine.js']) {
    const bytes = git(root, ['show', SOURCE.baseCommit + ':assets/' + name]);
    fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o444 });
    harness[name] = sha(bytes);
  }
  const registration = { source: SOURCE, candidateSearchSha256: sha(patched),
    tableSha256: sha(table), testsSha256: sha(tests), harness };
  fs.writeFileSync(path.join(output, 'source-registration.json'), JSON.stringify(registration, null, 2) + '\n', { flag: 'wx' });
  return registration;
}
module.exports = { prepare, SOURCE, ROOT, sha };
if (require.main === module) console.log(JSON.stringify(prepare(path.resolve(process.argv[2])), null, 2));
