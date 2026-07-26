/*
 * Aggregate self-play match shards into one opening-clustered verdict.
 *
 * Usage:
 *   node test/ai-match-agg.js [--openings 100] [--seeds 4] shard0.txt ...
 *
 * Every shard must carry exactly one canonical metadata field for protocol,
 * acceptance class/lower-bound threshold, candidate/base commits, budget
 * mode/value, max plies, opening-manifest version/hash, Node runtime, records
 * and opening count. workflow-run is optional for local artifacts, but must be
 * present on every shard or none, and identical when present.
 * Unknown/duplicate metadata is rejected.
 *
 * Exit codes:
 *   0  aggregated; candidate passes the statistical threshold
 *   1  aggregated; candidate fails the statistical threshold
 *   2  usage error / malformed or non-canonical artifact
 *   3  shards disagree on experiment metadata
 *   4  a (opening, seed) cell appears in more than one shard
 *   5  the shards do not cover the full manifest
 */
'use strict';
const fs = require('fs');
const { clusterStats } = require('./match-stats');
const MatchProtocol = require('./ai-match-protocol');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
}
function fail(code, msg) { console.error('ERROR: ' + msg); process.exit(code); }
function posIntOpt(name, dflt) {
  const raw = opt(name, String(dflt));
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    fail(2, '--' + name + ' must be a positive integer (got "' + raw + '")');
  }
  return n;
}

const EXP_OPENINGS = posIntOpt('openings', 100);
const EXP_SEEDS = posIntOpt('seeds', 4);
if (EXP_OPENINGS !== MatchProtocol.OPENINGS_MANIFEST_COUNT) {
  fail(2, '--openings must match canonical manifest count ' +
    MatchProtocol.OPENINGS_MANIFEST_COUNT + ' (got ' + EXP_OPENINGS + ')');
}
const files = argv.filter(function (arg, i) {
  if (arg.indexOf('--') === 0) return false;
  return !(i > 0 &&
    (argv[i - 1] === '--openings' || argv[i - 1] === '--seeds'));
});
if (!files.length) {
  fail(2, 'usage: node test/ai-match-agg.js [--openings N] [--seeds M] <shard-file> ...');
}

const REQUIRED = [
  'protocol-id', 'acceptance-class', 'lower-bound-threshold',
  'candidate-sha', 'base-sha', 'budget-mode', 'budget-value', 'max-plies',
  'openings-manifest-version', 'openings-manifest-sha256', 'node-runtime',
  'records', 'openings-total'
];
const OPTIONAL = ['workflow-run'];
const DIAGNOSTIC = ['pair-scores', 'shard', 'depth-dist', 'completed-depth'];
const KNOWN = new Set(REQUIRED.concat(OPTIONAL, DIAGNOSTIC));

function values(text, key) {
  return text.split('\n').map(function (line) {
    const m = line.match(new RegExp('^' + key + ':\\s*(.+)$'));
    return m ? m[1].trim() : null;
  }).filter(function (value) { return value != null; });
}
function exactOne(text, key, file) {
  const found = values(text, key);
  if (found.length !== 1) {
    fail(2, file + ' must contain exactly one ' + key +
      ' field (found ' + found.length + ')');
  }
  return found[0];
}
function positive(value, key, file) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    fail(2, file + ': ' + key +
      ' must be a positive safe integer (got "' + value + '")');
  }
  return n;
}
function probability(value, key, file) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    fail(2, file + ': ' + key +
      ' must be a probability strictly between 0 and 1 (got "' + value + '")');
  }
  return n;
}

