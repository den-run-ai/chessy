/*
 * Aggregate self-play match shards into one opening-clustered verdict.
 *
 * Usage:
 *   node test/ai-match-agg.js [--openings 100] [--seeds 4] shard0.txt shard1.txt ...
 *
 * Each argument is a shard artifact (the workflow's match-results.txt) that
 * MUST carry the workflow metadata header (candidate-sha, base-sha,
 * nodes-per-move) and a `records:` line from test/ai-match.js. The shards must
 * TILE the full manifest exactly: every (opening, seed) cell of
 * {0..openings-1} x {0..seeds-1} present once and only once. Anything less is a
 * hard error — a partial or double-counted set must never silently produce a
 * verdict.
 *
 * Exit codes:
 *   0  aggregated; candidate PASSES the non-inferiority gate
 *   1  aggregated; candidate FAILS the gate
 *   2  usage error / missing metadata / malformed record
 *   3  shards disagree on candidate-sha, base-sha, or nodes-per-move
 *   4  a (opening, seed) cell appears in more than one shard
 *   5  the shards do not cover the full manifest
 */
'use strict';
const fs = require('fs');
const { clusterStats } = require('./match-stats');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
}
function posIntOpt(name, dflt) {
  const raw = opt(name, String(dflt));
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) { fail(2, '--' + name + ' must be a positive integer (got "' + raw + '")'); }
  return n;
}
function fail(code, msg) { console.error('ERROR: ' + msg); process.exit(code); }

const EXP_OPENINGS = posIntOpt('openings', 100);
const EXP_SEEDS = posIntOpt('seeds', 4);
const files = argv.filter(function (a, i) {
  if (a.indexOf('--') === 0) return false;                 // a flag
  if (i > 0 && (argv[i - 1] === '--openings' || argv[i - 1] === '--seeds')) return false; // a flag's value
  return true;
});
if (files.length === 0) fail(2, 'usage: node test/ai-match-agg.js [--openings N] [--seeds M] <shard-file> ...');

function field(text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : null;
}

const all = [];
const owner = new Map(); // "op:seed" -> file (duplicate detection)
const cands = new Set(), bases = new Set(), nodes = new Set(), totals = new Set();
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { fail(2, 'cannot read ' + file + ': ' + e.message); }

  // Required metadata — a shard with no provenance is not admissible.
  const csha = field(text, 'candidate-sha');
  const bsha = field(text, 'base-sha');
  const npm = field(text, 'nodes-per-move');
  const missing = [];
  if (!csha) missing.push('candidate-sha');
  if (!bsha) missing.push('base-sha');
  if (!npm) missing.push('nodes-per-move');
  const recLine = text.split('\n').find(function (ln) { return ln.indexOf('records: ') === 0; });
  if (!recLine) missing.push('records');
  if (missing.length) fail(2, file + ' is missing required field(s): ' + missing.join(', '));

  cands.add(csha); bases.add(bsha); nodes.add(npm);
  const tot = field(text, 'openings-total');
  if (tot) {
    totals.add(tot);
    // Catch a wrong --openings before the per-record range check turns the same
    // mismatch into a less obvious "op out of range" error.
    if (Number(tot) !== EXP_OPENINGS) {
      fail(3, file + ' ran a ' + tot + '-opening list but --openings is ' + EXP_OPENINGS);
    }
  }

  let recs;
  try { recs = JSON.parse(recLine.slice('records: '.length)); }
  catch (e) { fail(2, 'bad records JSON in ' + file + ': ' + e.message); }
  if (!Array.isArray(recs) || recs.length === 0) fail(2, file + ': records is empty or not an array');

  for (const r of recs) {
    if (!Number.isInteger(r.op) || r.op < 0 || r.op >= EXP_OPENINGS) {
      fail(2, file + ': record op ' + JSON.stringify(r.op) + ' is out of range [0,' + EXP_OPENINGS + ')');
    }
    if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed >= EXP_SEEDS) {
      fail(2, file + ': record seed ' + JSON.stringify(r.seed) + ' is out of range [0,' + EXP_SEEDS + ')');
    }
    if (typeof r.pair !== 'number' || r.pair < 0 || r.pair > 1) {
      fail(2, file + ': record pair ' + JSON.stringify(r.pair) + ' is not a score in [0,1]');
    }
    const k = r.op + ':' + r.seed;
    if (owner.has(k)) {
      fail(4, 'cell (opening ' + r.op + ', seed ' + r.seed + ') appears in both ' +
        owner.get(k) + ' and ' + file + ' — shards are not disjoint');
    }
    owner.set(k, file);
    all.push(r);
  }
  console.log('loaded ' + recs.length + ' pairs from ' + file +
    '  cand ' + csha.slice(0, 9) + '  base ' + bsha.slice(0, 9) + '  ' + npm + ' nodes');
}

// Consistency across shards.
if (cands.size > 1) fail(3, 'shards played different candidate SHAs: ' + Array.from(cands).join(', '));
if (bases.size > 1) fail(3, 'shards played different base SHAs: ' + Array.from(bases).join(', '));
if (nodes.size > 1) fail(3, 'shards used different node budgets: ' + Array.from(nodes).join(', '));
if (totals.size > 1) fail(3, 'shards report different opening-list sizes: ' + Array.from(totals).join(', '));
if (totals.size === 1 && Number(Array.from(totals)[0]) !== EXP_OPENINGS) {
  fail(3, 'shards ran a ' + Array.from(totals)[0] + '-opening list but --openings is ' + EXP_OPENINGS);
}

// Completeness: every cell of the manifest must be present exactly once.
const missingCells = [];
for (let op = 0; op < EXP_OPENINGS; op++) {
  for (let s = 0; s < EXP_SEEDS; s++) {
    if (!owner.has(op + ':' + s)) missingCells.push(op + ':' + s);
  }
}
if (missingCells.length) {
  fail(5, 'incomplete manifest: ' + missingCells.length + ' of ' + (EXP_OPENINGS * EXP_SEEDS) +
    ' (opening, seed) cells are missing (e.g. ' + missingCells.slice(0, 6).join(', ') + ') — ' +
    'expected ' + EXP_OPENINGS + ' openings x ' + EXP_SEEDS + ' seeds');
}

// Reconstruct W/D/L from the candidate's per-game scores.
let w = 0, d = 0, l = 0;
for (const r of all) for (const sc of [r.white, r.black]) {
  if (sc === 1) w++; else if (sc === 0) l++; else if (sc === 0.5) d++;
}

const cs = clusterStats(all);
console.log('\ncombined: ' + all.length + ' pairs, ' + (all.length * 2) + ' games' +
  '  candidate ' + Array.from(cands)[0] + '  vs base ' + Array.from(bases)[0] +
  '  ' + Array.from(nodes)[0] + ' nodes/move');
console.log('W ' + w + ' / D ' + d + ' / L ' + l +
  '  score ' + (cs.mean * 100).toFixed(2) + '%  one-sided 95% lower bound ' +
  (cs.lo95 * 100).toFixed(2) + '%  over ' + cs.nClusters + ' openings (' + cs.nPairs + ' pairs)');
console.log('RESULT: ' + cs.verdict);
process.exit(cs.pass ? 0 : 1);
