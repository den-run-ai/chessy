/*
 * Contract tests for the data-only E4-v1 adapter and manifests.
 *
 *   node test/eval/e4-protocol.test.js
 */
'use strict';

const path = require('path');
const E4 = require('./e4-protocol.js');
const Corpus = require('../training/corpus.js');

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

let syntheticSerial = 1;
const syntheticClusterIds = new Set();
const syntheticFamilyIds = new Set();
const SOURCE_NAMESPACE =
  'chessy.e4.lichess-standard-rated.2026-06';

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
  return ranks.join('/') + ' w - - 0 7';
}

function relocateWhiteKnight(fen) {
  const parsed = Corpus.parseFen4(fen);
  const board = parsed.board.flat();
  const from = board.indexOf('N');
  const to = 42;
  if (from < 0 || board[to] !== null) {
    throw new Error('synthetic opening lacks a movable white knight');
  }
  board[from] = null;
  board[to] = 'N';
  return boardToFen(board);
}

function heldoutFamilyVariant() {
  const parsed = Corpus.parseFen4(E4.EXPECTED.heldoutFen);
  const board = parsed.board.flat();
  const from = 26; // c5
  const to = 35; // d4
  if (board[from] !== 'b' || board[to] !== null) {
    throw new Error('held-out fixture lacks the expected c5 bishop');
  }
  board[from] = null;
  board[to] = 'b';
  return boardToFen(board);
}

function nextSyntheticOpening() {
  for (;;) {
    const serial = syntheticSerial++;
    const board = new Array(64).fill(null);
    board[4] = 'k';
    board[60] = 'K';
    board[57] = 'N';
    board[2] = 'b';
    [48, 49, 50, 51, 52, 53, 54].forEach(function (square, bit) {
      if (serial & (1 << bit)) board[square] = 'P';
    });
    [8, 9, 10, 11, 12, 13, 14].forEach(function (square, bit) {
      if (serial & (1 << (bit + 7))) board[square] = 'p';
    });
    const fen = boardToFen(board);
    const clusterId = Corpus.clusterKey(fen);
    const positionFamilyId = Corpus.positionFamilyKey(fen);
    if (syntheticClusterIds.has(clusterId) ||
        syntheticFamilyIds.has(positionFamilyId)) continue;
    syntheticClusterIds.add(clusterId);
    syntheticFamilyIds.add(positionFamilyId);
    return { fen, clusterId, positionFamilyId };
  }
}

function opening(clusterId, openingId) {
  const generated = nextSyntheticOpening();
  return {
    clusterId: generated.clusterId,
    openingId: 'op-' + generated.clusterId,
    fen: generated.fen,
    eco: 'A00',
    openingFamily: 'synthetic-contract-fixture',
    initialBalanceCp: 0,
    sourceRecordIds: [
      SOURCE_NAMESPACE + ':candidate:' +
        E4.sha256('synthetic-record:' + generated.clusterId)
    ],
    sourceGameIds: [
      SOURCE_NAMESPACE + ':game:' +
        E4.sha256('synthetic-game:' + generated.clusterId)
    ],
    positionFamilyIds: [generated.positionFamilyId],
    clusterMembers: [generated.fen]
  };
}

function setFrozenMetadata(manifest) {
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
}

function rehash(manifest) {
  manifest.openingClusters.sort(function (left, right) {
    return left.clusterId < right.clusterId ? -1 :
      left.clusterId > right.clusterId ? 1 : 0;
  });
  manifest.freeze.openingSetSha256 =
    E4.canonicalSha256(manifest.openingClusters);
  manifest.freeze.assignmentSha256 =
    E4.canonicalSha256(manifest.assignments);
  manifest.freeze.contentSha256 = null;
  manifest.manifestId = 'r71-cal-v1/' +
    (manifest.kind === 'certification' ? 'cert/' : 'explore/') +
      manifest.freeze.openingSetSha256;
  manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
  return manifest;
}

function frozenExploration(template) {
  const manifest = clone(template);
  manifest.manifestId = 'r71-cal-v1/explore/synthetic-frozen';
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
      openingId: row.openingId,
      colors: ['white', 'black'],
      games: 2
    });
  });
  return rehash(manifest);
}

