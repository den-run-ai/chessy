/*
 * Chessy analysis — ONE bounded analysis-CONTRACT request at a time, in its
 * own worker (analysis-worker.js) so a live Play search is never disturbed.
 * There is deliberately no queue: the only caller is the reflection flow,
 * whose Verify button disables while a request is in flight. A NEW request
 * supersedes an abandoned one — the busy worker is terminated (nothing left
 * occupying it) and the old promise resolves null so its caller discards it.
 * A wedged or crashed worker is retried once in a FRESH worker; if that also
 * fails the probe resolves gracefully (null). The search NEVER runs on the
 * main thread, so verification can neither hang nor freeze the UI.
 *
 * analyse(fen, positions, opts) resolves the ChessyAnalysisCore contract
 * (bestLines, playedLine, provenance, stability, …) — or null when superseded,
 * when no Web Worker is available, or when a wedged/crashed worker could not
 * be recovered. opts.playedMove ({from,to,promotion}) is scored and ranked.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessAI === 'undefined') return;

  // A FIXED NODE BUDGET — not a wall-clock deadline — is what makes the probe
  // deterministic: the search evaluates exactly nodeLimit nodes, completing
  // the same depth and returning the same contract on every device and under
  // any worker scheduling or load. The contract deep-verifies its candidates
  // at that completed depth under full windows with delta pruning off, bounded
  // by verifyNodeLimit; stability re-scans at a larger fixed budget.
  const CFG = {
    maxDepth: 30, nodeLimit: 150000, multiPV: 3, pvLen: 6,
    verifyNodeLimit: 2000000, stabilityNodeLimit: 300000
  };
  // A FIXED NODE budget is not a fixed WALL-CLOCK cost: 150k nodes is ~1s on a
  // desktop but several seconds on a hard midgame position on a slow phone. The
  // watchdog exists only to rescue a genuinely WEDGED worker, so it sits well
  // above that realistic completion time — a healthy-but-slow worker must be
  // allowed to finish, not killed and (as before) have its entire 150k-node
  // search recomputed synchronously on the main thread, which froze the UI for
  // seconds (~9s measured on Kiwipete). Overridable to a tiny value ONLY so a
  // test can exercise the timeout path without a multi-second wait.
  const DEFAULT_WATCHDOG_MS = 20000;
  function watchdogMs() {
    const o = global.CHESSY_VERIFY_WATCHDOG_MS;
    return typeof o === 'number' && o > 0 ? o : DEFAULT_WATCHDOG_MS;
  }
  const MAX_ATTEMPTS = 2; // initial worker + one fresh-worker retry, then give up

  let worker = null;
  let active = null;
  let seq = 0;

  function settle(job, result) {
    if (active !== job) return;
    active = null;
    clearTimeout(job.watchdog);
    job.resolve(result);
  }

  function ensureWorker() {
    if (worker || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker('assets/analysis-worker.js' +
        (global.CHESSY_RELEASE ? '?r=' + global.CHESSY_RELEASE : ''));
    } catch (e) { return null; }
    worker.onmessage = function (e) {
      if (active && e.data.id === active.id) settle(active, e.data.contract);
    };
    worker.onerror = function () {
      if (worker) { worker.terminate(); worker = null; }
      if (active) active.recover();
    };
    return worker;
  }

  // `positions` is the game's repetition table up to this position — the
  // engine needs it to score a move that completes a repetition as the draw
  // it is. `opts.playedMove` ({from,to,promotion}) is the move actually
  // played, scored and ranked against the candidates. Resolves with the
  // ChessyAnalysisCore contract, or null when a newer request superseded this
  // one, when no Web Worker is available, or when a wedged/crashed worker
  // could not be recovered.
  function analyse(fen, positions, opts) {
    opts = opts || {};
    if (active) {
      // The previous request was abandoned (its moment was left) — kill
      // its search instead of letting it finish underneath the new one.
      if (worker) { worker.terminate(); worker = null; }
      settle(active, null);
    }
    return new Promise(function (resolve) {
      const job = { id: ++seq, resolve: resolve, attempts: 0 };
      active = job;
      // Dispatch the probe to a worker and arm the watchdog. The search is
      // ALWAYS off the main thread: without a Web Worker (or once the retry
      // budget is spent) we resolve null gracefully rather than block the UI.
      function dispatch() {
        if (active !== job) return;
        if (worker) { worker.terminate(); worker = null; }
        if (job.attempts >= MAX_ATTEMPTS || !ensureWorker()) { settle(job, null); return; }
        job.attempts++;
        job.watchdog = setTimeout(job.recover, watchdogMs());
        worker.postMessage({
          id: job.id, fen: fen, positions: positions || undefined,
          playedMove: opts.playedMove || undefined,
          maxDepth: CFG.maxDepth, nodeLimit: CFG.nodeLimit, multiPV: CFG.multiPV,
          pvLen: CFG.pvLen, verifyNodeLimit: CFG.verifyNodeLimit,
          stabilityNodeLimit: CFG.stabilityNodeLimit
        });
      }
      // A wedged worker (watchdog fired) or a crashed one (worker.onerror):
      // retry once in a fresh worker, then give up gracefully. Guarded so a
      // supersede/cancel that already settled this job wins the race.
      job.recover = function () { if (active === job) dispatch(); };
      dispatch();
    });
  }

  // Abandoning the reflection (leaving Review, leaving the game) kills an
  // in-flight probe outright: the worker stops burning the search budget
  // and the caller's promise resolves null so its guards discard it.
  function cancel() {
    if (!active) return;
    if (worker) { worker.terminate(); worker = null; }
    settle(active, null);
  }

  global.ChessyAnalysis = { analyse: analyse, cancel: cancel };
})(typeof window !== 'undefined' ? window : globalThis);
