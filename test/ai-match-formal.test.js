'use strict';
const assert = require('assert');
const fs = require('fs');
const cp = require('child_process');
const S = require('./ai-match-formal-stats');
const G = require('./ai-match-formal-reservation');
const A = require('./ai-match-formal');
const C = require('./ai-match-v2-core');
const F = require('./ai-match-family-map');
const U = require('./ai-match-opening-utils-v2');
const Chess = globalThis.Chess;
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
const copy = value => JSON.parse(JSON.stringify(value));
const h = 'a'.repeat(64);
test('partial Fisher-Yates is uniform over every ordered sample; no modulo sampler', () => {
  const counts = new Map();
  for (let first = 0; first < 4; first++) for (let second = 1; second < 4; second++) {
    const draws = [first, second]; let i = 0;
    const receipt = S.sample(['a', 'b', 'c', 'd'], 2, (lo, hi) => {
      assert.deepEqual([lo, hi], [i, 4]); return draws[i++];
    });
    assert.deepEqual(S.replay(['a', 'b', 'c', 'd'], receipt), receipt.endpoints);
    const key = receipt.endpoints.join(','); counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 12);
  assert.deepEqual([...counts.values()], Array(12).fill(1));
  assert.throws(() => S.sample(['a', 'a'], 1), /duplicate/);
  assert.throws(() => S.sample(['a', 'b'], 2), /integer/);
  assert.throws(() => S.sample(['a', 'b'], 1, () => 2), /integer/);
  assert.throws(() => S.replay(['a', 'b'], { algorithm: 'hash-ranking', draws: [0], endpoints: ['a'] }), /mismatch/);
  assert.throws(() => S.replay(['a', 'b'], { algorithm: 'os-randomInt-partial-fisher-yates-v1', draws: [0], endpoints: ['b'] }), /mismatch/);
});
test('independent Python oracle reproduces bound and endpoint weights, without iid/family n', () => {
  const pairs = Array.from({ length: 4096 }, (_, i) => ({ id: 'p' + i, score: i < 3072 ? 0.75 : 0.5 }));
  const actual = S.estimate(pairs, 8192, 0.05);
  const reference = JSON.parse(cp.execFileSync('python3', ['-c',
    'import json,math; x=json.load(__import__("sys").stdin); m=sum(p["score"] for p in x)/len(x); r=math.sqrt(-math.log(0.05)/(2*len(x))); print(json.dumps([m,r,max(0,m-r)]))'],
  { input: JSON.stringify(pairs), encoding: 'utf8' }));
  assert.equal(actual.mean, reference[0]);
  assert.ok(Math.abs(actual.radius - reference[1]) < 1e-15);
  assert.ok(Math.abs(actual.lower - reference[2]) < 1e-15);
  assert.equal(actual.independentOutcomeAssumption, false);
  assert.equal(actual.effectiveFamilySampleSize, null);
  assert.ok(Math.abs(actual.radius - 0.01912) < 0.000005);
  assert.throws(() => S.estimate([...pairs, pairs[0]], 8192, .05), /duplicate/);
  assert.throws(() => S.estimate([{ id: 'x', score: .6 }], 10, .05), /paired-color/);
  assert.throws(() => S.estimate(pairs, 8192, 0), /alpha/);
  // Identical outcomes within a family cannot reduce the fixed prospective
  // radius via an empirical zero variance or invented independent families.
  const identical = S.estimate(pairs.map(p => ({ ...p, score: .5 })), 8192, .05);
  assert.equal(identical.radius, actual.radius);
  assert.ok(identical.lower < .5);
});
test('enumeration verifies conservative coverage on a finite correlated population', () => {
  const population = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
  let trials = 0, violations = 0;
  function visit(chosen, first) {
    if (chosen.length === 6) {
      trials++;
      if (S.estimate(chosen.map(i => ({ id: String(i), score: population[i] })), 10, .25).lower > .5) violations++;
      return;
    }
    for (let i = first; i < population.length; i++) visit([...chosen, i], i + 1);
  }
  visit([], 0); assert.equal(trials, 210); assert.ok(violations / trials <= .25);
});
function row(id, pgn, family) {
  return { id, pgn, family, sourceGame: 'game-' + id, fen: Chess.toFen(U.replayPgn(pgn, id).state) };
}
const bank = { schema: 'chessy.fresh-finite-bank.v1', id: 'synthetic-bank-never-search',
  sourceLicense: 'CC0-1.0', selection: 'outcome-blind-one-endpoint-per-source-game',
  exposureCoverage: ['all-candidate-training', 'all-candidate-validation', 'all-development-search', 'all-historical-formal'],
  exposureSources: [{ id: 'synthetic-exposure', openings: [], sourceGames: [], artifactSha256: h }],
  openings: [row('A', 'e4 e5 Nf3', 'First'), row('B', 'd4 d5 Nf3', 'First'),
    row('C', 'd4 d5 Nc3', 'Second'), row('D', 'c4 c5 Nc3', 'Third')] };
