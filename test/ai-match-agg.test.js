/*
 * Aggregator hardening tests — run with: node test/ai-match-agg.test.js
 *
 * Synthesizes shard artifacts in a temp dir and asserts that ai-match-agg.js
 * ACCEPTS a complete, disjoint, consistent manifest and REJECTS (non-zero,
 * with the documented exit code) every bad case: missing metadata, malformed
 * records, mismatched SHAs/nodes, duplicated cells, and incomplete coverage.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const AGG = path.join(__dirname, 'ai-match-agg.js');
const OPENINGS = 100, SEEDS = 4;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aggtest-'));

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail != null ? ' — ' + detail : '')); }
}

// Build one shard file covering openings [0,OPENINGS) for a single seed slot.
// `over` can override header fields (candidate-sha/base-sha/nodes-per-move) or
// inject a bad record.
function shardFile(name, seed, over) {
  over = over || {};
  const recs = [];
  for (let op = 0; op < OPENINGS; op++) {
    // Per-opening pair alternates 0.75 (W1/B0.5) / 0.50 (W0.5/B0.5) -> mean
    // 0.625 with real variance -> a clean PASS (lower bound well above 50%).
    // Both game scores are in {0,0.5,1} and pair === (white+black)/2, so the
    // records satisfy the aggregator's consistency check.
    const white = 1, black = op % 2 ? 0.5 : 0;
    recs.push({ op: op, name: 'op' + op, seed: seed, gseed: op * 7 + seed,
      white: white, black: black, pair: (white + black) / 2 });
  }
  if (over.badRecord) recs.push(over.badRecord);
  if (over.dropOp != null) recs.splice(over.dropOp, 1); // remove a cell -> incomplete
  const lines = [
    'candidate-sha: ' + (over.candSha || 'cand0000000000000000000000000000000000000'),
    'base-sha:      ' + (over.baseSha || 'base0000000000000000000000000000000000000'),
    'nodes-per-move: ' + (over.nodes || '10000'),
    'openings-total: ' + (over.total || OPENINGS),
    '---',
    'records: ' + JSON.stringify(recs)
  ].filter(function (ln) { return over.omit ? ln.indexOf(over.omit) !== 0 : true; });
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// Run the aggregator; return its exit code (0 on success).
function run(fileArgs, extra) {
  try {
    cp.execFileSync('node', [AGG].concat(extra || []).concat(fileArgs), { stdio: 'pipe' });
    return 0;
  } catch (e) { return e.status == null ? -1 : e.status; }
}

// Four disjoint seed shards = the full 100x4 manifest.
const full = [shardFile('s0.txt', 0), shardFile('s1.txt', 1), shardFile('s2.txt', 2), shardFile('s3.txt', 3)];

console.log('accepts a complete manifest');
check(run(full) === 0, 'complete, disjoint, consistent 100x4 -> exit 0 (PASS)');

console.log('rejects bad manifests');
check(run(full.slice(0, 3)) === 5, 'missing a seed slot -> exit 5 (incomplete)');
check(run([shardFile('opincomplete.txt', 0, { dropOp: 10 }), full[1], full[2], full[3]]) === 5,
  'one missing (opening, seed) cell -> exit 5 (incomplete)');
check(run(full.concat([full[0]])) === 4, 'a duplicated shard -> exit 4 (overlapping cells)');
check(run([full[0], full[1], full[2], shardFile('s3bad.txt', 3, { baseSha: 'DIFFERENT' })]) === 3,
  'a mismatched base-sha -> exit 3');
check(run([full[0], full[1], full[2], shardFile('s3nodes.txt', 3, { nodes: '25000' })]) === 3,
  'a mismatched node budget -> exit 3');
check(run([full[0], full[1], full[2], shardFile('s3nometa.txt', 3, { omit: 'candidate-sha' })]) === 2,
  'a shard missing candidate-sha -> exit 2 (missing metadata)');
check(run([full[0], full[1], full[2], shardFile('s3norec.txt', 3, { omit: 'records' })]) === 2,
  'a shard missing the records line -> exit 2');
check(run([shardFile('s0badrec.txt', 0, { badRecord: { op: 999, seed: 0, pair: 0.5 } }), full[1], full[2], full[3]]) === 2,
  'an out-of-range op -> exit 2 (malformed record)');
check(run(full, ['--openings', '99']) === 3,
  'declared --openings disagreeing with the shards -> exit 3');

// An out-of-range pair value, isolated on a 1x1 manifest so it reaches pair
// validation instead of colliding with an existing cell.
function rawShard(name, recs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, ['candidate-sha: c', 'base-sha: b', 'nodes-per-move: 10000',
    'openings-total: 1', '---', 'records: ' + JSON.stringify(recs)].join('\n') + '\n');
  return p;
}
check(run([rawShard('badpair.txt', [{ op: 0, seed: 0, white: 1, black: 1, pair: 2 }])], ['--openings', '1', '--seeds', '1']) === 2,
  'an out-of-range pair -> exit 2 (malformed record)');
check(run([rawShard('good11.txt', [{ op: 0, seed: 0, white: 1, black: 0, pair: 0.5 }])], ['--openings', '1', '--seeds', '1']) === 1,
  'a valid 1x1 manifest at 50% -> exit 1 (aggregates, FAILs the gate)');
// Regression: an internally inconsistent record (the reviewer's white 0 /
// black 0 / pair 1) must be rejected, not silently gated on `pair` while W/D/L
// reads white/black — otherwise 800 losses could report a 100% PASS.
check(run([rawShard('inconsistent.txt', [{ op: 0, seed: 0, white: 0, black: 0, pair: 1 }])], ['--openings', '1', '--seeds', '1']) === 2,
  'pair != (white+black)/2 -> exit 2 (inconsistent record)');
// A game score outside {0,0.5,1} is malformed even if `pair` looks in-range.
check(run([rawShard('badgame.txt', [{ op: 0, seed: 0, white: 0.3, black: 0.7, pair: 0.5 }])], ['--openings', '1', '--seeds', '1']) === 2,
  'a non-{0,0.5,1} game score -> exit 2 (malformed record)');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
