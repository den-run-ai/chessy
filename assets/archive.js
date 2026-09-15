/*
 * Chessy archive — records finished games and explicit New Game abandonment
 * checkpoints into the coaching store (assets/store.js). Review, reflection,
 * and spaced review consume those durable snapshots (roadmap #23).
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
  function releaseToken(value) {
    return typeof value === 'string' && value.length <= 32 &&
      value.trim() === value && /^r\d+$/.test(value)
      ? value : null;
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
  function sameEnding(a, b) {
    return !!a && !!b && a.id === b.id &&
      Array.isArray(a.sans) && Array.isArray(b.sans) &&
      a.sans.length === b.sans.length &&
      a.sans.every(function (san, i) { return san === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }
  function validEnding(value, id) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'id,reason,result,sans' &&
      typeof value.id === 'string' && value.id === id && !!value.id &&
      Array.isArray(value.sans) &&
      value.sans.every(function (san) {
        return typeof san === 'string' && san.length > 0;
      }) &&
      ((value.reason === 'resignation' &&
        (value.result === '1-0' || value.result === '0-1')) ||
       (value.reason === 'draw agreement' && value.result === '1/2-1/2'));
  }

  // A damaged Undo tombstone is authority that an outcome may have been
  // withdrawn, even when its exact ending can no longer be trusted enough to
  // delete. Keep that authority keyed by game id for the rest of this page:
  // after reconcile observes the damage, a later transient localStorage read
  // failure must not make the same boot fail open and re-offer the stale save.
  // The durable queue rediscovers the block on every later reload.
  const blockedRetractionIds = new Set();
  let pendingQueueBlocked = false;
  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }
  function retractionEntryState(entry, id) {
    const object = !!entry && typeof entry === 'object' && !Array.isArray(entry);
    // `ending` is tombstone-specific. Treat a missing/damaged `op` as a
    // malformed retraction too instead of reclassifying and deleting it as a
    // bad archive record.
    const tombstoneLike = object && (entry.op === 'retract' || own(entry, 'ending'));
    if (!tombstoneLike) {
      if (entry === undefined) return { kind: 'none', ending: null };
      const rec = object && entry.rec;
      const validArchiveWrapper = object && entry.op === undefined &&
        Object.keys(entry).sort().join(',') === 'rec,w' &&
        typeof entry.w === 'string' && !!entry.w &&
        rec && typeof rec === 'object' && !Array.isArray(rec) &&
        typeof rec.id === 'string' && rec.id === id && !!rec.id &&
        Array.isArray(rec.sans);
      if (validArchiveWrapper) return { kind: 'none', ending: null };
      // Once keyed durable bytes are present, an unrecognizable wrapper may
      // be a tombstone whose discriminator was damaged. Never guess that it
      // was an expendable archive record and delete the only withdrawal
      // authority.
      blockedRetractionIds.add(id);
      return { kind: 'blocked', ending: null };
    }
    if (entry.op === 'retract' && typeof entry.w === 'string' && !!entry.w &&
        Object.keys(entry).sort().join(',') === 'ending,op,w' &&
        validEnding(entry.ending, id)) {
      return { kind: 'valid', ending: entry.ending };
    }
    blockedRetractionIds.add(id);
    return { kind: 'blocked', ending: null };
  }
  function pendingRetractionState(id) {
    if (pendingQueueBlocked) return { kind: 'blocked', ending: null };
    if (blockedRetractionIds.has(id)) return { kind: 'blocked', ending: null };
    const map = readPending();
    if (!map) {
      pendingQueueBlocked = true;
      return { kind: 'blocked', ending: null };
    }
    return retractionEntryState(map[id], id);
  }
  function malformedRetractionBlocked(id) {
    return pendingRetractionState(id).kind === 'blocked';
  }
  function malformedRetractionError(id) {
    const err = new Error('archive retraction recovery is malformed');
    err.failedGameIds = [id];
    err.malformedRetraction = true;
    return err;
  }
  function malformedPendingError() {
    const err = new Error('archive recovery queue is unreadable');
    err.failedGameIds = [];
    err.malformedRecovery = true;
    return err;
  }

  // Writes can overlap by design: a revised finish must not wait behind an
  // older write that is stalled on storage. Track them by exact ending so an
  // Undo retraction can wait out only the write it supersedes, delete once
  // before and once after it, and never erase a newer different revision.
  const activeCommits = new Map();
  const activeRetractions = new Map();
  const completedRetractions = new Map();
  function endingKey(value) {
    return endingSig(value.id, value.sans, value.result, value.reason);
  }
  function trackCommit(rec, promise) {
    const key = endingKey(rec);
    let entries = activeCommits.get(key);
    if (!entries) {
      entries = new Set();
      activeCommits.set(key, entries);
    }
    const entry = { rec: rec, promise: promise };
    entries.add(entry);
    function forget() {
      entries.delete(entry);
      if (entries.size === 0 && activeCommits.get(key) === entries) {
        activeCommits.delete(key);
      }
    }
    promise.then(forget, forget);
    return promise;
  }
  function matchingCommitPromises(expected) {
    const entries = activeCommits.get(endingKey(expected));
    if (!entries) return [];
    return Array.from(entries)
      .filter(function (entry) { return sameEnding(entry.rec, expected); })
      .map(function (entry) { return entry.promise; });
  }
  function matchingRetraction(expected) {
    const entry = activeRetractions.get(endingKey(expected));
    return entry && sameEnding(entry.ending, expected) ? entry : null;
  }
  function afterGameRetractions(id, work) {
    const waits = Array.from(activeRetractions.values())
      .filter(function (entry) { return entry.ending.id === id; })
      .map(function (entry) {
        return entry.promise.then(
          function () { return null; }, function () { return null; });
      });
    return waits.length === 0 ? work() : Promise.all(waits).then(work);
  }
  function rememberRetraction(expected) {
    completedRetractions.set(endingKey(expected), {
      id: expected.id,
      sans: expected.sans.slice(),
      result: expected.result,
      reason: expected.reason
    });
  }
  function forgetRetraction(expected) {
    const key = endingKey(expected);
    const completed = completedRetractions.get(key);
    if (completed && sameEnding(completed, expected)) {
      completedRetractions.delete(key);
    }
  }
  function queuedRetraction(expected) {
    const pending = pendingRetractionState(expected.id);
    return pending.kind === 'valid' && sameEnding(pending.ending, expected);
  }
  // Review and the boot snapshot use this while an exact Undo is active,
  // parked for retry, or has just completed in this document. A later
  // intentional re-adjudication calls recordPrepared(), which forgets the
  // completed marker before storing the new outcome.
  function suppressesEnding(id, sans, result, reason) {
    // An exact valid tombstone suppresses only the ending it names. A damaged
    // tombstone cannot safely name an exact ending, so it suppresses every
    // archive/Review view of that game id until a later boot can recover it.
    if (pendingQueueBlocked || malformedRetractionBlocked(id)) return true;
    const expected = {
      id: id,
      sans: Array.isArray(sans) ? sans : [],
      result: result,
      reason: reason
    };
    if (!validEnding(expected, id)) return false;
    if (matchingRetraction(expected) || queuedRetraction(expected)) return true;
    const completed = completedRetractions.get(endingKey(expected));
    return !!(completed && sameEnding(completed, expected));
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
    try {
      localStorage.removeItem(PENDING_KEY);
      completedRetractions.clear();
      blockedRetractionIds.clear();
      pendingQueueBlocked = false;
      return true;
    } catch (e) { return false; }
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
  function retractionActive() { return activeRetractions.size > 0; }

  function parkToken() {
    // Unique across reloads too: a stale entry must never token-match a
    // fresh run's write.
    return 'w' + Date.now().toString(36) + '-' + (++writeSeq);
  }

  function parsePending(raw) {
    if (raw === null) return {};
    try {
      const map = JSON.parse(raw);
      if (map && typeof map === 'object' && !Array.isArray(map)) return map;
    } catch (e) { /* corrupt */ }
    return null;
  }

  function readPending() {
    try { return parsePending(localStorage.getItem(PENDING_KEY)); }
    catch (e) { return null; }
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

  // Undo is itself durable work. Replace this game's parked archive copy with
  // an exact-ending retraction before the live save is reopened. If the tab
  // dies before IndexedDB cleanup settles, reconcilePending() completes this
  // tombstone on the next boot instead of resurrecting the withdrawn result.
  function parkRetraction(ending) {
    const token = parkToken();
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return null; }
    const map = raw === null ? {} : readPending();
    if (!map) return null;
    if (retractionEntryState(map[ending.id], ending.id).kind === 'blocked') return null;
    map[ending.id] = { w: token, op: 'retract', ending: ending };
    return writePending(map) ? token : null;
  }

  function clearPendingIf(id, token, allowValidRetraction) {
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return false; }
    if (raw === null) return true;
    const map = readPending();
    if (!map) return false;
    const cur = map[id];
    if (!cur) return true;
    // A different token is a newer recovery source. Never clear it on behalf
    // of this write, and let callers that require neutralization fail closed.
    if (!token || cur.w !== token) return false;
    // Archive commits never have authority to remove a retraction. This also
    // catches a parked record whose wrapper was mutated into a tombstone while
    // its IndexedDB write was in flight.
    const retraction = retractionEntryState(cur, id);
    if (retraction.kind === 'blocked' ||
        (retraction.kind === 'valid' && !allowValidRetraction)) return false;
    delete map[id];
    return writePending(map);
  }

  // Retraction completion may find that a newer revision has already replaced
  // its queue slot. That is success: clear only our own token and preserve the
  // newer recovery source.
  function settlePendingIfCurrent(id, token, expected) {
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return false; }
    if (raw === null) return true;
    const map = readPending();
    if (!map) return false;
    const cur = map[id];
    if (!cur || cur.w !== token) return true;
    const state = retractionEntryState(cur, id);
    // A mutation after this exact retraction began turns settlement into a
    // retryable failure. Never erase the newly-unknown authority by token
    // alone.
    if (state.kind !== 'valid' || !sameEnding(state.ending, expected)) return false;
    delete map[id];
    return writePending(map);
  }

  // Best-effort fallback when the retraction tombstone could not initially be
  // parked (for example, quota was momentarily exhausted). A same-signature
  // new archive is held behind the active retraction, so removing the exact
  // old queue entry here cannot eat a newer intentional finish.
  function clearPendingEnding(expected) {
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return false; }
    if (raw === null) return true;
    const map = readPending();
    if (!map) return false;
    const cur = map[expected.id];
    if (!cur) return true;
    const state = retractionEntryState(cur, expected.id);
    if (state.kind === 'blocked') return false;
    const value = state.kind === 'valid' ? state.ending : cur.rec;
    if (!sameEnding(value, expected)) return true;
    delete map[expected.id];
    return writePending(map);
  }

  function commit(rec, token) {
    let write;
    try { write = Promise.resolve(CoachStore.archiveGame(rec)); }
    catch (e) { write = Promise.reject(e); }
    write = trackCommit(rec, write);
    return write.then(function (storedId) {
      if (token) clearPendingIf(rec.id, token);
      // First durable archive write → one-time persistent-storage request
      // (#82). Best-effort and synchronously guarded: it can neither fail
      // nor delay the archive result.
      if (window.ChessyStorageHealth) ChessyStorageHealth.noteDurableWrite();
      return storedId;
    });
  }

  function deleteExactEnding(expected) {
    if (!CoachStore.retractGameEnding) {
      return Promise.reject(new Error('archive retraction is unavailable'));
    }
    try { return Promise.resolve(CoachStore.retractGameEnding(expected)); }
    catch (e) { return Promise.reject(e); }
  }

  function runRetraction(expected, token) {
    const existing = matchingRetraction(expected);
    if (existing) return existing.promise;

    // Snapshot all already-started writes for this exact outcome. A first
    // conditional delete makes Review stop reporting a committed result
    // promptly; the second runs after those writes settle and catches one that
    // committed late. Different revisions are protected by the store's exact
    // comparison.
    const writes = matchingCommitPromises(expected);
    const firstDelete = deleteExactEnding(expected).then(
      function () { return null; }, function () { return null; });
    const settledWrites = Promise.all(writes.map(function (write) {
      return write.then(function () { return null; }, function () { return null; });
    }));
    const key = endingKey(expected);
    const entry = { ending: expected, promise: null, retain: false, token: token };
    const work = Promise.all([firstDelete, settledWrites])
      .then(function () { return deleteExactEnding(expected); })
      .then(function () {
        // If reopening the live save failed, retain the tombstone for one boot
        // so the stale finished save cannot resurrect this exact outcome.
        if (!entry.retain) {
          const cleared = token
            ? settlePendingIfCurrent(expected.id, token, expected)
            : clearPendingEnding(expected);
          if (!cleared) {
            throw new Error('archive retraction could not clear its recovery entry');
          }
        }
        rememberRetraction(expected);
        return expected.id;
      });

    entry.promise = work.then(function (value) {
      if (activeRetractions.get(key) === entry) activeRetractions.delete(key);
      return value;
    }, function (err) {
      if (activeRetractions.get(key) === entry) activeRetractions.delete(key);
      throw err;
    });
    activeRetractions.set(key, entry);
    return entry.promise;
  }

  function retractEnding(id, sans, result, reason) {
    const expected = {
      id: id,
      sans: Array.isArray(sans) ? sans.slice() : sans,
      result: result,
      reason: reason
    };
    if (!validEnding(expected, id)) {
      return Promise.reject(new Error('invalid ending retraction'));
    }
    if (malformedRetractionBlocked(id)) {
      return Promise.reject(malformedRetractionError(id));
    }
    const existing = matchingRetraction(expected);
    if (existing) return existing.promise;
    return runRetraction(expected, parkRetraction(expected));
  }

  // App calls this when its synchronous reopened-game save failed. Keep (or
  // restage) the exact tombstone so the next boot can complete the Undo before
  // considering a stale finished save.
  function retainRetraction(id, sans, result, reason) {
    const expected = {
      id: id,
      sans: Array.isArray(sans) ? sans.slice() : sans,
      result: result,
      reason: reason
    };
    if (!validEnding(expected, id)) return false;
    if (malformedRetractionBlocked(id)) return false;
    const active = matchingRetraction(expected);
    if (active) {
      if (!active.token) {
        active.token = parkRetraction(expected);
        if (!active.token) return false;
      }
      active.retain = true;
      return true;
    }
    return !!parkRetraction(expected);
  }

  // Capture the exact pending entry an incomplete checkpoint supersedes.
  // The abandonment path removes only this token before committing; a newer
  // revision that replaced it in the meantime makes the checkpoint fail safe.
  function pendingToken(id) {
    if (malformedRetractionBlocked(id)) {
      return { known: false, token: null };
    }
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) {
      return { known: false, token: null };
    }
    if (raw === null) return { known: true, token: null };
    const map = readPending();
    if (!map) return { known: false, token: null };
    const entry = map[id];
    if (!entry) return { known: true, token: null };
    if (typeof entry.w !== 'string' || !entry.w) {
      return { known: false, token: null };
    }
    return { known: true, token: entry.w };
  }

  function makeRecord(state, settings, status, gameId, opts) {
    const sans = state.history.map(function (h) { return h.san; });
    return {
      id: gameId,
      source: 'play',
      tags: {},
      sans: sans,
      // The side the human played — later slices focus feedback on it.
      playerColor: settings.mode === 'ai-b' ? 'w' : settings.mode === 'ai-w' ? 'b' : 'both',
      // Per-move clock evidence ({thinkMs, wMs, bMs} or null): retained so
      // efficiency/impulse diagnoses have data behind them.
      clocks: state.history.map(function (h) { return h.clock || null; }),
      // Search evidence is parallel to SAN/clocks (null for human moves).
      // Normalize here as a second trust boundary before either a direct
      // checkpoint commit or a finished-game durability-queue copy.
      ai: state.history.map(function (h) {
        return h.ai && typeof ChessyAiTelemetry !== 'undefined' &&
          ChessyAiTelemetry.sanitizeTelemetry
          ? ChessyAiTelemetry.sanitizeTelemetry(h.ai) : null;
      }),
      // Release at game creation. Per-AI-move entries carry their own release
      // too, so a game resumed after an update remains attributable.
      startedRelease: releaseToken(opts && opts.startedRelease),
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: state.history.length,
      createdAt: (opts && Number.isFinite(opts.archivedAt)) ? opts.archivedAt
        : ((opts && Number.isFinite(opts.endedAt)) ? opts.endedAt : Date.now())
    };
  }

  // Resolves with the stored game id, or rejects when the write failed —
  // the caller surfaces that (a training archive that silently drops
  // games would corrupt every later statistic). A zero-ply game is still
  // archived: a timed game can be forfeit on time before the first move.
  // opts: { endedAt, startedRelease } — persisted completion time and the
  // release that began the game, so a boot-time reconcile keeps chronology
  // and attribution instead of stamping either with the restart.
  function recordPrepared(rec) {
    if (malformedRetractionBlocked(rec.id)) {
      return Promise.reject(malformedRetractionError(rec.id));
    }
    forgetRetraction(rec);
    // Fenced ending: a specific finish cleared/replaced by Delete-all or
    // Restore must not be (re)archived — covers the boot re-archive of the
    // saved finished game and a reopened game-over. A REVISED ending of the
    // same instance (Undo → different finish) has a different signature and is
    // NOT fenced, so it archives normally.
    const fence = fenceMatch(rec.id, rec.sans, rec.result, rec.reason);
    if (fence === true) {
      return Promise.resolve(null);
    }
    // An unreadable/legacy fence is UNKNOWN: park this ending and surface a
    // failure, but never commit it and never silently discard its only copy.
    if (fence === null) {
      park(rec);
      const err = new Error('archive-clear fence is unavailable');
      err.failedGameIds = [rec.id];
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

  function record(state, settings, status, gameId, opts) {
    if (!gameId || !status.over) {
      return Promise.resolve(null);
    }
    const rec = makeRecord(state, settings, status, gameId, opts);
    // Any finish reached while the prior manual outcome is still retracting
    // waits behind it. Otherwise a stalled old write could land after a newer
    // revision, and the retraction's final exact delete would remove that old
    // row while leaving no copy of the newer result. The live save remains the
    // durable source during this short wait.
    return afterGameRetractions(rec.id, function () {
      return recordPrepared(rec);
    });
  }

  // Preserve a non-empty game that New Game is about to replace. This is an
  // archive checkpoint, not a chess result: PGN stays "*" and Review labels
  // it Incomplete/Abandoned rather than scoring a resignation or loss.
  //
  // Unlike a finished ending, do NOT park this in the finished-game recovery
  // queue. The caller keeps the live localStorage save until this direct
  // IndexedDB commit succeeds; on failure it leaves that game in place and
  // asks before discarding. Before the write, remove any OLDER parked finish
  // for the same UUID: the live save is the recovery copy until IndexedDB
  // succeeds, and pre-clearing avoids a half-success where the new row exists
  // but the stale queue still wins Backup or the next boot.
  function recordAbandonedPrepared(rec) {
    const gameId = rec.id;
    if (malformedRetractionBlocked(gameId)) {
      return Promise.reject(malformedRetractionError(gameId));
    }
    const fence = fenceMatch(gameId, rec.sans, rec.result, rec.reason);
    if (fence === true) return Promise.resolve(null);
    if (fence === null) {
      return Promise.reject(new Error('archive-clear fence is unavailable'));
    }
    if (operationActive()) {
      return Promise.reject(new Error('a data operation is in progress'));
    }
    const pending = pendingToken(gameId);
    if (!pending.known) {
      return Promise.reject(new Error('archive recovery queue is unavailable'));
    }
    if (pending.token && !clearPendingIf(gameId, pending.token, true)) {
      return Promise.reject(new Error('archive recovery queue could not be superseded'));
    }
    return commit(rec, null);
  }

  function recordAbandoned(state, settings, status, gameId, opts) {
    if (!gameId || !status || status.over || !state ||
        !Array.isArray(state.history) || state.history.length === 0) {
      return Promise.resolve(null);
    }
    const abandoned = { result: '*', reason: 'abandoned' };
    const rec = makeRecord(state, settings, abandoned, gameId, opts);
    return afterGameRetractions(gameId, function () {
      return recordAbandonedPrepared(rec);
    });
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
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); }
    catch (e) {
      pendingQueueBlocked = true;
      return Promise.reject(malformedPendingError());
    }
    if (raw === null) return Promise.resolve(null);
    const map = parsePending(raw);
    if (!map) {
      // UNKNOWN can be the only surviving withdrawal/archive authority. Keep
      // the bytes intact across reloads and globally suppress rearchive until
      // Restore/Delete All explicitly clears the quarantine.
      pendingQueueBlocked = true;
      return Promise.reject(malformedPendingError());
    }
    // UNKNOWN may represent a damaged signature for an archived record. Such
    // records stay parked and fail closed, but retraction tombstones are safe
    // to execute independently and must still be able to remove an outcome the
    // user withdrew.
    const fenceState = readFenced();
    const drains = [];
    let dirty = false;
    for (const id of Object.keys(map)) {
      const entry = map[id];
      const retraction = retractionEntryState(entry, id);
      if (retraction.kind === 'blocked') {
        drains.push(Promise.resolve({
          ok: false, e: malformedRetractionError(id), id: id
        }));
        continue;
      }
      if (retraction.kind === 'valid') {
        drains.push(runRetraction(retraction.ending, entry.w).then(
          function (v) { return { ok: true, v: v }; },
          function (e) { return { ok: false, e: e, id: id }; }));
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.w !== 'string' || !entry.w) {
        blockedRetractionIds.add(id);
        drains.push(Promise.resolve({
          ok: false, e: malformedRetractionError(id), id: id
        }));
        continue;
      }
      if (entry.op !== undefined) {
        blockedRetractionIds.add(id);
        drains.push(Promise.resolve({
          ok: false, e: malformedRetractionError(id), id: id
        }));
        continue;
      }
      const rec = entry && entry.rec;
      if (!rec || typeof rec.id !== 'string' || rec.id !== id || !Array.isArray(rec.sans)) {
        blockedRetractionIds.add(id);
        drains.push(Promise.resolve({
          ok: false, e: malformedRetractionError(id), id: id
        }));
        continue;
      }
      if (!fenceState.known) {
        const unavailable = new Error('archive-clear fence is unavailable');
        drains.push(Promise.resolve({ ok: false, e: unavailable, id: id }));
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
    // Synchronous with respect to the commits/retractions above: their
    // token-matched clears run strictly later, so this write cannot resurrect
    // one.
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

  window.ChessyArchive = { record: record, recordAbandoned: recordAbandoned,
    retractEnding: retractEnding, retainRetraction: retainRetraction,
    suppressesEnding: suppressesEnding,
    reconcilePending: reconcilePending,
    isFencedEnding: isFencedEnding, fenceEnding: fenceEnding, fenceEndings: fenceEndings,
    stageFenceEndings: stageFenceEndings, fenceKnown: fenceKnown, resetFence: resetFence,
    dropPendingQueue: dropPendingQueue, setSuspended: setSuspended,
    operationActive: operationActive, retractionActive: retractionActive,
    pendingRecords: pendingRecords };
})();