function frozenCertification(template) {
  const manifest = clone(template);
  manifest.manifestId = 'r71-cal-v1/cert/synthetic-frozen';
  setFrozenMetadata(manifest);

  [
    E4.LEVELS.find(function (level) { return level.id === 'master'; })
  ].concat(E4.LEVELS.filter(function (level) {
    return level.id !== 'master';
  })).forEach(function (level) {
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
          openingId: row.openingId,
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
        openingId: row.openingId,
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
      'checked-in adapter, protocol, statistics, templates, and r71 WASM pins validate');
  } catch (error) {
    check(false,
      'checked-in adapter, protocol, statistics, templates, and r71 WASM pins validate',
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
  'r71 keeps its embedded fixed engine seed; manifest seeds never enter search');

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
  check(whiteId === 'r71-cal-v1/cert/master/2300/opening-1/' +
    seed + '/white' &&
    blackId === 'r71-cal-v1/cert/master/2300/opening-1/' +
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

  expectThrow('r71 commit drift is rejected',
    /r71 commit drifted/, function () {
      const manifest = clone(templates.exploration);
      manifest.productBaseline.gitCommit = 'b'.repeat(40);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('r71 WASM hash drift is rejected',
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

  expectThrow('frozen manifests reject source-release drift',
    /frozen source must be the preregistered June 2026 Lichess archive/,
    function () {
      const manifest = clone(validExploration);
      manifest.source.release = '2026-05';
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject raw-archive hash drift',
    /raw-archive SHA-256 drifted from the preregistered source/,
    function () {
      const manifest = clone(validExploration);
      manifest.freeze.rawArchiveSha256 = 'f'.repeat(64);
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifest IDs derive from the opening-set hash',
    /manifest ID must derive from its frozen opening-set hash/, function () {
      const manifest = clone(validExploration);
      manifest.manifestId = 'r71-cal-v1/explore/arbitrary';
      manifest.freeze.contentSha256 = null;
      manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen opening clusters require canonical code-point order',
    /openingClusters must be in strict clusterId order/,
    function () {
      const manifest = clone(validExploration);
      manifest.openingClusters.reverse();
      manifest.freeze.openingSetSha256 =
        E4.canonicalSha256(manifest.openingClusters);
      manifest.manifestId = 'r71-cal-v1/explore/' +
        manifest.freeze.openingSetSha256;
      manifest.freeze.contentSha256 = null;
      manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('exploration rejects duplicate declared anchors',
    /duplicate exploration anchor allocation/, function () {
      const manifest = clone(validExploration);
      manifest.schedules[0].anchorAllocation.push(
        clone(manifest.schedules[0].anchorAllocation[0]));
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('exploration rejects opening reuse across schedules',
    /exploration opening cluster is assigned more than once/, function () {
      const manifest = clone(validExploration);
      manifest.assignments[1].openingClusterId =
        manifest.assignments[0].openingClusterId;
      manifest.assignments[1].openingId =
        manifest.assignments[0].openingId;
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('certification enforces the declared Master-first block order',
    /violates Master-first certification block order/, function () {
      const manifest = clone(validCertification);
      const firstNonMaster = manifest.assignments.findIndex(
        function (assignment) {
          return assignment.scheduleKind === 'cert' &&
            assignment.levelOrPair !== 'master';
        });
      const first = manifest.assignments[0];
      manifest.assignments[0] = manifest.assignments[firstNonMaster];
      manifest.assignments[firstNonMaster] = first;
      rehash(manifest);
      E4.validateCertificationManifest(manifest);
    });

  expectThrow('frozen manifests reject opening content after hash drift',
    /opening-set hash drifted/, function () {
      const manifest = clone(validExploration);
      manifest.openingClusters[0].initialBalanceCp = 1;
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject URL-bearing opening-family metadata',
    /without controls or URLs/, function () {
      const manifest = clone(validExploration);
      manifest.openingClusters[0].openingFamily =
        'https://lichess.org/forbidden';
      rehash(manifest);
      E4.validateExplorationManifest(manifest);
    });

  expectThrow('frozen manifests reject a held-out family-only variant',
    /locked Master incident position family/, function () {
      const manifest = clone(validExploration);
      const opening = manifest.openingClusters[0];
      const oldClusterId = opening.clusterId;
      const variant = heldoutFamilyVariant();
      opening.fen = variant;
      opening.clusterMembers = [variant];
      opening.clusterId = Corpus.clusterKey(variant);
      opening.openingId = 'op-' + opening.clusterId;
      opening.positionFamilyIds = [Corpus.positionFamilyKey(variant)];
      manifest.assignments.forEach(function (assignment) {
        if (assignment.openingClusterId === oldClusterId) {
          assignment.openingClusterId = opening.clusterId;
          assignment.openingId = opening.openingId;
        }
      });
      rehash(manifest);
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

  expectThrow('exploration/certification source-game overlap is rejected',
    /source-game overlap/, function () {
      const exploration = clone(validExploration);
      const certification = clone(validCertification);
      certification.openingClusters[0].sourceGameIds =
        exploration.openingClusters[0].sourceGameIds.slice();
      rehash(certification);
      E4.validateManifestSet(exploration, certification);
    });

  expectThrow('exploration/certification source-record overlap is rejected',
    /source-record overlap/, function () {
      const exploration = clone(validExploration);
      const certification = clone(validCertification);
      certification.openingClusters[0].sourceRecordIds =
        exploration.openingClusters[0].sourceRecordIds.slice();
      rehash(certification);
      E4.validateManifestSet(exploration, certification);
    });

  expectThrow('exploration/certification position-family overlap is rejected',
    /position-family overlap/, function () {
      const exploration = clone(validExploration);
      const certification = clone(validCertification);
      const target = certification.openingClusters[0];
      const oldClusterId = target.clusterId;
      const variant = relocateWhiteKnight(
        exploration.openingClusters[0].fen);
      target.fen = variant;
      target.clusterMembers = [variant];
      target.clusterId = Corpus.clusterKey(variant);
      target.openingId = 'op-' + target.clusterId;
      target.positionFamilyIds = [Corpus.positionFamilyKey(variant)];
      certification.assignments.forEach(function (assignment) {
        if (assignment.openingClusterId === oldClusterId) {
          assignment.openingClusterId = target.clusterId;
          assignment.openingId = target.openingId;
        }
      });
      rehash(certification);
      E4.validateManifestSet(exploration, certification);
    });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main();
