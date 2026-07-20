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
  // Durability slots: each record is parked in localStorage until its
  // IndexedDB commit settles. A Rematch can replace the MAIN save while
  // the write is still in flight, and a tab dying before the commit would
  // otherwise lose that finished game with nothing left to reconcile
  // from. The slot key carries the writing TAB's nonce: concurrent tabs
  // must not overwrite each other's parked records, and one tab's commit
  // must not clear a cloned tab's parked divergent completion just
  // because the two share a gameId. One slot per tab suffices — at most
  // one game-end write is in flight per tab — and reconcilePending()
  // sweeps every slot on the next boot.
  const PENDING_PREFIX = 'chessy-pending-archive-v1:';

  function pendingKey(rec) { return PENDING_PREFIX + (rec.tab || 'unknown'); }

  function clearPendingIf(key, id) {
    try {
      const cur = JSON.parse(localStorage.getItem(key));
      if (cur && cur.id === id) localStorage.removeItem(key);
    } catch (e) {
      try { localStorage.removeItem(key); } catch (e2) { /* gone */ }
    }
  }

  function commit(rec) {
    return CoachStore.archiveGame(rec).then(function (storedId) {
      // id-checked: this tab's slot may already hold a NEWER game's record
      clearPendingIf(pendingKey(rec), rec.id);
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
    try { localStorage.setItem(pendingKey(rec), JSON.stringify(rec)); } catch (e) { /* best effort */ }
    return commit(rec);
  }

  // Boot recovery: sweep EVERY parked slot whose commit never settled —
  // dead tabs leave theirs behind, and cloned tabs each leave their own.
  // Sequential, and rejects when a retry fails (the caller surfaces it);
  // slots not yet reached are retried on the next boot. Resolves null
  // when nothing was pending. Draining a LIVE tab's in-flight slot is
  // harmless: the double archive is idempotent per tab+ending.
  function reconcilePending() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PENDING_PREFIX) === 0) keys.push(k);
      }
    } catch (e) { return Promise.resolve(null); }
    return keys.reduce(function (chain, key) {
      return chain.then(function () {
        let rec = null;
        try { rec = JSON.parse(localStorage.getItem(key)); } catch (e) { /* corrupt */ }
        if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.sans)) {
          try { localStorage.removeItem(key); } catch (e) { /* gone */ }
          return null;
        }
        return commit(rec);
      });
    }, Promise.resolve(null));
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending };
})();
