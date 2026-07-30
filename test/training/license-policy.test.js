#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const source = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'eval', 'training', 'source-manifest.json'), 'utf8'));
const teacher = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'eval', 'training', 'teacher-sf18-100kn-v1.json'), 'utf8'));
let checks = 0;

assert.strictEqual(source.projectCodeLicense, 'MIT');
assert.strictEqual(source.policy.commitRawData, false);
assert.strictEqual(source.policy.commitTransformedShards, false);
assert.strictEqual(source.policy.defaultDisposition, 'excluded');
assert.strictEqual(source.policy.finalFitLabels.requiredProducer,
  'pinned-external-stockfish');
assert.strictEqual(source.policy.finalFitLabels.allowUpstreamLabelsAsFinalFitLabels,
  false);
checks += 6;

const ids = source.sources.map(item => item.id);
assert.strictEqual(new Set(ids).size, ids.length);
checks++;
const primary = source.sources.filter(item => item.disposition === 'primary');
assert.deepStrictEqual(primary.map(item => item.id).sort(), [
  'lichess-evaluations',
  'lichess-puzzles',
  'lichess-standard-rated-pgn'
]);
assert.ok(primary.every(item => item.license.spdx === 'CC0-1.0'));
checks += 2;

for (const item of source.sources) {
  assert.ok(['primary', 'optional-fetch-only', 'excluded'].includes(item.disposition));
  const urls = [
    item.canonicalUrl,
    item.licenseEvidenceUrl,
    item.downloadUrlTemplate,
    ...(item.downloadUrls || [])
  ].filter(Boolean);
  for (const value of urls) {
    const normalized = value.replace('YYYY-MM', '2026-01');
    assert.doesNotThrow(() => new URL(normalized), item.id + ': invalid URL ' + value);
  }
}
checks++;

for (const id of [
  'gigafish-3.8b-d10',
  'ccrl-games',
  'chessdb-cloud',
  'maia-processed-csv',
  'third-party-dataset-mirrors'
]) {
  const entry = source.sources.find(item => item.id === id);
  assert.ok(entry && entry.disposition === 'excluded', id + ' must remain excluded');
}
checks++;

assert.strictEqual(teacher.status, 'teacher-identity-frozen');
assert.strictEqual(teacher.engine.archive.sha256,
  '536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964');
assert.strictEqual(teacher.engine.executable.sha256,
  '6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9');
assert.deepStrictEqual(teacher.engine.networks.map(network => network.sha256), [
  'c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7',
  '37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d'
]);
assert.strictEqual(teacher.engine.redistributedByChessy, false);
assert.strictEqual(teacher.search.nodeLimit, 100000);
assert.strictEqual(teacher.labels.storedPov, 'white');
checks += 6;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function (entry) {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(name) : [name];
  });
}
const forbidden = walk(path.join(ROOT, 'eval', 'training')).filter(filename =>
  /\.(jsonl|ndjson|zst|pt|npz|npy|binpack)$/i.test(filename) ||
    /\.uci\.log$/i.test(filename));
assert.deepStrictEqual(forbidden, []);
checks++;

console.log(checks + ' training-license policy checks passed');
