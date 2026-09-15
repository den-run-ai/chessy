'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./ai-match-family-map');
const row = (id, pgn, family) => ({ id, pgn, family });
const groupIds = map => map.groups.map(group => group.endpointIds);

// A --named--> B --structural--> C is ONE component, even though A and C
// have different endpoint and structural identities. D is separate.
const chain = [row('A', 'e4 e5 Nf3', 'First'), row('B', 'd4 d5 Nf3', 'First'),
  row('C', 'd4 d5 Nc3', 'Second'), row('D', 'c4 c5 Nc3', 'Third')];
const map = F.buildMap(chain, [{ id: 'old', openings: [row('prior', 'd4 d5 Nc3')] }]);
assert.deepEqual(groupIds(map), [['A', 'B', 'C'], ['D']]);
assert.equal(map.groups[0].exposed, true);
assert.equal(map.groups[1].exposed, false);
assert.equal(map.counts.directlyExposedEndpoints, 2);
assert.equal(map.counts.endpointsInExposedComponents, 3, 'propagate exposure through the full component');
assert.equal(map.counts.components, 2);
assert.equal(map.independenceEstablished, false);
assert.equal(map.effectiveSampleSize, null, 'component count must never become effective sample size');
assert.equal(map.groups[0].id, '0a2b4ad995acc6f5a040c90e6daa08ca78405335b76027f3fd2889b714991a1a',
  'literal SHA-256 of ["A","B","C"] fixes group identity');
assert.deepEqual(F.buildMap([...chain].reverse(), [{ id: 'old', openings: [row('prior', 'd4 d5 Nc3')] }]), map,
  'group identities and output are invariant to input order');

// An exact duplicate endpoint with another ID joins its component; it cannot
// manufacture another unit. Unequal family sizes remain explicit.
const duplicate = F.buildMap([...chain, row('A2', 'e4 e5 Nf3', 'Unrelated label')], []);
assert.deepEqual(groupIds(duplicate), [['A', 'A2', 'B', 'C'], ['D']]);
assert.equal(duplicate.counts.largestComponent, 4);
assert.equal(duplicate.effectiveSampleSize, null);
assert.deepEqual(groupIds(F.buildMap([
  row('X', 'Nf3 d5 g3', 'X'), row('Y', 'g3 d5 Nf3', 'Y')], [])), [['X', 'Y']],
  'transposed endpoints join despite different taxonomies');

const line = 'e4 e5 Nf3 Nc6 Bc4 Bc5';
const prefixes = F.buildMap([row('long', line + ' d3 Nf6', 'Long'),
  row('short', line, 'Short'), row('other', 'e4 c5 Nf3 d6 d4 cxd4', 'Other')],
[{ id: 'past', openings: [row('exposed-long', line + ' d3')] }]);
assert.deepEqual(groupIds(prefixes), [['long', 'short'], ['other']]);
assert.equal(prefixes.counts.directlyExposedEndpoints, 2, 'both ancestor and descendant are known exposure');
assert.equal(F.buildMap([row('A', 'e4 e5 Nf3', 'A'), row('B', 'e4 c5 Nf3', 'B')],
  [{ id: 'short', openings: [row('first-move', 'e4')] }]).counts.directlyExposedEndpoints, 0,
'a common first move is not a full exposed six-ply line');

for (const openings of [[], [row('same', 'e4', 'A'), row('same', 'd4', 'B')],
  [row('missing-family', 'e4')]]) assert.throws(() => F.buildMap(openings, []), /invalid|duplicate|families/);
assert.throws(() => F.buildMap([row('illegal', 'e4 e4', 'A')], []), /matched 0/);
assert.throws(() => F.buildMap([{ ...chain[0], fen: 'wrong' }], []), /FEN differs/);
assert.throws(() => F.buildMap(chain, [{ id: 'same', openings: [] }, { id: 'same', openings: [] }]), /invalid exposure/);
assert.throws(() => F.buildMap(chain, [{ id: 'x', openings: [row('same', 'e4'), row('same', 'd4')] }]), /duplicate exposed/);

const current = F.currentMap();
assert.equal(current.disposition, 'prospective-audit-only');
assert.equal(current.mapSha256, F.hash(F.canonical(current.map) + '\n'));
assert.equal(current.manifestSha256, 'bda65b3253951863f2b01187b2a44becb8d36d29a7917780f6d920a92f4d7dab');
assert.deepEqual(current.map.counts, { endpoints: 400, components: 52, largestComponent: 63,
  directlyExposedEndpoints: 253, endpointsInExposedComponents: 374, componentsWithoutKnownExposure: 19 });
assert.equal(current.map.endpoints.length, 400);
assert.equal(new Set(current.map.groups.flatMap(group => group.endpointIds)).size, 400);
assert.equal(current.map.joiningEdges.length, 348, 'spanning forest records exactly endpoint count minus components');
F.checkStoredMap();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-family-map-'));
try {
  const file = path.join(temp, 'map.json');
  assert.throws(() => F.checkStoredMap(file), /ENOENT/);
  const mutations = [
    copy => { copy.map.endpoints.pop(); },
    copy => { copy.map.groups[0].exposed = !copy.map.groups[0].exposed; },
    copy => { copy.map.endpoints[0].groupId = '0'.repeat(64); },
    copy => { copy.manifestSha256 = '0'.repeat(64); },
    copy => { copy.exposureSources.pop(); },
    copy => { copy.map.effectiveSampleSize = 52; }
  ];
  for (const mutate of mutations) {
    const copy = JSON.parse(JSON.stringify(current)); mutate(copy);
    copy.mapSha256 = F.hash(F.canonical(copy.map) + '\n'); // forged self-consistent digest is insufficient
    fs.writeFileSync(file, JSON.stringify(copy, null, 2) + '\n');
    assert.throws(() => F.checkStoredMap(file), /missing or changed/);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
assert.throws(() => F.main(['--search']), /usage/);
console.log('prospective family map: transitive grouping, exposure propagation, unequal/duplicate groups, complete identity and mutation checks pass; no searches');
