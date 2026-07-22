/* Opening-cluster statistics tests — run with: node test/match-stats.test.js */
'use strict';
const { clusterStats, tCrit95Lower } = require('./match-stats');

let passed = 0, failed = 0;
function check(ok, label) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label); }
}

console.log('one-sided t critical values');
check(Math.abs(tCrit95Lower(1) - 6.314) < 1e-3, 't(1) = 6.314');
check(Math.abs(tCrit95Lower(30) - 1.697) < 1e-3, 't(30) = 1.697');
check(tCrit95Lower(99) > 1.660 && tCrit95Lower(99) < 1.662, 't(99) ~ 1.660');
check(tCrit95Lower(10) > tCrit95Lower(100) && tCrit95Lower(100) > 1.645, 't decreases monotonically toward 1.645');

console.log('clustering by opening');
// 100 openings x 4 seeds = 400 pairs, but n must be 100 openings, not 400.
const many = [];
for (let op = 0; op < 100; op++) for (let s = 0; s < 4; s++) many.push({ op: op, pair: 0.6 });
const c = clusterStats(many);
check(c.nClusters === 100 && c.nPairs === 400, 'clusters by opening: n = 100 openings (not 400 pairs)');

console.log('verdict thresholds');
// A tight edge whose lower bound clears 50% is called stronger.
const strong = [];
for (let op = 0; op < 100; op++) strong.push({ op: op, pair: op % 2 ? 0.62 : 0.58 });
const sv = clusterStats(strong);
check(sv.pass && sv.lo95 > 0.50 && /stronger/.test(sv.verdict),
  'tight ~60% edge -> PASS stronger (lo95 ' + (sv.lo95 * 100).toFixed(2) + '%)');

// A lower bound in (49%, 50%] passes non-inferiority but is NOT called stronger.
// fifty 0.55 + fifty 0.46 -> mean 0.505, sd ~0.0452, lo95 ~0.4975.
const border = [];
for (let op = 0; op < 100; op++) border.push({ op: op, pair: op < 50 ? 0.55 : 0.46 });
const bv = clusterStats(border);
check(bv.pass && bv.lo95 > 0.49 && bv.lo95 < 0.50 && /non-inferior/.test(bv.verdict),
  'lower bound in (49%,50%] -> PASS non-inferior, not stronger (lo95 ' + (bv.lo95 * 100).toFixed(2) + '%)');

// A mean below the tolerance fails the gate.
const weak = [];
for (let op = 0; op < 100; op++) weak.push({ op: op, pair: op % 2 ? 0.40 : 0.44 });
const wv = clusterStats(weak);
check(!wv.pass && /FAIL/.test(wv.verdict), '~42% mean -> FAIL non-inferiority');

console.log('degenerate inputs');
// A single opening cannot yield a confidence bound.
const one = clusterStats([{ op: 0, pair: 0.7 }]);
check(one.nClusters === 1 && !one.pass && /inconclusive/.test(one.verdict), 'single opening -> inconclusive');

// Identity match (regression for P1): identical engines make every opening's
// colour-swapped games mirror to exactly 0.5, so the observed cross-opening SD
// is zero. Retaining it, the lower bound is the mean (0.5): an unchanged
// candidate is declared NON-INFERIOR (not stronger), never a false FAIL.
const identity = [];
for (let op = 0; op < 100; op++) for (let s = 0; s < 4; s++) identity.push({ op: op, pair: 0.5 });
const iv = clusterStats(identity);
check(iv.sd === 0 && Math.abs(iv.lo95 - 0.5) < 1e-12 && iv.pass && /non-inferior/.test(iv.verdict),
  'identity match (all 0.5, zero variance) -> lower bound 50%, PASS non-inferior (lo95 ' +
  (iv.lo95 * 100).toFixed(2) + '%)');
check(iv.lo95 <= 0.50, 'identity match is NOT over-claimed as stronger (lo95 not > 50%)');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
