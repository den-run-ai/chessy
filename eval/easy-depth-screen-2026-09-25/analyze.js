#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');
const screen = require('../../test/eval/level-screen.js');
const REPLICATES = 10000;
const SEED = 20260925;

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(xs, q) {
  const p = (xs.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return xs[lo] + (xs[hi] - xs[lo]) * (p - lo);
}

function readBlock(file, depth) {
  const sealed = screen.verifySealed(path.resolve(file), screen.sourceOpenings());
  assert.equal(sealed.receipt.identityComplete, true);
  assert.equal(sealed.records.length, 100);
  const slots = new Set();
  const reasons = {};
  const depths = {};
  const stops = {};
  const stats = { moves: 0, retries: 0, failures: 0, nodes: 0, ms: 0, maxMs: 0,
    ttSaturated: 0 };
  for (const r of sealed.records) {
    assert.equal(r.level, 'easy');
    assert.equal(r.anchor, 1500);
    assert.deepEqual(r.preset, { label: 'Easy', target: '1500', maxDepth: depth,
      nodeLimit: 10000, timeMs: 5000, quiesce: true });
    assert.equal(r.openingId % 2, 0);
    assert.ok(r.openingId >= 0 && r.openingId < 100);
    assert.ok(['white', 'black'].includes(r.chessyColor));
    slots.add(r.openingId + ':' + r.chessyColor);
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    stats.failures += /^(chessy-|anchor-)/.test(r.reason) ? 1 : 0;
    stats.moves += r.chessy.moves;
    stats.retries += r.chessy.retries;
    stats.nodes += r.chessy.nodesSum;
    stats.ms += r.chessy.msSum;
    stats.maxMs = Math.max(stats.maxMs, r.chessy.maxMs);
    stats.ttSaturated += r.chessy.ttSaturated;
    for (const [key, value] of Object.entries(r.chessy.depths)) {
      depths[key] = (depths[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(r.chessy.stops)) {
      stops[key] = (stops[key] || 0) + value;
    }
  }
  assert.equal(slots.size, 100);
  return { records: sealed.records, report: {
    file: path.basename(file), receipt: sealed.receipt,
    ...screen.summarize(sealed.records, { anchor: 1500,
      replicates: REPLICATES, seed: SEED }), reasons,
    search: { moves: stats.moves, retries: stats.retries, failures: stats.failures,
      meanNodes: stats.nodes / stats.moves, meanMs: stats.ms / stats.moves,
      maxMs: stats.maxMs, depths, stops, ttSaturated: stats.ttSaturated }
  } };
}

function analyze(controlFile, candidateFile) {
  const control = readBlock(controlFile, 2);
  const candidate = readBlock(candidateFile, 1);
  const paired = [];
  for (let id = 0; id < 100; id += 2) {
    const score = (block) => block.records.filter(r => r.openingId === id)
      .reduce((sum, r) => sum + r.score, 0) / 2;
    paired.push(score(candidate) - score(control));
  }
  const next = rng(SEED);
  const draws = [];
  for (let b = 0; b < REPLICATES; b++) {
    let total = 0;
    for (let i = 0; i < paired.length; i++) {
      total += paired[Math.floor(next() * paired.length)];
    }
    draws.push(total / paired.length);
  }
  draws.sort((a, b) => a - b);
  const delta95 = [quantile(draws, 0.025), quantile(draws, 0.975)];
  const controlRating = control.report.ratingEstimate;
  const candidateRating = candidate.report.ratingEstimate;
  const criteria = {
    strictlyCloserTo1500: Math.abs(candidateRating - 1500) < Math.abs(controlRating - 1500),
    atLeast50EloWeaker: candidateRating <= controlRating - 50,
    pairedScore95UpperBelowZero: delta95[1] < 0,
    noSearchRetriesOrFailures: [control, candidate].every(block =>
      block.report.search.retries === 0 && block.report.search.failures === 0)
  };
  return { status: 'exploratory-development-only',
    protocol: 'easy-depth-screen-2026-09-25',
    control: control.report, candidate: candidate.report,
    comparison: { scoreDifference: candidate.report.score - control.report.score,
      ratingDifference: candidateRating - controlRating,
      pairedOpeningBootstrap: { replicates: REPLICATES, seed: SEED,
        scoreDifference95: delta95 } },
    criteria, selectedDepth: Object.values(criteria).every(Boolean) ? 1 : 2 };
}

if (require.main === module) {
  assert.equal(process.argv.length, 4, 'usage: analyze.js <control> <candidate>');
  console.log(JSON.stringify(analyze(process.argv[2], process.argv[3]), null, 2));
}

module.exports = { analyze };
