/*
 * Shared statistics for the paired self-play match (test/ai-match.js) and its
 * shard aggregator (test/ai-match-agg.js).
 *
 * The independent unit of analysis is the OPENING, not the (opening, seed)
 * pair. Repeated seeds of one opening explore correlated positions, so pooling
 * all pairs as if independent understates variance (pseudoreplication) and
 * makes a confidence bound look tighter than the evidence warrants. We instead
 * CLUSTER the pair scores by opening, average each opening to a single mean,
 * and form the confidence bound over those per-opening means — so 100 openings
 * x 4 seeds is n = 100 observations, not 400.
 *
 * The gate is one-sided non-inferiority: the 95% LOWER confidence bound on the
 * candidate's score must exceed 49% (a tolerated loss of at most 1 percentage
 * point, ~7 Elo). A lower bound above 50% additionally licenses "stronger".
 */
'use strict';

// One-sided 95% (upper-tail 0.05) Student's t critical value by degrees of
// freedom. Exact table for df <= 30; beyond that 1.645 + 1.55/df is within
// ~0.001 of the true value (df=40 -> 1.684, df=60 -> 1.671, df=99 -> 1.660,
// df=inf -> 1.645). This is the one-sided companion to ai-match's two-sided
// tCrit95 — a one-sided 95% bound uses the same critical value as a two-sided
// 90% interval, so the numbers here are deliberately smaller.
function tCrit95Lower(df) {
  const T = [6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833,
    1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729,
    1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
  if (df <= 0) return Infinity;
  return df <= 30 ? T[df - 1] : 1.645 + 1.55 / df;
}

// records: array of { op, pair } (other fields ignored). `op` is the frozen
// opening index; `pair` is the candidate's paired score in [0, 1]. Returns the
// clustered non-inferiority verdict.
function clusterStats(records) {
  const byOp = new Map();
  for (const r of records) {
    if (!byOp.has(r.op)) byOp.set(r.op, []);
    byOp.get(r.op).push(r.pair);
  }
  const means = [];
  byOp.forEach(function (arr) {
    means.push(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
  });
  const nClusters = means.length, nPairs = records.length;
  if (nClusters < 2) {
    return {
      nClusters: nClusters, nPairs: nPairs,
      mean: nClusters ? means[0] : NaN, sd: NaN, lo95: NaN,
      pass: false, verdict: 'inconclusive (need >= 2 openings for a confidence bound)'
    };
  }
  const mean = means.reduce(function (a, b) { return a + b; }, 0) / nClusters;
  let sd = Math.sqrt(means.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (nClusters - 1));
  // A zero observed variance across openings does not prove zero true variance;
  // with a bounded [0,1] score fall back to its largest possible sd (0.5) so
  // the bound reflects genuine uncertainty rather than false certainty. (Mirrors
  // ai-match's pair-level guard.)
  if (sd === 0) sd = 0.5;
  const half = tCrit95Lower(nClusters - 1) * sd / Math.sqrt(nClusters);
  const lo95 = Math.max(0, mean - half);
  let verdict, pass;
  if (lo95 > 0.50) { pass = true; verdict = 'PASS — stronger (one-sided 95% lower bound above 50%)'; }
  else if (lo95 > 0.49) { pass = true; verdict = 'PASS — non-inferior (one-sided 95% lower bound above 49%)'; }
  else { pass = false; verdict = 'FAIL — non-inferiority not met (lower bound at or below 49%)'; }
  return { nClusters: nClusters, nPairs: nPairs, mean: mean, sd: sd, lo95: lo95, pass: pass, verdict: verdict };
}

module.exports = { tCrit95Lower: tCrit95Lower, clusterStats: clusterStats };
