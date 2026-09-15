'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const Audit = require('./ai-match-holdout-audit');
const U = require('./ai-match-opening-utils-v2');

// Literal compatibility oracles from PR146 corpus.js at 1e01c0b. These are
// independent of the new implementation and catch representation drift.
const golden = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    '7bd725e0b253d79dff08daa96a3a69ac88f72e5be9ecf0824b9ae1cb1c2700ee'],
  ['rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    '4e0a65188e5e8b9e7cac9830233676d6bc1550187682dda469634c50f72d57c6'],
  ['4k3/8/2p5/8/4P3/8/8/4K3 w - - 0 1',
    '04ca2d4779246de749facc32a676b70d7378615b1d62ffd5c815e7254d15efe3']
];
for (const [fen, expected] of golden) assert.equal(Audit.structuralFamilyKey(fen), expected);
const asymmetric = golden[2][0];
assert.equal(Audit.structuralFamilyKey('3k4/8/5p2/8/3P4/8/8/3K4 w - - 0 1'),
  Audit.structuralFamilyKey(asymmetric), 'file reflection is static-family equivalent');
assert.equal(Audit.structuralFamilyKey(U.colourRankMirror(asymmetric.split(' ').slice(0, 4).join(' ')) + ' 0 1'),
  Audit.structuralFamilyKey(asymmetric), 'color/rank reflection is equivalent');
assert.equal(Audit.structuralFamilyKey(asymmetric.replace(' w ', ' b ')),
  Audit.structuralFamilyKey(asymmetric), 'side to move is outside this static key');
for (const variant of [
  '4k3/8/2p5/8/8/4P3/8/4K3 w - - 0 1', // pawn square
  '4k3/8/2p5/8/4P3/8/8/3K4 w - - 0 1', // king square
  '4k3/8/2p5/8/4P3/8/8/N3K3 w - - 0 1' // material
]) assert.notEqual(Audit.structuralFamilyKey(variant), Audit.structuralFamilyKey(asymmetric));

const row = (id, pgn, family = 'Example') => ({ id, pgn, family });
const sameStructure = Audit.audit([row('Nf3', 'e4 e5 Nf3'), row('Nc3', 'e4 e5 Nc3')], []);
assert.equal(sameStructure.endpointEquivalence.groups, 2);
assert.equal(sameStructure.staticStructuralFamilies.groups, 1);
assert.equal(sameStructure.staticStructuralFamilies.largestGroup, 2);
assert.equal(sameStructure.staticStructuralFamilies.endpointsBeyondOnePerGroup, 1);
assert.deepEqual(sameStructure.staticStructuralFamilies.groupsBySize, { 2: 1 });
const transposed = Audit.audit([row('A', 'Nf3 d5 g3'), row('B', 'g3 d5 Nf3')], []);
assert.equal(transposed.endpointEquivalence.groups, 1, 'transposed endpoints group together');
assert.equal(Audit.audit([row('A', 'e4 e5 Nf3'), row('B', 'e4 c5 Nf3')], [])
  .staticStructuralFamilies.groups, 2, 'pawn change creates another family');

const line = 'e4 e5 Nf3 Nc6 Bc4 Bc5';
const candidates = [row('exact', line), row('descendant', line + ' d3'),
  row('unrelated', 'e4 c5 Nf3 d6 d4 cxd4')];
const prior = [{ id: 'exposed', openings: [row('old', line)] },
  { id: 'short', openings: [row('first-move', 'e4')] }];
const counts = Audit.audit(candidates, prior);
assert.equal(counts.exposureOverlap.union.endpointEquivalence, 1);
assert.equal(counts.exposureOverlap.union.strictContinuationOfExposedLineAtLeastSixPlies, 1);
assert.equal(counts.exposureOverlap.bySource.short.strictContinuationOfExposedLineAtLeastSixPlies, 0,
  'sharing a common first move is not counted as exposed-line continuation');
assert.equal(counts.namedOpeningFamilies.groups, 1);
assert.equal(counts.endpointEquivalence.groups, 3, 'taxonomy must not replace endpoint identity');
assert.throws(() => Audit.audit([], []), /between 1 and 10000/);
assert.throws(() => Audit.audit([row('same', 'e4'), row('same', 'd4')], []), /distinct ID/);
assert.throws(() => Audit.audit([{ ...row('bad', 'e4'), fen: golden[0][0] }], []), /differs from legal replay/);
assert.throws(() => Audit.audit([row('bad', 'e4 e4')], []), /matched 0/);

const report = Audit.currentReport();
assert.equal(report.disposition, 'diagnostic-only');
assert.equal(report.independence.established, false);
assert.equal(report.independence.effectiveSampleSize, null);
assert.equal(report.sourceGameGrouping.sourceGames, null);
assert.equal(report.counts.endpoints, 400);
assert.equal(report.counts.endpointEquivalence.groups, 400);
assert.equal(report.counts.staticStructuralFamilies.groups, 340);
assert.equal(report.counts.namedOpeningFamilies.groups, 60);
assert.equal(report.counts.exposureOverlap.union.endpointEquivalence, 0);
assert.equal(report.counts.exposureOverlap.union.structuralFamily, 61);
const rendered = JSON.stringify(report, null, 2) + '\n';
assert.equal(fs.readFileSync(path.join(__dirname, '../eval/match-v2/holdout-audit.json'), 'utf8'), rendered);
const cli = cp.spawnSync(process.execPath, [path.join(__dirname, 'ai-match-holdout-audit.js'), '--check'],
  { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
const invalidCli = cp.spawnSync(process.execPath, [path.join(__dirname, 'ai-match-holdout-audit.js'), '--fit'],
  { encoding: 'utf8' });
assert.notEqual(invalidCli.status, 0, 'audit cannot accept training or candidate options');
console.log('holdout audit: static-key compatibility, exposure distinctions, replay, report reproduction, and no-independence contract pass');
