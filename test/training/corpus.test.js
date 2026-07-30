#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
}

const heldoutPath = path.join(__dirname, '..', '..', 'eval', 'training', 'heldout-v1.json');
const heldout = JSON.parse(fs.readFileSync(heldoutPath, 'utf8'));
const hceFit = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'eval', 'training', 'hce-r3-fit-v1.json'), 'utf8'));
const incident = heldout.incident.fen;
const heldoutControlStatus =
  Prepare.validateHeldoutExclusionPolicy(heldout);

assert.deepStrictEqual(Corpus.symmetryFens(incident), heldout.symmetryPolicy.fens4);
checks++;
assert.strictEqual(Corpus.canonicalFen4(incident), heldout.symmetryPolicy.canonicalFen4);
checks++;
assert.strictEqual(Corpus.canonicalModelBoard(incident),
  heldout.symmetryPolicy.canonicalModelBoard);
checks++;
assert.strictEqual(Corpus.clusterKey(incident), heldout.symmetryPolicy.clusterSha256);
checks++;
assert.strictEqual(Corpus.positionFamilyKey(incident),
  heldout.symmetryPolicy.positionFamilySha256);
checks++;
for (const fen of heldout.symmetryPolicy.fens4) {
  assert.strictEqual(Corpus.clusterKey(fen), heldout.symmetryPolicy.clusterSha256);
  assert.strictEqual(Corpus.positionFamilyKey(fen),
    heldout.symmetryPolicy.positionFamilySha256);
  checks += 2;
}
assert.deepStrictEqual(heldoutControlStatus, {
  incidentFamily: 'enforced',
  sameSourceGameLineage: 'pending-source-game-id',
  nearbyBudgetTraining: 'enforced-by-incident-family',
  nearbyBudgetPreregistration: 'preregistered',
  nearbyBudgetNodes: [8268594, 10106060],
  nearbyBudgetContract:
    'eval/training/hce-r3-fit-v1.json#/lockedPostFitGate/nearbyNodes',
  nearbyBudgetExecutionEvidence: 'pending-post-fit-execution'
});
checks++;
assert.deepStrictEqual(
  heldout.exclusion.controls.nearbyBudgetProbes.nodes,
  hceFit.lockedPostFitGate.nearbyNodes
);
checks++;
assert.throws(function () {
  const overstated = JSON.parse(JSON.stringify(heldout));
  overstated.exclusion.controls.sameSourceGameLineage.status = 'enforced';
  Prepare.validateHeldoutExclusionPolicy(overstated);
}, /control status drifted/);
checks++;
assert.throws(function () {
  const incomplete = JSON.parse(JSON.stringify(heldout));
  incomplete.exclusion.applyBefore =
    incomplete.exclusion.applyBefore.filter(function (stage) {
      return stage !== 'exploration-label-use';
    });
  Prepare.validateHeldoutExclusionPolicy(incomplete);
}, /control status drifted/);
checks++;

const stateVariants = [
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq -',
  'r3k2r/8/8/8/8/8/8/R3K2R b - -',
  'r3k2r/8/8/8/8/8/8/R3K2R w Kq -'
];
check(new Set(stateVariants.map(Corpus.clusterKey)).size === 1,
  'model-equivalent boards cannot split by side/castling/en-passant state');
check(new Set(stateVariants.map(fen =>
  Corpus.roleForCluster(Corpus.positionFamilyKey(fen)))).size === 1,
  'one structural position family cannot cross experiment roles');

const impossibleEp =
  '4k3/8/8/8/4p3/8/8/4K3 w - e6 0 1';
assert.strictEqual(Corpus.parseFen4(impossibleEp).fen4,
  '4k3/8/8/8/4p3/8/8/4K3 w - -');
checks++;
const capturableEp =
  '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1';
assert.strictEqual(Corpus.parseFen4(capturableEp).fen4,
  '4k3/8/8/3Pp3/8/8/8/4K3 w - e6');
checks++;
assert.throws(() => Corpus.parseFen4(
  '8/8/8/8/8/8/4k3/4K3 w - -'), /adjacent/);
assert.throws(() => Corpus.validateSourceState(
  '4k3/8/8/8/8/8/8/4K3 w K -'), /castling right/);
assert.throws(() => Corpus.parseFen4(
  'P3k3/8/8/8/8/8/8/4K3 w - -'), /pawn on rank/);
checks += 3;

const evalRecord = {
  fen: '4k3/8/8/8/8/8/4P3/4K3 w - -',
  evals: [
    { depth: 18, knodes: 900, pvs: [{ cp: -12, line: 'e2e4 e8e7' }] },
    { depth: 22, knodes: 100, pvs: [{ cp: 34, line: 'e2e3 e8e7' }] },
    { depth: 22, knodes: 200, pvs: [{ cp: 41, line: 'e2e4 e8e7' }] },
    { depth: 30, knodes: 500, pvs: [{ mate: 4, line: 'e2e4' }] }
  ]
};
assert.deepStrictEqual(Corpus.chooseLichessEval(evalRecord), {
  cpWhite: 41,
  depth: 22,
  knodes: 200,
  pvUci: ['e2e4', 'e8e7']
});
checks++;
const adapted = Corpus.adaptLichessRecord(evalRecord, { sha256: 'a'.repeat(64) });
check(adapted.schema === Corpus.SCHEMA &&
  adapted.explorationLabel.cpWhite === 41 &&
  adapted.explorationLabel.teacher === 'lichess-mixed-stockfish',
'Lichess adapter retains White-POV exploration label');
check([
  'shared-train', 'hce-validation', 'hce-test', 'nnue-validation', 'nnue-test'
].includes(adapted.role), 'adapter assigns one isolated experiment role');
check(adapted.source.license === 'CC0-1.0', 'adapter preserves CC0 source license');

