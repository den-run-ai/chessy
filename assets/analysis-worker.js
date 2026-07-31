/*
 * Coaching-analysis Web Worker — DEDICATED to the analysis contract, entirely
 * separate from ai-worker.js (opponent play). It runs the heavy, full-window,
 * delta-pruning-off MultiPV verification off the main thread so a live Play
 * search is never disturbed and the UI never freezes.
 *
 * Protocol (versioned so the page and worker can never silently disagree across
 * a release): the page posts { v, jobId, fen, positions, opts,
 * elapsedOffsetMs } and the worker replies with zero or more EXCLUSIVE
 * non-terminal { v, jobId, progress } messages, then exactly one terminal
 * { v, jobId, result } or { v, jobId, error }. The jobId is echoed verbatim so
 * the service can drop a reply that belongs to a superseded/cancelled request.
 * A protocol-version mismatch is reported rather than acted on.
 *
 * Progress is intentionally not a provisional result:
 *   { phase, completedRoots, totalRoots, elapsedMs }
 * contains no score or PV. Checkpoints are validated and time-throttled here;
 * phase transitions and a phase's truthful completion are always delivered.
 *
 * The worker URL carries the page's release token; forward it so the
 * rules, loader, WASM binary and analysis contract all come from the SAME
 * release (the service worker caches each release's assets under distinct
 * keys). The Rust module is fetched and instantiated once per worker.
 */
importScripts(
  'engine.js' + self.location.search,
  'wasm-engine.js' + self.location.search,
  'analysis-core.js' + self.location.search);

var PROTOCOL = 2;
var PROGRESS_THROTTLE_MS = 100;
var wasmLoad = null;

function loadWasmEngine() {
  if (!wasmLoad) {
    wasmLoad = fetch('chessy-ai-fast.wasm' + self.location.search)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('wasm fetch failed: ' + response.status);
        }
        return response.arrayBuffer();
      })
      .then(function (bytes) { return WasmEngine.load(bytes); });
  }
  return wasmLoad;
}

function finiteNonNegative(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function integerNonNegative(n) {
  return finiteNonNegative(n) && Math.floor(n) === n;
}

function validProgress(p) {
  if (!p || (p.phase !== 'initial-scan' && p.phase !== 'root-verification') ||
      !integerNonNegative(p.completedRoots) ||
      !integerNonNegative(p.totalRoots) ||
      p.completedRoots > p.totalRoots ||
      !finiteNonNegative(p.elapsedMs)) return false;
  if (p.phase === 'initial-scan') {
    return p.totalRoots === 1 && p.completedRoots <= 1;
  }
  return p.totalRoots > 0;
}

function progressReporter(jobId, elapsedOffsetMs) {
  var observed = null, sent = null;
  var offset = finiteNonNegative(elapsedOffsetMs) ? elapsedOffsetMs : 0;
  function phaseOrder(phase) { return phase === 'initial-scan' ? 0 : 1; }

  return function (p) {
    if (!validProgress(p)) return;
    var event = {
      phase: p.phase,
      completedRoots: p.completedRoots,
      totalRoots: p.totalRoots,
      elapsedMs: Math.max(0, Math.floor(offset + p.elapsedMs))
    };

    // Reject any core callback that moves backwards or changes the declared
    // total inside one phase. This is a transport boundary, not blind trust.
    if (observed) {
      var prevOrder = phaseOrder(observed.phase);
      var nextOrder = phaseOrder(event.phase);
      if (nextOrder < prevOrder || event.elapsedMs < observed.elapsedMs) return;
      if (nextOrder === prevOrder &&
          (event.totalRoots !== observed.totalRoots ||
           event.completedRoots < observed.completedRoots)) return;
    }
    observed = event;

    var phaseChanged = !sent || sent.phase !== event.phase;
    var phaseComplete = event.completedRoots === event.totalRoots;
    var throttleElapsed = !sent ||
      event.elapsedMs - sent.elapsedMs >= PROGRESS_THROTTLE_MS;
    if (!phaseChanged && !phaseComplete && !throttleElapsed) return;

    sent = event;
    self.postMessage({ v: PROTOCOL, jobId: jobId, progress: event });
  };
}

self.onmessage = function (e) {
  var msg = e.data || {};
  var jobId = msg.jobId;
  if (msg.v !== PROTOCOL) {
    self.postMessage({ v: PROTOCOL, jobId: jobId, error: 'protocol-version' });
    return;
  }
  if (!Number.isInteger(jobId) || jobId <= 0) {
    self.postMessage({ v: PROTOCOL, jobId: jobId, error: 'job-identity' });
    return;
  }
  loadWasmEngine().then(function (engine) {
    var state = Chess.parseFen(msg.fen);
    // The repetition table travels explicitly in opts.positions; analyse()
    // resolves opts.positions || state.positions, so a completed threefold is
    // terminal and deep lines see the draws in the game's history.
    var opts = Object.assign({}, msg.opts || {});
    if (msg.positions) opts = Object.assign({}, opts, { positions: msg.positions });
    opts.onProgress = progressReporter(jobId, msg.elapsedOffsetMs);
    var result = ChessyAnalysisCore.analyse(state, opts, engine);
    self.postMessage({ v: PROTOCOL, jobId: jobId, result: result });
  }).catch(function (err) {
    self.postMessage({ v: PROTOCOL, jobId: jobId, error: String(err && err.message || err) });
  });
};
