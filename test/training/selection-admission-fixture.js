#!/usr/bin/env node
/*
 * Synthetic admission-contract fixtures, never real source/teacher evidence.
 * The production-shaped branch deliberately exercises the full frozen E4
 * schema (4,000 openings) in isolated tests; its provenance is fabricated.
 *
 * stdin: { directory, filename, rows, snapshotSha256, sampleOnly?,
 *          certificationFens? }
 * stdout: selection binding with absolute paths and actual file digests.
 * `filename` contains test teacher rows; selection rows are reconstructed via
 * the corpus adapter, rather than copying arbitrary teacher metadata.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Corpus = require('./corpus.js');
const Prepare = require('./prepare-lichess-evals.js');
const Label = require('./label-stockfish.js');
const E4 = require('../eval/e4-protocol.js');

const SOURCE_NAMESPACE = 'chessy.e4.lichess-standard-rated.2026-06';
const certificationCache = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(filename, value) {
  const body = Prepare.stableJson(value) + '\n';
  fs.writeFileSync(filename, body, { flag: 'wx' });
  return Corpus.sha256(body);
}

function openingForFen(inputFen) {
  const fen = Corpus.validateSourceState(inputFen).fen4 + ' 0 7';
  const clusterId = Corpus.clusterKey(fen);
  return {
    clusterId,
    openingId: 'op-' + clusterId,
    fen,
    eco: 'A00',
    openingFamily: 'synthetic-contract-fixture',
    initialBalanceCp: 0,
    sourceRecordIds: [SOURCE_NAMESPACE + ':candidate:' +
      E4.sha256('synthetic-record:' + clusterId)],
    sourceGameIds: [SOURCE_NAMESPACE + ':game:' +
      E4.sha256('synthetic-game:' + clusterId)],
    positionFamilyIds: [Corpus.positionFamilyKey(fen)],
    clusterMembers: [fen]
  };
}

function syntheticOpenings() {
  let serial = 1;
  const clusters = new Set();
  const families = new Set();
  return function next() {
    while (serial < (1 << 14)) {
      const value = serial++;
      const board = new Array(64).fill(null);
      board[4] = 'k';
      board[60] = 'K';
      board[57] = 'N';
      board[2] = 'b';
      [48, 49, 50, 51, 52, 53, 54].forEach((square, bit) => {
        if (value & (1 << bit)) board[square] = 'P';
      });
      [8, 9, 10, 11, 12, 13, 14].forEach((square, bit) => {
        if (value & (1 << (bit + 7))) board[square] = 'p';
      });
      const ranks = [];
      for (let rank = 0; rank < 8; rank++) {
        let text = '', empty = 0;
        for (const piece of board.slice(rank * 8, rank * 8 + 8)) {
          if (piece === null) {
            empty++;
          } else {
            if (empty) text += String(empty);
            empty = 0;
            text += piece;
          }
        }
        if (empty) text += String(empty);
        ranks.push(text);
      }
      const opening = openingForFen(ranks.join('/') + ' w - -');
      const family = opening.positionFamilyIds[0];
      if (clusters.has(opening.clusterId) || families.has(family)) continue;
      clusters.add(opening.clusterId);
      families.add(family);
      return opening;
    }
    throw new Error('exhausted synthetic certification opening fixtures');
  };
}

function rehash(manifest) {
  manifest.openingClusters.sort((a, b) =>
    a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0);
  manifest.freeze.openingSetSha256 = E4.canonicalSha256(manifest.openingClusters);
  manifest.freeze.assignmentSha256 = E4.canonicalSha256(manifest.assignments);
  manifest.manifestId = 'r71-cal-v1/cert/' + manifest.freeze.openingSetSha256;
  manifest.freeze.contentSha256 = null;
  manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
  return manifest;
}

function frozenCertification() {
  const manifest = E4.readJson(E4.PATHS.certification);
  manifest.status = 'frozen';
  manifest.source.name = E4.EXPECTED.openingSourceName;
  manifest.source.release = E4.EXPECTED.openingSourceRelease;
  manifest.source.url = E4.EXPECTED.openingSourceUrl;
  manifest.freeze = {
    immutable: true,
    freezeBaseCommit: 'a'.repeat(40),
    contentSha256: null,
    openingSetSha256: null,
    assignmentSha256: null,
    rawArchiveSha256: E4.EXPECTED.openingRawArchiveSha256,
    candidateNdjsonSha256: '2'.repeat(64),
    candidateManifestSha256: '3'.repeat(64),
    selectionCodeSha256: '4'.repeat(64),
    stockfishExecutableSha256: E4.EXPECTED.stockfishExecutableSha256,
    stockfishNetworkSha256s: E4.EXPECTED.stockfishNetworkSha256s.slice()
  };
  const nextOpening = syntheticOpenings();
  function add(scheduleKind, levelOrPair, anchor) {
    const row = nextOpening();
    manifest.openingClusters.push(row);
    manifest.assignments.push({
      scheduleKind,
      levelOrPair,
      anchor,
      openingClusterId: row.clusterId,
      openingId: row.openingId,
      colors: ['white', 'black'],
      games: 2
    });
  }
  [E4.LEVELS.find(level => level.id === 'master')]
    .concat(E4.LEVELS.filter(level => level.id !== 'master'))
    .forEach(level => {
      level.anchors.forEach((anchor, anchorIndex) => {
        for (let index = 0; index < level.allocation[anchorIndex]; index++) {
          add('cert', level.id, anchor);
        }
      });
    });
  E4.ADJACENT.forEach(pair => {
    for (let index = 0; index < 400; index++) {
      add('adjacent', pair.pair, 'direct');
    }
  });
  return rehash(manifest);
}

function certificationFixture(directory, sampleOnly, certificationFens) {
  if (sampleOnly) {
    if (certificationFens.length) {
      throw new Error('pending certification fixture cannot contain openings');
    }
    return E4.readJson(E4.PATHS.certification);
  }
  // Python launches this helper more than once in one temporary directory.
  // Cache the deterministic full template there, never in the repository.
  const cacheKey = E4.sha256([
    fs.readFileSync(__filename), fs.readFileSync(E4.PATHS.certification),
    fs.readFileSync(require.resolve('../eval/e4-protocol.js')),
    fs.readFileSync(require.resolve('./corpus.js'))
  ].join('\n')).slice(0, 16);
  const cachePath = path.join(directory,
    'synthetic-certification-fixture-' + cacheKey + '.json');
  if (!certificationCache.has(cachePath)) {
    const exists = fs.existsSync(cachePath);
    const base = exists ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) :
      frozenCertification();
    E4.validateCertificationManifest(base);
    if (!exists) writeJson(cachePath, base);
    certificationCache.set(cachePath, base);
  }
  const manifest = clone(certificationCache.get(cachePath));
  if (certificationFens.length > manifest.openingClusters.length) {
    throw new Error('too many replacement certification fixture FENs');
  }
  certificationFens.forEach((fen, index) => {
    const previous = manifest.openingClusters[index];
    const replacement = openingForFen(fen);
    manifest.openingClusters[index] = replacement;
    const assignment = manifest.assignments.find(row =>
      row.openingClusterId === previous.clusterId);
    assignment.openingClusterId = replacement.clusterId;
    assignment.openingId = replacement.openingId;
  });
  if (certificationFens.length) {
    rehash(manifest);
    E4.validateCertificationManifest(manifest);
  }
  return manifest;
}

function selectionRecord(record, snapshotSha256, sampleOnly) {
  const supplied = record.sourceExplorationLabel || record.explorationLabel;
  const label = supplied && Array.isArray(supplied.pvUci) &&
    Number.isSafeInteger(supplied.cpWhite) && Number.isSafeInteger(supplied.depth) ? supplied : {
    cpWhite: 0, depth: 10, knodes: 100, pvUci: ['e1d1']
  };
  const selected = Corpus.adaptLichessRecord({
    fen: record.fen,
    evals: [{ depth: label.depth, knodes: label.knodes,
      pvs: [{ cp: label.cpWhite, moves: label.pvUci.join(' ') }] }]
  }, { sha256: snapshotSha256 });
  if (!selected) throw new Error('test row lacks an admissible exploration label');
  if (sampleOnly) {
    selected.source.dataset = Prepare.MECHANISM_FIXTURE_SOURCE_ID;
    selected.source.mechanismFixture = clone(Prepare.MECHANISM_FIXTURE_MARKER);
    selected.explorationLabel.teacher = Prepare.MECHANISM_FIXTURE_LABEL_TEACHER;
  }
  return selected;
}

function writeSelectionFixture(request) {
  const directory = path.resolve(request.directory);
  const filename = path.resolve(request.filename);
  const rows = request.rows;
  const snapshotSha256 = request.snapshotSha256;
  const sampleOnly = request.sampleOnly === true;
  const certificationFens = request.certificationFens || [];
  if (!Number.isSafeInteger(rows) || rows < 0 ||
      !/^[0-9a-f]{64}$/.test(snapshotSha256 || '') ||
      !Array.isArray(certificationFens)) {
    throw new Error('invalid selection fixture request');
  }
  const contracts = Label.loadFrozenContracts();
  const stem = path.parse(filename).name;
  const selectionDirectory = path.join(directory, stem + '-selection');
  fs.mkdirSync(selectionDirectory);
  const shardPath = path.join(selectionDirectory, 'selection-000.ndjson');
  const teacherText = fs.readFileSync(filename, 'utf8');
  const records = teacherText.trim() ? teacherText.trim().split('\n')
    .map(line => selectionRecord(JSON.parse(line), snapshotSha256, sampleOnly)) : [];
  if (records.length !== rows) throw new Error('selection fixture row count mismatch');
  records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const body = records.map(record => Prepare.stableJson(record) + '\n').join('');
  fs.writeFileSync(shardPath, body, { flag: 'wx' });
  const certification = certificationFixture(directory, sampleOnly, certificationFens);
  const certificationPath = path.join(directory, stem + '-certification.json');
  const certificationSha256 = writeJson(certificationPath, certification);
  const selectionContract = {
    wrapperSha256: contracts.prepareSha256,
    corpusContractSha256: contracts.corpusSha256,
    e4ValidatorSha256: contracts.e4ValidatorSha256,
    heldoutManifestSha256: contracts.heldoutSha256,
    sourcePolicySha256: contracts.sourcePolicySha256,
    certificationManifestSha256: certificationSha256
  };
  if (sampleOnly) selectionContract.mechanismFixture =
    clone(Prepare.MECHANISM_FIXTURE_MARKER);
  const selectionContractSha256 = E4.canonicalSha256(selectionContract);
  const controls = Prepare.validateHeldoutExclusionPolicy(contracts.heldout);
  const manifest = {
    schemaVersion: 1,
    state: sampleOnly ? 'mechanism-test-selection-only' : 'exploration-selection-only',
    finalFitAllowed: false,
    source: {
      id: sampleOnly ? Prepare.MECHANISM_FIXTURE_SOURCE_ID : 'lichess-evaluations',
      url: sampleOnly ? null : contracts.sourceEntry.canonicalUrl,
      retrieved: '2026-07-31',
      compressedSha256: snapshotSha256,
      license: 'CC0-1.0'
    },
    adapter: {
      schema: Corpus.SCHEMA,
      wrapperSha256: contracts.prepareSha256,
      corpusContractSha256: contracts.corpusSha256,
      e4ValidatorSha256: contracts.e4ValidatorSha256,
      sourcePolicySha256: contracts.sourcePolicySha256,
      selectionContractSha256,
      sample: { salt: 'e4-v1-sample', modulus: 1, numerator: 1 },
      shardCount: 1,
      modelCluster: 'canonical legal symmetry orbit of board-only piece placement',
      roleGroup: 'position-family key',
      positionFamilyCap: Math.max(64, rows)
    },
    exclusions: {
      manifest: 'eval/training/heldout-v1.json',
      manifestSha256: contracts.heldoutSha256,
      incidentClusterSha256: contracts.heldout.symmetryPolicy.clusterSha256,
      incidentPositionFamilySha256: contracts.heldout.symmetryPolicy.positionFamilySha256,
      incidentFamilyControlStatus: controls.incidentFamily,
      sameSourceGameLineageControlStatus: controls.sameSourceGameLineage,
      nearbyBudgetTrainingControlStatus: controls.nearbyBudgetTraining,
      nearbyBudgetPreregistrationStatus: controls.nearbyBudgetPreregistration,
      nearbyBudgetNodes: controls.nearbyBudgetNodes,
      nearbyBudgetContract: controls.nearbyBudgetContract,
      nearbyBudgetExecutionEvidenceStatus: controls.nearbyBudgetExecutionEvidence,
      certificationManifest: certificationPath,
      certificationManifestSha256: certificationSha256,
      certificationStatus: certification.status,
      certificationClusterCount: new Set(certification.openingClusters.map(row =>
        Corpus.clusterKey(row.fen))).size,
      certificationPositionFamilyCount: new Set(certification.openingClusters.map(row =>
        Corpus.positionFamilyKey(row.fen))).size,
      pendingCertificationAllowedForTestOnly: sampleOnly,
      appliedBeforeSplit: true
    },
    counts: { selected: rows },
    shards: [{ path: path.basename(shardPath), rows,
      canonicalNdjsonSha256: Corpus.sha256(body) }]
  };
  if (sampleOnly) {
    manifest.mechanismFixture = clone(Prepare.MECHANISM_FIXTURE_MARKER);
    manifest.source.mechanismFixture = clone(Prepare.MECHANISM_FIXTURE_MARKER);
  }
  const manifestPath = path.join(selectionDirectory, 'manifest.json');
  const sha256 = writeJson(manifestPath, manifest);
  return {
    path: manifestPath,
    sha256,
    selectionContractSha256,
    certificationPath,
    certificationStatus: certification.status,
    shardPath,
    shardRows: rows,
    shardSha256: Corpus.sha256(body)
  };
}

module.exports = { writeSelectionFixture, selectionRecord, frozenCertification };

if (require.main === module) {
  try {
    const result = writeSelectionFixture(JSON.parse(fs.readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exitCode = 1;
  }
}
