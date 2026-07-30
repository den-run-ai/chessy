/*
 * Contract tests for immutable E4-v1 certification results and statistics.
 *
 *   node test/eval/e4-stats.test.js
 */
'use strict';

const fs = require('fs');
const E4 = require('./e4-protocol.js');
const Stats = require('./e4-stats.js');
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

function nextSyntheticOpening(openingId) {
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
    const familyId = Corpus.positionFamilyKey(fen);
    if (syntheticClusterIds.has(clusterId) ||
        syntheticFamilyIds.has(familyId)) continue;
    syntheticClusterIds.add(clusterId);
    syntheticFamilyIds.add(familyId);
    return {
      clusterId,
      openingId: 'op-' + clusterId,
      fen,
      eco: 'A00',
      openingFamily: 'synthetic-stats-fixture',
      initialBalanceCp: 0,
      sourceRecordIds: [
        SOURCE_NAMESPACE + ':candidate:' +
          E4.sha256('synthetic-stats-record:' + clusterId)
      ],
      sourceGameIds: [
        SOURCE_NAMESPACE + ':game:' +
          E4.sha256('synthetic-stats-game:' + clusterId)
      ],
      positionFamilyIds: [familyId],
      clusterMembers: [fen]
    };
  }
}

function rehashManifest(manifest) {
  manifest.openingClusters.sort(function (left, right) {
    return left.clusterId < right.clusterId ? -1 :
      left.clusterId > right.clusterId ? 1 : 0;
  });
  manifest.freeze.openingSetSha256 =
    E4.canonicalSha256(manifest.openingClusters);
  manifest.freeze.assignmentSha256 =
    E4.canonicalSha256(manifest.assignments);
  manifest.freeze.contentSha256 = null;
  manifest.manifestId = 'r69-cal-v1/cert/' +
    manifest.freeze.openingSetSha256;
  manifest.freeze.contentSha256 = E4.manifestContentSha256(manifest);
  return manifest;
}

function frozenCertification() {
  const manifest = E4.readJson(E4.PATHS.certification);
  manifest.manifestId = 'r69-cal-v1/cert/synthetic-stats';
  manifest.status = 'frozen';
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
  [
    E4.LEVELS.find(function (level) { return level.id === 'master'; })
  ].concat(E4.LEVELS.filter(function (level) {
    return level.id !== 'master';
  })).forEach(function (level) {
    level.anchors.forEach(function (anchor, anchorIndex) {
      const count = level.allocation[anchorIndex];
      for (let index = 0; index < count; index++) {
        const openingId = 'cert-' + level.id + '-' + anchor + '-' + index;
        const opening = nextSyntheticOpening(openingId);
        manifest.openingClusters.push(opening);
        manifest.assignments.push({
          scheduleKind: 'cert',
          levelOrPair: level.id,
          anchor,
          openingClusterId: opening.clusterId,
          openingId: opening.openingId,
          colors: ['white', 'black'],
          games: 2
        });
      }
    });
  });
  E4.ADJACENT.forEach(function (pair) {
    for (let index = 0; index < 400; index++) {
      const openingId = 'adjacent-' + pair.pair + '-' + index;
      const opening = nextSyntheticOpening(openingId);
      manifest.openingClusters.push(opening);
      manifest.assignments.push({
        scheduleKind: 'adjacent',
        levelOrPair: pair.pair,
        anchor: 'direct',
        openingClusterId: opening.clusterId,
        openingId: opening.openingId,
        colors: ['white', 'black'],
        games: 2
      });
    }
  });
  return rehashManifest(manifest);
}

const TRUE_RATINGS = Object.freeze({
  easy: 1500,
  medium: 1700,
  hard: 1900,
  expert: 2100,
  master: 2425
});

function outcomeForAssignment(assignment, localIndex, subjectColor) {
  const offset = subjectColor === 'white' ? 11 : 53;
  const unit = ((localIndex * 37 + offset) % 100 + 0.5) / 100;
  if (assignment.scheduleKind === 'adjacent') {
    if (unit < 0.55) return 'win';
    if (unit < 0.85) return 'draw';
    return 'loss';
  }
  const probability = Stats.davidsonProbabilities(
    TRUE_RATINGS[assignment.levelOrPair],
    assignment.anchor,
    20,
    Math.log(2),
    subjectColor);
  if (unit < probability.win) return 'win';
  if (unit < probability.win + probability.draw) return 'draw';
  return 'loss';
}

