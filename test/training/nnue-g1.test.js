#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Corpus = require('./corpus');

const ROOT = path.join(__dirname, '..', '..');
const ARCH_PATH = path.join(ROOT, 'eval', 'training', 'nnue-v1-architecture.json');
const TRAIN_PATH = path.join(ROOT, 'eval', 'training', 'nnue-v1-train.json');
const TEACHER_PATH = path.join(
  ROOT, 'eval', 'training', 'teacher-sf18-100kn-v1.json');
const HELDOUT_PATH = path.join(ROOT, 'eval', 'training', 'heldout-v1.json');
const CORPUS_PATH = path.join(ROOT, 'test', 'training', 'corpus.js');
const PYTHON = process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
const SCRIPT = path.join(ROOT, 'tools', 'training', 'train-nnue.py');
const architecture = JSON.parse(fs.readFileSync(ARCH_PATH, 'utf8'));
const training = JSON.parse(fs.readFileSync(TRAIN_PATH, 'utf8'));
const teacher = JSON.parse(fs.readFileSync(TEACHER_PATH, 'utf8'));
let checks = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

assert.strictEqual(architecture.input.size, 768);
assert.strictEqual(architecture.input.planes, 12);
assert.deepStrictEqual(architecture.trainingSeeds, [10501, 10502, 10503]);
assert.strictEqual(architecture.runtimeIntegrationBlockedBy, 84);
assert.deepStrictEqual(architecture.output.mopUpAblation, [
  'net-only', 'net-plus-existing-lone-king-mop-up'
]);
checks += 5;

const candidates = new Map(architecture.candidates.map(item => [item.id, item]));
assert.strictEqual(candidates.get('h64-screlu').selectionRole, 'primary');
assert.strictEqual(candidates.get('h128-screlu').selectionRole, 'capacity-screen-only');
assert.ok(candidates.get('h128-screlu').shippingBlockedUntil);
checks += 3;

assert.strictEqual(training.data.trainRole, 'shared-train');
assert.strictEqual(training.data.validationRole, 'nnue-validation');
assert.strictEqual(training.data.testRole, 'nnue-test');
assert.strictEqual(training.data.upstreamMixedLabelsAllowed, false);
assert.strictEqual(training.artifacts.runtimeOrQuantizedArtifactProduced, false);
assert.strictEqual(training.dependency.torch, '2.7.1');
assert.strictEqual(
  teacher.labels.eligibility.mateInvalidatesEarlierExactCp, true);
assert.strictEqual(
  training.data.trustBoundary.teacherManifestSha256,
  sha256(fs.readFileSync(TEACHER_PATH)));
assert.strictEqual(
  training.data.trustBoundary.heldoutManifestSha256,
  sha256(fs.readFileSync(HELDOUT_PATH)));
assert.strictEqual(
  training.data.trustBoundary.corpusContractSha256,
  sha256(fs.readFileSync(CORPUS_PATH)));
checks += 10;

const witnesses = [
  '8/8/8/8/8/8/P6p/K6k w - -',
  'r3k2r/pp1n1ppp/2p1p3/8/3P4/2N2N2/PP3PPP/R3K2R w KQkq -',
  '4k3/3p4/8/4P3/8/8/8/4K3 b - -'
];
for (const fen of witnesses) {
  for (const perspective of ['w', 'b']) {
    const output = childProcess.execFileSync(PYTHON, [
      SCRIPT, '--features', fen, '--perspective', perspective
    ], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(output), Corpus.encodeNnue768(fen, perspective));
    checks++;
  }
}

childProcess.execFileSync(PYTHON, ['-m', 'py_compile', SCRIPT]);
checks++;