const all = [];
const owner = new Map();
const sets = {
  candidate: new Set(), base: new Set(), protocol: new Set(),
  acceptance: new Set(),
  budget: new Set(), maxPlies: new Set(), runtime: new Set(),
  manifest: new Set(), total: new Set(), workflow: new Set()
};
let workflowPresent = 0;

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { fail(2, 'cannot read ' + file + ': ' + e.message); }

  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z][a-z0-9-]*):/);
    if (m && !KNOWN.has(m[1])) {
      fail(2, file + ': unknown metadata field "' + m[1] + '"');
    }
  }
  for (const key of DIAGNOSTIC.concat(OPTIONAL)) {
    const count = values(text, key).length;
    if (count > 1) fail(2, file + ' contains duplicate ' + key + ' fields');
  }

  const protocolId = exactOne(text, 'protocol-id', file);
  const acceptanceClass = exactOne(text, 'acceptance-class', file);
  const lowerBoundThreshold = probability(
    exactOne(text, 'lower-bound-threshold', file),
    'lower-bound-threshold', file);
  const candidate = exactOne(text, 'candidate-sha', file);
  const base = exactOne(text, 'base-sha', file);
  const budgetMode = exactOne(text, 'budget-mode', file);
  const budgetValue = positive(
    exactOne(text, 'budget-value', file), 'budget-value', file);
  const maxPlies = positive(
    exactOne(text, 'max-plies', file), 'max-plies', file);
  const manifestVersion =
    exactOne(text, 'openings-manifest-version', file);
  const manifestSha = exactOne(text, 'openings-manifest-sha256', file);
  const runtime = exactOne(text, 'node-runtime', file);
  const total = positive(
    exactOne(text, 'openings-total', file), 'openings-total', file);
  const recordsJson = exactOne(text, 'records', file);
  const workflow = values(text, 'workflow-run')[0] || null;

  if (!/^[0-9a-f]{40}$/.test(candidate) || !/^[0-9a-f]{40}$/.test(base)) {
    fail(2, file + ': candidate-sha and base-sha must be canonical 40-character lowercase SHAs');
  }
  const protocol = MatchProtocol.PROTOCOL_BY_ID[protocolId];
  if (!protocol) {
    fail(2, file + ': unknown protocol-id "' + protocolId + '"');
  }
  if (budgetMode !== protocol.budgetMode) {
    fail(2, file + ': protocol-id "' + protocolId +
      '" does not match budget-mode "' + budgetMode + '"');
  }
  if (acceptanceClass !== protocol.acceptanceClass ||
      lowerBoundThreshold !== protocol.lowerBoundThreshold) {
    fail(2, file + ': protocol-id "' + protocolId +
      '" requires acceptance-class "' + protocol.acceptanceClass +
      '" and lower-bound-threshold ' + protocol.lowerBoundThreshold);
  }
  if (manifestVersion !== MatchProtocol.OPENINGS_MANIFEST_VERSION ||
      manifestSha !== MatchProtocol.OPENINGS_MANIFEST_SHA256) {
    fail(2, file + ': unknown opening-manifest version/hash ' +
      manifestVersion + '/' + manifestSha);
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(runtime)) {
    fail(2, file + ': node-runtime must be a canonical process.version (got "' +
      runtime + '")');
  }
  if (total !== MatchProtocol.OPENINGS_MANIFEST_COUNT) {
    fail(2, file + ': openings-total must match canonical manifest count ' +
      MatchProtocol.OPENINGS_MANIFEST_COUNT + ' (got ' + total + ')');
  }
  if (protocol.formal) {
    if (budgetValue !== protocol.budgetValue ||
        maxPlies !== protocol.maxPlies ||
        total !== protocol.openings ||
        EXP_SEEDS !== protocol.seeds) {
      fail(2, file + ': formal protocol requires exactly ' +
        protocol.budgetValue + ' nodes/move, ' + protocol.openings +
        ' openings, ' + protocol.seeds + ' seeds and ' +
        protocol.maxPlies + ' max plies');
    }
    if (candidate === base) {
      fail(2, file + ': formal protocol requires distinct candidate and base SHAs');
    }
  }
  if (workflow &&
      !/^https:\/\/[^\s]+\/actions\/runs\/[0-9]+$/.test(workflow)) {
    fail(2, file + ': workflow-run is not a canonical Actions run URL');
  }

  sets.candidate.add(candidate);
  sets.base.add(base);
  sets.protocol.add(protocolId);
  sets.acceptance.add(acceptanceClass + ':' + lowerBoundThreshold);
  sets.budget.add(budgetMode + ':' + budgetValue);
  sets.maxPlies.add(String(maxPlies));
  sets.runtime.add(runtime);
  sets.manifest.add(manifestVersion + ':' + manifestSha);
  sets.total.add(String(total));
  if (workflow) {
    workflowPresent++;
    sets.workflow.add(workflow);
  }

  let recs;
  try { recs = JSON.parse(recordsJson); }
  catch (e) { fail(2, 'bad records JSON in ' + file + ': ' + e.message); }
  if (!Array.isArray(recs) || !recs.length) {
    fail(2, file + ': records is empty or not an array');
  }

  for (let recordIndex = 0; recordIndex < recs.length; recordIndex++) {
    const r = recs[recordIndex];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      fail(2, file + ': record ' + recordIndex +
        ' is not a non-null object');
    }
    if (!Number.isInteger(r.op) || r.op < 0 || r.op >= EXP_OPENINGS) {
      fail(2, file + ': record op ' + JSON.stringify(r.op) +
        ' is out of range [0,' + EXP_OPENINGS + ')');
    }
    if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed >= EXP_SEEDS) {
      fail(2, file + ': record seed ' + JSON.stringify(r.seed) +
        ' is out of range [0,' + EXP_SEEDS + ')');
    }
    const expectedGameSeed = MatchProtocol.deriveGameSeed(r.op, r.seed);
    if (r.gseed !== expectedGameSeed) {
      fail(2, file + ': record gseed ' + JSON.stringify(r.gseed) +
        ' does not match canonical opening/seed mapping (expected ' +
        expectedGameSeed + ' for opening ' + r.op + ', seed ' + r.seed + ')');
    }
    if (typeof r.pair !== 'number' || r.pair < 0 || r.pair > 1) {
      fail(2, file + ': record pair ' + JSON.stringify(r.pair) +
        ' is not a score in [0,1]');
    }
    for (const game of ['white', 'black']) {
      if (r[game] !== 0 && r[game] !== 0.5 && r[game] !== 1) {
        fail(2, file + ': record ' + game + ' ' +
          JSON.stringify(r[game]) + ' is not a game score in {0, 0.5, 1}');
      }
    }
    if (Math.abs(r.pair - (r.white + r.black) / 2) > 1e-9) {
      fail(2, file + ': record pair ' + r.pair + ' != (white ' +
        r.white + ' + black ' + r.black + ') / 2');
    }
    const key = r.op + ':' + r.seed;
    if (owner.has(key)) {
      fail(4, 'cell (opening ' + r.op + ', seed ' + r.seed +
        ') appears in both ' + owner.get(key) + ' and ' + file);
    }
    owner.set(key, file);
    all.push(r);
  }
  console.log('loaded ' + recs.length + ' pairs from ' + file +
    '  cand ' + candidate.slice(0, 9) + '  base ' + base.slice(0, 9) +
    '  ' + budgetValue + (budgetMode === 'nodes' ? ' nodes' : ' ms'));
}

