#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Label = require('./label-stockfish');
const Stream = require('./hce-r3-pack-stream');

const contracts = Label.loadFrozenContracts();
const frozen = contracts.teacher;
let checks = 0;

function teacherRecord() {
  return {
    teacher: {
      id: frozen.id,
      release: frozen.engine.release,
      commit: frozen.engine.sourceCommit,
      manifestSha256: contracts.teacherSha256,
      nodes: frozen.search.nodeLimit,
      cpWhite: 25,
      wdlWhite: [500, 300, 200],
      targetWhite: 0.65,
      bestMoveUci: 'a2a3',
      pvUci: ['a2a3', 'a7a6'],
      depth: 15,
      seldepth: 22,
      scoreNodes: 61564,
      reportedNodes: 100054
    }
  };
}

function rejected(mutator) {
  const record = teacherRecord();
  mutator(record.teacher);
  assert.throws(
    () => Stream.exactTeacher(record, contracts),
    /frozen label contract/
  );
  checks++;
}

Stream.exactTeacher(teacherRecord(), contracts);
checks++;
rejected(teacher => { teacher.targetWhite = 0.66; });
rejected(teacher => { teacher.scoreNodes = teacher.reportedNodes + 1; });
rejected(teacher => {
  teacher.reportedNodes = frozen.search.nodeLimit - 1;
});
rejected(teacher => { teacher.scoreBound = 'upperbound'; });

const ids = ['f', '1', 'a', '0', '7'].map(value => value.repeat(64));
const heap = [];
for (const id of ids) Stream.heapPush(heap, { record: { id } });
const ordered = [];
while (heap.length) ordered.push(Stream.heapPop(heap).record.id);
assert.deepStrictEqual(ordered, ids.slice().sort());
checks++;

assert.deepStrictEqual(
  Stream.parseArgs([
    '--input', 'first.ndjson', '--input', 'second.ndjson',
    '--role', 'shared-train'
  ]),
  {
    input: ['first.ndjson', 'second.ndjson'],
    role: 'shared-train'
  }
);
checks++;

console.log(checks + ' HCE pack-stream contract checks passed');