function rehashBundle(bundle) {
  bundle.rowsSha256 = Stats.bundleRowsSha256(bundle.rows);
  bundle.contentSha256 = null;
  bundle.contentSha256 = Stats.bundleContentSha256(bundle);
  return bundle;
}

function resultBundle(manifest, requestedPhase) {
  const analysisPhase = requestedPhase || 'full-certification';
  const loaded = Stats.readStatsContract();
  const counters = new Map();
  const rows = [];
  manifest.assignments.forEach(function (assignment) {
    const included = analysisPhase === 'full-certification' ||
      (analysisPhase === 'master-first' &&
        assignment.scheduleKind === 'cert' &&
        assignment.levelOrPair === 'master');
    if (!included) return;
    const key = assignment.scheduleKind + '/' + assignment.levelOrPair + '/' +
      assignment.anchor;
    const localIndex = counters.get(key) || 0;
    counters.set(key, localIndex + 1);
    const pair = assignment.scheduleKind === 'adjacent' ?
      E4.ADJACENT.find(item => item.pair === assignment.levelOrPair) : null;
    const subject = assignment.scheduleKind === 'cert' ?
      assignment.levelOrPair : pair.stronger;
    const phase = assignment.scheduleKind === 'cert' ? 'cert' : 'adjacent';
    const seed = E4.deriveScheduleSeed(
      manifest.freeze.contentSha256, assignment.openingId);
    assignment.colors.forEach(function (subjectColor) {
      const outcome = outcomeForAssignment(
        assignment, localIndex, subjectColor);
      rows.push({
        schema: loaded.contract.resultBundle.rowSchema,
        resultId: E4.resultId({
          phase,
          levelOrPair: assignment.levelOrPair,
          anchor: assignment.anchor,
          openingId: assignment.openingId,
          seed,
          chessyColor: subjectColor
        }),
        manifestId: manifest.manifestId,
        manifestContentSha256: manifest.freeze.contentSha256,
        scheduleKind: assignment.scheduleKind,
        levelOrPair: assignment.levelOrPair,
        anchor: assignment.anchor,
        openingClusterId: assignment.openingClusterId,
        openingId: assignment.openingId,
        seed,
        subject,
        subjectColor,
        outcome,
        termination: outcome === 'draw' ? 'repetition' : 'checkmate',
        immutable: true
      });
    });
  });
  rows.sort((a, b) => Stats.compareCodePoints(a.resultId, b.resultId));
  return rehashBundle({
    schema: loaded.contract.resultBundle.schema,
    protocolId: 'E4-v1',
    analysisPhase,
    statsContractSha256: loaded.sha256,
    manifestId: manifest.manifestId,
    manifestContentSha256: manifest.freeze.contentSha256,
    immutable: true,
    complete: true,
    removedResultIds: [],
    rowsSha256: null,
    rows,
    contentSha256: null
  });
}

function changedBundle(bundle, index, changes) {
  const changed = Object.assign({}, bundle, {
    removedResultIds: bundle.removedResultIds.slice(),
    rows: bundle.rows.slice()
  });
  if (index != null) {
    changed.rows[index] = Object.assign({}, changed.rows[index], changes);
  }
  return rehashBundle(changed);
}

