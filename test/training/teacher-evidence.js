'use strict';

// Admission consumes the exact retained bytes hashed by each caller. Sidecar
// declarations alone are not evidence of execution or complete selection.
const fs = require('fs');
const path = require('path');
const Label = require('./label-stockfish');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const SCHEMA = 'chessy.teacher-evidence-admission.v1';
const HEX = /^[0-9a-f]{64}$/;

function artifactPath(teacherPath, reference, label) {
  if (!reference || typeof reference.path !== 'string' ||
      !reference.path || reference.path === '.' || reference.path === '..' ||
      path.basename(reference.path) !== reference.path ||
      reference.path.includes('\\') || !HEX.test(reference.sha256 || '')) {
    throw new Error(label + ': malformed evidence path/hash');
  }
  return path.join(path.dirname(teacherPath), reference.path);
}

function exactHash(text, expected, label) {
  if (typeof text !== 'string' || !HEX.test(expected || '') ||
      Corpus.sha256(text) !== expected) {
    throw new Error(label + ': retained evidence SHA-256 differs');
  }
}

function jsonRows(text, label) {
  if (!text) return [];
  if (!text.endsWith('\n')) throw new Error(label + ': final newline missing');
  return text.slice(0, -1).split('\n').map((line, index) => {
    if (!line.trim()) throw new Error(label + ': blank row');
    const record = JSON.parse(line);
    if (Prepare.stableJson(record) !== line) {
      throw new Error(label + ': noncanonical row ' + (index + 1));
    }
    return record;
  });
}

function uniqueRows(records, label) {
  const byId = new Map();
  let previous = null;
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !HEX.test(record.id) ||
        (previous !== null && record.id <= previous)) {
      throw new Error(label + ': IDs must be unique and strictly sorted');
    }
    previous = record.id;
    byId.set(record.id, record);
  }
  return byId;
}

function initialCommands(teacher) {
  return ['Threads', 'Hash', 'Ponder', 'MultiPV', 'SyzygyPath',
    'UCI_LimitStrength', 'UCI_ShowWDL'].map(name =>
    'setoption name ' + name + ' value ' + String(teacher.uci[name]));
}

function replayTranscript(text, selected, teacher) {
  if (typeof text !== 'string' || !text.endsWith('\n')) {
    throw new Error('teacher transcript: missing complete line evidence');
  }
  const lines = text.slice(0, -1).split('\n');
  let cursor = 0;
  function command(expected) {
    if (lines[cursor++] !== '> ' + expected) {
      throw new Error('teacher transcript: expected command ' + expected);
    }
  }
  function response() {
    const line = lines[cursor++];
    if (typeof line !== 'string' || !line.startsWith('< ')) {
      throw new Error('teacher transcript: incomplete or misplaced response');
    }
    return line.slice(2);
  }
  function until(expected) {
    while (response() !== expected) { /* Bound by retained transcript EOF. */ }
  }
  command('uci');
  const identity = [];
  for (;;) {
    const line = response();
    if (line === 'uciok') break;
    if (line.startsWith('id name ')) identity.push(line.slice(8));
  }
  if (identity.length !== 1 || identity[0] !== teacher.engine.name) {
    throw new Error('teacher transcript: engine identity differs');
  }
  for (const item of initialCommands(teacher)) command(item);
  command('isready');
  until('readyok');
  const results = [];
  for (const record of selected) {
    if (teacher.uci.UciNewGameBeforeEveryPosition) command('ucinewgame');
    if (teacher.uci.ClearHashBeforeEveryPosition) command('setoption name Clear Hash');
    if (teacher.uci.IsReadyBeforeEveryPosition) {
      command('isready');
      until('readyok');
    }
    command('position fen ' + record.fen + ' 0 1');
    command('go nodes ' + teacher.search.nodeLimit);
    const search = Label.newTeacherSearch();
    for (;;) {
      const line = response();
      if (/^info\s/.test(line)) Label.accumulateTeacherInfo(search, line);
      else if (/^bestmove\s/.test(line)) {
        results.push(Label.finishTeacherSearch(search, line.split(/\s+/)[1]));
        break;
      }
    }
  }
  command('quit');
  if (cursor !== lines.length) {
    throw new Error('teacher transcript: unconsumed commands or responses');
  }
  return results;
}

