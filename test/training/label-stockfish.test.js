#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');
const E4 = require('../eval/e4-protocol');

const ROOT = path.join(__dirname, '..', '..');

let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function throws(callback, pattern, message) {
  assert.throws(callback, pattern, message);
  checks++;
}
async function rejects(callback, pattern, message) {
  await assert.rejects(callback, pattern, message);
  checks++;
}

const info = Label.parseInfo(
  'info depth 17 seldepth 25 multipv 1 score cp -123 wdl 101 302 597 ' +
  'nodes 100000 nps 500000 pv e5e4 b1a1'
);
equal(info, {
  depth: 17,
  seldepth: 25,
  cpSideToMove: -123,
  wdlSideToMove: [101, 302, 597],
  nodes: 100000,
  pvUci: ['e5e4', 'b1a1']
});

const white = Label.whitePov(info, 'w');
equal(white.cpWhite, -123);
equal(white.wdlWhite, [101, 302, 597]);
equal(white.targetWhite, 0.252);

const black = Label.whitePov(info, 'b');
equal(black.cpWhite, 123);
equal(black.wdlWhite, [597, 302, 101]);
equal(black.targetWhite, 0.748);
equal(Label.whitePov({ cpSideToMove: 1 }, 'w'), null,
  'missing WDL cannot silently fall back to a CP sigmoid');

const bound = Label.parseInfo(
  'info depth 8 score cp 77 lowerbound wdl 500 400 100 ' +
  'nodes 100000 pv a2a4'
);
equal(bound.scoreBound, 'lowerbound');
equal(bound.pvUci, ['a2a4']);

const completedExact = Label.parseInfo(
  'info depth 15 seldepth 18 multipv 1 score cp 49 wdl 126 871 3 ' +
  'nodes 61564 pv e2e4 c7c5'
);
const terminalBound = Label.parseInfo(
  'info depth 16 seldepth 24 multipv 1 score cp 47 upperbound ' +
  'wdl 114 882 4 nodes 100054 pv e2e4 c7c5'
);
const terminalMate = Label.parseInfo(
  'info depth 16 seldepth 24 multipv 1 score mate 3 ' +
  'nodes 100054 pv h7h8q'
);

const cpThenMate = [
  'info depth 8 score cp 77 wdl 500 400 100 nodes 90000 pv a2a4',
  'info depth 20 score mate 3 nodes 100000 pv h7h8q'
].reduce(Label.updateLatestScore, null);
equal(cpThenMate.mateSideToMove, 3,
  'a final mate score replaces, rather than reuses, an earlier CP score');
equal(Label.whitePov(cpThenMate, 'w'), null);

throws(() => Label.parseArgs(['--input']), /requires a value/);
equal(Label.parseArgs([
  '--input', 'in.ndjson',
  '--selection-manifest', 'manifest.json',
  '--output', 'out.ndjson',
  '--stockfish', 'stockfish'
]), {
  input: 'in.ndjson',
  'selection-manifest': 'manifest.json',
  output: 'out.ndjson',
  stockfish: 'stockfish'
});
throws(() => Label.parseArgs(['--teacher-id', 'arbitrary']),
  /unknown or frozen argument/,
  'teacher identity cannot be supplied on the command line');
throws(() => Label.parseArgs(['--nodes', '1']),
  /unknown or frozen argument/,
  'the frozen teacher node limit cannot be overridden');
throws(() => Label.parseArgs(['--sample-only', 'true']),
  /unknown or frozen argument/,
  'the mechanism-fixture path is unavailable through the production CLI');
throws(() => Label.parseArgs(['--input', 'a', '--input', 'b']),
  /duplicate argument/);

const contracts = Label.loadFrozenContracts();
equal(contracts.teacher.id, 'sf18-100kn-v1');
equal(contracts.teacher.search.nodeLimit, 100000);
equal(contracts.teacher.watchdog.positionTimeoutMs, 120000);
ok(/^[0-9a-f]{64}$/.test(contracts.teacherSha256),
  'teacher manifest has a frozen content hash');

const eligible = Label.assessTeacherResult(
  { info, bestMove: 'e5e4' }, 'w', contracts.teacher
);
equal(eligible.eligible, true);
equal(eligible.pov.targetWhite, 0.252);
equal(Label.assessTeacherResult(
  { info: bound, bestMove: 'a2a4' }, 'w', contracts.teacher
).reason, 'bound-score');
equal(Label.assessTeacherResult(
  {
    info: {
      cpSideToMove: 4,
      nodes: 100000,
      pvUci: ['e2e4']
    },
    bestMove: 'e2e4'
  },
  'w',
  contracts.teacher
).reason, 'missing-wdl');
equal(Label.assessTeacherResult(
  {
    info: {
      cpSideToMove: 4,
      wdlSideToMove: [500, 400, 100],
      nodes: 99999,
      pvUci: ['e2e4']
    },
    bestMove: 'e2e4'
  },
  'w',
  contracts.teacher
).reason, 'reported-nodes-under-budget');
const crossedNodeBoundary = Label.assessTeacherResult(
  {
    info: completedExact,
    terminalInfo: terminalBound,
    bestMove: 'e2e4'
  },
  'w',
  contracts.teacher
);
equal(crossedNodeBoundary.eligible, true,
  'a terminal bound after crossing the node limit does not replace the latest exact score');
const mateAfterExact = Label.assessTeacherResult(
  {
    info: completedExact,
    terminalInfo: terminalMate,
    bestMove: 'h7h8q'
  },
  'w',
  contracts.teacher
);
equal(mateAfterExact.reason, 'mate-score',
  'a terminal mate can never reuse an earlier exact CP result');
equal(mateAfterExact.detail.cpSideToMove, undefined,
  'terminal-mate exclusions do not copy the earlier CP into their ledger');
const contaminatedMateInfo = Object.assign({}, terminalMate, {
  cpSideToMove: 999
});
const contaminatedMate = Label.assessTeacherResult(
  {
    info: contaminatedMateInfo,
    terminalInfo: contaminatedMateInfo,
    bestMove: 'h7h8q'
  },
  'w',
  contracts.teacher
);
equal(contaminatedMate.reason, 'mate-score');
equal(contaminatedMate.detail.cpSideToMove, undefined,
  'even malformed mixed score state cannot put stale CP beside mate evidence');
