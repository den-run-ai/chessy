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
  const FENCE_KEY = 'chessy-archive-fenced-v1';
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
    return Object.keys(map).map(function (id) {
      const entry = map[id];
      return entry && typeof entry === 'object' ? entry.rec : null;
    }).filter(Boolean);
  }

  // Backup must be able to honour archive-clear fences even when archive.js is
  // missing (for example, a partial offline release). This is the exact
  // ending-signature scheme used by archive.js: id + moves + result + reason,
  // separated by U+0001 and passed through the same double djb-style hash.
  // Unlike archive.js's best-effort runtime reader, backup treats an unreadable
  // fence as UNKNOWN and fails closed: exporting a parked/saved fenced ending
  // would let a later restore resurrect data the user deliberately cleared.
  function endingSig(id, sans, result, reason) {
    const s = String(id) + '\x01' + (Array.isArray(sans) ? sans.join(',') : '') +
      '\x01' + (result == null ? '' : result) + '\x01' + (reason == null ? '' : reason);
    let a = 5381, b = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) + a + c) | 0;
      b = ((b << 5) + b + (c ^ 0x5f)) | 0;
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
  }

  function rawFenceSignatures() {
    let raw;
    try { raw = localStorage.getItem(FENCE_KEY); }
    catch (e) { throw new Error('could not read the archive-clear fence'); }
    if (raw == null) return [];
    let signatures;
    try { signatures = JSON.parse(raw); }
    catch (e) { throw new Error('the archive-clear fence is unreadable'); }
    if (!Array.isArray(signatures)) {
      throw new Error('the archive-clear fence is malformed');
    }
    return signatures;
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
  // Invalidate scan ownership BEFORE stopping the shared worker. cancel()
  // resolves the abandoned analysis promise; without the generation bump its
  // continuation could later checkpoint/restart after Restore/Delete-all has
  // replaced the source game. The scan module is optional (older releases and
  // partial caches do not have it), so this remains a guarded best effort.
  function cancelAnalysis() {
    if (typeof ChessyMomentScan !== 'undefined' && ChessyMomentScan.invalidate) {
      try { ChessyMomentScan.invalidate(); } catch (e) { /* best effort */ }
    }
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
    if (typeof ChessyArchive !== 'undefined') {
      try {
        if (ChessyArchive.fenceEndings && ChessyArchive.pendingRecords) {
          ChessyArchive.fenceEndings(ChessyArchive.pendingRecords()); // best effort
        }
        // The queue must be REMOVED to be durably neutralized (a fence is only
        // honoured while its own write persisted). removeItem frees space, so it
        // succeeds even at quota; a false return means storage is fully blocked.
        if (ChessyArchive.dropPendingQueue && !ChessyArchive.dropPendingQueue()) ok = false;
      } catch (e) { ok = false; }
    } else {
      // Archive module absent (partial cache eviction): still neutralize the
      // queue via raw localStorage, or a later boot with the module loaded would
      // reconcile pre-clear games into the replacement.
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { ok = false; }
    }
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
        neutralized = ChessyArchive.isFencedEnding &&
          ChessyArchive.isFencedEnding(
            persisted.id, persisted.sans, persisted.result, persisted.reason);
        if (!neutralized) {
          neutralized = ChessyArchive.fenceEnding(
            persisted.id, persisted.sans, persisted.result, persisted.reason);
        }
      }
      if (!neutralized) {
        try { localStorage.removeItem(GAME_SAVE_KEY); }
        catch (e) { ok = false; }
      }
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
