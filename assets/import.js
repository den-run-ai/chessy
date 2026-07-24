/*
 * Chessy PGN import UI (roadmap #23, Phase 4b1).
 *
 * The Review game list gains an "Import PGN…" affordance that opens a dialog
 * to paste PGN text or choose a .pgn file. The heavy lifting already exists:
 *   ChessyPGN.parseGame   — parse + FULLY validate one game in memory
 *   ChessyPGN.toRecord    — build an archive-ready, content-hashed record
 *   CoachStore.importGame — commit ONCE (atomically) or not at all, deduped
 * so this file is only transport + feedback:
 * - Nothing is written until parse + validation succeed (invalid PGN → zero
 *   writes, the error and offending move number are shown).
 * - A repeated import is reported as a duplicate, never a second game.
 * - The player's side defaults to Unknown (null playerColor) so every ply
 *   stays flaggable when the colour can't be inferred.
 *
 * Async hygiene — every dialog lifecycle change (open/close/cancel/submit)
 * bumps a `generation`; a stale file read or import that settles afterwards
 * checks it and no-ops, so:
 * - an older file read cannot overwrite a newer selection;
 * - a submit is refused while a file is still being read (no stale content);
 * - a cancelled/closed import cannot update or close a reopened dialog.
 */
(function () {
  'use strict';
  if (typeof ChessyPGN === 'undefined' || typeof CoachStore === 'undefined' ||
      typeof CoachReview === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const dialog = $('importDialog');
  const form = $('importForm');
  const textEl = $('importText');
  const fileEl = $('importFile');
  const statusEl = $('importStatus');
  const submitBtn = $('importSubmit');
  if (!dialog || !form || !textEl) return;

  let generation = 0;   // bumped on every lifecycle change; invalidates async work
  let reader = null;    // the current (abortable) FileReader
  let reading = false;
  let importing = false;
  // A single game is a few KB even with heavy comments; a multi-game PGN
  // database can be hundreds of MB. Reading one into a string would freeze or
  // OOM the page before the user could cancel, so reject oversized files up
  // front (only the first game is imported anyway).
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }
  // Submit is unavailable while a file is being read or an import is in flight.
  // While a write is IN FLIGHT the source and side inputs are locked too:
  // editing them wouldn't bump `generation`, so the in-flight callback still
  // owns the dialog — a later close would discard newly typed PGN, a
  // duplicate/error would report against content that was never submitted, and
  // changing the side would show a value different from the one already stored
  // in the committed record. Locking them removes the whole class of races.
  function refreshBusy() {
    submitBtn.disabled = reading || importing;
    textEl.disabled = importing;
    if (fileEl) fileEl.disabled = importing;
    const sides = form.querySelectorAll('input[name="importSide"]');
    for (let i = 0; i < sides.length; i++) sides[i].disabled = importing;
  }

  // Invalidate any in-flight read/import and stop a running FileReader. Called
  // whenever the dialog's lifecycle changes so late callbacks can't touch a
  // dialog that has since been closed, reopened, or resubmitted.
  function invalidate() {
    generation++;
    if (reader) { try { reader.abort(); } catch (e) { /* already done */ } reader = null; }
    reading = false;
    importing = false;
  }

  function open() {
    invalidate();
    setStatus('');
    // A stale file selection would silently re-import the previous file on the
    // next submit; clear both fields so the dialog always starts empty.
    form.reset();
    refreshBusy();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    textEl.focus();
  }
  function close() {
    invalidate();
    refreshBusy();
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function chosenSide() {
    const picked = form.querySelector('input[name="importSide"]:checked');
    const v = picked ? picked.value : 'unknown';
    return v === 'w' || v === 'b' ? v : null; // 'unknown' → null (every ply flaggable)
  }

  // The board move number of the game's k-th ply (1-based), honouring a
  // SetUp/FEN start: an imported game can begin at any fullmove and with either
  // side to move, so "move ⌈ply/2⌉" (which assumes 1. White …) is wrong for it.
  function moveNumberOfPly(ply, setupFen) {
    let side = 'w', full = 1;
    if (setupFen) {
      const parts = String(setupFen).split(/\s+/);
      if (parts[1] === 'w' || parts[1] === 'b') side = parts[1];
      const f = parseInt(parts[5], 10);
      if (isFinite(f) && f > 0) full = f;
    }
    return full + Math.floor((ply - 1 + (side === 'b' ? 1 : 0)) / 2);
  }

  // Read a chosen file into the textarea so submit has a single source of
  // truth. An ABORTABLE reader tagged with the generation: a superseded or
  // post-close read never writes the textarea or repaints status.
  fileEl.addEventListener('change', function () {
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    // Choosing ANY file (accepted OR rejected) invalidates the previous source
    // FIRST: abort a pending read and clear the textarea. Otherwise a rejected
    // oversized pick would leave earlier text importable while the picker shows
    // the rejected file, and a slower earlier read could still land its result.
    if (reader) { try { reader.abort(); } catch (e) { /* already done */ } reader = null; }
    reading = false;
    textEl.value = '';
    refreshBusy();
    // Reject an oversized file before reading it (only the first game is
    // imported anyway); the source is already cleared above, so Import refuses.
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus('That file is too large (' + Math.round(file.size / 1048576) +
        ' MB). Import a single-game PGN (up to 5 MB).', 'error');
      return;
    }
    const myGen = generation;
    const r = new FileReader();
    reader = r;
    reading = true;
    refreshBusy();
    setStatus('Reading ' + file.name + '…', 'info');
    r.onload = function () {
      if (r !== reader || myGen !== generation) return; // superseded / dialog changed
      reader = null; reading = false; refreshBusy();
      textEl.value = String(r.result || '');
      setStatus('Loaded ' + file.name + ' — review the side, then Import.', 'info');
    };
    r.onerror = function () {
      if (r !== reader || myGen !== generation) return;
      reader = null; reading = false; refreshBusy();
      setStatus('Could not read that file.', 'error');
    };
    r.onabort = function () { /* superseded: the superseding action owns the UI */ };
    r.readAsText(file);
  });

  $('importOpen').addEventListener('click', open);
  $('importCancel').addEventListener('click', close);
  // Escape/backdrop close (dialog fires 'cancel') must not submit.
  dialog.addEventListener('cancel', function () { close(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    // A file still being read would submit STALE textarea content — refuse.
    if (reading) { setStatus('Still reading the file — one moment…', 'info'); return; }
    if (importing) return;
    const rawText = textEl.value;
    // The same 5 MB bound applies to paste as to file upload. Check bytes
    // before trim/parse so an oversized textarea is not repeatedly copied.
    if (new Blob([rawText]).size > MAX_IMPORT_BYTES) {
      setStatus('That pasted PGN is too large. Import a single game (up to 5 MB).', 'error');
      return;
    }
    const text = rawText.trim();
    if (!text) { setStatus('Paste a PGN or choose a file first.', 'error'); textEl.focus(); return; }

    let game;
    try { game = ChessyPGN.parseGame(text); }
    catch (err) { setStatus('Could not parse that PGN: ' + err.message, 'error'); return; }

    if (!game || !game.valid) {
      const where = game && game.ply
        ? ' (move ' + moveNumberOfPly(game.ply, game.setupFen) + ')' : '';
      setStatus('Not a valid game' + where + ': ' + ((game && game.error) || 'unrecognised PGN') +
        '. Nothing was imported.', 'error');
      return;
    }

    const record = ChessyPGN.toRecord(game, { playerColor: chosenSide(), importedAt: Date.now() });
    const myGen = generation;
    importing = true;
    refreshBusy();
    setStatus('Importing…', 'info');
    CoachStore.importGame(record).then(function (outcome) {
      if (outcome === 'duplicate') {
        // Nothing was added. If the dialog was cancelled/reopened meanwhile
        // there is nothing to report; otherwise re-enable Submit (the dialog
        // stays open) and do NOT mint a second game.
        if (myGen !== generation) return;
        importing = false;
        refreshBusy();
        setStatus('This game is already in your archive.', 'info');
        return;
      }
      // Committed. The game LANDED, so refresh the list even if the dialog was
      // cancelled/closed while the write was in flight — Cancel bumps the
      // generation but cannot abort the IndexedDB transaction, so without this
      // a silently-committed import would be missing from Review until a later
      // refresh. Only touch the dialog if this is still the current generation.
      // Keeping `importing` true through the refresh also blocks a second
      // silent paste while the still-open dialog's refreshGames() is pending
      // (close() → invalidate() clears it).
      return Promise.resolve(CoachReview.refreshGames()).then(function () {
        if (myGen !== generation) return;
        close();
      });
    }).catch(function (err) {
      if (myGen !== generation) return;
      importing = false;
      refreshBusy();
      setStatus('Import failed: ' + (err && err.message ? err.message : 'storage unavailable') +
        '. Nothing was saved.', 'error');
    });
  });
})();
