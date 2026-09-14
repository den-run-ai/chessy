#!/usr/bin/env node
'use strict';

// Independent synthetic transcripts exercise the admission trust boundary.
// These fixtures authenticate internal consistency, not a real teacher run.
const assert = require('assert');
const path = require('path');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');
const Evidence = require('./teacher-evidence');

const contracts = Label.loadFrozenContracts();
const snapshotSha256 = '1'.repeat(64);
const fens = [
  '8/8/8/8/8/8/P6p/K6k w - -',
  '4k3/3p4/8/4P3/8/8/8/4K3 b - -',
  '7k/8/8/8/8/8/P7/K7 w - -'
];
let checks = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function rowsText(rows) {
  return rows.slice().sort((a, b) => a.id.localeCompare(b.id))
    .map(record => Prepare.stableJson(record) + '\n').join('');
}
function selection(fen) {
  return Corpus.adaptLichessRecord({
    fen, evals: [{ depth: 24, knodes: 100,
      pvs: [{ cp: 25, line: 'a2a3 a7a6' }] }]
  }, { sha256: snapshotSha256 });
}
function header() {
  return [
    '> uci', '< id name Stockfish 18', '< uciok',
    '> setoption name Threads value 1',
    '> setoption name Hash value 64',
    '> setoption name Ponder value false',
    '> setoption name MultiPV value 1',
    '> setoption name SyzygyPath value <empty>',
    '> setoption name UCI_LimitStrength value false',
    '> setoption name UCI_ShowWDL value true',
    '> isready', '< readyok'
  ];
}
function searchLines(record, mate) {
  return [
    '> ucinewgame', '> setoption name Clear Hash',
    '> isready', '< readyok',
    '> position fen ' + record.fen + ' 0 1', '> go nodes 100000',
    '< info depth 24 seldepth 30 score cp 25 wdl 500 300 200 nodes 61564 pv a2a3 a7a6',
    mate ? '< info depth 25 seldepth 31 score mate 3 nodes 100054 pv a2a3' :
      '< info depth 25 seldepth 31 score cp 27 lowerbound wdl 500 300 200 nodes 100054 pv a2a3 a7a6',
    '< bestmove a2a3'
  ];
}
function fixture() {
  const selected = fens.map(selection).sort((a, b) => a.id.localeCompare(b.id));
  const accepted = [], excluded = [], transcriptLines = header();
  for (const record of selected) {
    const mate = record.fen === fens[2];
    const info = Label.parseInfo(mate ?
      'info depth 25 seldepth 31 score mate 3 nodes 100054 pv a2a3' :
      'info depth 24 seldepth 30 score cp 25 wdl 500 300 200 nodes 61564 pv a2a3 a7a6');
    const terminalInfo = Label.parseInfo(mate ?
      'info depth 25 seldepth 31 score mate 3 nodes 100054 pv a2a3' :
      'info depth 25 seldepth 31 score cp 27 lowerbound wdl 500 300 200 nodes 100054 pv a2a3 a7a6');
    const result = { info, terminalInfo, bestMove: 'a2a3' };
    const assessment = Label.assessTeacherResult(
      result, Corpus.parseFen4(record.fen).turn, contracts.teacher);
    if (assessment.eligible) accepted.push(clone(
      Label.labelledRecord(record, result, assessment, contracts)));
    else excluded.push(Label.exclusionRecord(record, assessment, contracts));
    transcriptLines.push(...searchLines(record, mate));
  }
  transcriptLines.push('> quit');
  const sidecar = {
    input: { shard: {} }, output: {},
    exclusions: { path: 'teacher.ndjson.exclusions.ndjson' },
    teacher: { transcript: { path: 'teacher.ndjson.uci.log' } }
  };
  const selectionContext = {
    sourceSha256: snapshotSha256, sourceLicense: 'CC0-1.0', sampleOnly: false,
    shardCount: 1, shardIndex: 0, positionFamilyCap: 64,
    certificationClusters: [], certificationFamilies: []
  };
  return { selected, accepted, excluded, transcriptLines, sidecar, selectionContext };
}
function request(fixture) {
  const teacherText = rowsText(fixture.accepted);
  const selectionText = rowsText(fixture.selected);
  const exclusionsText = rowsText(fixture.excluded);
  const transcriptText = fixture.transcriptLines.join('\n') + '\n';
  const sidecar = fixture.sidecar;
  // Deliberately rehash every supplied artifact after mutations. Passing these
  // cases cannot be explained by a stale checksum in a malformed fixture.
  sidecar.input.shard.rows = fixture.selected.length;
  sidecar.input.shard.sha256 = Corpus.sha256(selectionText);
  sidecar.output.rows = fixture.accepted.length;
  sidecar.output.sha256 = Corpus.sha256(teacherText);
  sidecar.exclusions.rows = fixture.excluded.length;
  sidecar.exclusions.sha256 = Corpus.sha256(exclusionsText);
  sidecar.exclusions.reasons = {};
  for (const item of fixture.excluded) {
    sidecar.exclusions.reasons[item.reason] =
      (sidecar.exclusions.reasons[item.reason] || 0) + 1;
  }
  sidecar.teacher.transcript.sha256 = Corpus.sha256(transcriptText);
  return { teacherPath: path.resolve('/synthetic-evidence/teacher.ndjson'),
    teacherText, selectionText, exclusionsText, transcriptText,
    sidecarText: JSON.stringify(sidecar), selectionContext: fixture.selectionContext };
}
function rejected(name, mutate, pattern) {
  const data = fixture();
  mutate(data);
  assert.throws(() => Evidence.validateEvidence(request(data), contracts), pattern, name);
  checks++;
}

