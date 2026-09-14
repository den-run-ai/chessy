/*
 * Hermetic validator and helpers for the frozen E4-v1 calibration protocol.
 *
 * This module is data-only: it does not run games and is not imported by the
 * shipped app.  The checked-in templates deliberately validate while their
 * status is "awaiting-opening-freeze"; a manifest cannot validate as "frozen"
 * until its literal openings, assignments, provenance hashes, and content hash
 * are present.
 *
 *   node test/eval/e4-protocol.js
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TrainingCorpus = require('../training/corpus.js');

const ROOT = path.join(__dirname, '..', '..');
const E4_DIR = path.join(ROOT, 'eval', 'e4');

const PATHS = Object.freeze({
  adapter: path.join(E4_DIR, 'adapter-v1.json'),
  protocol: path.join(E4_DIR, 'protocol-v1.json'),
  statistics: path.join(E4_DIR, 'stats-v1.json'),
  exploration: path.join(E4_DIR, 'exploration-manifest.template.json'),
  certification: path.join(E4_DIR, 'certification-manifest.template.json'),
  explorationSchema: path.join(E4_DIR, 'exploration-manifest.schema.json'),
  certificationSchema: path.join(E4_DIR, 'certification-manifest.schema.json'),
  wasm: path.join(ROOT, 'assets', 'chessy-ai-fast.wasm')
});

const EXPECTED = Object.freeze({
  adapterSha256: 'dc3a6ac3188ae8a44e10f1dd3ccd06d6a1f4fbf12bcef43fddd31be1190a2381',
  protocolSha256: 'b99204164fd3098a13fe5155f2c82985f4c438d48c8aa6324b036b8516ff7a0b',
  statsSha256: '4decc7bdc4facade1a05c867cec475f6299d8866df1a7c8d9e55e4daacbb6e5b',
  release: 'r71',
  commit: '885e6941bf7fa4478370d759e7034567bf463169',
  wasmAsset: 'assets/chessy-ai-fast.wasm',
  wasmSha256: '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f',
  wasmGitBlob: '97bf60097f5739d101635f143facedb363ce5c8d',
  rootSeedHex: '0x00C0FFEE',
  rootSeedInteger: 12648430,
  anchorCommit: 'cb3d4ee9b47d0c5aae855b12379378ea1439675c',
  anchorArchiveSha256: '536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964',
  stockfishExecutableSha256:
    '6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9',
  stockfishNetworkSha256s: Object.freeze([
    'c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7',
    '37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d'
  ]),
  openingSourceName: 'Lichess database',
  openingSourceRelease: '2026-06',
  openingSourceUrl:
    'https://database.lichess.org/standard/' +
    'lichess_db_standard_rated_2026-06.pgn.zst',
  openingSourceLicense: 'CC0-1.0',
  openingRawArchiveSha256:
    '8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79',
  heldoutFen: 'r4rk1/ppp2ppp/2n5/2b1pb2/8/1P1P1N2/q1PBBPPP/1R1Q1RK1 b - - 0 11'
});

const LEVELS = Object.freeze([
  Object.freeze({
    id: 'easy', productId: '1', label: 'Easy', nominalElo: 1500,
    nodeLimit: 10000, anchors: [1400, 1500, 1600],
    openingClusters: 400, games: 800, allocation: [100, 200, 100],
    gate: 'two-sided-90-percent-rating-interval-within-1400-1600'
  }),
  Object.freeze({
    id: 'medium', productId: '2', label: 'Medium', nominalElo: 1700,
    nodeLimit: 36000, anchors: [1600, 1700, 1800],
    openingClusters: 400, games: 800, allocation: [100, 200, 100],
    gate: 'two-sided-90-percent-rating-interval-within-1600-1800'
  }),
  Object.freeze({
    id: 'hard', productId: '3', label: 'Hard', nominalElo: 1900,
    nodeLimit: 230000, anchors: [1800, 1900, 2000],
    openingClusters: 400, games: 800, allocation: [100, 200, 100],
    gate: 'two-sided-90-percent-rating-interval-within-1800-2000'
  }),
  Object.freeze({
    id: 'expert', productId: '5', label: 'Expert', nominalElo: 2100,
    nodeLimit: 1440000, anchors: [2000, 2100, 2200],
    openingClusters: 400, games: 800, allocation: [100, 200, 100],
    gate: 'two-sided-90-percent-rating-interval-within-2000-2200'
  }),
  Object.freeze({
    id: 'master', productId: 'master', label: 'Master', nominalElo: 2300,
    nodeLimit: null, anchors: [2200, 2300, 2400],
    openingClusters: 800, games: 1600, allocation: [200, 400, 200],
    gate: 'one-sided-95-percent-rating-lower-bound-gte-2300'
  })
]);

const ADJACENT = Object.freeze([
  Object.freeze({ pair: 'easy-medium', weaker: 'easy', stronger: 'medium' }),
  Object.freeze({ pair: 'medium-hard', weaker: 'medium', stronger: 'hard' }),
  Object.freeze({ pair: 'hard-expert', weaker: 'hard', stronger: 'expert' }),
  Object.freeze({ pair: 'expert-master', weaker: 'expert', stronger: 'master' })
]);

const FREEZE_HASH_FIELDS = Object.freeze([
  'contentSha256',
  'openingSetSha256',
  'assignmentSha256',
  'rawArchiveSha256',
  'candidateNdjsonSha256',
  'candidateManifestSha256',
  'selectionCodeSha256',
  'stockfishExecutableSha256'
]);
const OPAQUE_GAME_ID =
  /^chessy\.e4\.lichess-standard-rated\.2026-06:game:[0-9a-f]{64}$/;
const OPAQUE_RECORD_ID =
  /^chessy\.e4\.lichess-standard-rated\.2026-06:candidate:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveLocalRef(schema, rootSchema) {
  if (!schema || typeof schema.$ref !== 'string') return schema;
  const prefix = '#/$defs/';
  assert(schema.$ref.startsWith(prefix),
    'unsupported JSON Schema reference: ' + schema.$ref);
  const name = schema.$ref.slice(prefix.length);
  assert(rootSchema.$defs && rootSchema.$defs[name],
    'missing JSON Schema definition: ' + name);
  return rootSchema.$defs[name];
}

/*
 * The semantic validators below remain the executable protocol oracle. This
 * recursive schema pass additionally makes every `additionalProperties:
 * false` boundary real, so an undeclared scheduler/search control cannot hide
 * outside the canonical manifest contract.
 */
