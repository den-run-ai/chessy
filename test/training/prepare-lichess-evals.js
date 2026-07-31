#!/usr/bin/env node
/*
 * Stream a pinned Lichess evaluated-position snapshot into deterministic,
 * bounded-size NDJSON shards shared by HCE R3 and NNUE G0/G1.
 *
 * Example (roughly 1% / ~3.9M eligible rows):
 *   node test/training/prepare-lichess-evals.js \
 *     --input /data/lichess_db_eval.jsonl.zst \
 *     --source-sha256 <sha256-of-compressed-file> \
 *     --retrieved 2026-07-29 \
 *     --output /data/chessy-teacher-v1-selection \
 *     --modulus 100 --numerator 1 --family-cap 64 --shards 64
 *
 * The script refuses an unpinned source and an existing output directory.
 * Compressed input requires the `zstd` executable; no archive is downloaded
 * and no training data is written inside the repository by default.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { once } = require('events');
const Corpus = require('./corpus');
const E4 = require('../eval/e4-protocol');

const MECHANISM_FIXTURE_MARKER = Object.freeze({
  status: 'sample-only-not-fit-eligible',
  fitAllowed: false,
  officialEvaluationSnapshot: false
});
const MECHANISM_FIXTURE_SOURCE_ID =
  'chessy-training-mechanism-fixture';
const MECHANISM_FIXTURE_LABEL_TEACHER =
  'mechanism-fixture-placeholder';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error('unexpected argument: ' + argv[i]);
    const name = argv[i].slice(2);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error('--' + name + ' requires a value');
    }
    out[name] = argv[++i];
  }
  return out;
}

function positiveInt(value, name, fallback) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('--' + name + ' must be a positive integer');
  }
  return parsed;
}

function nonNegativeInt(value, name, fallback) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('--' + name + ' must be a non-negative integer');
  }
  return parsed;
}

async function fileSha256(filename) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filename);
  stream.on('data', chunk => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

function inputStream(filename) {
  if (!filename.endsWith('.zst')) {
    return { stream: fs.createReadStream(filename), child: null, done: null };
  }
  const child = spawn('zstd', ['-dc', '--', filename], {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  child.on('error', function (error) {
    if (error.code === 'ENOENT') {
      error.message = 'zstd is required to read .zst input';
    }
  });
  const done = new Promise(function (resolve, reject) {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { stream: child.stdout, child, done };
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateMechanismFixtureMarker(value) {
  const expectedKeys = Object.keys(MECHANISM_FIXTURE_MARKER).sort();
  const actualKeys = value && typeof value === 'object' &&
    !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (stableJson(actualKeys) !== stableJson(expectedKeys) ||
      value.status !== MECHANISM_FIXTURE_MARKER.status ||
      value.fitAllowed !== MECHANISM_FIXTURE_MARKER.fitAllowed ||
      value.officialEvaluationSnapshot !==
        MECHANISM_FIXTURE_MARKER.officialEvaluationSnapshot) {
    throw new Error('mechanism fixture marker is invalid');
  }
  return value;
}

function acquirePrefixLock(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        'another selection run holds the output prefix lock: ' + filename
      );
    }
    throw error;
  }
  try {
    const body = stableJson({
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

function validateHeldoutExclusionPolicy(heldout) {
  const exclusion = heldout && heldout.exclusion;
  const controls = exclusion && exclusion.controls;
  const incident = controls && controls.incidentClusterAndFamily;
  const lineage = controls && controls.sameSourceGameLineage;
  const nearby = controls && controls.nearbyBudgetProbes;
  const expectedApplyBefore = [
    'augmentation',
    'deduplication',
    'split-assignment',
    'exploration-label-use',
    'teacher-relabel',
    'training'
  ];
  if (stableJson(exclusion && exclusion.applyBefore) !==
        stableJson(expectedApplyBefore) ||
      !incident || incident.status !== 'enforced' ||
      !lineage || lineage.status !== 'pending-source-game-id' ||
      lineage.mechanism !== null ||
      !nearby ||
      nearby.trainingStatus !== 'enforced-by-incident-family' ||
      nearby.budgetStatus !== 'preregistered' ||
      stableJson(nearby.nodes) !== stableJson([8268594, 10106060]) ||
      nearby.budgetContract !==
        'eval/training/hce-r3-fit-v1.json#/lockedPostFitGate/nearbyNodes' ||
      nearby.executionEvidenceStatus !== 'pending-post-fit-execution') {
    throw new Error('held-out exclusion control status drifted');
  }
  return Object.freeze({
    incidentFamily: incident.status,
    sameSourceGameLineage: lineage.status,
    nearbyBudgetTraining: nearby.trainingStatus,
    nearbyBudgetPreregistration: nearby.budgetStatus,
    nearbyBudgetNodes: Object.freeze(nearby.nodes.slice()),
    nearbyBudgetContract: nearby.budgetContract,
    nearbyBudgetExecutionEvidence: nearby.executionEvidenceStatus
  });
}

async function closeStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function abortStream(stream) {
  if (stream.closed) return;
  await new Promise(function (resolve) {
    function ignoreCleanupError() {}
    function closed() {
      stream.removeListener('error', ignoreCleanupError);
      resolve();
    }
    stream.on('error', ignoreCleanupError);
    stream.once('close', closed);
    try {
      stream.destroy();
    } catch (_) {
      stream.removeListener('close', closed);
      stream.removeListener('error', ignoreCleanupError);
      resolve();
    }
  });
}

async function prepareLocked(options, output) {
  const input = path.resolve(options.input);
  const expectedSha = String(options['source-sha256'] || '').toLowerCase();
  const retrieved = options.retrieved;
  const modulus = positiveInt(options.modulus, 'modulus', 100);
  const numerator = positiveInt(options.numerator, 'numerator', 1);
  const shardCount = positiveInt(options.shards, 'shards', 64);
  const familyCap = positiveInt(options['family-cap'], 'family-cap', 64);
  const minimumSelected = positiveInt(
    options['minimum-selected'], 'minimum-selected', 1000000);
  const maxMalformedPpm = nonNegativeInt(
    options['max-malformed-ppm'], 'max-malformed-ppm', 1000);
  const requireAllRoles = options['allow-missing-roles'] !== 'true';
  const allowPendingCertification =
    options['allow-pending-certification-for-test'] === 'true';
  if (options['mechanism-fixture'] !== undefined &&
      options['mechanism-fixture'] !== 'true' &&
      options['mechanism-fixture'] !== 'false') {
    throw new Error('--mechanism-fixture must be true or false');
  }
  const mechanismFixture = options['mechanism-fixture'] === 'true';
  if (numerator > modulus) throw new Error('--numerator cannot exceed --modulus');
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new Error('--source-sha256 must be 64 lowercase hexadecimal characters');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrieved || '')) {
    throw new Error('--retrieved must be an ISO date (YYYY-MM-DD)');
  }
  if (!fs.statSync(input).isFile()) throw new Error('--input must name a file');
  if (fs.existsSync(output)) throw new Error('refusing existing --output directory: ' + output);

  const actualSha = await fileSha256(input);
  if (actualSha !== expectedSha) {
    throw new Error('source SHA-256 mismatch: expected ' + expectedSha + ', got ' + actualSha);
  }

  const heldoutPath = path.join(__dirname, '..', '..', 'eval', 'training', 'heldout-v1.json');
  const sourcePolicyPath = path.join(
    __dirname, '..', '..', 'eval', 'training', 'source-manifest.json');
  const sourcePolicyText = fs.readFileSync(sourcePolicyPath, 'utf8');
  const sourcePolicy = JSON.parse(sourcePolicyText);
  const sourceEntry = sourcePolicy.sources.find(function (item) {
    return item.id === 'lichess-evaluations';
  });
  if (!sourceEntry || sourceEntry.disposition !== 'primary' ||
      sourceEntry.license.spdx !== 'CC0-1.0') {
    throw new Error('Lichess evaluations are not primary/CC0 in source policy');
  }
  const heldoutText = fs.readFileSync(heldoutPath, 'utf8');
  const heldout = JSON.parse(heldoutText);
  const heldoutControlStatus = validateHeldoutExclusionPolicy(heldout);
  const certificationPath = path.resolve(
    options['certification-manifest'] || E4.PATHS.certification);
  const certificationText = fs.readFileSync(certificationPath, 'utf8');
  const certification = JSON.parse(certificationText);
  E4.validateCertificationManifest(certification);
  if (certification.status !== 'frozen' && !allowPendingCertification) {
    throw new Error('E4 certification manifest must be frozen before corpus selection');
  }
  if (mechanismFixture &&
      (certification.status !== 'awaiting-opening-freeze' ||
       !allowPendingCertification)) {
    throw new Error(
      'mechanism fixture requires the awaiting-opening-freeze ' +
      'certification and its explicit pending test override'
    );
  }
  const certificationClusters = new Set();
  const certificationFamilies = new Set();
  if (certification.status === 'frozen') {
    certification.openingClusters.forEach(function (opening) {
      certificationClusters.add(Corpus.clusterKey(opening.fen));
      certificationFamilies.add(Corpus.positionFamilyKey(opening.fen));
    });
  }
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'master-e4-regression-20260729.json');
  const fixtureSha = Corpus.sha256(fs.readFileSync(fixturePath));
  if (fixtureSha !== heldout.sourceFixtureSha256) {
    throw new Error('held-out source fixture hash drifted');
  }
  if (Corpus.clusterKey(heldout.incident.fen) !== heldout.symmetryPolicy.clusterSha256 ||
      Corpus.positionFamilyKey(heldout.incident.fen) !==
        heldout.symmetryPolicy.positionFamilySha256) {
    throw new Error('held-out incident keys drifted');
  }

  const nonce =
    process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const staging = output + '.tmp-' + nonce;
  const streams = [];
  const hashes = [];
  const shardRows = new Array(shardCount).fill(0);
  const counts = {
    inputRows: 0,
    malformed: 0,
    noCentipawnLabel: 0,
    scoreExcluded: 0,
    incidentClusterExcluded: 0,
    incidentFamilyExcluded: 0,
    certificationClusterExcluded: 0,
    certificationFamilyExcluded: 0,
    samplingExcluded: 0,
    duplicateClusterExcluded: 0,
    familyCapExcluded: 0,
    selected: 0,
    byRole: {},
    byStratum: {}
  };
  const selectedClusters = new Set();
  const selectedFamilies = new Map();
  let opened = null;
  let streamFailure = null;

  try {
    fs.mkdirSync(staging, { recursive: false });
    for (let i = 0; i < shardCount; i++) {
      const name = 'selection-' + String(i).padStart(3, '0') + '.ndjson';
      const stream =
        fs.createWriteStream(path.join(staging, name), { flags: 'wx' });
      stream.on('error', function (error) {
        if (!streamFailure) streamFailure = error;
      });
      streams.push(stream);
      hashes.push(crypto.createHash('sha256'));
    }
    opened = inputStream(input);
    const lines = readline.createInterface({
      input: opened.stream,
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      counts.inputRows++;
      let raw, adapted;
      try {
        raw = JSON.parse(line);
        adapted = Corpus.adaptLichessRecord(raw, { sha256: expectedSha });
      } catch (error) {
        counts.malformed++;
        continue;
      }
      if (!adapted) {
        const selected = raw && Corpus.chooseLichessEval(raw);
        if (!selected) counts.noCentipawnLabel++;
        else counts.scoreExcluded++;
        continue;
      }
      if (mechanismFixture) {
        adapted = Object.assign({}, adapted, {
          explorationLabel: Object.assign({}, adapted.explorationLabel, {
            teacher: MECHANISM_FIXTURE_LABEL_TEACHER
          }),
          source: {
            dataset: MECHANISM_FIXTURE_SOURCE_ID,
            snapshotSha256: expectedSha,
            license: 'CC0-1.0',
            mechanismFixture:
              Object.assign({}, MECHANISM_FIXTURE_MARKER)
          }
        });
      }
      if (adapted.cluster === heldout.symmetryPolicy.clusterSha256) {
        counts.incidentClusterExcluded++;
        continue;
      }
      if (adapted.positionFamily === heldout.symmetryPolicy.positionFamilySha256) {
        counts.incidentFamilyExcluded++;
        continue;
      }
      if (certificationClusters.has(adapted.cluster)) {
        counts.certificationClusterExcluded++;
        continue;
      }
      if (certificationFamilies.has(adapted.positionFamily)) {
        counts.certificationFamilyExcluded++;
        continue;
      }
      // Sample the model-equivalence cluster, not each source spelling. A
      // cluster with several symmetry/state variants receives one inclusion
      // chance rather than several.
      if (Corpus.selectionCell(adapted.cluster, modulus) >= numerator) {
        counts.samplingExcluded++;
        continue;
      }
      if (selectedClusters.has(adapted.cluster)) {
        counts.duplicateClusterExcluded++;
        continue;
      }
      const familyCount = selectedFamilies.get(adapted.positionFamily) || 0;
      if (familyCount >= familyCap) {
        counts.familyCapExcluded++;
        continue;
      }
      selectedClusters.add(adapted.cluster);
      selectedFamilies.set(adapted.positionFamily, familyCount + 1);

      const shard = parseInt(adapted.id.slice(0, 8), 16) % shardCount;
      const encoded = stableJson(adapted) + '\n';
      if (streamFailure) throw streamFailure;
      if (!streams[shard].write(encoded)) await once(streams[shard], 'drain');
      if (streamFailure) throw streamFailure;
      hashes[shard].update(encoded);
      shardRows[shard]++;
      counts.selected++;
      counts.byRole[adapted.role] = (counts.byRole[adapted.role] || 0) + 1;
      const stratum = adapted.role + '/' + adapted.strata.phase + '/' + adapted.strata.eval;
      counts.byStratum[stratum] = (counts.byStratum[stratum] || 0) + 1;
    }
    if (opened.child) {
      const code = await opened.done;
      if (code !== 0) throw new Error('zstd exited with status ' + code);
    }
    if (streamFailure) throw streamFailure;
    for (const stream of streams) await closeStream(stream);
    if (streamFailure) throw streamFailure;
    if (counts.selected < minimumSelected) {
      throw new Error('selected only ' + counts.selected +
        ' positions; minimum is ' + minimumSelected);
    }
    if (counts.inputRows > 0 &&
        counts.malformed * 1000000 > counts.inputRows * maxMalformedPpm) {
      throw new Error('malformed-row rate exceeds --max-malformed-ppm');
    }
    const roleNames = [
      'shared-train', 'hce-validation', 'hce-test',
      'nnue-validation', 'nnue-test'
    ];
    if (requireAllRoles) {
      const missingRoles = roleNames.filter(role => !counts.byRole[role]);
      if (missingRoles.length) {
        throw new Error('selected corpus is missing roles: ' +
          missingRoles.join(', '));
      }
    }

    const shards = shardRows.map(function (rows, index) {
      return {
        path: 'selection-' + String(index).padStart(3, '0') + '.ndjson',
        rows,
        canonicalNdjsonSha256: hashes[index].digest('hex')
      };
    });
    const wrapperSha256 = Corpus.sha256(fs.readFileSync(__filename));
    const corpusContractPath = path.join(__dirname, 'corpus.js');
    const corpusContractSha256 =
      Corpus.sha256(fs.readFileSync(corpusContractPath));
    const e4ValidatorSha256 = Corpus.sha256(
      fs.readFileSync(path.join(__dirname, '..', 'eval', 'e4-protocol.js')));
    const selectionContract = {
      wrapperSha256,
      corpusContractSha256,
      e4ValidatorSha256,
      heldoutManifestSha256: Corpus.sha256(heldoutText),
      sourcePolicySha256: Corpus.sha256(sourcePolicyText),
      certificationManifestSha256: Corpus.sha256(certificationText)
    };
    if (mechanismFixture) {
      selectionContract.mechanismFixture =
        Object.assign({}, MECHANISM_FIXTURE_MARKER);
    }
    const selectionContractSha256 =
      Corpus.sha256(stableJson(selectionContract));
    const manifest = {
      schemaVersion: 1,
      state: mechanismFixture ?
        'mechanism-test-selection-only' : 'exploration-selection-only',
      finalFitAllowed: false,
      reason: mechanismFixture ?
        'Mechanism fixture only; the source is not an official evaluation ' +
          'snapshot and the records are never fit-eligible.' :
        'Selected records retain mixed upstream Stockfish labels and require pinned-teacher relabelling.',
      source: {
        id: mechanismFixture ?
          MECHANISM_FIXTURE_SOURCE_ID : 'lichess-evaluations',
        url: mechanismFixture ? null : sourceEntry.canonicalUrl,
        retrieved,
        compressedSha256: expectedSha,
        license: 'CC0-1.0'
      },
      adapter: {
        schema: Corpus.SCHEMA,
        wrapperSha256,
        corpusContractSha256,
        e4ValidatorSha256,
        selectionContractSha256,
        sourcePolicySha256: Corpus.sha256(sourcePolicyText),
        sample: { salt: 'e4-v1-sample', modulus, numerator },
        shardCount,
        modelCluster: 'canonical legal symmetry orbit of board-only piece placement',
        roleGroup: 'position-family key',
        positionFamilyCap: familyCap,
        qualityGates: {
          minimumSelected,
          maxMalformedPpm,
          requireAllRoles
        }
      },
      exclusions: {
        manifest: path.relative(path.join(__dirname, '..', '..'), heldoutPath),
        manifestSha256: Corpus.sha256(heldoutText),
        incidentClusterSha256: heldout.symmetryPolicy.clusterSha256,
        incidentPositionFamilySha256: heldout.symmetryPolicy.positionFamilySha256,
        incidentFamilyControlStatus: heldoutControlStatus.incidentFamily,
        sameSourceGameLineageControlStatus:
          heldoutControlStatus.sameSourceGameLineage,
        nearbyBudgetTrainingControlStatus:
          heldoutControlStatus.nearbyBudgetTraining,
        nearbyBudgetPreregistrationStatus:
          heldoutControlStatus.nearbyBudgetPreregistration,
        nearbyBudgetNodes: heldoutControlStatus.nearbyBudgetNodes,
        nearbyBudgetContract: heldoutControlStatus.nearbyBudgetContract,
        nearbyBudgetExecutionEvidenceStatus:
          heldoutControlStatus.nearbyBudgetExecutionEvidence,
        certificationManifest: path.relative(
          path.join(__dirname, '..', '..'), certificationPath),
        certificationManifestSha256: Corpus.sha256(certificationText),
        certificationStatus: certification.status,
        certificationClusterCount: certificationClusters.size,
        certificationPositionFamilyCount: certificationFamilies.size,
        pendingCertificationAllowedForTestOnly: allowPendingCertification,
        appliedBeforeSplit: true
      },
      roles: {
        'shared-train': 'HCE and NNUE training only',
        'hce-validation': 'HCE selection only',
        'hce-test': 'HCE one-time untouched transfer test',
        'nnue-validation': 'NNUE architecture/training selection only',
        'nnue-test': 'NNUE one-time untouched transfer test'
      },
      counts,
      shards
    };
    if (mechanismFixture) {
      manifest.mechanismFixture =
        Object.assign({}, MECHANISM_FIXTURE_MARKER);
      manifest.source.mechanismFixture =
        Object.assign({}, MECHANISM_FIXTURE_MARKER);
    }
    const manifestText = stableJson(manifest) + '\n';
    fs.writeFileSync(path.join(staging, 'manifest.json'), manifestText, { flag: 'wx' });
    if (fs.existsSync(output)) {
      throw new Error(
        'refusing concurrently created --output directory: ' + output
      );
    }
    fs.renameSync(staging, output);
    return manifest;
  } catch (error) {
    if (opened) {
      if (!opened.stream.destroyed) opened.stream.destroy();
      if (opened.child &&
          opened.child.exitCode === null &&
          opened.child.signalCode === null) {
        opened.child.kill('SIGKILL');
      }
      if (opened.done) {
        try { await opened.done; } catch (_) {}
      }
    }
    await Promise.all(streams.map(abortStream));
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function prepare(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('prepare options are required');
  }
  const output = path.resolve(options.output);
  const lockPath = output + '.lock';
  const lockFd = acquirePrefixLock(lockPath);
  try {
    return await prepareLocked(options, output);
  } finally {
    releasePrefixLock(lockFd, lockPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['input', 'source-sha256', 'retrieved', 'output']) {
    if (!args[required]) throw new Error('--' + required + ' is required');
  }
  const manifest = await prepare(args);
  console.log('selected ' + manifest.counts.selected + ' positions into ' +
    manifest.shards.length + ' shards');
  console.log('manifest: ' + path.join(path.resolve(args.output), 'manifest.json'));
  console.log('final fit remains blocked until pinned Stockfish relabelling');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('prepare-lichess-evals: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MECHANISM_FIXTURE_MARKER,
  MECHANISM_FIXTURE_SOURCE_ID,
  MECHANISM_FIXTURE_LABEL_TEACHER,
  parseArgs,
  fileSha256,
  stableJson,
  validateMechanismFixtureMarker,
  acquirePrefixLock,
  releasePrefixLock,
  abortStream,
  validateHeldoutExclusionPolicy,
  prepare
};
