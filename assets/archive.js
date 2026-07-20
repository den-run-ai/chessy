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
  // from. ONE SLOT PER WRITE — the key is tab nonce + write sequence, so
  // no write ever shares a key with another: concurrent tabs cannot
  // overwrite each other's parked records, and overlapping writes in ONE
  // tab (undo → revised ending while the first write is in flight, which
  // even share a gameId) each keep their own recoverable copy; a commit
  // settling removes exactly its own slot. reconcilePending() sweeps
  // every slot on the next boot.
  const PENDING_PREFIX = 'chessy-pending-archive-v1:';
  let writeSeq = 0;

  function clearPending(key) {
    try { localStorage.removeItem(key); } catch (e) { /* gone */ }
  }

  function commit(rec, key) {
    return CoachStore.archiveGame(rec).then(function (storedId) {
      if (key) clearPending(key);
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
    let key = PENDING_PREFIX + (rec.tab || 'unknown') + ':' + (++writeSeq);
    try { localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { key = null; }
    return commit(rec, key);
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
    // WRITE ORDER, not enumeration order (which is user-agent-defined):
    // a tab that parked several revisions of one game needs the later
    // write to land last, or a stale ending would overwrite the final one.
    keys.sort(function (a, b) {
      const pa = a.lastIndexOf(':'), pb = b.lastIndexOf(':');
      const ta = a.slice(0, pa), tb = b.slice(0, pb);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return Number(a.slice(pa + 1)) - Number(b.slice(pb + 1));
    });
    return keys.reduce(function (chain, key) {
      return chain.then(function () {
        let rec = null;
        try { rec = JSON.parse(localStorage.getItem(key)); } catch (e) { /* corrupt */ }
        if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.sans)) {
          clearPending(key);
          return null;
        }
        return commit(rec, key);
      });
    }, Promise.resolve(null));
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending };
})();
