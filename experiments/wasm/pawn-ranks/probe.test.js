'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { candidate } = require('./candidate.js');
const { prepare, ROOT, SOURCE, sha } = require('./prepare.js');
const { summarize } = require('./measure.js');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-pawn-ranks-test-'));
try {
  const output = path.join(temporary, 'prepared');
  const registration = prepare(output);
  assert.throws(() => prepare(output), /EEXIST/);
  assert.throws(() => prepare(path.join(ROOT, 'forbidden-generated-output')), /outside the repository/);
  for (const [file, hash] of Object.entries(SOURCE.files)) {
    assert.equal(sha(fs.readFileSync(path.join(output, 'baseline', file))), hash);
  }
  const original = fs.readFileSync(path.join(output, 'baseline/src/eval.rs'));
  const tests = fs.readFileSync(path.join(__dirname, 'tests.rs'));
  assert.equal(sha(candidate(original, tests)), registration.candidateEvalSha256);
  assert.throws(() => candidate(Buffer.concat([original, Buffer.from('\n')]), tests), /unknown evaluator source/);
  assert.throws(() => candidate(original, Buffer.from('missing baseline reference')), /strictly equal/);
  console.log('ok: exact verified source snapshots, evaluator hash guard, exclusive output');

  const protocol = { fixedNodeLimits: [10000], fixedNodeRepetitions: 4,
    positions: ['opening', 'middlegame', 'endgame'].map(phase => ({ name: phase, phase })),
    masterRouting: { budget: 10000, geomeanMinimum: 1.02, eachPhaseMedianMinimum: 1 } };
  const ratios = [[1, 1, 9, 9], [2, 2, 2, 2], [0.5, 0.5, 0.5, 0.5]];
  const rows = protocol.positions.flatMap((position, index) => ratios[index].flatMap((ratio, repeat) => [
    { position: position.name, repeat, nodeLimit: 10000, engine: 'baseline', elapsedMs: 10 * ratio, result: { nodes: 10000 } },
    { position: position.name, repeat, nodeLimit: 10000, engine: 'candidate', elapsedMs: 10, result: { nodes: 10000 } }
  ]));
  const summary = summarize(rows, protocol);
  assert.deepEqual(summary.byBudget[10000].positions.map(item => item.medianRatio), [5, 2, 0.5]);
  assert.ok(Math.abs(summary.byBudget[10000].geomeanRatio - Math.cbrt(5)) < 1e-12);
  assert.equal(summary.masterRoute, false, 'a phase regression blocks the conditional followup');
  assert.equal(summary.allSearchesConsumeDeclaredNodeLimit, true);
  rows[1].result.nodes--;
  assert.throws(() => summarize(rows, protocol), /complete signature/);
  console.log('ok: position-median aggregation, phase routing, complete timed-signature guard');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
