/*
 * Isolated timed-search worker for ai-tt5-screen.js. Candidate and baseline
 * run in separate Node processes so each revision owns an isolated WASM
 * instance and linear memory, mirroring test/ai-bench-worker.js. Requests are
 * production-budget searches
 * (maxDepth 30, quiesce, timeMs) rather than fixed-depth batches.
 */
'use strict';
const WasmHarness = require('./wasm-harness-engine');

const ref = process.argv[2] === '__worktree__' ? null : process.argv[2];
let engine = null;

function timedThink(fen, timeMs) {
  const t0 = process.hrtime.bigint();
  const r = engine.search(fen, { maxDepth: 30, timeMs: timeMs, quiesce: true });
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    wallMs: wallMs,
    elapsedMs: wallMs,
    stopReason: r.stopReason,
    nodes: r.nodes,
    qnodes: r.qnodes || 0,
    researches: r.researches || 0,
    depth: r.depth,
    score: r.score,
    move: WasmHarness.moveName(r.move)
  };
}

process.on('disconnect', function () { process.exit(0); });
WasmHarness.loadRevision(ref).then(function (loaded) {
  engine = loaded;
  process.on('message', function (message) {
    if (!message || message.type !== 'think') return;
    try {
      process.send({
        id: message.id,
        result: timedThink(message.fen, message.timeMs)
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