for (const [name, set] of Object.entries(sets)) {
  if (name !== 'workflow' && set.size > 1) {
    fail(3, 'shards disagree on ' + name + ': ' + Array.from(set).join(', '));
  }
}
if (workflowPresent !== 0 && workflowPresent !== files.length) {
  fail(3, 'workflow-run must be present on every shard or none (' +
    workflowPresent + '/' + files.length + ' present)');
}
if (sets.workflow.size > 1) {
  fail(3, 'shards came from different workflow runs: ' +
    Array.from(sets.workflow).join(', '));
}

const missing = [];
for (let op = 0; op < EXP_OPENINGS; op++) {
  for (let seed = 0; seed < EXP_SEEDS; seed++) {
    if (!owner.has(op + ':' + seed)) missing.push(op + ':' + seed);
  }
}
if (missing.length) {
  fail(5, 'incomplete manifest: ' + missing.length + ' of ' +
    (EXP_OPENINGS * EXP_SEEDS) + ' cells missing (e.g. ' +
    missing.slice(0, 6).join(', ') + ')');
}

let w = 0, d = 0, l = 0;
for (const r of all) for (const score of [r.white, r.black]) {
  if (score === 1) w++;
  else if (score === 0) l++;
  else d++;
}

const cs = clusterStats(all);
const budget = Array.from(sets.budget)[0].split(':');
const protocolId = Array.from(sets.protocol)[0];
const protocol = MatchProtocol.PROTOCOL_BY_ID[protocolId];
const protocolPass = cs.lo95 > protocol.lowerBoundThreshold;
console.log('\ncombined: ' + all.length + ' pairs, ' + (all.length * 2) +
  ' games  candidate ' + Array.from(sets.candidate)[0] + '  vs base ' +
  Array.from(sets.base)[0] + '  ' + budget[1] +
  (budget[0] === 'nodes' ? ' nodes/move' : ' ms/move'));
console.log('protocol: ' + protocolId +
  (protocol.formal
    ? ' (formal strict-strength fixed-node gate)'
    : budget[0] === 'time'
      ? ' (DRAFT equal-time diagnostic; non-auditable)'
      : ' (non-formal fixed-node diagnostic)'));
console.log('acceptance: ' + protocol.acceptanceClass +
  ' (one-sided 95% lower bound must be > ' +
  (protocol.lowerBoundThreshold * 100).toFixed(0) + '%)');
console.log('W ' + w + ' / D ' + d + ' / L ' + l +
  '  score ' + (cs.mean * 100).toFixed(2) +
  '%  one-sided 95% lower bound ' + (cs.lo95 * 100).toFixed(2) +
  '%  over ' + cs.nClusters + ' openings (' + cs.nPairs + ' pairs)');
console.log('RESULT: ' + (protocolPass
  ? protocol.formal
    ? 'PASS — strict strength gate met'
    : cs.verdict
  : protocol.formal
    ? 'FAIL — strict strength gate not met (lower bound at or below 50%)'
    : cs.verdict));
process.exit(protocolPass ? 0 : 1);
