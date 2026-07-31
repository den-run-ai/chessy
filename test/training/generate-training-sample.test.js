#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Corpus = require('./corpus');
const Sample = require('./generate-training-sample');

let checks = 0;

assert.deepStrictEqual(
  Sample.parseArgs([
    '--stockfish', '/tmp/stockfish',
    '--output', '/tmp/sample'
  ]),
  {
    stockfish: '/tmp/stockfish',
    output: '/tmp/sample',
    profile: 'smoke'
  }
);
assert.deepStrictEqual(
  Sample.parseArgs([
    '--profile', 'preliminary',
    '--output', '/tmp/sample',
    '--stockfish', '/tmp/stockfish'
  ]).profile,
  'preliminary'
);
assert.throws(
  () => Sample.parseArgs([
    '--stockfish', '/tmp/stockfish',
    '--output', '/tmp/sample',
    '--profile', 'custom'
  ]),
  /smoke or preliminary/
);
checks += 3;

for (const profile of ['smoke', 'preliminary']) {
  const fixture = Sample.openingWireFixture(profile);
  const counts = Object.fromEntries(
    Object.keys(Sample.SAMPLE_PROFILES[profile]).map(role => [role, 0])
  );
  const clusters = new Set();
  const families = new Set();
  for (const row of fixture.rows) {
    const parsed = Corpus.validateSourceState(row.fen);
    const cluster = Corpus.clusterKey(parsed.fen4);
    const family = Corpus.positionFamilyKey(parsed.fen4);
    counts[Corpus.roleForCluster(family)]++;
    assert(!clusters.has(cluster), profile + ' repeats a cluster');
    assert(!families.has(family), profile + ' repeats a position family');
    clusters.add(cluster);
    families.add(family);
  }
  assert.deepStrictEqual(counts, Sample.SAMPLE_PROFILES[profile]);
  assert.strictEqual(
    fixture.rows.length,
    Object.values(Sample.SAMPLE_PROFILES[profile])
      .reduce((sum, value) => sum + value, 0)
  );
  checks += 3;
}

assert.deepStrictEqual(
  Sample.LABELLED_PROFILES.preliminary,
  {
    'shared-train': 17,
    'hce-validation': 4,
    'hce-test': 9,
    'nnue-validation': 2,
    'nnue-test': 7
  }
);
assert.strictEqual(Sample.EXPECTED_EXCLUSIONS.smoke, 0);
assert.strictEqual(Sample.EXPECTED_EXCLUSIONS.preliminary, 1);
assert.deepStrictEqual(
  Sample.EXPECTED_EXCLUSION_REASONS.preliminary,
  { 'bestmove-pv-mismatch': 1 }
);
checks += 4;

console.log(checks + ' training-sample profile checks passed');