function validateEvidence(request, contracts = Label.loadFrozenContracts()) {
  const { teacherPath, teacherText, selectionText, sidecarText,
    transcriptText, exclusionsText } = request;
  if (typeof teacherPath !== 'string' || !path.isAbsolute(teacherPath)) {
    throw new Error('teacher evidence requires absolute teacherPath');
  }
  const sidecar = JSON.parse(sidecarText);
  const exclusion = sidecar.exclusions;
  const transcript = sidecar.teacher && sidecar.teacher.transcript;
  artifactPath(teacherPath, exclusion, 'teacher exclusions');
  artifactPath(teacherPath, transcript, 'teacher transcript');
  exactHash(teacherText, sidecar.output && sidecar.output.sha256, 'teacher output');
  exactHash(selectionText, sidecar.input && sidecar.input.shard &&
    sidecar.input.shard.sha256, 'teacher selection');
  exactHash(exclusionsText, exclusion.sha256, 'teacher exclusions');
  exactHash(transcriptText, transcript.sha256, 'teacher transcript');
  const selected = jsonRows(selectionText, 'teacher selection');
  const admission = request.selectionContext;
  if (admission) {
    if (!HEX.test(admission.sourceSha256 || '') ||
        typeof admission.sampleOnly !== 'boolean' ||
        admission.sourceLicense !== 'CC0-1.0' ||
        !Number.isSafeInteger(admission.shardCount) || admission.shardCount < 1 ||
        !Number.isSafeInteger(admission.shardIndex) || admission.shardIndex < 0 ||
        admission.shardIndex >= admission.shardCount ||
        !Number.isSafeInteger(admission.positionFamilyCap) || admission.positionFamilyCap < 1 ||
        !Array.isArray(admission.certificationClusters) ||
        !Array.isArray(admission.certificationFamilies) ||
        !admission.certificationClusters.concat(admission.certificationFamilies)
          .every(value => HEX.test(value))) {
      throw new Error('teacher selection admission context is malformed');
    }
    const context = {
      sourceSha256: admission.sourceSha256, sampleOnly: admission.sampleOnly,
      shardIndex: admission.shardIndex, contracts,
      manifest: { source: { license: admission.sourceLicense },
        adapter: { shardCount: admission.shardCount } },
      certification: {
        clusters: new Set(admission.certificationClusters),
        positionFamilies: new Set(admission.certificationFamilies)
      }
    };
    const clusters = new Set(), families = new Map();
    for (const record of selected) {
      Label.validateSelectionRecord(record, context);
      if (clusters.has(record.cluster)) throw new Error('duplicate selected cluster');
      clusters.add(record.cluster);
      const count = (families.get(record.positionFamily) || 0) + 1;
      if (count > admission.positionFamilyCap) throw new Error('selected position-family cap exceeded');
      families.set(record.positionFamily, count);
    }
  }
  const accepted = jsonRows(teacherText, 'teacher output');
  const excluded = jsonRows(exclusionsText, 'teacher exclusions');
  const selectedById = uniqueRows(selected, 'teacher selection');
  const acceptedById = uniqueRows(accepted, 'teacher output');
  const excludedById = uniqueRows(excluded, 'teacher exclusions');
  for (const [rows, expected, label] of [
    [selected, sidecar.input.shard.rows, 'selection'],
    [accepted, sidecar.output.rows, 'output'],
    [excluded, exclusion.rows, 'exclusions']
  ]) {
    if (!Number.isSafeInteger(expected) || expected < 0 || rows.length !== expected) {
      throw new Error('teacher ' + label + ': row count differs');
    }
  }
  if (selected.length !== accepted.length + excluded.length) {
    throw new Error('teacher selected/accepted/excluded partition count differs');
  }
  for (const id of acceptedById.keys()) {
    if (!selectedById.has(id) || excludedById.has(id)) {
      throw new Error('teacher accepted/excluded partition is not exclusive and selected');
    }
  }
  for (const id of excludedById.keys()) {
    if (!selectedById.has(id)) throw new Error('teacher exclusion ID was not selected');
  }
  const results = replayTranscript(transcriptText, selected, contracts.teacher);
  const reasons = {};
  selected.forEach((record, index) => {
    const result = results[index];
    const assessment = Label.assessTeacherResult(
      result, Corpus.parseFen4(record.fen).turn, contracts.teacher);
    const expected = assessment.eligible ?
      Label.labelledRecord(record, result, assessment, contracts) :
      Label.exclusionRecord(record, assessment, contracts);
    const actual = assessment.eligible ?
      acceptedById.get(record.id) : excludedById.get(record.id);
    if (!actual || Prepare.stableJson(actual) !== Prepare.stableJson(expected)) {
      throw new Error('teacher transcript/selection ' +
        (assessment.eligible ? 'accepted label' : 'exclusion') +
        ' binding differs for ' + record.id);
    }
    if (!assessment.eligible) reasons[assessment.reason] =
      (reasons[assessment.reason] || 0) + 1;
  });
  if (Prepare.stableJson(reasons) !== Prepare.stableJson(exclusion.reasons)) {
    throw new Error('teacher exclusion reason inventory differs');
  }
  return {
    schema: SCHEMA,
    transcriptSha256: transcript.sha256,
    exclusionsSha256: exclusion.sha256,
    selectedRows: selected.length,
    acceptedRows: accepted.length,
    excludedRows: excluded.length,
    selectedClusters: selected.map(record => record.cluster),
    selectedFamilies: selected.map(record => record.positionFamily)
  };
}

function readEvidence(teacherPath, sidecar) {
  const directory = fs.realpathSync(path.dirname(teacherPath));
  function read(reference, label) {
    const filename = artifactPath(teacherPath, reference, label);
    if (path.dirname(fs.realpathSync(filename)) !== directory) {
      throw new Error(label + ': evidence symlink escapes artifact directory');
    }
    return fs.readFileSync(filename, 'utf8');
  }
  return {
    transcriptText: read(sidecar.teacher && sidecar.teacher.transcript,
      'teacher transcript'),
    exclusionsText: read(sidecar.exclusions, 'teacher exclusions')
  };
}

module.exports = { SCHEMA, artifactPath, jsonRows, initialCommands,
  replayTranscript, validateEvidence, readEvidence };
