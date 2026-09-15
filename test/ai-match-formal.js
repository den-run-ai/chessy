/* Trusted prospective formal admission. The empty main-branch registry admits
 * no candidate. Existing v2 records and their diagnostic verdict are untouched. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./ai-match-v2-core');
const F = require('./ai-match-family-map');
const U = require('./ai-match-opening-utils-v2');
const S = require('./ai-match-formal-stats');
const Loader = require('../assets/wasm-engine');
const Chess = globalThis.Chess;
const REGISTRY = 'eval/match-formal/registry.json';
const PROFILES = Object.freeze({
  'evaluator-easy': { nodes: 10000, threshold: 0.50, acceptance: 'strict-evaluator-strength' },
  'selective-hard': { nodes: 230000, threshold: 0.49, acceptance: 'selective-search-conditional-noninferiority' }
});
const CHANGE_CLASSES = Object.freeze({
  'evaluator-easy': 'evaluation-change',
  'selective-hard': 'selective-search-change'
});
const CONTRACT = Object.freeze({ schema: 'chessy.formal-registration.v1',
  protocol: 'chessy-finite-bank-4096-pairs-v1', opportunity: 'initial-formal-opportunity-v1',
  alpha: 0.05, sampleSize: 4096, minimumBankSize: 8192, shards: 32, endpointsPerShard: 128,
  maxDepth: 30, maxPlies: 180, quiesce: true, abi: 2, budgetMode: 'nodes',
  estimator: 'finite-population-endpoint-hoeffding-one-sided-v1',
  weighting: 'each-bank-endpoint-equal-weight-families-proportional-to-endpoint-count',
  grouping: 'connected-components-endpoint-structural-named-six-ply-prefix-v1-one-endpoint-per-source-game',
  exposure: 'reject-entire-bank-if-any-declared-component-or-source-game-is-exposed',
  failure: 'reserve-before-draw-any-later-failure-consumes-opportunity-no-retries',
  selection: 'one-post-freeze-os-randomInt-SRS-without-replacement-both-colors',
  thresholdComparison: 'strictly-greater', scoreNoise: 'deterministic-fixed-node-only' });
const TRUSTED = Object.freeze([...C.TRUSTED_FILES, 'test/ai-match-formal.js',
  'test/ai-match-formal-stats.js', 'test/ai-match-formal-reservation.js', 'test/ai-match-family-map.js',
  'test/ai-match-holdout-audit.js', REGISTRY, '.github/workflows/ai-match-formal.yml']);
const KINDS = Object.freeze(['source-build-reproduction', 'numerical-model-parity', 'wasm-size',
  'tactics-correctness', 'signature-admission', 'physical-device-runtime', 'deterministic-node-execution', 'development-runtime-cost', 'bank-provenance-exposure']);
const digest = (x, what) => C.check(typeof x === 'string' && /^[a-f0-9]{64}$/.test(x), 'invalid ' + what);
const canonicalBytes = value => Buffer.from(C.canonical(value) + '\n');
function parse(bytes) {
  const value = JSON.parse(bytes);
  C.check(bytes.equals(canonicalBytes(value)), 'noncanonical/duplicate-key artifact');
  return value;
}
function retained(ref, relative) {
  C.check(typeof relative === 'string' && /^eval\/match-formal\/[a-zA-Z0-9_./-]+$/.test(relative) &&
    !relative.split('/').some(p => p === '..' || p === '.' || p === ''), 'invalid campaign path');
  return C.revision(ref, relative);
}
function attachment(ref, descriptor) {
  C.same(Object.keys(descriptor || {}).sort(), ['path', 'sha256'], 'artifact descriptor');
  digest(descriptor.sha256, 'artifact digest');
  const bytes = retained(ref, descriptor.path);
  C.check(C.sha256(bytes) === descriptor.sha256, 'campaign artifact digest mismatch');
  return { bytes, value: parse(bytes) };
}
function filesAt(ref) {
  return Object.fromEntries(TRUSTED.map(file => [file, C.sha256(C.revision(ref, file))]));
}
function runtime() {
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch };
}
function buildFormalMap(openings, exposureSources) {
  const map = F.buildMap(openings, exposureSources);
  // The historical mapper intentionally cannot infer taxonomy absent from its
  // two old sources. The fresh ledger preserves named families when available
  // and source-game lineage, so both must propagate through the whole group.
  const byId = new Map(openings.map(row => [row.id, row]));
  for (const group of map.groups) {
    for (const id of group.endpointIds) {
      const row = byId.get(id);
      for (const source of exposureSources) {
        for (const prior of source.openings) if (typeof prior.family === 'string' && prior.family && prior.family === row.family) {
          const existing = group.directExposures.find(e => e.endpointId === id && e.source === source.id && e.exposedId === prior.id);
          if (existing) existing.reasons.push('named-family');
          else group.directExposures.push({ endpointId: id, source: source.id, exposedId: prior.id, reasons: ['named-family'] });
        }
        if ((source.sourceGames || []).includes(row.sourceGame)) group.directExposures.push({
          endpointId: id, source: source.id, exposedId: row.sourceGame, reasons: ['source-game'] });
      }
    }
    group.directExposures.sort((a, b) => { const x = C.canonical(a), y = C.canonical(b); return x < y ? -1 : x > y ? 1 : 0; });
    group.exposed = group.directExposures.length > 0;
  }
  map.counts.directlyExposedEndpoints = new Set(map.groups.flatMap(g => g.directExposures.map(e => e.endpointId))).size;
  map.counts.endpointsInExposedComponents = map.groups.filter(g => g.exposed).reduce((sum, g) => sum + g.endpointIds.length, 0);
  map.counts.componentsWithoutKnownExposure = map.groups.filter(g => !g.exposed).length;
  return map;
}
function validateBank(bank, map, minCount = CONTRACT.minimumBankSize) {
  C.check(bank && bank.schema === 'chessy.fresh-finite-bank.v1' && bank.id !== 'chessy-openings-v2-400-cc0', 'fresh bank identity required');
  C.check(typeof bank.id === 'string' && bank.id.length > 0, 'missing bank ID');
  C.check(Array.isArray(bank.openings) && bank.openings.length >= minCount && bank.openings.length <= 10000, 'bank size outside contract');
  C.check(Array.isArray(bank.exposureSources) && bank.exposureSources.length > 0, 'full exposure ledger required');
  C.same(bank.exposureCoverage, ['all-candidate-training', 'all-candidate-validation', 'all-development-search', 'all-historical-formal'], 'exposure coverage');
  C.check(bank.sourceLicense === 'CC0-1.0' && bank.selection === 'outcome-blind-one-endpoint-per-source-game', 'source/license selection contract');
  const endpoints = new Set(), games = new Set();
  const exposedGames = new Set();
  for (const source of bank.exposureSources) {
    C.check(Array.isArray(source.sourceGames) && typeof source.artifactSha256 === 'string', 'missing exposure source identity');
    digest(source.artifactSha256, 'exposure artifact digest');
    for (const game of source.sourceGames) { C.check(typeof game === 'string' && game, 'missing exposed game'); exposedGames.add(game); }
  }
  for (const row of bank.openings) {
    C.check(typeof row.sourceGame === 'string' && row.sourceGame && !games.has(row.sourceGame), 'one endpoint per authenticated source game required');
    C.check(!exposedGames.has(row.sourceGame), 'source-game exposure'); games.add(row.sourceGame);
    const state = C.initialState(row), key = U.positionCluster(Chess.toFen(state));
    C.check(!Chess.gameStatus(state).over && !endpoints.has(key), 'terminal/duplicate exact-or-mirror endpoint'); endpoints.add(key);
  }
  C.same(bank.openings.map(o => o.id), bank.openings.map(o => o.id).sort(), 'canonical bank order');
  const expected = buildFormalMap(bank.openings, bank.exposureSources);
  C.same(map, expected, 'complete family/exposure map');
  C.check(expected.counts.endpointsInExposedComponents === 0, 'known exposed components cannot enter fresh bank');
  return expected;
}
function validatePrerequisites(campaign, candidate, base, read) {
  const required = [...KINDS, ...(campaign.profile === 'selective-hard' ? ['product-budget-efficiency'] : [])];
  C.same(Object.keys(campaign.prerequisites || {}).sort(), required.sort(), 'complete prerequisite inventory');
  for (const kind of required) {
    const receipt = read(campaign.prerequisites[kind]);
    C.same({ schema: receipt.schema, kind: receipt.kind, candidate: receipt.candidate, base: receipt.base,
      profile: receipt.profile, result: receipt.result, protocol: receipt.protocol, contractSha256: receipt.contractSha256 },
    { schema: 'chessy.formal-prerequisite.v1', kind, candidate, base, profile: campaign.profile, result: 'pass',
      protocol: CONTRACT.protocol, contractSha256: C.sha256(canonicalBytes(CONTRACT)) }, 'prerequisite identity/admission');
    C.check(typeof receipt.evidence === 'string' && receipt.evidence.length > 0, 'missing prerequisite evidence');
    if (kind === 'bank-provenance-exposure') {
      C.same({ bank: receipt.bankSha256, map: receipt.familyMapSha256 },
        { bank: campaign.bank.sha256, map: campaign.familyMap.sha256 }, 'bank/map provenance receipt identity');
    }
    if (kind === 'development-runtime-cost') {
      C.same(receipt.budget, PROFILES[campaign.profile], 'runtime-cost execution budget');
      C.check(receipt.sampledEndpoints === CONTRACT.sampleSize && receipt.estimatedTotalMinutes > 0 &&
        Number.isFinite(receipt.estimatedTotalMinutes) && Number.isFinite(receipt.paidCapUsd) && receipt.paidCapUsd >= 0 && receipt.paidCapUsd <= 30,
      'full-sample development runtime/cost projection required');
      C.check(Number.isFinite(receipt.estimatedShardMinutes) && receipt.estimatedShardMinutes > 0 && receipt.estimatedShardMinutes <= 35,
        'runtime projection must reserve at least 10 of 45 shard minutes for overhead');
    }
  }
}
function validateCampaignScope(campaign) {
  C.check(campaign && Object.hasOwn(CHANGE_CLASSES, campaign.profile), 'unknown formal campaign/profile');
  C.check(campaign.changeClass === CHANGE_CLASSES[campaign.profile],
    'formal profile requires its declared behavior-changing class; pure search-cost admission remains unavailable');
}
function loadCampaign(harness) {
  const registryBytes = C.revision(harness, REGISTRY), registry = parse(registryBytes);
  C.same({ schema: registry.schema, alpha: registry.alpha, opportunity: registry.opportunity },
    { schema: 'chessy.formal-campaign-registry.v1', alpha: CONTRACT.alpha, opportunity: CONTRACT.opportunity }, 'fixed lifetime alpha ledger');
  C.same(Object.keys(registry).sort(), ['alpha', 'campaign', 'opportunity', 'schema'], 'registry fields');
  C.check(registry.campaign !== null, 'no reviewed fresh campaign: formal dispatch unavailable');
  const campaign = attachment(harness, registry.campaign).value;
  C.check(campaign.schema === 'chessy.formal-campaign.v1', 'unknown formal campaign schema');
  validateCampaignScope(campaign);
  C.same(campaign.contract, CONTRACT, 'prospective formal contract');
  C.check(campaign.candidate !== campaign.base, 'candidate/base must differ');
  // v2 provides exact Git module/source/build identities; no v2 verdict or
  // manifest enters the new registration or estimator.
  const identities = C.registration({ base: campaign.base, candidate: campaign.candidate, harness,
    profile: campaign.profile, run: 'https://github.com/den-run-ai/chessy/actions/runs/1' });
  const candidate = identities.candidate, base = identities.base;
  const bankArtifact = attachment(harness, campaign.bank), mapArtifact = attachment(harness, campaign.familyMap);
  const bank = bankArtifact.value, map = mapArtifact.value;
  validateBank(bank, map);
  C.check(bankArtifact.bytes.length < (1 << 27), 'bank exceeds resource cap');
  C.check(campaign.quarantine && campaign.quarantine.bankSha256 === campaign.bank.sha256 &&
    campaign.quarantine.candidateCommit === candidate.commit && campaign.quarantine.furtherSelectionForbidden === true,
  'missing frozen bank/candidate quarantine');
  // Each prerequisite is an independently reviewed receipt admitted by this
  // trusted-main campaign. Digests authenticate evidence, not its truth; the
  // reviewing maintainer remains the authority for physical observations.
  validatePrerequisites(campaign, candidate, base, descriptor => attachment(harness, descriptor).value);
  return { campaign, registrySha256: C.sha256(registryBytes), candidate, base, bank, map };
}
function preflight(harness, run) {
  C.check(/^https:\/\/github\.com\/den-run-ai\/chessy\/actions\/runs\/[1-9][0-9]*$/.test(run), 'canonical repository run URL required');
  C.check(process.version === 'v22.23.2' && process.platform === 'linux' && process.arch === 'x64', 'pinned formal runtime required');
  const data = loadCampaign(harness), files = filesAt(harness);
  for (const file of TRUSTED) C.check(C.sha256(fs.readFileSync(path.join(C.ROOT, file))) === files[file], 'dirty trusted formal file');
  return { ...CONTRACT, profile: data.campaign.profile, budget: PROFILES[data.campaign.profile],
    candidate: data.candidate, base: data.base, harness: { commit: harness, files },
    registrySha256: data.registrySha256, campaign: data.campaign, runtime: runtime(), run, attempt: 1 };
}
function validateRegistration(r, expectedDigest) {
  digest(expectedDigest, 'external registration digest');
  C.check(C.sha256(canonicalBytes(r)) === expectedDigest, 'formal registration digest mismatch');
  const { sampling, ...plan } = r;
  C.same(plan, preflight(r.harness.commit, r.run), 'frozen formal registration');
  const data = loadCampaign(r.harness.commit);
  C.check(sampling && sampling.draws.length === CONTRACT.sampleSize, 'complete registered sample required');
  S.replay(data.bank.openings.map(o => o.id), sampling);
  return data;
}
function schedule(r, bank) {
  const byId = new Map(bank.openings.map(o => [o.id, o]));
  return S.replay(bank.openings.map(o => o.id), r.sampling).map(id => byId.get(id));
}
function validateFormalSearch(search, nodes) {
  C.validateSearch(search, nodes);
  C.check(search.cutoffs <= search.nodes && search.elapsedMs > 0, 'invalid formal search counters/elapsed');
  if (search.attemptedDepth !== null) C.check(search.attemptedDepth === search.depth + 1, 'formal interrupted iteration must be next depth');
  if (search.stopReason === 'node-limit') C.check(search.depth < CONTRACT.maxDepth, 'formal node stop cannot complete maximum depth');
}
function replayShard(bytes, r, registrationSha256, openings, slot, count = CONTRACT.endpointsPerShard) {
  const rows = C.parseCanonicalLines(bytes), footer = rows.pop(), header = rows.shift();
  C.same(header, { type: 'header', schema: 'chessy.formal-raw.v1', registrationSha256, slot }, 'formal shard header');
  const prefix = Buffer.from(bytes.toString('utf8').split('\n').slice(0, -2).join('\n') + '\n');
  C.same(footer, { type: 'complete', rows: rows.length + 1, games: count * 2, sha256: C.sha256(prefix) }, 'complete raw digest/inventory');
  let cursor = 0; const pairs = [];
  for (const opening of openings.slice(slot * count, (slot + 1) * count)) {
    let score = 0;
    for (const color of ['w', 'b']) {
      const game = opening.id + ':' + color;
      C.same(rows[cursor++], { type: 'start', game, endpoint: opening.id, candidateColor: color }, 'sample/color schedule');
      let state = C.initialState(opening), ply = 0;
      while (!C.outcome(state, ply, CONTRACT.maxPlies)) {
        const row = rows[cursor++];
        C.check(row && row.type === 'move' && row.search, 'missing formal move');
        C.same(Object.keys(row).sort(), ['type', 'game', 'ply', 'side', 'fen', 'historySha256', 'move', 'search'].sort(), 'formal move fields');
        C.same({ game: row.game, ply: row.ply, side: row.side, fen: row.fen, history: row.historySha256 },
          { game, ply, side: state.turn === color ? 'candidate' : 'base', fen: Chess.toFen(state), history: C.historyHash(state) }, 'formal search context');
        C.same(Object.keys(row.search).sort(), ['score', 'scorePov', 'depth', 'attemptedDepth', 'nodes', 'qnodes', 'cutoffs', 'researches', 'stopReason', 'elapsedMs'].sort(), 'formal search telemetry');
        validateFormalSearch(row.search, r.budget.nodes);
        state = Chess.playMove(state, C.legalMove(state, row.move)); ply++;
      }
      const terminal = C.outcome(state, ply, CONTRACT.maxPlies);
      C.same(rows[cursor++], { type: 'end', game, ply, ...terminal, fen: Chess.toFen(state) }, 'formal adjudication');
      const white = terminal.result === '1-0' ? 1 : terminal.result === '0-1' ? 0 : 0.5;
      score += color === 'w' ? white : 1 - white;
    }
    pairs.push({ id: opening.id, score: score / 2 });
  }
  C.check(cursor === rows.length && pairs.length === count, 'incomplete/extra formal games');
  return pairs;
}
function summarize(pairs, r, bank, map) {
  C.same(pairs.map(p => p.id), r.sampling.endpoints, 'complete registered score inventory');
  const stats = S.estimate(pairs, bank.openings.length, r.alpha);
  const sampled = new Set(pairs.map(p => p.id));
  return { schema: 'chessy.formal-summary.v1', protocol: r.protocol, run: r.run,
    opportunity: r.opportunity, profile: r.profile, budget: r.budget,
    bankSha256: r.campaign.bank.sha256, familyMapSha256: r.campaign.familyMap.sha256,
    registrySha256: r.registrySha256, harness: r.harness, candidate: r.candidate, base: r.base,
    runtime: r.runtime, prerequisites: r.campaign.prerequisites,
    estimatorSha256: r.harness.files['test/ai-match-formal-stats.js'], stats,
    familyWeights: map.groups.map(g => ({ id: g.id, bankEndpoints: g.endpointIds.length,
      bankWeight: g.endpointIds.length / bank.openings.length,
      sampledEndpoints: g.endpointIds.filter(id => sampled.has(id)).length })),
    strengthThresholdExceeded: stats.lower > 0.5,
    prospectiveThresholdExceeded: stats.lower > r.budget.threshold, formalPass: false,
    admissionClass: r.budget.acceptance,
    limitations: ['Claim is limited to the exact fresh finite bank and frozen fixed-node budget.',
      'Families are exposure descriptors, not independent outcomes; their counts never set uncertainty.',
      'Evidence digests require honest trusted-main review and runner; they are not remote attestation.',
      'This report does not itself merge, deploy, change level ratings, or certify human Elo.'] };
}
function aggregateRaw(buffers, r, registrationSha256, openings, bank, map) {
  C.check(buffers.length === CONTRACT.shards, 'exactly 32 formal shards required');
  const pairs = buffers.flatMap((bytes, slot) => replayShard(bytes, r, registrationSha256, openings, slot));
  return { ...summarize(pairs, r, bank, map), registrationSha256 };
}
async function main(argv) {
  const mode = argv.shift(), opts = {};
  C.check(argv.length % 2 === 0, 'key/value arguments required');
  for (let i = 0; i < argv.length; i += 2) {
    C.check(/^--[a-z-]+$/.test(argv[i]) && !Object.hasOwn(opts, argv[i].slice(2)) && argv[i + 1], 'invalid/duplicate CLI flag');
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  const keys = list => C.same(Object.keys(opts).sort(), list.sort(), 'formal CLI options');
  C.check(process.env.GITHUB_RUN_ATTEMPT === '1', 'only the first trusted workflow attempt is permitted');
  if (mode === 'preflight') {
    keys(['harness', 'run', 'out']);
    fs.writeFileSync(opts.out, canonicalBytes(preflight(opts.harness, opts.run)), { flag: 'wx' }); return;
  }
  if (mode === 'draw') {
    keys(['plan', 'out']);
    const plan = parse(fs.readFileSync(opts.plan));
    C.same(plan, preflight(plan.harness.commit, plan.run), 'pre-draw plan');
    C.check(process.env.CHESSY_RESERVED_RUN === plan.run, 'draw requires trusted reserved run');
    const data = loadCampaign(plan.harness.commit);
    const r = { ...plan, sampling: S.sample(data.bank.openings.map(o => o.id), CONTRACT.sampleSize) };
    const bytes = canonicalBytes(r); fs.writeFileSync(opts.out, bytes, { flag: 'wx' });
    console.log(C.sha256(bytes)); return;
  }
  C.check(mode === 'shard' || mode === 'aggregate', 'unknown formal mode');
  keys(mode === 'shard' ? ['registration', 'digest', 'slot', 'out'] : ['registration', 'digest', 'directory']);
  const r = parse(fs.readFileSync(opts.registration)), data = validateRegistration(r, opts.digest);
  C.check(process.env.CHESSY_WORKFLOW_RUN === r.run, 'formal run identity mismatch');
  const openings = schedule(r, data.bank);
  if (mode === 'aggregate') {
    const names = Array.from({ length: CONTRACT.shards }, (_, slot) => 'slot-' + slot + '.jsonl');
    C.same(fs.readdirSync(opts.directory).sort(), names.slice().sort(), 'complete formal shard directory');
    const buffers = names.map(name => {
      const file = path.join(opts.directory, name);
      C.check(fs.lstatSync(file).isFile(), 'regular raw artifact required');
      return fs.readFileSync(file);
    });
    const descriptive = aggregateRaw(buffers, r, opts.digest, openings, data.bank, data.map);
    // Pure helpers cannot authorize admission. Reauthenticate after the full
    // replay, immediately before this sole formal-verdict publication.
    validateRegistration(r, opts.digest);
    const summary = { ...descriptive, formalPass: descriptive.prospectiveThresholdExceeded };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.formalPass) process.exitCode = 1;
    return;
  }
  C.check(/^(0|[1-9][0-9]*)$/.test(opts.slot), 'invalid shard slot');
  const slot = Number(opts.slot); C.integer(slot, 0, CONTRACT.shards - 1, 'formal slot');
  const fd = fs.openSync(opts.out, 'wx'), hash = crypto.createHash('sha256'); let rows = 0;
  const emit = value => { const bytes = canonicalBytes(value); fs.writeSync(fd, bytes); hash.update(bytes); rows++; };
  try {
    emit({ type: 'header', schema: 'chessy.formal-raw.v1', registrationSha256: opts.digest, slot });
    const engines = {};
    for (const side of ['candidate', 'base']) {
      const bytes = C.revision(r[side].commit, C.MODULE);
      C.check(C.sha256(bytes) === r[side].moduleSha256, 'formal raw module identity');
      engines[side] = await Loader.load(bytes);
    }
    for (const opening of openings.slice(slot * CONTRACT.endpointsPerShard, (slot + 1) * CONTRACT.endpointsPerShard)) {
      for (const color of ['w', 'b']) {
        const game = opening.id + ':' + color;
        emit({ type: 'start', game, endpoint: opening.id, candidateColor: color });
        C.playGame(engines, opening, color, r.budget.nodes, row => {
          emit({ ...row, game });
          if (row.type === 'move') validateFormalSearch(row.search, r.budget.nodes);
        });
        fs.fsyncSync(fd);
      }
    }
    validateRegistration(r, opts.digest);
    fs.writeSync(fd, canonicalBytes({ type: 'complete', rows, games: CONTRACT.endpointsPerShard * 2, sha256: hash.digest('hex') }));
    fs.fsyncSync(fd);
  } catch (error) {
    emit({ type: 'failure', message: String(error.message) }); fs.fsyncSync(fd); throw error;
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error('FAIL: ' + error.message); process.exitCode = 2; });
module.exports = { CONTRACT, PROFILES, CHANGE_CLASSES, TRUSTED, KINDS, parse, validateCampaignScope, buildFormalMap, validateBank, validatePrerequisites, loadCampaign, preflight,
  validateRegistration, validateFormalSearch, replayShard, summarize, aggregateRaw, canonicalBytes, main };
