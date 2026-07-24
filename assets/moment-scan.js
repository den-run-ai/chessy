/*
 * Phase 5 critical-moment scan controller.
 *
 * This module deliberately owns orchestration only. ChessyAnalysisCore owns
 * the engine contract, ChessyAnalysisResult owns the trust boundary, and
 * ChessyMomentSelector owns the deterministic selection policy. The
 * controller contributes the parts that are easy to get subtly wrong:
 *
 *   - one sequential request at a time over the player's non-terminal moves;
 *   - a shallow pass followed by at most two exact reflection-profile checks;
 *   - a durable checkpoint after every completed decision and verification;
 *   - reload-safe pause/resume with the cursor meaning "next ply";
 *   - generation ownership, so a late callback after Restore/Delete all,
 *     navigation, or an explicit pause can never write or repaint;
 *   - sanitized events: pre-reflection UI sees only progress and
 *     { ply, playedSan } suggestions, never scores, labels or better moves.
 *
 * Nothing starts automatically. The Review UI must call start()/resume() in
 * response to an explicit player action.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' ||
      typeof ChessyAnalysisCore === 'undefined' ||
      typeof ChessyAnalysisService === 'undefined' ||
      typeof ChessyAnalysisResult === 'undefined' ||
      typeof ChessyMomentSelector === 'undefined') return;

  var JOB_SCHEMA = 1;
  var ALGORITHM = 'critical-moments-v1';
  var QUICK = {
    maxDepth: 5, nodeLimit: 5000, nodeBudget: 150000, multiPV: 1, pvLen: 3
  };
  var QUICK_FALLBACK = {
    maxDepth: 5, nodeLimit: 12000, nodeBudget: 300000, multiPV: 1, pvLen: 3
  };
  // Kept byte-for-byte aligned with reflection.js. A suggestion click can
  // therefore reuse the already validated deep result from the analysis cache.
  var DEEP = {
    maxDepth: 10, nodeLimit: 80000, nodeBudget: 1200000, multiPV: 3, pvLen: 6
  };

  var generation = 0;
  var current = null;
  var currentSource = null;
  var running = false;
  var OWNER = 'moment-scan';

  function now() {
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  // Shared cache revision for scan and manual reflection. SetUp/FEN is part of
  // the game, so two identical SAN lists from different initial boards must
  // never share a result.
  function analysisRevision(game) {
    return hash(JSON.stringify({
      setupFen: game && game.setupFen || null,
      sans: game && Array.isArray(game.sans) ? game.sans : []
    }));
  }

  // Progress additionally depends on who is being scanned and on exact clock
  // evidence. Changing either must restart selection even though the engine
  // position cache itself remains reusable through analysisRevision().
  function sourceRevision(game, scanColor) {
    return hash(JSON.stringify({
      analysis: analysisRevision(game),
      scanColor: scanColor,
      playerColor: game && game.playerColor || null,
      timeControl: game && game.timeControl || null,
      clocks: game && Array.isArray(game.clocks) ? game.clocks : []
    }));
  }

  function sourceSnapshot(game) {
    return {
      id: game.id,
      setupFen: game.setupFen || null,
      playerColor: game.playerColor || null,
      sans: Array.isArray(game.sans) ? game.sans.slice() : [],
      clocks: Array.isArray(game.clocks)
        ? JSON.parse(JSON.stringify(game.clocks)) : [],
      timeControl: game.timeControl || null
    };
  }

  function scanColorFor(game, requested) {
    var own = game && game.playerColor;
    if (own === 'w' || own === 'b') return own;
    if (own === 'both') return 'both';
    return requested === 'w' || requested === 'b' || requested === 'both'
      ? requested : null;
  }

  function stateTerminal(state) {
    try { return !!Chess.gameStatus(state).over; }
    catch (e) { return true; }
  }

  function eligible(review, ply, scanColor) {
    if (!review || !review.gs || !Array.isArray(review.gs.history) ||
        ply < 0 || ply >= review.gs.history.length) return false;
    var state = review.states && review.states[ply];
    if (!state || stateTerminal(state)) return false;
    return scanColor === 'both' || state.turn === scanColor;
  }

  function countEligible(review, scanColor) {
    var n = review && review.gs && Array.isArray(review.gs.history)
      ? review.gs.history.length : 0;
    var total = 0;
    for (var ply = 0; ply < n; ply++) {
      if (eligible(review, ply, scanColor)) total++;
    }
    return total;
  }

  function exactThinkMs(game, ply) {
    var c = game && Array.isArray(game.clocks) ? game.clocks[ply] : null;
    return c && typeof c.thinkMs === 'number' && isFinite(c.thinkMs) &&
      c.thinkMs >= 0 ? c.thinkMs : null;
  }

  function median(values) {
    values = values.slice().sort(function (a, b) { return a - b; });
    if (!values.length) return null;
    var mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  function typicalThinkMsBySide(review, scanColor) {
    var times = { w: [], b: [] };
    var n = review && review.gs && Array.isArray(review.gs.history)
      ? review.gs.history.length : 0;
    for (var ply = 0; ply < n; ply++) {
      if (!eligible(review, ply, scanColor)) continue;
      var ms = exactThinkMs(review.game, ply);
      if (ms !== null) times[review.states[ply].turn].push(ms);
    }
    return { w: median(times.w), b: median(times.b) };
  }

  function arrays(job) {
    job.candidates = Array.isArray(job.candidates) ? job.candidates : [];
    job.shortlist = Array.isArray(job.shortlist) ? job.shortlist : [];
    job.moments = Array.isArray(job.moments) ? job.moments : [];
    job.unresolved = Array.isArray(job.unresolved) ? job.unresolved : [];
    return job;
  }

  function publicState(job) {
    if (!job) return null;
    return {
      gameId: job.gameId,
      state: job.state,
      pass: job.pass,
      cursorPly: job.cursorPly,
      checked: job.checked,
      total: job.total,
      verifyIndex: job.verifyIndex,
      verifyTotal: Array.isArray(job.shortlist) ? job.shortlist.length : 0,
      moments: (Array.isArray(job.moments) ? job.moments : []).map(function (m) {
        return { ply: m.ply, playedSan: m.playedSan };
      }),
      unresolvedCount: Array.isArray(job.unresolved) ? job.unresolved.length : 0,
      error: typeof job.error === 'string' ? job.error : null
    };
  }

  function emit(job) {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    try {
      document.dispatchEvent(new CustomEvent('chessy:scanchange', {
        detail: publicState(job)
      }));
    } catch (e) { /* a non-DOM test environment may not provide CustomEvent */ }
  }

  function owns(token, job) {
    return token === generation && current === job;
  }

  function stopLocal() {
    generation++;
    running = false;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
  }

  // Guard every checkpoint against the source record in the SAME IndexedDB
  // transaction as the job put. That atomic store seam closes the TOCTOU race
  // where a same-id revision could otherwise commit after getGame() but before
  // putJob(), then receive an orphaned stale checkpoint.
  function checkpoint(token, job) {
    if (!owns(token, job)) return Promise.resolve(false);
    if (!global.CoachStore || !CoachStore.putJob) {
      return pauseForFailure(token, job, 'Archive unavailable — scan paused.');
    }
    job.updatedAt = now();
    if (CoachStore.putJobIfGame) {
      return Promise.resolve(CoachStore.putJobIfGame(job, currentSource))
        .then(function (wrote) {
          if (!owns(token, job)) return false;
          if (!wrote) {
            stopLocal();
            if (current === job) current = null;
            currentSource = null;
            return false;
          }
          emit(job);
          return true;
        }).catch(function () {
          return pauseForFailure(token, job, 'Could not save progress — scan paused.');
        });
    }
    // Compatibility fallback for an intentionally partial test harness.
    if (!CoachStore.getGame) {
      return pauseForFailure(token, job, 'Archive unavailable — scan paused.');
    }
    return Promise.resolve(CoachStore.getGame(job.gameId)).then(function (game) {
      if (!owns(token, job)) return false;
      if (!game || sourceRevision(game, job.scanColor) !== job.sourceRev) {
        stopLocal();
        if (current === job) current = null;
        currentSource = null;
        return false;
      }
      return Promise.resolve(CoachStore.putJob(job)).then(function () {
        if (!owns(token, job)) return false;
        emit(job);
        return true;
      });
    }).catch(function () {
      return pauseForFailure(token, job, 'Could not save progress — scan paused.');
    });
  }

  function pauseForFailure(token, job, message) {
    if (!owns(token, job)) return Promise.resolve(false);
    // Do not attempt another write after a persistence failure. Retain the
    // last durable cursor and require an explicit resume.
    generation++;
    running = false;
    job.state = 'paused';
    job.error = message;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
    emit(job);
    return Promise.resolve(false);
  }

  function moveRequest(review, job, ply, profile, fresh) {
    var entry = review.gs.history[ply];
    var state = review.states[ply];
    return {
      gameId: job.gameId,
      ply: ply,
      gameRev: job.analysisRev,
      fen: review.fens[ply],
      positions: state.positions,
      fresh: !!fresh,
      opts: {
        playedMove: entry.move,
        maxDepth: profile.maxDepth,
        nodeLimit: profile.nodeLimit,
        nodeBudget: profile.nodeBudget,
        multiPV: profile.multiPV,
        pvLen: profile.pvLen
      }
    };
  }

  function expectedFor(state, req, requirePlayed, minDepth) {
    var opts = Object.assign({}, req.opts, { positions: req.positions });
    return {
      identity: ChessyAnalysisCore.identity(state, opts),
      requireComplete: true,
      requirePlayed: !!requirePlayed,
      requireStability: minDepth >= 3,
      playedMove: req.opts.playedMove,
      minDepth: minDepth || 1
    };
  }

  function validate(result, state, req, minDepth) {
    try {
      return ChessyAnalysisResult.validate(
        result, state, expectedFor(state, req, true, minDepth));
    } catch (e) {
      return { ok: false, reason: 'validator-failed' };
    }
  }

  function unresolved(job, ply, phase, reason) {
    job.unresolved.push({
      ply: ply,
      phase: phase,
      reason: typeof reason === 'string' ? reason : 'unusable-result'
    });
  }

  function analyseQuick(review, job, ply, token) {
    var state = review.states[ply];
    var firstReq = moveRequest(review, job, ply, QUICK, false);
    return ChessyAnalysisService.analyse(firstReq, OWNER).then(function (res) {
      if (!owns(token, job)) return { stopped: true };
      if (res === null) return { paused: true };
      var checked = validate(res, state, firstReq, 2);
      if (checked.ok) return { result: res, validation: checked };

      // Exactly one stronger retry. The profile changes the cache key and fresh
      // also prevents a malformed served value from being handed back.
      var retryReq = moveRequest(review, job, ply, QUICK_FALLBACK, true);
      return ChessyAnalysisService.analyse(retryReq, OWNER).then(function (retry) {
        if (!owns(token, job)) return { stopped: true };
        if (retry === null) return { paused: true };
        var retryChecked = validate(retry, state, retryReq, 2);
        if (!retryChecked.ok) {
          return { unusable: true, reason: retryChecked.reason || checked.reason };
        }
        return { result: retry, validation: retryChecked };
      });
    });
  }

  function nextEligible(review, cursor, scanColor) {
    var end = review.gs.history.length;
    for (var ply = cursor; ply < end; ply++) {
      if (eligible(review, ply, scanColor)) return ply;
    }
    return end;
  }

  function runPassOne(review, job, token) {
    if (!owns(token, job)) return Promise.resolve(job);
    var ply = nextEligible(review, job.cursorPly, job.scanColor);
    if (ply >= review.gs.history.length) {
      job.shortlist = ChessyMomentSelector.shortlist(job.candidates, 2);
      job.pass = 2;
      job.verifyIndex = 0;
      delete job.error;
      // Persist the pass transition before dispatching expensive deep work.
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassTwo(review, job, token) : job;
      });
    }

    // Skipped opponent/terminal plies are represented by the absolute cursor.
    // The analysed ply is not advanced until a usable or terminally unusable
    // result has been checkpointed.
    job.cursorPly = ply;
    return analyseQuick(review, job, ply, token).then(function (out) {
      if (!owns(token, job) || out.stopped) return job;
      if (out.paused) return pauseAfterNull(token, job);
      if (out.unusable) {
        unresolved(job, ply, 'quick', out.reason);
      } else {
        var entry = review.gs.history[ply];
        var candidate = ChessyMomentSelector.quickCandidate(out.result, {
          ply: ply,
          playedSan: entry.san,
          turn: review.states[ply].turn,
          thinkMs: exactThinkMs(review.game, ply),
          typicalThinkMs:
            job.typicalThinkMsBySide[review.states[ply].turn],
          validated: true
        });
        if (candidate) job.candidates.push(candidate);
      }
      job.cursorPly = ply + 1; // cursor always denotes the NEXT absolute ply
      job.checked++;
      delete job.error;
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassOne(review, job, token) : job;
      });
    });
  }

  function runPassTwo(review, job, token) {
    if (!owns(token, job)) return Promise.resolve(job);
    if (job.verifyIndex >= job.shortlist.length) {
      job.state = 'done';
      job.pass = 2;
      delete job.error;
      running = false;
      return checkpoint(token, job).then(function () { return job; });
    }
    var quick = job.shortlist[job.verifyIndex];
    var ply = quick.ply;
    if (!eligible(review, ply, job.scanColor)) {
      unresolved(job, ply, 'deep', 'position-no-longer-eligible');
      job.verifyIndex++;
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassTwo(review, job, token) : job;
      });
    }
    var state = review.states[ply];
    var req = moveRequest(review, job, ply, DEEP, false);
    return ChessyAnalysisService.analyse(req, OWNER).then(function (res) {
      if (!owns(token, job)) return job;
      if (res === null) return pauseAfterNull(token, job);
      var checked = validate(res, state, req, 3);
      if (!checked.ok) {
        unresolved(job, ply, 'deep', checked.reason);
      } else {
        var accepted = ChessyMomentSelector.acceptDeep(quick, res, {
          ply: ply,
          playedSan: review.gs.history[ply].san,
          turn: state.turn,
          thinkMs: exactThinkMs(review.game, ply),
          typicalThinkMs: job.typicalThinkMsBySide[state.turn],
          validated: true
        });
        if (accepted) {
          // Enforce the spoiler boundary even if a future selector regresses.
          job.moments.push({ ply: accepted.ply, playedSan: accepted.playedSan });
        }
      }
      job.verifyIndex++;
      delete job.error;
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassTwo(review, job, token) : job;
      });
    });
  }

  function pauseAfterNull(token, job) {
    if (!owns(token, job)) return Promise.resolve(job);
    job.state = 'paused';
    job.error = 'Analysis was interrupted — resume to continue.';
    running = false;
    return checkpoint(token, job).then(function () { return job; });
  }

  function normalizeLoaded(job, review, scanColor) {
    if (!job || job.schema !== JOB_SCHEMA || job.algorithm !== ALGORITHM ||
        job.gameId !== review.game.id ||
        job.sourceRev !== sourceRevision(review.game, scanColor) ||
        job.analysisRev !== analysisRevision(review.game) ||
        job.scanColor !== scanColor) return null;
    arrays(job);
    function validRef(item) {
      return !!item && typeof item === 'object' &&
        Number.isInteger(item.ply) && item.ply >= 0 &&
        item.ply < review.gs.history.length &&
        eligible(review, item.ply, scanColor) &&
        typeof item.playedSan === 'string' &&
        item.playedSan === review.gs.history[item.ply].san;
    }
    // The job store is cache state, not a trust boundary. A malformed/relic
    // entry must neither throw during pass 2 nor surface an invented link.
    job.shortlist = job.shortlist.filter(function (item) {
      return validRef(item) && item.turn === review.states[item.ply].turn;
    }).slice(0, 2);
    var seenMoments = Object.create(null);
    job.moments = job.moments.filter(function (m) {
      if (!validRef(m) || seenMoments[m.ply]) return false;
      seenMoments[m.ply] = true;
      return true;
    }).slice(0, 2);
    job.unresolved = job.unresolved.filter(function (item) {
      return !!item && typeof item === 'object' &&
        Number.isInteger(item.ply) && item.ply >= 0 &&
        item.ply < review.gs.history.length;
    });
    job.cursorPly = Number.isInteger(job.cursorPly) && job.cursorPly >= 0
      ? Math.min(job.cursorPly, review.gs.history.length) : 0;
    job.total = countEligible(review, scanColor);
    job.checked = Number.isInteger(job.checked) && job.checked >= 0
      ? Math.min(job.checked, job.total) : 0;
    job.typicalThinkMsBySide = typicalThinkMsBySide(review, scanColor);
    delete job.typicalThinkMs;
    job.pass = job.pass === 2 ? 2 : 1;
    job.verifyIndex = Number.isInteger(job.verifyIndex) && job.verifyIndex >= 0
      ? Math.min(job.verifyIndex, job.shortlist.length) : 0;
    if (job.state === 'running') job.state = 'paused'; // stale process ownership
    if (job.state !== 'done' && job.state !== 'paused') job.state = 'paused';
    if (job.state === 'done' &&
        (job.pass !== 2 || job.verifyIndex < job.shortlist.length)) {
      job.state = 'paused';
    }
    return job;
  }

  function freshJob(review, scanColor) {
    return {
      schema: JOB_SCHEMA,
      algorithm: ALGORITHM,
      gameId: review.game.id,
      sourceRev: sourceRevision(review.game, scanColor),
      analysisRev: analysisRevision(review.game),
      scanColor: scanColor,
      state: 'paused',
      pass: 1,
      cursorPly: 0,
      checked: 0,
      total: countEligible(review, scanColor),
      candidates: [],
      shortlist: [],
      verifyIndex: 0,
      moments: [],
      unresolved: [],
      typicalThinkMsBySide: typicalThinkMsBySide(review, scanColor),
      updatedAt: now()
    };
  }

  function prepare(review, opts) {
    opts = opts || {};
    if (!review || !review.game || !review.gs || !Array.isArray(review.gs.history) ||
        !Array.isArray(review.states) || !Array.isArray(review.fens)) {
      return Promise.reject(new Error('an open, replayed game is required'));
    }
    stopLocal();
    current = null;
    currentSource = null;
    var token = generation;
    var get = global.CoachStore && CoachStore.getJob && !opts.restart
      ? Promise.resolve(CoachStore.getJob(review.game.id)) : Promise.resolve(null);
    return get.then(function (stored) {
      if (token !== generation) return null;
      // An imported game has no known owner. The explicit first-run choice is
      // stored on the job and remains the choice on reload/resume; do not make
      // the player answer again, and never silently default to both.
      var priorChoice = stored &&
        (stored.scanColor === 'w' || stored.scanColor === 'b' ||
         stored.scanColor === 'both') ? stored.scanColor : null;
      var scanColor = scanColorFor(
        review.game, opts.scanColor !== undefined ? opts.scanColor : priorChoice);
      if (!scanColor) {
        throw new Error('choose White, Black or both before scanning this game');
      }
      var job = normalizeLoaded(stored, review, scanColor);
      if (!job) job = freshJob(review, scanColor);
      currentSource = sourceSnapshot(review.game);
      current = job;
      emit(job);
      // A synchronous scanchange listener (or a microtask queued by it) may
      // pause/navigate before start() receives this prepared job. Carry the
      // ownership token across the promise boundary so that continuation can
      // never acquire a newer generation after its preparation was cancelled.
      return { job: job, token: token };
    });
  }

  // Start or resume only on explicit UI action. restart discards all previous
  // scan work for this game; otherwise a matching durable checkpoint resumes.
  function start(review, opts) {
    opts = opts || {};
    return prepare(review, opts).then(function (prepared) {
      if (!prepared || prepared.token !== generation ||
          current !== prepared.job) return null;
      var job = prepared.job;
      if (job.state === 'done' && !opts.restart) return publicState(job);
      job.state = 'running';
      delete job.error;
      running = true;
      var token = generation;
      return checkpoint(token, job).then(function (saved) {
        if (!saved) return current === job ? job : null;
        return job.pass === 2 ? runPassTwo(review, job, token)
          : runPassOne(review, job, token);
      }).then(function () {
        return current === job ? publicState(job) : null;
      });
    });
  }

  function resume(review, opts) {
    opts = Object.assign({}, opts || {}, { restart: false });
    return start(review, opts);
  }

  function pause() {
    var job = current;
    generation++;
    var wasRunning = running;
    running = false;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
    // Invalidating the generation is required even while prepare() is awaiting
    // a durable getJob(): at that point there is deliberately no current job
    // and no running request yet, but navigation/pause must still prevent the
    // pending start from later acquiring ownership.
    if (!job || !wasRunning) return Promise.resolve(publicState(job));
    job.state = 'paused';
    job.error = null;
    var token = generation;
    // This explicit checkpoint has the new ownership token. The abandoned
    // analysis continuation still carries the old token and is inert.
    return checkpoint(token, job).then(function () { return publicState(current); });
  }

  // Synchronous generation invalidation for destructive operations. It
  // intentionally performs NO write: Restore/Delete all own the database
  // transaction and clear jobs atomically.
  function invalidate() {
    stopLocal();
    current = null;
    currentSource = null;
    emit(null);
  }

  function load(review, opts) {
    return prepare(review, opts || {}).then(function (prepared) {
      if (!prepared || prepared.token !== generation ||
          current !== prepared.job) return null;
      var job = prepared.job;
      // A stale persisted "running" state was normalized above. Persist that
      // pause so the same record is honest to every future reader.
      var token = generation;
      return checkpoint(token, job).then(function () { return publicState(current); });
    });
  }

  function state() { return publicState(current); }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('chessy:archivecleared', invalidate);
    document.addEventListener('chessy:reviewrender', function () {
      if (global.CoachReview && !CoachReview.current()) pause();
    });
    document.addEventListener('chessy:viewchange', function () {
      if (document.body && document.body.dataset.view !== 'review') pause();
    });
  }

  global.ChessyMomentScan = {
    start: start,
    resume: resume,
    pause: pause,
    invalidate: invalidate,
    load: load,
    state: state,
    analysisRevision: analysisRevision,
    sourceRevision: sourceRevision,
    profiles: {
      quick: Object.assign({}, QUICK),
      quickFallback: Object.assign({}, QUICK_FALLBACK),
      deep: Object.assign({}, DEEP)
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
