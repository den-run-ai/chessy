/* Post-run CI verifier. This file was not part of the measured implementation. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { snapshot, sha } = require('./validate.js');
const { summarize } = require('./measure.js');
const evidence = path.join(__dirname, 'results/run-v1');
const read = (directory, file) => fs.readFileSync(path.join(directory, file));
const parse = (directory, file) => JSON.parse(read(directory, file));
const registrationBytes = read(evidence, 'measurement-registration.json');
const registration = JSON.parse(registrationBytes);
for (const [file, digest] of Object.entries(parse(evidence, 'files.json'))) {
  assert.equal(sha(read(evidence, file)), digest, 'retained evidence changed: ' + file);
}
for (const [file, digest] of Object.entries(registration.implementationSha256)) {
  assert.equal(sha(read(__dirname, file)), digest, 'measured implementation changed: ' + file);
}
const report = parse(evidence, 'report.json');
assert.equal(report.status, 'complete');
assert.equal(report.registrationSha256, sha(registrationBytes));
assert.equal(report.correctnessSha256, sha(read(evidence, 'measured-correctness.json')));
assert.equal(report.fixedNodes.length, 432);
assert.equal(report.warmups.length, 72);
const summary = summarize(report.fixedNodes, registration.protocol);
for (const [budget, item] of Object.entries(summary.byBudget)) {
  assert.ok(Math.abs(item.geomeanRatio - report.fixedNodeSummary.byBudget[budget].geomeanRatio) < 1e-12);
  assert.deepEqual(item.phaseMedians, report.fixedNodeSummary.byBudget[budget].phaseMedians);
}
assert.equal(summary.masterRoute, report.masterRouting.run);
assert.equal(report.master.length, report.masterRouting.run ? 8 : 0);
if (process.argv[2]) {
  const output = path.resolve(process.argv[2]);
  const built = snapshot(output);
  assert.deepEqual(built.registration, registration.source, 'fresh source differs from measured source');
  for (const [mode, bytes] of Object.entries(built.modules)) {
    assert.equal(sha(bytes), registration.modules[mode], 'fresh module differs from published measurement: ' + mode);
  }
  assert.deepEqual(parse(output, 'correctness.json'), parse(evidence, 'measured-correctness.json'),
    'fresh correctness observations differ from published evidence');
}
console.log('Pawn-rank evidence verified; measured candidate SHA-256 ' + registration.modules.candidate);
