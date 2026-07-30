#!/usr/bin/env node
/*
 * Authenticate pinned-teacher shards, merge them by record ID, and stream the
 * complete HCE affine rows as NDJSON for the binary/NPZ packer.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');
const Linear = require('./hce-r3-linear');

const ROLES = new Set([
  'shared-train', 'hce-validation', 'hce-test',
  'nnue-validation', 'nnue-test'
]);
const HEX_256 = /^[0-9a-f]{64}$/;
const TEACHER_RECORD_FIELDS = Object.freeze([
  'id', 'release', 'commit', 'manifestSha256', 'nodes', 'cpWhite',
  'wdlWhite', 'targetWhite', 'bestMoveUci', 'pvUci', 'depth', 'seldepth',
  'scoreNodes', 'reportedNodes'
]);
const FINAL_RECORD_FIELDS = Object.freeze([
  'schema', 'id', 'fen', 'canonicalFen', 'cluster', 'role',
  'positionFamily', 'strata', 'source', 'teacher'
]);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function parseArgs(argv) {
  const result = { input: [] };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option !== '--input' && option !== '--role') {
      throw new Error('unknown argument: ' + option);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(option + ' requires a value');
    }
    const value = argv[++index];
    if (option === '--input') result.input.push(value);
    else if (result.role) throw new Error('duplicate --role');
    else result.role = value;
  }
  if (!result.input.length) throw new Error('at least one --input is required');
  if (!ROLES.has(result.role)) throw new Error('--role is invalid');
  return result;
}

function exactTeacher(record, contracts) {
  const teacher = record.teacher;
  const frozen = contracts.teacher;
  if (!hasExactKeys(teacher, TEACHER_RECORD_FIELDS) ||
      teacher.id !== frozen.id ||
      teacher.release !== frozen.engine.release ||
      teacher.commit !== frozen.engine.sourceCommit ||
      teacher.manifestSha256 !== contracts.teacherSha256 ||
      teacher.nodes !== frozen.search.nodeLimit ||
      !Number.isSafeInteger(teacher.cpWhite) ||
      !Number.isFinite(teacher.targetWhite) ||
      teacher.targetWhite < 0 || teacher.targetWhite > 1 ||
      !Array.isArray(teacher.wdlWhite) ||
      teacher.wdlWhite.length !== 3 ||
      !teacher.wdlWhite.every(value =>
        Number.isSafeInteger(value) && value >= 0) ||
      teacher.wdlWhite.reduce((sum, value) => sum + value, 0) !==
        frozen.labels.eligibility.wdlTotal ||
      teacher.targetWhite !==
        (teacher.wdlWhite[0] + 0.5 * teacher.wdlWhite[1]) /
          frozen.labels.eligibility.wdlTotal ||
      !Array.isArray(teacher.pvUci) || !teacher.pvUci.length ||
      !teacher.pvUci.every(move =>
        typeof move === 'string' && move.length > 0) ||
      typeof teacher.bestMoveUci !== 'string' ||
      teacher.bestMoveUci !== teacher.pvUci[0] ||
      !Number.isSafeInteger(teacher.depth) || teacher.depth <= 0 ||
      !Number.isSafeInteger(teacher.seldepth) ||
      teacher.seldepth < teacher.depth ||
      !Number.isSafeInteger(teacher.scoreNodes) ||
      teacher.scoreNodes <= 0 ||
      !Number.isSafeInteger(teacher.reportedNodes) ||
      teacher.reportedNodes < frozen.search.nodeLimit ||
      teacher.scoreNodes > teacher.reportedNodes) {
    throw new Error('teacher record does not match the frozen label contract');
  }
}

function validateTeacherRecord(record, context, contracts) {
  if (record && typeof record === 'object' &&
      (Object.prototype.hasOwnProperty.call(record, 'explorationLabel') ||
       Object.prototype.hasOwnProperty.call(record, 'sourceExplorationLabel'))) {
    throw new Error('mixed upstream labels survived teacher relabelling');
  }
  if (!hasExactKeys(record, FINAL_RECORD_FIELDS) ||
      record.schema !== Corpus.SCHEMA ||
      typeof record.fen !== 'string' || typeof record.id !== 'string') {
    throw new Error('teacher record has the wrong schema');
  }
  const parsed = Corpus.validateSourceState(record.fen);
  const expected = {
    id: Corpus.sha256(
      context.manifest.source.compressedSha256 + '\n' + parsed.fen4),
    canonicalFen: Corpus.canonicalFen4(parsed.fen4),
    cluster: Corpus.clusterKey(parsed.fen4),
    positionFamily: Corpus.positionFamilyKey(parsed.fen4)
  };
  expected.role = Corpus.roleForCluster(expected.positionFamily);
  for (const name of Object.keys(expected)) {
    if (record[name] !== expected[name]) {
      throw new Error('teacher record ' + name + ' does not recompute');
    }
  }
  if (!record.source ||
      record.source.dataset !== 'lichess-evaluated-positions' ||
      record.source.snapshotSha256 !==
        context.manifest.source.compressedSha256 ||
      record.source.license !== context.manifest.source.license ||
      !record.strata || record.strata.phase !== Corpus.phaseBucket(parsed.fen4)) {
    throw new Error('teacher record source/phase provenance does not match');
  }
  if (expected.cluster === contracts.heldout.symmetryPolicy.clusterSha256 ||
      expected.positionFamily ===
        contracts.heldout.symmetryPolicy.positionFamilySha256 ||
      context.certification.clusters.has(expected.cluster) ||
      context.certification.positionFamilies.has(expected.positionFamily)) {
    throw new Error('teacher record leaks a frozen held-out family');
  }
  exactTeacher(record, contracts);
  return record;
}

async function authenticateInput(filename, contracts) {
  const input = path.resolve(filename);
  const sidecarPath = input + '.manifest.json';
  const sidecarText = fs.readFileSync(sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarText);
  const sideTeacher = sidecar.teacher;
  if (sidecar.schemaVersion !== 1 ||
      sidecar.state !== 'pinned-teacher-labels' ||
      !sidecar.output ||
      path.basename(input) !== sidecar.output.path ||
      !Number.isSafeInteger(sidecar.output.rows) ||
      sidecar.output.rows < 0 ||
      await Prepare.fileSha256(input) !== sidecar.output.sha256 ||
      !sideTeacher || !sideTeacher.manifest ||
      sideTeacher.manifest.sha256 !== contracts.teacherSha256 ||
      sideTeacher.id !== contracts.teacher.id ||
      sideTeacher.release !== contracts.teacher.engine.release ||
      sideTeacher.commit !== contracts.teacher.engine.sourceCommit ||
      sideTeacher.executableSha256 !==
        contracts.teacher.engine.executable.sha256 ||
      sideTeacher.license !== contracts.teacher.engine.license ||
      sideTeacher.use !== contracts.teacher.engine.integration ||
      sideTeacher.nodes !== contracts.teacher.search.nodeLimit ||
      sideTeacher.scorePovFromEngine !== contracts.teacher.labels.enginePov ||
      sideTeacher.storedScorePov !== contracts.teacher.labels.storedPov) {
    throw new Error(input + ': teacher sidecar/output binding failed');
  }
  const expectedNetworks = contracts.teacher.engine.networks.map(network => ({
    option: network.option,
    embeddedName: network.embeddedName,
    sha256: network.sha256
  }));
  if (JSON.stringify(sideTeacher.networks) !==
      JSON.stringify(expectedNetworks)) {
    throw new Error(input + ': teacher network pins differ');
  }
  if (JSON.stringify(sideTeacher.options) !==
        JSON.stringify(contracts.teacher.uci) ||
      JSON.stringify(sideTeacher.watchdog) !==
        JSON.stringify(contracts.teacher.watchdog)) {
    throw new Error(input + ': teacher UCI/watchdog pins differ');
  }
  if (!sidecar.input || !sidecar.input.selectionManifest ||
      !sidecar.input.shard) {
    throw new Error(input + ': selection provenance is missing');
  }
  const sideSelection = sidecar.input.selectionManifest;
  const sideShard = sidecar.input.shard;
  const selectionPath = sideSelection.path;
  const selectionShard = sideShard.path;
  if (typeof selectionPath !== 'string' ||
      typeof selectionShard !== 'string' ||
      !HEX_256.test(sideSelection.sha256 || '') ||
      !HEX_256.test(sideSelection.selectionContractSha256 || '') ||
      !HEX_256.test(sideShard.sha256 || '') ||
      !Number.isSafeInteger(sideShard.rows) || sideShard.rows < 0) {
    throw new Error(input + ': selection provenance is malformed');
  }
  const selectionText = fs.readFileSync(selectionPath, 'utf8');
  if (Corpus.sha256(selectionText) !==
      sideSelection.sha256) {
    throw new Error(input + ': selection manifest hash differs');
  }
  const selection = JSON.parse(selectionText);
  const context = await Label.loadSelectionContext(
    selectionPath, selectionShard, contracts);
  if (context.inputSha256 !== sideShard.sha256 ||
      context.shard.rows !== sideShard.rows ||
      sideSelection.selectionContractSha256 !==
        selection.adapter.selectionContractSha256 ||
      sideSelection.certificationStatus !== context.certification.status ||
      context.certification.status !== 'frozen') {
    throw new Error(input + ': selection shard sidecar binding failed');
  }
  return {
    input,
    inputSha256: sidecar.output.sha256,
    sidecarPath,
    sidecarSha256: Corpus.sha256(sidecarText),
    rows: sidecar.output.rows,
    context,
    selectionManifestSha256: sideSelection.sha256,
    selectionContractSha256: selection.adapter.selectionContractSha256
  };
}

function lineIterator(filename) {
  const lines = readline.createInterface({
    input: fs.createReadStream(filename),
    crlfDelay: Infinity
  });
  return lines[Symbol.asyncIterator]();
}

async function advance(state, contracts) {
  const next = await state.iterator.next();
  if (next.done) {
    const observedSha256 = state.hash.digest('hex');
    state.hash = null;
    if (observedSha256 !== state.auth.inputSha256) {
      throw new Error(
        state.auth.input + ': bytes read differ from authenticated shard hash'
      );
    }
    state.record = null;
    return;
  }
  state.hash.update(next.value + '\n');
  if (!next.value.trim()) {
    throw new Error(state.auth.input + ': blank teacher rows are forbidden');
  }
  const record = validateTeacherRecord(
    JSON.parse(next.value), state.auth.context, contracts);
  if (state.previousId && record.id <= state.previousId) {
    throw new Error(state.auth.input +
      ': teacher rows must be strictly sorted by ID');
  }
  state.previousId = record.id;
  state.seen++;
  state.record = record;
}

function heapPush(heap, state) {
  heap.push(state);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent].record.id <= state.record.id) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = state;
}

function heapPop(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) {
    let index = 0;
    while (true) {
      let child = index * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length &&
          heap[child + 1].record.id < heap[child].record.id) child++;
      if (heap[child].record.id >= last.record.id) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

async function streamRows(options, write) {
  const contracts = Label.loadFrozenContracts();
  const authenticated = [];
  for (const filename of options.input) {
    authenticated.push(await authenticateInput(filename, contracts));
  }
  const selectionContracts = new Set(
    authenticated.map(item => item.selectionContractSha256));
  const selectionManifests = new Set(
    authenticated.map(item => item.selectionManifestSha256));
  if (selectionContracts.size !== 1 || selectionManifests.size !== 1) {
    throw new Error(
      'teacher shards do not share one selection manifest and contract'
    );
  }
  const states = authenticated.map(auth => ({
    auth,
    iterator: lineIterator(auth.input),
    record: null,
    previousId: null,
    seen: 0,
    hash: crypto.createHash('sha256')
  }));
  const heap = [];
  for (const state of states) {
    await advance(state, contracts);
    if (state.record) heapPush(heap, state);
  }
  let lastId = null, rows = 0;
  while (heap.length) {
    const selected = heapPop(heap);
    const record = selected.record;
    if (record.id === lastId) {
      throw new Error('duplicate teacher record ID across shards: ' + record.id);
    }
    lastId = record.id;
    if (record.role === options.role) {
      const linear = Linear.compile(record.fen);
      await write(JSON.stringify({
        id: record.id,
        cluster: record.cluster,
        positionFamily: record.positionFamily,
        role: record.role,
        fixedCp: linear.fixedCp,
        target: record.teacher.targetWhite,
        indices: linear.sparse.map(entry => entry[0]),
        data: linear.sparse.map(entry => entry[1])
      }) + '\n');
      rows++;
    }
    await advance(selected, contracts);
    if (selected.record) heapPush(heap, selected);
  }
  for (const state of states) {
    if (state.seen !== state.auth.rows) {
      throw new Error(state.auth.input + ': sidecar row count differs');
    }
  }
  return {
    rows,
    role: options.role,
    teacherManifestSha256: contracts.teacherSha256,
    selectionContractSha256: authenticated[0].selectionContractSha256,
    inputSha256: authenticated.map(item => item.inputSha256),
    inputSidecarSha256: authenticated.map(item => item.sidecarSha256)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await streamRows(options, text => {
    if (process.stdout.write(text)) return Promise.resolve();
    return new Promise(resolve => process.stdout.once('drain', resolve));
  });
  process.stderr.write(JSON.stringify(summary) + '\n');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('hce-r3-pack-stream: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  exactTeacher,
  validateTeacherRecord,
  authenticateInput,
  heapPush,
  heapPop,
  streamRows
};
