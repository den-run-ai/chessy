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
  const LEGACY_FENCE_KEY = 'chessy-archive-fenced-v1';
  const FENCE_KEY = 'chessy-archive-fenced-v2';
  const FENCE_CAP = 200; // fenced endings never recur; cap only bounds storage
  // v1 concatenated two UNPADDED hashes, so a truncated/replaced 2–16 digit
  // string still looked syntactically valid and could make Backup miss a
  // deliberately cleared ending. v2 uses an unambiguous canonical payload,
  // two fixed-width hashes, and a checksum over the whole versioned envelope.
  // Missing/reordered/replaced entries therefore make the fence UNKNOWN
  // instead of looking like an empty/non-matching set.
  function hex32(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
  function endingSig(id, sans, result, reason) {
    const s = JSON.stringify([String(id), Array.isArray(sans) ? sans : [],
      result == null ? '' : String(result), reason == null ? '' : String(reason)]);
    let a = 5381, b = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) + a + c) | 0;
      b = ((b << 5) + b + (c ^ 0x5f)) | 0;
    }
    return hex32(a) + hex32(b);
  }
  function fenceChecksum(entries) {
    const s = JSON.stringify([2, entries]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return hex32(h);
  }
  function fenceEnvelope(entries) {
    return { version: 2, entries: entries.slice(), checksum: fenceChecksum(entries) };
  }
  function validEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.version !== 2 || !Array.isArray(value.entries) ||
        value.entries.length > FENCE_CAP ||
        typeof value.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(value.checksum)) {
      return false;
    }
    const seen = Object.create(null);
    if (!value.entries.every(function (sig) {
      if (typeof sig !== 'string' || !/^[0-9a-f]{16}$/.test(sig) || seen[sig]) return false;
      seen[sig] = true;
      return true;
    })) return false;
    return value.checksum === fenceChecksum(value.entries);
  }
  function readV2() {
    try {
      const raw = localStorage.getItem(FENCE_KEY);
      if (raw === null) return { known: true, entries: [] };
      const value = JSON.parse(raw);
      return validEnvelope(value)
        ? { known: true, entries: value.entries.slice() }
        : { known: false, entries: [] };
    } catch (e) {
      return { known: false, entries: [] };
    }
  }
  function readFenced() {
    try {
      // A v1 entry has neither recoverable hash boundaries nor integrity
      // metadata. Even alongside a valid v2 envelope it is unverifiable, so
      // fail closed until a successful destructive operation neutralizes all
      // recovery sources and explicitly resets the fence.
      if (localStorage.getItem(LEGACY_FENCE_KEY) !== null) {
        return { known: false, entries: [] };
      }
      return readV2();
    } catch (e) {
      return { known: false, entries: [] };
    }
  }
  function fenceMatch(id, sans, result, reason) {
    const state = readFenced();
    if (!state.known) return null;
    return state.entries.indexOf(endingSig(id, sans, result, reason)) !== -1;
  }
  function isFencedEnding(id, sans, result, reason) {
    if (!id) return false;
    // Boolean callers must fail closed. Internal record/reconcile paths use
    // fenceMatch's tri-state so UNKNOWN work is preserved rather than deleted.
    return fenceMatch(id, sans, result, reason) !== false;
  }
  function writeFenced(entries) {
    try {
      localStorage.setItem(FENCE_KEY, JSON.stringify(fenceEnvelope(entries)));
      const state = readV2();
      return state.known && state.entries.length === entries.length &&
        state.entries.every(function (sig, i) { return sig === entries[i]; });
    } catch (e) {
      return false;
    }
  }
  // Persist one ending as fenced. Returns true only if the signature is now in
  // the stored set (so a caller can fall back — e.g. remove the saved game and
  // suppress future saves — when localStorage is full and it could not write).
  function fenceEnding(id, sans, result, reason) {
    if (!id) return true; // nothing to fence
    const state = readFenced();
    if (!state.known) return false;
    const sig = endingSig(id, sans, result, reason);
    const set = state.entries;
    if (set.indexOf(sig) !== -1) return true; // already fenced
    set.push(sig);
    while (set.length > FENCE_CAP) set.shift();
    return writeFenced(set);
  }
  // Fence a batch of ending records ({id, sans, result, reason} — e.g. the
  // parked durability-queue records). Returns true only if every one persisted.
  function fenceEndings(recs) {
    if (!Array.isArray(recs)) return false;
    const state = readFenced();
    if (!state.known) return false;
    const set = state.entries;
    const required = [];
    let valid = true;
    recs.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !r.id || !Array.isArray(r.sans)) {
        valid = false;
        return;
      }
      const sig = endingSig(r.id, r.sans, r.result, r.reason);
      if (required.indexOf(sig) === -1) required.push(sig);
      if (set.indexOf(sig) === -1) set.push(sig);
    });
    if (!valid) return false;
    // Do not claim that every source is fenced after the cap evicted one of
    // this batch. The caller will fall back to removing the queue.
    if (required.length > FENCE_CAP) return false;
    while (set.length > FENCE_CAP) set.shift();
    if (!required.every(function (sig) { return set.indexOf(sig) !== -1; })) return false;
    return writeFenced(set);
  }
  // During a successful destructive operation, stage the currently readable
  // pending sources in v2 while leaving an unverifiable v1 fence in place.
  // Only resetFence may retire v1, after live/saved sources are neutralized.
  function stageFenceEndings(recs) {
    if (!Array.isArray(recs)) return false;
    const prior = readV2();
    const set = prior.known ? prior.entries : [];
    const required = [];
    let valid = true;
    recs.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !r.id || !Array.isArray(r.sans)) {
        valid = false;
        return;
      }
      const sig = endingSig(r.id, r.sans, r.result, r.reason);
      if (required.indexOf(sig) === -1) required.push(sig);
      if (set.indexOf(sig) === -1) set.push(sig);
    });
    if (!valid) return false;
    if (required.length > FENCE_CAP) return false;
    while (set.length > FENCE_CAP) set.shift();
    if (!required.every(function (sig) { return set.indexOf(sig) !== -1; })) return false;
    return writeFenced(set);
  }
  function fenceKnown() { return readFenced().known; }
  // Called only after a successful destructive replacement has durably
  // neutralized every pending/live/saved recovery source. Write the verified
  // v2 envelope BEFORE retiring v1; a failure leaves UNKNOWN in place.
  function resetFence() {
    const prior = readV2();
    const entries = prior.known ? prior.entries : [];
    // Verify the v2 replacement while v1 is still present (readV2 deliberately
    // ignores the legacy key for this staged migration check).
    if (!writeFenced(entries)) return false;
    try {
      localStorage.removeItem(LEGACY_FENCE_KEY);
      const state = readFenced();
      return state.known && state.entries.length === entries.length &&
        state.entries.every(function (sig, i) { return sig === entries[i]; });
    } catch (e) {
      return false;
    }
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
  // passed the fence check.
  //
  // REFERENCE-COUNTED, not a boolean: if two destructive operations ever
  // overlap, the first to finish must not resume writes while the second is
  // still replacing the store. Writes resume only when the LAST operation ends
  // (depth 0). operationActive() lets the UI serialize operations as the
  // primary guard; the refcount is defense in depth.
  let suspendDepth = 0;
  function setSuspended(on) {
    if (on) suspendDepth++;
    else if (suspendDepth > 0) suspendDepth--;
  }
  function operationActive() { return suspendDepth > 0; }

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
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return null; }
    const map = raw === null ? {} : readPending();
    // Present-but-unreadable is UNKNOWN, not an empty queue. Never overwrite
    // older recoverable bytes just to park the newer ending.
    if (!map) return null;
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
    const sans = state.history.map(function (h) { return h.san; });
    // Fenced ending: a specific finish cleared/replaced by Delete-all or
    // Restore must not be (re)archived — covers the boot re-archive of the
    // saved finished game and a reopened game-over. A REVISED ending of the
    // same instance (Undo → different finish) has a different signature and is
    // NOT fenced, so it archives normally.
    const fence = fenceMatch(gameId, sans, status.result, status.reason);
    if (fence === true) {
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
    // An unreadable/legacy fence is UNKNOWN: park this ending and surface a
    // failure, but never commit it and never silently discard its only copy.
    if (fence === null) {
      park(rec);
      const err = new Error('archive-clear fence is unavailable');
      err.failedGameIds = [gameId];
      return Promise.reject(err);
    }
    // A destructive replace is in progress: PARK the record but do NOT commit
    // it onto the store being replaced. Parking (not dropping) is what keeps a
    // game that finishes during the operation recoverable if the operation
    // FAILS — the parked entry survives a Rematch overwriting the live save and
    // boot-reconciles later. If the operation SUCCEEDS it fences this ending and
    // drops the queue, so the parked copy can't resurrect either.
    if (operationActive()) {
      park(rec);
      return Promise.resolve(null);
    }
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
    // UNKNOWN may represent a damaged signature for one of these exact
    // records. Leave the queue untouched and surface the block; treating every
    // entry as fenced would destroy unrelated recoverable games.
    if (!readFenced().known) {
      const err = new Error('archive-clear fence is unavailable');
      err.failedGameIds = Object.keys(map);
      return Promise.reject(err);
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
    stageFenceEndings: stageFenceEndings, fenceKnown: fenceKnown, resetFence: resetFence,
    dropPendingQueue: dropPendingQueue, setSuspended: setSuspended,
    operationActive: operationActive, pendingRecords: pendingRecords };
})();
