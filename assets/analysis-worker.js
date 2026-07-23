/*
 * Coaching-analysis Web Worker — DEDICATED to the analysis contract, entirely
 * separate from ai-worker.js (opponent play). It runs the heavy, full-window,
 * delta-pruning-off MultiPV verification off the main thread so a live Play
 * search is never disturbed and the UI never freezes.
 *
 * Protocol (versioned so the page and worker can never silently disagree across
 * a release): the page posts { v, jobId, fen, positions, opts } and the worker
 * replies exactly once with { v, jobId, result } or { v, jobId, error }. The
 * jobId is echoed verbatim so the service can drop a reply that belongs to a
 * superseded/cancelled request. A protocol-version mismatch is reported rather
 * than acted on.
 *
 * The worker URL carries the page's release token (#37); forward it so
 * engine/ai/analysis-core all come from the SAME release (the service worker
 * caches each release's assets under distinct keys).
 */
importScripts(
  'engine.js' + self.location.search,
  'ai.js' + self.location.search,
  'analysis-core.js' + self.location.search);

var PROTOCOL = 1;

self.onmessage = function (e) {
  var msg = e.data || {};
  var jobId = msg.jobId;
  if (msg.v !== PROTOCOL) {
    self.postMessage({ v: PROTOCOL, jobId: jobId, error: 'protocol-version' });
    return;
  }
  try {
    var state = Chess.parseFen(msg.fen);
    // The repetition table travels explicitly in opts.positions; analyse()
    // resolves opts.positions || state.positions, so a completed threefold is
    // terminal and deep lines see the draws in the game's history.
    var opts = msg.opts || {};
    if (msg.positions) opts = Object.assign({}, opts, { positions: msg.positions });
    var result = ChessyAnalysisCore.analyse(state, opts);
    self.postMessage({ v: PROTOCOL, jobId: jobId, result: result });
  } catch (err) {
    self.postMessage({ v: PROTOCOL, jobId: jobId, error: String(err && err.message || err) });
  }
};
