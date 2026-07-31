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
const PRODUCTION_SOURCE_FIELDS = Object.freeze([
  'dataset', 'snapshotSha256', 'license'
]);
const SAMPLE_SOURCE_FIELDS = Object.freeze([
  'dataset', 'snapshotSha256', 'license', 'mechanismFixture'
]);
const SAMPLE_MECHANISM_FIXTURE = Prepare.MECHANISM_FIXTURE_MARKER;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function parseArgs(argv) {
  const result = { input: [], sampleOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option !== '--input' && option !== '--role' &&
        option !== '--sample-only') {
      throw new Error('unknown argument: ' + option);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(option + ' requires a value');
    }
    const value = argv[++index];
    if (option === '--input') result.input.push(value);
    else if (option === '--role') {
      if (result.role) throw new Error('duplicate --role');
      result.role = value;
    } else {
      if (result.sampleOnly) throw new Error('duplicate --sample-only');
      if (value !== 'true') {
        throw new Error('--sample-only must be exactly true');
      }
      result.sampleOnly = true;
    }
  }
  if (!result.input.length) throw new Error('at least one --input is required');
  if (!ROLES.has(result.role)) throw new Error('--role is invalid');
  return result;
}

function sampleOnlyOption(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('stream options are required');
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'sampleOnly')) {
    return false;
  }
  if (typeof options.sampleOnly !== 'boolean') {
    throw new Error('sampleOnly direct option must be boolean');
  }
  return options.sampleOnly;
}

function exactMechanismFixture(value) {
  return hasExactKeys(value, Object.keys(SAMPLE_MECHANISM_FIXTURE)) &&
    Prepare.stableJson(value) ===
      Prepare.stableJson(SAMPLE_MECHANISM_FIXTURE);
}

function streamDisposition(sampleOnly) {
  if (typeof sampleOnly !== 'boolean') {
    throw new Error('sample-only mode must be boolean');
  }
  if (sampleOnly) {
    return {
      status: SAMPLE_MECHANISM_FIXTURE.status,
      mode: 'sample-only',
      sampleOnly: true,
      fitAllowed: SAMPLE_MECHANISM_FIXTURE.fitAllowed,
      officialEvaluationSnapshot:
        SAMPLE_MECHANISM_FIXTURE.officialEvaluationSnapshot
    };
  }
  return {
    status: 'authenticated-production-input',
    mode: 'production',
    sampleOnly: false
  };
}

function validateSidecarMode(sidecar, sampleOnly) {
  streamDisposition(sampleOnly);
  if (sampleOnly) {
    if (sidecar.state !== 'pinned-teacher-labels-sample-only' ||
        sidecar.fitAllowed !== false ||
        !exactMechanismFixture(sidecar.mechanismFixture)) {
      throw new Error(
        'sample-only teacher sidecar state or mechanism marker differs'
      );
    }
    return;
  }
  if (sidecar.state !== 'pinned-teacher-labels' ||
      Object.prototype.hasOwnProperty.call(sidecar, 'fitAllowed') ||
      Object.prototype.hasOwnProperty.call(sidecar, 'mechanismFixture')) {
    throw new Error('production teacher sidecar state differs');
  }
}

function validateSelectionMode(sidecar, context, sampleOnly) {
  streamDisposition(sampleOnly);
  const sideSelection = sidecar.input &&
    sidecar.input.selectionManifest;
  const selection = context && context.manifest;
  const certification = context && context.certification;
  if (sampleOnly) {
    if (!context || context.sampleOnly !== true ||
        !selection ||
        selection.state !== 'mechanism-test-selection-only' ||
        selection.finalFitAllowed !== false ||
        !exactMechanismFixture(selection.mechanismFixture) ||
        !sideSelection ||
        sideSelection.certificationStatus !==
          'awaiting-opening-freeze' ||
        !certification ||
        certification.status !== 'awaiting-opening-freeze') {
      throw new Error(
        'sample-only selection state, marker, or certification differs'
      );
    }
    return;
  }
  if (!selection ||
      selection.state !== 'exploration-selection-only' ||
      Object.prototype.hasOwnProperty.call(
        selection, 'mechanismFixture') ||
      !sideSelection ||
      sideSelection.certificationStatus !== 'frozen' ||
      !certification ||
      certification.status !== 'frozen') {
    throw new Error('production selection or certification state differs');
  }
}

function validateSelectionBinding(sideSelection, sideShard, context) {
  if (!sideSelection || !sideShard || !context ||
      !context.manifest || !context.manifest.adapter ||
      !context.shard || !context.certification ||
      context.manifestSha256 !== sideSelection.sha256 ||
      context.inputSha256 !== sideShard.sha256 ||
      context.shard.rows !== sideShard.rows ||
      sideSelection.selectionContractSha256 !==
        context.manifest.adapter.selectionContractSha256 ||
      sideSelection.certificationStatus !== context.certification.status) {
    throw new Error('selection shard sidecar binding failed');
  }
}

