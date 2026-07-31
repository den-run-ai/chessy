#!/usr/bin/env node
/*
 * Re-label one selected NDJSON shard with a single pinned external Stockfish
 * build. Stockfish remains a GPL build-time tool and is never vendored or
 * linked into Chessy's MIT application.
 *
 * Run shards independently, then merge only after every sidecar manifest
 * agrees on teacher identity/options and all expected input hashes are present.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const E4 = require('../eval/e4-protocol');

const ROOT = path.join(__dirname, '..', '..');
const TEACHER_MANIFEST_PATH = path.join(
  ROOT, 'eval', 'training', 'teacher-sf18-100kn-v1.json'
);
const HELDOUT_MANIFEST_PATH = path.join(
  ROOT, 'eval', 'training', 'heldout-v1.json'
);
const PREPARE_PATH = path.join(__dirname, 'prepare-lichess-evals.js');
const CORPUS_PATH = path.join(__dirname, 'corpus.js');
const E4_VALIDATOR_PATH = path.join(__dirname, '..', 'eval', 'e4-protocol.js');
const SOURCE_POLICY_PATH = path.join(
  ROOT, 'eval', 'training', 'source-manifest.json'
);
const ALLOWED_ARGS = new Set([
  'input', 'selection-manifest', 'output', 'stockfish'
]);
const HEX_256 = /^[0-9a-f]{64}$/;
const EXCLUSION_SCHEMA = 'chessy.teacher-exclusion.v1';
const SELECTION_RECORD_FIELDS = Object.freeze([
  'schema', 'id', 'fen', 'canonicalFen', 'cluster', 'role',
  'positionFamily', 'strata', 'explorationLabel', 'source'
]);
const VERIFIED_EXECUTABLE_PREFIX = 'chessy-stockfish-executable-';

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function fileIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function hasIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function cleanupVerifiedExecutable(staged) {
  if (!staged) return;
  let executableStat = null;
  try {
    executableStat = fs.lstatSync(staged.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (executableStat) {
    if (!executableStat.isFile() ||
        !hasIdentity(executableStat, staged.executableIdentity)) {
      throw new Error(
        'refusing to remove replaced verified Stockfish executable'
      );
    }
    fs.unlinkSync(staged.path);
  }
  const directoryStat = fs.lstatSync(staged.directory);
  if (!directoryStat.isDirectory() ||
      !hasIdentity(directoryStat, staged.directoryIdentity)) {
    throw new Error(
      'refusing to remove replaced verified Stockfish directory'
    );
  }
  if (fs.readdirSync(staged.directory).length !== 0) {
    throw new Error(
      'refusing to remove non-empty verified Stockfish directory'
    );
  }
  fs.rmdirSync(staged.directory);
}

function stageVerifiedExecutable(filename, expectedSha256) {
  if (!HEX_256.test(expectedSha256 || '')) {
    throw new Error('expected Stockfish executable SHA-256 is invalid');
  }
  const sourceFd = fs.openSync(filename, 'r');
  let destinationFd = null;
  let staged = null;
  try {
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile()) {
      throw new Error('--stockfish must name an executable file');
    }
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), VERIFIED_EXECUTABLE_PREFIX)
    );
    staged = {
      directory,
      directoryIdentity: fileIdentity(fs.statSync(directory)),
      path: path.join(directory, 'stockfish'),
      executableIdentity: null
    };
    fs.chmodSync(directory, 0o700);
    destinationFd = fs.openSync(staged.path, 'wx', 0o500);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(
        sourceFd, buffer, 0, buffer.length, null
      );
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        written += fs.writeSync(
          destinationFd, buffer, written, read - written
        );
      }
      bytes += read;
    }
    fs.fsyncSync(destinationFd);
    fs.fchmodSync(destinationFd, 0o500);
    staged.executableIdentity =
      fileIdentity(fs.fstatSync(destinationFd));
    fs.closeSync(destinationFd);
    destinationFd = null;
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error(
        'Stockfish executable does not match the checked-in teacher manifest'
      );
    }
    return Object.freeze({
      path: staged.path,
      directory: staged.directory,
      directoryIdentity: staged.directoryIdentity,
      executableIdentity: staged.executableIdentity,
      sha256,
      bytes
    });
  } catch (error) {
    if (destinationFd !== null) {
      try {
        if (staged && !staged.executableIdentity) {
          staged.executableIdentity =
            fileIdentity(fs.fstatSync(destinationFd));
        }
      } catch (_) {}
      try { fs.closeSync(destinationFd); } catch (_) {}
    }
    if (staged) {
      try {
        cleanupVerifiedExecutable(staged);
      } catch (cleanupError) {
        error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error('unexpected argument: ' + item);
    const name = item.slice(2);
    if (!ALLOWED_ARGS.has(name)) {
      throw new Error('unknown or frozen argument: --' + name);
    }
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      throw new Error('duplicate argument: --' + name);
    }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(item + ' requires a value');
    }
    out[name] = argv[++i];
  }
  return out;
}

function parseInfo(line) {
  if (!/^info\s/.test(line)) return null;
  const tokens = line.trim().split(/\s+/);
  const info = {};
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === 'depth') info.depth = Number(tokens[++i]);
    else if (tokens[i] === 'seldepth') info.seldepth = Number(tokens[++i]);
    else if (tokens[i] === 'nodes') info.nodes = Number(tokens[++i]);
    else if (tokens[i] === 'score' && tokens[i + 1] === 'cp') {
      info.cpSideToMove = Number(tokens[i + 2]);
      i += 2;
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') {
        info.scoreBound = tokens[++i];
      }
    } else if (tokens[i] === 'score' && tokens[i + 1] === 'mate') {
      info.mateSideToMove = Number(tokens[i + 2]);
      i += 2;
    } else if (tokens[i] === 'wdl') {
      info.wdlSideToMove = [
        Number(tokens[i + 1]), Number(tokens[i + 2]), Number(tokens[i + 3])
      ];
      i += 3;
    } else if (tokens[i] === 'pv') {
      info.pvUci = tokens.slice(i + 1);
      break;
    }
  }
  return info;
}

function updateLatestScore(latest, line) {
  const parsed = parseInfo(line);
  return parsed && (Number.isFinite(parsed.cpSideToMove) ||
    Number.isFinite(parsed.mateSideToMove)) ? parsed : latest;
}

function whitePov(info, turn) {
  if (!info || !Number.isFinite(info.cpSideToMove) ||
      turn !== 'w' && turn !== 'b') return null;
  if (!Array.isArray(info.wdlSideToMove) ||
      info.wdlSideToMove.length !== 3 ||
      !info.wdlSideToMove.every(value =>
        Number.isSafeInteger(value) && value >= 0)) return null;
  const total = info.wdlSideToMove.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const cpWhite = turn === 'w' ? info.cpSideToMove : -info.cpSideToMove;
  const wdlWhite = turn === 'w' ? info.wdlSideToMove.slice() :
    [info.wdlSideToMove[2], info.wdlSideToMove[1], info.wdlSideToMove[0]];
  return {
    cpWhite,
    wdlWhite,
    targetWhite: (wdlWhite[0] + 0.5 * wdlWhite[1]) / total
  };
}

function ineligible(reason, info, bestMove, terminalInfo) {
  const detail = {};
  if (info) {
    if (Number.isFinite(info.mateSideToMove)) {
      detail.mateSideToMove = info.mateSideToMove;
    } else if (Number.isFinite(info.cpSideToMove)) {
      detail.cpSideToMove = info.cpSideToMove;
    }
    if (info.scoreBound) detail.scoreBound = info.scoreBound;
    if (Number.isFinite(info.nodes)) detail.scoreNodes = info.nodes;
  }
  if (terminalInfo && Number.isFinite(terminalInfo.nodes)) {
    detail.reportedNodes = terminalInfo.nodes;
  }
  if (bestMove) detail.bestMoveUci = bestMove;
  return { eligible: false, reason, detail };
}

function assessTeacherResult(result, turn, teacherManifest) {
  const info = result && result.info;
  const terminalInfo = result && (result.terminalInfo || result.info);
  const bestMove = result && result.bestMove;
  const eligibility = teacherManifest.labels.eligibility;
  const nodeLimit = teacherManifest.search.nodeLimit;
  if (terminalInfo && Number.isFinite(terminalInfo.mateSideToMove)) {
    return ineligible(
      'mate-score', terminalInfo, bestMove, terminalInfo
    );
  }
  if (!info) return ineligible('missing-score', info, bestMove, terminalInfo);
  if (Number.isFinite(info.mateSideToMove)) {
    return ineligible('mate-score', info, bestMove, terminalInfo);
  }
  if (!Number.isSafeInteger(info.cpSideToMove)) {
    return ineligible('missing-cp', info, bestMove, terminalInfo);
  }
  if (info.scoreBound && !eligibility.boundScoresAllowed) {
    return ineligible('bound-score', info, bestMove, terminalInfo);
  }
  if (eligibility.reportedNodesMustMeetOrExceedLimit &&
      (!terminalInfo || !Number.isSafeInteger(terminalInfo.nodes) ||
       terminalInfo.nodes < nodeLimit)) {
    return ineligible(
      'reported-nodes-under-budget', info, bestMove, terminalInfo
    );
  }
  if (!Number.isSafeInteger(info.nodes) || info.nodes <= 0 ||
      !terminalInfo || info.nodes > terminalInfo.nodes) {
    return ineligible(
      'invalid-score-nodes', info, bestMove, terminalInfo
    );
  }
  if (eligibility.wdlRequired &&
      (!Array.isArray(info.wdlSideToMove) ||
       info.wdlSideToMove.length !== 3)) {
    return ineligible('missing-wdl', info, bestMove, terminalInfo);
  }
  const wdlValid = Array.isArray(info.wdlSideToMove) &&
    info.wdlSideToMove.length === 3 &&
    info.wdlSideToMove.every(value =>
      Number.isSafeInteger(value) && value >= 0) &&
    info.wdlSideToMove.reduce((sum, value) => sum + value, 0) ===
      eligibility.wdlTotal;
  if (!wdlValid) {
    return ineligible('invalid-wdl', info, bestMove, terminalInfo);
  }
  if (!Number.isSafeInteger(info.depth) || info.depth <= 0 ||
      !Number.isSafeInteger(info.seldepth) || info.seldepth < info.depth) {
    return ineligible(
      'invalid-search-depth', info, bestMove, terminalInfo
    );
  }
  if (eligibility.bestMoveMustMatchPvHead &&
      (!Array.isArray(info.pvUci) || !info.pvUci.length ||
       info.pvUci[0] !== bestMove)) {
    return ineligible(
      'bestmove-pv-mismatch', info, bestMove, terminalInfo
    );
  }
  const pov = whitePov(info, turn);
  if (!pov || !Number.isFinite(pov.targetWhite) ||
      pov.targetWhite < 0 || pov.targetWhite > 1) {
    return ineligible(
      'invalid-white-pov-target', info, bestMove, terminalInfo
    );
  }
  return { eligible: true, pov };
}

function loadFrozenContracts() {
  const teacherText = fs.readFileSync(TEACHER_MANIFEST_PATH, 'utf8');
  const heldoutText = fs.readFileSync(HELDOUT_MANIFEST_PATH, 'utf8');
  const sourcePolicyText = fs.readFileSync(SOURCE_POLICY_PATH, 'utf8');
  const teacher = JSON.parse(teacherText);
  const heldout = JSON.parse(heldoutText);
  const sourcePolicy = JSON.parse(sourcePolicyText);
  const sourceEntry = Array.isArray(sourcePolicy.sources) &&
    sourcePolicy.sources.find(entry => entry.id === 'lichess-evaluations');
  if (teacher.schemaVersion !== 1 ||
      teacher.id !== 'sf18-100kn-v1' ||
      teacher.status !== 'teacher-identity-frozen' ||
      !teacher.engine ||
      teacher.engine.name !== 'Stockfish 18' ||
      teacher.engine.release !== 'sf_18' ||
      !/^[0-9a-f]{40}$/.test(teacher.engine.sourceCommit || '') ||
      !teacher.engine.archive ||
      !HEX_256.test(teacher.engine.archive.sha256 || '') ||
      !teacher.engine.executable ||
      !HEX_256.test(teacher.engine.executable.sha256) ||
      teacher.engine.license !== 'GPL-3.0-or-later' ||
      teacher.engine.integration !== 'external-build-time-process-only' ||
      teacher.engine.redistributedByChessy !== false ||
      !Number.isSafeInteger(teacher.search.nodeLimit) ||
      teacher.search.nodeLimit <= 0 ||
      teacher.search.command !== 'go nodes ' + teacher.search.nodeLimit ||
      teacher.search.clockLimit !== null ||
      teacher.search.mateRecordsAllowedForFit !== false ||
      !teacher.watchdog ||
      !Number.isSafeInteger(teacher.watchdog.uciStartupTimeoutMs) ||
      teacher.watchdog.uciStartupTimeoutMs <= 0 ||
      !Number.isSafeInteger(teacher.watchdog.readyTimeoutMs) ||
      teacher.watchdog.readyTimeoutMs <= 0 ||
      !Number.isSafeInteger(teacher.watchdog.positionTimeoutMs) ||
      teacher.watchdog.positionTimeoutMs <= 0 ||
      !Number.isSafeInteger(teacher.watchdog.quitTimeoutMs) ||
      teacher.watchdog.quitTimeoutMs <= 0 ||
      teacher.watchdog.failureDisposition !==
        'kill-teacher-and-delete-partial-shard-artifacts' ||
      !teacher.labels || !teacher.labels.eligibility ||
      teacher.labels.enginePov !== 'side-to-move' ||
      teacher.labels.storedPov !== 'white' ||
      !Array.isArray(teacher.labels.fields) ||
      teacher.labels.fields.join(',') !==
        'cpWhite,wdlWhite,targetWhite,bestMoveUci,pvUci,depth,seldepth,scoreNodes,reportedNodes' ||
      teacher.labels.eligibility.scoreKind !== 'exact-cp' ||
      teacher.labels.eligibility.boundScoresAllowed !== false ||
      teacher.labels.eligibility.scoreSelection !==
        'latest-unbounded-exact-cp-info-before-bestmove' ||
      teacher.labels.eligibility.terminalBoundAllowedAsEffortEvidence !== true ||
      teacher.labels.eligibility.scoreNodesMayBeBelowLimit !== true ||
      teacher.labels.eligibility.mateInvalidatesEarlierExactCp !== true ||
      teacher.labels.eligibility.wdlRequired !== true ||
      teacher.labels.eligibility.wdlTotal !== 1000 ||
      teacher.labels.eligibility.reportedNodesMustMeetOrExceedLimit !== true ||
      teacher.labels.eligibility.bestMoveMustMatchPvHead !== true ||
      teacher.labels.eligibility.depthAndSeldepthRequired !== true ||
      teacher.labels.eligibility.ineligibleDisposition !==
        'deterministic-exclusion-ledger' ||
      !teacher.uci ||
      teacher.uci.Threads !== 1 ||
      teacher.uci.Hash !== 64 ||
      teacher.uci.Ponder !== false ||
      teacher.uci.MultiPV !== 1 ||
      teacher.uci.SyzygyPath !== '<empty>' ||
      teacher.uci.UCI_LimitStrength !== false ||
      teacher.uci.UCI_ShowWDL !== true ||
      teacher.uci.ClearHashBeforeEveryPosition !== true ||
      teacher.uci.UciNewGameBeforeEveryPosition !== true ||
      teacher.uci.IsReadyBeforeEveryPosition !== true ||
      !Array.isArray(teacher.engine.networks) ||
      teacher.engine.networks.length !== 2 ||
      !teacher.engine.networks.every(network =>
        typeof network.option === 'string' &&
        typeof network.embeddedName === 'string' &&
        typeof network.exportCommand === 'string' &&
        HEX_256.test(network.sha256 || '') &&
        Number.isSafeInteger(network.bytes) && network.bytes > 0) ||
      !teacher.provenance ||
      teacher.provenance.selectionManifestRequired !== true ||
      teacher.provenance.selectionShardHashRequired !== true ||
      teacher.provenance.selectionContractSha256Required !== true ||
      teacher.provenance.frozenCertificationManifestRequired !== true ||
      !Array.isArray(teacher.provenance.recomputeRecordFields) ||
      teacher.provenance.recomputeRecordFields.join(',') !==
        'id,canonicalFen,cluster,positionFamily,role' ||
      teacher.provenance.rejectHeldoutClusterOrFamily !== true ||
      teacher.provenance.teacherMetadataSource !==
        'this checked-in manifest only') {
    throw new Error('checked-in teacher manifest does not satisfy the frozen label contract');
  }
  if (!sourceEntry || sourceEntry.disposition !== 'primary' ||
      !sourceEntry.license || sourceEntry.license.spdx !== 'CC0-1.0' ||
      typeof sourceEntry.canonicalUrl !== 'string') {
    throw new Error('checked-in Lichess source policy is not primary CC0');
  }
  if (Corpus.clusterKey(heldout.incident.fen) !==
        heldout.symmetryPolicy.clusterSha256 ||
      Corpus.positionFamilyKey(heldout.incident.fen) !==
        heldout.symmetryPolicy.positionFamilySha256) {
    throw new Error('checked-in held-out incident keys drifted');
  }
  return Object.freeze({
    teacher,
    teacherSha256: Corpus.sha256(teacherText),
    heldout,
    heldoutSha256: Corpus.sha256(heldoutText),
    sourceEntry,
    sourcePolicySha256: Corpus.sha256(sourcePolicyText),
    prepareSha256: Corpus.sha256(fs.readFileSync(PREPARE_PATH)),
    corpusSha256: Corpus.sha256(fs.readFileSync(CORPUS_PATH)),
    e4ValidatorSha256: Corpus.sha256(fs.readFileSync(E4_VALIDATOR_PATH))
  });
}

function validateCertificationBinding(manifest, contracts, validationOptions) {
  const exclusions = manifest.exclusions;
  const sampleOnly = validationOptions &&
    validationOptions.sampleOnly === true;
  const allowPendingForTest = validationOptions &&
    validationOptions.allowPendingCertificationForTest === true;
  if (typeof exclusions.certificationManifest !== 'string' ||
      !exclusions.certificationManifest ||
      !HEX_256.test(exclusions.certificationManifestSha256 || '')) {
    throw new Error('selection manifest does not pin an E4 certification manifest');
  }
  const certificationPath = path.resolve(
    ROOT, exclusions.certificationManifest
  );
  if (!fs.statSync(certificationPath).isFile()) {
    throw new Error('selection certification manifest is not a file');
  }
  const certificationText = fs.readFileSync(certificationPath, 'utf8');
  if (Corpus.sha256(certificationText) !==
      exclusions.certificationManifestSha256) {
    throw new Error('selection certification manifest SHA-256 does not match');
  }
  const certification = JSON.parse(certificationText);
  E4.validateCertificationManifest(certification);
  if (certification.status !== exclusions.certificationStatus) {
    throw new Error('selection certification status does not match its manifest');
  }
  if (sampleOnly) {
    if (certification.status !== 'awaiting-opening-freeze' ||
        exclusions.pendingCertificationAllowedForTestOnly !== true) {
      throw new Error(
        'sample-only selection requires the awaiting-opening-freeze ' +
        'certification and pending test override'
      );
    }
  } else if (certification.status !== 'frozen') {
    if (!allowPendingForTest ||
        certification.status !== 'awaiting-opening-freeze' ||
        exclusions.pendingCertificationAllowedForTestOnly !== true) {
      throw new Error(
        'selection manifest requires a frozen E4 certification holdout'
      );
    }
  } else if (exclusions.pendingCertificationAllowedForTestOnly !== false) {
    throw new Error(
      'frozen selection manifest cannot carry the pending-certification test override'
    );
  }
  const clusters = new Set();
  const positionFamilies = new Set();
  certification.openingClusters.forEach(function (opening) {
    clusters.add(Corpus.clusterKey(opening.fen));
    positionFamilies.add(Corpus.positionFamilyKey(opening.fen));
  });
  if (exclusions.certificationClusterCount !== clusters.size ||
      exclusions.certificationPositionFamilyCount !== positionFamilies.size) {
    throw new Error('selection certification holdout counts do not match');
  }
  return Object.freeze({
    path: certificationPath,
    sha256: exclusions.certificationManifestSha256,
    status: certification.status,
    clusters,
    positionFamilies
  });
}

function validateSelectionManifest(
  manifest, manifestPath, input, contracts, validationOptions
) {
  const sampleOnly = validationOptions &&
    validationOptions.sampleOnly === true;
  const expectedState = sampleOnly ?
    'mechanism-test-selection-only' : 'exploration-selection-only';
  if (!manifest || manifest.schemaVersion !== 1 ||
      manifest.state !== expectedState ||
      manifest.finalFitAllowed !== false) {
    throw new Error('selection manifest has the wrong state or schema');
  }
  if (sampleOnly) {
    Prepare.validateMechanismFixtureMarker(manifest.mechanismFixture);
  } else if (Object.prototype.hasOwnProperty.call(
    manifest, 'mechanismFixture'
  )) {
    throw new Error(
      'production selection cannot carry a mechanism fixture marker'
    );
  }
  const expectedSourceKeys = sampleOnly ? [
    'id', 'url', 'retrieved', 'compressedSha256', 'license',
    'mechanismFixture'
  ] : [
    'id', 'url', 'retrieved', 'compressedSha256', 'license'
  ];
  if (!manifest.source ||
      !hasExactKeys(manifest.source, expectedSourceKeys) ||
      manifest.source.id !== (sampleOnly ?
        Prepare.MECHANISM_FIXTURE_SOURCE_ID : 'lichess-evaluations') ||
      manifest.source.url !== (sampleOnly ?
        null : contracts.sourceEntry.canonicalUrl) ||
      manifest.source.license !== contracts.sourceEntry.license.spdx ||
      !/^\d{4}-\d{2}-\d{2}$/.test(manifest.source.retrieved || '') ||
      !HEX_256.test(manifest.source.compressedSha256 || '')) {
    throw new Error('selection manifest has an unpinned or unexpected source');
  }
  if (sampleOnly) {
    Prepare.validateMechanismFixtureMarker(
      manifest.source.mechanismFixture
    );
  }
  if (!manifest.adapter || manifest.adapter.schema !== Corpus.SCHEMA ||
      manifest.adapter.wrapperSha256 !== contracts.prepareSha256 ||
      manifest.adapter.corpusContractSha256 !== contracts.corpusSha256 ||
      manifest.adapter.e4ValidatorSha256 !== contracts.e4ValidatorSha256 ||
      manifest.adapter.sourcePolicySha256 !== contracts.sourcePolicySha256 ||
      manifest.adapter.modelCluster !==
        'canonical legal symmetry orbit of board-only piece placement' ||
      manifest.adapter.roleGroup !== 'position-family key') {
    throw new Error('selection manifest adapter contract or hash does not match');
  }
  if (!manifest.adapter.sample ||
      manifest.adapter.sample.salt !== 'e4-v1-sample' ||
      !Number.isSafeInteger(manifest.adapter.sample.modulus) ||
      manifest.adapter.sample.modulus <= 0 ||
      !Number.isSafeInteger(manifest.adapter.sample.numerator) ||
      manifest.adapter.sample.numerator <= 0 ||
      manifest.adapter.sample.numerator > manifest.adapter.sample.modulus) {
    throw new Error('selection manifest sample contract is invalid');
  }
  if (!manifest.exclusions ||
      manifest.exclusions.appliedBeforeSplit !== true ||
      manifest.exclusions.manifestSha256 !== contracts.heldoutSha256 ||
      manifest.exclusions.incidentClusterSha256 !==
        contracts.heldout.symmetryPolicy.clusterSha256 ||
      manifest.exclusions.incidentPositionFamilySha256 !==
        contracts.heldout.symmetryPolicy.positionFamilySha256) {
    throw new Error('selection manifest does not bind the frozen held-out exclusions');
  }
  const heldoutControlStatus =
    Prepare.validateHeldoutExclusionPolicy(contracts.heldout);
  if (manifest.exclusions.incidentFamilyControlStatus !==
        heldoutControlStatus.incidentFamily ||
      manifest.exclusions.sameSourceGameLineageControlStatus !==
        heldoutControlStatus.sameSourceGameLineage ||
      manifest.exclusions.nearbyBudgetTrainingControlStatus !==
        heldoutControlStatus.nearbyBudgetTraining ||
      manifest.exclusions.nearbyBudgetPreregistrationStatus !==
        heldoutControlStatus.nearbyBudgetPreregistration ||
      Prepare.stableJson(manifest.exclusions.nearbyBudgetNodes) !==
        Prepare.stableJson(heldoutControlStatus.nearbyBudgetNodes) ||
      manifest.exclusions.nearbyBudgetContract !==
        heldoutControlStatus.nearbyBudgetContract ||
      manifest.exclusions.nearbyBudgetExecutionEvidenceStatus !==
        heldoutControlStatus.nearbyBudgetExecutionEvidence) {
    throw new Error('selection manifest misstates held-out control enforcement');
  }
  const certification = validateCertificationBinding(
    manifest, contracts, validationOptions
  );
  const expectedSelectionContract = {
    wrapperSha256: contracts.prepareSha256,
    corpusContractSha256: contracts.corpusSha256,
    e4ValidatorSha256: contracts.e4ValidatorSha256,
    heldoutManifestSha256: contracts.heldoutSha256,
    sourcePolicySha256: contracts.sourcePolicySha256,
    certificationManifestSha256: certification.sha256
  };
  if (sampleOnly) {
    expectedSelectionContract.mechanismFixture =
      Object.assign({}, Prepare.MECHANISM_FIXTURE_MARKER);
  }
  const expectedSelectionContractSha256 =
    Corpus.sha256(Prepare.stableJson(expectedSelectionContract));
  if (manifest.adapter.selectionContractSha256 !==
      expectedSelectionContractSha256) {
    throw new Error('selection manifest aggregate contract SHA-256 does not match');
  }
  if (!Array.isArray(manifest.shards)) {
    throw new Error('selection manifest has no shard list');
  }
  if (!Number.isSafeInteger(manifest.adapter.shardCount) ||
      manifest.adapter.shardCount !== manifest.shards.length ||
      !Number.isSafeInteger(manifest.adapter.positionFamilyCap) ||
      manifest.adapter.positionFamilyCap <= 0) {
    throw new Error('selection manifest shard/family-cap contract is invalid');
  }
  const manifestDirectory = path.dirname(manifestPath);
  const resolvedShardPaths = new Set();
  let totalRows = 0;
  manifest.shards.forEach(function (shard, index) {
    const expectedName =
      'selection-' + String(index).padStart(3, '0') + '.ndjson';
    if (!shard || shard.path !== expectedName ||
        !Number.isSafeInteger(shard.rows) || shard.rows < 0 ||
        !HEX_256.test(shard.canonicalNdjsonSha256 || '')) {
      throw new Error('selection manifest shard metadata is invalid');
    }
    const resolved = path.resolve(manifestDirectory, shard.path);
    if (resolvedShardPaths.has(resolved)) {
      throw new Error('selection manifest contains duplicate shard paths');
    }
    resolvedShardPaths.add(resolved);
    totalRows += shard.rows;
  });
  if (!manifest.counts ||
      !Number.isSafeInteger(manifest.counts.selected) ||
      manifest.counts.selected !== totalRows) {
    throw new Error('selection manifest selected count does not match its shards');
  }
  const matches = manifest.shards.filter(function (shard) {
    return path.resolve(manifestDirectory, shard.path) === input;
  });
  if (matches.length !== 1) {
    throw new Error('input shard is not uniquely listed by the selection manifest');
  }
  const shard = matches[0];
  return Object.freeze({
    shard,
    shardIndex: manifest.shards.indexOf(shard),
    certification,
    sampleOnly
  });
}

async function loadSelectionContextSnapshot(
  manifestFilename, input, contracts, validationOptions, snapshot
) {
  const manifestPath = path.resolve(manifestFilename);
  if (!fs.statSync(manifestPath).isFile()) {
    throw new Error('--selection-manifest must name a file');
  }
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const validated = validateSelectionManifest(
    manifest, manifestPath, input, contracts, validationOptions
  );
  const actualSha256 = await Prepare.snapshotSha256(snapshot);
  if (actualSha256 !== validated.shard.canonicalNdjsonSha256) {
    throw new Error('selection shard SHA-256 does not match its manifest');
  }
  return Object.freeze({
    manifest,
    manifestPath,
    manifestSha256: Corpus.sha256(manifestText),
    shard: validated.shard,
    shardIndex: validated.shardIndex,
    certification: validated.certification,
    sourceSha256: manifest.source.compressedSha256,
    inputSha256: actualSha256,
    inputPath: input,
    sampleOnly: validated.sampleOnly,
    contracts
  });
}

async function loadSelectionContext(
  manifestFilename, input, contracts, validationOptions
) {
  const inputPath = path.resolve(input);
  const snapshot = Prepare.openInputSnapshot(inputPath);
  try {
    return await loadSelectionContextSnapshot(
      manifestFilename,
      inputPath,
      contracts,
      validationOptions,
      snapshot
    );
  } finally {
    Prepare.closeInputSnapshot(snapshot);
  }
}

function validateSelectionRecord(record, context) {
  if (record && typeof record === 'object' &&
      (Object.prototype.hasOwnProperty.call(record, 'teacher') ||
       Object.prototype.hasOwnProperty.call(record, 'sourceExplorationLabel') ||
       Object.prototype.hasOwnProperty.call(record, 'nnue'))) {
    throw new Error('input shard already contains arbitrary teacher metadata');
  }
  if (!hasExactKeys(record, SELECTION_RECORD_FIELDS) ||
      record.schema !== Corpus.SCHEMA ||
      !HEX_256.test(record.id || '') ||
      typeof record.fen !== 'string') {
    throw new Error('input record does not satisfy ' + Corpus.SCHEMA);
  }
  const fen = Corpus.parseFen4(record.fen).fen4;
  if (fen !== record.fen) throw new Error(record.id + ': FEN is not canonical four-field form');
  const cluster = Corpus.clusterKey(fen);
  const positionFamily = Corpus.positionFamilyKey(fen);
  const expected = {
    id: Corpus.sha256(context.sourceSha256 + '\n' + fen),
    canonicalFen: Corpus.canonicalFen4(fen),
    cluster,
    positionFamily,
    role: Corpus.roleForCluster(positionFamily)
  };
  for (const name of Object.keys(expected)) {
    if (record[name] !== expected[name]) {
      throw new Error(record.id + ': recomputed ' + name + ' does not match');
    }
  }
  if (cluster === context.contracts.heldout.symmetryPolicy.clusterSha256 ||
      positionFamily ===
        context.contracts.heldout.symmetryPolicy.positionFamilySha256) {
    throw new Error(record.id + ': held-out incident cluster/family is forbidden');
  }
  if (context.certification.clusters.has(cluster) ||
      context.certification.positionFamilies.has(positionFamily)) {
    throw new Error(record.id + ': E4 certification cluster/family is forbidden');
  }
  const expectedSourceFields = context.sampleOnly ? [
    'dataset', 'snapshotSha256', 'license', 'mechanismFixture'
  ] : [
    'dataset', 'snapshotSha256', 'license'
  ];
  if (!hasExactKeys(record.source, expectedSourceFields) ||
      record.source.dataset !== (context.sampleOnly ?
        Prepare.MECHANISM_FIXTURE_SOURCE_ID :
        'lichess-evaluated-positions') ||
      record.source.snapshotSha256 !== context.sourceSha256 ||
      record.source.license !== context.manifest.source.license) {
    throw new Error(record.id + ': source provenance does not match selection manifest');
  }
  if (context.sampleOnly) {
    Prepare.validateMechanismFixtureMarker(
      record.source.mechanismFixture
    );
  }
  if (!hasExactKeys(record.explorationLabel, [
    'cpWhite', 'depth', 'knodes', 'pvUci', 'teacher'
  ]) ||
      record.explorationLabel.teacher !== (context.sampleOnly ?
        Prepare.MECHANISM_FIXTURE_LABEL_TEACHER :
        'lichess-mixed-stockfish') ||
      !Number.isSafeInteger(record.explorationLabel.cpWhite) ||
      !Number.isSafeInteger(record.explorationLabel.depth) ||
      record.explorationLabel.depth <= 0 ||
      !(record.explorationLabel.knodes === null ||
        Number.isFinite(record.explorationLabel.knodes) &&
        record.explorationLabel.knodes >= 0) ||
      !Array.isArray(record.explorationLabel.pvUci) ||
      !record.explorationLabel.pvUci.every(move =>
        typeof move === 'string' && move.length > 0)) {
    throw new Error(record.id + ': exploration label contract is missing');
  }
  if (!hasExactKeys(record.strata, ['phase', 'eval']) ||
      record.strata.phase !== Corpus.phaseBucket(fen) ||
      record.strata.eval !== Corpus.evalBucket(record.explorationLabel.cpWhite)) {
    throw new Error(record.id + ': recomputed strata do not match');
  }
  if (parseInt(record.id.slice(0, 8), 16) %
      context.manifest.adapter.shardCount !== context.shardIndex) {
    throw new Error(record.id + ': record is assigned to the wrong selection shard');
  }
  return record;
}

class UciEngine {
  constructor(executable, transcript, watchdog, workingDirectory) {
    this.watchdog = watchdog;
    this.exited = false;
    this.exit = null;
    this.stdinError = null;
    const spawnOptions = { stdio: ['pipe', 'pipe', 'inherit'] };
    if (workingDirectory !== undefined) {
      if (typeof workingDirectory !== 'string' || !workingDirectory) {
        throw new Error('Stockfish working directory must be a non-empty path');
      }
      spawnOptions.cwd = workingDirectory;
    }
    this.child = spawn(executable, [], spawnOptions);
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.transcript = transcript || { append: function () {} };
    this.child.stdin.on('error', error => {
      this.stdinError = error;
    });
    this.closed = new Promise(resolve => {
      this.child.once('error', error => {
        this.exited = true;
        this.exit = { code: null, signal: null, error };
        resolve(this.exit);
      });
      this.child.once('close', (code, signal) => {
        this.exited = true;
        this.exit = { code, signal, error: null };
        resolve(this.exit);
      });
    });
  }

  send(command) {
    if (this.exited || this.stdinError || !this.child.stdin.writable) {
      throw this.stdinError ||
        new Error('Stockfish stdin is not writable');
    }
    this.transcript.append('> ' + command);
    this.child.stdin.write(command + '\n');
  }

  forceKill() {
    if (!this.exited && !this.child.killed) {
      this.child.kill('SIGKILL');
    }
  }

  async readUntil(predicate, timeoutMs, phase) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.forceKill();
        throw new Error(
          'Stockfish watchdog timeout waiting for ' + phase
        );
      }
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(function () {
          reject(new Error(
            'Stockfish watchdog timeout waiting for ' + phase
          ));
        }, remaining);
      });
      let next;
      try {
        next = await Promise.race([this.iterator.next(), timeout]);
      } catch (error) {
        this.forceKill();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (next.done) {
        if (this.exit && this.exit.error) throw this.exit.error;
        throw new Error('Stockfish stdout closed unexpectedly');
      }
      const line = next.value;
      this.transcript.append('< ' + line);
      if (predicate(line)) return line;
    }
  }

  async initialize(uci) {
    this.send('uci');
    await this.readUntil(
      line => line === 'uciok',
      this.watchdog.uciStartupTimeoutMs,
      'uciok'
    );
    const options = [
      ['Threads', String(uci.Threads)],
      ['Hash', String(uci.Hash)],
      ['Ponder', String(uci.Ponder)],
      ['MultiPV', String(uci.MultiPV)],
      ['SyzygyPath', String(uci.SyzygyPath)],
      ['UCI_LimitStrength', String(uci.UCI_LimitStrength)],
      ['UCI_ShowWDL', String(uci.UCI_ShowWDL)]
    ];
    for (const [name, value] of options) {
      this.send('setoption name ' + name + ' value ' + value);
    }
    this.send('isready');
    await this.readUntil(
      line => line === 'readyok',
      this.watchdog.readyTimeoutMs,
      'initial readyok'
    );
  }

  async exportNetworks(exportCommand) {
    if (typeof exportCommand !== 'string' ||
        !/^export_net [A-Za-z0-9._-]+ [A-Za-z0-9._-]+$/.test(exportCommand)) {
      throw new Error('Stockfish network export command is not a safe two-file command');
    }
    this.send(exportCommand);
    this.send('isready');
    await this.readUntil(
      line => line === 'readyok',
      this.watchdog.readyTimeoutMs,
      'network export readyok'
    );
    return exportCommand.split(/\s+/).slice(1);
  }

  async label(fen4, nodes, uci) {
    if (uci.UciNewGameBeforeEveryPosition) this.send('ucinewgame');
    if (uci.ClearHashBeforeEveryPosition) {
      this.send('setoption name Clear Hash');
    }
    if (uci.IsReadyBeforeEveryPosition) {
      this.send('isready');
      await this.readUntil(
        line => line === 'readyok',
        this.watchdog.readyTimeoutMs,
        'per-position readyok'
      );
    }
    this.send('position fen ' + fen4 + ' 0 1');
    this.send('go nodes ' + nodes);
    let latestScore = null, latestExactCp = null, latestEffort = null;
    let bestMove = null;
    const deadline = Date.now() + this.watchdog.positionTimeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.forceKill();
        throw new Error('Stockfish watchdog timeout waiting for bestmove');
      }
      const line = await this.readUntil(
        candidate =>
          /^info\s/.test(candidate) || /^bestmove\s/.test(candidate),
        remaining,
        'bestmove'
      );
      if (/^info\s/.test(line)) {
        const parsed = parseInfo(line);
        if (parsed && Number.isSafeInteger(parsed.nodes) &&
            parsed.nodes >= 0 &&
            (!latestEffort || parsed.nodes >= latestEffort.nodes)) {
          latestEffort = parsed;
        }
        if (parsed && (Number.isFinite(parsed.cpSideToMove) ||
            Number.isFinite(parsed.mateSideToMove))) {
          latestScore = parsed;
          if (Number.isFinite(parsed.mateSideToMove)) {
            // A later bound CP cannot make an exact CP from before a mate
            // report current again. Only a newer unbounded CP can do that.
            latestExactCp = null;
          } else if (Number.isFinite(parsed.cpSideToMove) &&
              !parsed.scoreBound) {
            latestExactCp = parsed;
          }
        }
      } else {
        bestMove = line.split(/\s+/)[1];
        break;
      }
    }
    const info = latestScore &&
      Number.isFinite(latestScore.mateSideToMove) ?
      latestScore : latestExactCp;
    return { info, terminalInfo: latestEffort || latestScore, bestMove };
  }

  async waitForClose(timeoutMs, phase) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(function () {
        reject(new Error(
          'Stockfish watchdog timeout waiting for ' + phase
        ));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.closed, timeout]);
    } catch (error) {
      this.forceKill();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async quit() {
    if (!this.exited) {
      this.send('quit');
      this.child.stdin.end();
    }
    let exit;
    try {
      exit = await this.waitForClose(
        this.watchdog.quitTimeoutMs, 'clean shutdown'
      );
    } catch (error) {
      await this.abort();
      throw error;
    }
    if (exit.code !== 0) {
      if (exit.error) throw exit.error;
      throw new Error(
        'Stockfish exited with status ' + exit.code +
        (exit.signal ? ' (' + exit.signal + ')' : '')
      );
    }
  }

  async abort() {
    this.forceKill();
    try {
      await this.waitForClose(
        this.watchdog.quitTimeoutMs, 'forced shutdown'
      );
    } catch (_) {}
  }
}

async function loadRecords(snapshot, context) {
  if (!snapshot || !Number.isInteger(snapshot.fd) || snapshot.closed ||
      path.resolve(snapshot.filename) !== context.inputPath) {
    throw new Error(
      'selection records require the authenticated open shard snapshot'
    );
  }
  const records = [];
  const input = fs.createReadStream(null, {
    fd: snapshot.fd,
    autoClose: true,
    start: 0
  });
  const closed = new Promise(resolve => input.once('close', resolve));
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) {
        throw new Error(
          'selection shard contains a blank row at line ' + lineNumber
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          'selection shard contains invalid JSON at line ' + lineNumber +
          ': ' + error.message
        );
      }
      if (Prepare.stableJson(parsed) !== line) {
        throw new Error(
          'selection shard row is not canonical JSON at line ' + lineNumber
        );
      }
      records.push(validateSelectionRecord(parsed, context));
    }
  } finally {
    lines.close();
    if (!input.destroyed) input.destroy();
    await closed;
    snapshot.closed = true;
  }
  if (records.length !== context.shard.rows) {
    throw new Error(
      'selection shard row count does not match its manifest: ' +
      records.length + ' != ' + context.shard.rows
    );
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const clusters = new Set();
  const familyCounts = new Map();
  for (let i = 1; i < records.length; i++) {
    if (records[i - 1].id === records[i].id) throw new Error('duplicate record id');
  }
  for (const record of records) {
    if (clusters.has(record.cluster)) {
      throw new Error('duplicate model cluster in selection shard');
    }
    clusters.add(record.cluster);
    const count = (familyCounts.get(record.positionFamily) || 0) + 1;
    if (count > context.manifest.adapter.positionFamilyCap) {
      throw new Error('position-family cap exceeded in selection shard');
    }
    familyCounts.set(record.positionFamily, count);
  }
  return records;
}

async function loadSelectionRecords(
  manifestFilename, input, contracts, validationOptions
) {
  const inputPath = path.resolve(input);
  const snapshot = Prepare.openInputSnapshot(inputPath);
  try {
    const context = await loadSelectionContextSnapshot(
      manifestFilename,
      inputPath,
      contracts,
      validationOptions,
      snapshot
    );
    const records = await loadRecords(snapshot, context);
    return Object.freeze({ context, records });
  } finally {
    Prepare.closeInputSnapshot(snapshot);
  }
}

class LineArtifact {
  constructor(filename) {
    this.filename = filename;
    this.fd = fs.openSync(filename, 'wx');
    this.hash = crypto.createHash('sha256');
    this.rows = 0;
    this.summary = null;
  }

  append(line) {
    if (this.fd == null) throw new Error('artifact is already closed');
    const encoded = line + '\n';
    const written = fs.writeSync(this.fd, encoded);
    if (written !== Buffer.byteLength(encoded)) {
      throw new Error('short write while streaming artifact');
    }
    this.hash.update(encoded);
    this.rows++;
  }

  appendObject(value) {
    this.append(Prepare.stableJson(value));
  }

  finish() {
    if (this.summary) return this.summary;
    fs.closeSync(this.fd);
    this.fd = null;
    this.summary = Object.freeze({
      rows: this.rows,
      sha256: this.hash.digest('hex')
    });
    return this.summary;
  }

  abort() {
    if (this.fd != null) {
      try { fs.closeSync(this.fd); } catch (_) {}
      this.fd = null;
    }
    try { fs.unlinkSync(this.filename); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function labelledRecord(record, result, assessment, contracts) {
  const teacher = contracts.teacher;
  const output = Object.assign({}, record, {
    teacher: {
      id: teacher.id,
      release: teacher.engine.release,
      commit: teacher.engine.sourceCommit,
      manifestSha256: contracts.teacherSha256,
      nodes: teacher.search.nodeLimit,
      cpWhite: assessment.pov.cpWhite,
      wdlWhite: assessment.pov.wdlWhite,
      targetWhite: assessment.pov.targetWhite,
      bestMoveUci: result.bestMove,
      pvUci: result.info.pvUci,
      depth: result.info.depth,
      seldepth: result.info.seldepth,
      scoreNodes: result.info.nodes,
      reportedNodes: result.terminalInfo ?
        result.terminalInfo.nodes : result.info.nodes
    }
  });
  delete output.explorationLabel;
  return output;
}

function exclusionRecord(record, assessment, contracts) {
  return {
    schema: EXCLUSION_SCHEMA,
    id: record.id,
    fen: record.fen,
    role: record.role,
    reason: assessment.reason,
    detail: assessment.detail,
    teacher: {
      id: contracts.teacher.id,
      manifestSha256: contracts.teacherSha256,
      nodes: contracts.teacher.search.nodeLimit
    }
  };
}

function refuseExistingArtifacts(paths) {
  const existing = paths.filter(filename => fs.existsSync(filename));
  if (existing.length) {
    throw new Error(
      'refusing to overwrite output artifact: ' + existing.join(', ')
    );
  }
}

function acquirePrefixLock(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        'another Stockfish label run holds the output prefix lock: ' +
        filename
      );
    }
    throw error;
  }
  try {
    const body = Prepare.stableJson({
      pid: process.pid,
      startedAtUtc: new Date().toISOString()
    }) + '\n';
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(filename); } catch (_) {}
    throw error;
  }
}

function releasePrefixLock(fd, filename) {
  try {
    const held = fs.fstatSync(fd);
    let current = null;
    try { current = fs.statSync(filename); } catch (_) {}
    if (current && current.dev === held.dev && current.ino === held.ino) {
      fs.unlinkSync(filename);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function commitNoReplace(temporaryName, filename) {
  try {
    fs.linkSync(temporaryName, filename);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('refusing to overwrite output artifact: ' + filename);
    }
    throw error;
  }
  fs.unlinkSync(temporaryName);
}

function commitLabelArtifacts(temporary, final) {
  commitNoReplace(temporary.output, final.output);
  commitNoReplace(temporary.exclusions, final.exclusions);
  commitNoReplace(temporary.transcript, final.transcript);
  commitNoReplace(temporary.sidecar, final.sidecar);
}

function cleanupTemporaryArtifacts(temporary) {
  for (const filename of Object.values(temporary)) {
    try { fs.unlinkSync(filename); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validateLabelOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('label options are required');
  }
  for (const name of Object.keys(options)) {
    if (!ALLOWED_ARGS.has(name)) {
      throw new Error('unknown or frozen option: ' + name);
    }
  }
  for (const name of ALLOWED_ARGS) {
    if (typeof options[name] !== 'string' || !options[name]) {
      throw new Error('--' + name + ' is required');
    }
  }
}

function sampleOnlyMode(options, subject) {
  if (options === undefined) return false;
  if (!hasExactKeys(options, ['sampleOnly']) ||
      options.sampleOnly !== true) {
    throw new Error(
      subject + ' accepts only the explicit { sampleOnly: true } option'
    );
  }
  return true;
}

function buildSidecarManifest(
  context, paths, summaries, actualExecutableSha, exclusionReasons,
  buildOptions
) {
  const teacher = context.contracts.teacher;
  const sampleOnly = sampleOnlyMode(
    buildOptions, 'teacher sidecar builder'
  );
  if (sampleOnly) {
    if (context.sampleOnly !== true ||
        context.manifest.state !== 'mechanism-test-selection-only' ||
        context.manifest.finalFitAllowed !== false ||
        context.certification.status !== 'awaiting-opening-freeze' ||
        context.manifest.exclusions
          .pendingCertificationAllowedForTestOnly !== true) {
      throw new Error(
        'sample-only teacher sidecar requires a validated mechanism fixture'
      );
    }
    Prepare.validateMechanismFixtureMarker(
      context.manifest.mechanismFixture
    );
  } else {
    if (context.sampleOnly === true ||
        context.manifest.state !== 'exploration-selection-only' ||
        Object.prototype.hasOwnProperty.call(
          context.manifest, 'mechanismFixture'
        )) {
      throw new Error(
        'production teacher sidecar requires a production selection'
      );
    }
    if (context.certification.status !== 'frozen') {
      throw new Error(
        'teacher sidecar requires frozen E4 certification provenance'
      );
    }
  }
  if (actualExecutableSha !== teacher.engine.executable.sha256 ||
      !HEX_256.test(context.manifest.adapter.selectionContractSha256 || '') ||
      !summaries || !summaries.output || !summaries.exclusions ||
      !summaries.transcript ||
      !Number.isSafeInteger(summaries.output.rows) ||
      summaries.output.rows < 0 ||
      !Number.isSafeInteger(summaries.exclusions.rows) ||
      summaries.exclusions.rows < 0 ||
      !HEX_256.test(summaries.output.sha256 || '') ||
      !HEX_256.test(summaries.exclusions.sha256 || '') ||
      !HEX_256.test(summaries.transcript.sha256 || '') ||
      summaries.output.rows + summaries.exclusions.rows !==
        context.shard.rows) {
    throw new Error('teacher sidecar inputs do not satisfy the frozen contract');
  }
  const manifest = {
    schemaVersion: 1,
    state: sampleOnly ?
      'pinned-teacher-labels-sample-only' : 'pinned-teacher-labels',
    input: {
      selectionManifest: {
        path: context.manifestPath,
        sha256: context.manifestSha256,
        selectionContractSha256:
          context.manifest.adapter.selectionContractSha256,
        certificationStatus: context.certification.status
      },
      shard: {
        path: paths.input,
        rows: context.shard.rows,
        sha256: context.inputSha256
      }
    },
    output: {
      path: path.basename(paths.output),
      rows: summaries.output.rows,
      sha256: summaries.output.sha256
    },
    exclusions: {
      path: path.basename(paths.exclusions),
      rows: summaries.exclusions.rows,
      sha256: summaries.exclusions.sha256,
      reasons: exclusionReasons
    },
    teacher: {
      manifest: {
        path: path.relative(ROOT, TEACHER_MANIFEST_PATH),
        sha256: context.contracts.teacherSha256
      },
      id: teacher.id,
      release: teacher.engine.release,
      commit: teacher.engine.sourceCommit,
      executableSha256: actualExecutableSha,
      networks: teacher.engine.networks.map(network => ({
        option: network.option,
        embeddedName: network.embeddedName,
        sha256: network.sha256
      })),
      license: teacher.engine.license,
      use: teacher.engine.integration,
      nodes: teacher.search.nodeLimit,
      options: teacher.uci,
      watchdog: teacher.watchdog,
      scorePovFromEngine: teacher.labels.enginePov,
      storedScorePov: teacher.labels.storedPov,
      transcript: {
        path: path.basename(paths.transcript),
        sha256: summaries.transcript.sha256
      }
    }
  };
  if (sampleOnly) {
    manifest.fitAllowed = false;
    manifest.mechanismFixture =
      Object.assign({}, Prepare.MECHANISM_FIXTURE_MARKER);
  }
  return manifest;
}

async function labelShard(options, runOptions) {
  validateLabelOptions(options);
  const sampleOnly = sampleOnlyMode(runOptions, 'labelShard');
  const contracts = loadFrozenContracts();
  const input = path.resolve(options.input);
  const selectionManifest = path.resolve(options['selection-manifest']);
  const output = path.resolve(options.output);
  const executable = path.resolve(options.stockfish);
  if (!fs.statSync(input).isFile()) throw new Error('--input must name a file');
  const exclusionPath = output + '.exclusions.ndjson';
  const transcriptPath = output + '.uci.log';
  const sidecarPath = output + '.manifest.json';
  const finalArtifacts = {
    output,
    exclusions: exclusionPath,
    transcript: transcriptPath,
    sidecar: sidecarPath
  };
  const lockPath = output + '.lock';
  const lockFd = acquirePrefixLock(lockPath);
  let stagedExecutable = null;
  try {
    refuseExistingArtifacts(Object.values(finalArtifacts));

    const authenticated = await loadSelectionRecords(
      selectionManifest,
      input,
      contracts,
      sampleOnly ? { sampleOnly: true } : undefined
    );
    const context = authenticated.context;
    const records = authenticated.records;
    stagedExecutable = stageVerifiedExecutable(
      executable, contracts.teacher.engine.executable.sha256
    );
    const actualExecutableSha = stagedExecutable.sha256;

    const nonce =
      process.pid + '-' + crypto.randomBytes(8).toString('hex');
    const temporary = {
      output: output + '.tmp-' + nonce,
      exclusions: exclusionPath + '.tmp-' + nonce,
      transcript: transcriptPath + '.tmp-' + nonce,
      sidecar: sidecarPath + '.tmp-' + nonce
    };
    refuseExistingArtifacts(Object.values(temporary));
    let outputWriter = null;
    let exclusionWriter = null;
    let transcriptWriter = null;
    const exclusionReasons = {};
    let engine = null;
    try {
      outputWriter = new LineArtifact(temporary.output);
      exclusionWriter = new LineArtifact(temporary.exclusions);
      transcriptWriter = new LineArtifact(temporary.transcript);
      engine = new UciEngine(
        stagedExecutable.path,
        transcriptWriter,
        contracts.teacher.watchdog
      );
      await engine.initialize(contracts.teacher.uci);
      for (const record of records) {
        const turn = Corpus.parseFen4(record.fen).turn;
        const result = await engine.label(
          record.fen,
          contracts.teacher.search.nodeLimit,
          contracts.teacher.uci
        );
        const assessment = assessTeacherResult(
          result, turn, contracts.teacher
        );
        if (!assessment.eligible) {
          exclusionWriter.appendObject(
            exclusionRecord(record, assessment, contracts)
          );
          exclusionReasons[assessment.reason] =
            (exclusionReasons[assessment.reason] || 0) + 1;
          continue;
        }
        outputWriter.appendObject(
          labelledRecord(record, result, assessment, contracts)
        );
      }
      const quitting = engine;
      engine = null;
      await quitting.quit();

      const outputSummary = outputWriter.finish();
      const exclusionSummary = exclusionWriter.finish();
      const transcriptSummary = transcriptWriter.finish();
      if (outputSummary.rows + exclusionSummary.rows !== records.length) {
        throw new Error('teacher output accounting does not match input rows');
      }
      const manifest = buildSidecarManifest(
        context,
        {
          input,
          output,
          exclusions: exclusionPath,
          transcript: transcriptPath
        },
        {
          output: outputSummary,
          exclusions: exclusionSummary,
          transcript: transcriptSummary
        },
        actualExecutableSha,
        exclusionReasons,
        sampleOnly ? { sampleOnly: true } : undefined
      );
      fs.writeFileSync(
        temporary.sidecar,
        Prepare.stableJson(manifest) + '\n',
        { flag: 'wx' }
      );
      commitLabelArtifacts(temporary, finalArtifacts);
      return manifest;
    } catch (error) {
      if (engine) {
        try { await engine.abort(); } catch (_) {}
      }
      for (const writer of [outputWriter, exclusionWriter, transcriptWriter]) {
        if (!writer) continue;
        try { writer.abort(); } catch (_) {}
      }
      cleanupTemporaryArtifacts(temporary);
      throw error;
    }
  } finally {
    try {
      if (stagedExecutable) {
        cleanupVerifiedExecutable(stagedExecutable);
      }
    } finally {
      releasePrefixLock(lockFd, lockPath);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = ['input', 'selection-manifest', 'output', 'stockfish'];
  for (const name of required) {
    if (!options[name]) throw new Error('--' + name + ' is required');
  }
  const manifest = await labelShard(options);
  console.log('labelled ' + manifest.output.rows + ' positions');
  console.log('excluded ' + manifest.exclusions.rows + ' ineligible positions');
  console.log('output SHA-256 ' + manifest.output.sha256);
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('label-stockfish: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parseInfo,
  updateLatestScore,
  whitePov,
  assessTeacherResult,
  loadFrozenContracts,
  validateSelectionManifest,
  loadSelectionContext,
  loadSelectionRecords,
  validateSelectionRecord,
  UciEngine,
  stageVerifiedExecutable,
  cleanupVerifiedExecutable,
  LineArtifact,
  loadRecords,
  labelledRecord,
  exclusionRecord,
  refuseExistingArtifacts,
  acquirePrefixLock,
  releasePrefixLock,
  commitNoReplace,
  commitLabelArtifacts,
  cleanupTemporaryArtifacts,
  validateLabelOptions,
  sampleOnlyMode,
  buildSidecarManifest,
  labelShard
};