equal(Label.assessTeacherResult(
  {
    info: {
      mateSideToMove: 3,
      nodes: 100000,
      pvUci: ['h7h8q']
    },
    bestMove: 'h7h8q'
  },
  'w',
  contracts.teacher
).reason, 'mate-score');
equal(Label.assessTeacherResult(
  {
    info: {
      cpSideToMove: 4,
      wdlSideToMove: [500, 400, 99],
      nodes: 100000,
      pvUci: ['e2e4']
    },
    bestMove: 'e2e4'
  },
  'w',
  contracts.teacher
).reason, 'invalid-wdl');
equal(Label.assessTeacherResult(
  {
    info: {
      cpSideToMove: 4,
      wdlSideToMove: [500, 400, 100],
      nodes: 100000,
      depth: 12,
      seldepth: 16,
      pvUci: ['d2d4']
    },
    bestMove: 'e2e4'
  },
  'w',
  contracts.teacher
).reason, 'bestmove-pv-mismatch');

throws(() => Label.validateLabelOptions({
  input: 'in.ndjson',
  'selection-manifest': 'manifest.json',
  output: 'out.ndjson',
  stockfish: 'stockfish',
  teacher: { id: 'arbitrary' }
}), /unknown or frozen option/,
'programmatic callers cannot inject teacher metadata');

function selectionManifest(sourceSha256, shardPath, body) {
  const rows = body ? body.trim().split('\n').length : 0;
  const certificationText = fs.readFileSync(E4.PATHS.certification, 'utf8');
  const certification = JSON.parse(certificationText);
  const certificationSha256 = Corpus.sha256(certificationText);
  const selectionContractSha256 = Corpus.sha256(Prepare.stableJson({
    wrapperSha256: contracts.prepareSha256,
    corpusContractSha256: contracts.corpusSha256,
    e4ValidatorSha256: contracts.e4ValidatorSha256,
    heldoutManifestSha256: contracts.heldoutSha256,
    sourcePolicySha256: contracts.sourcePolicySha256,
    certificationManifestSha256: certificationSha256
  }));
  return {
    schemaVersion: 1,
    state: 'exploration-selection-only',
    finalFitAllowed: false,
    source: {
      id: 'lichess-evaluations',
      url: contracts.sourceEntry.canonicalUrl,
      retrieved: '2026-07-29',
      compressedSha256: sourceSha256,
      license: 'CC0-1.0'
    },
    adapter: {
      schema: Corpus.SCHEMA,
      wrapperSha256: contracts.prepareSha256,
      corpusContractSha256: contracts.corpusSha256,
      e4ValidatorSha256: contracts.e4ValidatorSha256,
      selectionContractSha256,
      sourcePolicySha256: contracts.sourcePolicySha256,
      sample: {
        salt: 'e4-v1-sample',
        modulus: 100,
        numerator: 1
      },
      shardCount: 1,
      modelCluster: 'canonical legal symmetry orbit of board-only piece placement',
      roleGroup: 'position-family key',
      positionFamilyCap: 64
    },
    exclusions: {
      manifest: 'eval/training/heldout-v1.json',
      manifestSha256: contracts.heldoutSha256,
      incidentClusterSha256:
        contracts.heldout.symmetryPolicy.clusterSha256,
      incidentPositionFamilySha256:
        contracts.heldout.symmetryPolicy.positionFamilySha256,
      incidentFamilyControlStatus: 'enforced',
      sameSourceGameLineageControlStatus: 'pending-source-game-id',
      nearbyBudgetTrainingControlStatus: 'enforced-by-incident-family',
      nearbyBudgetPreregistrationStatus: 'preregistered',
      nearbyBudgetNodes: [8268594, 10106060],
      nearbyBudgetContract:
        'eval/training/hce-r3-fit-v1.json#/lockedPostFitGate/nearbyNodes',
      nearbyBudgetExecutionEvidenceStatus: 'pending-post-fit-execution',
      certificationManifest:
        path.relative(ROOT, E4.PATHS.certification),
      certificationManifestSha256: certificationSha256,
      certificationStatus: certification.status,
      certificationClusterCount: 0,
      certificationPositionFamilyCount: 0,
      pendingCertificationAllowedForTestOnly: true,
      appliedBeforeSplit: true
    },
    roles: {
      'shared-train': 'HCE and NNUE training only',
      'hce-validation': 'HCE selection only',
      'hce-test': 'HCE one-time untouched transfer test',
      'nnue-validation': 'NNUE architecture/training selection only',
      'nnue-test': 'NNUE one-time untouched transfer test'
    },
    counts: { selected: rows },
    shards: [{
      path: shardPath,
      rows,
      canonicalNdjsonSha256: Corpus.sha256(body)
    }]
  };
}

function selectedRecord(fen, sourceSha256) {
  return Corpus.adaptLichessRecord({
    fen,
    evals: [{
      depth: 20,
      knodes: 100,
      pvs: [{ cp: 12, line: 'e2e4 e8e7' }]
    }]
  }, { sha256: sourceSha256 });
}

function lichessSourceBody(fen) {
  return Prepare.stableJson({
    fen,
    evals: [{
      depth: 20,
      knodes: 100,
      pvs: [{ cp: 12, line: 'e2e4 e8e7' }]
    }]
  }) + '\n';
}

