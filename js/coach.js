/*
 * Chessy coach — the first vertical slice of the improvement loop:
 *
 *   archive (IndexedDB, js/store.js) → PGN import → position browser →
 *   HIDDEN self-reflection → engine verification → manual lesson card →
 *   fixed 1/3/7/14/30/90-day spaced review → honest progress counts.
 *
 * Design rules carried over from the coaching roadmap (#23):
 * - The engine's opinion is never shown before the player has answered the
 *   reflection questions (the form gates the verify step).
 * - The player owns the diagnosis: cause and lesson text are theirs; the
 *   engine contributes only moves and scores.
 * - Progress reports plain counts, not a headline "accuracy" number.
 *
 * The analysis engine is the playing engine (Master settings) run in its
 * OWN worker, so a live game's search is never disturbed. A watchdog
 * terminates an alive-but-silent worker and falls back to the synchronous
 * search, so verification can never hang the flow.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  const TXT = '︎';
  const GLYPHS = {
    wK: '♚' + TXT, wQ: '♛' + TXT, wR: '♜' + TXT,
    wB: '♝' + TXT, wN: '♞' + TXT, wP: '♟' + TXT,
    bK: '♚' + TXT, bQ: '♛' + TXT, bR: '♜' + TXT,
    bB: '♝' + TXT, bN: '♞' + TXT, bP: '♟' + TXT
  };
  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  const CAUSE_LABELS = {
    'threat-scan': 'Missed a threat',
    candidates: 'Good move not among candidates',
    evaluation: 'Judged it wrong',
    calculation: 'Line went wrong on the reply',
    efficiency: 'Right idea, too much time',
    impulse: 'Moved too fast',
    pattern: 'Good move (pattern)'
  };
  const DAY = 86400000;
  const LADDER_DAYS = [1, 3, 7, 14, 30, 90]; // fixed spaced-review ladder
  const AGAIN_DELAY = 10 * 60 * 1000;        // "Again" retries later today
  const MATE_ISH = 900000;                   // |score| above this reads as mate
  // Score for a position that IS checkmate: the engine scores a mate found
  // at ply p as 1000000 - p, so the delivered mate must sit at the ceiling —
  // a smaller constant makes the mating move itself look like a huge loss.
  const MATE_SCORE = 1000000;

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  const VIEWS = ['play', 'review', 'train', 'progress'];

  function showView(name) {
    document.body.dataset.view = name;
    $('viewPlay').hidden = name !== 'play';
    $('viewReview').hidden = name !== 'review';
    $('viewTrain').hidden = name !== 'train';
    $('viewProgress').hidden = name !== 'progress';
    for (const v of VIEWS) {
      const tab = $('tab' + v[0].toUpperCase() + v.slice(1));
      if (name === v) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (name === 'review') renderGameList();
    if (name === 'train') loadTrain();
    if (name === 'progress') renderProgress();
    // Play owns the live-game banner: leaving Play during a running timed
    // game must surface the still-ticking clocks (see app.js).
    document.dispatchEvent(new CustomEvent('chessy:viewchange'));
  }

  for (const v of VIEWS) {
    $('tab' + v[0].toUpperCase() + v.slice(1))
      .addEventListener('click', function () { showView(v); });
  }

  // ---- Mini board (shared by Review and Train) ----
  // The Play board's full accessibility model, not a lesser copy: an ARIA
  // grid of role=row/role=gridcell buttons with a single roving tab stop
  // and arrow-key navigation, so both boards are keyboard-inspectable and
  // announce their state. The Review board is inspection-only (clicks and
  // Enter no-op); the Train board answers cards via onClick.
  function makeBoard(el, onClick) {
    el.innerHTML = '';
    el.setAttribute('role', 'grid');
    el.classList.toggle('inspect', !onClick);
    const squares = [];
    let focusIdx = 52; // e2 — same roving-tab-stop model as the Play board
    function setFocus(i, focus) {
      squares[focusIdx].tabIndex = -1;
      focusIdx = i;
      squares[i].tabIndex = 0;
      if (focus) squares[i].focus();
    }
    for (let r = 0; r < 8; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < 8; c++) {
        const i = r * 8 + c;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.setAttribute('role', 'gridcell');
        cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        // Roving tab stop: one Tab stop for the whole board, arrows move
        // within it (Enter/Space activate the button natively).
        cell.tabIndex = i === focusIdx ? 0 : -1;
        cell.addEventListener('click', function () {
          setFocus(i, false);
          if (onClick) onClick(i);
        });
        const glyph = document.createElement('span');
        glyph.className = 'piece';
        cell.appendChild(glyph);
        row.appendChild(cell);
        squares.push(cell);
      }
      el.appendChild(row);
    }
    el.addEventListener('keydown', function (e) {
      const idx = squares.indexOf(e.target);
      if (idx < 0) return;
      let r = Math.floor(idx / 8), c = idx % 8;
      if (e.key === 'ArrowUp') r--;
      else if (e.key === 'ArrowDown') r++;
      else if (e.key === 'ArrowLeft') c--;
      else if (e.key === 'ArrowRight') c++;
      else if (e.key === 'Home') c = 0;
      else if (e.key === 'End') c = 7;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (r >= 0 && r < 8 && c >= 0 && c < 8) setFocus(r * 8 + c, true);
    });
    return {
      render: function (state, opts) {
        opts = opts || {};
        for (let i = 0; i < 64; i++) {
          const cell = squares[i], p = state.board[i];
          const isLast = !!opts.lastMove && (i === opts.lastMove.from || i === opts.lastMove.to);
          cell.querySelector('.piece').textContent = p ? GLYPHS[p] : '';
          cell.classList.toggle('white-piece', !!p && p[0] === 'w');
          cell.classList.toggle('black-piece', !!p && p[0] === 'b');
          cell.classList.toggle('selected', i === opts.selected);
          cell.classList.toggle('last-move', isLast);
          const target = opts.targets && opts.targets.find(function (m) { return m.to === i; });
          cell.classList.toggle('hint', !!target && !target.captured);
          cell.classList.toggle('hint-capture', !!target && !!target.captured);
          // Announce square, piece, and interaction state, mirroring Play.
          let label = Chess.sqName(i) +
            (p ? ', ' + (p[0] === 'w' ? 'white' : 'black') + ' ' + PIECE_NAMES[p[1]] : ', empty');
          if (i === opts.selected) label += ', selected';
          if (target) label += target.captured ? ', capture available' : ', legal move';
          if (isLast) label += ', last move';
          cell.setAttribute('aria-label', label);
          cell.setAttribute('aria-selected', i === opts.selected ? 'true' : 'false');
        }
      }
    };
  }

  // ---- Analysis (own worker; FIFO queue + watchdog, sync fallback) ----
  // The worker handles ONE request at a time, so every analyse() call joins
  // a queue — a reflection submitted while a game scan is mid-flight simply
  // waits its turn instead of orphaning the scan's promise (which froze the
  // UI on "Scanning…"). A watchdog terminates an alive-but-silent worker
  // and answers synchronously, then the queue keeps draining.
  let anWorker = null, anActive = null, anId = 0;
  const anQueue = [];
  const ANALYSIS = { maxDepth: 30, timeMs: 1200, quiesce: true }; // per-moment verification
  const SCAN = { maxDepth: 30, timeMs: 300, quiesce: true };      // whole-game quick scan

  // `positions` is the game's repetition table up to this position — the
  // engine needs it to score a root move that creates a third occurrence
  // as the draw it is (otherwise the coach could recommend a "win" that
  // the opponent escapes by repetition, or miss an available draw).
  function analyse(fen, cfg, positions) {
    return new Promise(function (resolve) {
      anQueue.push({ fen: fen, cfg: cfg || ANALYSIS, positions: positions || null, resolve: resolve });
      pumpAnalysis();
    });
  }

  function ensureWorker() {
    if (anWorker || typeof Worker === 'undefined') return anWorker;
    try { anWorker = new Worker('js/ai-worker.js'); } catch (e) { return null; }
    anWorker.onmessage = function (e) {
      if (anActive && e.data.id === anActive.id) settleActive(e.data);
    };
    anWorker.onerror = function () {
      if (anWorker) { anWorker.terminate(); anWorker = null; }
      if (anActive) anActive.fallback();
    };
    return anWorker;
  }

  function settleActive(result) {
    const job = anActive;
    anActive = null;
    clearTimeout(job.watchdog);
    job.resolve(result);
    pumpAnalysis();
  }

  function pumpAnalysis() {
    if (anActive || anQueue.length === 0) return;
    const job = anQueue.shift();
    anActive = job;
    job.fallback = function () {
      if (anActive !== job) return;
      settleActive(ChessAI.think(Chess.parseFen(job.fen),
        Object.assign({}, job.cfg, { positions: job.positions || undefined })));
    };
    if (!ensureWorker()) { setTimeout(job.fallback, 0); return; }
    job.id = ++anId;
    job.watchdog = setTimeout(function () {
      if (anWorker) { anWorker.terminate(); anWorker = null; }
      job.fallback();
    }, job.cfg.timeMs + 4000);
    anWorker.postMessage({
      id: job.id, fen: job.fen, positions: job.positions || undefined,
      maxDepth: job.cfg.maxDepth, timeMs: job.cfg.timeMs, quiesce: job.cfg.quiesce
    });
  }

  function fmtScore(s) {
    if (s > MATE_ISH) return '+M';
    if (s < -MATE_ISH) return '−M';
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
  }

  function lossLabel(lossCp) {
    if (lossCp >= 300) return 'a blunder';
    if (lossCp >= 100) return 'a mistake';
    if (lossCp >= 50) return 'an inaccuracy';
    return 'fine';
  }

  // ---- Coaching data generation ----
  // ONE shared epoch for every asynchronous writer — game scans, PGN
  // imports, JSON restore, archive and card writes. "Delete all training
  // data" bumps it first; each writer captures the generation when it
  // starts and abandons if it changed, so nothing writes deleted data back.
  // The epoch is BROADCAST across open tabs/PWA windows via a localStorage
  // marker: a delete in one instance invalidates the writers of every
  // other instance too (storage events fire only in the OTHER contexts).
  let coachGen = 0;
  const DELETE_EVENT_KEY = 'chessy-coach-delete-v1';
  const DELETE_COMMIT_KEY = 'chessy-coach-delete-commit-v1';
  const activeDeleteIds = new Set();
  const localDeleteIds = new Set();
  const settledDeleteOutcomes = new Map();
  const deleteAttemptTimers = new Map();
  let deleteSigSnapshot = null;
  let deleteTombstones = new Set();
  let deleteGroupSucceeded = false;
  let deleteGroupHadLocalSuccess = false;
  let deleteFailureMessage = '';
  let lastCommittedDeleteGen = -1;
  let deleteStateToken = 0;
  let deleteOutcomeWaiters = [];
  let deleteBootSettled = false;
  let deleteBootReady = Promise.resolve();
  const DELETE_LEASE_MS = 5000;

  function liveGameSignature() {
    const live = typeof window.chessyLiveGame === 'function' ? window.chessyLiveGame() : null;
    return live ? gameSig(live.sans, live.result, live.gameSeq) : null;
  }

  function invalidateCoachWork() {
    coachGen++;
    scanToken++;
    importToken++;
    verifyToken++;
    archivedSigs.clear();
    // Tombstone the live game: the Play save may hold a FINISHED game
    // whose record was just deleted — without its signature, boot
    // reconciliation would deterministically archive the deleted game
    // right back on the next reload. app.js exposes the provider at
    // script PARSE time (before this file installs the delete handler),
    // so there is no window where deletion runs without it.
    const liveSig = liveGameSignature();
    if (liveSig) archivedSigs.add(liveSig);
    lastArchivePromise = null;
  }

  // Existing-record mutations (scan/grade) may settle after a delete START.
  // They compensate only if some overlapping clear actually COMMITTED; an
  // all-failed group leaves the original records intact.
  function coachWorkInvalidated(gen, commit) {
    return gen !== coachGen || readDeleteCommit() > commit;
  }

  function deleteCommittedAfter(gen, commit) {
    // localStorage is synchronous across same-origin windows. Consulting
    // the durable marker closes the gap before this tab's queued storage
    // event runs: a writer that lands after a remote clear still sees that
    // the clear committed and compensates its resurrected row.
    if (readDeleteCommit() > commit) return Promise.resolve(true);
    if (activeDeleteIds.size === 0) {
      return Promise.resolve(lastCommittedDeleteGen > gen);
    }
    return new Promise(function (resolve) {
      deleteOutcomeWaiters.push({ gen: gen, commit: commit, resolve: resolve });
    });
  }

  function flushDeleteOutcomeWaiters() {
    const waiters = deleteOutcomeWaiters;
    deleteOutcomeWaiters = [];
    for (const w of waiters) {
      w.resolve(readDeleteCommit() > w.commit || lastCommittedDeleteGen > w.gen);
    }
  }

  function addDeleteTombstones(values) {
    if (!Array.isArray(values)) return;
    for (const s of values) if (typeof s === 'string') deleteTombstones.add(s);
  }

  function rememberDeleteOutcome(id, succeeded) {
    settledDeleteOutcomes.set(id, succeeded);
    if (settledDeleteOutcomes.size > 64) {
      settledDeleteOutcomes.delete(settledDeleteOutcomes.keys().next().value);
    }
  }

  function advanceDeleteCommit(commit) {
    let stored = '';
    try { stored = localStorage.getItem(DELETE_COMMIT_KEY) || ''; }
    catch (e) { /* keep the in-memory marker */ }
    let current = knownDeleteCommit;
    if (stored > current) current = stored;
    if (commit > current) current = commit;
    knownDeleteCommit = current;
    try { localStorage.setItem(DELETE_COMMIT_KEY, current); }
    catch (e) { /* in-memory fencing still protects this tab */ }
  }

  function broadcastDeleteEvent(id, phase, commit) {
    try {
      localStorage.setItem(DELETE_EVENT_KEY, JSON.stringify({
        id: id, phase: phase, at: Date.now(), commit: commit || '',
        tombstones: Array.from(deleteTombstones)
      }));
    } catch (e) { /* storage unavailable — the initiating tab still settles */ }
  }

  function beginDeleteAttempt(id, tombstones) {
    if (!id || activeDeleteIds.has(id)) return;
    if (settledDeleteOutcomes.has(id)) {
      if (settledDeleteOutcomes.get(id)) {
        if (Array.isArray(tombstones)) {
          for (const s of tombstones) if (typeof s === 'string') archivedSigs.add(s);
        }
        persistSigs();
      }
      return;
    }
    if (activeDeleteIds.size === 0) {
      // Snapshot THIS TAB before optimistic invalidation. Pending archive
      // signatures are excluded: their generation-mismatch cleanup removes
      // the just-written record, so restoring them would create a false
      // dedupe hit with no corresponding archive row.
      deleteSigSnapshot = Array.from(archivedSigs).filter(function (sig) {
        return !pendingArchiveSigs.has(sig);
      });
      deleteTombstones = new Set();
      deleteGroupSucceeded = false;
      deleteGroupHadLocalSuccess = false;
      deleteFailureMessage = '';
    }
    addDeleteTombstones(tombstones);
    const liveSig = liveGameSignature();
    if (liveSig) deleteTombstones.add(liveSig);
    activeDeleteIds.add(id);
    deleteStateToken++;
    invalidateCoachWork();
    resetCoachViews();
    // Keep rollback snapshots separate from the tombstones a SUCCESSFUL
    // delete needs. A concurrent rollback may republish old signatures;
    // commits always normalize back to this tombstone-only collection.
    for (const s of deleteTombstones) archivedSigs.add(s);
    persistSigs();
    $('deleteData').disabled = true;
    deleteAttemptTimers.set(id, setTimeout(function () {
      reconcileDeleteAttempt(id);
    }, DELETE_LEASE_MS));
  }

  function reconcileDeleteAttempt(id) {
    if (!activeDeleteIds.has(id)) return;
    // The initiating tab may have closed after `start`. deleteAll writes
    // this id to the meta store in the SAME transaction as both clears, so
    // the marker is authoritative even when legitimate post-clear records
    // now make the content stores non-empty again.
    CoachStore.getLastDelete().then(function (marker) {
      if (!activeDeleteIds.has(id)) return;
      const startedAt = Number(id.slice(0, 13)) || 0;
      const committed = !!marker && (
        (Array.isArray(marker.ids) && marker.ids.indexOf(id) >= 0) ||
        (typeof marker.at === 'number' && marker.at >= startedAt)
      );
      settleDeleteAttempt(id, committed,
        committed ? '' : 'the deleting window closed before the clear completed',
        committed && Array.isArray(marker.tombstones) ? marker.tombstones : null,
        committed && typeof marker.token === 'string' ? marker.token : '');
      broadcastDeleteEvent(id, committed ? 'commit' : 'rollback',
        committed && typeof marker.token === 'string' ? marker.token : '');
    }).catch(function () {
      if (activeDeleteIds.has(id)) {
        settleDeleteAttempt(id, false, 'the delete result could not be confirmed');
        broadcastDeleteEvent(id, 'rollback');
      }
    });
  }

  function settleDeleteAttempt(id, succeeded, message, tombstones, commit) {
    addDeleteTombstones(tombstones);
    if (!activeDeleteIds.has(id)) {
      const previous = settledDeleteOutcomes.get(id);
      if (previous === true) {
        if (succeeded) {
          if (commit) advanceDeleteCommit(commit);
          if (Array.isArray(tombstones)) {
            for (const s of tombstones) if (typeof s === 'string') archivedSigs.add(s);
          }
          persistSigs();
        }
        return;
      }
      if (previous === false && !succeeded) return;
      if (previous === false) settledDeleteOutcomes.delete(id);
      if (succeeded && commit && commit <= knownDeleteCommit) {
        rememberDeleteOutcome(id, true);
        if (Array.isArray(tombstones)) {
          for (const s of tombstones) if (typeof s === 'string') archivedSigs.add(s);
        }
        persistSigs();
        return;
      }
      // A tab opened after the start marker can still receive the commit.
      // Invalidate anything it loaded before the clear completed.
      if (succeeded) {
        beginDeleteAttempt(id, tombstones);
      } else {
        return;
      }
    }
    clearTimeout(deleteAttemptTimers.get(id));
    deleteAttemptTimers.delete(id);
    const locallyInitiated = localDeleteIds.delete(id);
    if (locallyInitiated) deleteBusy = false;
    activeDeleteIds.delete(id);
    rememberDeleteOutcome(id, succeeded);
    if (succeeded) {
      deleteGroupSucceeded = true;
      lastCommittedDeleteGen = Math.max(lastCommittedDeleteGen, coachGen);
      // Capture every signature observed during the clear (including a
      // game that finished after START) before switching the shared fence.
      for (const s of archivedSigs) deleteTombstones.add(s);
      for (const s of pendingArchiveSigs) deleteTombstones.add(s);
      const live = liveGameSignature();
      if (live) deleteTombstones.add(live);
      advanceDeleteCommit(commit || knownDeleteCommit);
      // Persist immediately, even while another overlapping attempt is
      // unresolved: a new/reloaded tab must never see the new fence paired
      // with the old signature envelope.
      archivedSigs.clear();
      for (const s of deleteTombstones) archivedSigs.add(s);
      persistSigs();
      if (locallyInitiated) deleteGroupHadLocalSuccess = true;
    }
    else if (message) deleteFailureMessage = message;
    // Simultaneous starts are one group: do not roll back one failed clear
    // while another tab's clear can still commit. Recovery happens only if
    // EVERY overlapping attempt has settled and none succeeded.
    if (activeDeleteIds.size !== 0) return;

    if (deleteGroupSucceeded) {
      const token = ++deleteStateToken;
      deleteSigSnapshot = null;
      archivedSigs.clear();
      for (const s of deleteTombstones) archivedSigs.add(s);
      persistSigs();
      // Preserve the established cross-tab UX: receivers stay in the
      // directly-reset empty DOM (no mid-clear read), while the initiating
      // Progress view renders committed zero counts.
      const notice = deleteGroupHadLocalSuccess
        ? 'All training data deleted.'
        : 'All training data was deleted in another window.';
      const refreshed = deleteGroupHadLocalSuccess ? refreshCoachView() : Promise.resolve();
      Promise.resolve(refreshed).then(function () {
        if (token === deleteStateToken && document.body.dataset.view === 'progress') {
          $('dataNote').textContent = notice;
        }
      });
    } else {
      // Every clear aborted, so the atomic two-store transaction left the
      // archive intact. Restore this tab's own pre-invalidation signatures,
      // keeping current live-game tombstones at the tail of the bounded Set,
      // and repopulate whichever view was optimistically emptied.
      const token = ++deleteStateToken;
      const snapshot = deleteSigSnapshot || [];
      archivedSigs.clear();
      for (const s of snapshot) archivedSigs.add(s);
      persistSigs();
      // Include any durable game written while the failed group was active,
      // but never re-add attempt-only/pending tombstones with no DB row.
      CoachStore.listGames().then(function (games) {
        if (token !== deleteStateToken) return;
        for (const g of games) if (typeof g.sig === 'string') archivedSigs.add(g.sig);
        persistSigs();
      }).catch(function () {});
      const notice = deleteFailureMessage
        ? 'Delete failed: ' + deleteFailureMessage + '. Training data was not deleted.'
        : 'Delete failed in another window; training data is still available.';
      $('dataNote').textContent = notice;
      Promise.resolve(refreshCoachView()).then(function () {
        // A failed store-open refresh reports "Archive unavailable" on its
        // own; the more specific destructive-action result must win.
        if (token === deleteStateToken) $('dataNote').textContent = notice;
      });
      deleteSigSnapshot = null;
    }
    flushDeleteOutcomeWaiters();
    if (!deleteBusy) $('deleteData').disabled = false;
  }

  window.addEventListener('storage', function (e) {
    if (e.key === SIGS_KEY) {
      // Another tab archived (or tombstoned) a game: merge its signatures
      // so this tab's dedupe snapshot stays current. The unique DB index
      // is the hard backstop for truly simultaneous inserts.
      // During deletion, correlated start/commit events carry tombstones;
      // an uncorrelated SIGS write may be a concurrent rollback snapshot.
      let storedCommit = null;
      let storedSigs = [];
      let storedDeletes = [];
      try {
        const stored = JSON.parse(e.newValue);
        storedCommit = stored && !Array.isArray(stored) &&
          typeof stored.commit === 'string' ? stored.commit : '';
        if (Array.isArray(stored) && readDeleteCommit() === '') {
          storedSigs = stored;
        } else if (stored && storedCommit === readDeleteCommit() &&
                   Array.isArray(stored.sigs)) {
          storedSigs = stored.sigs;
        }
        if (stored && Array.isArray(stored.deletes)) {
          storedDeletes = stored.deletes.filter(function (id) {
            return typeof id === 'string';
          });
          // Contributions can intentionally carry the pre-commit fence.
          if (Array.isArray(stored.sigs)) storedSigs = stored.sigs;
        }
      } catch (err) { /* malformed data contributes nothing */ }

      const contribution = storedDeletes.some(function (id) {
        return activeDeleteIds.has(id) || settledDeleteOutcomes.get(id) === true;
      });
      if (contribution) {
        let added = false;
        for (const s of storedSigs) {
          if (typeof s !== 'string') continue;
          if (!deleteTombstones.has(s)) { deleteTombstones.add(s); added = true; }
          if (!archivedSigs.has(s)) { archivedSigs.add(s); added = true; }
        }
        if (added) persistSigs();
        return;
      }
      if (storedDeletes.some(function (id) {
        return settledDeleteOutcomes.get(id) === false;
      })) {
        // A delayed pre-rollback contribution is not ordinary archive
        // state; republish the restored snapshot without adopting it.
        persistSigs();
        return;
      }
      if (activeDeleteIds.size !== 0) return;

      const current = readDeleteCommit();
      if (knownDeleteCommit === current && storedCommit !== current) {
        // Repair a stale tab's late write with this tab's current fenced
        // snapshot. Its old signatures must never become authoritative.
        persistSigs();
        return;
      }
      let changed = false;
      for (const s of storedSigs) {
        if (typeof s !== 'string') continue;
        if (!archivedSigs.has(s)) {
          archivedSigs.add(s);
          changed = true;
        }
      }
      // Same-fence snapshots from multiple passive tabs each contain that
      // tab's live-game tombstone. Republish the union so the last write
      // cannot discard another tab's deleted ending.
      if (changed) persistSigs();
      return;
    }
    if (e.key === DELETE_COMMIT_KEY && e.newValue) {
      // The durable fence is also a fallback terminal signal. This closes
      // split-brain when one peer's lease read fails or the correlated
      // commit event is delayed/lost. Tokens encode their attempt id.
      if (e.newValue < knownDeleteCommit) {
        try { localStorage.setItem(DELETE_COMMIT_KEY, knownDeleteCommit); }
        catch (err) { /* the in-memory fence remains authoritative here */ }
        return;
      }
      const bar = e.newValue.indexOf('|');
      if (bar >= 0) {
        settleDeleteAttempt(e.newValue.slice(bar + 1), true, '', null, e.newValue);
      }
      return;
    }
    if (e.key !== DELETE_EVENT_KEY || !e.newValue) return;
    let event = null;
    try { event = JSON.parse(e.newValue); } catch (err) { return; }
    if (!event || typeof event.id !== 'string') return;
    if (event.phase === 'start') {
      // Another instance is ABOUT to clear the data: invalidate every
      // asynchronous writer and active view before its transaction begins.
      beginDeleteAttempt(event.id, event.tombstones);
      if (document.body.dataset.view === 'progress') {
        $('dataNote').textContent = 'Deleting training data in another window…';
      }
    } else if (event.phase === 'commit') {
      settleDeleteAttempt(event.id, true, '', event.tombstones, event.commit || '');
    } else if (event.phase === 'rollback') {
      settleDeleteAttempt(event.id, false, '', event.tombstones);
    }
  });

  function storedDeleteTombstones(id) {
    try {
      const stored = JSON.parse(localStorage.getItem(SIGS_KEY));
      if (!stored || !Array.isArray(stored.deletes) ||
          stored.deletes.indexOf(id) < 0 || !Array.isArray(stored.sigs)) return [];
      return stored.sigs.filter(function (s) { return typeof s === 'string'; });
    } catch (e) { return []; }
  }

  function resumeDeleteStateAtBoot() {
    let event = null;
    let rollbackRecovery = Promise.resolve();
    try { event = JSON.parse(localStorage.getItem(DELETE_EVENT_KEY)); }
    catch (e) { /* no usable persisted event */ }
    if (event && typeof event.id === 'string') {
      const tombstones = (Array.isArray(event.tombstones) ? event.tombstones : [])
        .concat(storedDeleteTombstones(event.id));
      if (event.phase === 'start') {
        const commit = readDeleteCommit();
        const bar = commit.indexOf('|');
        if (bar >= 0 && commit.slice(bar + 1) === event.id) {
          settleDeleteAttempt(event.id, true, '', tombstones, commit);
        } else {
          beginDeleteAttempt(event.id, tombstones);
          if (Date.now() - Number(event.at || 0) >= DELETE_LEASE_MS) {
            clearTimeout(deleteAttemptTimers.get(event.id));
            reconcileDeleteAttempt(event.id);
          }
        }
      } else if (event.phase === 'commit' && typeof event.commit === 'string') {
        if (event.commit > knownDeleteCommit) {
          settleDeleteAttempt(event.id, true, '', tombstones, event.commit);
        } else if (event.commit === knownDeleteCommit) {
          rememberDeleteOutcome(event.id, true);
          for (const s of tombstones) if (typeof s === 'string') archivedSigs.add(s);
          persistSigs();
        }
      } else if (event.phase === 'rollback') {
        rememberDeleteOutcome(event.id, false);
        if (storedDeleteTombstones(event.id).length) {
          archivedSigs.clear();
          persistSigs();
          rollbackRecovery = CoachStore.listGames().then(function (games) {
            for (const game of games) {
              if (typeof game.sig === 'string') archivedSigs.add(game.sig);
            }
            persistSigs();
          }).catch(function () {});
        }
      }
    }

    // IndexedDB is authoritative if every window disappeared after the
    // atomic clear but before localStorage's terminal event/signature write.
    return rollbackRecovery.then(function () { return CoachStore.getLastDelete(); })
      .then(function (marker) {
      if (!marker || typeof marker.token !== 'string') return;
      if (Array.isArray(marker.ids)) {
        for (const id of marker.ids) {
          if (typeof id === 'string') rememberDeleteOutcome(id, true);
        }
      }
      if (marker.token > knownDeleteCommit) {
        const id = typeof marker.attemptId === 'string'
          ? marker.attemptId : marker.token.slice(marker.token.indexOf('|') + 1);
        const tombstones = (Array.isArray(marker.tombstones) ? marker.tombstones : [])
          .concat(storedDeleteTombstones(id));
        settleDeleteAttempt(id, true, '', tombstones, marker.token);
      } else if (marker.token === knownDeleteCommit &&
                 typeof marker.attemptId === 'string') {
        rememberDeleteOutcome(marker.attemptId, true);
        const tombstones = (Array.isArray(marker.tombstones) ? marker.tombstones : [])
          .concat(storedDeleteTombstones(marker.attemptId));
        for (const s of tombstones) if (typeof s === 'string') archivedSigs.add(s);
        if (tombstones.length) persistSigs();
      }
    }).catch(function () { /* normal calls report storage failures in their own UI */ });
  }

  function resetCoachViews() {
    review = null;
    const view = document.body.dataset.view;
    // Clear to the post-delete EMPTY state directly — re-querying the
    // store here could still see pre-delete records (the other tab's
    // clear may not have committed yet) and hand them back to the UI.
    if (view === 'review') {
      $('reviewFlow').hidden = true;
      $('gameListWrap').hidden = false;
      $('gameList').innerHTML = '';
      $('reviewEmpty').textContent = 'No games archived yet — finish a game in Play, or import a PGN.';
      $('reviewEmpty').hidden = false;
    }
    if (view === 'train' || train) {
      // Straight to the empty DOM, NOT via nextTrainCard(): its requeue
      // lookup re-queries the store, which mid-clear can still see the
      // pre-delete cards and reload one as "overdue".
      train = { queue: [], card: null, state: null, selected: null, answered: false };
      clearTimeout(trainTimer);
      $('trainCount').textContent = '';
      $('trainEmpty').textContent = 'No cards due. Flag moments in Review to create lesson cards.';
      $('trainEmpty').hidden = false;
      $('trainCardBox').hidden = true;
      $('trainReveal').hidden = true;
    }
    if (view === 'progress') {
      // Clear the counts directly, same principle as above: an immediate
      // re-render could read pre-delete data and leave stale counts on
      // screen indefinitely. (The LOCAL delete path re-renders after its
      // clear commits — see the deleteData handler.)
      $('progressStats').innerHTML = '';
      $('causeStats').innerHTML = '';
    }
  }

  function refreshCoachView() {
    const view = document.body.dataset.view;
    if (view === 'review') return renderGameList();
    if (view === 'train') return loadTrain();
    if (view === 'progress') return renderProgress();
    return Promise.resolve();
  }

  // ---- Archive hook (called by app.js when a game ends) ----
  // Dedupe is keyed on the game INSTANCE (app.js's gameSeq, persisted with
  // the saved game) plus the moves: a re-shown ending — including a
  // reload → undo → replay of the same finish — archives once, while an
  // identical game legitimately replayed via New game/Rematch archives
  // again. EVERY seen signature is retained (finish A, undo into B, then
  // reproduce A still counts A once), signatures survive reloads via
  // localStorage (bounded), and a signature is removed again when its
  // write FAILS so a transient IndexedDB error does not suppress the retry.
  const SIGS_KEY = 'chessy-coach-sigs-v1';
  function readDeleteCommit() {
    try { return localStorage.getItem(DELETE_COMMIT_KEY) || ''; }
    catch (e) { return ''; }
  }

  // Signature snapshots are tagged with the latest successful clear. A
  // background tab that has not processed that clear yet may still publish
  // its old in-memory Set, but the old tag prevents any current tab (or a
  // later reload) from adopting those pre-delete signatures.
  let knownDeleteCommit = readDeleteCommit();
  const archivedSigs = new Set(loadSigs());
  const pendingArchiveSigs = new Set();
  // The CURRENT archive attempt (promise of the stored id, or null): the
  // game-over Review handoff awaits it, so clicking "Review game" while
  // the write is still in flight opens the game that just finished — never
  // the previous one, and never anything at all if the write failed.
  let lastArchivePromise = null;

  function loadSigs() {
    // Legacy arrays remain readable until the first successful clear. After
    // that, only a snapshot fenced by the CURRENT clear marker is trusted.
    // Any other valid JSON (including a stale or corrupt object) reads empty.
    try {
      const v = JSON.parse(localStorage.getItem(SIGS_KEY));
      const current = readDeleteCommit();
      if (Array.isArray(v)) {
        return current === ''
          ? v.filter(function (s) { return typeof s === 'string'; })
          : [];
      }
      if (!v || typeof v !== 'object' || v.commit !== current ||
          !Array.isArray(v.sigs)) return [];
      return v.sigs.filter(function (s) { return typeof s === 'string'; });
    } catch (e) { return []; }
  }

  function persistSigs() {
    try {
      const snapshot = {
        commit: knownDeleteCommit,
        sigs: Array.from(archivedSigs).slice(-100)
      };
      if (activeDeleteIds.size) snapshot.deletes = Array.from(activeDeleteIds);
      localStorage.setItem(SIGS_KEY, JSON.stringify(snapshot));
    } catch (e) { /* storage unavailable — session-level dedupe still applies */ }
  }

  function gameSig(sans, result, gameSeq) {
    return (gameSeq || 0) + '|' + sans.join(' ') + '|' + result;
  }

  // Locate the archived record for a signature (legacy records lack the
  // stored sig — fall back to matching the parts). Used by the dedupe-hit
  // handoff and by the ConstraintError adoption below.
  function findArchived(sig, sans, result, seq) {
    const key = sans.join(' ');
    return CoachStore.listGames().then(function (games) {
      const match = games.find(function (g) {
        return g.source === 'play' && (g.sig === sig || (
          g.result === result &&
          (g.gameSeq === seq || g.gameSeq === undefined) &&
          Array.isArray(g.sans) && g.sans.join(' ') === key));
      });
      return match ? match.id : null;
    }).catch(function () { return null; });
  }

  function archiveGame(state, settings, status, gameSeq) {
    if (!deleteBootSettled) {
      return deleteBootReady.then(function () {
        return archiveGame(state, settings, status, gameSeq);
      });
    }
    if (!state.history.length || !status.over) return Promise.resolve(null);
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const sans = state.history.map(function (h) { return h.san; });
    const sig = gameSig(sans, status.result, gameSeq);
    // A re-shown ending: already archived — point the handoff at the
    // EXISTING record. lastArchivePromise may be stale (an A→B→A ending
    // would otherwise open B) or null (after a reload the promise is gone
    // even though the signature persisted), so it is re-resolved by lookup.
    if (archivedSigs.has(sig)) {
      lastArchivePromise = findArchived(sig, sans, status.result, gameSeq || 0);
      return lastArchivePromise;
    }
    archivedSigs.add(sig);
    pendingArchiveSigs.add(sig);
    const attempt = CoachStore.addGame({
      source: 'play',
      tags: {},
      // The signature is STORED (backing a unique index): each tab's
      // in-memory dedupe is only a snapshot, so the database must refuse
      // a second tab's identical insert itself.
      sig: sig,
      // The instance number backs the dedupe lookup above: a re-shown
      // ending must reopen ITS record, not an identical game's.
      gameSeq: gameSeq || 0,
      sans: sans,
      // The side the human played — scans focus feedback on these moves.
      playerColor: settings.mode === 'ai-b' ? 'w' : settings.mode === 'ai-w' ? 'b' : 'both',
      // Per-move clock evidence ({thinkMs, wMs, bMs} or null): retained so
      // efficiency/impulse diagnoses have data behind them.
      clocks: state.history.map(function (h) { return h.clock || null; }),
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: sans.length,
      createdAt: Date.now()
    }, commit).then(function (id) {
      pendingArchiveSigs.delete(sig);
      if (coachWorkInvalidated(gen, commit)) {
        return deleteCommittedAfter(gen, commit).then(function (committed) {
          if (committed) {
            // A committed clear can be followed by this older transaction;
            // take the resurrected row back out but retain its tombstone.
            CoachStore.deleteGame(id).catch(function () {});
            return null;
          }
          // Every clear failed: the archive row is durable and should remain
          // visible/deduped, even though its old UI handoff was cancelled.
          archivedSigs.add(sig);
          persistSigs();
          return id;
        });
      }
      persistSigs();
      return id;
    }).catch(function (err) {
      pendingArchiveSigs.delete(sig);
      if (err && err.name === 'StaleCoachWriteError') return null;
      // Unique-sig violation: another tab archived this exact game first
      // (both passed their local snapshot check) — adopt its record.
      if (err && err.name === 'ConstraintError') {
        return findArchived(sig, sans, status.result, gameSeq || 0);
      }
      if (coachWorkInvalidated(gen, commit)) {
        return deleteCommittedAfter(gen, commit).then(function (committed) {
          // Successful deletion owns the live-game tombstone. If every
          // clear failed, release this failed attempt so boot/replay retries.
          if (!committed) {
            archivedSigs.delete(sig);
            persistSigs();
          }
          return null;
        });
      }
      archivedSigs.delete(sig); // failed write: allow the retry
      return null;
    });
    lastArchivePromise = attempt;
    return attempt;
  }

  // Game-over "Review game" hands off here: AWAIT the current archive
  // attempt, then open that game in the coaching review. Returns false when
  // no attempt exists (the caller falls back to the on-board replay); a
  // failed write lands on the game list instead of a wrong game.
  function openLatestArchived() {
    if (!lastArchivePromise) return false;
    // The handoff is asynchronous and the game-over dialog has already
    // closed, so focus must be MOVED into the view that opens — otherwise
    // keyboard/screen-reader users are left on the stale Play board. The
    // reads are generation-guarded: a cross-tab delete landing while they
    // are in flight must not reopen (and later re-scan) the deleted game.
    const gen = coachGen;
    const commit = knownDeleteCommit;
    lastArchivePromise.then(function (id) {
      if (coachWorkInvalidated(gen, commit)) return null; // deleted while awaiting the archive
      if (id === null) { showView('review'); $('tabReview').focus(); return null; }
      return CoachStore.getGame(id).then(function (game) {
        if (coachWorkInvalidated(gen, commit)) return; // deleted while the read was in flight
        showView('review');
        if (game) {
          openReview(game);
          $('reviewBack').focus();
        } else {
          $('tabReview').focus();
        }
      });
    }).catch(function () { showView('review'); $('tabReview').focus(); });
    return true;
  }

  // ---- Review: game list ----
  function gameLabel(g) {
    if (g.source === 'import') {
      const w = (g.tags && g.tags.White) || 'White';
      const b = (g.tags && g.tags.Black) || 'Black';
      return w + ' vs ' + b;
    }
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function renderGameList() {
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
    const gen = coachGen;
    const commit = knownDeleteCommit;
    return CoachStore.listGames().then(function (games) {
      if (coachWorkInvalidated(gen, commit)) return; // deleted while the read was in flight
      const list = $('gameList');
      list.innerHTML = '';
      $('reviewEmpty').hidden = games.length > 0;
      for (const g of games) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'game-item';
        const when = new Date(g.createdAt);
        btn.textContent = gameLabel(g) + ' · ' + g.result +
          (g.reason ? ' (' + g.reason + ')' : '') + ' · ' +
          Math.ceil(g.plies / 2) + ' moves · ' + when.toLocaleDateString();
        btn.addEventListener('click', function () { openReview(g); });
        li.appendChild(btn);
        list.appendChild(li);
      }
    }).catch(function () {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Review: position browser + reflection + verification ----
  const reviewBoard = makeBoard($('reviewBoard'), null);
  let review = null; // { game, gs, fens[], ply, flagged, verdict }

  function openReview(game) {
    let gs;
    try { gs = Chess.replaySans(game.sans); }
    catch (e) {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'This archived game no longer replays: ' + e.message;
      return;
    }
    scanToken++; // abandon any scan still running for the previous game
    const fens = gs.history.map(function (h) { return h.fen; });
    fens.push(Chess.toFen(gs));
    // Full game states per ply (WITH repetition tables): terminal checks on
    // "the position after move k" must see draws by threefold repetition,
    // which a bare FEN cannot represent.
    let s = Chess.newGameState();
    const states = [s];
    for (const h of gs.history) {
      s = Chess.playMove(s, h.move);
      states.push(s);
    }
    review = { game: game, gs: gs, fens: fens, states: states, ply: 0, flagged: null, verdict: null };
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    renderScan(review);
    renderReview();
  }

  function renderReview() {
    const r = review;
    const state = Chess.parseFen(r.fens[r.ply]);
    const last = r.ply > 0 ? r.gs.history[r.ply - 1].move : null;
    reviewBoard.render(state, { lastMove: last });
    const side = state.turn === 'w' ? 'White' : 'Black';
    const played = r.ply < r.gs.history.length ? r.gs.history[r.ply] : null;
    // An imported game can CONTINUE past a position the engine scores as
    // over (an unclaimed threefold/fifty-move draw is automatic for
    // Chessy's rules): the engine has no move to suggest there, so a card
    // built from such a moment would be unanswerable — not flaggable.
    const engineOver = !!played && terminalScore(r.states[r.ply]) !== null;
    $('reviewStatus').textContent = 'Position ' + r.ply + '/' + r.gs.history.length +
      ' · ' + side + ' to move' + (played ? ' · played here: ' + played.san : ' · end of game') +
      (engineOver ? ' · already drawn by rule here — moment not flaggable' : '');
    $('revStart').disabled = r.ply === 0;
    $('revPrev').disabled = r.ply === 0;
    $('revNext').disabled = r.ply >= r.gs.history.length;
    $('revEnd').disabled = r.ply >= r.gs.history.length;
    $('flagMoment').disabled = !played || engineOver;
    // Stepping away from a flagged moment abandons the (unsaved) reflection.
    if (r.flagged !== r.ply) {
      r.flagged = null;
      r.verdict = null;
      $('reflectForm').hidden = true;
      $('verifyBox').hidden = true;
    }
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  // ---- Retroactive scan: analyse every decision, surface key moments ----
  // The engine picks WHICH moments matter (the roadmap's "quick scan"),
  // but stays quiet about WHY: the moment list shows the played move and
  // what it cost — never the better move, which is revealed only after the
  // reflection form, so the reflect-first rule holds even for scanned games.
  let scanToken = 0;

  // `state` must be a FULL game state (repetition table included) so that
  // draws by threefold repetition read as terminal too.
  function terminalScore(state) {
    const st = Chess.gameStatus(state);
    if (!st.over) return null;
    return st.result === '1-0' ? MATE_SCORE : st.result === '0-1' ? -MATE_SCORE : 0;
  }

  function runScan(r) {
    const token = ++scanToken;
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const n = r.gs.history.length;
    const evals = new Array(n + 1);
    const bestSans = new Array(n + 1);
    $('scanGame').disabled = true;
    $('momentList').innerHTML = '';
    $('scanStatus').hidden = false;
    let chain = Promise.resolve();
    for (let k = 0; k <= n; k++) {
      (function (k) {
        chain = chain.then(function () {
          if (token !== scanToken) return;
          $('scanStatus').textContent = 'Scanning position ' + (k + 1) + '/' + (n + 1) + '…';
          const term = terminalScore(r.states[k]);
          if (term !== null) {
            evals[k] = term;
            bestSans[k] = null;
            return;
          }
          return analyse(r.fens[k], SCAN, r.states[k].positions).then(function (res) {
            if (token !== scanToken) return;
            evals[k] = res.score;
            const st = Chess.parseFen(r.fens[k]);
            const legal = Chess.legalMoves(st);
            const bm = res.move && legal.find(function (m) {
              return m.from === res.move.from && m.to === res.move.to &&
                     (m.promotion || null) === (res.move.promotion || null);
            });
            bestSans[k] = bm ? Chess.toSan(st, bm, legal) : null;
          });
        });
      })(k);
    }
    chain.then(function () {
      if (token !== scanToken || coachWorkInvalidated(gen, commit)) return;
      // Coach the TRAINEE only: an opponent's blunders are not the player's
      // lesson material, and in an easy-AI game they would otherwise crowd
      // out every slot.
      const pc = r.game.playerColor || 'both';
      const moments = [];
      for (let k = 0; k < n; k++) {
        const mover = k % 2 === 0 ? 'w' : 'b'; // games replay from the standard start
        if (pc !== 'both' && mover !== pc) continue;
        // Moves played FROM an engine-terminal position (imported games
        // continuing past an unclaimed draw) are not flaggable — don't
        // surface them as moments either.
        if (terminalScore(r.states[k]) !== null) continue;
        const loss = Math.max(0, Math.round((evals[k] - evals[k + 1]) * (mover === 'w' ? 1 : -1)));
        if (loss >= 50) moments.push({ ply: k, loss: loss });
      }
      moments.sort(function (a, b) { return b.loss - a.loss; });
      const top = moments.slice(0, 2).sort(function (a, b) { return a.ply - b.ply; });
      r.game.scan = {
        at: Date.now(),
        settings: { maxDepth: SCAN.maxDepth, timeMs: SCAN.timeMs },
        playerColor: pc,
        evals: evals,
        bestSans: bestSans,
        moments: top
      };
      CoachStore.updateGame(r.game, commit).then(function () {
        if (coachWorkInvalidated(gen, commit)) {
          // Undo a stale put only when a clear COMMITTED. On rollback this is
          // still the original game record; deleting it would turn a failed
          // destructive action into real data loss (including its cards).
          deleteCommittedAfter(gen, commit).then(function (committed) {
            if (committed) CoachStore.deleteGame(r.game.id).catch(function () {});
          });
        }
      }).catch(function () { /* scan still usable this session */ });
      renderScan(r);
    });
  }

  function moveLabel(r, ply) {
    return (Math.floor(ply / 2) + 1) + (ply % 2 === 0 ? '. ' : '… ') + r.gs.history[ply].san;
  }

  function renderScan(r) {
    const scan = r.game.scan;
    const list = $('momentList');
    list.innerHTML = '';
    $('scanGame').disabled = false;
    $('scanGame').textContent = scan ? 'Re-scan game' : 'Scan for key moments';
    $('scanStatus').hidden = !scan;
    if (!scan) return;
    const whose = scan.playerColor === 'w' ? 'your White moves'
      : scan.playerColor === 'b' ? 'your Black moves' : 'this game';
    $('scanStatus').textContent = scan.moments.length
      ? scan.moments.length + ' key moment' + (scan.moments.length > 1 ? 's' : '') +
        ' in ' + whose + ' (Chessy estimate). Open one and reflect — details appear after you answer.'
      : 'Scanned ' + whose + ' — no significant swings found (Chessy estimate).';
    // Deliberately NO cost or severity here: revealing the magnitude before
    // the reflection would leak the engine's judgement (roadmap #23's
    // engine-hidden sequence). The moment's existence is the only hint.
    for (const m of scan.moments) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'moment-item';
      const side = m.ply % 2 === 0 ? 'White' : 'Black';
      btn.textContent = moveLabel(r, m.ply) + ' (' + side + ') — review this decision';
      btn.addEventListener('click', function () { stepReview(m.ply); });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  $('scanGame').addEventListener('click', function () {
    if (review) runScan(review);
  });

  $('reviewBack').addEventListener('click', function () {
    scanToken++; // abandon a running scan when leaving the game
    renderGameList();
  });
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  $('flagMoment').addEventListener('click', function () {
    verifyToken++; // a new flag invalidates any in-flight verification
    saveToken++;   // and any lesson write that still owns the shared UI
    review.flagged = review.ply;
    // Fresh moment, fresh answers: reflection AND card fields reset, so a
    // stale cause/lesson from the previous moment can never carry over.
    $('reflectThreat').value = '';
    $('reflectCandidates').value = '';
    $('reflectEval').value = '';
    $('cardCause').value = '';
    $('cardLesson').value = '';
    $('reflectForm').hidden = false;
    $('reflectVerify').disabled = false; // a fresh moment can be verified
    $('verifyBox').hidden = true;
    $('cardSaved').hidden = true;
    $('reflectThreat').focus();
  });

  // Verifications are tokenized: results landing after the user has moved
  // to another moment (or another game) are discarded — a stale verdict
  // must never re-enable Save and attach the wrong position to a card.
  let verifyToken = 0;
  // Lesson writes need their own ownership token. A fresh verification can
  // enable Save for verdict B while verdict A's IndexedDB request is still
  // pending; A must never repaint or re-enable B's shared controls.
  let saveToken = 0;

  $('reflectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    // Whitespace is not reflection: native `required` accepts spaces, so
    // trim first and re-run validation — a spaces-only answer is rejected
    // with the browser's own "fill in this field" prompt.
    $('reflectThreat').value = $('reflectThreat').value.trim();
    $('reflectCandidates').value = $('reflectCandidates').value.trim();
    if (!$('reflectForm').reportValidity()) return;
    const r = review;
    if (r.flagged === null) return;
    // A new verdict is taking ownership of the card controls immediately;
    // an older save must not re-enable them while these probes are running.
    saveToken++;
    const token = ++verifyToken;
    const ply = r.flagged;
    const fenBefore = r.fens[ply];
    const entry = r.gs.history[ply];
    const mover = Chess.parseFen(fenBefore).turn;
    $('verifyBox').hidden = false;
    $('verifyResult').textContent = 'Analysing…';
    $('saveCard').disabled = true;
    // In-flight guard: repeated submits would ENQUEUE duplicate probe
    // pairs — the token discards their stale results, but the FIFO worker
    // still has to burn through them, multiplying the "Analysing…" wait.
    $('reflectVerify').disabled = true;

    analyse(fenBefore, null, r.states[ply].positions).then(function (best) {
      // The played move's value = the value of the position it leads to.
      // If that position is terminal (mate, stalemate, dead, 50-move, or a
      // COMPLETED threefold — hence the full prefix state, not a bare FEN)
      // the engine has nothing to search.
      const afterFen = r.fens[ply + 1];
      const term = terminalScore(r.states[ply + 1]);
      const playedScoreP = term !== null
        ? Promise.resolve({ score: term })
        : analyse(afterFen, null, r.states[ply + 1].positions);
      return playedScoreP.then(function (after) {
        if (token !== verifyToken || review !== r || r.flagged !== ply) return; // stale
        // Resolve the engine's move object back to a SAN on this board.
        const legal = Chess.legalMoves(Chess.parseFen(fenBefore));
        const bm = best.move && legal.find(function (m) {
          return m.from === best.move.from && m.to === best.move.to &&
                 (m.promotion || null) === (best.move.promotion || null);
        });
        const bestSan = bm ? Chess.toSan(Chess.parseFen(fenBefore), bm, legal) : '?';
        const same = bm && entry.move.from === bm.from && entry.move.to === bm.to &&
          (entry.move.promotion || null) === (bm.promotion || null);
        // Playing the engine's own move costs nothing by definition — the
        // two probes can still differ (depth parity, terminal shortcuts).
        const lossCp = same ? 0 : Math.max(0,
          Math.round((best.score - after.score) * (mover === 'w' ? 1 : -1)));
        // A moment where the played move held up is a positive PATTERN, not
        // an error — it gets no cause diagnosis, just a lesson to keep.
        const kind = (same || lossCp < 50) ? 'pattern' : 'error';
        review.verdict = {
          ply: ply, fenBefore: fenBefore, playedSan: entry.san,
          bestSan: bestSan,
          bestMove: bm ? { from: bm.from, to: bm.to, promotion: bm.promotion || null } : null,
          bestScore: best.score, playedScore: after.score, lossCp: lossCp,
          kind: kind,
          depth: best.depth
        };
        $('causeLabel').hidden = kind === 'pattern';
        $('verifyResult').textContent = (same
          ? 'You played ' + entry.san + ' — Chessy’s line agrees (eval ' +
            fmtScore(best.score) + ', depth ' + best.depth + ').'
          : 'You played ' + entry.san + ' (position eval ' + fmtScore(after.score) +
            ') — Chessy prefers ' + bestSan + ' (eval ' + fmtScore(best.score) +
            ', depth ' + best.depth + '). Cost ≈ ' + (lossCp / 100).toFixed(1) +
            ' pawns: ' + lossLabel(lossCp) + '.') +
          ' Chessy estimate, not authoritative analysis.';
        $('saveCard').disabled = false;
      });
    }).then(function () {
      // Only the request that still OWNS the token re-enables the shared
      // control: a STALE request settling while a newer one is mid-flight
      // would otherwise reopen the duplicate-submission window this guard
      // exists for. (Flagging a new moment re-enables it directly.)
      if (token === verifyToken) $('reflectVerify').disabled = false;
    });
  });

  $('saveCard').addEventListener('click', function () {
    const r = review;
    const v = r && r.verdict;
    if (!v || $('saveCard').disabled) return;
    // Validation: every card needs a one-sentence lesson; error cards also
    // need the player's cause diagnosis (pattern cards have no cause).
    const lesson = $('cardLesson').value.trim();
    const cause = v.kind === 'pattern' ? 'pattern' : $('cardCause').value;
    if (!lesson || !cause) {
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = v.kind === 'pattern'
        ? 'Write a one-sentence lesson first.'
        : 'Pick a cause and write a one-sentence lesson first.';
      return;
    }
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const token = ++saveToken;
    // Disable BEFORE the async write — a double-click (or a slow
    // IndexedDB) must not create duplicate cards for the same moment.
    $('saveCard').disabled = true;
    const now = Date.now();
    CoachStore.addCard({
      gameId: r.game.id,
      ply: v.ply,
      fenBefore: v.fenBefore,
      playedSan: v.playedSan,
      bestSan: v.bestSan,
      bestMove: v.bestMove,
      bestScore: v.bestScore,
      playedScore: v.playedScore,
      lossCp: v.lossCp,
      kind: v.kind,
      cause: cause,
      lesson: lesson,
      reflection: {
        threat: $('reflectThreat').value.trim(),
        candidates: $('reflectCandidates').value.trim(),
        evaluation: $('reflectEval').value
      },
      createdAt: now,
      due: now,        // first review is immediate (the "learn" step)
      step: -1,        // -1 = not yet on the day ladder
      attempts: []
    }, commit).then(function (id) {
      if (coachWorkInvalidated(gen, commit)) {
        return deleteCommittedAfter(gen, commit).then(function (committed) {
          // A committed clear owns the cancellation; if every clear failed,
          // retaining the completed card avoids turning rollback into loss.
          if (committed) CoachStore.deleteCard(id).catch(function () {});
        });
      }
      if (token !== saveToken || review !== r || r.verdict !== v || r.flagged !== v.ply) return;
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = 'Lesson card saved — it is due in Train now, then on the 1/3/7/14/30/90-day ladder.';
    }).catch(function (err) {
      if (err && err.name === 'StaleCoachWriteError') return;
      if (coachWorkInvalidated(gen, commit) || token !== saveToken || review !== r ||
          r.verdict !== v || r.flagged !== v.ply) return;
      $('saveCard').disabled = false; // failed write: let the user retry
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = 'Could not save the card — storage unavailable.';
    });
  });

  // ---- Import PGN ----
  // Multi-game imports write one game at a time; Cancel bumps the token so
  // the remaining chain steps become no-ops instead of importing on behind
  // a closed dialog.
  let importToken = 0;

  function newGameChoice(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  $('importPgnBtn').addEventListener('click', function () {
    $('importText').value = '';
    $('importError').textContent = '';
    $('importStart').disabled = false;
    $('importDialog').showModal();
  });
  $('importCancel').addEventListener('click', function () {
    importToken++; // abandon any batch still importing
    $('importDialog').close();
  });
  // EVERY dismissal cancels a running batch — Escape closes a <dialog>
  // through its native cancel/close path without touching the button
  // handler, so the token is bumped on `close` too (harmless when the
  // batch already finished).
  $('importDialog').addEventListener('close', function () {
    importToken++;
  });

  $('importStart').addEventListener('click', function () {
    if ($('importStart').disabled) return;
    $('importStart').disabled = true;
    const token = ++importToken;
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const playerColor = (newGameChoice('importColor') || 'both');
    const games = Chess.parsePgn($('importText').value);
    let ok = 0, failed = 0, firstError = null;
    let chain = Promise.resolve();
    for (const g of games) {
      if (g.sans.length === 0) continue;
      chain = chain.then(function () {
        if (token !== importToken || coachWorkInvalidated(gen, commit)) return;
        if (g.unsupported) throw new Error('games from a set-up position are not supported');
        const gs = Chess.replaySans(g.sans); // throws on illegal moves
        const status = Chess.gameStatus(gs);
        return CoachStore.addGame({
          source: 'import',
          tags: g.tags,
          sans: gs.history.map(function (h) { return h.san; }), // canonical SANs
          playerColor: playerColor,
          clocks: null, // PGN %clk import is a follow-up
          result: status.over ? status.result : g.result,
          reason: status.over ? status.reason : '',
          mode: null, difficulty: null, timeControl: (g.tags && g.tags.TimeControl) || null,
          plies: gs.history.length,
          createdAt: Date.now()
        }, commit).then(function (id) {
          if (token !== importToken || coachWorkInvalidated(gen, commit)) {
            if (coachWorkInvalidated(gen, commit)) {
              return deleteCommittedAfter(gen, commit).then(function (committed) {
                if (committed) CoachStore.deleteGame(id).catch(function () {});
              });
            }
            CoachStore.deleteGame(id).catch(function () {}); // explicit Cancel during the write
            return;
          }
          ok++;
        });
      }).catch(function (e) {
        if (e && e.name === 'StaleCoachWriteError') return;
        failed++;
        if (!firstError) firstError = e.message || String(e);
      });
    }
    chain.then(function () {
      // Only the batch that still OWNS the token may touch the shared
      // button: an obsolete cancelled chain settling late would otherwise
      // re-enable Import while a newer batch is mid-write, letting a
      // second click cancel and duplicate it. (Reopening the dialog is
      // what re-enables the button after a cancel.)
      if (token !== importToken) return; // cancelled: no completion UI
      $('importStart').disabled = false;
      if (ok === 0 && failed === 0) {
        $('importError').textContent = 'No games found in that text.';
        return;
      }
      if (failed > 0 && ok === 0) {
        $('importError').textContent = 'Import failed: ' + firstError;
        return;
      }
      if (failed > 0) {
        $('importError').textContent = ok + ' imported, ' + failed + ' skipped (' + firstError + ').';
        renderGameList();
        return;
      }
      $('importDialog').close();
      renderGameList();
    });
  });

  // ---- Train ----
  const trainBoard = makeBoard($('trainBoard'), onTrainSquare);
  let train = null; // { queue, card, state, selected, answered }

  function loadTrain() {
    // A cross-tab delete can land while this read is in flight: the reset
    // clears the UI, and applying the pre-delete result afterwards would
    // hand the deleted cards straight back to the grading flow.
    const gen = coachGen;
    const commit = knownDeleteCommit;
    return CoachStore.dueCards(Date.now()).then(function (cards) {
      if (coachWorkInvalidated(gen, commit)) return;
      train = { queue: cards, card: null, state: null, selected: null, answered: false };
      nextTrainCard();
    }).catch(function () {
      $('trainEmpty').hidden = false;
      $('trainEmpty').textContent = 'Archive unavailable in this browser.';
      $('trainCardBox').hidden = true;
    });
  }

  // A card graded "Again" comes due ten minutes later while the user may
  // still be sitting in Train — the due query only runs when the view is
  // entered, so without a timer the promised same-day retry never appears.
  // When the queue drains, name the next near-term due time and requeue
  // automatically when it arrives (only if no card is being answered).
  let trainTimer = null;

  function scheduleTrainRequeue() {
    clearTimeout(trainTimer);
    $('trainEmpty').textContent = 'No cards due. Flag moments in Review to create lesson cards.';
    const gen = coachGen;
    const commit = knownDeleteCommit;
    CoachStore.listCards().then(function (cards) {
      if (coachWorkInvalidated(gen, commit)) return; // deleted while the read was in flight
      const now = Date.now();
      let next = Infinity;
      let overdue = false;
      for (const c of cards) {
        if (c.due <= now) overdue = true;
        else next = Math.min(next, c.due);
      }
      // A card can come due WHILE the rest of the queue is worked (a long
      // session after an "Again"): by the time the queue drains it is
      // already overdue, so reload now instead of arming a timer for it.
      if (overdue) { loadTrain(); return; }
      if (next - now > 3600000) return; // nothing near-term (ladder rungs are days away)
      $('trainEmpty').textContent = 'No cards due right now — the next retry unlocks at ' +
        new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
      trainTimer = setTimeout(function () {
        if (document.body.dataset.view === 'train' && (!train || !train.card)) loadTrain();
      }, next - now + 250);
    }).catch(function () { /* archive unavailable — keep the default note */ });
  }

  function nextTrainCard() {
    const t = train;
    t.card = t.queue.shift() || null;
    t.selected = null;
    t.answered = false;
    $('trainCount').textContent = t.card
      ? (t.queue.length + 1) + ' due'
      : '';
    $('trainEmpty').hidden = !!t.card;
    $('trainCardBox').hidden = !t.card;
    $('trainReveal').hidden = true;
    if (!t.card) { scheduleTrainRequeue(); return; }
    t.state = Chess.parseFen(t.card.fenBefore);
    trainBoard.render(t.state, {});
    $('trainPrompt').textContent =
      (t.state.turn === 'w' ? 'White' : 'Black') +
      ' to move — find the move Chessy saved for this moment. (You played ' +
      t.card.playedSan + ' in the game.)';
  }

  function onTrainSquare(i) {
    const t = train;
    if (!t || !t.card || t.answered) return;
    const p = t.state.board[i];
    if (t.selected === null || (p && p[0] === t.state.turn)) {
      if (p && p[0] === t.state.turn) {
        t.selected = i;
        trainBoard.render(t.state, { selected: i, targets: Chess.legalMovesFrom(t.state, i) });
      }
      return;
    }
    const candidates = Chess.legalMovesFrom(t.state, t.selected)
      .filter(function (m) { return m.to === i; });
    if (candidates.length === 0) {
      t.selected = null;
      trainBoard.render(t.state, {});
      return;
    }
    if (candidates[0].promotion) {
      // The player must choose the piece — auto-queening would make a card
      // whose best move underpromotes impossible to answer correctly.
      const owner = t;
      const cardId = t.card.id;
      choosePromotion(t.state.turn, function (type) {
        // Delete rollback can repopulate Train before the old dialog choice
        // lands. Never apply that old move to the newly loaded card/object.
        if (train !== owner || !owner.card || owner.card.id !== cardId) return;
        answerTrain(candidates.find(function (m) { return m.promotion === type; }));
      });
      return;
    }
    answerTrain(candidates[0]);
  }

  // Promotion picker for training answers, sharing the Play view's dialog
  // element (each caller rebuilds the buttons, so there is no conflict).
  function choosePromotion(color, cb) {
    const dlg = $('promotionDialog');
    const box = $('promotionChoices');
    box.innerHTML = '';
    ['Q', 'R', 'B', 'N'].forEach(function (type) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn ' + (color === 'w' ? 'white' : 'black');
      btn.textContent = GLYPHS[color + type];
      btn.setAttribute('aria-label', 'Promote to ' + PIECE_NAMES[type]);
      btn.addEventListener('click', function () {
        dlg.close();
        cb(type);
      });
      box.appendChild(btn);
    });
    dlg.showModal();
  }

  function answerTrain(attempt) {
    const t = train;
    // The promotion picker's callback can land AFTER a cross-tab delete
    // reset the training state — the card is gone; dismiss quietly.
    if (!t || !t.card) return;
    const best = t.card.bestMove;
    const correct = !!best && attempt.from === best.from && attempt.to === best.to &&
      (attempt.promotion || null) === (best.promotion || null);
    t.answered = true;
    const attemptSan = Chess.toSan(t.state, attempt);
    trainBoard.render(Chess.applyMove(t.state, attempt), { lastMove: attempt });
    $('trainReveal').hidden = false;
    // Honest wording: a single-line 300/1200 ms engine saved ONE move — a
    // different answer may be equally sound, so it "differs", it is not
    // declared wrong. The player grades themselves accordingly.
    $('trainOutcome').textContent = correct
      ? '✓ ' + attemptSan + ' — matches Chessy’s saved move.'
      : '≠ ' + attemptSan + ' differs from Chessy’s saved move ' + t.card.bestSan +
        ' (in the game you played ' + t.card.playedSan + '). Your move may still be' +
        ' sound — grade yourself honestly.';
    $('trainLesson').textContent =
      (t.card.lesson ? 'Lesson: ' + t.card.lesson + ' · ' : '') +
      'Cause: ' + (CAUSE_LABELS[t.card.cause] || t.card.cause);
    t.lastCorrect = correct;
  }

  // Fixed ladder scheduling. Good climbs, Hard repeats the current rung,
  // Again drops off the ladder and retries later today.
  function schedule(card, grade, now) {
    if (grade === 'again') {
      card.step = -1;
      card.due = now + AGAIN_DELAY;
    } else if (grade === 'hard') {
      card.step = Math.max(card.step, 0);
      card.due = now + LADDER_DAYS[Math.min(card.step, LADDER_DAYS.length - 1)] * DAY;
    } else {
      card.step = Math.min(card.step + 1, LADDER_DAYS.length - 1);
      card.due = now + LADDER_DAYS[card.step] * DAY;
    }
  }

  function grade(g) {
    const t = train;
    if (!t || !t.card || !t.answered) return;
    // Consume the answer BEFORE the async write: a double-click must not
    // record two attempts or climb the ladder twice for one reveal.
    t.answered = false;
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const now = Date.now();
    const card = t.card;
    const correct = !!t.lastCorrect;
    // Atomic read-modify-write: another tab may have graded this card
    // meanwhile — mutating OUR copy and put()ting it would erase that
    // tab's appended attempt. The mutation runs on the fresh stored
    // record inside one transaction.
    CoachStore.gradeCard(card.id, function (fresh) {
      fresh.attempts.push({ at: now, grade: g, correct: correct });
      schedule(fresh, g, now);
      return fresh;
    }, commit).then(function (updated) {
      // Delete-all racing this write would resurrect the card — undo it.
      if (coachWorkInvalidated(gen, commit)) {
        return deleteCommittedAfter(gen, commit).then(function (committed) {
          // `gradeCard` mutates an EXISTING row. Only a committed clear may
          // delete it; after rollback the saved grade/card remain intact.
          if (committed && updated) CoachStore.deleteCard(card.id).catch(function () {});
        }); // the reset/recovery owns the UI
      }
      nextTrainCard();
    }, function (err) {
      if (err && err.name === 'StaleCoachWriteError') return;
      if (coachWorkInvalidated(gen, commit)) return;
      // The grade was NOT saved (quota, storage failure): keep the card
      // on screen and say so — silently advancing would drop the attempt
      // and reschedule nothing.
      t.answered = true;
      $('trainOutcome').textContent =
        '⚠ Could not save that grade (storage unavailable) — try again.';
    });
  }

  $('gradeAgain').addEventListener('click', function () { grade('again'); });
  $('gradeHard').addEventListener('click', function () { grade('hard'); });
  $('gradeGood').addEventListener('click', function () { grade('good'); });

  // ---- Progress ----
  function stat(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderProgress() {
    const gen = coachGen;
    const commit = knownDeleteCommit;
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (r) {
      if (coachWorkInvalidated(gen, commit)) return; // deleted while the read was in flight
      const games = r[0], cards = r[1];
      const now = Date.now();
      const dl = $('progressStats');
      dl.innerHTML = '';
      stat(dl, 'Games archived', games.length);
      stat(dl, 'Lesson cards', cards.length);
      stat(dl, 'Cards due now', cards.filter(function (c) { return c.due <= now; }).length);
      // "First try" means each card's FIRST attempt — counting every
      // attempt would report per-attempt correctness (a miss followed by
      // a correct retry is not a first-try success).
      const recent = [];
      const firstTries = [];
      for (const c of cards) {
        const attempts = c.attempts || [];
        for (const a of attempts) if (now - a.at <= 30 * DAY) recent.push(a);
        if (attempts.length && now - attempts[0].at <= 30 * DAY) firstTries.push(attempts[0]);
      }
      stat(dl, 'Reviews (30 days)', recent.length);
      // `correct` records an exact match with the single saved engine move;
      // Train explicitly allows the player to self-grade a different sound
      // move, so do not mislabel this narrower signal as chess correctness.
      stat(dl, 'Matched Chessy’s saved move on first try (30 days)',
        firstTries.length
          ? firstTries.filter(function (a) { return a.correct; }).length + '/' + firstTries.length
          : '—');
      const causes = $('causeStats');
      causes.innerHTML = '';
      const byCause = {};
      for (const c of cards) byCause[c.cause] = (byCause[c.cause] || 0) + 1;
      const keys = Object.keys(byCause);
      if (keys.length === 0) stat(causes, 'No lesson cards yet', '—');
      for (const k of keys) stat(causes, CAUSE_LABELS[k] || k, byCause[k]);
    }).catch(function () {
      $('dataNote').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Data controls ----
  $('exportData').addEventListener('click', function () {
    CoachStore.exportAll().then(function (data) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const d = new Date();
      a.download = 'chessy-coach-' + d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      $('dataNote').textContent = 'Exported ' + data.games.length + ' games and ' + data.cards.length + ' cards.';
    }).catch(function (e) {
      $('dataNote').textContent = 'Export failed: ' + (e && e.message ? e.message : e) + '.';
    });
  });

  $('importData').addEventListener('click', function () { $('importFile').click(); });
  // ONE restore at a time: while a large backup is still appending, a
  // second selection of the same file would start another importAll under
  // the same generation and append everything twice.
  let restoreBusy = false;

  $('importFile').addEventListener('change', function () {
    const file = $('importFile').files[0];
    if (!file) return;
    if (restoreBusy) { $('importFile').value = ''; return; }
    restoreBusy = true;
    $('importData').disabled = true;
    function settleRestore() {
      restoreBusy = false;
      $('importData').disabled = false;
    }
    // Capture the generation BEFORE the file read, not inside onload: a
    // "Delete all" clicked while a (large) backup is still being read
    // would otherwise be undone when the read completes and the restore
    // writes the deleted archive back.
    const gen = coachGen;
    const commit = knownDeleteCommit;
    const reader = new FileReader();
    reader.onerror = function () {
      $('importFile').value = '';
      if (!coachWorkInvalidated(gen, commit)) {
        $('dataNote').textContent = 'Could not read the backup file.';
      }
      settleRestore();
    };
    reader.onload = function () {
      $('importFile').value = '';
      if (coachWorkInvalidated(gen, commit)) { settleRestore(); return; }
      let data = null;
      try { data = JSON.parse(reader.result); } catch (e) { /* handled below */ }
      // The restore also checks the generation between records: a
      // "Delete all" clicked mid-restore stops the remaining writes.
      Promise.resolve()
        .then(function () {
          return CoachStore.importAll(data, function () {
            return coachWorkInvalidated(gen, commit);
          }, commit);
        })
        .then(function (n) {
          if (coachWorkInvalidated(gen, commit)) return;
          $('dataNote').textContent = 'Imported ' + n.games + ' games and ' + n.cards + ' cards.';
          renderProgress();
        })
        .catch(function (e) {
          if (e && e.name === 'StaleCoachWriteError') return;
          if (coachWorkInvalidated(gen, commit)) return;
          $('dataNote').textContent = 'Import failed: ' + (e.message || e);
        })
        .then(settleRestore);
    };
    reader.readAsText(file);
  });

  let deleteBusy = false;
  $('deleteData').addEventListener('click', function () {
    if (deleteBusy || activeDeleteIds.size !== 0) return;
    if (!window.confirm('Delete ALL archived games, lesson cards and review history?')) return;
    deleteBusy = true;
    const deleteId = String(Date.now()).padStart(13, '0') + '-' +
      Math.random().toString(36).slice(2);
    localDeleteIds.add(deleteId);
    // New data epoch FIRST: every asynchronous writer (scan, PGN import,
    // JSON restore, archive/card/grade writes) checks its captured
    // generation and abandons instead of writing deleted data back — and
    // the epoch is broadcast so OTHER open tabs invalidate theirs too.
    beginDeleteAttempt(deleteId, []);
    broadcastDeleteEvent(deleteId, 'start');
    CoachStore.deleteAll(deleteId, Array.from(deleteTombstones)).then(function (marker) {
      const commit = marker && typeof marker.token === 'string' ? marker.token : '';
      settleDeleteAttempt(deleteId, true, '', null, commit);
      broadcastDeleteEvent(deleteId, 'commit', commit);
    }, function (e) {
      settleDeleteAttempt(deleteId, false, e && e.message ? e.message : String(e));
      broadcastDeleteEvent(deleteId, 'rollback');
    }).then(function () {
      deleteBusy = false;
      if (activeDeleteIds.size === 0) $('deleteData').disabled = false;
    });
  });

  deleteBootReady = resumeDeleteStateAtBoot().then(function () {
    deleteBootSettled = true;
  }, function () {
    deleteBootSettled = true;
  });

  window.Coach = {
    archiveGame: archiveGame,
    openLatestArchived: openLatestArchived,
    showView: showView
  };
})();
