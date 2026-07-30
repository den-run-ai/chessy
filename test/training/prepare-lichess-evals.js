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

async function closeStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function prepare(options) {
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
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
  const certificationPath = path.resolve(
    options['certification-manifest'] || E4.PATHS.certification);
  const certificationText = fs.readFileSync(certificationPath, 'utf8');
  const certification = JSON.parse(certificationText);
  E4.validateCertificationManifest(certification);
  if (certification.status !== 'frozen' && !allowPendingCertification) {
    throw new Error('E4 certification manifest must be frozen before corpus selection');
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

  const staging = output + '.tmp-' + process.pid;
  fs.mkdirSync(staging, { recursive: false });
  const streams = [], hashes = [], shardRows = new Array(shardCount).fill(0);
  for (let i = 0; i < shardCount; i++) {
    const name = 'selection-' + String(i).padStart(3, '0') + '.ndjson';
    streams.push(fs.createWriteStream(path.join(staging, name), { flags: 'wx' }));
    hashes.push(crypto.createHash('sha256'));
  }

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
  const opened = inputStream(input);
  const lines = readline.createInterface({ input: opened.stream, crlfDelay: Infinity });

  try {
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
      if (!streams[shard].write(encoded)) await once(streams[shard], 'drain');
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
    for (const stream of streams) await closeStream(stream);

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
    const selectionContractSha256 = Corpus.sha256(stableJson({
      wrapperSha256,
      corpusContractSha256,
      e4ValidatorSha256,
      heldoutManifestSha256: Corpus.sha256(heldoutText),
      sourcePolicySha256: Corpus.sha256(sourcePolicyText),
      certificationManifestSha256: Corpus.sha256(certificationText)
    }));
    const manifest = {
      schemaVersion: 1,
      state: 'exploration-selection-only',
      finalFitAllowed: false,
      reason: 'Selected records retain mixed upstream Stockfish labels and require pinned-teacher relabelling.',
      source: {
        id: 'lichess-evaluations',
        url: sourceEntry.canonicalUrl,
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
    const manifestText = stableJson(manifest) + '\n';
    fs.writeFileSync(path.join(staging, 'manifest.json'), manifestText, { flag: 'wx' });
    fs.renameSync(staging, output);
    return manifest;
  } catch (error) {
    for (const stream of streams) stream.destroy();
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
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

module.exports = { parseArgs, fileSha256, stableJson, prepare };
