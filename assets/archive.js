/*
 * Chessy archive — records finished games into the coaching store
 * (assets/store.js). This is the whole slice: no UI reads the archive yet;
 * the Review browser, reflection, and spaced review build on it next
 * (roadmap #23).
 *
 * record() is IDEMPOTENT per game instance: the record's key is the
 * game's UUID (minted at New game/Rematch in app.js and persisted with
 * the saved game), so re-offering the same ending — reopened game-over
 * dialog, reload → undo → replayed finish, the boot reconcile in app.js —
 * overwrites the one record (keeping its earliest completion time), and a
 * REVISED ending (undo → different finish) replaces it. SINGLE-TAB model
 * by design, like the rest of the app; cross-tab semantics live in #44.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  // Durability slot: the record is parked in localStorage until its
  // IndexedDB commit settles. A Rematch can replace the MAIN save while
  // the write is still in flight, and a tab dying before the commit would
  // otherwise lose that finished game with nothing left to reconcile
  // from. ONE slot, holding the LATEST unarchived ending; each park gets
  // its own token and only the commit holding the CURRENT token may clear
  // the slot — an earlier write settling after a revision was parked
  // (undo → different finish while the first write was in flight) must
  // not discard the revision's recoverable copy. reconcilePending()
  // drains the slot on the next boot.
  const PENDING_KEY = 'chessy-pending-archive-v1';
  let writeSeq = 0;

  function parkToken() {
    // Unique across reloads too: a stale slot must never token-match a
    // fresh run's write.
    return 'w' + Date.now().toString(36) + '-' + (++writeSeq);
  }

  function clearPendingIf(token) {
    try {
      const cur = JSON.parse(localStorage.getItem(PENDING_KEY));
      if (cur && cur.w === token) localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      try { localStorage.removeItem(PENDING_KEY); } catch (e2) { /* gone */ }
    }
  }

  function commit(rec, token) {
    return CoachStore.archiveGame(rec).then(function (storedId) {
      if (token) clearPendingIf(token);
      return storedId;
    });
  }

  // Resolves with the stored game id, or rejects when the write failed —
  // the caller surfaces that (a training archive that silently drops
  // games would corrupt every later statistic). A zero-ply game is still
  // archived: a timed game can be forfeit on time before the first move.
  // opts: { endedAt } — the persisted completion time, so a boot-time
  // reconcile keeps the chronology instead of stamping the restart.
  function record(state, settings, status, gameId, opts) {
    if (!gameId || !status.over) {
      return Promise.resolve(null);
    }
    const rec = {
      id: gameId,
      source: 'play',
      tags: {},
      sans: state.history.map(function (h) { return h.san; }),
      // The side the human played — later slices focus feedback on it.
      playerColor: settings.mode === 'ai-b' ? 'w' : settings.mode === 'ai-w' ? 'b' : 'both',
      // Per-move clock evidence ({thinkMs, wMs, bMs} or null): retained so
      // efficiency/impulse diagnoses have data behind them.
      clocks: state.history.map(function (h) { return h.clock || null; }),
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: state.history.length,
      createdAt: (opts && Number.isFinite(opts.endedAt)) ? opts.endedAt : Date.now()
    };
    let token = parkToken();
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ w: token, rec: rec }));
    } catch (e) { token = null; /* best effort */ }
    return commit(rec, token);
  }

  // Boot recovery for a parked record whose commit never settled (rejects
  // when the retry fails too, so the caller can surface it). Resolves null
  // when nothing was pending.
  function reconcilePending() {
    let slot = null;
    try { slot = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { /* corrupt */ }
    const rec = slot && slot.rec;
    if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.sans)) {
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* gone */ }
      return Promise.resolve(null);
    }
    return commit(rec, slot.w);
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending };
})();
