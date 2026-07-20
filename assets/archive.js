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
 * simply overwrites the one record (keeping its original createdAt). A
 * DIFFERENT completion under the same key (cloned tabs that diverged) is
 * stored under a fresh id instead, so no finished game is ever lost.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  // Resolves with the stored game id (which may differ from gameId when a
  // cloned tab already archived a divergent completion — see
  // CoachStore.archiveGame), or rejects when the write failed — the caller
  // surfaces that (a training archive that silently drops games would
  // corrupt every later statistic). A zero-ply game is still archived:
  // a timed game can be forfeit on time before the first move.
  // opts: { endedAt, tab } — endedAt is the persisted completion time (so
  // a boot-time reconcile keeps the chronology instead of stamping the
  // restart); tab is the writing tab's identity (same-tab replay edits
  // overwrite, cloned-tab divergence forks).
  // Durability slot: the record is parked in localStorage until its
  // IndexedDB commit settles. A Rematch can replace the MAIN save while
  // the write is still in flight, and a tab dying before the commit would
  // otherwise lose that finished game with nothing left to reconcile
  // from. One slot suffices: at most one game-end write is in flight per
  // tab, and reconcilePending() drains it on the next boot.
  const PENDING_KEY = 'chessy-pending-archive-v1';

  function clearPendingIf(id) {
    try {
      const cur = JSON.parse(localStorage.getItem(PENDING_KEY));
      if (cur && cur.id === id) localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      try { localStorage.removeItem(PENDING_KEY); } catch (e2) { /* gone */ }
    }
  }

  function commit(rec) {
    return CoachStore.archiveGame(rec).then(function (storedId) {
      clearPendingIf(rec.id); // don't clear a NEWER game's parked record
      return storedId;
    });
  }

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
      createdAt: (opts && Number.isFinite(opts.endedAt)) ? opts.endedAt : Date.now(),
      tab: (opts && opts.tab) || null
    };
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(rec)); } catch (e) { /* best effort */ }
    return commit(rec);
  }

  // Boot recovery for a parked record whose commit never settled (rejects
  // when the retry fails too, so the caller can surface it). Resolves null
  // when nothing was pending.
  function reconcilePending() {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { /* corrupt */ }
    if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.sans)) {
      return Promise.resolve(null);
    }
    return commit(rec);
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending };
})();
