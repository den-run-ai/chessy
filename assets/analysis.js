/*
 * Chessy analysis — ONE bounded engine request at a time, in its own
 * worker so a live Play search is never disturbed. There is deliberately
 * no queue: the only caller is the reflection flow, whose Verify button
 * disables while a request is in flight. A NEW request supersedes an
 * abandoned one — the busy worker is terminated (nothing left occupying
 * it) and the old promise resolves null so its caller discards it. A
 * watchdog terminates an alive-but-silent worker and answers with the
 * synchronous search, so verification can never hang.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessAI === 'undefined') return;

  // randomize:false makes Verify deterministic: the same position always
  // yields the same probe move/score, so a re-run cannot save a different
  // verdict for an unchanged position (the root shuffle is the only source
  // of run-to-run variation in the search).
  const CFG = { maxDepth: 30, timeMs: 1200, quiesce: true, randomize: false };

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
      if (active) active.fallback();
    };
    return worker;
  }

  // `positions` is the game's repetition table up to this position — the
  // engine needs it to score a move that completes a repetition as the
  // draw it is. Resolves with {move, depth, score}, or null when a newer
  // request superseded this one.
  function analyse(fen, positions) {
    if (active) {
      // The previous request was abandoned (its moment was left) — kill
      // its search instead of letting it finish underneath the new one.
      if (worker) { worker.terminate(); worker = null; }
      settle(active, null);
    }
    return new Promise(function (resolve) {
      const job = { id: ++seq, resolve: resolve };
      active = job;
      job.fallback = function () {
        // A canceled or superseded job must not burn the synchronous
        // search budget on the main thread — its result would be
        // discarded, and the freeze would hit whatever view the user
        // moved on to.
        if (active !== job) return;
        settle(job, ChessAI.think(Chess.parseFen(fen),
          Object.assign({}, CFG, { positions: positions || undefined })));
      };
      // The zero-delay fallback registers as the job's watchdog so a
      // cancel/supersede clears the pending timer as well.
      if (!ensureWorker()) { job.watchdog = setTimeout(job.fallback, 0); return; }
      job.watchdog = setTimeout(function () {
        if (worker) { worker.terminate(); worker = null; }
        job.fallback();
      }, CFG.timeMs + 4000);
      worker.postMessage({
        id: job.id, fen: fen, positions: positions || undefined,
        maxDepth: CFG.maxDepth, timeMs: CFG.timeMs, quiesce: CFG.quiesce,
        randomize: CFG.randomize
      });
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
