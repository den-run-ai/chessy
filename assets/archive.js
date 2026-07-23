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

  // Monotonic REVISION SEQUENCE. Every finished ending recorded gets a strictly
  // increasing `rev`, stamped onto the archive record AND (via app.js) the live
  // save, so the three recovery sources a backup merges — the committed row, a
  // parked queue entry, and the finished local save — can be ordered EXACTLY.
  // Wall-clock completion time cannot order revisions (a backward clock stamps a
  // later finish with a smaller time), and "still parked" / "is the live save"
  // are not proof of newest either; the rev is. Persisted so it survives
  // reloads; an in-memory floor keeps it monotonic even if a persist fails.
  const REV_KEY = 'chessy-archive-rev-v1';
  const GAME_SAVE_KEY = 'chessy-game-v1';
  // The sequence lives in the SAFE integer range: a rev must stay below
  // MAX_SAFE_INTEGER so nextRev()'s +1 is always a DISTINCT safe integer. Past
  // 2^53, `x + 1` can equal `x`, which would hand two different endings the same
  // rev and let park()/archiveGame() treat the newer one as stale. Untrusted
  // values (a hand-edited save/queue, a crafted backup) are clamped out of the
  // floor here, and validateBackup rejects a game rev at/above the ceiling.
  const REV_MAX = Number.MAX_SAFE_INTEGER - 1;
  let memRev = 0;
  // A usable floor contribution: a safe integer within the incrementable range,
  // else -Infinity (ignored) — so a poisoned/huge rev can't push the counter
  // into the range where it can no longer strictly increase.
  function usableRev(v) {
    return (Number.isSafeInteger(v) && v >= 0 && v <= REV_MAX) ? v : -Infinity;
  }
  function readRevValue(raw) {
    return usableRev(typeof raw === 'number' ? raw : parseInt(raw, 10));
  }
  // The highest rev any DURABLE, synchronously-readable source already carries.
  // REV_KEY is the primary persisted floor, but its setItem can be SILENTLY
  // dropped at quota while a game save (or a parked entry) that carries a high
  // rev still persists; after a reload `memRev` is 0 and REV_KEY is stale, so an
  // Undo → revised finish would otherwise mint a rev BELOW one a recoverable
  // copy already uses and lose the ordering. Deriving the floor from the live
  // save and the durability queue too keeps the sequence monotonic across that
  // failed write. (Committed IndexedDB rows can't be read synchronously; each
  // boot and every restore seed them explicitly via seedRev() — a revision that
  // persisted ONLY to IndexedDB is thus not lost from the floor either.)
  function durableRevFloor() {
    let floor = memRev;
    try { floor = Math.max(floor, readRevValue(localStorage.getItem(REV_KEY))); }
    catch (e) { /* unreadable */ }
    try {
      const g = JSON.parse(localStorage.getItem(GAME_SAVE_KEY));
      if (g) floor = Math.max(floor, usableRev(g.rev));
    } catch (e) { /* absent/corrupt */ }
    const map = readPending();
    if (map) {
      for (const id of Object.keys(map)) {
        const rec = map[id] && map[id].rec;
        if (rec) floor = Math.max(floor, usableRev(rec.rev));
      }
    }
    return floor;
  }
  function nextRev() {
    // Clamp the floor to REV_MAX so the return is always a safe integer even if
    // some source sits at the ceiling; the caps above keep a real floor far below.
    const rev = Math.min(durableRevFloor(), REV_MAX) + 1;
    memRev = rev;
    try { localStorage.setItem(REV_KEY, String(rev)); }
    catch (e) { /* quota: the floor is re-derived from durable sources next time */ }
    return rev;
  }
  // Raise the floor to at least `rev`. A RESTORE re-adds committed rows the
  // synchronous floor can't see; seeding from their max rev stops a later live
  // finish minting a rev at or below a restored game's, which would let a stale
  // copy of that id outrank the restored one.
  function seedRev(rev) {
    if (usableRev(rev) <= memRev) return; // ignore unusable/huge or not-newer
    memRev = rev;
    try {
      if (!(readRevValue(localStorage.getItem(REV_KEY)) >= rev)) {
        localStorage.setItem(REV_KEY, String(rev));
      }
    } catch (e) { /* quota: in-memory floor still holds this session */ }
  }
  // Same finish re-offered? (identical moves + result + reason, as opposed to a
  // revised completion of the instance) — mirrors store.js so the queue guard
  // agrees with what archiveGame() and the backup merge decide.
  function sameEndingRec(a, b) {
    return Array.isArray(a.sans) && Array.isArray(b.sans) &&
      a.sans.length === b.sans.length &&
      a.sans.every(function (s, i) { return s === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }

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
    const map = readPending() || {};
    const cur = map[rec.id];
    // The queue must always hold the NEWEST unconfirmed ending for an id, so a
    // stale re-offer cannot displace a revision still awaiting recovery. Only a
    // strictly higher rev — or the SAME ending (a fresher write of that finish)
    // — may replace an existing entry. A LOWER-rev finish, or a revless boot
    // re-offer of a DIFFERENT ending than a revless pending revision, is refused
    // and the pending copy stays. Live finishes always carry a rev, so this only
    // ever withholds a demonstrably not-newer copy; the stale record is dropped
    // rather than parked (a null token means commit() clears nothing).
    if (cur && cur.rec) {
      const curRev = Number.isFinite(cur.rec.rev) ? cur.rec.rev : -Infinity;
      const recRev = Number.isFinite(rec.rev) ? rec.rev : -Infinity;
      if (recRev < curRev) return null;
      if (recRev === curRev && !sameEndingRec(cur.rec, rec)) return null;
    }
    const token = parkToken();
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
      // Clear ONLY the entry still holding this write's own token: a later
      // revision that parked under the same id after this write began must keep
      // its copy (its token differs). A stale queue leftover from a failed park
      // is handled at MERGE time by the revision sequence (a lower rev loses),
      // not by an unconditional clear here — that would race a concurrent newer
      // park and could discard the only copy of the latest ending.
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
      createdAt: (opts && Number.isFinite(opts.endedAt)) ? opts.endedAt : Date.now(),
      // Revision order marker. app.js stamps a rev when the game first finishes
      // and passes it here (and into the live save), so a committed row, a
      // parked copy, and the saved game of the SAME id sort exactly. A caller
      // that supplies none is a boot reconcile of a PRE-REV (legacy) save: it is
      // ranked as the OLDEST (revless), NOT minted a fresh rev. Minting one
      // would let a stale legacy snapshot outrank a same-id revision still
      // awaiting recovery in the queue (a fresh nextRev() beats a revless
      // pending entry), permanently discarding the revision. reconcilePending()
      // migrates a genuinely-recovered legacy entry into the sequence instead.
      rev: (opts && Number.isFinite(opts.rev)) ? opts.rev : undefined
    };
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
      // Migrate a legacy (revless) queued finish INTO the rev sequence as it is
      // recovered, so a later revless boot re-offer of the same id can no longer
      // overwrite this committed copy (revless vs revless cannot be ordered). A
      // revision awaiting recovery thereby outranks its stale saved twin once it
      // commits. Live entries already carry a rev; this only touches legacy ones.
      if (!Number.isFinite(rec.rev)) rec.rev = nextRev();
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
    operationActive: operationActive, pendingRecords: pendingRecords,
    nextRev: nextRev, seedRev: seedRev };
})();
