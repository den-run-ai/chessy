#!/usr/bin/env node
'use strict';
// Fabricated evidence for contract tests only. Never source/teacher evidence.
const fs = require('fs');
const path = require('path');
const Label = require('./label-stockfish');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Evidence = require('./teacher-evidence');

function infoLine(info) {
  const fields = ['info'];
  for (const name of ['depth', 'seldepth']) {
    if (info[name] !== undefined) fields.push(name, String(info[name]));
  }
  if (info.cpSideToMove !== undefined) fields.push('score', 'cp', String(info.cpSideToMove));
  if (info.mateSideToMove !== undefined) fields.push('score', 'mate', String(info.mateSideToMove));
  if (info.scoreBound) fields.push(info.scoreBound);
  if (info.wdlSideToMove) fields.push('wdl', ...info.wdlSideToMove.map(String));
  if (info.nodes !== undefined) fields.push('nodes', String(info.nodes));
  if (info.pvUci) fields.push('pv', ...info.pvUci);
  return fields.join(' ');
}

function makeEvidence(teacherPath, acceptedRecords, sidecar, options = {}) {
  const contracts = Label.loadFrozenContracts();
  const teacher = contracts.teacher;
  const cases = acceptedRecords.map(record => {
    const t = record.teacher;
    const white = Corpus.parseFen4(record.fen).turn === 'w';
    const info = {
      depth: t.depth, seldepth: t.seldepth,
      cpSideToMove: white ? t.cpWhite : -t.cpWhite,
      wdlSideToMove: white ? t.wdlWhite : t.wdlWhite.slice().reverse(),
      nodes: t.scoreNodes, pvUci: t.pvUci
    };
    return { record, result: { info,
      terminalInfo: { nodes: t.reportedNodes }, bestMove: t.bestMoveUci } };
  }).concat((options.excludedRecords || []).map(item => ({ ...item, excluded: true }))).sort((a, b) =>
    a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0);
  const lines = ['> uci', '< id name Stockfish 18', '< uciok',
    ...Evidence.initialCommands(teacher).map(line => '> ' + line),
    '> isready', '< readyok'];
  const exclusions = [], reasons = {};
  for (const { record, result, excluded } of cases) {
    if (teacher.uci.UciNewGameBeforeEveryPosition) lines.push('> ucinewgame');
    if (teacher.uci.ClearHashBeforeEveryPosition) lines.push('> setoption name Clear Hash');
    if (teacher.uci.IsReadyBeforeEveryPosition) lines.push('> isready', '< readyok');
    lines.push('> position fen ' + record.fen + ' 0 1',
      '> go nodes ' + teacher.search.nodeLimit);
    if (result.info) lines.push('< ' + infoLine(result.info));
    if (result.terminalInfo && result.terminalInfo !== result.info) {
      lines.push('< ' + infoLine(result.terminalInfo));
    }
    lines.push('< bestmove ' + result.bestMove);
    const assessment = Label.assessTeacherResult(
      result, Corpus.parseFen4(record.fen).turn, teacher);
    if (excluded && !assessment.eligible) {
      exclusions.push(Label.exclusionRecord(record, assessment, contracts));
      reasons[assessment.reason] = (reasons[assessment.reason] || 0) + 1;
    }
  }
  lines.push('> quit');
  const transcriptText = lines.join('\n') + '\n';
  const exclusionsText = exclusions.map(row => Prepare.stableJson(row) + '\n').join('');
  sidecar.teacher.transcript = {
    path: path.basename(teacherPath) + '.uci.log',
    sha256: Corpus.sha256(transcriptText)
  };
  sidecar.exclusions = {
    path: path.basename(teacherPath) + '.exclusions.ndjson',
    rows: exclusions.length, sha256: Corpus.sha256(exclusionsText), reasons
  };
  return { transcriptText, exclusionsText, sidecar };
}

function writeEvidence(teacherPath, acceptedRecords, sidecar, options) {
  const result = makeEvidence(teacherPath, acceptedRecords, sidecar, options);
  fs.writeFileSync(Evidence.artifactPath(teacherPath,
    sidecar.teacher.transcript, 'fixture transcript'), result.transcriptText);
  fs.writeFileSync(Evidence.artifactPath(teacherPath,
    sidecar.exclusions, 'fixture exclusions'), result.exclusionsText);
  return result;
}

if (require.main === module) {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const result = makeEvidence(request.teacherPath,
    Evidence.jsonRows(request.teacherText, 'fixture teacher'),
    JSON.parse(request.sidecarText));
  process.stdout.write(JSON.stringify(result) + '\n');
}
module.exports = { makeEvidence, writeEvidence };
