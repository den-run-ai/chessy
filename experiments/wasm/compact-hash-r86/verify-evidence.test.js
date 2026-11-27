'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const gate = require('./verify-evidence.js');
const retained = gate.capture(), clone = value => JSON.parse(JSON.stringify(value));
const identityBytes = fs.readFileSync(path.join(__dirname, 'evidence/identity.json'));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
function mutable() {
  return { ...retained, ...Object.fromEntries(['identity', 'protocol', 'fixture', 'source', 'validation', 'registration', 'report', 'storedSummary', 'journal']
    .map(key => [key, clone(retained[key])])) };
}
function coherentRow(data, stage, index, change) {
  const row = data.report[stage][index]; change(row);
  const original = data.journal.filter(r => r.stage === stage)[index];
  data.journal[data.journal.indexOf(original)] = { stage, ...clone(row) };
}
function rejects(name, change, pattern) {
  test(name, () => { const data = mutable(); change(data); assert.throws(() => gate.inspect(data), pattern); });
}
test('all 672 actual rows and independent summary arithmetic pass', () => {
  const result = gate.inspect(retained);
  assert.equal(result.journalRows, 672); assert.equal(result.pairedFixedSearches, 280);
  assert.equal(result.fixedCapsFullyUsed, true); assert.equal(result.masterSearches, 8);
  assert.equal(result.timingRepeated, false);
});
test('a coherently rewritten identity cannot relabel measured evidence', () => {
  const changed = JSON.parse(identityBytes); changed.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => gate.authenticate(Buffer.from(JSON.stringify(changed)), p => retained.bytes[p]), /evidence identity changed/);
});
for (const file of ['protocol.json', 'measure.js', 'validate.js', 'evidence/source.json', 'evidence/validation.json',
  'evidence/registration.json', 'evidence/measurement.json', 'evidence/rows.jsonl']) {
  test('rejects changed captured bytes: ' + file, () => {
    assert.throws(() => gate.authenticate(identityBytes, p => p === file ? Buffer.concat([retained.bytes[p], Buffer.from(' ')]) : retained.bytes[p]), /evidence (byte count|hash)/);
  });
}
rejects('dropped report and journal row fails the complete schedule', data => {
  data.report.fixed.shift(); data.journal.splice(data.journal.findIndex(r => r.stage === 'fixed'), 1);
}, /complete fixed schedule/);
rejects('coherent duplicate-engine row fails balanced execution order', data => {
  coherentRow(data, 'fixed', 0, row => { row.engine = 1; });
}, /row schedule/);
rejects('an altered journal cannot disagree with the retained report', data => {
  data.journal[0].elapsedMs += 1;
}, /journal\/report row identity/);
rejects('a changed paired result fails even when the journal agrees', data => {
  coherentRow(data, 'fixed', 1, row => { row.result.qnodes++; });
}, /paired complete result/);
rejects('a paired underfilled cap cannot support the full-cap claim', data => {
  for (const index of [0, 1]) coherentRow(data, 'fixed', index, row => { row.result.nodes--; });
}, /full declared cap/);
rejects('a coherent illegal move pair is rejected by independent rules', data => {
  for (const index of [0, 1]) coherentRow(data, 'fixed', index, row => { row.result.move = { from: 0, to: 0, promotion: null }; });
}, /move must be legal/);
rejects('renamed seeded export cannot pass the preflight receipt', data => {
  data.validation.seededRows[0].exports[0].name = 'search';
}, /observed seeded export/);
rejects('seed forwarding must preserve the actual u32', data => {
  data.validation.seededRows[0].exports[0].args[4] = 2;
}, /observed seeded export/);
rejects('a timed row cannot be relabeled with another seed', data => {
  coherentRow(data, 'seeded', 0, row => { row.rootSeed = 2; });
});
rejects('a paired seeded result must match the export-traced preflight', data => {
  for (const index of [0, 1]) coherentRow(data, 'seeded', index, row => { row.result.score++; });
}, /export preflight/);
rejects('rewritten report and standalone summaries fail independent arithmetic', data => {
  data.report.summary.budgets[230000].geomeanRatio += 0.01;
  data.storedSummary = clone(data.report.summary);
}, /summary arithmetic/);
rejects('Master routing cannot be rewritten to discard declared follow-up rows', data => {
  data.report.summary.masterRoute = false; data.storedSummary = clone(data.report.summary);
  data.report.master = []; data.journal = data.journal.filter(r => r.stage !== 'master');
}, /summary arithmetic/);
rejects('extra timed Master rows cannot be admitted', data => {
  data.report.master.push(clone(data.report.master[0])); data.journal.push({ stage: 'master', ...clone(data.report.master[0]) });
}, /prospectively routed Master/);
rejects('the stated unchanged Master completed result must hold', data => {
  coherentRow(data, 'master', 1, row => { row.result.depth++; });
}, /Master completed result/);
rejects('a failed measurement cannot be presented as complete', data => { data.report.status = 'failed'; });
console.log(checks + ' committed-evidence checks passed; no timing or search executed');
