/*
 * Contract tests for the data-only E4-v1 adapter and manifests.
 *
 *   node test/eval/e4-protocol.test.js
 */
'use strict';

const path = require('path');
const E4 = require('./e4-protocol.js');

let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function expectThrow(label, expected, callback) {
  try {
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    const message = String(error && error.message || error);
    check(expected.test(message), label, message);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readTemplates() {
  return {
    exploration: E4.readJson(E4.PATHS.exploration),
    certification: E4.readJson(E4.PATHS.certification)
  };
}

let syntheticSerial = 0;
const syntheticClusterIds = new Set();

function boardToFen(board) {
  const ranks = [];
  for (let rank = 0; rank < 8; rank++) {
    let text = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (!piece) {
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
  return ranks.join('/') + ' w - - 0 1';
}

function nextSyntheticOpening() {
  for (;;) {
    const serial = syntheticSerial++;
    const board = new Array(64).fill(null);
    board[4] = 'k';
    board[60] = 'K';
    const available = [];
    for (let square = 0; square < 64; square++) {
      if (!board[square]) available.push(square);
    }
    const firstIndex = serial % available.length;
    const first = available[firstIndex];
    available.splice(firstIndex, 1);
    const secondIndex = Math.floor(serial / 62) % available.length;
    const second = available[secondIndex];
    available.splice(secondIndex, 1);
    const pawnSquares = available.filter(square => {
      const rank = square >> 3;
      return rank > 0 && rank < 7;
    });
    const pawn = pawnSquares[Math.floor(serial / (62 * 61)) % pawnSquares.length];
    board[first] = 'N';
    board[second] = 'b';
    board[pawn] = 'P';
    const fen = boardToFen(board);
    const clusterId = require('../training/corpus.js').clusterKey(fen);
    if (syntheticClusterIds.has(clusterId)) continue;
    syntheticClusterIds.add(clusterId);
    return { fen, clusterId };
  }
}

function opening(clusterId, openingId) {
  const generated = nextSyntheticOpening();
  return {
    clusterId: generated.clusterId,
    openingId: openingId,
    fen: generated.fen,
    eco: 'A00',
    openingFamily: 'synthetic-contract-fixture',
    initialBalanceCp: 0,
    sourceRecordIds: ['source-' + generated.clusterId],
    clusterMembers: ['member-' + generated.clusterId]
  };
}

function setFrozenMetadata(manifest) {
  manifest.status = 'frozen';
  if (manifest.source.name == null) manifest.source.name = 'synthetic-openings';
  manifest.source.release = 'synthetic-v1';
  manifest.source.url = 'https://example.invalid/synthetic-v1';
  manifest.freeze = {
    immutable: true,
    freezeBaseCommit: 'a'.repeat(40),
    contentSha256: null,
    openingSetSha256: null,
    assignmentSha256: null,
    sourceArchiveSha256: '1'.repeat(64),
    selectionCodeSha256: '2'.repeat(64),
    stockfishExecutableSha256: E4.EXPECTED.stockfishExecutableSha256,
    stockfishNetworkSha256s: E4.EXPECTED.stockfishNetworkSha256s.slice()
  };
}

function rehash(manifest) {
  manifest.freeze.openingSetSha256 =
    E4.canonicalSha256(manifest.openingClusters);
  manifest.freeze.assignmentSha256 =
    E4.canonicalSha256(manifest.assignments);
  manifest.freeze.contentSha256 = null;
  manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
  return manifest;
}

function frozenExploration(template) {
  const manifest = clone(template);
  manifest.manifestId = 'r69-cal-v1/explore/synthetic-frozen';
  setFrozenMetadata(manifest);
  manifest.schedules.forEach(function (schedule, index) {
    const level = E4.LEVELS[index];
    const openingId = 'explore-opening-' + level.id;
    schedule.openingClusters = 1;
    schedule.games = 2;
    schedule.anchorAllocation = [{
      elo: level.nominalElo,
      openingClusters: 1,
      games: 2
    }];
    const row = opening(null, openingId);
    manifest.openingClusters.push(row);
    manifest.assignments.push({
      level: level.id,
      anchor: level.nominalElo,
      openingClusterId: row.clusterId,
      openingId: openingId,
      colors: ['white', 'black'],
      games: 2
    });
  });
  return rehash(manifest);
}

function frozenCertification(template) {
  const manifest = clone(template);
  manifest.manifestId = 'r69-cal-v1/cert/synthetic-frozen';
  setFrozenMetadata(manifest);

  E4.LEVELS.forEach(function (level) {
    level.anchors.forEach(function (anchor, anchorIndex) {
      const count = level.allocation[anchorIndex];
      for (let index = 0; index < count; index++) {
        const suffix = level.id + '-' + anchor + '-' + index;
        const openingId = 'cert-opening-' + suffix;
        const row = opening(null, openingId);
        manifest.openingClusters.push(row);
        manifest.assignments.push({
          scheduleKind: 'cert',
          levelOrPair: level.id,
          anchor: anchor,
          openingClusterId: row.clusterId,
          openingId: openingId,
          colors: ['white', 'black'],
          games: 2
        });
      }
    });
  });

  E4.ADJACENT.forEach(function (pair) {
    for (let index = 0; index < 400; index++) {
      const suffix = pair.pair + '-' + index;
      const openingId = 'adjacent-opening-' + suffix;
      const row = opening(null, openingId);
      manifest.openingClusters.push(row);
      manifest.assignments.push({
        scheduleKind: 'adjacent',
        levelOrPair: pair.pair,
        anchor: 'direct',
        openingClusterId: row.clusterId,
        openingId: openingId,
        colors: ['white', 'black'],
        games: 2
      });
    }
  });
  return rehash(manifest);
}

function main() {
  const templates = readTemplates();

  try {
    E4.validateRepository(path.join(__dirname, '..', '..'));
    check(true,
      'checked-in adapter, protocol, statistics, templates, and r69 WASM pins validate');
  } catch (error) {
    check(false,
      'checked-in adapter, protocol, statistics, templates, and r69 WASM pins validate',
      String(error && error.message || error));
  }

  check(templates.exploration.status === 'awaiting-opening-freeze' &&
    templates.certification.status === 'awaiting-opening-freeze' &&
    templates.exploration.openingClusters.length === 0 &&
    templates.certification.openingClusters.length === 0,
  'incomplete opening manifests honestly remain awaiting-opening-freeze');

  const explorationSchema = E4.readJson(path.join(
    path.dirname(E4.PATHS.exploration), 'exploration-manifest.schema.json'));
  const certificationSchema = E4.readJson(path.join(
    path.dirname(E4.PATHS.certification), 'certification-manifest.schema.json'));
  check(explorationSchema.properties.kind.const === 'exploration' &&
    certificationSchema.properties.kind.const === 'certification' &&
    explorationSchema.properties.kind.const !==
      certificationSchema.properties.kind.const,
  'exploration and certification have disjoint manifest schemas');

  const adapter = E4.readJson(E4.PATHS.adapter);
  const protocol = E4.readJson(E4.PATHS.protocol);
  check(adapter.searchContract.engineRootSeed.hex === '0x00C0FFEE' &&
    adapter.searchContract.engineRootSeed.integer === 12648430 &&
    adapter.searchContract.engineRootSeed.configurable === false &&
    adapter.searchContract.engineRootSeed.acceptedAsSearchInput === false &&
    protocol.seedContracts.manifestDerived.searchUse === false,
  'r69 keeps its embedded fixed engine seed; manifest seeds never enter search');

  const seed = E4.deriveScheduleSeed('a'.repeat(64), 'opening-1');
  check(seed ===
    '347dc3de1957d27322687114d73e7f47e030308c87ff322d0c939a53eb5db928',
  'manifest-derived schedule seed has a frozen deterministic encoding', seed);
  const whiteId = E4.resultId({
    phase: 'cert',
    levelOrPair: 'master',
    anchor: 2300,
    openingId: 'opening-1',
    seed: seed,
    chessyColor: 'white'
  });
  const blackId = E4.resultId({
    phase: 'cert',
    levelOrPair: 'master',
    anchor: 2300,
    openingId: 'opening-1',
    seed: seed,
    chessyColor: 'black'
  });
  check(whiteId === 'r69-cal-v1/cert/master/2300/opening-1/' +
    seed + '/white' &&
    blackId === 'r69-cal-v1/cert/master/2300/opening-1/' +
      seed + '/black',
  'both colors share one schedule seed and receive immutable result IDs');

  expectThrow('per-opening engineSeed is forbidden',
    /undeclared property engineSeed|engineSeed.*forbidden/, function () {
      const manifest = clone(templates.exploration);
      manifest.openingClusters.push({ engineSeed: 7 });
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('an awaiting manifest cannot invent exploration counts',
    /must not invent counts/, function () {
      const manifest = clone(templates.exploration);
      manifest.schedules[0].openingClusters = 1;
      manifest.schedules[0].games = 2;
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('certification rejects a wrong game count',
    /exact external schedules/, function () {
      const manifest = clone(templates.certification);
      manifest.externalSchedules[4].games = 1598;
      E4.validateCertificationManifest(manifest);
    });

  expectThrow('certification rejects a wrong 25/50/25 anchor allocation',
    /exact external schedules/, function () {
      const manifest = clone(templates.certification);
      manifest.externalSchedules[0].anchorAllocation[0].openingClusters = 99;
      manifest.externalSchedules[0].anchorAllocation[1].openingClusters = 201;
      E4.validateCertificationManifest(manifest);
    });

  expectThrow('r69 commit drift is rejected',
    /r69 commit drifted/, function () {
      const manifest = clone(templates.exploration);
      manifest.productBaseline.gitCommit = 'b'.repeat(40);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('r69 WASM hash drift is rejected',
    /WASM SHA-256 drifted/, function () {
      const manifest = clone(templates.certification);
      manifest.productBaseline.wasmSha256 = 'b'.repeat(64);
      E4.validateCertificationManifest(manifest);
    });

  expectThrow('a configurable engine root seed is rejected',
    /engine root seed.*drifted/, function () {
      const changed = clone(adapter);
      changed.searchContract.engineRootSeed.configurable = true;
      E4.validateAdapter(changed);
    });

  expectThrow('manifest JSON Schema boundaries reject undeclared controls',
    /undeclared property unexpectedMutableField/, function () {
      const manifest = clone(templates.certification);
      manifest.unexpectedMutableField = { searchSeed: 123 };
      E4.validateCertificationManifest(manifest);
    });

  const validExploration = frozenExploration(templates.exploration);
  const validCertification = frozenCertification(templates.certification);
  try {
    E4.validateManifestSet(validExploration, validCertification);
    check(true, 'fully frozen synthetic manifests satisfy all counts and hashes');
  } catch (error) {
    check(false, 'fully frozen synthetic manifests satisfy all counts and hashes',
      String(error && error.message || error));
  }

  expectThrow('frozen manifests reject mutable freeze state',
    /immutable=true/, function () {
      const manifest = clone(validExploration);
      manifest.freeze.immutable = false;
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject missing literal hashes',
    /must contain exactly EvalFile and EvalFileSmall hashes/, function () {
      const manifest = clone(validExploration);
      manifest.freeze.stockfishNetworkSha256s = null;
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject a different Stockfish network identity',
    /network hashes do not match E4-v1/, function () {
      const manifest = clone(validExploration);
      manifest.freeze.stockfishNetworkSha256s[1] = 'f'.repeat(64);
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject opening content after hash drift',
    /opening-set hash drifted/, function () {
      const manifest = clone(validExploration);
      manifest.openingClusters[0].initialBalanceCp = 1;
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('exploration/certification cluster overlap is rejected',
    /opening cluster ID overlap/, function () {
      const exploration = clone(validExploration);
      const certification = clone(validCertification);
      const oldOpening = certification.openingClusters[0];
      const overlappingOpening = clone(exploration.openingClusters[0]);
      certification.openingClusters[0] = overlappingOpening;
      certification.assignments.forEach(function (assignment) {
        if (assignment.openingClusterId === oldOpening.clusterId) {
          assignment.openingClusterId = overlappingOpening.clusterId;
          assignment.openingId = overlappingOpening.openingId;
        }
      });
      rehash(certification);
      E4.validateManifestSet(exploration, certification);
    });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main();
