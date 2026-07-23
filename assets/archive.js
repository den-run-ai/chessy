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

  // Archive-clear fence (Phase 4b3/4b4). A restore or Delete-all fences the
  // exact ENDINGS that could otherwise be re-archived from a recovery source —
  // the locally saved finished game and any parked durability-queue entries.
  // The fence key is a SIGNATURE of the specific ending (game id + its move
  // list + result + reason), NOT the bare game UUID and NOT a wall-clock epoch.
  //   - Signature (not epoch) is immune to a save with no/out-of-order
  //     `endedAt`, a clock moved backward, or two events in the same
  //     millisecond — the failures a timestamp fence has.
  //   - Signature (not bare UUID) lets a REVISED ending of the same game
  //     instance archive: the supported Undo flow keeps the UUID but changes
  //     the continuation, so a different finish has a different signature and
  //     is not fenced, while the exact cleared ending never reappears.
  // record() refuses a fenced ending, so those games never come back, while a
  // new game (or a revision) archives normally. Same-tab by design (#44).
  const FENCE_KEY = 'chessy-archive-fenced-v1';
  const FENCE_CAP = 200; // fenced endings never recur; cap only bounds storage
  // A compact, low-collision signature over the ending that identifies it:
  // the game id plus the moves, result and reason that make one finish
  // distinct from a revision of the same instance (same djb-style double hash
  // used for content ids in pgn.js).
  function endingSig(id, sans, result, reason) {
    const s = String(id) + '' + (Array.isArray(sans) ? sans.join(',') : '') +
      '' + (result == null ? '' : result) + '' + (reason == null ? '' : reason);
    let a = 5381, b = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) + a + c) | 0;
      b = ((b << 5) + b + (c ^ 0x5f)) | 0;
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
  }
  function readFenced() {
    try { const a = JSON.parse(localStorage.getItem(FENCE_KEY)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function isFencedEnding(id, sans, result, reason) {
    if (!id) return false;
    return readFenced().indexOf(endingSig(id, sans, result, reason)) !== -1;
  }
  // Persist one ending as fenced. Returns true only if the signature is now in
  // the stored set (so a caller can fall back — e.g. remove the saved game and
  // suppress future saves — when localStorage is full and it could not write).
  function fenceEnding(id, sans, result, reason) {
    if (!id) return true; // nothing to fence
    const sig = endingSig(id, sans, result, reason);
    const set = readFenced();
    if (set.indexOf(sig) !== -1) return true; // already fenced
    set.push(sig);
    while (set.length > FENCE_CAP) set.shift();
    try { localStorage.setItem(FENCE_KEY, JSON.stringify(set)); return true; }
    catch (e) { return false; } // quota/blocked — caller must fall back
  }
  // Fence a batch of ending records ({id, sans, result, reason} — e.g. the
  // parked durability-queue records). Returns true only if every one persisted.
  function fenceEndings(recs) {
    let ok = true;
    (recs || []).forEach(function (r) {
      if (!fenceEnding(r.id, r.sans, r.result, r.reason)) ok = false;
    });
    return ok;
  }
  // Drop the durability queue (parked, awaiting-commit finished games), so they
  // are not re-inserted after a clear/replace. Returns true on success. Even if
  // this fails (storage momentarily blocked), reconcilePending() honours the
  // fence, so a fenced ending is not re-committed when storage recovers.
  function dropPendingQueue() {
    try { localStorage.removeItem(PENDING_KEY); return true; } catch (e) { return false; }
  }

  // Suspend live archive writes while a destructive operation (restore /
  // Delete-all) is replacing the store. A live game that flags on time or an
  // AI move that finishes the game BETWEEN the operation queuing its
  // transaction and its success handler must not queue archiveGame() on top of
  // the replacement — fencing only afterward cannot stop a write that already
  // passed the fence check. record() short-circuits while suspended, so no such
  // write is queued behind the operation's transaction.
  let suspended = false;
  function setSuspended(on) { suspended = !!on; }

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
    // A destructive replace is in progress: dropping this write is what keeps a
    // live game that finishes DURING a restore/Delete-all from landing on top
    // of the replacement (the operation fences this ending afterward, so a boot
    // reconcile won't re-add it either).
    if (suspended) return Promise.resolve(null);
    const sans = state.history.map(function (h) { return h.san; });
    // Fenced ending: a specific finish cleared/replaced by Delete-all or
    // Restore must not be (re)archived — covers the boot re-archive of the
    // saved finished game and a reopened game-over. A REVISED ending of the
    // same instance (Undo → different finish) has a different signature and is
    // NOT fenced, so it archives normally.
    if (isFencedEnding(gameId, sans, status.result, status.reason)) {
      return Promise.resolve(null);
    }
    const rec = {
      id: gameId,
      source: 'play',
      tags: {},
      sans: sans,
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
  // retry failed so the caller can surface it — the rejection carries
  // `failedGameIds` so the caller can blame the specific games (and
  // withdraw the blame when a later replacement write succeeds). Resolves
  // null when nothing was pending. Entries are independent games (one per
  // id), so drain order does not matter and one entry failing never stops
  // another from committing.
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
      // A restore/Delete-all fenced this ending but couldn't drop the queue
      // (storage momentarily blocked): honour the fence here so the cleared
      // game is discarded, not re-committed on top of the restored archive when
      // storage recovers.
      if (isFencedEnding(rec.id, rec.sans, rec.result, rec.reason)) {
        delete map[id];
        dirty = true;
        continue;
      }
      drains.push(commit(rec, entry.w).then(
        function (v) { return { ok: true, v: v }; },
        function (e) { return { ok: false, e: e, id: id }; }));
    }
    // Synchronous with respect to the commits above: their token-matched
    // clears run strictly later, so this write cannot resurrect one.
    // (An empty or invalid-only map is removed outright.)
    if (drains.length === 0) { writePending(map); return Promise.resolve(null); }
    if (dirty) writePending(map);
    return Promise.all(drains).then(function (results) {
      const failures = results.filter(function (r) { return !r.ok; });
      if (failures.length === 0) return results.length;
      const err = failures[0].e instanceof Error
        ? failures[0].e
        : new Error('archive reconcile failed: ' + failures[0].e);
      err.failedGameIds = failures.map(function (f) { return f.id; });
      throw err;
    });
  }

  // The parked (awaiting-commit) game records, so a backup can include a
  // finished game recoverable ONLY from the durability queue (its IndexedDB
  // write failed): omitting it would silently drop an unrecomputable game.
  function pendingRecords() {
    const map = readPending();
    if (!map) return [];
    const out = [];
    for (const id of Object.keys(map)) {
      const rec = map[id] && map[id].rec;
      if (rec && typeof rec.id === 'string' && Array.isArray(rec.sans)) out.push(rec);
    }
    return out;
  }

  window.ChessyArchive = { record: record, reconcilePending: reconcilePending,
    isFencedEnding: isFencedEnding, fenceEnding: fenceEnding, fenceEndings: fenceEndings,
    dropPendingQueue: dropPendingQueue, setSuspended: setSuspended,
    pendingRecords: pendingRecords };
})();
