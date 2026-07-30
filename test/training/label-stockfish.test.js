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

async function integration() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'chessy-label-contract-')
  );
  try {
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
    const context = await Label.loadSelectionContext(
      manifestPath,
      shardPath,
      contracts,
      { allowPendingCertificationForTest: true }
    );
    const records = await Label.loadRecords(shardPath, context);
    equal(records.length, 1);
    equal(records[0].id, record.id);

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
