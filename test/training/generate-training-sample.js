#!/usr/bin/env node
/*
 * Generate a small, external, mechanism-test corpus through the real
 * selection -> pinned Stockfish -> HCE/NNUE trust-boundary path.
 *
 * The input is a deterministic wire-format fixture derived from checked-in
 * CC0 opening positions. It is deliberately not represented as an official
 * Lichess evaluated-position snapshot and its output is never fit-eligible.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');
const HceStream = require('./hce-r3-pack-stream');

const ROOT = path.join(__dirname, '..', '..');
const ROLES = Object.freeze([
  'shared-train',
  'hce-validation',
  'hce-test',
  'nnue-validation',
  'nnue-test'
]);
const SAMPLE_PROFILES = Object.freeze({
  smoke: Object.freeze(Object.fromEntries(
    ROLES.map(role => [role, 2])
  )),
  preliminary: Object.freeze({
    'shared-train': 18,
    'hce-validation': 4,
    'hce-test': 9,
    'nnue-validation': 2,
    'nnue-test': 7
  })
});
const LABELLED_PROFILES = Object.freeze({
  smoke: SAMPLE_PROFILES.smoke,
  preliminary: Object.freeze({
    'shared-train': 17,
    'hce-validation': 4,
    'hce-test': 9,
    'nnue-validation': 2,
    'nnue-test': 7
  })
});
const EXPECTED_EXCLUSIONS = Object.freeze({
  smoke: 0,
  preliminary: 1
});
const EXPECTED_EXCLUSION_REASONS = Object.freeze({
  smoke: Object.freeze({}),
  preliminary: Object.freeze({
    'bestmove-pv-mismatch': 1
  })
});

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['stockfish', 'output', 'profile']);
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      throw new Error('unexpected argument: ' + item);
    }
    const name = item.slice(2);
    if (!allowed.has(name)) throw new Error('unknown argument: ' + item);
    if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new Error('duplicate argument: ' + item);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(item + ' requires a value');
    }
    result[name] = argv[++index];
  }
  for (const name of ['stockfish', 'output']) {
    if (!result[name]) throw new Error('--' + name + ' is required');
  }
  if (!result.profile) result.profile = 'smoke';
  if (!Object.prototype.hasOwnProperty.call(SAMPLE_PROFILES, result.profile)) {
    throw new Error('--profile must be smoke or preliminary');
  }
  return result;
}

function fileSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function writeJsonExclusive(filename, value) {
  fs.writeFileSync(filename, Prepare.stableJson(value) + '\n', { flag: 'wx' });
}

function writeJsonSuccessMarker(filename, value) {
  const temporary = filename + '.tmp-' + process.pid + '-' +
    crypto.randomBytes(8).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, Prepare.stableJson(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(temporary, filename);
    fs.unlinkSync(temporary);
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function openingWireFixture(profile) {
  const profileName = profile || 'smoke';
  const target = SAMPLE_PROFILES[profileName];
  if (!target) throw new Error('unknown sample profile: ' + profileName);
  const corpusPath = path.join(ROOT, 'eval', 'corpus', 'eval-v1.ndjson');
  const selected = Object.fromEntries(ROLES.map(role => [role, []]));
  const clusters = new Set();
  const families = new Set();
  const rows = fs.readFileSync(corpusPath, 'utf8').trim().split('\n');
  for (const line of rows) {
    const record = JSON.parse(line);
    if (record.license !== 'CC0-1.0' ||
        record.source_url !==
          'https://raw.githubusercontent.com/lichess-org/chess-openings/master' ||
        !record.assert || record.assert.notTerminal !== true) {
      continue;
    }
    let parsed;
    try {
      parsed = Corpus.validateSourceState(record.fen);
    } catch (_) {
      continue;
    }
    const cluster = Corpus.clusterKey(parsed.fen4);
    const family = Corpus.positionFamilyKey(parsed.fen4);
    const role = Corpus.roleForCluster(family);
    if (selected[role].length >= target[role] ||
        clusters.has(cluster) || families.has(family)) {
      continue;
    }
    clusters.add(cluster);
    families.add(family);
    selected[role].push({
      sourceId: record.source_id,
      fen: parsed.fen4,
      wire: {
        fen: parsed.fen4,
        evals: [{
          depth: 1,
          knodes: 0,
          pvs: [{ cp: 0, line: '' }]
        }]
      }
    });
  }
  const missing = ROLES.filter(role =>
    selected[role].length !== target[role]
  );
  if (missing.length) {
    throw new Error(
      'checked-in CC0 opening fixture lacks ' + profileName +
        ' role coverage: ' + missing.join(', ')
    );
  }
  const flat = ROLES.flatMap(role => selected[role]);
  return {
    corpusPath,
    profile: profileName,
    sourceIds: flat.map(item => item.sourceId),
    rows: flat.map(item => item.wire)
  };
}

function readNdjson(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  if (!text) return [];
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
}

function runNnueValidation(teacherPath) {
  const python = process.env.PYTHON || 'python3';
  const result = spawnSync(python, [
    path.join(ROOT, 'tools', 'training', 'train-nnue.py'),
    '--validate-inputs',
    '--sample-only',
    '--train', teacherPath,
    '--validation', teacherPath
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'NNUE input validation failed: ' + (result.stderr || result.stdout).trim()
    );
  }
  return JSON.parse(result.stdout);
}

async function writeHceRole(teacherPath, role, filename) {
  const fd = fs.openSync(filename, 'wx');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    const provenance = await HceStream.streamRows({
      input: [teacherPath],
      role,
      sampleOnly: true
    }, function (text) {
      const encoded = Buffer.from(text);
      const written = fs.writeSync(fd, encoded);
      if (written !== encoded.length) {
        throw new Error('short write while generating HCE sample rows');
      }
      hash.update(encoded);
      bytes += encoded.length;
      return Promise.resolve();
    });
    fs.closeSync(fd);
    const output = {
      path: path.basename(filename),
      rows: provenance.rows,
      bytes,
      sha256: hash.digest('hex')
    };
    writeJsonExclusive(filename + '.manifest.json', {
      schemaVersion: 1,
      status: 'sample-only-not-fit-eligible',
      fitAllowed: false,
      role,
      output,
      provenance
    });
    return Object.assign({}, output, {
      status: provenance.status,
      fitAllowed: provenance.fitAllowed
    });
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(filename); } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    throw error;
  }
}

function roleCounts(records) {
  const counts = Object.fromEntries(ROLES.map(role => [role, 0]));
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(counts, record.role)) {
      counts[record.role]++;
    }
  }
  return counts;
}

function expectedRoleCounts(profile) {
  const profileName = profile || 'smoke';
  const counts = SAMPLE_PROFILES[profileName];
  if (!counts) throw new Error('unknown sample profile: ' + profileName);
  return Object.assign({}, counts);
}

function expectedLabelledRoleCounts(profile) {
  const profileName = profile || 'smoke';
  const counts = LABELLED_PROFILES[profileName];
  if (!counts) throw new Error('unknown sample profile: ' + profileName);
  return Object.assign({}, counts);
}

function hasExactRoleCounts(counts, profile) {
  return Prepare.stableJson(counts) ===
    Prepare.stableJson(expectedRoleCounts(profile));
}

function hasExactLabelledRoleCounts(counts, profile) {
  return Prepare.stableJson(counts) ===
    Prepare.stableJson(expectedLabelledRoleCounts(profile));
}

function totalRows(profile) {
  return Object.values(expectedRoleCounts(profile))
    .reduce((sum, value) => sum + value, 0);
}

async function generateCreated(output, stockfish, profile) {
  const certificationTemplate = path.join(
    ROOT, 'eval', 'e4', 'certification-manifest.template.json'
  );
  const certificationPath = path.join(
    output, 'certification-pending.json'
  );
  fs.copyFileSync(
    certificationTemplate,
    certificationPath,
    fs.constants.COPYFILE_EXCL
  );
  const certification = JSON.parse(
    fs.readFileSync(certificationPath, 'utf8')
  );
  const fixture = openingWireFixture(profile);
  const expectedRows = totalRows(profile);
  const sourcePath = path.join(output, 'opening-wire-fixture.jsonl');
  fs.writeFileSync(
    sourcePath,
    fixture.rows.map(Prepare.stableJson).join('\n') + '\n',
    { flag: 'wx' }
  );
  const sourceSha256 = fileSha256(sourcePath);

  const selectionPath = path.join(output, 'selection');
  const selection = await Prepare.prepare({
    input: sourcePath,
    'source-sha256': sourceSha256,
    retrieved: '2026-07-31',
    output: selectionPath,
    modulus: '1',
    numerator: '1',
    'family-cap': '64',
    shards: '1',
    'minimum-selected': String(expectedRows),
    'max-malformed-ppm': '0',
    'certification-manifest': certificationPath,
    'allow-pending-certification-for-test': 'true',
    'mechanism-fixture': 'true'
  });
  if (selection.counts.selected !== expectedRows ||
      !hasExactRoleCounts(selection.counts.byRole, profile)) {
    throw new Error(
      'selection sample did not retain the exact ' + profile +
        ' role inventory'
    );
  }

  const teacherDirectory = path.join(output, 'teacher');
  fs.mkdirSync(teacherDirectory);
  const selectionShard = path.join(selectionPath, 'selection-000.ndjson');
  const selectionManifestPath = path.join(selectionPath, 'manifest.json');
  const teacherPath = path.join(teacherDirectory, 'teacher-000.ndjson');
  const teacher = await Label.labelShard({
    input: selectionShard,
    'selection-manifest': selectionManifestPath,
    output: teacherPath,
    stockfish
  }, { sampleOnly: true });
  const labelled = readNdjson(teacherPath);
  const labelledRoles = roleCounts(labelled);
  const expectedLabelled = Object.values(
    expectedLabelledRoleCounts(profile)
  ).reduce((sum, value) => sum + value, 0);
  if (teacher.output.rows !== expectedLabelled ||
      teacher.exclusions.rows !== EXPECTED_EXCLUSIONS[profile] ||
      Prepare.stableJson(teacher.exclusions.reasons) !==
        Prepare.stableJson(EXPECTED_EXCLUSION_REASONS[profile]) ||
      labelled.length !== expectedLabelled ||
      !hasExactLabelledRoleCounts(labelledRoles, profile)) {
    throw new Error(
      'real teacher sample must label the exact ' + profile +
        ' frozen eligibility and exclusion inventory; labelled=' +
        Prepare.stableJson(labelledRoles) + ', excluded=' +
        teacher.exclusions.rows
    );
  }

  const nnue = runNnueValidation(teacherPath);
  if (nnue.status !==
        'validated-sample-only-pinned-teacher-inputs' ||
      nnue.fitAllowed !== false ||
      nnue.train.length !== 1 ||
      nnue.validation.length !== 1 ||
      nnue.train[0].rows !== expectedLabelled ||
      nnue.validation[0].rows !== expectedLabelled ||
      nnue.train[0].selectedRows !==
        expectedLabelledRoleCounts(profile)['shared-train'] ||
      nnue.validation[0].selectedRows !==
        expectedLabelledRoleCounts(profile)['nnue-validation'] ||
      !hasExactLabelledRoleCounts(nnue.train[0].roleRows, profile) ||
      !hasExactLabelledRoleCounts(nnue.validation[0].roleRows, profile)) {
    throw new Error('NNUE sample validation did not preserve exact role counts');
  }
  const nnuePath = path.join(output, 'nnue-input-validation.json');
  writeJsonExclusive(nnuePath, nnue);

  const hceDirectory = path.join(output, 'hce');
  fs.mkdirSync(hceDirectory);
  const hceTrainPath = path.join(
    hceDirectory, 'shared-train.features.ndjson'
  );
  const hceValidationPath = path.join(
    hceDirectory, 'hce-validation.features.ndjson'
  );
  const hceTrain = await writeHceRole(
    teacherPath,
    'shared-train',
    hceTrainPath
  );
  const hceValidation = await writeHceRole(
    teacherPath,
    'hce-validation',
    hceValidationPath
  );
  if (hceTrain.rows !==
        expectedLabelledRoleCounts(profile)['shared-train'] ||
      hceValidation.rows !==
        expectedLabelledRoleCounts(profile)['hce-validation'] ||
      hceTrain.status !== 'sample-only-not-fit-eligible' ||
      hceValidation.status !== 'sample-only-not-fit-eligible' ||
      hceTrain.fitAllowed !== false ||
      hceValidation.fitAllowed !== false) {
    throw new Error('HCE sample extraction did not preserve exact role counts');
  }

  const sampleManifest = {
    schema: 'chessy.training-sample.v1',
    status: 'sample-only-not-fit-eligible',
    fitAllowed: false,
    publishableArtifact: false,
    profile,
    purpose:
      'Exercise an explicitly test-only selection, real pinned-teacher labelling, mixed-role NNUE validation, and HCE role extraction before corpus-scale compute.',
    caveats: [
      'The input is a local wire-format fixture derived from checked-in CC0 opening positions, not an official Lichess evaluation archive snapshot.',
      'The E4 certification boundary remains awaiting-opening-freeze; this run uses the explicit pending-certification test path and cannot enter production fitting.',
      'Counts are intentionally tiny and can support only a non-candidate convex mechanism diagnostic, never fitting, certification, or quality claims.',
      ...(profile === 'preliminary' ? [
        'The preliminary profile intentionally preserves one deterministic bestmove/PV eligibility exclusion in shared-train instead of substituting a label-friendly position post hoc.'
      ] : []),
      'Generated labels still require the declared artifact-license and legal review before public release.'
    ],
    sourceFixture: {
      path: path.relative(output, sourcePath),
      sha256: sourceSha256,
      rows: fixture.rows.length,
      derivedFrom: path.relative(ROOT, fixture.corpusPath),
      derivedFromSha256: fileSha256(fixture.corpusPath),
      upstream: 'lichess-org/chess-openings',
      upstreamLicense: 'CC0-1.0',
      sourceIds: fixture.sourceIds,
      officialEvaluationSnapshot: false
    },
    certificationBoundary: {
      path: path.relative(output, certificationPath),
      sha256: fileSha256(certificationPath),
      status: certification.status,
      openingClusters: certification.openingClusters.length,
      productionFreeze: false
    },
    selection: {
      manifest: path.relative(output, selectionManifestPath),
      manifestSha256: fileSha256(selectionManifestPath),
      state: selection.state,
      fitAllowed: selection.finalFitAllowed,
      rows: selection.counts.selected,
      byRole: selection.counts.byRole,
      shardSha256: selection.shards[0].canonicalNdjsonSha256
    },
    teacher: {
      manifest: path.relative(output, teacherPath + '.manifest.json'),
      manifestSha256: fileSha256(teacherPath + '.manifest.json'),
      state: teacher.state,
      fitAllowed: teacher.fitAllowed,
      rows: teacher.output.rows,
      excludedRows: teacher.exclusions.rows,
      exclusionReasons: teacher.exclusions.reasons,
      exclusionSha256: teacher.exclusions.sha256,
      outputSha256: teacher.output.sha256,
      byRole: labelledRoles
    },
    nnue: {
      report: path.relative(output, nnuePath),
      reportSha256: fileSha256(nnuePath),
      status: nnue.status,
      fitAllowed: nnue.fitAllowed,
      trainSelectedRows: nnue.train[0].selectedRows,
      validationSelectedRows: nnue.validation[0].selectedRows,
      selectionManifestSha256: nnue.selectionManifestSha256,
      sourceSnapshotSha256: nnue.sourceSnapshotSha256
    },
    hce: {
      sharedTrain: Object.assign({}, hceTrain, {
        path: path.relative(output, hceTrainPath),
        manifest: path.relative(output, hceTrainPath + '.manifest.json'),
        manifestSha256: fileSha256(hceTrainPath + '.manifest.json')
      }),
      validation: Object.assign({}, hceValidation, {
        path: path.relative(output, hceValidationPath),
        manifest: path.relative(
          output, hceValidationPath + '.manifest.json'
        ),
        manifestSha256: fileSha256(
          hceValidationPath + '.manifest.json'
        )
      })
    }
  };
  const manifestPath = path.join(output, 'sample-manifest.json');
  writeJsonSuccessMarker(manifestPath, sampleManifest);
  return { manifestPath, manifest: sampleManifest };
}

async function generate(options) {
  const output = path.resolve(options.output);
  const stockfish = path.resolve(options.stockfish);
  const profile = options.profile || 'smoke';
  if (!Object.prototype.hasOwnProperty.call(SAMPLE_PROFILES, profile)) {
    throw new Error('unknown sample profile: ' + profile);
  }
  if (!fs.statSync(stockfish).isFile()) {
    throw new Error('--stockfish must name a file');
  }
  fs.mkdirSync(output, { recursive: false });
  try {
    return await generateCreated(output, stockfish, profile);
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const generated = await generate(parseArgs(process.argv.slice(2)));
  console.log('generated ' + generated.manifest.teacher.rows +
    ' real Stockfish-labelled sample rows');
  console.log('sample manifest: ' + generated.manifestPath);
  console.log('status: ' + generated.manifest.status);
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('generate-training-sample: ' +
      String(error && error.stack || error));
    process.exitCode = 1;
  });
}

module.exports = {
  SAMPLE_PROFILES,
  LABELLED_PROFILES,
  EXPECTED_EXCLUSIONS,
  EXPECTED_EXCLUSION_REASONS,
  parseArgs,
  openingWireFixture,
  roleCounts,
  expectedRoleCounts,
  generate
};