async function assertAuthenticatedSourceSurvivesReplacement(
  temporary, extension
) {
  const authenticatedFen = '4k3/8/8/8/8/8/4P3/4K3 w - -';
  const replacementFen = '4k3/8/8/8/8/8/3P4/4K3 w - -';
  const authenticatedBody = lichessSourceBody(authenticatedFen);
  const replacementBody = lichessSourceBody(replacementFen);
  const input = path.join(temporary, 'authenticated-source' + extension);
  const replacement = input + '.replacement';
  const output = path.join(
    temporary,
    extension === '.zst' ?
      'authenticated-zst-selection' : 'authenticated-jsonl-selection'
  );
  fs.writeFileSync(input, authenticatedBody);
  fs.writeFileSync(replacement, replacementBody);
  const expectedSha256 = Corpus.sha256(authenticatedBody);
  const originalCreateReadStream = fs.createReadStream;
  const originalPath = process.env.PATH;
  let replaced = false;
  if (extension === '.zst') {
    const bin = path.join(temporary, 'fake-zstd-bin');
    fs.mkdirSync(bin, { recursive: true });
    const zstd = path.join(bin, 'zstd');
    fs.writeFileSync(zstd, [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      'const filename = process.argv.find(arg => arg.endsWith(".zst"));',
      '(filename ? fs.createReadStream(filename) : process.stdin)' +
        '.pipe(process.stdout);',
      ''
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(zstd, 0o755);
    process.env.PATH = bin + path.delimiter + originalPath;
  }
  fs.createReadStream = function (filename, options) {
    const stream = originalCreateReadStream.call(fs, filename, options);
    if (!replaced && options && Number.isInteger(options.fd)) {
      stream.once('end', function () {
        fs.renameSync(replacement, input);
        replaced = true;
      });
    }
    return stream;
  };
  let manifest;
  try {
    manifest = await Prepare.prepare({
      input,
      'source-sha256': expectedSha256,
      retrieved: '2026-07-31',
      output,
      modulus: '1',
      numerator: '1',
      shards: '1',
      'family-cap': '64',
      'minimum-selected': '1',
      'max-malformed-ppm': '0',
      'allow-missing-roles': 'true',
      'allow-pending-certification-for-test': 'true',
      'mechanism-fixture': 'true'
    });
  } finally {
    fs.createReadStream = originalCreateReadStream;
    process.env.PATH = originalPath;
  }
  equal(replaced, true,
    extension + ' source path is atomically replaced after authentication');
  equal(manifest.source.compressedSha256, expectedSha256,
    extension + ' manifest retains the authenticated source digest');
  const selected = JSON.parse(fs.readFileSync(
    path.join(output, 'selection-000.ndjson'), 'utf8'
  ).trim());
  equal(selected.fen, authenticatedFen,
    extension + ' parsing consumes the authenticated open descriptor');
  equal(
    Corpus.sha256(fs.readFileSync(input)),
    Corpus.sha256(replacementBody),
    extension + ' test confirms the pathname now names replacement bytes'
  );
}

async function integration() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'chessy-label-contract-')
  );
  try {
    const lockPath = path.join(temporary, 'teacher-locked.ndjson.lock');
    const lockFd = Label.acquirePrefixLock(lockPath);
    try {
      throws(
        () => Label.acquirePrefixLock(lockPath),
        /holds the output prefix lock/,
        'only one label process can own an output prefix'
      );
      equal(fs.existsSync(lockPath), true,
        'a refused competitor cannot remove the winning process lock');
    } finally {
      Label.releasePrefixLock(lockFd, lockPath);
    }
    equal(fs.existsSync(lockPath), false,
      'the owning process releases its output prefix lock');
    const retryLockFd = Label.acquirePrefixLock(lockPath);
    Label.releasePrefixLock(retryLockFd, lockPath);
    equal(fs.existsSync(lockPath), false,
      'a clean retry can acquire and release the prefix');

    const existingFinal = path.join(temporary, 'teacher-existing.ndjson');
    fs.writeFileSync(existingFinal, 'existing winner\n');
    throws(
      () => Label.refuseExistingArtifacts([existingFinal]),
      /refusing to overwrite output artifact/,
      'a completed artifact is rejected before labelling starts'
    );
    equal(fs.readFileSync(existingFinal, 'utf8'), 'existing winner\n',
      'preflight refusal preserves the existing winner');

    const concurrentFinal = {
      output: path.join(temporary, 'teacher-concurrent.ndjson'),
      exclusions:
        path.join(temporary, 'teacher-concurrent.ndjson.exclusions.ndjson'),
      transcript:
        path.join(temporary, 'teacher-concurrent.ndjson.uci.log'),
      sidecar:
        path.join(temporary, 'teacher-concurrent.ndjson.manifest.json')
    };
    Label.refuseExistingArtifacts(Object.values(concurrentFinal));
    const concurrentTemporary = Object.fromEntries(
      Object.entries(concurrentFinal).map(function ([name, filename]) {
        const temporaryName = filename + '.tmp-test-owner';
        fs.writeFileSync(temporaryName, name + ' from losing process\n');
        return [name, temporaryName];
      })
    );
    fs.writeFileSync(concurrentFinal.output, 'concurrent winner\n');
    throws(
      () => Label.commitLabelArtifacts(
        concurrentTemporary, concurrentFinal
      ),
      /refusing to overwrite output artifact/,
      'no-replace publication refuses a winner created after preflight'
    );
    Label.cleanupTemporaryArtifacts(concurrentTemporary);
    equal(
      fs.readFileSync(concurrentFinal.output, 'utf8'),
      'concurrent winner\n',
      'failed publication cannot overwrite or delete a concurrent winner'
    );
    equal(fs.existsSync(concurrentFinal.exclusions), false,
      'publication stops before exposing later data artifacts');
    equal(fs.existsSync(concurrentFinal.transcript), false,
      'publication stops before exposing the transcript');
    equal(fs.existsSync(concurrentFinal.sidecar), false,
      'the sidecar commit marker is never exposed on a failed publication');
    ok(
      Object.values(concurrentTemporary).every(
        filename => !fs.existsSync(filename)
      ),
      'failure cleanup removes only the losing process temporary artifacts'
    );

    const partialFinal = {
      output: path.join(temporary, 'teacher-partial.ndjson'),
      exclusions:
        path.join(temporary, 'teacher-partial.ndjson.exclusions.ndjson'),
      transcript:
        path.join(temporary, 'teacher-partial.ndjson.uci.log'),
      sidecar:
        path.join(temporary, 'teacher-partial.ndjson.manifest.json')
    };
    const partialTemporary = Object.fromEntries(
      Object.entries(partialFinal).map(function ([name, filename]) {
        const temporaryName = filename + '.tmp-test-owner';
        fs.writeFileSync(temporaryName, name + ' from interrupted run\n');
        return [name, temporaryName];
      })
    );
    fs.writeFileSync(
      partialFinal.exclusions, 'concurrent exclusion winner\n'
    );
    throws(
      () => Label.commitLabelArtifacts(
        partialTemporary, partialFinal
      ),
      /refusing to overwrite output artifact/,
      'a mid-publication collision stops before the sidecar commit marker'
    );
    Label.cleanupTemporaryArtifacts(partialTemporary);
    equal(
      fs.readFileSync(partialFinal.output, 'utf8'),
      'output from interrupted run\n',
      'per-file publication can expose data before its completion marker'
    );
    equal(
      fs.readFileSync(partialFinal.exclusions, 'utf8'),
      'concurrent exclusion winner\n',
      'mid-publication refusal preserves the conflicting winner'
    );
    equal(fs.existsSync(partialFinal.transcript), false);
    equal(fs.existsSync(partialFinal.sidecar), false,
      'consumers reject a partial prefix because its sidecar is absent');

    let forcedKills = 0;
    const stalled = Object.create(Label.UciEngine.prototype);
    stalled.iterator = {
      next: function () {
        return new Promise(function () {});
      }
    };
    stalled.closed = new Promise(function () {});
    stalled.transcript = { append: function () {} };
    stalled.forceKill = function () { forcedKills++; };
    await rejects(
      () => stalled.readUntil(() => false, 20, 'fake response'),
      /watchdog timeout waiting for fake response/,
      'a silent engine is bounded by the frozen watchdog'
    );
    equal(forcedKills, 1, 'watchdog expiry force-kills the engine');

    const scriptedLines = [
      'info depth 14 seldepth 18 score cp 40 wdl 90 905 5 ' +
        'nodes 50000 pv e2e4 c7c5',
      'info depth 15 seldepth 22 score mate 4 nodes 80000 pv e2e4',
      'info depth 16 seldepth 24 score cp 39 upperbound wdl 86 909 5 ' +
        'nodes 100050 pv e2e4 c7c5',
      'bestmove e2e4 ponder c7c5'
    ];
    const scripted = Object.create(Label.UciEngine.prototype);
    scripted.watchdog = { positionTimeoutMs: 1000 };
    scripted.send = function () {};
    scripted.forceKill = function () {};
    scripted.readUntil = async function () {
      return scriptedLines.shift();
    };
    const noStaleCp = await scripted.label(
      '4k3/8/8/8/8/8/4P3/4K3 w - -',
      100000,
      {
        UciNewGameBeforeEveryPosition: false,
        ClearHashBeforeEveryPosition: false,
        IsReadyBeforeEveryPosition: false
      }
    );
    equal(noStaleCp.info, null,
      'a bound after a mate cannot revive an exact CP from before the mate');
    equal(noStaleCp.terminalInfo.scoreBound, 'upperbound');
    const noStaleAssessment = Label.assessTeacherResult(
      noStaleCp, 'w', contracts.teacher
    );
    equal(noStaleAssessment.reason, 'missing-score');
    equal(noStaleAssessment.detail.cpSideToMove, undefined,
      'the exclusion ledger cannot leak the invalidated pre-mate CP');

    const sourceSha256 = 'a'.repeat(64);
    const shardName = 'selection-000.ndjson';
    const shardPath = path.join(temporary, shardName);
    const manifestPath = path.join(temporary, 'manifest.json');
    const record = selectedRecord(
      '4k3/8/8/8/8/8/4P3/4K3 w - -',
      sourceSha256
    );
    const body = Prepare.stableJson(record) + '\n';
    fs.writeFileSync(shardPath, body);
    fs.writeFileSync(
      manifestPath,
      Prepare.stableJson(
        selectionManifest(sourceSha256, shardName, body)
      ) + '\n'
    );

    await rejects(
      () => Label.loadSelectionContext(manifestPath, shardPath, contracts),
      /requires a frozen E4 certification holdout/,
      'production label validation refuses a pending certification selection'
    );
    const authenticatedSelection = await Label.loadSelectionRecords(
      manifestPath,
      shardPath,
      contracts,
      { allowPendingCertificationForTest: true }
    );
    const context = authenticatedSelection.context;
    const records = authenticatedSelection.records;
    equal(records.length, 1);
    equal(records[0].id, record.id);

    const replacementRecord = selectedRecord(
      '4k3/8/8/8/8/8/3P4/4K3 w - -',
      sourceSha256
    );
    const replacementBody =
      Prepare.stableJson(replacementRecord) + '\n';
    const racedDirectory =
      path.join(temporary, 'raced-selection');
    fs.mkdirSync(racedDirectory);
    const racedShardPath =
      path.join(racedDirectory, 'selection-000.ndjson');
    const racedReplacementPath = racedShardPath + '.replacement';
    const racedManifestPath =
      path.join(racedDirectory, 'manifest.json');
    fs.writeFileSync(racedShardPath, body);
    fs.writeFileSync(racedReplacementPath, replacementBody);
    fs.writeFileSync(
      racedManifestPath,
      Prepare.stableJson(
        selectionManifest(sourceSha256, path.basename(racedShardPath), body)
      ) + '\n'
    );
    const originalCreateReadStream = fs.createReadStream;
    let shardReplaced = false;
    let snapshotStreamCount = 0;
    let parseOpenedAfterReplacement = false;
    fs.createReadStream = function (filename, options) {
      const stream = originalCreateReadStream.call(fs, filename, options);
      if (filename === null && options && Number.isInteger(options.fd)) {
        snapshotStreamCount++;
        if (snapshotStreamCount === 1) {
          stream.once('end', function () {
            fs.renameSync(racedReplacementPath, racedShardPath);
            shardReplaced = true;
          });
        } else if (snapshotStreamCount === 2) {
          parseOpenedAfterReplacement = shardReplaced;
        }
      }
      return stream;
    };
    let racedSelection;
    try {
      racedSelection = await Label.loadSelectionRecords(
        racedManifestPath,
        racedShardPath,
        contracts,
        { allowPendingCertificationForTest: true }
      );
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
    equal(shardReplaced, true,
      'selection shard pathname is replaced immediately after hashing');
    equal(snapshotStreamCount, 2,
      'selection authentication and parsing use two reads of one descriptor');
    equal(parseOpenedAfterReplacement, true,
      'record parsing begins only after the pathname names replacement bytes');
    equal(racedSelection.context.inputSha256, Corpus.sha256(body),
      'selection context retains the authenticated shard digest');
    equal(racedSelection.records[0].id, record.id,
      'record parsing consumes the authenticated open shard descriptor');
    equal(
      fs.readFileSync(racedShardPath, 'utf8'),
      replacementBody,
      'the adversarial pathname now names different valid records'
    );

    await assertAuthenticatedSourceSurvivesReplacement(
      temporary, '.jsonl'
    );
    await assertAuthenticatedSourceSurvivesReplacement(
      temporary, '.zst'
    );

    const mechanismInputPath =
      path.join(temporary, 'mechanism-input.jsonl');
    const mechanismInputBody = Prepare.stableJson({
      fen: record.fen,
      evals: [{
        depth: 20,
        knodes: 100,
        pvs: [{ cp: 12, line: 'e2e4 e8e7' }]
      }]
    }) + '\n';
    fs.writeFileSync(mechanismInputPath, mechanismInputBody);
    const mechanismSourceSha256 =
      Corpus.sha256(mechanismInputBody);
    const mechanismOutput =
      path.join(temporary, 'mechanism-selection');
    const mechanismPrepareLock = mechanismOutput + '.lock';
    const mechanismPrepareLockFd =
      Prepare.acquirePrefixLock(mechanismPrepareLock);
    try {
      await rejects(
        () => Prepare.prepare({
          input: mechanismInputPath,
          'source-sha256': mechanismSourceSha256,
          retrieved: '2026-07-31',
          output: mechanismOutput,
          modulus: '1',
          numerator: '1',
          shards: '1',
          'family-cap': '64',
          'minimum-selected': '1',
          'max-malformed-ppm': '0',
          'allow-missing-roles': 'true',
          'allow-pending-certification-for-test': 'true',
          'mechanism-fixture': 'true'
        }),
        /holds the output prefix lock/,
        'only one preparation process can own an output prefix'
      );
      equal(fs.existsSync(mechanismPrepareLock), true,
        'a refused preparation cannot remove the winning process lock');
    } finally {
      Prepare.releasePrefixLock(
        mechanismPrepareLockFd, mechanismPrepareLock
      );
    }
    const mechanismManifest = await Prepare.prepare({
      input: mechanismInputPath,
      'source-sha256': mechanismSourceSha256,
      retrieved: '2026-07-31',
      output: mechanismOutput,
      modulus: '1',
      numerator: '1',
      shards: '1',
      'family-cap': '64',
      'minimum-selected': '1',
      'max-malformed-ppm': '0',
      'allow-missing-roles': 'true',
      'allow-pending-certification-for-test': 'true',
      'mechanism-fixture': 'true'
    });
    equal(fs.existsSync(mechanismPrepareLock), false,
      'successful preparation releases its output-prefix lock');
    equal(
      mechanismManifest.state,
      'mechanism-test-selection-only'
    );
    equal(mechanismManifest.finalFitAllowed, false);
    equal(
      mechanismManifest.mechanismFixture,
      Prepare.MECHANISM_FIXTURE_MARKER,
      'the selection explicitly marks a non-official, non-fit fixture'
    );
    equal(Object.keys(mechanismManifest.source).sort(), [
      'compressedSha256', 'id', 'license', 'mechanismFixture',
      'retrieved', 'url'
    ]);
    equal(
      mechanismManifest.source.id,
      Prepare.MECHANISM_FIXTURE_SOURCE_ID
    );
    equal(mechanismManifest.source.url, null);
    equal(
      mechanismManifest.source.mechanismFixture,
      Prepare.MECHANISM_FIXTURE_MARKER
    );
    const mechanismManifestPath =
      path.join(mechanismOutput, 'manifest.json');
    const mechanismShardPath =
      path.join(mechanismOutput, 'selection-000.ndjson');
    const mechanismRecord = JSON.parse(
      fs.readFileSync(mechanismShardPath, 'utf8').trim()
    );
    equal(Object.keys(mechanismRecord.source).sort(), [
      'dataset', 'license', 'mechanismFixture', 'snapshotSha256'
    ]);
    equal(
      mechanismRecord.source.dataset,
      Prepare.MECHANISM_FIXTURE_SOURCE_ID
    );
    equal(
      mechanismRecord.source.mechanismFixture,
      Prepare.MECHANISM_FIXTURE_MARKER
    );
    equal(
      mechanismRecord.explorationLabel.teacher,
      Prepare.MECHANISM_FIXTURE_LABEL_TEACHER
    );
    await rejects(
      () => Label.loadSelectionContext(
        mechanismManifestPath,
        mechanismShardPath,
        contracts
      ),
      /wrong state or schema/,
      'production selection validation rejects a mechanism fixture'
    );
    await rejects(
      () => Label.loadSelectionContext(
        mechanismManifestPath,
        mechanismShardPath,
        contracts,
        { allowPendingCertificationForTest: true }
      ),
      /wrong state or schema/,
      'the legacy pending test override cannot admit a mechanism fixture'
    );
    const mechanismContext = await Label.loadSelectionContext(
      mechanismManifestPath,
      mechanismShardPath,
      contracts,
      { sampleOnly: true }
    );
    equal(mechanismContext.sampleOnly, true);
    equal(
      mechanismContext.certification.status,
      'awaiting-opening-freeze'
    );
    equal(
      Label.validateSelectionRecord(
        mechanismRecord, mechanismContext
      ),
      mechanismRecord
    );
    const missingRowMarker =
      JSON.parse(JSON.stringify(mechanismRecord));
    delete missingRowMarker.source.mechanismFixture;
    throws(
      () => Label.validateSelectionRecord(
        missingRowMarker, mechanismContext
      ),
      /source provenance does not match selection manifest/,
      'sample selection rows require their source-level fixture marker'
    );
    const malformedRowMarker =
      JSON.parse(JSON.stringify(mechanismRecord));
    malformedRowMarker.source.mechanismFixture.extra = true;
    throws(
      () => Label.validateSelectionRecord(
        malformedRowMarker, mechanismContext
      ),
      /mechanism fixture marker is invalid/,
      'sample selection rows require the exact fixture marker'
    );

    const malformedMechanism =
      JSON.parse(JSON.stringify(mechanismManifest));
    malformedMechanism.mechanismFixture.extra = true;
    const malformedMechanismPath =
      path.join(mechanismOutput, 'bad-mechanism-marker.json');
    fs.writeFileSync(
      malformedMechanismPath,
      Prepare.stableJson(malformedMechanism) + '\n'
    );
    await rejects(
      () => Label.loadSelectionContext(
        malformedMechanismPath,
        mechanismShardPath,
        contracts,
        { sampleOnly: true }
      ),
      /mechanism fixture marker is invalid/,
      'sample selection requires the exact non-fit marker'
    );
    const malformedSourceMechanism =
      JSON.parse(JSON.stringify(mechanismManifest));
    malformedSourceMechanism.source.mechanismFixture.extra = true;
    const malformedSourceMechanismPath =
      path.join(mechanismOutput, 'bad-source-mechanism-marker.json');
    fs.writeFileSync(
      malformedSourceMechanismPath,
      Prepare.stableJson(malformedSourceMechanism) + '\n'
    );
    await rejects(
      () => Label.loadSelectionContext(
        malformedSourceMechanismPath,
        mechanismShardPath,
        contracts,
        { sampleOnly: true }
      ),
      /mechanism fixture marker is invalid/,
      'sample manifests require the exact source-level fixture marker'
    );

    const failedOutput =
      path.join(temporary, 'failed-mechanism-selection');
    const foreignStaging = failedOutput + '.tmp-foreign-owner';
    fs.mkdirSync(foreignStaging);
    fs.writeFileSync(path.join(foreignStaging, 'sentinel'), 'foreign\n');
    await rejects(
      () => Prepare.prepare({
        input: mechanismInputPath,
        'source-sha256': mechanismSourceSha256,
        retrieved: '2026-07-31',
        output: failedOutput,
        modulus: '1',
        numerator: '1',
        shards: '1',
        'family-cap': '64',
        'minimum-selected': '2',
        'max-malformed-ppm': '0',
        'allow-missing-roles': 'true',
        'allow-pending-certification-for-test': 'true',
        'mechanism-fixture': 'true'
      }),
      /selected only 1 positions; minimum is 2/,
      'handled preparation failure rejects an incomplete selection'
    );
    equal(fs.existsSync(failedOutput), false);
    equal(fs.existsSync(failedOutput + '.lock'), false,
      'handled preparation failure releases its prefix lock');
    equal(
      fs.readFileSync(path.join(foreignStaging, 'sentinel'), 'utf8'),
      'foreign\n',
      'failure cleanup removes only staging owned by the failed run'
    );

    const normalOutput = path.join(temporary, 'normal-selection');
    const normalManifest = await Prepare.prepare({
      input: mechanismInputPath,
      'source-sha256': mechanismSourceSha256,
      retrieved: '2026-07-31',
      output: normalOutput,
      modulus: '1',
      numerator: '1',
      shards: '1',
      'family-cap': '64',
      'minimum-selected': '1',
      'max-malformed-ppm': '0',
      'allow-missing-roles': 'true',
      'allow-pending-certification-for-test': 'true'
    });
    equal(normalManifest.state, 'exploration-selection-only',
      'normal preparation retains the production selection state');
    equal(normalManifest.mechanismFixture, undefined,
      'normal preparation does not acquire a sample-only marker');
    equal(Object.keys(normalManifest.source).sort(), [
      'compressedSha256', 'id', 'license', 'retrieved', 'url'
    ], 'the production selection source shape is unchanged');
    equal(normalManifest.source.id, 'lichess-evaluations');
    equal(
      normalManifest.source.url,
      contracts.sourceEntry.canonicalUrl
    );
    const normalRecord = JSON.parse(fs.readFileSync(
      path.join(normalOutput, 'selection-000.ndjson'), 'utf8'
    ).trim());
    equal(Object.keys(normalRecord.source).sort(), [
      'dataset', 'license', 'snapshotSha256'
    ], 'the production selection row shape is unchanged');
    equal(normalRecord.source.dataset, 'lichess-evaluated-positions');
    await rejects(
      () => Prepare.prepare({
        input: mechanismInputPath,
        'source-sha256': mechanismSourceSha256,
        retrieved: '2026-07-31',
        output: normalOutput,
        modulus: '1',
        numerator: '1',
        shards: '1',
        'family-cap': '64',
        'minimum-selected': '1',
        'max-malformed-ppm': '0',
        'allow-missing-roles': 'true',
        'allow-pending-certification-for-test': 'true'
      }),
      /refusing existing --output directory/,
      'preparation never replaces a completed output directory'
    );
    equal(
      fs.readFileSync(
        path.join(normalOutput, 'manifest.json'), 'utf8'
      ),
      Prepare.stableJson(normalManifest) + '\n',
      'no-replace refusal preserves the completed manifest'
    );
    throws(
      () => Label.validateSelectionRecord(
        Object.assign({}, record, {
          source: Object.assign({}, record.source, {
            mechanismFixture:
              Object.assign({}, Prepare.MECHANISM_FIXTURE_MARKER)
          })
        }),
        context
      ),
      /source provenance does not match selection manifest/,
      'production row validation rejects a fixture marker'
    );

    const authenticatedExecutable =
      path.join(temporary, 'authenticated-stockfish');
    const authenticatedExecutableBody = [
      '#!/usr/bin/env -S node --preserve-symlinks-main',
      "'use strict';",
      "const readline = require('readline');",
      'const input = readline.createInterface({ input: process.stdin });',
      "input.on('line', function (line) {",
      "  if (line === 'uci') {",
      "    console.log('id name authenticated executable');",
      "    console.log('uciok');",
      "  } else if (line === 'isready') {",
      "    console.log('readyok');",
      "  } else if (line === 'quit') {",
      '    input.close();',
      '    process.exit(0);',
      '  }',
      '});',
      ''
    ].join('\n');
    fs.writeFileSync(
      authenticatedExecutable,
      authenticatedExecutableBody,
      { mode: 0o755 }
    );
    const stagedExecutable = Label.stageVerifiedExecutable(
      authenticatedExecutable,
      Corpus.sha256(authenticatedExecutableBody)
    );
    ok(stagedExecutable.path !== authenticatedExecutable,
      'the verified teacher owns a private snapshot name');
    if (process.platform !== 'win32') {
      equal(fs.fstatSync(stagedExecutable.fd).mode & 0o777, 0o500,
        'the retained executable inode is read/execute-only');
    }
    equal(fs.existsSync(stagedExecutable.path), false,
      'the verified executable inode has no mutable staging pathname');
    throws(
      () => new Label.UciEngine(
        stagedExecutable.path,
        { append: function () {} },
        contracts.teacher.watchdog
      ),
      /live verified executable handle/,
      'the engine refuses a verified pathname without its retained inode'
    );
    const attackerExecutable = authenticatedExecutable + '.replacement';
    const attackerExecutableBody = authenticatedExecutableBody.replace(
      'authenticated executable', 'replacement attacker'
    );
    fs.writeFileSync(
      attackerExecutable, attackerExecutableBody, { mode: 0o755 }
    );
    fs.renameSync(attackerExecutable, authenticatedExecutable);
    fs.writeFileSync(
      stagedExecutable.path, attackerExecutableBody, { mode: 0o755 }
    );
    equal(
      fs.readFileSync(stagedExecutable.path, 'utf8'),
      attackerExecutableBody,
      'the adversary replaces the verified staged pathname before spawn'
    );
    const stagedTranscript = [];
    const stagedEngine = new Label.UciEngine(
      stagedExecutable,
      { append: line => stagedTranscript.push(line) },
      contracts.teacher.watchdog
    );
    await stagedEngine.initialize(contracts.teacher.uci);
    await stagedEngine.quit();
    ok(
      stagedTranscript.includes('< id name authenticated executable'),
      'atomic source replacement cannot change the verified executable'
    );
    ok(
      !stagedTranscript.includes('< id name replacement attacker'),
      'the replacement staged pathname is never spawned'
    );
    fs.unlinkSync(stagedExecutable.path);
    Label.cleanupVerifiedExecutable(stagedExecutable);
    throws(
      () => fs.fstatSync(stagedExecutable.fd),
      /EBADF|bad file descriptor/,
      'the verified executable descriptor closes after engine lifetime'
    );
    equal(fs.existsSync(stagedExecutable.directory), false,
      'the private executable snapshot is narrowly removed after use');
    const dummyStockfish = path.join(temporary, 'not-stockfish');
    fs.writeFileSync(dummyStockfish, 'not the pinned executable\n');
    const mechanismLabelOutput =
      path.join(temporary, 'mechanism-teacher.ndjson');
    const mechanismLabelOptions = {
      input: mechanismShardPath,
      'selection-manifest': mechanismManifestPath,
      output: mechanismLabelOutput,
      stockfish: dummyStockfish
    };
    await rejects(
      () => Label.labelShard(mechanismLabelOptions),
      /wrong state or schema/,
      'normal labelShard rejects mechanism-fixture selection'
    );
    await rejects(
      () => Label.labelShard(
        mechanismLabelOptions, { sampleOnly: true }
      ),
      /Stockfish executable does not match/,
      'the explicit imported sample path admits the marked selection'
    );
    equal(fs.existsSync(mechanismLabelOutput + '.lock'), false,
      'both refused label attempts release the output-prefix lock');

    const failingQuitExecutable =
      path.join(temporary, 'failing-quit-stockfish');
    const failingQuitExecutableBody = [
      '#!/usr/bin/env -S node --preserve-symlinks-main',
      "'use strict';",
      "const readline = require('readline');",
      'const input = readline.createInterface({ input: process.stdin });',
      "input.on('line', function (line) {",
      "  if (line === 'uci') {",
      "    console.log('id name failing quit fixture');",
      "    console.log('uciok');",
      "  } else if (line === 'isready') {",
      "    console.log('readyok');",
      "  } else if (line === 'go nodes 100000') {",
      "    console.log('info depth 16 seldepth 22 score cp 23 " +
        "wdl 310 620 70 nodes 100000 pv e2e4 e7e5');",
      "    console.log('bestmove e2e4 ponder e7e5');",
      '  }',
      '});',
      ''
    ].join('\n');
    fs.writeFileSync(
      failingQuitExecutable,
      failingQuitExecutableBody,
      { mode: 0o755 }
    );
    const failingQuitOutput =
      path.join(temporary, 'failing-quit-teacher.ndjson');
    const failingQuitArtifacts = [
      failingQuitOutput,
      failingQuitOutput + '.exclusions.ndjson',
      failingQuitOutput + '.uci.log',
      failingQuitOutput + '.manifest.json'
    ];
    const teacherManifestPath = path.join(
      ROOT, 'eval', 'training', 'teacher-sf18-100kn-v1.json'
    );
    const originalReadFileSync = fs.readFileSync;
    const originalOpenSync = fs.openSync;
    const originalQuit = Label.UciEngine.prototype.quit;
    const originalAbort = Label.UciEngine.prototype.abort;
    let retainedExecutableFd = null;
    let failedQuitEngine = null;
    let abortCalls = 0;
    fs.readFileSync = function (filename, options) {
      const value = originalReadFileSync.call(fs, filename, options);
      if (typeof filename !== 'string' ||
          path.resolve(filename) !== teacherManifestPath) {
        return value;
      }
      const teacher = JSON.parse(
        typeof value === 'string' ? value : value.toString('utf8')
      );
      teacher.engine.executable.sha256 =
        Corpus.sha256(failingQuitExecutableBody);
      return Prepare.stableJson(teacher) + '\n';
    };
    fs.openSync = function (filename, flags, mode) {
      const fd = originalOpenSync.call(fs, filename, flags, mode);
      if (typeof filename === 'string' && flags === 'r' &&
          path.basename(filename) === 'stockfish' &&
          path.basename(path.dirname(filename))
            .startsWith('chessy-stockfish-executable-')) {
        retainedExecutableFd = fd;
      }
      return fd;
    };
    Label.UciEngine.prototype.quit = async function () {
      failedQuitEngine = this;
      throw new Error('adversarial quit failure before shutdown');
    };
    Label.UciEngine.prototype.abort = async function () {
      abortCalls++;
      return originalAbort.call(this);
    };
    try {
      await rejects(
        () => Label.labelShard({
          input: mechanismShardPath,
          'selection-manifest': mechanismManifestPath,
          output: failingQuitOutput,
          stockfish: failingQuitExecutable
        }, { sampleOnly: true }),
        /adversarial quit failure before shutdown/,
        'a quit failure aborts the label run before publication'
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.openSync = originalOpenSync;
      Label.UciEngine.prototype.quit = originalQuit;
      Label.UciEngine.prototype.abort = originalAbort;
      if (failedQuitEngine && !failedQuitEngine.exited) {
        failedQuitEngine.forceKill();
        await failedQuitEngine.closed;
      }
    }
    equal(abortCalls, 1,
      'the retained engine is aborted after quit throws');
    equal(failedQuitEngine.exited, true,
      'the failing-quit child is fully reaped');
    throws(
      () => process.kill(failedQuitEngine.child.pid, 0),
      /ESRCH|no such process/,
      'no failing-quit Stockfish child remains alive'
    );
    throws(
      () => fs.fstatSync(retainedExecutableFd),
      /EBADF|bad file descriptor/,
      'failing quit closes the retained executable descriptor'
    );
    equal(
      failingQuitArtifacts.filter(filename => fs.existsSync(filename)),
      [],
      'failing quit publishes no completed label artifacts'
    );
    equal(fs.existsSync(failingQuitOutput + '.lock'), false,
      'failing quit releases the output-prefix lock');
    equal(
      fs.readdirSync(temporary).filter(name =>
        name.startsWith(path.basename(failingQuitOutput) + '.tmp-')),
      [],
      'failing quit removes every partial label artifact'
    );

    const overstatedControlPath =
      path.join(temporary, 'overstated-control-manifest.json');
    const overstatedControl =
      selectionManifest(sourceSha256, shardName, body);
    overstatedControl.exclusions.sameSourceGameLineageControlStatus =
      'enforced';
    fs.writeFileSync(
      overstatedControlPath,
      Prepare.stableJson(overstatedControl) + '\n'
    );
    await rejects(
      () => Label.loadSelectionContext(
        overstatedControlPath,
        shardPath,
        contracts,
        { allowPendingCertificationForTest: true }
      ),
      /misstates held-out control enforcement/,
      'teacher relabelling rejects a manifest that overstates pending controls'
    );

    const artifactPaths = {
      input: shardPath,
      output: path.join(temporary, 'teacher-000.ndjson'),
      exclusions:
        path.join(temporary, 'teacher-000.ndjson.exclusions.ndjson'),
      transcript: path.join(temporary, 'teacher-000.ndjson.uci.log')
    };
    const artifactSummaries = {
      output: { rows: 1, sha256: '1'.repeat(64) },
      exclusions: { rows: 0, sha256: '2'.repeat(64) },
      transcript: { rows: 9, sha256: '3'.repeat(64) }
    };
    throws(() => Label.buildSidecarManifest(
      context,
      artifactPaths,
      artifactSummaries,
      contracts.teacher.engine.executable.sha256,
      {}
    ), /requires frozen E4 certification provenance/,
    'even the sidecar builder refuses pending certification provenance');
    throws(() => Label.buildSidecarManifest(
      context,
      artifactPaths,
      artifactSummaries,
      contracts.teacher.engine.executable.sha256,
      {},
      { sampleOnly: true }
    ), /requires a validated mechanism fixture/,
    'sample mode cannot be applied to an ordinary selection');
    const mechanismSidecar = Label.buildSidecarManifest(
      mechanismContext,
      Object.assign({}, artifactPaths, {
        input: mechanismShardPath
      }),
      artifactSummaries,
      contracts.teacher.engine.executable.sha256,
      {},
      { sampleOnly: true }
    );
    equal(
      mechanismSidecar.state,
      'pinned-teacher-labels-sample-only'
    );
    equal(mechanismSidecar.fitAllowed, false);
    equal(
      mechanismSidecar.mechanismFixture,
      Prepare.MECHANISM_FIXTURE_MARKER,
      'teacher sidecar propagates the strict sample-only marker'
    );
    equal(
      mechanismSidecar.input.selectionManifest.certificationStatus,
      'awaiting-opening-freeze'
    );
    const frozenContext = Object.assign({}, context, {
      certification: Object.assign({}, context.certification, {
        status: 'frozen'
      })
    });
    const sidecar = Label.buildSidecarManifest(
      frozenContext,
      artifactPaths,
      artifactSummaries,
      contracts.teacher.engine.executable.sha256,
      {}
    );
    equal(sidecar.state, 'pinned-teacher-labels');
    equal(sidecar.fitAllowed, undefined,
      'production sidecar shape remains free of sample-only fields');
    equal(sidecar.mechanismFixture, undefined,
      'production sidecar never carries a mechanism marker');
    equal(
      sidecar.input.selectionManifest.selectionContractSha256,
      context.manifest.adapter.selectionContractSha256
    );
    equal(
      sidecar.input.selectionManifest.certificationStatus,
      'frozen'
    );
    equal(sidecar.teacher.options, contracts.teacher.uci);
    equal(sidecar.teacher.watchdog, contracts.teacher.watchdog);
    equal(sidecar.teacher.use, contracts.teacher.engine.integration);

    const recomputedDrifts = {
      id: '0'.repeat(64),
      canonicalFen: record.fen,
      cluster: '1'.repeat(64),
      positionFamily: '2'.repeat(64),
      role: record.role === 'nnue-test' ? 'shared-train' : 'nnue-test'
    };
    Object.entries(recomputedDrifts).forEach(function ([field, value]) {
      throws(() => Label.validateSelectionRecord(
        Object.assign({}, record, { [field]: value }),
        context
      ), new RegExp('recomputed ' + field + ' does not match'),
      field + ' is recomputed instead of trusted from the selected row');
    });
    throws(() => Label.validateSelectionRecord(
      Object.assign({}, record, {
        teacher: { id: 'arbitrary', targetWhite: 0.5 }
      }),
      context
    ), /arbitrary teacher metadata/);

    const certificationContext = Object.assign({}, context, {
      certification: {
        clusters: new Set([record.cluster]),
        positionFamilies: new Set()
      }
    });
    throws(() => Label.validateSelectionRecord(record, certificationContext),
      /E4 certification cluster\/family is forbidden/,
      'records from the E4 certification holdout are rejected');

    const heldout = selectedRecord(
      contracts.heldout.incident.fen,
      sourceSha256
    );
    throws(() => Label.validateSelectionRecord(heldout, context),
      /held-out incident cluster\/family is forbidden/);

    const badManifestPath = path.join(temporary, 'bad-manifest.json');
    const badManifest = selectionManifest(sourceSha256, shardName, body);
    badManifest.shards[0].canonicalNdjsonSha256 = '0'.repeat(64);
    fs.writeFileSync(
      badManifestPath,
      Prepare.stableJson(badManifest) + '\n'
    );
    await rejects(
      () => Label.loadSelectionContext(
        badManifestPath,
        shardPath,
        contracts,
        { allowPendingCertificationForTest: true }
      ),
      /selection shard SHA-256 does not match/,
      'a shard cannot be detached from its selection manifest hash'
    );

    const badContractPath = path.join(temporary, 'bad-contract.json');
    const badContract = selectionManifest(sourceSha256, shardName, body);
    badContract.adapter.selectionContractSha256 = '0'.repeat(64);
    fs.writeFileSync(
      badContractPath,
      Prepare.stableJson(badContract) + '\n'
    );
    await rejects(
      () => Label.loadSelectionContext(
        badContractPath,
        shardPath,
        contracts,
        { allowPendingCertificationForTest: true }
      ),
      /aggregate contract SHA-256 does not match/,
      'selection manifests cannot detach from the frozen adapter contract'
    );

    const assessment = Label.assessTeacherResult(
      { info: cpThenMate, bestMove: 'h7h8q' },
      'w',
      contracts.teacher
    );
    const exclusion = Label.exclusionRecord(record, assessment, contracts);
    equal(exclusion.schema, 'chessy.teacher-exclusion.v1');
    equal(exclusion.reason, 'mate-score');
    equal(exclusion.detail.cpSideToMove, undefined,
      'mate exclusions never retain a stale earlier CP score');
    equal(
      Prepare.stableJson(exclusion),
      Prepare.stableJson(
        Label.exclusionRecord(record, assessment, contracts)
      ),
      'per-row exclusion ledger records are deterministic'
    );

    const labelled = Label.labelledRecord(
      record,
      { info, terminalInfo: info, bestMove: 'e5e4' },
      eligible,
      contracts
    );
    equal(labelled.explorationLabel, undefined);
    equal(labelled.sourceExplorationLabel, undefined,
      'mixed upstream labels cannot enter the fit-ready teacher row');
    equal(labelled.teacher.id, contracts.teacher.id);
    equal(labelled.teacher.manifestSha256, contracts.teacherSha256);
    equal(labelled.teacher.scoreNodes, 100000);
    equal(labelled.teacher.reportedNodes, 100000);
    const mechanismLabelled = Label.labelledRecord(
      mechanismRecord,
      { info, terminalInfo: info, bestMove: 'e5e4' },
      eligible,
      contracts
    );
    equal(
      mechanismLabelled.source.dataset,
      Prepare.MECHANISM_FIXTURE_SOURCE_ID
    );
    equal(
      mechanismLabelled.source.mechanismFixture,
      Prepare.MECHANISM_FIXTURE_MARKER,
      'sample teacher rows retain exact source-level fixture provenance'
    );

    const crossed = Label.labelledRecord(
      record,
      {
        info: completedExact,
        terminalInfo: terminalBound,
        bestMove: 'e2e4'
      },
      crossedNodeBoundary,
      contracts
    );
    equal(crossed.teacher.scoreNodes, 61564);
    equal(crossed.teacher.reportedNodes, 100054);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

integration().then(function () {
  console.log(checks + ' Stockfish-label adapter checks passed');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
