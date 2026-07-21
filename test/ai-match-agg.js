/*
 * Aggregate self-play match shards into one opening-clustered verdict.
 *
 * Usage:
 *   node test/ai-match-agg.js shard0.txt shard1.txt shard2.txt shard3.txt
 *
 * Each argument is a file containing a `records: [...]` line as emitted by
 * test/ai-match.js (the workflow's match-results.txt artifact qualifies). The
 * four 200-game shards of the planned 800-game match are run with a shared
 * base/nodes and disjoint --seedbase values; this concatenates their records,
 * clusters the pairs by opening, and prints the combined non-inferiority
 * verdict from the SAME statistics the match itself uses (test/match-stats.js).
 *
 * It refuses to combine shards that played different candidate/base SHAs, and
 * warns (does not silently merge) if two shards overlap on the same
 * (opening, seed) slot — a sign the shards were not disjoint.
 */
'use strict';
const fs = require('fs');
const { clusterStats } = require('./match-stats');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node test/ai-match-agg.js <shard-file> [<shard-file> ...]');
  process.exit(2);
}

// Pull the first `<key>: <value>` line (workflow header fields) if present.
function field(text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : null;
}

const all = [];
const seen = new Map(); // "op:seed" -> file, to detect non-disjoint shards
const cands = new Set(), bases = new Set();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const line = text.split('\n').find(function (ln) { return ln.indexOf('records: ') === 0; });
  if (!line) { console.error('no `records:` line in ' + file); process.exit(2); }
  let recs;
  try { recs = JSON.parse(line.slice('records: '.length)); }
  catch (e) { console.error('bad records JSON in ' + file + ': ' + e.message); process.exit(2); }
  const csha = field(text, 'candidate-sha'), bsha = field(text, 'base-sha');
  if (csha) cands.add(csha);
  if (bsha) bases.add(bsha);
  for (const r of recs) {
    const k = r.op + ':' + r.seed;
    if (seen.has(k)) {
      console.error('WARNING: (opening ' + r.op + ', seed ' + r.seed + ') appears in both ' +
        seen.get(k) + ' and ' + file + ' — shards are not disjoint; the duplicate is still counted');
    } else {
      seen.set(k, file);
    }
    all.push(r);
  }
  console.log('loaded ' + recs.length + ' pairs from ' + file +
    (csha ? '  cand ' + csha.slice(0, 9) : '') + (bsha ? '  base ' + bsha.slice(0, 9) : ''));
}

if (cands.size > 1) {
  console.error('ERROR: shards played different candidate SHAs: ' + Array.from(cands).join(', '));
  process.exit(3);
}
if (bases.size > 1) {
  console.error('ERROR: shards played different base SHAs: ' + Array.from(bases).join(', '));
  process.exit(3);
}

// Reconstruct W/D/L from the candidate's per-game scores.
let w = 0, d = 0, l = 0;
for (const r of all) for (const sc of [r.white, r.black]) {
  if (sc === 1) w++; else if (sc === 0) l++; else d++;
}

const cs = clusterStats(all);
console.log('\ncombined: ' + all.length + ' pairs, ' + (all.length * 2) + ' games' +
  (cands.size === 1 ? '  candidate ' + Array.from(cands)[0] : '') +
  (bases.size === 1 ? '  vs base ' + Array.from(bases)[0] : ''));
console.log('W ' + w + ' / D ' + d + ' / L ' + l +
  (cs.nClusters >= 2
    ? '  score ' + (cs.mean * 100).toFixed(2) + '%  one-sided 95% lower bound ' +
      (cs.lo95 * 100).toFixed(2) + '%  over ' + cs.nClusters + ' openings'
    : '  (' + cs.nClusters + ' openings — too few)'));
console.log('RESULT: ' + cs.verdict);
process.exit(0);
