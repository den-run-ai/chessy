/*
 * Isolated timing worker for ai-bench.js. Candidate and baseline run in
 * separate Node processes so each revision owns an isolated WASM instance and
 * linear memory during its timed sample.
 */
'use strict';
const WasmHarness = require('./wasm-harness-engine');

const ref = process.argv[2] === '__worktree__' ? null : process.argv[2];
let engine = null;

function bench(fen, depth) {
  const t0 = process.hrtime.bigint();
  const r = engine.search(fen, { maxDepth: depth, quiesce: true });
  return {
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    cutoffs: r.cutoffs || 0,
    researches: r.researches || 0,
    depth: r.depth,
    score: r.score,
    move: WasmHarness.moveName(r.move)
  };
}

function sameSearch(a, b) {
  return a.nodes === b.nodes && a.qnodes === b.qnodes &&
    a.cutoffs === b.cutoffs && a.researches === b.researches &&
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
WasmHarness.loadRevision(ref).then(function (loaded) {
  engine = loaded;
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
}).catch(function (error) {
  process.send({
    type: 'startup-error',
    error: error && error.stack || String(error)
  }, function () {
    if (process.connected) process.disconnect();
  });
});
