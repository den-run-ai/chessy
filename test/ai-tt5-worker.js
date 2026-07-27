/*
 * Isolated timed-search worker for ai-tt5-screen.js. Candidate and baseline
 * run in separate Node processes so an allocation change in one engine cannot
 * trigger garbage collection inside the other's timed think, mirroring
 * test/ai-bench-worker.js. Requests are production-budget searches
 * (maxDepth 30, quiesce, timeMs) rather than fixed-depth batches.
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

function timedThink(fen, timeMs, seed) {
  vm.runInContext('Math.random = __mkRand(' + (seed | 0) + ')', ctx);
  const state = ctx.Chess.parseFen(fen);
  const t0 = process.hrtime.bigint();
  const r = ctx.ChessAI.think(state, { maxDepth: 30, timeMs: timeMs, quiesce: true });
  return {
    wallMs: Number(process.hrtime.bigint() - t0) / 1e6,
    elapsedMs: r.elapsedMs,
    stopReason: r.stopReason,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    researches: r.researches || 0,
    depth: r.depth,
    score: r.score,
    move: r.move
      ? ctx.Chess.sqName(r.move.from) + ctx.Chess.sqName(r.move.to) +
        (r.move.promotion || '')
      : '-'
  };
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
    if (!message || message.type !== 'think') return;
    try {
      process.send({
        id: message.id,
        result: timedThink(message.fen, message.timeMs, message.seed)
      });
    } catch (error) {
      process.send({ id: message.id, error: error && error.stack || String(error) });
    }
  });
  process.send({ type: 'ready' });
}