function validateTeacherSource(source, context) {
  const manifestSource = context && context.manifest &&
    context.manifest.source;
  const sampleOnly = context && context.sampleOnly === true;
  const expectedFields = sampleOnly ?
    SAMPLE_SOURCE_FIELDS : PRODUCTION_SOURCE_FIELDS;
  const expectedDataset = sampleOnly ?
    Prepare.MECHANISM_FIXTURE_SOURCE_ID :
    'lichess-evaluated-positions';
  if (!manifestSource ||
      !hasExactKeys(source, expectedFields) ||
      source.dataset !== expectedDataset ||
      source.snapshotSha256 !== context.sourceSha256 ||
      source.license !== manifestSource.license ||
      (sampleOnly && !exactMechanismFixture(source.mechanismFixture))) {
    throw new Error(
      'teacher record source provenance does not match its selection mode'
    );
  }
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
      context.sourceSha256 + '\n' + parsed.fen4),
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
  validateTeacherSource(record.source, context);
  if (!record.strata ||
      record.strata.phase !== Corpus.phaseBucket(parsed.fen4)) {
    throw new Error('teacher record phase provenance does not match');
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

async function authenticateInput(filename, contracts, options) {
  const sampleOnly = sampleOnlyOption(options || {});
  const input = path.resolve(filename);
  const sidecarPath = input + '.manifest.json';
  const sidecarText = fs.readFileSync(sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarText);
  validateSidecarMode(sidecar, sampleOnly);
  const sideTeacher = sidecar.teacher;
  if (sidecar.schemaVersion !== 1 ||
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
  if (Prepare.stableJson(sideTeacher.networks) !==
      Prepare.stableJson(expectedNetworks)) {
    throw new Error(input + ': teacher network pins differ');
  }
  if (Prepare.stableJson(sideTeacher.options) !==
        Prepare.stableJson(contracts.teacher.uci) ||
      Prepare.stableJson(sideTeacher.watchdog) !==
        Prepare.stableJson(contracts.teacher.watchdog)) {
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
  const context = await Label.loadSelectionContext(
    selectionPath,
    selectionShard,
    contracts,
    sampleOnly ? { sampleOnly: true } : undefined);
  validateSelectionMode(sidecar, context, sampleOnly);
  try {
    validateSelectionBinding(sideSelection, sideShard, context);
  } catch (error) {
    throw new Error(input + ': ' + error.message);
  }
  return {
    input,
    inputSha256: sidecar.output.sha256,
    sidecarPath,
    sidecarSha256: Corpus.sha256(sidecarText),
    rows: sidecar.output.rows,
    context,
    selectionManifestSha256: context.manifestSha256,
    selectionContractSha256:
      context.manifest.adapter.selectionContractSha256,
    sourceSnapshotSha256: context.sourceSha256,
    selectionShard: {
      path: path.resolve(selectionShard),
      index: context.shardIndex,
      rows: sideShard.rows,
      sha256: sideShard.sha256
    }
  };
}

function sharedProvenance(authenticated) {
  if (!Array.isArray(authenticated) || !authenticated.length) {
    throw new Error('at least one authenticated teacher shard is required');
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
  const sourceSnapshots = new Set(
    authenticated.map(item => item.sourceSnapshotSha256));
  if (sourceSnapshots.size !== 1) {
    throw new Error('teacher shards do not share one source snapshot');
  }
  return {
    selectionManifestSha256: authenticated[0].selectionManifestSha256,
    selectionContractSha256: authenticated[0].selectionContractSha256,
    sourceSnapshotSha256: authenticated[0].sourceSnapshotSha256
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
  const sampleOnly = sampleOnlyOption(options);
  const disposition = streamDisposition(sampleOnly);
  const contracts = Label.loadFrozenContracts();
  const authenticated = [];
  for (const filename of options.input) {
    authenticated.push(await authenticateInput(
      filename, contracts, { sampleOnly }));
  }
  const provenance = sharedProvenance(authenticated);
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
  return Object.assign({
    rows,
    role: options.role,
  }, disposition, {
    teacherManifestSha256: contracts.teacherSha256,
    selectionManifestSha256: provenance.selectionManifestSha256,
    selectionContractSha256: provenance.selectionContractSha256,
    sourceSnapshotSha256: provenance.sourceSnapshotSha256,
    inputSha256: authenticated.map(item => item.inputSha256),
    inputSidecarSha256: authenticated.map(item => item.sidecarSha256),
    providedShardInventory: authenticated.map((item, index) => ({
      index,
      teacherPath: item.input,
      teacherRows: item.rows,
      teacherSha256: item.inputSha256,
      teacherSidecarPath: item.sidecarPath,
      teacherSidecarSha256: item.sidecarSha256,
      selectionShardPath: item.selectionShard.path,
      selectionShardIndex: item.selectionShard.index,
      selectionShardRows: item.selectionShard.rows,
      selectionShardSha256: item.selectionShard.sha256
    }))
  });
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
  sampleOnlyOption,
  exactMechanismFixture,
  streamDisposition,
  validateSidecarMode,
  validateSelectionMode,
  validateSelectionBinding,
  validateTeacherSource,
  exactTeacher,
  validateTeacherRecord,
  authenticateInput,
  sharedProvenance,
  heapPush,
  heapPop,
  streamRows
};