const good = Evidence.validateEvidence(request(fixture()), contracts);
assert.strictEqual(good.selectedRows, 3);
assert.strictEqual(good.acceptedRows, 2);
assert.strictEqual(good.excludedRows, 1);
checks += 3;

rejected('coherently rehashed accepted row omission', data => {
  data.accepted.pop();
}, /partition count differs/);
rejected('coherently rehashed exclusion omission', data => {
  data.excluded.pop();
}, /partition count differs/);
rejected('accepted and excluded overlap with unchanged total count', data => {
  const row = data.accepted[0];
  Object.assign(data.excluded[0], { id: row.id, fen: row.fen, role: row.role });
}, /partition is not exclusive/);
rejected('unselected teacher output substitutes for a selected row', data => {
  const unrelated = selection('7k/8/8/8/8/8/2P5/K7 w - -');
  const teacher = data.accepted[0].teacher;
  delete unrelated.explorationLabel;
  data.accepted[0] = Object.assign(unrelated, { teacher });
}, /partition is not exclusive and selected/);
rejected('source identity cannot be replaced under matching ID', data => {
  data.accepted[0].source.snapshotSha256 = '2'.repeat(64);
}, /accepted label binding differs/);
rejected('fabricated exclusion reason with coherent reason inventory', data => {
  data.excluded[0].reason = 'missing-score';
}, /exclusion binding differs/);
rejected('fabricated exclusion detail', data => {
  data.excluded[0].detail.mateSideToMove = 4;
}, /exclusion binding differs/);
rejected('self-consistent changed label still needs transcript', data => {
  data.accepted[0].teacher.cpWhite++;
}, /accepted label binding differs/);
rejected('changed score in transcript', data => {
  const index = data.transcriptLines.findIndex(line => /score cp 25 /.test(line));
  data.transcriptLines[index] = data.transcriptLines[index].replace('score cp 25 ', 'score cp 26 ');
}, /binding differs/);
rejected('changed WDL in transcript', data => {
  const index = data.transcriptLines.findIndex(line => /score cp 25 /.test(line));
  data.transcriptLines[index] = data.transcriptLines[index].replace('wdl 500 300 200', 'wdl 501 300 199');
}, /binding differs/);
rejected('changed configured search budget', data => {
  const index = data.transcriptLines.indexOf('> go nodes 100000');
  data.transcriptLines[index] = '> go nodes 99999';
}, /expected command go nodes 100000/);
rejected('changed actual terminal effort', data => {
  const index = data.transcriptLines.findIndex(line => /lowerbound.*nodes 100054/.test(line));
  data.transcriptLines[index] = data.transcriptLines[index].replace('nodes 100054', 'nodes 99999');
}, /exclusion binding differs/);
rejected('changed actual engine option', data => {
  const index = data.transcriptLines.indexOf('> setoption name Hash value 64');
  data.transcriptLines[index] = '> setoption name Hash value 32';
}, /expected command setoption name Hash value 64/);
rejected('searched a different position', data => {
  const index = data.transcriptLines.findIndex(line => line.startsWith('> position fen '));
  data.transcriptLines[index] = '> position startpos';
}, /expected command position fen/);
rejected('missing per-position hash reset', data => {
  data.transcriptLines.splice(data.transcriptLines.indexOf('> setoption name Clear Hash'), 1);
}, /expected command setoption name Clear Hash/);
rejected('missing per-position new-game reset', data => {
  data.transcriptLines.splice(data.transcriptLines.indexOf('> ucinewgame'), 1);
}, /expected command ucinewgame/);
rejected('truncated transcript', data => {
  data.transcriptLines.pop();
}, /expected command quit/);
rejected('extra unbound search after selected inventory', data => {
  data.transcriptLines.splice(-1, 0, ...searchLines(data.selected[0], false));
}, /expected command quit/);
rejected('evidence path traversal', data => {
  data.sidecar.teacher.transcript.path = '../outside.log';
}, /malformed evidence path/);
rejected('excluded selection rows must still have their frozen role', data => {
  const row = data.selected.find(record => record.id === data.excluded[0].id);
  row.role = row.role === 'shared-train' ? 'nnue-validation' : 'shared-train';
  data.excluded[0].role = row.role;
}, /recomputed role does not match/);
rejected('excluded selection rows cannot overlap certification families', data => {
  const row = data.selected.find(record => record.id === data.excluded[0].id);
  data.selectionContext.certificationFamilies.push(row.positionFamily);
}, /E4 certification cluster\/family is forbidden/);
rejected('excluded selection rows cannot contain quarantined incident', data => {
  const old = data.selected.find(record => record.id === data.excluded[0].id);
  const quarantined = selection(contracts.heldout.incident.fen4);
  data.selected[data.selected.indexOf(old)] = quarantined;
  Object.assign(data.excluded[0], {
    id: quarantined.id, fen: quarantined.fen, role: quarantined.role
  });
}, /held-out incident cluster\/family is forbidden/);

// A later bound must not resurrect a CP predating a mate. The old search
// reduction did that and would admit this row as ordinary training data.
const mateThenBound = fixture();
const mateRecord = mateThenBound.selected.find(record => record.fen === fens[2]);
const mateIndex = mateThenBound.transcriptLines.findIndex(line => /score mate 3 /.test(line));
const boundLine = 'info depth 26 seldepth 32 score cp 27 lowerbound wdl 500 300 200 nodes 100100 pv a2a3';
mateThenBound.transcriptLines.splice(mateIndex + 1, 0, '< ' + boundLine);
const boundResult = { info: null, terminalInfo: Label.parseInfo(boundLine), bestMove: 'a2a3' };
const missingAssessment = Label.assessTeacherResult(boundResult, 'w', contracts.teacher);
assert.strictEqual(missingAssessment.reason, 'missing-score');
mateThenBound.excluded = [Label.exclusionRecord(mateRecord, missingAssessment, contracts)];
assert.strictEqual(Evidence.validateEvidence(request(mateThenBound), contracts).excludedRows, 1);
checks += 2;

console.log(checks + ' retained teacher evidence checks passed');
