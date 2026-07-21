/*
 * Chessy analysis — ONE bounded engine request at a time, in its own
 * worker so a live Play search is never disturbed. There is deliberately
 * no queue: the only caller is the reflection flow, whose Verify button
 * disables while a request is in flight. A NEW request supersedes an
 * abandoned one — the busy worker is terminated (nothing left occupying
 * it) and the old promise resolves null so its caller discards it. A wedged
 * or crashed worker is retried once in a FRESH worker; if that also fails the
 * probe resolves gracefully (null). The search NEVER runs on the main thread,
 * so verification can neither hang nor freeze the UI.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessAI === 'undefined') return;

  // A FIXED NODE BUDGET — not a wall-clock deadline — is what makes Verify
  // deterministic. The search evaluates exactly nodeLimit nodes, so it
  // completes the same depth and returns the same move/score on every device
  // and under any worker scheduling or load; a re-run cannot save a different
  // verdict for an unchanged position. (randomize:false removes the only other
  // source of run-to-run variation, the root shuffle.) A timeMs budget would
  // reintroduce exactly the nondeterminism we are avoiding: a faster or
  // less-loaded run could finish an extra depth and prefer a different move.
  const CFG = { maxDepth: 30, nodeLimit: 150000, quiesce: true, randomize: false };
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
      worker = new Worker('assets/ai-worker.js' +
        (global.CHESSY_RELEASE ? '?r=' + global.CHESSY_RELEASE : ''));
    } catch (e) { return null; }
    worker.onmessage = function (e) {
      if (active && e.data.id === active.id) settle(active, e.data);
    };
    worker.onerror = function () {
      if (worker) { worker.terminate(); worker = null; }
      if (active) active.recover();
    };
    return worker;
  }

  // `positions` is the game's repetition table up to this position — the
  // engine needs it to score a move that completes a repetition as the
  // draw it is. Resolves with {move, depth, score}, or null when a newer
  // request superseded this one, when no Web Worker is available, or when a
  // wedged/crashed worker could not be recovered.
  function analyse(fen, positions) {
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
          maxDepth: CFG.maxDepth, nodeLimit: CFG.nodeLimit, quiesce: CFG.quiesce,
          randomize: CFG.randomize
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
