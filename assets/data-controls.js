/*
 * Chessy archive data controls (roadmap #23, Phase 4b).
 *
 * 4b2 (this file, so far): "Back up (JSON)" downloads a versioned snapshot of
 * the durable archive (games + cards). Restore (4b3) and a fenced Delete-all
 * (4b4) attach their handlers here in later slices.
 *
 * Correctness lives in store.js; this file is transport, fencing and feedback.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof CoachReview === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const statusEl = $('dataStatus');
  if (!statusEl) return;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }

  // Reconstruct a finished game saved ONLY in chessy-game-v1 (app.js's live
  // save) as an archive record, or null if there is no valid finished save.
  // Mirrors what app.js would archive: replay the saved moves (rejecting a
  // corrupt save rather than fabricating a record), derive result/reason —
  // honouring a saved time forfeit, which the rules engine knows nothing about
  // — and carry the game's id and completion time so a later restore keeps its
  // chronology. Only a FINISHED game is returned (an in-progress save is not
  // archived until it ends).
  const GAME_SAVE_KEY = 'chessy-game-v1';
  const PENDING_KEY = 'chessy-pending-archive-v1';
  const LEGACY_FENCE_KEY = 'chessy-archive-fenced-v1';
  const FENCE_KEY = 'chessy-archive-fenced-v2';
  const FENCE_CAP = 200;
  // A destructive operation (restore / Delete-all) holds this mutex while it
  // runs, so the two can never overlap: a second confirm is refused rather than
  // racing a shared suspension and fence. archive.js reference-counts the
  // suspension too, as defense in depth.
  let opInFlight = false;
  function savedFinishedRecord(readState) {
    if (typeof Chess === 'undefined') return null;
    let raw;
    try { raw = localStorage.getItem(GAME_SAVE_KEY); }
    catch (e) {
      if (readState) readState.failed = true;
      return null;
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { return null; }
    if (!data || typeof data.gameId !== 'string' || !Array.isArray(data.history)) return null;
    let s = Chess.newGameState();
    const sans = [], clocks = [];
    for (let i = 0; i < data.history.length; i++) {
      const entry = data.history[i];
      if (!entry || !entry.move) return null;
      const legal = Chess.legalMoves(s);
      const m = legal.find(function (x) {
        return x.from === entry.move.from && x.to === entry.move.to &&
               (x.promotion || null) === (entry.move.promotion || null);
      });
      if (!m) return null; // corrupt save — don't fabricate a record
      sans.push(Chess.toSan(s, m, legal));
      clocks.push(entry.clock || null);
      s = Chess.playMove(s, m);
    }
    let status;
    if (data.timeForfeit && (data.timeForfeit.color === 'w' || data.timeForfeit.color === 'b')) {
      status = { over: true,
        result: data.timeForfeit.draw ? '1/2-1/2' : (data.timeForfeit.color === 'w' ? '0-1' : '1-0'),
        reason: data.timeForfeit.draw ? 'time forfeit (no mating material)' : 'time forfeit' };
    } else {
      status = Chess.gameStatus(s);
    }
    if (!status.over) return null; // in-progress — not archived until it finishes
    return {
      id: data.gameId,
      source: 'play',
      tags: {},
      sans: sans,
      playerColor: data.mode === 'ai-b' ? 'w' : data.mode === 'ai-w' ? 'b' : 'both',
      clocks: clocks,
      result: status.result,
      reason: status.reason,
      mode: data.mode,
      difficulty: data.difficulty,
      timeControl: data.timeControl,
      plies: sans.length,
      createdAt: Number.isFinite(data.endedAt) ? data.endedAt : Date.now()
    };
  }

  // The same ENDING (identical moves + result + reason) — as opposed to a
  // REVISED completion of the instance. Mirrors store.js's sameEnding so the
  // backup merge agrees with what archiveGame() would have done.
  function sameEnding(a, b) {
    return Array.isArray(a.sans) && Array.isArray(b.sans) &&
      a.sans.length === b.sans.length &&
      a.sans.every(function (s, i) { return s === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }

  // Drop cards for `id` at or after the first ply where the moves diverge —
  // exactly what archiveGame() does when a revised ending replaces an old one
  // (store.js pruneFromDivergence). Without this a backup carrying a parked
  // revision would still ship lesson cards from the abandoned continuation.
  function pruneCardsFromDivergence(cards, id, oldSans, newSans) {
    let p = 0;
    while (p < oldSans.length && p < newSans.length && oldSans[p] === newSans[p]) p++;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i] && cards[i].gameId === id && cards[i].ply >= p) cards.splice(i, 1);
    }
  }

  // Read the durability queue without archive.js. A partial offline release
  // can leave this transport module available while ChessyArchive is absent;
  // backup must still include the only copy of a finished game.
  function rawPendingRecords() {
    let raw;
    try { raw = localStorage.getItem(PENDING_KEY); }
    catch (e) { throw new Error('could not read the pending-game recovery queue'); }
    if (raw == null) return [];
    let map;
    try {
      map = JSON.parse(raw);
    } catch (e) {
      throw new Error('the pending-game recovery queue is unreadable');
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('the pending-game recovery queue is malformed');
    }
    const out = [];
    Object.keys(map).forEach(function (id) {
      const entry = map[id];
      const rec = entry && entry.rec;
      // This queue can hold the only durable copy of a finished game. Treat
      // any damaged entry as unknown queue state instead of filtering it out
      // and advertising a successful (but incomplete) backup. Validate the
      // wrapper written by archive.js, its keyed identity, and the same fields
      // restore requires for a usable game row.
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.w !== 'string' || !entry.w ||
          !rec || typeof rec !== 'object' || Array.isArray(rec) ||
          typeof rec.id !== 'string' || !rec.id || rec.id !== id ||
          !Array.isArray(rec.sans) ||
          !rec.sans.every(function (san) {
            return typeof san === 'string' && san.length > 0;
          }) ||
          typeof rec.result !== 'string' || !rec.result ||
          !Number.isInteger(rec.plies) || rec.plies !== rec.sans.length ||
          !Number.isFinite(rec.createdAt)) {
        throw new Error('the pending-game recovery queue is malformed');
      }
      out.push(rec);
    });
    return out;
  }

  // Backup must be able to honour archive-clear fences even when archive.js is
  // missing (for example, a partial offline release). This exactly mirrors its
  // v2 encoding: canonical fields, two fixed-width hashes, and an envelope
  // checksum that covers version, count, order, and every entry. Unlike the
  // old unpadded v1 strings, truncation/replacement/removal is detectable.
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
  function validFenceEnvelope(value) {
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

  function rawFenceSignatures() {
    let legacy, raw;
    try {
      legacy = localStorage.getItem(LEGACY_FENCE_KEY);
      raw = localStorage.getItem(FENCE_KEY);
    }
    catch (e) { throw new Error('could not read the archive-clear fence'); }
    if (legacy !== null) {
      throw new Error('the archive-clear fence uses an unverifiable legacy format');
    }
    if (raw == null) return [];
    let value;
    try { value = JSON.parse(raw); }
    catch (e) { throw new Error('the archive-clear fence is unreadable'); }
    if (!validFenceEnvelope(value)) {
      throw new Error('the archive-clear fence is malformed');
    }
    return value.entries;
  }
  // Partial-cache fallback for retiring UNKNOWN fence state after every
  // recovery source was durably removed. Write v2 first; never remove v1 when
  // the replacement cannot be persisted and verified.
  function resetRawFence() {
    try {
      localStorage.setItem(FENCE_KEY, JSON.stringify(fenceEnvelope([])));
      const value = JSON.parse(localStorage.getItem(FENCE_KEY));
      if (!validFenceEnvelope(value) || value.entries.length !== 0) return false;
      localStorage.removeItem(LEGACY_FENCE_KEY);
      const verified = JSON.parse(localStorage.getItem(FENCE_KEY));
      return localStorage.getItem(LEGACY_FENCE_KEY) === null &&
        validFenceEnvelope(verified) && verified.entries.length === 0;
    } catch (e) {
      return false;
    }
  }

  // Merge the recovery sources IndexedDB can't see into the exported snapshot,
  // as one canonical routine so a backup can't silently drop or misrepresent a
  // finished game. exportAll gives the committed rows; a parked durability-queue
  // record (in-flight/failed write) and the finished local save (chessy-game-v1)
  // may each hold a NEWER copy. For each such record, applied newest-last
  // (committed < local save < pending):
  //   - identical ending re-offered → keep the committed row, but retain the
  //     EARLIEST createdAt (archiveGame's same-ending rule — never export a
  //     later completion time that would reorder the list);
  //   - a genuine REVISION (same id, different moves) → the recovery copy wins
  //     AND its abandoned-continuation cards are pruned at the divergence;
  //   - a new id → added.
  // `keep(rec)` lets a caller veto a record (e.g. a fenced ending on the
  // restore branch) before it is merged.
  function mergeRecoverySources(data, keep) {
    const games = data.stores.games || (data.stores.games = []);
    const cards = data.stores.cards || (data.stores.cards = []);
    // Game ids are user-controlled strings (imports/restores included).
    // A null-prototype map keeps "__proto__" enumerable and round-trippable.
    const byId = Object.create(null);
    games.forEach(function (g) { byId[g.id] = g; });
    function apply(rec) {
      if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.sans)) return;
      if (keep && !keep(rec)) return;
      const cur = byId[rec.id];
      if (cur && sameEnding(cur, rec)) {
        if (Number.isFinite(rec.createdAt) && Number.isFinite(cur.createdAt)) {
          cur.createdAt = Math.min(cur.createdAt, rec.createdAt);
        }
        return; // keep the committed record's moves and earliest date
      }
      if (cur) pruneCardsFromDivergence(cards, rec.id, cur.sans, rec.sans);
      byId[rec.id] = rec; // new id, or a revision that supersedes the committed row
    }
    // Local save first, pending queue last: a still-parked write is the most
    // recent authoritative intent, so it wins over the live save on a genuine
    // difference.
    const saved = savedFinishedRecord();
    if (saved) apply(saved);
    // Read the durable source directly even when archive.js is present:
    // pendingRecords() intentionally turns an unreadable queue into [], which
    // is fine for best-effort boot recovery but unsafe for an advertised
    // backup. Unknown must fail the backup, not be mistaken for empty.
    rawPendingRecords().forEach(apply);
    data.stores.games = Object.keys(byId).map(function (id) { return byId[id]; });
  }

  // ---- Back up ----------------------------------------------------------
  const backupBtn = $('backupBtn');
  if (backupBtn) {
    backupBtn.addEventListener('click', function () {
      setStatus('Preparing backup…', 'info');
      CoachStore.exportAll().then(function (data) {
        // Exclude fenced endings: a restore/Delete-all deliberately removed
        // them, so a still-present saved/parked copy must not be carried back
        // into an export (and thence a future restore). Read the persisted
        // fence directly so this remains true when archive.js is absent, and
        // so an unreadable fence fails closed instead of being mistaken for an
        // empty set.
        const fenced = rawFenceSignatures();
        mergeRecoverySources(data, function (rec) {
          return fenced.indexOf(endingSig(
            rec.id, rec.sans, rec.result, rec.reason)) === -1;
        });
        const json = JSON.stringify(data);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = 'chessy-backup-' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after the click has dispatched, not synchronously — some
        // engines cancel an in-flight download when the URL is revoked too soon.
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        const games = (data.stores.games || []).length;
        const cards = (data.stores.cards || []).length;
        setStatus('Backed up ' + games + ' game' + (games === 1 ? '' : 's') +
          ' and ' + cards + ' card' + (cards === 1 ? '' : 's') + '.', 'info');
      }).catch(function (err) {
        setStatus('Backup failed: ' + (err && err.message ? err.message : 'storage unavailable'), 'error');
      });
    });
  }

  function refresh() { return Promise.resolve(CoachReview.refreshGames()); }
  function total(counts) {
    return Object.keys(counts || {}).reduce(function (n, k) { return n + counts[k]; }, 0);
  }
  function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  }
  // Stop an in-flight analysis before its inputs are replaced/cleared.
  function cancelAnalysis() {
    if (typeof ChessyAnalysisService !== 'undefined' && ChessyAnalysisService.cancel) {
      try { ChessyAnalysisService.cancel(); } catch (e) { /* best effort */ }
    }
  }
  // Fence AND neutralize every recovery source AFTER a successful clear/replace
  // so no cleared game reappears. By ENDING SIGNATURE, not bare id or timestamp:
  // fence each parked ending, REMOVE the durability queue, and tell the app to
  // fence its live finished game (app.js listens on 'chessy:archivecleared'
  // and, if it can't persist the fence, removes the saved game and suppresses
  // re-saving it). Fencing the ending (not the whole instance) lets a later
  // Undo → revised finish still archive.
  //
  // Returns true only if EVERY source was durably neutralized (fenced write
  // persisted, or the source removed). A fence is only honoured if its write
  // actually persisted, so on quota/blocked storage the removals — which free
  // space and succeed anyway — are what guarantee neutralization; if even a
  // removal fails the caller must NOT report an unqualified success, since a
  // later reload could resurrect the surviving source. Runs only on success — a
  // failed/aborted operation never loses the queue or fences a live game.
  function fenceRecovery() {
    let ok = true;
    let fenceWasKnown = true;
    let pendingSafe = false;
    let pendingRemoved = false;
    if (typeof ChessyArchive !== 'undefined') {
      const v2Capable = typeof ChessyArchive.fenceKnown === 'function' &&
        typeof ChessyArchive.stageFenceEndings === 'function' &&
        typeof ChessyArchive.resetFence === 'function';
      if (!v2Capable) {
        // A mixed cached release may expose the old v1-only archive module.
        // Do not mistake its writes for verified v2 state or retire v1 while
        // that older app may still be preserving a live save behind it.
        fenceWasKnown = false;
        ok = false;
      }
      try {
        if (v2Capable) fenceWasKnown = ChessyArchive.fenceKnown();
        // Use the strict transport reader, not archive.js's best-effort boot
        // view: a damaged/blocked queue cannot be mistaken for empty while a
        // destructive operation is deciding whether it is safe to retire v1.
        const pending = rawPendingRecords();
        if (pending.length === 0) {
          pendingSafe = true;
        } else if (fenceWasKnown && ChessyArchive.fenceEndings) {
          pendingSafe = ChessyArchive.fenceEndings(pending);
        } else if (!fenceWasKnown && v2Capable) {
          // Stage a verified v2 envelope without retiring v1. The legacy
          // unknown remains fail-closed until live/saved sources below are
          // durably neutralized.
          pendingSafe = ChessyArchive.stageFenceEndings(pending);
        }
      } catch (e) {
        pendingSafe = false;
        if (v2Capable) {
          try { fenceWasKnown = ChessyArchive.fenceKnown(); } catch (e2) { fenceWasKnown = false; }
        }
      }
      // Removal is the fallback when the fence/queue cannot be read or written.
      // It also frees quota before the app fences the live saved ending.
      try {
        if (ChessyArchive.dropPendingQueue && ChessyArchive.dropPendingQueue()) {
          pendingSafe = true;
          pendingRemoved = true;
        }
      } catch (e) { /* pendingSafe decides below */ }
    } else {
      // Archive module absent (partial cache eviction): still neutralize the
      // queue via raw localStorage, or a later boot with the module loaded would
      // reconcile pre-clear games into the replacement.
      try { rawFenceSignatures(); } catch (e) { fenceWasKnown = false; }
      try {
        localStorage.removeItem(PENDING_KEY);
        pendingSafe = localStorage.getItem(PENDING_KEY) === null;
        pendingRemoved = pendingSafe;
      } catch (e) { pendingSafe = false; }
    }
    if (!pendingSafe && !pendingRemoved) ok = false;
    // The live saved finished game: app.js fences its ending or removes the
    // save, reporting back through the event's MUTABLE detail (dispatch is
    // synchronous, so detail is set on return).
    const detail = { neutralized: true };
    try { document.dispatchEvent(new CustomEvent('chessy:archivecleared', { detail: detail })); }
    catch (e) { ok = false; } // very old engines without the CustomEvent constructor
    if (!detail.neutralized) ok = false;

    // The persisted save can be a different finished game from the live one
    // when a later save failed. Neutralize that actual on-disk recovery source
    // too; otherwise it can reappear on the next boot.
    const saveRead = { failed: false };
    const persisted = savedFinishedRecord(saveRead);
    if (saveRead.failed) {
      // Unknown is not the same as absent: remove the unreadable recovery
      // source, or qualify success if storage will not let us neutralize it.
      try { localStorage.removeItem(GAME_SAVE_KEY); }
      catch (e) { ok = false; }
    } else if (persisted) {
      let neutralized = false;
      if (typeof ChessyArchive !== 'undefined' && ChessyArchive.fenceEnding) {
        // fenceEnding returns true for an exact already-persisted v2 entry,
        // but false for UNKNOWN. Do not let isFencedEnding's fail-closed
        // boolean masquerade as proof of durable neutralization.
        neutralized = ChessyArchive.fenceEnding(
          persisted.id, persisted.sans, persisted.result, persisted.reason);
      }
      if (!neutralized) {
        try {
          localStorage.removeItem(GAME_SAVE_KEY);
          neutralized = localStorage.getItem(GAME_SAVE_KEY) === null;
        }
        catch (e) { ok = false; }
      }
      if (!neutralized) ok = false;
    }

    // A legacy/malformed fence may be retired only AFTER all possible recovery
    // sources above were fenced, removed, or session-suppressed. resetFence
    // writes and verifies the v2 envelope before removing v1. If anything was
    // not neutralized, leave UNKNOWN intact so runtime and Backup keep failing
    // closed.
    if (!fenceWasKnown && ok) {
      const reset = (typeof ChessyArchive !== 'undefined' && ChessyArchive.resetFence)
        ? ChessyArchive.resetFence()
        : resetRawFence();
      if (!reset) ok = false;
    }
    return ok;
  }

  // Block every store write while a destructive replacement is in flight.
  // Restore/Delete-all bypass the store lock internally; archive writes are
  // parked separately so a failed operation does not lose a finished game.
  function suspendWrites(on) {
    if (CoachStore.setOpLock) {
      try { CoachStore.setOpLock(on); } catch (e) { /* best effort */ }
    }
    if (typeof ChessyArchive !== 'undefined' && ChessyArchive.setSuspended) {
      try { ChessyArchive.setSuspended(on); } catch (e) { /* best effort */ }
    }
  }

  // Replay every game in a backup from its own starting position before the
  // destructive transaction: a record can have a valid key and `sans` array yet
  // still be unreplayable (an illegal SAN, a corrupt SetUp/FEN), which Review
  // would later reject — the user must not lose their archive to swap in a
  // backup the app cannot actually open. Returns an error string or null.
  function replayError(data) {
    if (typeof Chess === 'undefined') return null; // cannot check here; structure was validated
    const games = (data.stores && data.stores.games) || [];
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      let s;
      try {
        s = g.setupFen ? Chess.parseFen(g.setupFen) : Chess.newGameState();
        if (!s.history) s.history = [];
        if (!s.positions) { s.positions = {}; s.positions[Chess.positionKey(s)] = 1; }
      } catch (e) { return 'game ' + (i + 1) + ' has an invalid starting position'; }
      const sans = g.sans || [];
      for (let k = 0; k < sans.length; k++) {
        const legal = Chess.legalMoves(s);
        const m = legal.find(function (mv) { return Chess.toSan(s, mv, legal) === sans[k]; });
        if (!m) return 'game ' + (i + 1) + ', move ' + (k + 1) + ' ("' + sans[k] + '") is not legal';
        s = Chess.playMove(s, m);
      }
    }
    return null;
  }

  // ---- Restore ----------------------------------------------------------
  const restoreBtn = $('restoreBtn');
  const restoreFile = $('restoreFile');
  const restoreDialog = $('restoreConfirmDialog');
  let pendingRestore = null;

  let restoreGen = 0; // bumped per file choice; a stale read no longer applies
  const MAX_RESTORE_BYTES = 32 * 1024 * 1024; // 32 MB — bounds a hostile/huge file

  if (restoreBtn && restoreFile && restoreDialog) {
    restoreBtn.addEventListener('click', function () { restoreFile.click(); });

    restoreFile.addEventListener('change', function () {
      const file = restoreFile.files && restoreFile.files[0];
      restoreFile.value = ''; // let the SAME file be chosen again later
      if (!file) return;
      const myGen = ++restoreGen; // a slower earlier read must not overwrite a newer choice
      // Reject an oversized file BEFORE reading it: readAsText buffers the whole
      // payload and JSON.parse is synchronous, so a huge (or hostile) file would
      // freeze or OOM the page before the user could cancel. A real archive of
      // thousands of clocked games is still well under this ceiling.
      if (file.size > MAX_RESTORE_BYTES) {
        setStatus('That file is too large (' + Math.round(file.size / 1048576) +
          ' MB) to restore. Nothing was changed.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        if (myGen !== restoreGen) return; // superseded by a newer file selection
        let data;
        try { data = JSON.parse(String(reader.result || '')); }
        catch (e) { setStatus('That file is not valid JSON — nothing was changed.', 'error'); return; }
        const err = CoachStore.validateBackup(data);
        if (err) { setStatus('Not a usable backup (' + err + '). Nothing was changed.', 'error'); return; }
        const rErr = replayError(data);
        if (rErr) { setStatus('Backup has an unplayable game (' + rErr + '). Nothing was changed.', 'error'); return; }
        pendingRestore = data;
        const g = (data.stores.games || []).length;
        const c = (data.stores.cards || []).length;
        $('restoreConfirmText').textContent =
          'This replaces your entire archive with the backup: ' + g + ' game' +
          (g === 1 ? '' : 's') + ' and ' + c + ' lesson card' + (c === 1 ? '' : 's') +
          '. Your current games and cards will be removed. This cannot be undone.';
        openDialog(restoreDialog);
        $('restoreCancel').focus();
      };
      reader.onerror = function () {
        if (myGen !== restoreGen) return;
        setStatus('Could not read that file.', 'error');
      };
      reader.readAsText(file);
    });

    $('restoreConfirm').addEventListener('click', function () {
      const data = pendingRestore;
      pendingRestore = null;
      closeDialog(restoreDialog);
      if (!data) return;
      // Mutex: never let a restore overlap another restore or a Delete-all.
      if (opInFlight) {
        setStatus('Another data operation is already in progress. Try again once it finishes.', 'error');
        return;
      }
      opInFlight = true;
      setStatus('Restoring…', 'info');
      cancelAnalysis(); // stop an in-flight analysis before replacing its inputs
      // Suspend live archive writes BEFORE the destructive transaction: a timed
      // game that flags or an AI move that finishes the game while the restore
      // is in flight must be PARKED, not landed on top of the replacement.
      suspendWrites(true);
      CoachStore.restoreAll(data).then(function (counts) {
        // Committed. Fence recovery ONLY now (on success); a failed/aborted
        // restore leaves the durability queue and saved game untouched.
        const neutralized = fenceRecovery();
        suspendWrites(false);
        opInFlight = false;
        const msg = 'Restored ' + total(counts) + ' record' + (total(counts) === 1 ? '' : 's') +
          ' (' + (counts.games || 0) + ' games, ' + (counts.cards || 0) + ' cards).' +
          (neutralized ? '' : ' Reload once storage is available so the old game cannot return.');
        // Force the Review panel back to a fresh list even if a stale game was
        // left open (refreshGames no-ops then): otherwise a Verify/Save on that
        // removed game could recreate an orphan card/analysis. A refresh failure
        // is COSMETIC — the restore already landed.
        return Promise.resolve(CoachReview.resetToList()).then(
          function () { setStatus(msg, neutralized ? 'info' : 'error'); },
          function () { setStatus(msg + ' Reopen Review to see them.', neutralized ? 'info' : 'error'); }
        );
      }).catch(function (err) {
        // restoreAll is atomic AND the fence runs only on success, so on
        // failure the old archive and its recovery sources are all intact. A
        // finish that arrived while suspended was PARKED, so it survives to the
        // next boot rather than being lost.
        suspendWrites(false);
        opInFlight = false;
        setStatus('Restore failed: ' + (err && err.message ? err.message : 'unknown error') +
          '. Your existing archive is unchanged.', 'error');
      });
    });
    $('restoreCancel').addEventListener('click', function () {
      pendingRestore = null;
      closeDialog(restoreDialog);
      setStatus('Restore cancelled — nothing was changed.', 'info');
    });
    restoreDialog.addEventListener('cancel', function () {
      pendingRestore = null;
      setStatus('Restore cancelled — nothing was changed.', 'info');
    });
  }

  // ---- Delete all (fenced) ---------------------------------------------
  const deleteBtn = $('deleteAllBtn');
  const deleteDialog = $('deleteAllDialog');
  if (deleteBtn && deleteDialog) {
    deleteBtn.addEventListener('click', function () {
      openDialog(deleteDialog);
      $('deleteAllCancel').focus();
    });
    $('deleteAllCancel').addEventListener('click', function () { closeDialog(deleteDialog); });
    $('deleteAllConfirm').addEventListener('click', function () {
      closeDialog(deleteDialog);
      // Mutex: never let a Delete-all overlap another Delete-all or a restore.
      if (opInFlight) {
        setStatus('Another data operation is already in progress. Try again once it finishes.', 'error');
        return;
      }
      opInFlight = true;
      setStatus('Deleting…', 'info');
      cancelAnalysis();
      // Suspend live archive writes so a game that finishes DURING the clear is
      // PARKED, not landed on top of the emptied store. Fence the recovery
      // sources ONLY AFTER the clear COMMITS: a parked durability-queue entry
      // can be the only recoverable copy of a game precisely when IndexedDB is
      // failing, so a rejected clear must leave the queue and the saved game
      // intact — reporting "Delete failed" while discarding them would be the
      // very data loss the delete is meant to prevent. On success, fence the
      // exact cleared endings (by signature, so a later Undo → revised finish
      // still archives) and drop the queue; reconcilePending() honours the
      // fence even if the drop is momentarily blocked.
      suspendWrites(true);
      CoachStore.deleteAllData().then(function () {
        const neutralized = fenceRecovery();
        suspendWrites(false);
        opInFlight = false;
        const msg = 'All training data deleted.' +
          (neutralized ? '' : ' Reload once storage is available so the old game cannot return.');
        // Force the Review panel back to a fresh (now empty) list even if a
        // stale game was left open, so a later Verify/Save can't recreate an
        // orphan card/analysis for a deleted game. A refresh failure is cosmetic.
        return Promise.resolve(CoachReview.resetToList()).then(
          function () { setStatus(msg, neutralized ? 'info' : 'error'); },
          function () { setStatus(msg + ' Reopen Review to refresh.', neutralized ? 'info' : 'error'); }
        );
      }).catch(function (err) {
        // Nothing was fenced or dropped — every recovery source is intact. A
        // finish that arrived while suspended was PARKED, so it survives.
        suspendWrites(false);
        opInFlight = false;
        setStatus('Delete failed: ' + (err && err.message ? err.message : 'storage unavailable'), 'error');
      });
    });
  }
})();