function main() {
  const loaded = Stats.readStatsContract();
  const protocol = E4.readJson(E4.PATHS.protocol);
  check(loaded.contract.status === 'frozen' &&
    protocol.statistics.sha256 === loaded.sha256 &&
    protocol.estimation.contract.sha256 === loaded.sha256 &&
    protocol.estimation.bootstrap.replicates === 10000,
  'protocol pins the frozen exact-10,000 statistics contract');

  const equal = Stats.davidsonProbabilities(
    2300, 2300, 0, Math.log(2), 'white');
  check(Math.abs(equal.win - 0.25) < 1e-15 &&
    Math.abs(equal.draw - 0.5) < 1e-15 &&
    Math.abs(equal.loss - 0.25) < 1e-15,
  'Davidson nu=2 gives 25/50/25 at equal logistic-Elo ability');

  check(Stats.quantileType7([0, 10], 0.25) === 2.5 &&
    Stats.quantileType7([0, 10], 0.95) === 9.5,
  'bootstrap quantiles use the frozen R type 7 interpolation');

  const streamSeed = Stats.deriveStreamSeed(20260730, 'external-ratings');
  const rng = new Stats.XorShift32(streamSeed);
  const sequence = [
    rng.nextUint32(),
    rng.nextUint32(),
    rng.nextUint32()
  ];
  check(streamSeed === Stats.deriveStreamSeed(20260730, 'external-ratings') &&
    sequence.join(',') === '2371879311,660947911,1822518633',
  'SHA-256 stream derivation and xorshift32 sequence are deterministic',
  streamSeed + ': ' + sequence.join(','));

  const manifest = frozenCertification();
  const bundle = resultBundle(manifest);
  let validated;
  try {
    validated = Stats.validateCertificationResults(manifest, bundle);
    check(validated.openingClusters.length === 4000 &&
      validated.rows.length === 8000 &&
      validated.total.wins + validated.total.draws +
        validated.total.losses === 8000,
    'complete immutable paired results validate and aggregate to 4,000 clusters');
  } catch (error) {
    check(false, 'complete immutable paired results validate and aggregate to 4,000 clusters',
      String(error && error.message || error));
  }

  const masterBundle = resultBundle(manifest, 'master-first');
  let masterValidated;
  try {
    masterValidated = Stats.validateCertificationResults(
      manifest, masterBundle);
    check(masterValidated.analysisPhase === 'master-first' &&
      masterValidated.openingClusters.length === 800 &&
      masterValidated.rows.length === 1600 &&
      masterValidated.openingClusters.every(cluster =>
        cluster.scheduleKind === 'cert' &&
        cluster.levelOrPair === 'master'),
    'Master-first completeness is exactly 800 assignments and 1,600 paired games');
  } catch (error) {
    check(false,
      'Master-first completeness is exactly 800 assignments and 1,600 paired games',
      String(error && error.message || error));
  }

  let masterFirstReport;
  try {
    masterFirstReport = Stats.analyzeMasterFirst(manifest, masterBundle);
    check(masterFirstReport.analysisPhase === 'master-first' &&
      masterFirstReport.inputs.assignments === 800 &&
      masterFirstReport.inputs.games === 1600 &&
      masterFirstReport.bootstrap.replicates === 10000 &&
      Object.keys(masterFirstReport.externalAnchorModel.ratings).join(',') ===
        'master' &&
      masterFirstReport.master.pass === true,
    'Master-first runs its own Master/color/draw fit and exact 10,000 bootstrap gate');
  } catch (error) {
    check(false,
      'Master-first runs its own Master/color/draw fit and exact 10,000 bootstrap gate',
      String(error && error.stack || error));
  }

  expectThrow('Master-first results cannot masquerade as the full certification',
    /analysisPhase=full-certification/, function () {
      Stats.analyzeCertification(manifest, masterBundle);
    });
  const missingMaster = Object.assign({}, masterBundle, {
    rows: masterBundle.rows.slice(1)
  });
  rehashBundle(missingMaster);
  expectThrow('Master-first still fails closed on one missing game',
    /expected 1600, got 1599/, function () {
      Stats.validateCertificationResults(manifest, missingMaster);
    });

  const missing = Object.assign({}, bundle, {
    rows: bundle.rows.slice(1)
  });
  rehashBundle(missing);
  expectThrow('a missing scheduled game fails closed',
    /missing or unexpected games/, function () {
      Stats.validateCertificationResults(manifest, missing);
    });

  const duplicate = Object.assign({}, bundle, {
    rows: bundle.rows.slice(1)
  });
  duplicate.rows.push(clone(bundle.rows[1]));
  duplicate.rows.sort((a, b) =>
    Stats.compareCodePoints(a.resultId, b.resultId));
  rehashBundle(duplicate);
  expectThrow('a duplicate result ID fails closed',
    /duplicate or not in canonical|duplicate result ID/, function () {
      Stats.validateCertificationResults(manifest, duplicate);
    });

  const reordered = Object.assign({}, bundle, {
    rows: bundle.rows.slice()
  });
  [reordered.rows[0], reordered.rows[1]] =
    [reordered.rows[1], reordered.rows[0]];
  rehashBundle(reordered);
  expectThrow('result rows must retain canonical immutable order',
    /not in canonical ascending resultId order/, function () {
      Stats.validateCertificationResults(manifest, reordered);
    });

  const removed = Object.assign({}, bundle, {
    removedResultIds: [bundle.rows[0].resultId],
    rows: bundle.rows
  });
  rehashBundle(removed);
  expectThrow('a posthoc-removed result fails closed',
    /posthoc-removed results are forbidden/, function () {
      Stats.validateCertificationResults(manifest, removed);
    });

  const mismatch = changedBundle(bundle, 0, { subject: 'wrong-level' });
  expectThrow('a row that disagrees with its frozen assignment fails closed',
    /subject does not match the frozen assignment/, function () {
      Stats.validateCertificationResults(manifest, mismatch);
    });

  const badTermination = changedBundle(bundle, 0, {
    outcome: 'draw',
    termination: 'checkmate'
  });
  expectThrow('termination and subject outcome must agree',
    /checkmate must be decisive/, function () {
      Stats.validateCertificationResults(manifest, badTermination);
    });

  const tampered = Object.assign({}, bundle, {
    rows: bundle.rows.slice()
  });
  tampered.rows[0] = Object.assign({}, tampered.rows[0], { outcome: 'loss' });
  expectThrow('row tampering without a new bundle hash is rejected',
    /row SHA-256 mismatch/, function () {
      Stats.validateCertificationResults(manifest, tampered);
    });

  const pending = E4.readJson(E4.PATHS.certification);
  expectThrow('statistics refuse an awaiting-opening-freeze manifest',
    /require a frozen certification manifest/, function () {
      Stats.validateCertificationResults(pending, bundle);
    });

  const pValues = [0.001, 0.006, 0.02, 0.04, 0.2, 0.3, 0.4, 0.5];
  const holm = Stats.holmStepDown(Stats.CLAIM_ORDER.map(function (id, index) {
    return { id, rawPValue: pValues[index] };
  }), 0.05);
  check(holm[0].rejected === true &&
    holm[1].rejected === true &&
    holm.slice(2).every(row => row.rejected === false) &&
    holm[0].threshold === 0.05 / 8,
  'Holm step-down stops at the first failed ordered claim');
  expectThrow('Holm cannot be weakened to an incomplete claim family',
    /complete frozen eight-claim family/, function () {
      Stats.holmStepDown([
        { id: 'easy-medium', rawPValue: 0.01 }
      ], 0.05);
    });

  let report;
  const started = Date.now();
  try {
    report = Stats.analyzeCertification(manifest, bundle);
    check(report.bootstrap.replicates === 10000 &&
      report.inputs.games === 8000 &&
      report.inputs.openingClusters === 4000 &&
      report.externalAnchorModel.converged === true &&
      Number.isFinite(report.master.oneSided95LowerBoundElo),
    'full certification analysis fits all anchors and exactly 10,000 cluster replicates');
  } catch (error) {
    check(false,
      'full certification analysis fits all anchors and exactly 10,000 cluster replicates',
      String(error && error.stack || error));
  }

  if (report) {
    console.log('  info fitted external model ' +
      E4.stableJson(report.externalAnchorModel));
    check(E4.LEVELS.every(level =>
      Math.abs(report.externalAnchorModel.ratings[level.id] -
        TRUE_RATINGS[level.id]) < 10) &&
      Math.abs(report.externalAnchorModel.colorEffectElo - 20) < 5 &&
      Math.abs(report.externalAnchorModel.drawParameterNu - 2) < 0.05,
    'joint Davidson MLE recovers level, color, and draw parameters');
    check(report.master.pass === true &&
      report.master.oneSided95LowerBoundElo >= 2300,
    'synthetic 2425-Elo Master clears the one-sided 95% 2300 gate',
    E4.stableJson(report.master));
    check(report.bands.every(row => row.pass) &&
      report.adjacent.every(row => row.pass) &&
      report.holm.claims.length === 8,
    'lower-level bands and adjacent claims pass their basic intervals and Holm family');
    check(report.runtimeFilesChanged === false &&
      report.statsContractSha256 === loaded.sha256 &&
      /^[0-9a-f]{64}$/.test(report.estimatorSourceSha256) &&
      /^[0-9a-f]{64}$/.test(report.analysisContentSha256),
    'analysis report pins contract, implementation, inputs, and runtime-neutral status');
    console.log('  info exact bootstrap analysis completed in ' +
      (Date.now() - started) + ' ms');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main();