function rejectUndeclaredProperties(value, schema, rootSchema, label) {
  const resolved = resolveLocalRef(schema, rootSchema);
  if (!resolved) return;
  if (Array.isArray(value)) {
    if (resolved.items) {
      value.forEach(function (item, index) {
        rejectUndeclaredProperties(
          item, resolved.items, rootSchema, label + '[' + index + ']');
      });
    }
    return;
  }
  if (!isObject(value) || !resolved.properties) return;
  const allowed = new Set(Object.keys(resolved.properties));
  if (resolved.additionalProperties === false) {
    Object.keys(value).forEach(function (key) {
      assert(allowed.has(key), label + ' contains undeclared property ' + key);
    });
  }
  Object.keys(value).forEach(function (key) {
    if (resolved.properties[key]) {
      rejectUndeclaredProperties(
        value[key], resolved.properties[key], rootSchema, label + '.' + key);
    }
  });
}

function validateSchemaBoundaries(manifest, kind) {
  const schema = readJson(kind === 'exploration' ?
    PATHS.explorationSchema : PATHS.certificationSchema);
  rejectUndeclaredProperties(manifest, schema, schema, kind);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  if (isObject(value)) {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return sha256(stableJson(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifestContentSha256(manifest) {
  const payload = clone(manifest);
  assert(payload.freeze && Object.prototype.hasOwnProperty.call(
    payload.freeze, 'contentSha256'), 'manifest freeze.contentSha256 is missing');
  payload.freeze.contentSha256 = null;
  return canonicalSha256(payload);
}

function deriveScheduleSeed(manifestContentSha256Value, openingId) {
  assert(/^[0-9a-f]{64}$/.test(String(manifestContentSha256Value)),
    'manifest content SHA-256 must be 64 lowercase hexadecimal characters');
  assert(typeof openingId === 'string' && openingId.length > 0 &&
    !openingId.includes('/'), 'opening ID must be a nonempty result-ID segment');
  return sha256(manifestContentSha256Value + openingId + 'E4-v1');
}

function assertSegment(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !value.includes('/'),
    label + ' must be a nonempty result-ID segment');
}

function resultId(options) {
  assert(isObject(options), 'result ID options are required');
  assert(['explore', 'cert', 'adjacent'].includes(options.phase),
    'result phase must be explore, cert, or adjacent');
  assertSegment(options.levelOrPair, 'level-or-pair');
  const anchor = String(options.anchor);
  assertSegment(anchor, 'anchor');
  assertSegment(options.openingId, 'opening ID');
  assert(/^[0-9a-f]{64}$/.test(String(options.seed)),
    'result seed must be a manifest-derived 64-character lowercase SHA-256');
  assert(options.chessyColor === 'white' || options.chessyColor === 'black',
    'Chessy color must be white or black');
  if (options.phase === 'adjacent') {
    assert(anchor === 'direct', 'adjacent result IDs must use the direct anchor token');
  } else {
    assert(/^\d+$/.test(anchor), 'external result IDs must use a numeric anchor');
  }
  return [
    'r71-cal-v1',
    options.phase,
    options.levelOrPair,
    anchor,
    options.openingId,
    options.seed,
    options.chessyColor
  ].join('/');
}

function assertEqual(actual, expected, label) {
  assert(stableJson(actual) === stableJson(expected), label + ' drifted: expected ' +
    stableJson(expected) + ', got ' + stableJson(actual));
}

function assertSha(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    label + ' must be a literal 64-character lowercase SHA-256');
}

function assertGitSha(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
    label + ' must be a literal 40-character lowercase Git commit');
}

function assertBaseline(baseline, label) {
  assert(isObject(baseline), label + ' is missing');
  assert(baseline.release === EXPECTED.release, label + ' release must remain r71');
  assert(baseline.gitCommit === EXPECTED.commit,
    label + ' r71 commit drifted');
  assert(baseline.wasmAsset === EXPECTED.wasmAsset,
    label + ' WASM asset path drifted');
  assert(baseline.wasmSha256 === EXPECTED.wasmSha256,
    label + ' r71 WASM SHA-256 drifted');
}

function expectedAdapterLevels() {
  return LEVELS.map(function (level) {
    const band = level.id === 'master' ?
      {
        lowerElo: 2300,
        upperElo: null,
        interval: 'one-sided-95-percent-lower-bound'
      } :
      {
        lowerElo: level.nominalElo - 100,
        upperElo: level.nominalElo + 100,
        interval: 'two-sided-90-percent'
      };
    const row = {
      id: level.id,
      productId: level.productId,
      label: level.label,
      nominalElo: level.nominalElo,
      shippedSearch: {
        nodeLimit: level.nodeLimit,
        timeLimitMs: 5000
      },
      certificationBand: band
    };
    if (level.id === 'master') row.claim = '2300+';
    return row;
  });
}

function validateAdapter(adapter) {
  assert(isObject(adapter), 'adapter must be an object');
  assert(adapter.schema === 'chessy.e4.calibration-adapter.v1',
    'adapter schema drifted');
  assert(adapter.adapterId === 'E4-v1' && adapter.status === 'frozen',
    'E4-v1 adapter must be frozen');
  assert(adapter.claimScale === 'pinned Stockfish 18 UCI-Elo scale',
    'adapter claim scale drifted');
  assertBaseline(adapter.productBaseline, 'adapter product baseline');
  assert(adapter.productBaseline.wasmGitBlob === EXPECTED.wasmGitBlob,
    'adapter r71 WASM Git blob drifted');
  const search = adapter.searchContract;
  assert(search.maxDepth === 30 && search.iterativeDeepening === true &&
    search.quiesce === true, 'adapter search contract drifted');
  assertEqual(search.engineRootSeed, {
    kind: 'embedded-fixed',
    hex: EXPECTED.rootSeedHex,
    integer: EXPECTED.rootSeedInteger,
    configurable: false,
    acceptedAsSearchInput: false
  }, 'adapter engine root seed');
  assertEqual(adapter.levels, expectedAdapterLevels(), 'adapter levels');
  return true;
}

function expectedExternalSchedules(includeGate) {
  return LEVELS.map(function (level) {
    const schedule = {
      level: level.id,
      openingClusters: level.openingClusters,
      games: level.games,
      colorsPerOpening: 2,
      anchorAllocation: level.anchors.map(function (elo, index) {
        return {
          elo: elo,
          openingClusters: level.allocation[index],
          games: level.allocation[index] * 2
        };
      })
    };
    if (includeGate) schedule.gate = level.gate;
    return schedule;
  });
}

function expectedAdjacentSchedules(protocolShape) {
  return ADJACENT.map(function (row) {
    if (protocolShape) {
      return {
        pair: row.pair,
        weaker: row.weaker,
        stronger: row.stronger,
        openingClusters: 400,
        games: 800,
        colorsPerOpening: 2,
        anchorToken: 'direct'
      };
    }
    return {
      pair: row.pair,
      weaker: row.weaker,
      stronger: row.stronger,
      openingClusters: 400,
      games: 800,
      colorsPerOpening: 2,
      anchor: 'direct',
      gate: 'one-sided-95-percent-opening-cluster-score-lower-bound-gt-50-percent'
    };
  });
}

function validateProtocol(protocol) {
  assert(isObject(protocol), 'protocol must be an object');
  assert(protocol.schema === 'chessy.e4.protocol.v1' &&
    protocol.protocolId === 'E4-v1' && protocol.status === 'frozen',
  'E4-v1 protocol identity/status drifted');
  assert(protocol.claimScale === 'pinned Stockfish 18 UCI-Elo scale',
    'protocol claim scale drifted');
  assertEqual(protocol.adapter, {
    path: 'eval/e4/adapter-v1.json',
    sha256: EXPECTED.adapterSha256
  }, 'protocol adapter pin');
  assertEqual(protocol.statistics, {
    path: 'eval/e4/stats-v1.json',
    sha256: EXPECTED.statsSha256
  }, 'protocol statistics pin');
  assertBaseline(protocol.productBaseline, 'protocol product baseline');
  assert(protocol.productBaseline.wasmGitBlob === EXPECTED.wasmGitBlob &&
    protocol.productBaseline.mutationPolicy === 'unchanged',
  'protocol must preserve the unchanged r71 WASM baseline');

  assertEqual(protocol.seedContracts.engineRoot, {
    kind: 'embedded-fixed',
    hex: EXPECTED.rootSeedHex,
    integer: EXPECTED.rootSeedInteger,
    configurable: false,
    acceptedAsSearchInput: false,
    note: 'The r71 Rust/WASM ABI-v2 has no seed input. Every search uses the embedded root-order seed.'
  }, 'protocol engine root seed');
  const derived = protocol.seedContracts.manifestDerived;
  assert(derived.algorithm === 'SHA-256' &&
    derived.input === 'UTF-8(manifest-content-sha256 || opening-id || E4-v1)' &&
    derived.concatenation === 'raw-without-separators' &&
    derived.output === '64-lowercase-hex' &&
    derived.sharedAcrossOpeningColors === true &&
    derived.searchUse === false,
  'manifest-derived seed contract drifted or entered the search ABI');
  assertEqual(derived.allowedUses, [
    'schedule-order',
    'result-id-seed-segment',
    'bootstrap-cluster-key'
  ], 'manifest-derived seed uses');
  assertEqual(protocol.seedContracts.statisticalBootstrap, {
    rngSeed: 20260730,
    replicates: 10000,
    clusterUnit: 'opening',
    pairedColors: true,
    stratifiedBy: 'schedule-kind/level-or-pair/anchor'
  }, 'bootstrap seed contract');

  assert(protocol.anchor.engine === 'Stockfish 18' &&
    protocol.anchor.releaseTag === 'sf_18' &&
    protocol.anchor.sourceCommit === EXPECTED.anchorCommit &&
    protocol.anchor.archive.name === 'stockfish-ubuntu-x86-64-avx2.tar' &&
    protocol.anchor.archive.sha256 === EXPECTED.anchorArchiveSha256,
  'pinned Stockfish 18 anchor drifted');
  assert(protocol.anchor.executableSha256 ===
    EXPECTED.stockfishExecutableSha256,
  'pinned Stockfish executable SHA-256 drifted');
  assertEqual(protocol.anchor.networkSha256s,
    EXPECTED.stockfishNetworkSha256s,
    'pinned Stockfish EvalFile/EvalFileSmall hashes');
  assertEqual(protocol.anchor.frozenRunHashes, [
    'executableSha256',
    'networkSha256s[EvalFile,EvalFileSmall]'
  ], 'Stockfish executable/network freeze hashes');
  assertEqual(protocol.anchor.uci, {
    UCI_LimitStrength: true,
    Threads: 1,
    Hash: 64,
    Ponder: false,
    MultiPV: 1,
    SyzygyPath: '',
    'Move Overhead': 10
  }, 'Stockfish UCI settings');
  assertEqual(protocol.anchor.uciPerExternalAssignment, {
    UCI_Elo: 'assignment.anchor',
    applyBeforeEveryGame: true,
    adjacentProductMatchesUseAnchorEngine: false
  }, 'per-assignment Stockfish UCI_Elo binding');
  assert(protocol.anchor.go.movetimeMs === 1000 &&
    protocol.anchor.book === 'none', 'Stockfish game search settings drifted');

  assert(protocol.openingPolicy.exploration.fixedGameCount === null &&
    protocol.openingPolicy.exploration.countSpecifiedByProtocol === false &&
    protocol.openingPolicy.exploration.countMustBeDeclaredAndFrozenBeforeRun === true &&
    protocol.openingPolicy.exploration.anchorSelection === 'nearest-only' &&
    protocol.openingPolicy.exploration.mayChangeShippedBudgets === false,
  'exploration must not invent a #87 sample count or alter shipped budgets');
  assert(protocol.openingPolicy.certification.sourceLicense === 'CC0-1.0' &&
    protocol.openingPolicy.certification.untouchedAfterFreeze === true &&
    protocol.openingPolicy.certification.postResultRemoval === false,
  'certification holdout policy drifted');
  assertEqual(protocol.certificationSchedules.external,
    expectedExternalSchedules(false), 'certification external schedules');
  assertEqual(protocol.certificationSchedules.adjacent,
    expectedAdjacentSchedules(true), 'certification adjacent schedules');
  assert(protocol.certificationSchedules.runOrder[0] === 'master',
    'Master certification must run first');

  assert(protocol.resultIdentity.template ===
    'r71-cal-v1/{explore|cert|adjacent}/{level-or-pair}/{anchor}/{opening-id}/{seed}/{chessy-color}' &&
    protocol.resultIdentity.prefix === 'r71-cal-v1' &&
    protocol.resultIdentity.rerunPolicy === 'new-linked-id',
  'immutable result identity contract drifted');
  assert(protocol.adjudication.drawAtPlies === 180 &&
    protocol.adjudication.maximumVoidFraction === 0.01 &&
    protocol.adjudication.invalidateWholeRunAboveMaximum === true,
  'adjudication/void gates drifted');
  assert(protocol.estimation.model === 'Davidson/Bradley-Terry logistic-Elo' &&
    protocol.estimation.contract.path === 'eval/e4/stats-v1.json' &&
    protocol.estimation.contract.sha256 === EXPECTED.statsSha256 &&
    protocol.estimation.bootstrap.replicates === 10000 &&
    protocol.estimation.bootstrap.rngSeed === 20260730 &&
    protocol.estimation.bootstrap.stratifiedBy ===
      'schedule-kind/level-or-pair/anchor' &&
    protocol.estimation.holmFamily.claims === 8,
  'rating estimator/bootstrap/Holm contract drifted');
  assert(protocol.gates.certificationFirst === 'master' &&
    protocol.gates.beforeCertification.includes(
      'issue-84-physical-device-offline-watchdog-memory-battery-thermal-baseline-complete'),
  '#84 and Master-first gates drifted');
  assert(protocol.lockedHeldoutEvidence.fen === EXPECTED.heldoutFen &&
    protocol.lockedHeldoutEvidence.expectedMoveUci === 'e5e4' &&
    protocol.lockedHeldoutEvidence.historicalMoveUci === 'c5d4' &&
    protocol.lockedHeldoutEvidence.nodeGate === 9187327 &&
    protocol.lockedHeldoutEvidence.trainingUse === false &&
    protocol.lockedHeldoutEvidence.mirrorsInTraining === false &&
    protocol.lockedHeldoutEvidence.requireFixDefault === false,
  'locked held-out ...e4 evidence drifted');
  return true;
}

function walkForForbiddenEngineSeed(value, label) {
  if (Array.isArray(value)) {
    value.forEach(function (item, index) {
      walkForForbiddenEngineSeed(item, label + '[' + index + ']');
    });
    return;
  }
  if (!isObject(value)) return;
  Object.keys(value).forEach(function (key) {
    assert(key !== 'engineSeed',
      label + '.' + key + ' is forbidden: r71 has no configurable engine seed');
    walkForForbiddenEngineSeed(value[key], label + '.' + key);
  });
}

function assertManifestCommon(manifest, kind) {
  assert(isObject(manifest), kind + ' manifest must be an object');
  assert(manifest.protocolId === 'E4-v1', kind + ' protocol ID drifted');
  assert(manifest.kind === kind, 'manifest kind must be ' + kind);
  assert(manifest.status === 'awaiting-opening-freeze' ||
    manifest.status === 'frozen', kind + ' manifest status is invalid');
  assert(typeof manifest.manifestId === 'string' &&
    manifest.manifestId.startsWith('r71-cal-v1/' +
      (kind === 'exploration' ? 'explore/' : 'cert/')),
  kind + ' manifest ID must stay in the r71-cal-v1 namespace');
  assertEqual(manifest.protocol, {
    path: 'eval/e4/protocol-v1.json',
    sha256: EXPECTED.protocolSha256
  }, kind + ' protocol file pin');
  assertEqual(manifest.adapter, {
    path: 'eval/e4/adapter-v1.json',
    sha256: EXPECTED.adapterSha256
  }, kind + ' adapter file pin');
  assertBaseline(manifest.productBaseline, kind + ' product baseline');
  assert(manifest.anchorRuntime.engine === 'Stockfish 18' &&
    manifest.anchorRuntime.releaseTag === 'sf_18' &&
    manifest.anchorRuntime.sourceCommit === EXPECTED.anchorCommit &&
    manifest.anchorRuntime.archiveName ===
      'stockfish-ubuntu-x86-64-avx2.tar' &&
    manifest.anchorRuntime.archiveSha256 === EXPECTED.anchorArchiveSha256,
  kind + ' Stockfish anchor runtime drifted');
  assert(Array.isArray(manifest.openingClusters) &&
    Array.isArray(manifest.assignments), kind + ' opening/assignment arrays missing');
  assert(isObject(manifest.freeze), kind + ' freeze block missing');
  walkForForbiddenEngineSeed(manifest, kind);
}

function assertPending(manifest, kind) {
  assert(manifest.freeze.immutable === false,
    kind + ' awaiting manifest cannot claim immutability');
  assert(manifest.freeze.freezeBaseCommit === null,
    kind + ' awaiting manifest cannot claim a freeze commit');
  FREEZE_HASH_FIELDS.forEach(function (field) {
    assert(manifest.freeze[field] === null,
      kind + ' awaiting manifest ' + field + ' must be null');
  });
  assert(manifest.freeze.stockfishNetworkSha256s === null,
    kind + ' awaiting manifest stockfishNetworkSha256s must be null');
  assert(manifest.openingClusters.length === 0 &&
    manifest.assignments.length === 0,
  kind + ' awaiting manifest cannot pretend literal openings are frozen');
}

function validateOpeningClusters(manifest, kind) {
  assert(manifest.openingClusters.length > 0,
    kind + ' frozen manifest needs literal opening clusters');
  const byCluster = new Map();
  const openingIds = new Set();
  const sourceRecordIds = new Set();
  const sourceGameIds = new Set();
  const positionFamilyIds = new Set();
  let priorClusterId = null;
  const heldoutCluster = TrainingCorpus.clusterKey(EXPECTED.heldoutFen);
  const heldoutFamily =
    TrainingCorpus.positionFamilyKey(EXPECTED.heldoutFen);
  manifest.openingClusters.forEach(function (opening, index) {
    const label = kind + ' openingClusters[' + index + ']';
    assert(isObject(opening), label + ' must be an object');
    assertSha(opening.clusterId, label + '.clusterId');
    assert(priorClusterId == null || priorClusterId < opening.clusterId,
      kind + ' openingClusters must be in strict clusterId order');
    priorClusterId = opening.clusterId;
    assertSegment(opening.openingId, label + '.openingId');
    assert(opening.openingId === 'op-' + opening.clusterId,
      label + '.openingId must derive from its cluster ID');
    assert(!byCluster.has(opening.clusterId),
      kind + ' duplicate opening cluster ID: ' + opening.clusterId);
    assert(!openingIds.has(opening.openingId),
      kind + ' duplicate opening ID: ' + opening.openingId);
    assert(typeof opening.fen === 'string' && opening.fen.length > 0,
      label + '.fen is missing');
    const parsedOpening = TrainingCorpus.validateSourceState(opening.fen);
    assert(parsedOpening.fen6 !== null &&
      parsedOpening.fen6 === opening.fen,
    label + '.fen must be a canonical validated six-field FEN');
    const openingPly = parsedOpening.turn === 'w' ?
      2 * (parsedOpening.fullmoveNumber - 1) :
      2 * parsedOpening.fullmoveNumber - 1;
    assert(openingPly >= 12 && openingPly <= 20 &&
      parsedOpening.halfmoveClock <= openingPly,
    label + '.fen counters must derive from candidate ply 12..20');
    const computedCluster = TrainingCorpus.clusterKey(opening.fen);
    assert(opening.clusterId === computedCluster,
      label + '.clusterId does not match its canonical board/symmetry cluster');
    assert(computedCluster !== heldoutCluster,
      label + ' leaks the locked Master incident cluster');
    assert(typeof opening.eco === 'string' &&
      /^[A-E][0-9]{2}$/.test(opening.eco),
    label + '.eco must match [A-E][0-9]{2}');
    assert(typeof opening.openingFamily === 'string' &&
      opening.openingFamily.length > 0 &&
      opening.openingFamily.length <= 256 &&
      opening.openingFamily === opening.openingFamily.trim() &&
      opening.openingFamily.normalize('NFC') === opening.openingFamily &&
      !/[\u0000-\u001f\u007f]/.test(opening.openingFamily) &&
      !/(?:https?:\/\/|lichess\.org\/)/i.test(opening.openingFamily),
    label + '.openingFamily must be trimmed NFC text without controls or URLs');
    assert(Number.isSafeInteger(opening.initialBalanceCp) &&
      Math.abs(opening.initialBalanceCp) <= 200,
    label + '.initialBalanceCp must be an integer in [-200, 200]');
    assert(Array.isArray(opening.sourceRecordIds) &&
      opening.sourceRecordIds.length > 0, label + '.sourceRecordIds is empty');
    assert(Array.isArray(opening.sourceGameIds) &&
      opening.sourceGameIds.length > 0, label + '.sourceGameIds is empty');
    assert(Array.isArray(opening.positionFamilyIds) &&
      opening.positionFamilyIds.length > 0,
    label + '.positionFamilyIds is empty');
    assert(Array.isArray(opening.clusterMembers) &&
      opening.clusterMembers.length > 0, label + '.clusterMembers is empty');
    assert(opening.clusterMembers.includes(opening.fen),
      label + '.clusterMembers must contain the representative FEN');
    [
      ['sourceRecordIds', opening.sourceRecordIds],
      ['sourceGameIds', opening.sourceGameIds],
      ['positionFamilyIds', opening.positionFamilyIds],
      ['clusterMembers', opening.clusterMembers]
    ].forEach(function (entry) {
      const sorted = entry[1].slice().sort();
      assert(stableJson(entry[1]) === stableJson(sorted) &&
        new Set(entry[1]).size === entry[1].length,
      label + '.' + entry[0] + ' must be sorted and unique');
    });
    opening.sourceRecordIds.forEach(function (id) {
      assert(OPAQUE_RECORD_ID.test(id),
        label + '.sourceRecordIds contains a non-opaque ID');
      assert(!sourceRecordIds.has(id),
        kind + ' source record is reused across opening clusters: ' + id);
      sourceRecordIds.add(id);
    });
    opening.sourceGameIds.forEach(function (id) {
      assert(OPAQUE_GAME_ID.test(id),
        label + '.sourceGameIds contains a non-opaque ID');
      assert(!sourceGameIds.has(id),
        kind + ' source game is reused across opening clusters: ' + id);
      sourceGameIds.add(id);
    });
    opening.positionFamilyIds.forEach(function (id) {
      assertSha(id, label + '.positionFamilyIds entry');
      assert(id !== heldoutFamily,
        label + ' leaks the locked Master incident position family');
      assert(!positionFamilyIds.has(id),
        kind + ' position family is reused across opening clusters: ' + id);
      positionFamilyIds.add(id);
    });
    const derivedFamilies = Array.from(new Set(
      opening.clusterMembers.map(function (fen, memberIndex) {
        const parsed = TrainingCorpus.validateSourceState(fen);
        assert(parsed.fen6 !== null && parsed.fen6 === fen,
          label + '.clusterMembers[' + memberIndex +
            '] must be a canonical validated six-field FEN');
        const completedPly = parsed.turn === 'w' ?
          2 * (parsed.fullmoveNumber - 1) :
          2 * parsed.fullmoveNumber - 1;
        assert(completedPly >= 12 && completedPly <= 20 &&
          parsed.halfmoveClock <= completedPly,
        label + '.clusterMembers[' + memberIndex +
          '] counters must derive from candidate ply 12..20');
        return TrainingCorpus.positionFamilyKey(fen);
      })
    )).sort();
    assert(stableJson(opening.positionFamilyIds) ===
      stableJson(derivedFamilies),
    label + '.positionFamilyIds do not derive from clusterMembers');
    byCluster.set(opening.clusterId, opening);
    openingIds.add(opening.openingId);
  });
  return byCluster;
}

function validateAssignmentCommon(assignment, openingByCluster, label) {
  assert(isObject(assignment), label + ' must be an object');
  assertSegment(assignment.openingClusterId, label + '.openingClusterId');
  assertSegment(assignment.openingId, label + '.openingId');
  const opening = openingByCluster.get(assignment.openingClusterId);
  assert(opening, label + ' references an unknown opening cluster');
  assert(opening.openingId === assignment.openingId,
    label + ' opening ID does not match its cluster');
  assertEqual(assignment.colors, ['white', 'black'],
    label + ' paired Chessy colors');
  assert(assignment.games === 2, label + ' must schedule both colors (two games)');
}

function validateFrozenHashes(manifest, kind) {
  assert(manifest.freeze.immutable === true,
    kind + ' frozen manifest must set freeze.immutable=true');
  assertGitSha(manifest.freeze.freezeBaseCommit, kind + ' freeze base commit');
  FREEZE_HASH_FIELDS.forEach(function (field) {
    assertSha(manifest.freeze[field], kind + ' freeze.' + field);
  });
  assert(Array.isArray(manifest.freeze.stockfishNetworkSha256s) &&
    manifest.freeze.stockfishNetworkSha256s.length === 2,
  kind + ' freeze.stockfishNetworkSha256s must contain exactly ' +
    'EvalFile and EvalFileSmall hashes');
  manifest.freeze.stockfishNetworkSha256s.forEach(function (value, index) {
    assertSha(value, kind + ' freeze.stockfishNetworkSha256s[' + index + ']');
  });
  assert(manifest.freeze.stockfishNetworkSha256s[0] !==
    manifest.freeze.stockfishNetworkSha256s[1],
  kind + ' frozen Stockfish network hashes must be distinct');
  assert(manifest.freeze.stockfishExecutableSha256 ===
    EXPECTED.stockfishExecutableSha256,
  kind + ' frozen Stockfish executable hash does not match E4-v1');
  assertEqual(manifest.freeze.stockfishNetworkSha256s,
    EXPECTED.stockfishNetworkSha256s,
    kind + ' frozen Stockfish network hashes do not match E4-v1');
  assert(manifest.freeze.openingSetSha256 ===
    canonicalSha256(manifest.openingClusters),
  kind + ' opening-set hash drifted');
  assert(manifest.manifestId === 'r71-cal-v1/' +
    (kind === 'certification' ? 'cert/' : 'explore/') +
      manifest.freeze.openingSetSha256,
  kind + ' manifest ID must derive from its frozen opening-set hash');
  assert(manifest.freeze.assignmentSha256 ===
    canonicalSha256(manifest.assignments),
  kind + ' assignment hash drifted');
  assert(manifest.freeze.contentSha256 === manifestContentSha256(manifest),
    kind + ' content hash drifted');
}

function validateFrozenOpeningSource(manifest, kind) {
  assert(manifest.source.name === EXPECTED.openingSourceName &&
    manifest.source.release === EXPECTED.openingSourceRelease &&
    manifest.source.url === EXPECTED.openingSourceUrl &&
    manifest.source.license === EXPECTED.openingSourceLicense,
  kind + ' frozen source must be the preregistered June 2026 Lichess archive');
  assert(manifest.freeze.rawArchiveSha256 ===
    EXPECTED.openingRawArchiveSha256,
  kind + ' frozen raw-archive SHA-256 drifted from the preregistered source');
}

function assertAllClustersUsed(openingByCluster, used, kind) {
  assert(used.size === openingByCluster.size,
    kind + ' manifest has unused or multiply-described opening clusters');
  openingByCluster.forEach(function (_, id) {
    assert(used.has(id), kind + ' opening cluster is not assigned: ' + id);
  });
}

function validateExplorationManifest(manifest) {
  validateSchemaBoundaries(manifest, 'exploration');
  assertManifestCommon(manifest, 'exploration');
  assert(manifest.schema === 'chessy.e4.exploration-manifest.v1',
    'exploration schema drifted');
  assert(manifest.source.license === 'CC0-1.0' &&
    manifest.source.selectionPolicy === 'separate-from-certification',
  'exploration source must be a separate CC0 set');
  assertEqual(manifest.schedulePolicy, {
    countSpecifiedByProtocol: false,
    countMustBeFrozenBeforeRun: true,
    colorsPerOpening: 2,
    anchorSelection: 'nearest-only',
    manifestSeedUse: 'schedule-result-bootstrap-only',
    engineSeedOverride: false
  }, 'exploration schedule policy');
  assert(Array.isArray(manifest.schedules) &&
    manifest.schedules.length === LEVELS.length,
  'exploration needs one declared schedule per level');
  manifest.schedules.forEach(function (schedule, index) {
    const level = LEVELS[index];
    assert(schedule.level === level.id,
      'exploration schedule order/level drifted at ' + level.id);
    assertEqual(schedule.allowedAnchors, level.anchors,
      'exploration allowed anchors for ' + level.id);
    if (manifest.status === 'awaiting-opening-freeze') {
      assert(schedule.openingClusters === null && schedule.games === null &&
        Array.isArray(schedule.anchorAllocation) &&
        schedule.anchorAllocation.length === 0,
      'awaiting exploration schedule must not invent counts for ' + level.id);
    }
  });

  if (manifest.status === 'awaiting-opening-freeze') {
    assertPending(manifest, 'exploration');
    return true;
  }

  validateFrozenOpeningSource(manifest, 'exploration');
  const openingByCluster = validateOpeningClusters(manifest, 'exploration');
  const expectedAssignmentBuckets = [];
  let declaredExplorationOpenings = 0;
  manifest.schedules.forEach(function (schedule) {
    assert(Number.isInteger(schedule.openingClusters) &&
      schedule.openingClusters > 0,
    'frozen exploration opening count missing for ' + schedule.level);
    assert(schedule.games === schedule.openingClusters * 2,
      'exploration game count must be two per opening for ' + schedule.level);
    assert(Array.isArray(schedule.anchorAllocation) &&
      schedule.anchorAllocation.length > 0,
    'frozen exploration anchor allocation missing for ' + schedule.level);
    const seenAnchors = new Set();
    let openings = 0;
    schedule.anchorAllocation.forEach(function (allocation) {
      assert(schedule.allowedAnchors.includes(allocation.elo),
        'exploration allocation uses a non-nearest anchor for ' +
          schedule.level);
      assert(!seenAnchors.has(allocation.elo),
        'duplicate exploration anchor allocation for ' + schedule.level +
          '/' + allocation.elo);
      seenAnchors.add(allocation.elo);
      assert(Number.isSafeInteger(allocation.openingClusters) &&
        allocation.openingClusters > 0 &&
        allocation.games === allocation.openingClusters * 2,
      'exploration allocation games/count drifted for ' + schedule.level +
        '/' + allocation.elo);
      openings += allocation.openingClusters;
      for (let index = 0; index < allocation.openingClusters; index++) {
        expectedAssignmentBuckets.push(
          schedule.level + '/' + allocation.elo);
      }
    });
    assert(openings === schedule.openingClusters,
      'exploration anchor allocations do not sum for ' + schedule.level);
    declaredExplorationOpenings += openings;
  });
  assert(manifest.assignments.length === declaredExplorationOpenings &&
    openingByCluster.size === declaredExplorationOpenings,
  'exploration assignments/openings do not match declared schedule totals');
  const used = new Set();
  const seenAssignments = new Set();
  const byLevelAnchor = new Map();
  manifest.assignments.forEach(function (assignment, index) {
    const label = 'exploration assignments[' + index + ']';
    validateAssignmentCommon(assignment, openingByCluster, label);
    const level = LEVELS.find(function (row) {
      return row.id === assignment.level;
    });
    assert(level, label + ' has an unknown level');
    assert(level.anchors.includes(assignment.anchor),
      label + ' uses an anchor outside the nearest-anchor set');
    const bucket = assignment.level + '/' + assignment.anchor;
    assert(expectedAssignmentBuckets[index] === bucket,
      label + ' violates declared level/anchor block order');
    const key = assignment.level + '/' + assignment.anchor + '/' +
      assignment.openingClusterId;
    assert(!seenAssignments.has(key), 'duplicate exploration assignment: ' + key);
    seenAssignments.add(key);
    assert(!used.has(assignment.openingClusterId),
      'exploration opening cluster is assigned more than once: ' +
        assignment.openingClusterId);
    used.add(assignment.openingClusterId);
    byLevelAnchor.set(bucket, (byLevelAnchor.get(bucket) || 0) + 1);
  });
  manifest.schedules.forEach(function (schedule) {
    schedule.anchorAllocation.forEach(function (allocation) {
      assert(byLevelAnchor.get(schedule.level + '/' + allocation.elo) ===
        allocation.openingClusters,
      'exploration assignments do not match allocation for ' + schedule.level +
        '/' + allocation.elo);
    });
  });
  assertAllClustersUsed(openingByCluster, used, 'exploration');
  validateFrozenHashes(manifest, 'exploration');
  return true;
}

function validateCertificationManifest(manifest) {
  validateSchemaBoundaries(manifest, 'certification');
  assertManifestCommon(manifest, 'certification');
  assert(manifest.schema === 'chessy.e4.certification-manifest.v1',
    'certification schema drifted');
  assert(manifest.source.name === 'Lichess database' &&
    manifest.source.license === 'CC0-1.0' &&
    manifest.source.selectionPolicy === 'mechanical-holdout' &&
    manifest.source.untouchedAfterFreeze === true,
  'certification source must be the untouched mechanical Lichess CC0 holdout');
  assertEqual(manifest.source.strata,
    ['ECO', 'opening-family', 'initial-balance'],
    'certification source strata');
  assertEqual(manifest.source.clusterTogether,
    ['mirrors', 'transpositions', 'positions-from-the-same-source-game'],
    'certification clustering policy');
  assertEqual(manifest.schedulePolicy, {
    colorsPerOpening: 2,
    externalAllocation: '25-50-25-percent-by-opening',
    manifestSeedUse: 'schedule-result-bootstrap-only',
    engineSeedOverride: false,
    masterFirst: true,
    postResultRemoval: false
  }, 'certification schedule policy');
  assertEqual(manifest.externalSchedules,
    expectedExternalSchedules(true), 'certification exact external schedules');
  assertEqual(manifest.adjacentSchedules,
    expectedAdjacentSchedules(false), 'certification exact adjacent schedules');

  if (manifest.status === 'awaiting-opening-freeze') {
    assertPending(manifest, 'certification');
    return true;
  }

  validateFrozenOpeningSource(manifest, 'certification');
  const openingByCluster = validateOpeningClusters(manifest, 'certification');
  const used = new Set();
  const seenAssignments = new Set();
  const counts = new Map();
  const clusters = new Map();
  const expectedAssignmentKeys = [];
  const masterFirst = [
    LEVELS.find(function (level) { return level.id === 'master'; })
  ].concat(LEVELS.filter(function (level) {
    return level.id !== 'master';
  }));
  masterFirst.forEach(function (level) {
    level.anchors.forEach(function (anchor, anchorIndex) {
      for (let index = 0; index < level.allocation[anchorIndex]; index++) {
        expectedAssignmentKeys.push('cert/' + level.id + '/' + anchor);
      }
    });
  });
  ADJACENT.forEach(function (pair) {
    for (let index = 0; index < 400; index++) {
      expectedAssignmentKeys.push('adjacent/' + pair.pair + '/direct');
    }
  });

  manifest.assignments.forEach(function (assignment, index) {
    const label = 'certification assignments[' + index + ']';
    validateAssignmentCommon(assignment, openingByCluster, label);
    let key;
    if (assignment.scheduleKind === 'cert') {
      const level = LEVELS.find(function (row) {
        return row.id === assignment.levelOrPair;
      });
      assert(level, label + ' has an unknown certification level');
      assert(Number.isInteger(assignment.anchor) &&
        level.anchors.includes(assignment.anchor),
      label + ' has an invalid certification anchor');
      key = 'cert/' + level.id + '/' + assignment.anchor;
    } else {
      assert(assignment.scheduleKind === 'adjacent',
        label + ' has an invalid schedule kind');
      const pair = ADJACENT.find(function (row) {
        return row.pair === assignment.levelOrPair;
      });
      assert(pair, label + ' has an unknown adjacent pair');
      assert(assignment.anchor === 'direct',
        label + ' adjacent anchor must be direct');
      key = 'adjacent/' + pair.pair + '/direct';
    }
    assert(expectedAssignmentKeys[index] === key,
      label + ' violates Master-first certification block order');
    const unique = key + '/' + assignment.openingClusterId;
    assert(!seenAssignments.has(unique),
      'duplicate certification assignment: ' + unique);
    seenAssignments.add(unique);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!clusters.has(key)) clusters.set(key, new Set());
    clusters.get(key).add(assignment.openingClusterId);
    assert(!used.has(assignment.openingClusterId),
      'certification opening cluster is assigned more than once: ' +
        assignment.openingClusterId);
    used.add(assignment.openingClusterId);
  });

  LEVELS.forEach(function (level) {
    level.anchors.forEach(function (anchor, index) {
      const key = 'cert/' + level.id + '/' + anchor;
      assert(counts.get(key) === level.allocation[index],
        'certification allocation mismatch for ' + level.id + '/' + anchor);
      assert(clusters.get(key).size === level.allocation[index],
        'certification opening-cluster count mismatch for ' +
        level.id + '/' + anchor);
    });
    const levelClusters = new Set();
    level.anchors.forEach(function (anchor) {
      clusters.get('cert/' + level.id + '/' + anchor).forEach(function (id) {
        levelClusters.add(id);
      });
    });
    assert(levelClusters.size === level.openingClusters,
      'certification anchors reuse or omit openings for ' + level.id);
  });
  ADJACENT.forEach(function (pair) {
    const key = 'adjacent/' + pair.pair + '/direct';
    assert(counts.get(key) === 400 && clusters.get(key).size === 400,
      'adjacent schedule must contain 400 paired openings for ' + pair.pair);
  });
  assert(manifest.assignments.length === 4000,
    'certification must contain 4,000 paired assignments / 8,000 games');
  assertAllClustersUsed(openingByCluster, used, 'certification');
  validateFrozenHashes(manifest, 'certification');
  return true;
}

