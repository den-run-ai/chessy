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
 *   - Stale replies are ignored. Every reply must come from the current Worker
 *     instance and carry the current protocol version and active job id;
 *     anything else (a late superseded/retried attempt, a foreign message) is
 *     dropped.
 *   - Progress is an exclusive NON-TERMINAL protocol message. It is validated,
 *     monotonic across retries, forwarded only to subscribers matching the
 *     active job's owner, and never clears or extends the watchdog. It carries
 *     no scores/PVs and is never cached.
 *   - The watchdog is DERIVED FROM THE WORKLOAD, not a fixed play-probe budget:
 *     the contract can search millions of nodes, so the deadline scales with
 *     scanNodes + the deep/shallow node budgets and is generous enough that a
 *     healthy-but-slow phone finishes rather than being killed. A wedged or
 *     crashed worker is retried ONCE in a fresh worker, then the probe resolves
 *     gracefully (null). There is NO synchronous main-thread fallback.
 *   - Cache identity folds game revision, ply, the halfmove-and-repetition-aware
 *     position fingerprint, the engine version and the config hash. A stored
 *     result is persisted only when it VALIDATES against the originating
 *     request (same engine identity, fingerprint, config and side to move) and
 *     must re-pass the same validation when SERVED back, so a corrupted or
 *     mismatched record is recomputed rather than published; complete AND
 *     partial (complete:false) results are stored, with the completeness flag
 *     preserved.
 *
 * A request is { gameId, ply, gameRev, fen, positions, opts }. analyse(req,
 * owner?) accepts an optional subsystem owner; cancel(owner) then abandons
 * only that owner's job, while cancel() remains the global teardown.
 * analyse()
 * resolves with the analysis contract, or null (superseded/cancelled, no worker
 * available, or an unrecoverable worker). The heavy ChessyAnalysisCore.analyse
 * runs ONLY inside the worker — this module calls only the pure identity() to
 * compute the cache key before dispatch.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessyAnalysisCore === 'undefined') return;

  var PROTOCOL = 2;            // must match assets/analysis-worker.js
  var MAX_ATTEMPTS = 2;        // initial worker + one fresh-worker retry
  var DEFAULT_WATCHDOG_MS = 20000;

  var worker = null;
  var active = null;
  var seq = 0;
  var dispatches = 0;         // worker postMessages (tests assert cache hits skip these)
  var subscribers = [];
  // A tiny process-local cache closes the handoff between a scan result and an
  // immediately opened reflection without making analysis completion depend on
  // IndexedDB. A storage write is best-effort and, under a broken adapter, may
  // never settle; keeping the validated result here lets the next identical
  // request reuse it while the persistent write remains non-blocking.
  var recent = new Map();
  var RECENT_CAP = 16;
  // Cache mutations for one identity are ordered without blocking analysis
  // delivery. In particular, invalidate(key) must run AFTER any already-started
  // best-effort put for that key; otherwise a delayed put can land after the
  // delete and resurrect a result the user explicitly cancelled. A later fresh
  // put queues after that delete, so cancellation cannot erase its successor.
  var cacheOps = new Map();

  function nowMs() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }

  // The watchdog rescues only a genuinely WEDGED worker, so it sits above
  // realistic completion. The contract self-bounds at scanNodes (the scan) plus
  // the deep and shallow verification budgets, so worst-case runtime is bounded;
  // dividing that node ceiling by a deliberately CONSERVATIVE slow-device rate
  // yields a deadline a healthy slow phone beats. Overridable to a tiny value so
  // a test can exercise the timeout path without a multi-second wait.
  //
  // The 18k-NPS floor is deliberately far below the hosted Rust/WASM
  // measurements and retained as a conservative slow-device allowance, not a
  // performance claim. A healthy device that legitimately needs the full node
  // budget should finish before the deadline rather than being killed,
  // retried, and finally failing. Erring long here only delays detection of a
  // truly wedged background coaching worker, which is the safe direction.
  function watchdogMs(opts) {
    var override = global.CHESSY_ANALYSIS_WATCHDOG_MS;
    if (typeof override === 'number' && override > 0) return override;
    var scanNodes = (opts && opts.nodeLimit) || 150000;
    var nodeBudget = (opts && opts.nodeBudget) || 8000000;
    var workNodes = scanNodes + 2 * nodeBudget; // scan + deep-verify + shallow-verify
    var SLOW_NPS = 18000;                         // conservative Rust/WASM floor
    var ms = Math.ceil(workNodes / SLOW_NPS * 1000) + 5000; // + fixed startup slack
    return Math.min(Math.max(ms, DEFAULT_WATCHDOG_MS), 300000);
  }

  function buildOpts(req) {
    var opts = Object.assign({}, req.opts || {});
    // Direct core callers may observe opts.onProgress, but service callers use
    // subscribe(owner, listener). A main-thread function cannot be cloned into
    // a Worker and must never become part of the cache/transport payload.
    delete opts.onProgress;
    if (req.positions) opts.positions = req.positions;
    return opts;
  }

  function keyFor(req, ident) {
    if (!global.CoachStore || !global.CoachStore.analysisKey) return null;
    return global.CoachStore.analysisKey(
      req.gameId, req.ply, ident.positionFingerprint, ident.engineId, ident.configHash);
  }

  function remember(job, result) {
    if (!job.key) return;
    recent.delete(job.key);
    recent.set(job.key, { gameRev: job.req.gameRev, result: result });
    while (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value);
  }

  function enqueueCacheOp(key, op) {
    var before = cacheOps.get(key);
    // Every mutation is best effort. Swallow a predecessor's adapter failure
    // before attempting the next operation, and swallow this operation's too,
    // while preserving the per-key ordering chain.
    function attempt() {
      try { return Promise.resolve(op()).catch(function () {}); }
      catch (e) { return Promise.resolve(); }
    }
    // Keep the historical fast path: when no mutation is pending, invoke the
    // adapter now (putAnalysis may synchronously populate an in-memory store)
    // while still tracking its async completion. Only contended identities
    // need to wait on a predecessor.
    var current = before
      ? before.catch(function () {}).then(attempt)
      : attempt();
    cacheOps.set(key, current);
    current.then(function () {
      if (cacheOps.get(key) === current) cacheOps.delete(key);
    });
    return current;
  }

  // A reply is trustworthy only if it describes the SAME engine identity,
  // position, config and turn the request asked about — a last guard against a
  // mismatched or corrupt result being cached or shown. The engine id/version
  // legs matter for SERVED cache rows: an honest result from another engine
  // build keys a different configHash, but a corrupted payload can lie in its
  // provenance fields while keeping the expected hash, and the full
  // ChessyAnalysisResult.validate boundary downstream requires id/version to
  // match the computed identity too.
  function validMatch(result, job) {
    return !!result && !!result.engine &&
      result.engine.id === job.ident.engineId &&
      result.engine.version === job.ident.version &&
      result.engine.configHash === job.ident.configHash &&
      result.positionFingerprint === job.ident.positionFingerprint &&
      result.turn === job.state.turn;
  }

  function clearWatch(job) { if (job.watchdog) { clearTimeout(job.watchdog); job.watchdog = null; } }

  function finiteInteger(n) {
    return typeof n === 'number' && Number.isFinite(n) &&
      n >= 0 && Math.floor(n) === n;
  }

  function phaseOrder(phase) {
    return phase === 'initial-scan' ? 0 :
      phase === 'root-verification' ? 1 : -1;
  }

  // Validate progress independently from the worker. Exact payload keys keep
  // provisional scores/PVs from crossing this boundary by accident.
  function progressEvent(msg, job) {
    var p = msg && msg.progress;
    if (!p || Object.keys(p).sort().join(',') !==
        'completedRoots,elapsedMs,phase,totalRoots' ||
        phaseOrder(p.phase) < 0 ||
        !finiteInteger(p.completedRoots) ||
        !finiteInteger(p.totalRoots) ||
        !finiteInteger(p.elapsedMs) ||
        p.completedRoots > p.totalRoots) return null;
    if (p.phase === 'initial-scan') {
      if (p.totalRoots !== 1 || p.completedRoots > 1) return null;
    } else if (p.totalRoots < 1) {
      return null;
    }

    var event = {
      jobId: job.id,
      owner: job.owner,
      phase: p.phase,
      completedRoots: p.completedRoots,
      totalRoots: p.totalRoots,
      elapsedMs: p.elapsedMs
    };

    // Each attempt must be internally monotonic. A retry gets a fresh
    // attemptProgress, but public progress below retains the prior high-water.
    var attempt = job.attemptProgress;
    if (attempt) {
      var attemptPrevOrder = phaseOrder(attempt.phase);
      var attemptNextOrder = phaseOrder(event.phase);
      if (attemptNextOrder < attemptPrevOrder ||
          event.elapsedMs < attempt.elapsedMs ||
          (attemptNextOrder === attemptPrevOrder &&
           (event.totalRoots !== attempt.totalRoots ||
            event.completedRoots < attempt.completedRoots))) return null;
    }
    job.attemptProgress = event;

    // A retry truthfully starts its own scan at zero, but publishing that reset
    // would move the user-visible job backwards. Suppress it until the fresh
    // attempt catches the prior phase/root high-water; never fabricate counts.
    var published = job.publishedProgress;
    if (published) {
      var prevOrder = phaseOrder(published.phase);
      var nextOrder = phaseOrder(event.phase);
      if (nextOrder < prevOrder || event.elapsedMs < published.elapsedMs) return null;
      if (nextOrder === prevOrder) {
        if (event.totalRoots !== published.totalRoots ||
            event.completedRoots < published.completedRoots) return null;
        if (event.completedRoots === published.completedRoots &&
            event.elapsedMs === published.elapsedMs) return null;
      }
    }
    return event;
  }

  function publishProgress(job, event) {
    if (!event || job !== active || job.done) return;
    job.publishedProgress = event;
    // Snapshot the list so listeners may safely unsubscribe. Re-check active
    // ownership before each call: an earlier listener may cancel/supersede.
    subscribers.slice().forEach(function (sub) {
      if (job !== active || job.done || sub.owner !== job.owner ||
          subscribers.indexOf(sub) < 0) return;
      try { sub.listener(Object.assign({}, event)); } catch (e) {
        // Observation-only: a broken listener cannot affect the worker job.
      }
    });
  }

  function settle(job, value) {
    if (job.done) return;
    job.done = true;
    clearWatch(job);
    if (active === job) active = null;
    job.resolve(value);
  }

  // Kill the in-flight job outright (supersede/cancel/navigation/game revision):
  // stop the worker burning its budget and resolve the abandoned promise null.
  function abandon(owner) {
    if (!active) return;
    // A subsystem may relinquish only the work it owns. This matters when a
    // reflection has just superseded a background moment scan: the scan's
    // delayed pause callback must not terminate the newer interactive job.
    // No owner keeps the historic/global behavior used by destructive data
    // controls and legacy callers.
    if (arguments.length && active.owner !== owner) return;
    var job = active;
    if (worker) { worker.terminate(); worker = null; }
    settle(job, null);
  }

  function ensureWorker(job) {
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
    // Bind callbacks to this exact worker/job. A queued event from a worker
    // terminated during supersede/retry must never act through the global
    // `worker` reference and kill, settle, or consume a retry for its successor.
    var instance = worker;
    instance.onmessage = function (e) {
      if (worker !== instance || active !== job || job.done) return;
      onReply(e.data);
    };
    instance.onerror = function () {
      if (worker !== instance || active !== job || job.done) return;
      instance.terminate();
      worker = null;
      recover(job);
    };
    return instance;
  }

  function onReply(msg) {
    var job = active;
    if (!job || job.done) return;
    // Drop foreign / superseded / wrong-protocol replies.
    if (!msg || msg.v !== PROTOCOL || msg.jobId !== job.id) return;
    var hasProgress = Object.prototype.hasOwnProperty.call(msg, 'progress');
    var hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
    var hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
    if (hasProgress) {
      // Progress is exclusive and non-terminal. In particular, do NOT
      // clear/re-arm the watchdog here: chatter cannot keep a wedged job alive.
      if (hasResult || hasError) return;
      publishProgress(job, progressEvent(msg, job));
      return;
    }
    // Result/error are the only terminal message shapes. Malformed chatter is
    // ignored while the original watchdog continues to bound the attempt.
    if (hasResult === hasError) return;
    if (hasError && (typeof msg.error !== 'string' || !msg.error)) return;
    clearWatch(job);
    if (hasError) { recover(job); return; }   // worker-side failure → retry/give up
    var result = msg.result;
    if (!validMatch(result, job)) { settle(job, null); return; }
    // Publish from a bounded in-memory handoff, then persist without blocking
    // the analysis lane. The next identical request can reuse `recent` even if
    // IndexedDB is slow, rejected, or never settles.
    remember(job, result);
    persist(job, result);
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
    if (job.attempts >= MAX_ATTEMPTS || !ensureWorker(job)) { settle(job, null); return; }
    job.attempts++;
    job.attemptProgress = null;
    job.watchdog = setTimeout(function () { recover(job); }, watchdogMs(job.opts));
    dispatches++;
    var elapsedOffset = Math.max(0, nowMs() - job.startedAt);
    if (job.publishedProgress) {
      elapsedOffset = Math.max(elapsedOffset, job.publishedProgress.elapsedMs);
    }
    worker.postMessage({
      v: PROTOCOL, jobId: job.id, fen: job.req.fen,
      positions: job.req.positions || undefined, opts: job.opts,
      elapsedOffsetMs: elapsedOffset
    });
  }

  function persist(job, result) {
    var store = global.CoachStore;
    if (!store || !store.putAnalysis || !job.key) return Promise.resolve();
    var at = nowMs();
    var rec = {
      key: job.key, gameId: job.req.gameId, ply: job.req.ply,
      gameRev: job.req.gameRev,
      fingerprint: job.ident.positionFingerprint,
      engineId: job.ident.engineId, configHash: job.ident.configHash,
      complete: result.complete !== false, // partial results are stored, flagged
      result: result, createdAt: at,
      // Recency for the bounded-cache policy (#82): stamped on write and
      // refreshed on validated reuse, so LRU pruning has an honest order.
      usedAt: at
    };
    var put = enqueueCacheOp(job.key, function () { return store.putAnalysis(rec); });
    // Bounded-cache maintenance (#82) runs strictly AFTER the put settles and
    // in its own store transaction: the fresh result commits (or fails) on
    // its own, and a pruning failure can neither abort that write nor reach
    // this job. protectKey pins the record just written even against a
    // skewed clock stamping it older than the survivors.
    if (store.maintainAnalysesCache) {
      put.then(function () {
        try {
          Promise.resolve(store.maintainAnalysesCache({ protectKey: job.key }))
            .catch(function () {});
        } catch (e) { /* best effort */ }
      });
    }
    return put;
  }

  // Refresh a stored entry's recency after a validated cache reuse so LRU
  // pruning ranks entries by actual usefulness. Ordered per key behind any
  // in-flight put/delete for the same identity; failures never reach the
  // served result.
  function touchUsed(key) {
    var store = global.CoachStore;
    if (!store || !store.touchAnalysis || !key) return;
    enqueueCacheOp(key, function () { return store.touchAnalysis(key); });
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

    var hot = !job.req.fresh && job.key && recent.get(job.key);
    if (hot && hot.gameRev === job.req.gameRev) {
      // The in-memory handoff mirrors a persisted entry; keep that entry's
      // recency truthful so a hot identity is not pruned as cold.
      touchUsed(job.key);
      settle(job, hot.result);
      return;
    }

    // req.fresh bypasses the cache read entirely: the reflection layer sets it
    // on a retry after it rejected a served result as unusable, so the retry
    // ALWAYS dispatches a fresh worker run (and its result overwrites the bad
    // entry via persist) rather than racing a not-yet-committed eviction.
    var store = global.CoachStore;
    if (!job.req.fresh && store && store.getAnalysis && job.key) {
      var lookup;
      try { lookup = store.getAnalysis(job.key); } catch (e) { lookup = null; }
      if (lookup && typeof lookup.then === 'function') {
        lookup.then(function (rec) {
          if (job !== active || job.done) return;          // superseded during lookup
          // A persisted record outlives the session that validated it, so a
          // served payload must re-pass the SAME gate as a live worker reply
          // (validMatch): a corrupted or mismatched row under a correct key is
          // recomputed — and overwritten via persist — never published.
          if (rec && rec.gameRev === job.req.gameRev && rec.result &&
              validMatch(rec.result, job)) {
            touchUsed(job.key);
            settle(job, rec.result);                        // validated fresh cache hit
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
  function analyse(req, owner) {
    abandon(); // one active job: kill any predecessor before starting
    var job = {
      id: ++seq, req: req || {}, owner: owner || null,
      attempts: 0, done: false, watchdog: null,
      startedAt: nowMs(), attemptProgress: null, publishedProgress: null
    };
    return new Promise(function (resolve) {
      job.resolve = resolve;
      active = job;
      run(job);
    });
  }

  // Abandon the in-flight analysis (leaving Review, navigating, or the game
  // being revised): terminate the worker and resolve its promise null.
  function cancel(owner) {
    if (arguments.length) abandon(owner || null);
    else abandon();
  }

  // Subscribe to progress owned by one subsystem. There is deliberately no
  // wildcard: a listener can observe only the currently active job whose
  // owner exactly matches its subscription. Returns an idempotent unsubscribe.
  function subscribe(owner, listener) {
    if (typeof listener !== 'function') return function () {};
    var sub = { owner: owner || null, listener: listener };
    var closed = false;
    subscribers.push(sub);
    return function () {
      if (closed) return;
      closed = true;
      var i = subscribers.indexOf(sub);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  // Evict the cached result for a request. The service caches any reply that
  // matches the request's position/config/turn, but the reflection layer
  // applies stricter rules it cannot (every candidate legal + SAN-verified);
  // when it rejects a served result as unusable it calls this so the NEXT
  // analyse() for the same request misses the cache and dispatches a fresh
  // worker run rather than serving the same bad entry forever. Recomputes the
  // key exactly as run() does. Best-effort; resolves when the entry is gone.
  function invalidate(req) {
    var store = global.CoachStore;
    if (!req) return Promise.resolve();
    try {
      var state = Chess.parseFen(req.fen);
      var opts = buildOpts(req);
      var ident = ChessyAnalysisCore.identity(state, opts);
      var key = keyFor(req, ident);
      if (!key) return Promise.resolve();
      recent.delete(key);
      if (!store || !store.deleteAnalysis) return Promise.resolve();
      // Queue behind a put that onReply may already have started. This delete
      // therefore remains the terminal mutation for all work accepted before
      // invalidate(), even when that put is intentionally delayed.
      return enqueueCacheOp(key, function () { return store.deleteAnalysis(key); });
    } catch (e) { return Promise.resolve(); }
  }

  function stats() { return { dispatches: dispatches }; }

  global.ChessyAnalysisService = {
    analyse: analyse,
    cancel: cancel,
    subscribe: subscribe,
    invalidate: invalidate,
    stats: stats,
    PROTOCOL: PROTOCOL
  };
})(typeof window !== 'undefined' ? window : globalThis);