const featureFen = '8/8/8/8/8/8/P6p/K6k w - -';
assert.deepStrictEqual(Corpus.encodeNnue768(featureFen, 'w'), [48, 376, 439, 767]);
assert.deepStrictEqual(Corpus.encodeNnue768(featureFen, 'b'), [15, 327, 392, 704]);
checks += 2;
const colorRank = Corpus.transformFen4(featureFen, 'color-rank');
assert.deepStrictEqual(Corpus.encodeNnue768(colorRank, 'b'),
  Corpus.encodeNnue768(featureFen, 'w'));
checks++;

const p0 = Corpus.teacherProbability(0);
check(Math.abs(p0 - 0.5) < 1e-12, 'zero CP maps to an even soft target');
check(Corpus.teacherProbability(200) > p0 &&
  Corpus.teacherProbability(-200) < p0, 'soft target is monotone in White-POV CP');

async function integration() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-corpus-test-'));
  try {
    const input = path.join(temp, 'source.jsonl');
    const outA = path.join(temp, 'out-a');
    const outB = path.join(temp, 'out-b');
    const rows = [
      evalRecord,
      {
        fen: incident,
        evals: [{
          depth: 20,
          knodes: 8268,
          pvs: [{ cp: -90, line: 'e5e4' }]
        }]
      },
      {
        fen: heldout.symmetryPolicy.fens4[1],
        evals: [{
          depth: 20,
          knodes: 10106,
          pvs: [{ cp: -90, line: 'd5d4' }]
        }]
      },
      {
        fen: '4k3/8/8/8/8/2N5/4P3/4K3 b - -',
        evals: [{ depth: 21, knodes: 2, pvs: [{ cp: 120, line: 'e8e7' }] }]
      }
    ];
    const text = rows.map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(input, text);
    const sha = Corpus.sha256(text);
    const args = {
      input,
      output: outA,
      'source-sha256': sha,
      retrieved: '2026-07-29',
      modulus: '1',
      numerator: '1',
      shards: '4',
      'minimum-selected': '1',
      'allow-missing-roles': 'true',
      'allow-pending-certification-for-test': 'true'
    };
    const first = await Prepare.prepare(args);
    const second = await Prepare.prepare(Object.assign({}, args, { output: outB }));
    assert.strictEqual(first.counts.inputRows, 4);
    assert.strictEqual(first.counts.selected, 2);
    assert.strictEqual(first.counts.incidentClusterExcluded, 2);
    assert.strictEqual(first.exclusions.appliedBeforeSplit, true);
    assert.strictEqual(first.exclusions.certificationStatus,
      'awaiting-opening-freeze');
    assert.strictEqual(first.exclusions.pendingCertificationAllowedForTestOnly,
      true);
    assert.strictEqual(first.exclusions.incidentFamilyControlStatus,
      'enforced');
    assert.strictEqual(first.exclusions.sameSourceGameLineageControlStatus,
      'pending-source-game-id');
    assert.strictEqual(first.exclusions.nearbyBudgetTrainingControlStatus,
      'enforced-by-incident-family');
    assert.strictEqual(first.exclusions.nearbyBudgetPreregistrationStatus,
      'preregistered');
    assert.deepStrictEqual(first.exclusions.nearbyBudgetNodes,
      [8268594, 10106060]);
    assert.strictEqual(first.exclusions.nearbyBudgetContract,
      'eval/training/hce-r3-fit-v1.json#/lockedPostFitGate/nearbyNodes');
    assert.strictEqual(first.exclusions.nearbyBudgetExecutionEvidenceStatus,
      'pending-post-fit-execution');
    assert.strictEqual(first.adapter.corpusContractSha256,
      Corpus.sha256(fs.readFileSync(path.join(__dirname, 'corpus.js'))));
    assert.match(first.adapter.selectionContractSha256, /^[0-9a-f]{64}$/);
    checks += 15;
    assert.strictEqual(
      fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'),
      fs.readFileSync(path.join(outB, 'manifest.json'), 'utf8'));
    checks++;
    for (const shard of first.shards) {
      assert.strictEqual(
        fs.readFileSync(path.join(outA, shard.path), 'utf8'),
        fs.readFileSync(path.join(outB, shard.path), 'utf8'));
      checks++;
    }
    const selectedText = first.shards.map(shard =>
      fs.readFileSync(path.join(outA, shard.path), 'utf8')).join('');
    check(!selectedText.includes(heldout.symmetryPolicy.clusterSha256),
      'incident symmetry cluster is absent from every output shard');
    check(!selectedText.includes(heldout.symmetryPolicy.positionFamilySha256),
      'incident position family is absent from every output shard');
    check(first.counts.incidentClusterExcluded === 2,
      'incident-family quarantine is independent of nearby source label budgets');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

integration().then(function () {
  console.log(checks + ' training-corpus checks passed');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