function validateManifestSet(exploration, certification) {
  validateExplorationManifest(exploration);
  validateCertificationManifest(certification);
  const explorationIds = new Set(exploration.openingClusters.map(function (row) {
    return row.clusterId;
  }));
  const explorationGames = new Set(exploration.openingClusters.flatMap(
    function (row) { return row.sourceGameIds; }));
  const explorationRecords = new Set(exploration.openingClusters.flatMap(
    function (row) { return row.sourceRecordIds; }));
  const explorationFamilies = new Set(exploration.openingClusters.flatMap(
    function (row) { return row.positionFamilyIds; }));
  certification.openingClusters.forEach(function (row) {
    assert(!explorationIds.has(row.clusterId),
      'exploration/certification opening cluster ID overlap: ' + row.clusterId);
    row.sourceGameIds.forEach(function (id) {
      assert(!explorationGames.has(id),
        'exploration/certification source-game overlap: ' + id);
    });
    row.sourceRecordIds.forEach(function (id) {
      assert(!explorationRecords.has(id),
        'exploration/certification source-record overlap: ' + id);
    });
    row.positionFamilyIds.forEach(function (id) {
      assert(!explorationFamilies.has(id),
        'exploration/certification position-family overlap: ' + id);
    });
  });
  return true;
}

function validateRepository(root) {
  const repositoryRoot = root || ROOT;
  const e4 = path.join(repositoryRoot, 'eval', 'e4');
  const files = {
    adapter: path.join(e4, 'adapter-v1.json'),
    protocol: path.join(e4, 'protocol-v1.json'),
    statistics: path.join(e4, 'stats-v1.json'),
    exploration: path.join(e4, 'exploration-manifest.template.json'),
    certification: path.join(e4, 'certification-manifest.template.json'),
    wasm: path.join(repositoryRoot, EXPECTED.wasmAsset)
  };
  const adapterBytes = fs.readFileSync(files.adapter);
  const protocolBytes = fs.readFileSync(files.protocol);
  assert(sha256(adapterBytes) === EXPECTED.adapterSha256,
    'frozen E4-v1 adapter file SHA-256 drifted');
  assert(sha256(protocolBytes) === EXPECTED.protocolSha256,
    'frozen E4-v1 protocol file SHA-256 drifted');
  assert(sha256(fs.readFileSync(files.statistics)) === EXPECTED.statsSha256,
    'frozen E4-v1 statistics contract SHA-256 drifted');
  assert(sha256(fs.readFileSync(files.wasm)) === EXPECTED.wasmSha256,
    'checked-in r71 WASM bytes drifted');
  const adapter = JSON.parse(adapterBytes.toString('utf8'));
  const protocol = JSON.parse(protocolBytes.toString('utf8'));
  const exploration = readJson(files.exploration);
  const certification = readJson(files.certification);
  validateAdapter(adapter);
  validateProtocol(protocol);
  validateManifestSet(exploration, certification);
  return { adapter, protocol, exploration, certification };
}

module.exports = Object.freeze({
  EXPECTED,
  LEVELS,
  ADJACENT,
  PATHS,
  readJson,
  sha256,
  stableJson,
  canonicalSha256,
  manifestContentSha256,
  deriveScheduleSeed,
  resultId,
  validateAdapter,
  validateProtocol,
  validateExplorationManifest,
  validateCertificationManifest,
  validateManifestSet,
  validateRepository
});

if (require.main === module) {
  try {
    const validated = validateRepository();
    console.log('E4-v1 adapter/protocol valid; exploration and certification ' +
      'manifests are ' + validated.exploration.status + '.');
  } catch (error) {
    console.error('FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  }
}
