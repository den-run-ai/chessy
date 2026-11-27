/* CI adapter: reproduce the recorded correctness checks, never repeat timings. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { performance } = require('perf_hooks');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const evidence = path.join(__dirname, 'results/run-v1');
const registrationBytes = fs.readFileSync(path.join(evidence, 'measurement-registration.json'));
const registration = JSON.parse(registrationBytes);
const report = JSON.parse(fs.readFileSync(path.join(evidence, 'report.json')));
assert.equal(sha(registrationBytes), report.registrationSha256);
assert.equal(report.status, 'complete');
for (const [file, digest] of Object.entries(registration.implementationSha256)) {
  assert.equal(sha(fs.readFileSync(path.join(__dirname, file))), digest,
    'recorded measurement implementation changed: ' + file);
}
const recorded = require('./probe.js');
const directory = process.argv[2];
if (!directory) throw Error('usage: validate.js ABS_BUILT_SNAPSHOT_DIRECTORY');
const frozen = recorded.snapshot(path.resolve(directory));
for (const [name, bytes] of Object.entries(frozen.modules)) {
  assert.equal(sha(bytes), registration.modules[name], name + ' is not the recorded candidate build');
}
const context = { WebAssembly, TextEncoder, performance, console, module: { exports: {} } };
vm.createContext(context);
vm.runInContext(frozen.scripts['engine.js'].toString(), context);
vm.runInContext(frozen.scripts['wasm-engine.js'].toString(), context);
const Wasm = context.module.exports;
const engines = Object.fromEntries(Object.entries(frozen.modules).map(([name, bytes]) => [name, Wasm.loadSync(bytes)]));
for (const engine of Object.values(engines)) assert.equal(engine.memoryBytes(), 26542080);
const protocol = registration.protocol;
const positions = protocol.families.flatMap(([name, fen]) => [[name, fen], [name + ' mirrored', recorded.mirror(fen)]]);
const result = recorded.verify(engines, Wasm.loadSync(frozen.modules.baseline), context.Chess, protocol, positions);
assert.deepEqual(result, report.correctness);
console.log('Recorded TT correctness reproduced; no timings run:', JSON.stringify(result));