const map = A.buildFormalMap(bank.openings, bank.exposureSources);
test('complete family map reproduces unequal components and propagates exposure', () => {
  A.validateBank(bank, map, 4);
  assert.deepEqual(map.groups.map(g => g.endpointIds.length), [3, 1]);
  const mutations = [
    b => b.openings[1].sourceGame = b.openings[0].sourceGame,
    b => b.exposureSources[0].sourceGames.push('game-A'),
    b => b.exposureCoverage.pop(),
    b => b.id = 'chessy-openings-v2-400-cc0',
    b => b.sourceLicense = 'unknown',
    b => b.openings[0].fen = 'wrong',
    b => b.exposureSources = [],
    b => b.openings.push({ ...b.openings[0], id: 'Z', sourceGame: 'game-Z' })
  ];
  for (const mutate of mutations) { const b = copy(bank); mutate(b); assert.throws(() => A.validateBank(b, map, 4)); }
  for (const mutate of [m => m.endpoints.pop(), m => m.groups[0].endpointIds.pop(),
    m => m.groups[0].exposed = true, m => m.effectiveSampleSize = 2]) {
    const m = copy(map); mutate(m); assert.throws(() => A.validateBank(bank, m, 4), /map/);
  }
  assert.throws(() => A.validateBank(bank, null, 4), /map/);
  const exposed = copy(bank);
  exposed.exposureSources[0].openings.push({ id: 'prior', pgn: 'd4 d5 Nc3' });
  const rebuilt = A.buildFormalMap(exposed.openings, exposed.exposureSources);
  assert.equal(rebuilt.counts.endpointsInExposedComponents, 3);
  assert.throws(() => A.validateBank(exposed, rebuilt, 4), /exposed components/);
  const named = copy(bank);
  named.exposureSources[0].openings.push({ id: 'named-prior', pgn: 'g3 d5 Bg2', family: 'First' });
  assert.equal(F.buildMap(named.openings, named.exposureSources).counts.endpointsInExposedComponents, 0);
  const namedMap = A.buildFormalMap(named.openings, named.exposureSources);
  assert.equal(namedMap.counts.endpointsInExposedComponents, 3);
  assert.throws(() => A.validateBank(named, namedMap, 4), /exposed components/);
});
function seal(rows, games) {
  const prefix = rows.map(C.canonical).join('\n') + '\n';
  return Buffer.from(prefix + C.canonical({ type: 'complete', rows: rows.length, games, sha256: C.sha256(prefix) }) + '\n');
}
const openings = [row('M1', 'f3 e5 g4', 'fixture'), row('M2', 'f3 e6 g4', 'fixture')];
const rawRows = [{ type: 'header', schema: 'chessy.formal-raw.v1', registrationSha256: h, slot: 0 }];
for (const opening of openings) for (const color of ['w', 'b']) {
  const game = opening.id + ':' + color, state = C.initialState(opening);
  const move = C.legalMove(state, 'd8h4'), end = Chess.playMove(state, move);
  rawRows.push({ type: 'start', game, endpoint: opening.id, candidateColor: color });
  rawRows.push({ type: 'move', game, ply: 0, side: state.turn === color ? 'candidate' : 'base',
    fen: Chess.toFen(state), historySha256: C.historyHash(state), move: 'd8h4',
    search: { score: -999999, scorePov: 'white', depth: 1, attemptedDepth: null,
      nodes: 4, qnodes: 0, cutoffs: 0, researches: 0, stopReason: 'mate', elapsedMs: 1 } });
  rawRows.push({ type: 'end', game, ply: 1, result: '0-1', reason: 'checkmate', fen: Chess.toFen(end) });
}
const raw = seal(rawRows, 4), fake = { budget: A.PROFILES['evaluator-easy'] };
test('rules-only four-game fixture replays colors, complete sample, history and mate', () => {
  assert.deepEqual(A.replayShard(raw, fake, h, openings, 0, 2), [{ id: 'M1', score: .5 }, { id: 'M2', score: .5 }]);
  const mutations = [rows => rows[0].registrationSha256 = 'b'.repeat(64),
    rows => rows[1].candidateColor = 'b', rows => rows[1].endpoint = 'unregistered',
    rows => rows[2].historySha256 = 'b'.repeat(64), rows => rows[2].move = 'd8h5',
    rows => rows[2].search.nodes = 10001, rows => rows[2].search.stopReason = 'time-limit',
    rows => rows[2].search.seed = 1, rows => rows[3].result = '1-0',
    rows => rows.push({ type: 'failure' }), rows => rows.splice(1, 3)];
  for (const mutate of mutations) { const rows = copy(rawRows); mutate(rows); assert.throws(() => A.replayShard(seal(rows, 4), fake, h, openings, 0, 2)); }
  assert.throws(() => A.replayShard(raw.subarray(0, raw.length - 1), fake, h, openings, 0, 2), /truncated/);
  assert.throws(() => A.replayShard(raw, fake, h, openings, 1, 2), /header/);
  assert.throws(() => A.parse(Buffer.from('{"x":1,"x":1}\n')), /noncanonical/);
});
test('full scheduled pair inventory and profile thresholds cannot cross-admit', () => {
  const population = Array.from({ length: 8192 }, (_, i) => ({ id: String(i) }));
  const pairs = population.slice(0, 4096).map(o => ({ ...o, score: .515625 }));
  // The first fixture clears both thresholds; the second clears only .49.
  pairs.forEach((p, i) => { p.score = i < 563 ? .75 : .5; });
  const sampleMap = { groups: [{ id: 'large', endpointIds: population.slice(0, 8000).map(o => o.id) },
    { id: 'small', endpointIds: population.slice(8000).map(o => o.id) }] };
  const registration = { ...A.CONTRACT, profile: 'selective-hard', budget: A.PROFILES['selective-hard'],
    sampling: { endpoints: pairs.map(p => p.id) }, campaign: { bank: { sha256: h }, familyMap: { sha256: h } },
    harness: { files: { 'test/ai-match-formal-stats.js': h } } };
  const summary = A.summarize(pairs, registration, { openings: population }, sampleMap);
  assert.equal(summary.prospectiveThresholdExceeded, true);
  assert.equal(summary.formalPass, false);
  assert.equal(summary.strengthThresholdExceeded, true);
  pairs.forEach((p, i) => { p.score = i < 160 ? .75 : .5; });
  const noninferior = A.summarize(pairs, registration, { openings: population }, sampleMap);
  assert.equal(noninferior.prospectiveThresholdExceeded, true);
  assert.equal(noninferior.formalPass, false);
  assert.equal(noninferior.strengthThresholdExceeded, false);
  const evaluator = A.summarize(pairs, { ...registration, profile: 'evaluator-easy', budget: A.PROFILES['evaluator-easy'] }, { openings: population }, sampleMap);
  assert.equal(evaluator.formalPass, false);
  assert.equal(noninferior.familyWeights[0].bankWeight, 8000 / 8192);
  assert.equal(noninferior.stats.sampledEndpoints, 4096, 'never two family units or 8192 independent games');
  assert.throws(() => A.summarize(pairs.slice(1), registration, { openings: population }, sampleMap), /inventory/);
  assert.throws(() => A.summarize([...pairs].reverse(), registration, { openings: population }, sampleMap), /inventory/);
});
test('all 32 raw shards cover 4096 pairs once; duplicate/missing slots fail', () => {
  // These deliberately repeated synthetic positions are raw-replay fixtures,
  // never an admissible bank: validateBank separately rejects duplicates.
  const syntheticOpenings = Array.from({ length: 4096 }, (_, i) => ({ ...openings[0], id: 'fixture-' + i }));
  const syntheticBank = { openings: [...syntheticOpenings, ...Array.from({ length: 4096 }, (_, i) => ({ id: 'unselected-' + i }))] };
  const syntheticMap = { groups: [{ id: 'all-fixtures', endpointIds: syntheticBank.openings.map(o => o.id) }] };
  const registration = { ...A.CONTRACT, profile: 'evaluator-easy', budget: A.PROFILES['evaluator-easy'],
    sampling: { endpoints: syntheticOpenings.map(o => o.id) }, campaign: { bank: { sha256: h }, familyMap: { sha256: h } },
    harness: { files: { 'test/ai-match-formal-stats.js': h } } };
  const buffers = [];
  for (let slot = 0; slot < 32; slot++) {
    const rows = [{ type: 'header', schema: 'chessy.formal-raw.v1', registrationSha256: h, slot }];
    for (const opening of syntheticOpenings.slice(slot * 128, (slot + 1) * 128)) {
      for (let i = 1; i <= 6; i++) {
        const r = copy(rawRows[i]);
        r.game = opening.id + ':' + (i <= 3 ? 'w' : 'b');
        if (r.type === 'start') r.endpoint = opening.id;
        rows.push(r);
      }
    }
    buffers.push(seal(rows, 256));
  }
  const summary = A.aggregateRaw(buffers, registration, h, syntheticOpenings, syntheticBank, syntheticMap);
  assert.equal(summary.stats.sampledEndpoints, 4096); assert.equal(summary.stats.mean, .5);
  assert.equal(summary.formalPass, false);
  assert.throws(() => A.aggregateRaw(buffers.slice(1), registration, h, syntheticOpenings, syntheticBank, syntheticMap), /32/);
  const duplicate = buffers.slice(); duplicate[1] = duplicate[0];
  assert.throws(() => A.aggregateRaw(duplicate, registration, h, syntheticOpenings, syntheticBank, syntheticMap), /header/);
});
test('every independent prerequisite must authenticate the exact candidate, base and profile', () => {
  const identity = n => ({ commit: String(n).repeat(40), moduleSha256: h, sourceSha256: h, buildSha256: h });
  const candidate = identity(1), base = identity(2), receipts = {};
  const campaign = { profile: 'evaluator-easy', prerequisites: {}, bank: { sha256: h }, familyMap: { sha256: h } };
  for (const kind of A.KINDS) {
    campaign.prerequisites[kind] = { path: kind, sha256: h };
    receipts[kind] = { schema: 'chessy.formal-prerequisite.v1', kind, candidate, base,
      profile: campaign.profile, result: 'pass', evidence: 'fixture never authorizes real admission',
      protocol: A.CONTRACT.protocol, contractSha256: C.sha256(A.canonicalBytes(A.CONTRACT)) }; 
  }
  Object.assign(receipts['bank-provenance-exposure'], { bankSha256: h, familyMapSha256: h });
  Object.assign(receipts['development-runtime-cost'], { budget: A.PROFILES['evaluator-easy'], sampledEndpoints: 4096,
    estimatedTotalMinutes: 300, estimatedShardMinutes: 10, paidCapUsd: 0 });
  const read = descriptor => receipts[descriptor.path];
  A.validatePrerequisites(campaign, candidate, base, read);
  for (const kind of A.KINDS) {
    const missing = copy(campaign); delete missing.prerequisites[kind];
    assert.throws(() => A.validatePrerequisites(missing, candidate, base, read), /inventory/);
    for (const field of ['candidate', 'base', 'profile', 'result', 'kind', 'schema', 'evidence', 'protocol', 'contractSha256']) {
      const changed = copy(receipts); changed[kind][field] = 'mixed-or-missing';
      if (field === 'evidence') changed[kind][field] = '';
      assert.throws(() => A.validatePrerequisites(campaign, candidate, base, d => changed[d.path]));
    }
  }
  for (const change of [{ sampledEndpoints: 400 }, { paidCapUsd: 31 }, { paidCapUsd: NaN },
    { estimatedTotalMinutes: 0 }, { estimatedShardMinutes: 36 }, { budget: A.PROFILES['selective-hard'] }]) {
    const changed = copy(receipts); Object.assign(changed['development-runtime-cost'], change);
    assert.throws(() => A.validatePrerequisites(campaign, candidate, base, d => changed[d.path]));
  }
  for (const key of ['bankSha256', 'familyMapSha256']) {
    const changed = copy(receipts); changed['bank-provenance-exposure'][key] = 'b'.repeat(64);
    assert.throws(() => A.validatePrerequisites(campaign, candidate, base, d => changed[d.path]), /bank\/map/);
  }
  assert.throws(() => A.validatePrerequisites({ ...campaign, profile: 'selective-hard' }, candidate, base, read), /inventory/);
  const r = { fake: 'registration' };
  assert.throws(() => A.validateRegistration(r, h), /digest mismatch/);
});
test('formal-local telemetry rejects impossible iteration/cutoff/time records', () => {
  const search = { score: 0, scorePov: 'white', depth: 3, attemptedDepth: 4, nodes: 10000,
    qnodes: 100, cutoffs: 30, researches: 0, stopReason: 'node-limit', elapsedMs: 1 };
  A.validateFormalSearch(search, 10000);
  for (const change of [{ attemptedDepth: 5 }, { cutoffs: 10001 }, { elapsedMs: 0 },
    { depth: 30, attemptedDepth: null }]) {
    assert.throws(() => A.validateFormalSearch({ ...search, ...change }, 10000));
  }
});
test('strict threshold comparisons do not accept equality', () => {
  const text = fs.readFileSync('test/ai-match-formal.js', 'utf8');
  assert.match(text, /prospectiveThresholdExceeded: stats\.lower > r\.budget\.threshold/);
  assert.match(text, /formalPass: descriptive\.prospectiveThresholdExceeded/);
  assert.equal(A.PROFILES['evaluator-easy'].threshold, .5);
  assert.equal(A.PROFILES['selective-hard'].threshold, .49);
});
test('empty trusted registry keeps formal registration unavailable', () => {
  const registry = A.parse(fs.readFileSync('eval/match-formal/registry.json'));
  assert.deepEqual(registry, { alpha: .05, campaign: null, opportunity: 'initial-formal-opportunity-v1', schema: 'chessy.formal-campaign-registry.v1' });
  assert.equal(A.CONTRACT.sampleSize, 4096); assert.equal(A.CONTRACT.minimumBankSize, 8192);
  assert.equal(A.CONTRACT.shards * A.CONTRACT.endpointsPerShard, 4096);
});
test('reservation status consumes alpha after upload, independent of candidate and score', () => {
  const job = conclusion => [{ steps: [{ name: G.STEP, status: 'completed', conclusion }] }];
  assert.equal(G.reserved(job('success')), true);
  assert.equal(G.reserved(job('failure')), false);
  assert.equal(G.reserved(job('skipped')), false);
  assert.throws(() => G.reserved([{ steps: [{ name: G.STEP, status: 'in_progress' }] }]), /unresolved/);
  assert.throws(() => G.reserved([{}]), /unavailable/);
  assert.throws(() => G.reserved([]), /inventory/);
  assert.throws(() => G.reserved([{ steps: [] }]), /unavailable/);
  assert.throws(() => G.reserved(job(null)), /unresolved/);
  assert.throws(() => G.reserved(job('unknown')), /unresolved/);
});
test('workflow pins trusted main and registers/reserves before draw and all searches', () => {
  const text = fs.readFileSync('.github/workflows/ai-match-formal.yml', 'utf8');
  assert.match(text, /github\.event\.repository\.default_branch/);
  assert.match(text, /group: initial-formal-opportunity-v1/);
  assert.match(text, /draw:\n    needs: preflight/);
  assert.match(text, /shard:\n    needs: \[preflight, draw\]/);
  assert.match(text, /fail-fast: false/);
  assert.match(text, /test "\$SHARDS_RESULT" = success/);
  assert.match(text, /name: Preserve all raw results and failures\n        if: always\(\)/);
  assert.doesNotMatch(text, /pull_request_target|continue-on-error|inputs:|seeds:|rerun/);
  for (const match of text.matchAll(/uses: [^@]+@([^\s]+)/g)) assert.match(match[1], /^[a-f0-9]{40}$/);
});
(async () => {
  let requests = 0;
  await G.guard(async endpoint => {
    requests++;
    if (endpoint.includes('/workflows/')) return { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] };
    return { total_count: 1, jobs: [{ id: 1, steps: [{ name: G.STEP, status: 'completed', conclusion: 'failure' }] }] };
  }, 2);
  assert.equal(requests, 2);
  await assert.rejects(G.guard(async endpoint => endpoint.includes('/workflows/')
    ? { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] }
    : { total_count: 1, jobs: [{ id: 1, steps: [{ name: G.STEP, status: 'completed', conclusion: 'success' }] }] }, 2), /consumed/);
  await assert.rejects(G.guard(async () => ({}), 2), /unavailable/);
  await assert.rejects(G.guard(async endpoint => endpoint.includes('/workflows/')
    ? { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] }
    : { total_count: 1, jobs: [] }, 2), /incomplete/);
  await assert.rejects(G.guard(async () => ({ total_count: 2, workflow_runs: [{ id: 2 }] }), 2), /incomplete/);
  checks++;
  console.log(checks + ' formal-admission tests passed; synthetic fixtures only, no engine or holdout search');
})().catch(error => { console.error(error); process.exitCode = 1; });
