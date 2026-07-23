/*
 * Coaching-analysis service (Phase 3a) — the transport, cancellation,
 * watchdog and persistence layer between the app and the analysis contract.
 * It is deliberately NARROW: it owns one dedicated coaching worker (separate
 * from opponent play), runs ONE interactive job at a time, caches validated
 * results in IndexedDB, and never runs the heavy search on the main thread.
 *
 * Guarantees:
 *   - One active interactive job. A newer analyse() SUPERSEDES the previous
 *     one: the busy worker is TERMINATED (the only way to cancel a running
 *     search) and the abandoned promise resolves null so its caller discards it.
 *   - Stale replies are ignored. Every reply must carry the current protocol
 *     version and the active job's id; anything else (a late reply from a
 *     superseded request, a foreign message) is dropped.
 *   - The watchdog is DERIVED FROM THE WORKLOAD, not a fixed play-probe budget:
 *     the contract can search millions of nodes, so the deadline scales with
 *     scanNodes + the deep/shallow node budgets and is generous enough that a
 *     healthy-but-slow phone finishes rather than being killed. A wedged or
 *     crashed worker is retried ONCE in a fresh worker, then the probe resolves
 *     gracefully (null). There is NO synchronous main-thread fallback.
 *   - Cache identity folds game revision, ply, the halfmove-and-repetition-aware
 *     position fingerprint, the engine version and the config hash. A stored
 *     result is persisted only when it VALIDATES against the originating
 *     request (same fingerprint, config and side to move); complete AND partial
 *     (complete:false) results are stored, with the completeness flag preserved.
 *
 * A request is { gameId, ply, gameRev, fen, positions, opts }. analyse()
 * resolves with the analysis contract, or null (superseded/cancelled, no worker
 * available, or an unrecoverable worker). The heavy ChessyAnalysisCore.analyse
 * runs ONLY inside the worker — this module calls only the pure identity() to
 * compute the cache key before dispatch.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessyAnalysisCore === 'undefined') return;

  var PROTOCOL = 1;            // must match assets/analysis-worker.js
  var MAX_ATTEMPTS = 2;        // initial worker + one fresh-worker retry
  var DEFAULT_WATCHDOG_MS = 20000;

  var worker = null;
  var active = null;
  var seq = 0;
  var dispatches = 0;         // worker postMessages (tests assert cache hits skip these)

  function nowMs() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }

  // The watchdog rescues only a genuinely WEDGED worker, so it sits above
  // realistic completion. The contract self-bounds at scanNodes (the scan) plus
  // the deep and shallow verification budgets, so worst-case runtime is bounded;
  // dividing that node ceiling by a deliberately CONSERVATIVE slow-device rate
  // yields a deadline a healthy slow phone beats. Overridable to a tiny value so
  // a test can exercise the timeout path without a multi-second wait.
  //
  // SLOW_NPS is empirically grounded and sized for the SLOWEST device we mean to
  // support, not an average: a hard midgame (Kiwipete) measured ~78k nodes/s on
  // a fast x86 CI runner under Chromium; WebKit and older phones run this
  // hand-written JS search roughly 2-4x slower, so the slowest supported rate is
  // ~78k / 4 ≈ 19.5k nps. The assumed rate is set at 18k (below that, for
  // margin) so a healthy-but-slow phone that legitimately needs the full node
  // budget completes before the deadline rather than being killed mid-search,
  // retried, and finally failing. Erring long here only delays detection of a
  // truly wedged worker (a background coaching probe, not a live move), which is
  // the safe direction to err.
  function watchdogMs(opts) {
    var override = global.CHESSY_ANALYSIS_WATCHDOG_MS;
    if (typeof override === 'number' && override > 0) return override;
    var scanNodes = (opts && opts.nodeLimit) || 150000;
    var nodeBudget = (opts && opts.nodeBudget) || 8000000;
    var workNodes = scanNodes + 2 * nodeBudget; // scan + deep-verify + shallow-verify
    var SLOW_NPS = 18000;                         // ≤ slowest supported rate (78k ÷ 4 ≈ 19.5k), with margin
    var ms = Math.ceil(workNodes / SLOW_NPS * 1000) + 5000; // + fixed startup slack
    return Math.min(Math.max(ms, DEFAULT_WATCHDOG_MS), 300000);
  }

  function buildOpts(req) {
    var opts = Object.assign({}, req.opts || {});
    if (req.positions) opts.positions = req.positions;
    return opts;
  }

  function keyFor(req, ident) {
    if (!global.CoachStore || !global.CoachStore.analysisKey) return null;
    return global.CoachStore.analysisKey(
      req.gameId, req.ply, ident.positionFingerprint, ident.engineId, ident.configHash);
  }

  // A reply is trustworthy only if it describes the SAME position/config/turn
  // the request asked about — a last guard against a mismatched or corrupt
  // result being cached or shown.
  function validMatch(result, job) {
    return !!result && !!result.engine &&
      result.engine.configHash === job.ident.configHash &&
      result.positionFingerprint === job.ident.positionFingerprint &&
      result.turn === job.state.turn;
  }

  function clearWatch(job) { if (job.watchdog) { clearTimeout(job.watchdog); job.watchdog = null; } }

  function settle(job, value) {
    if (job.done) return;
    job.done = true;
    clearWatch(job);
    if (active === job) active = null;
    job.resolve(value);
  }

  // Kill the in-flight job outright (supersede/cancel/navigation/game revision):
  // stop the worker burning its budget and resolve the abandoned promise null.
  function abandon() {
    if (!active) return;
    var job = active;
    if (worker) { worker.terminate(); worker = null; }
    settle(job, null);
  }

  function ensureWorker() {
    if (worker) return worker;
    var factory = global.CHESSY_ANALYSIS_WORKER_FACTORY;
    try {
      if (typeof factory === 'function') {
        worker = factory();
      } else if (typeof Worker !== 'undefined') {
        worker = new Worker('assets/analysis-worker.js' +
          (global.CHESSY_RELEASE ? '?r=' + global.CHESSY_RELEASE : ''));
      } else {
        return null;
      }
    } catch (e) { worker = null; return null; }
    worker.onmessage = function (e) { onReply(e.data); };
    worker.onerror = function () {
      if (worker) { worker.terminate(); worker = null; }
      if (active) recover(active);
    };
    return worker;
  }

  function onReply(msg) {
    var job = active;
    if (!job || job.done) return;
    // Drop foreign / superseded / wrong-protocol replies.
    if (!msg || msg.v !== PROTOCOL || msg.jobId !== job.id) return;
    clearWatch(job);
    if (msg.error) { recover(job); return; }   // worker-side failure → retry/give up
    var result = msg.result;
    if (!validMatch(result, job)) { settle(job, null); return; }
    persist(job, result);                       // best-effort; complete + partial
    settle(job, result);
  }

  // A wedged worker (watchdog) or a crashed one (onerror / error reply): retry
  // ONCE in a fresh worker, then give up gracefully. Guarded so a supersede or
  // cancel that already settled this job wins the race. Never falls back to the
  // main thread.
  function recover(job) {
    if (job !== active || job.done) return;
    clearWatch(job);
    if (worker) { worker.terminate(); worker = null; }
    dispatch(job);
  }

  function dispatch(job) {
    if (job !== active || job.done) return;
    if (worker) { worker.terminate(); worker = null; }
    if (job.attempts >= MAX_ATTEMPTS || !ensureWorker()) { settle(job, null); return; }
    job.attempts++;
    job.watchdog = setTimeout(function () { recover(job); }, watchdogMs(job.opts));
    dispatches++;
    worker.postMessage({
      v: PROTOCOL, jobId: job.id, fen: job.req.fen,
      positions: job.req.positions || undefined, opts: job.opts
    });
  }

  function persist(job, result) {
    var store = global.CoachStore;
    if (!store || !store.putAnalysis || !job.key) return;
    var rec = {
      key: job.key, gameId: job.req.gameId, ply: job.req.ply,
      gameRev: job.req.gameRev,
      fingerprint: job.ident.positionFingerprint,
      engineId: job.ident.engineId, configHash: job.ident.configHash,
      complete: result.complete !== false, // partial results are stored, flagged
      result: result, createdAt: nowMs()
    };
    try {
      var p = store.putAnalysis(rec);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* cache write is best-effort */ }
  }

  function run(job) {
    // Compute the pure cache identity on the main thread (parsing a FEN and
    // hashing are trivial — this is NOT the heavy search).
    try {
      job.state = Chess.parseFen(job.req.fen);
      job.opts = buildOpts(job.req);
      job.ident = ChessyAnalysisCore.identity(job.state, job.opts);
      job.key = keyFor(job.req, job.ident);
    } catch (e) { settle(job, null); return; }

    var store = global.CoachStore;
    if (store && store.getAnalysis && job.key) {
      var lookup;
      try { lookup = store.getAnalysis(job.key); } catch (e) { lookup = null; }
      if (lookup && typeof lookup.then === 'function') {
        lookup.then(function (rec) {
          if (job !== active || job.done) return;          // superseded during lookup
          if (rec && rec.gameRev === job.req.gameRev && rec.result) {
            settle(job, rec.result);                        // fresh cache hit
          } else {
            dispatch(job);
          }
        }, function () { if (job === active && !job.done) dispatch(job); });
        return;
      }
    }
    dispatch(job);
  }

  // Start (or supersede) the single interactive analysis. Resolves with the
  // analysis contract, or null when superseded/cancelled or no worker could run.
  function analyse(req) {
    abandon(); // one active job: kill any predecessor before starting
    var job = { id: ++seq, req: req || {}, attempts: 0, done: false, watchdog: null };
    return new Promise(function (resolve) {
      job.resolve = resolve;
      active = job;
      run(job);
    });
  }

  // Abandon the in-flight analysis (leaving Review, navigating, or the game
  // being revised): terminate the worker and resolve its promise null.
  function cancel() { abandon(); }

  function stats() { return { dispatches: dispatches }; }

  global.ChessyAnalysisService = {
    analyse: analyse,
    cancel: cancel,
    stats: stats,
    PROTOCOL: PROTOCOL
  };
})(typeof window !== 'undefined' ? window : globalThis);