const SOURCE_SHA = '1'.repeat(64);
const SELECTION_SHA = '2'.repeat(64);
const SELECTION_CONTRACT_SHA = '3'.repeat(64);
const EMPTY_SHA = sha256('');
const TRAIN_FENS = [
  '8/8/8/8/8/8/P6p/K6k w - -',
  'r3k2r/pp1n1ppp/2p1p3/8/3P4/2N2N2/PP3PPP/R3K2R w KQkq -'
];
const VALIDATION_FEN = '4k3/P1p5/2N2n2/8/8/8/8/4K3 w - -';

function labelledRecord(fen) {
  const record = Corpus.adaptLichessRecord({
    fen,
    evals: [{
      depth: 24,
      knodes: 100,
      pvs: [{ cp: 25, line: 'a2a3 a7a6' }]
    }]
  }, { sha256: SOURCE_SHA });
  assert.ok(record);
  delete record.explorationLabel;
  record.teacher = {
    id: teacher.id,
    release: teacher.engine.release,
    commit: teacher.engine.sourceCommit,
    manifestSha256: training.data.trustBoundary.teacherManifestSha256,
    nodes: teacher.search.nodeLimit,
    cpWhite: 25,
    wdlWhite: [500, 300, 200],
    targetWhite: 0.65,
    bestMoveUci: 'a2a3',
    pvUci: ['a2a3', 'a7a6'],
    depth: 24,
    seldepth: 30,
    scoreNodes: 61564,
    reportedNodes: teacher.search.nodeLimit + 54
  };
  return record;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sidecarFor(filename, body, rows) {
  return {
    schemaVersion: 1,
    state: training.data.trustBoundary.sidecarState,
    input: {
      selectionManifest: {
        path: '/frozen/selection/manifest.json',
        sha256: SELECTION_SHA,
        selectionContractSha256: SELECTION_CONTRACT_SHA,
        certificationStatus: 'frozen'
      },
      shard: {
        path: '/frozen/selection/' + path.basename(filename),
        rows,
        sha256: '4'.repeat(64)
      }
    },
    output: {
      path: filename,
      rows,
      sha256: sha256(body)
    },
    exclusions: {
      path: filename + '.exclusions.ndjson',
      rows: 0,
      sha256: EMPTY_SHA
    },
    teacher: {
      manifest: {
        path: TEACHER_PATH,
        sha256: training.data.trustBoundary.teacherManifestSha256
      },
      id: teacher.id,
      release: teacher.engine.release,
      commit: teacher.engine.sourceCommit,
      executableSha256: teacher.engine.executable.sha256,
      networks: teacher.engine.networks.map(network => ({
        option: network.option,
        embeddedName: network.embeddedName,
        sha256: network.sha256
      })),
      license: teacher.engine.license,
      use: teacher.engine.integration,
      nodes: teacher.search.nodeLimit,
      options: clone(teacher.uci),
      watchdog: clone(teacher.watchdog),
      scorePovFromEngine: teacher.labels.enginePov,
      storedScorePov: teacher.labels.storedPov,
      transcript: {
        path: filename + '.uci.log',
        sha256: '5'.repeat(64)
      }
    }
  };
}

function writeShard(directory, name, records, options) {
  const settings = options || {};
  const filename = path.join(directory, name);
  const ordered = settings.preserveOrder ?
    records.slice() : records.slice().sort((a, b) => a.id.localeCompare(b.id));
  const body = ordered.map(record => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(filename, body);
  const sidecar = sidecarFor(filename, body, ordered.length);
  if (settings.mutateSidecar) settings.mutateSidecar(sidecar);
  if (!settings.omitSidecar) {
    fs.writeFileSync(filename + '.manifest.json', JSON.stringify(sidecar) + '\n');
  }
  return filename;
}

function validateCommand(train, validation) {
  return childProcess.spawnSync(PYTHON, [
    SCRIPT,
    '--validate-inputs',
    '--train', ...train,
    '--validation', ...validation
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
}

function expectRejected(train, validation, message) {
  const result = validateCommand(train, validation);
  assert.notStrictEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
  checks += 2;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-nnue-trust-'));
try {
  const goodDir = path.join(temporary, 'good');
  fs.mkdirSync(goodDir);
  const trainA = writeShard(goodDir, 'train-000.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ]);
  const trainB = writeShard(goodDir, 'train-001.ndjson', [
    labelledRecord(TRAIN_FENS[1])
  ]);
  const validation = writeShard(goodDir, 'validation-000.ndjson', [
    labelledRecord(VALIDATION_FEN)
  ]);
  const good = validateCommand([trainA, trainB], [validation]);
  assert.strictEqual(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.strictEqual(report.status, 'validated-pinned-teacher-inputs');
  assert.strictEqual(report.train.length, 2);
  assert.strictEqual(report.validation[0].role, 'nnue-validation');
  assert.strictEqual(report.selectionContractSha256, SELECTION_CONTRACT_SHA);
  checks += 5;

  const missingDir = path.join(temporary, 'missing-sidecar');
  fs.mkdirSync(missingDir);
  const missing = writeShard(missingDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], { omitSidecar: true });
  expectRejected([missing], [validation], /required sidecar is missing/);

  const targetDir = path.join(temporary, 'bad-target');
  fs.mkdirSync(targetDir);
  const badTargetRecord = labelledRecord(TRAIN_FENS[0]);
  badTargetRecord.teacher.targetWhite = 1.2;
  const badTarget = writeShard(targetDir, 'train.ndjson', [badTargetRecord]);
  expectRejected([badTarget], [validation], /targetWhite must be in \[0,1\]/);

  const roleDir = path.join(temporary, 'bad-role');
  fs.mkdirSync(roleDir);
  const badRoleRecord = labelledRecord(TRAIN_FENS[0]);
  badRoleRecord.role = 'nnue-validation';
  const badRole = writeShard(roleDir, 'train.ndjson', [badRoleRecord]);
  expectRejected([badRole], [validation], /recomputed role does not match/);

  const upstreamDir = path.join(temporary, 'upstream-label');
  fs.mkdirSync(upstreamDir);
  const upstreamRecord = labelledRecord(TRAIN_FENS[0]);
  upstreamRecord.sourceExplorationLabel = { teacher: 'untrusted-upstream' };
  const upstream = writeShard(
    upstreamDir, 'train.ndjson', [upstreamRecord]);
  expectRejected([upstream], [validation], /mixed upstream label fields are forbidden/);

  const explorationDir = path.join(temporary, 'exploration-label');
  fs.mkdirSync(explorationDir);
  const explorationRecord = labelledRecord(TRAIN_FENS[0]);
  explorationRecord.explorationLabel = { teacher: 'untrusted-upstream' };
  const exploration = writeShard(
    explorationDir, 'train.ndjson', [explorationRecord]);
  expectRejected(
    [exploration], [validation], /mixed upstream label fields are forbidden/);

  const arbitraryDir = path.join(temporary, 'arbitrary-field');
  fs.mkdirSync(arbitraryDir);
  const arbitraryRecord = labelledRecord(TRAIN_FENS[0]);
  arbitraryRecord.scoreBound = 'upperbound';
  const arbitrary = writeShard(
    arbitraryDir, 'train.ndjson', [arbitraryRecord]);
  expectRejected(
    [arbitrary], [validation], /record has undeclared or missing fields/);

  const effortDir = path.join(temporary, 'bad-terminal-effort');
  fs.mkdirSync(effortDir);
  const effortRecord = labelledRecord(TRAIN_FENS[0]);
  effortRecord.teacher.reportedNodes = teacher.search.nodeLimit - 1;
  const effort = writeShard(effortDir, 'train.ndjson', [effortRecord]);
  expectRejected(
    [effort], [validation], /score\/terminal node evidence is invalid/);

  const scoreNodesDir = path.join(temporary, 'bad-score-nodes');
  fs.mkdirSync(scoreNodesDir);
  const scoreNodesRecord = labelledRecord(TRAIN_FENS[0]);
  scoreNodesRecord.teacher.scoreNodes =
    scoreNodesRecord.teacher.reportedNodes + 1;
  const scoreNodes = writeShard(
    scoreNodesDir, 'train.ndjson', [scoreNodesRecord]);
  expectRejected(
    [scoreNodes], [validation], /score\/terminal node evidence is invalid/);

  const orderDir = path.join(temporary, 'bad-order');
  fs.mkdirSync(orderDir);
  const reverse = TRAIN_FENS.map(labelledRecord)
    .sort((a, b) => b.id.localeCompare(a.id));
  const badOrder = writeShard(orderDir, 'train.ndjson', reverse, {
    preserveOrder: true
  });
  expectRejected([badOrder], [validation], /unsorted record ID/);

  const teacherDir = path.join(temporary, 'bad-teacher');
  fs.mkdirSync(teacherDir);
  const badTeacher = writeShard(teacherDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], {
    mutateSidecar(sidecar) {
      sidecar.teacher.networks[0].sha256 = 'f'.repeat(64);
    }
  });
  expectRejected([badTeacher], [validation], /networks do not match frozen teacher/);

  const watchdogDir = path.join(temporary, 'bad-watchdog');
  fs.mkdirSync(watchdogDir);
  const badWatchdog = writeShard(watchdogDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], {
    mutateSidecar(sidecar) {
      sidecar.teacher.watchdog.positionTimeoutMs++;
    }
  });
  expectRejected(
    [badWatchdog], [validation], /watchdog does not match frozen teacher/);

  const hashDir = path.join(temporary, 'bad-output-hash');
  fs.mkdirSync(hashDir);
  const badHash = writeShard(hashDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], {
    mutateSidecar(sidecar) {
      sidecar.output.sha256 = 'f'.repeat(64);
    }
  });
  expectRejected([badHash], [validation], /SHA-256 does not match its sidecar/);

  const rowsDir = path.join(temporary, 'bad-row-count');
  fs.mkdirSync(rowsDir);
  const badRows = writeShard(rowsDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], {
    mutateSidecar(sidecar) {
      sidecar.output.rows++;
      sidecar.input.shard.rows++;
    }
  });
  expectRejected([badRows], [validation], /sidecar rows=2, observed rows=1/);

  const pendingDir = path.join(temporary, 'pending-certification');
  fs.mkdirSync(pendingDir);
  const pending = writeShard(pendingDir, 'train.ndjson', [
    labelledRecord(TRAIN_FENS[0])
  ], {
    mutateSidecar(sidecar) {
      sidecar.input.selectionManifest.certificationStatus =
        'awaiting-opening-freeze';
    }
  });
  expectRejected(
    [pending], [validation], /pending\/test-only certification selections are forbidden/);

  const duplicateDir = path.join(temporary, 'duplicate');
  fs.mkdirSync(duplicateDir);
  const duplicateRecord = labelledRecord(TRAIN_FENS[0]);
  const duplicateA = writeShard(
    duplicateDir, 'train-000.ndjson', [duplicateRecord]);
  const duplicateB = writeShard(
    duplicateDir, 'train-001.ndjson', [duplicateRecord]);
  expectRejected(
    [duplicateA, duplicateB], [validation], /duplicate record ID across shards/);

  const heldoutDir = path.join(temporary, 'heldout');
  fs.mkdirSync(heldoutDir);
  const heldout = JSON.parse(fs.readFileSync(HELDOUT_PATH, 'utf8'));
  const heldoutRecord = labelledRecord(heldout.incident.fen4);
  const heldoutShard = writeShard(
    heldoutDir, 'train.ndjson', [heldoutRecord]);
  expectRejected(
    [heldoutShard], [validation], /held-out incident cluster\/family is forbidden/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(checks + ' NNUE G1 contract checks passed');
