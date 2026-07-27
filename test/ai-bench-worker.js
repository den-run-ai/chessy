/*
 * Isolated timing worker for ai-bench.js. Candidate and baseline run in
 * separate Node processes so an allocation change in one engine cannot trigger
 * garbage collection in the other's timed sample.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ref = process.argv[2] === '__worktree__' ? null : process.argv[2];
const MK_RAND = 'function __mkRand(seed) {\n' +
  '  return function () {\n' +
  '    seed = (seed + 0x6D2B79F5) | 0;\n' +
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);\n' +
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
  '  };\n' +
  '}';

function readEngine(file) {
  if (!ref) return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  return cp.execFileSync('git', ['show', ref + ':' + file], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    cwd: path.join(__dirname, '..')
  });
}

let ctx = null;
let startupError = null;
try {
  ctx = vm.createContext({ console: console });
  vm.runInContext(MK_RAND, ctx);
  vm.runInContext(readEngine('assets/engine.js'), ctx, { filename: 'engine.js' });
  vm.runInContext(readEngine('assets/ai.js'), ctx, { filename: 'ai.js' });
} catch (error) {
  startupError = error;
}

function bench(fen, depth) {
  vm.runInContext('Math.random = __mkRand(0xC0FFEE)', ctx);
  const state = ctx.Chess.parseFen(fen);
  const t0 = process.hrtime.bigint();
  const r = ctx.ChessAI.think(state, { maxDepth: depth, quiesce: true });
  return {
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    cutoffs: r.cutoffs || 0,
    researches: r.researches || 0,
    lmrApplied: r.lmrApplied || 0,
    lmrResearched: r.lmrResearched || 0,
    depth: r.depth,
    score: r.score,
    move: r.move
      ? ctx.Chess.sqName(r.move.from) + ctx.Chess.sqName(r.move.to) +
        (r.move.promotion || '')
      : '-'
  };
}

function sameSearch(a, b) {
  return a.nodes === b.nodes && a.qnodes === b.qnodes &&
    a.cutoffs === b.cutoffs && a.researches === b.researches &&
    a.lmrApplied === b.lmrApplied &&
    a.lmrResearched === b.lmrResearched &&
    a.depth === b.depth && a.score === b.score && a.move === b.move;
}

function benchBatch(fen, depth, batch) {
  let first = null, elapsed = 0;
  for (let i = 0; i < batch; i++) {
    const result = bench(fen, depth);
    if (first && !sameSearch(first, result)) {
      throw new Error('search changed inside an identical timing batch');
    }
    if (!first) first = result;
    elapsed += result.ms;
  }
  first.ms = elapsed / batch;
  first.batch = batch;
  return first;
}

process.on('disconnect', function () { process.exit(0); });
if (startupError) {
  process.send({
    type: 'startup-error',
    error: startupError && startupError.stack || String(startupError)
  }, function () {
    if (process.connected) process.disconnect();
  });
} else {
  process.on('message', function (message) {
    if (!message || message.type !== 'bench') return;
    try {
      process.send({
        id: message.id,
        result: benchBatch(message.fen, message.depth, message.batch || 1)
      });
    } catch (error) {
      process.send({ id: message.id, error: error && error.stack || String(error) });
    }
  });
  process.send({ type: 'ready' });
}
