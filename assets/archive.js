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

  // Durability queue: each record is parked in localStorage until its
  // IndexedDB commit settles. A Rematch can replace the MAIN save while
  // the write is still in flight, and a tab dying before the commit would
  // otherwise lose that finished game with nothing left to reconcile
  // from. The queue is a map KEYED BY GAME ID — one entry per game, so a
  // failed write for game A survives game B parking later (a single
  // shared slot would let B overwrite A's only recoverable copy). Within
  // one game the latest park wins (a revised ending supersedes the one it
  // replaced), and each park gets its own token: only the commit holding
  // the entry's CURRENT token may clear it, so an earlier write settling
  // after a revision was parked must not discard the revision's copy.
  // reconcilePending() drains every entry on the next boot.
  const PENDING_KEY = 'chessy-pending-archive-v1';
  let writeSeq = 0;

  function parkToken() {
    // Unique across reloads too: a stale entry must never token-match a
    // fresh run's write.
    return 'w' + Date.now().toString(36) + '-' + (++writeSeq);
  }

  function readPending() {
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_KEY));
      if (map && typeof map === 'object' && !Array.isArray(map)) return map;
    } catch (e) { /* corrupt */ }
    return null;
  }

  function writePending(map) {
    try {
      if (Object.keys(map).length === 0) localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(map));
      return true;
    } catch (e) { return false; }
  }

  function park(rec) {
    const token = parkToken();
    const map = readPending() || {};
    map[rec.id] = { w: token, rec: rec };
    return writePending(map) ? token : null; // quota/blocked → best effort
  }

  function clearPendingIf(id, token) {
    const map = readPending();
    if (!map) return;
    const cur = map[id];
    if (cur && cur.w === token) {
      delete map[id];
      writePending(map);
    }
  }

  function commit(rec, token) {
    return CoachStore.archiveGame(rec).then(function (storedId) {
      if (token) clearPendingIf(rec.id, token);
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
    return commit(rec, park(rec));
  }

  // Boot recovery for parked records whose commits never settled. Every
  // queued entry is retried; entries that commit clear themselves, failed
  // ones STAY PARKED for the next boot, and the promise rejects when any
  // retry failed so the caller can surface it. Resolves null when nothing
  // was pending. Entries are independent games (one per id), so drain
  // order does not matter.
  function reconcilePending() {
    let raw = null;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { /* unavailable */ }
    if (raw === null) return Promise.resolve(null);
    const map = readPending();
    if (!map) { // unparseable — nothing recoverable
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* gone */ }
      return Promise.resolve(null);
    }
    const drains = [];
    let dirty = false;
    for (const id of Object.keys(map)) {
      const entry = map[id];
      const rec = entry && entry.rec;
      if (!rec || typeof rec.id !== 'string' || rec.id !== id || !Array.isArray(rec.sans)) {
        delete map[id]; // malformed entry — drop it
        dirty = true;
        continue;
      }
      drains.push(commit(rec, entry.w));
    }
    // Synchronous with respect to the commits above: their token-matched
    // clears run strictly later, so this write cannot resurrect one.
    // (An empty or invalid-only map is removed outright.)
    if (drains.length === 0) { writePending(map); return Promise.resolve(null); }
    if (dirty) writePending(map);
    return Promise.all(drains.map(function (p) {
      return p.then(function (v) { return { ok: true, v: v }; },
        function (e) { return { ok: false, e: e }; });
    })).then(function (results) {
      const failed = results.find(function (r) { return !r.ok; });
      if (failed) throw failed.e;
      return results.length;
    });
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending };
})();
