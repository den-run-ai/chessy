/* Finite-population sampling: uncertainty is from the draw, never iid chess
 * outcomes. No normal approximation, estimated effective n, or family pooling. */
'use strict';
const crypto = require('crypto');
function check(ok, message) { if (!ok) throw new Error(message); }
function integer(value, lo, hi) { check(Number.isSafeInteger(value) && value >= lo && value <= hi, 'invalid sampling integer'); }
function sample(population, count, randomInt = crypto.randomInt) {
  integer(population.length, 2, 1000000); integer(count, 1, population.length - 1);
  check(new Set(population).size === population.length, 'duplicate population endpoint');
  const pool = population.slice(), draws = [];
  for (let i = 0; i < count; i++) {
    // crypto.randomInt uses rejection sampling, avoiding modulo bias. The
    // retained integers replay the exact partial Fisher-Yates draw.
    const j = randomInt(i, pool.length); integer(j, i, pool.length - 1);
    draws.push(j); [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { algorithm: 'os-randomInt-partial-fisher-yates-v1', draws, endpoints: pool.slice(0, count) };
}
function replay(population, receipt) {
  check(receipt && Array.isArray(receipt.draws), 'missing sampling receipt');
  let i = 0;
  const reproduced = sample(population, receipt.draws.length, () => receipt.draws[i++]);
  check(JSON.stringify(reproduced) === JSON.stringify(receipt), 'sampling receipt mismatch');
  return reproduced.endpoints;
}
function estimate(pairs, populationSize, alpha) {
  integer(populationSize, 2, 1000000); integer(pairs.length, 1, populationSize - 1);
  check(Number.isFinite(alpha) && alpha > 0 && alpha < 1, 'invalid alpha');
  const ids = new Set(); let sum = 0;
  for (const row of pairs) {
    check(row && typeof row.id === 'string' && row.id && !ids.has(row.id), 'duplicate/invalid endpoint score');
    check([0, 0.25, 0.5, 0.75, 1].includes(row.score), 'invalid paired-color score');
    ids.add(row.id); sum += row.score;
  }
  const mean = sum / pairs.length, radius = Math.sqrt(Math.log(1 / alpha) / (2 * pairs.length));
  return { estimator: 'finite-population-endpoint-hoeffding-one-sided-v1',
    estimand: 'uniform-finite-bank-endpoint-two-color-mean', populationSize,
    sampledEndpoints: pairs.length, alpha, mean, radius, lower: Math.max(0, mean - radius),
    uncertainty: 'simple-random-sampling-without-replacement-of-fixed-outcomes',
    independentOutcomeAssumption: false, effectiveFamilySampleSize: null };
}
module.exports = { sample, replay, estimate };
