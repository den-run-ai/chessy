#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Data = require('../../tools/training/hce-synthetic-pilot-data');
const Corpus = require('./corpus');
const Linear = require('./hce-r3-linear');

const ROOT = path.join(__dirname, '..', '..');
const LABELER = path.join(ROOT, 'tools', 'training', 'hce-synthetic-pilot-label.js');
const HELDOUT = JSON.parse(fs.readFileSync(path.join(
  ROOT, 'eval', 'training', 'heldout-v1.json'
), 'utf8'));
const HEX = /^[0-9a-f]{64}$/;
let checks = 0;

function check(callback) {
  callback();
  checks++;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodedRows(rows) {
  return rows.map(function (row) { return JSON.stringify(row) + '\n'; }).join('');
}

check(function () {
  assert.deepStrictEqual(Data.rowQuotas(100), {
    train: { opening: 24, middlegame: 23, endgame: 23 },
    validation: { opening: 5, middlegame: 5, endgame: 5 },
    test: { opening: 5, middlegame: 5, endgame: 5 }
  });
  assert.throws(function () { Data.rowQuotas(89); }, /at least 90/);
});

check(function () {
  assert.deepStrictEqual(Data.parseArgs(['--rows', '180', '--seed', '7']), {
    rows: 180,
    seed: 7,
    metadata: false
  });
  assert.strictEqual(Data.parseArgs(['--metadata']).metadata, true);
  assert.throws(function () { Data.parseArgs(['--seed', '-1']); }, /seed/);
  assert.throws(function () { Data.parseArgs(['--unknown', '1']); }, /unknown/);
});

const first = Data.generate({ rows: 180, seed: Data.DEFAULT_SEED });
const second = Data.generate({ rows: 180, seed: Data.DEFAULT_SEED });
const firstBytes = encodedRows(first.rows);

check(function () {
  assert.strictEqual(first.rows.length, 180);
  assert.deepStrictEqual(first.counts, first.quotas);
  assert.strictEqual(firstBytes, encodedRows(second.rows));
  assert.strictEqual(
    sha256(firstBytes),
    'a8c19daf0647254019a30a68bf31d62eb20986ca4de37eb90bcc4225843ea555'
  );
});

check(function () {
  const clusters = new Set();
  const familyCounts = new Map();
  const familySplits = new Map();
  for (const row of first.rows) {
    assert(HEX.test(row.id));
    assert.strictEqual(
      row.id,
      sha256('chessy-hce-synthetic-pilot-v1\n' + row.fen)
    );
    assert(!clusters.has(row.cluster));
    clusters.add(row.cluster);
    assert.strictEqual(row.cluster, Corpus.clusterKey(row.fen));
    assert.strictEqual(row.positionFamily, Corpus.positionFamilyKey(row.fen));
    assert.strictEqual(row.split, Data.splitForFamily(row.positionFamily));
    assert.strictEqual(row.phase, Corpus.phaseBucket(row.fen));
    assert.notStrictEqual(row.cluster, HELDOUT.symmetryPolicy.clusterSha256);
    assert.notStrictEqual(
      row.positionFamily,
      HELDOUT.symmetryPolicy.positionFamilySha256
    );
    const familyCount = (familyCounts.get(row.positionFamily) || 0) + 1;
    familyCounts.set(row.positionFamily, familyCount);
    assert(familyCount <= Data.FAMILY_CAP);
    const priorSplit = familySplits.get(row.positionFamily);
    if (priorSplit) assert.strictEqual(priorSplit, row.split);
    familySplits.set(row.positionFamily, row.split);
    assert(['MIT', 'CC0-1.0'].includes(row.sourceSeed.license));
    assert(HEX.test(row.sourceSeed.sourceSha256));

    const compiled = Linear.compile(row.fen);
    assert.strictEqual(row.fixedCp, compiled.fixedCp);
    assert.deepStrictEqual(
      row.indices,
      compiled.sparse.map(function (entry) { return entry[0]; })
    );
    assert.deepStrictEqual(
      row.data,
      compiled.sparse.map(function (entry) { return entry[1]; })
    );
  }
});

check(function () {
  const metadata = Data.metadata();
  assert.strictEqual(metadata.parameters, 965);
  assert.strictEqual(metadata.baselineParameters, 753);
  assert.strictEqual(metadata.center.length, 965);
  assert.strictEqual(metadata.scales.length, 965);
  assert.strictEqual(metadata.qualityClaimAllowed, false);
  assert(HEX.test(metadata.corpus.sha256));
});

function fakeEngineSource() {
  return `#!/usr/bin/env node
'use strict';
const readline = require('readline');
let searches = 0;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', function (line) {
  if (line === 'uci') {
    console.log('id name Stockfish 18');
    console.log('id author pilot fake');
    console.log('option name EvalFile type string default nn-c288c895ea92.nnue');
    console.log('option name EvalFileSmall type string default nn-37f18f62d772.nnue');
    console.log('uciok');
  } else if (line === 'isready') {
    console.log('readyok');
  } else if (line.startsWith('go nodes ')) {
    const nodes = Number(line.split(/\\s+/)[2]);
    searches++;
    if (searches === 1) {
      console.log('info depth 8 seldepth 12 score mate 2 wdl 1000 0 0 nodes ' + nodes + ' pv a2a3');
      console.log('bestmove a2a3');
    } else {
      const depth = searches === 3 ? 12 : 8;
      const seldepth = searches === 3 ? 8 : 12;
      console.log('info depth ' + depth + ' seldepth ' + seldepth + ' score cp 25 wdl 500 400 100 nodes ' + nodes + ' pv a2a3');
      console.log(searches === 2 ? 'bestmove a2a4' : 'bestmove a2a3');
    }
  } else if (line === 'quit') {
    process.exit(0);
  }
});
`;
}

check(function () {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-hce-pilot-test-'));
  try {
    const engine = path.join(temporary, 'fake-stockfish');
    const summaryPath = path.join(temporary, 'summary.json');
    fs.writeFileSync(engine, fakeEngineSource(), { flag: 'wx', mode: 0o755 });
    const executableSha256 = sha256(fs.readFileSync(engine));
    const result = spawnSync(process.execPath, [
      LABELER,
      '--stockfish', engine,
      '--summary', summaryPath,
      '--rows', '90',
      '--seed', String(Data.DEFAULT_SEED),
      '--nodes', '1000',
      '--hash-mb', '1',
      '--expected-executable-sha256', executableSha256,
      '--expected-evalfile-sha256', '1'.repeat(64),
      '--expected-evalfile-small-sha256', '2'.repeat(64),
      '--verify-networks', 'false'
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const output = result.stdout;
    const rows = output.trim().split('\n').map(JSON.parse);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.strictEqual(rows.length, 87);
    assert.strictEqual(summary.output.labelledRows, 87);
    assert.strictEqual(summary.output.excludedRows, 3);
    assert.deepStrictEqual(summary.output.exclusionReasons, {
      'mate-or-missing-exact-cp': 1,
      'bestmove-pv-mismatch': 1,
      'invalid-depth-or-seldepth': 1
    });
    assert.strictEqual(summary.provenance.labelledStreamSha256, sha256(output));
    assert.strictEqual(
      summary.provenance.generatedInputSha256,
      sha256(encodedRows(Data.generate({ rows: 90, seed: Data.DEFAULT_SEED }).rows))
    );
    assert(summary.teacher.identityLines.includes('id name Stockfish 18'));
    assert.strictEqual(summary.teacher.networks.EvalFile.verified, false);
    for (const row of rows) {
      assert.strictEqual(row.teacher.pvUci[0], row.teacher.bestMoveUci);
      assert.strictEqual(
        row.teacher.targetWhite,
        (row.teacher.wdlWhite[0] + 0.5 * row.teacher.wdlWhite[1]) / 1000
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

check(function () {
  const directory = path.join(ROOT, 'eval', 'training', 'pilots');
  const summaryPath = path.join(
    directory, 'hce-synthetic-12k-25kn-label-summary.json'
  );
  const analysisPath = path.join(
    directory, 'hce-synthetic-12k-25kn-analysis.json'
  );
  const reviewPath = path.join(
    directory, 'hce-synthetic-12k-25kn-review.json'
  );
  const summaryBytes = fs.readFileSync(summaryPath);
  const analysisBytes = fs.readFileSync(analysisPath);
  const analysis = JSON.parse(analysisBytes);
  const review = JSON.parse(fs.readFileSync(reviewPath));
  assert.strictEqual(
    sha256(summaryBytes),
    '2f8076471fb49cd57a87233b54d60a8b0e6406e4dcdfb28804d60550b2a0a57f'
  );
  assert.strictEqual(
    sha256(analysisBytes),
    '566ee8e8c5f11b9a573cf33ebd0fe0ee33c024615198391c0a28269224fce5f7'
  );
  assert.strictEqual(review.sourceRun.labelSummary.sha256, sha256(summaryBytes));
  assert.strictEqual(review.sourceRun.analysis.sha256, sha256(analysisBytes));
  assert.strictEqual(analysis.candidateProduced, false);
  assert.strictEqual(analysis.weightsEmitted, false);
  assert.strictEqual(review.protocolReview.acceptedRowsFailingFrozenDepthSeldepthRule, 215);
  const surfaces = Object.fromEntries(analysis.surfaces.map(function (surface) {
    return [surface.surface, surface];
  }));
  assert.strictEqual(
    review.crossEntropy.fullR3.test,
    surfaces['full-r3'].float.test.crossEntropy
  );
  assert.strictEqual(review.decision.outcome, 'stop-no-runtime-candidate');
});

console.log('hce-synthetic-pilot tests: ' + checks + ' groups passed');
