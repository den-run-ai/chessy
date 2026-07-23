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

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }

  function open() {
    setStatus('');
    // A stale file selection would silently re-import the previous file on the
    // next submit; clear both fields so the dialog always starts empty.
    form.reset();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    textEl.focus();
  }
  function close() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function chosenSide() {
    const picked = form.querySelector('input[name="importSide"]:checked');
    const v = picked ? picked.value : 'unknown';
    return v === 'w' || v === 'b' ? v : null; // 'unknown' → null (every ply flaggable)
  }

  // Read a chosen file into the textarea so submit has a single source of
  // truth. FileReader errors surface as status, never as an unhandled reject.
  fileEl.addEventListener('change', function () {
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      textEl.value = String(reader.result || '');
      setStatus('Loaded ' + file.name + ' — review the side, then Import.', 'info');
    };
    reader.onerror = function () { setStatus('Could not read that file.', 'error'); };
    reader.readAsText(file);
  });

  $('importOpen').addEventListener('click', open);
  $('importCancel').addEventListener('click', close);
  // Escape/backdrop close (dialog fires 'cancel') must not submit.
  dialog.addEventListener('cancel', function () { close(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) { setStatus('Paste a PGN or choose a file first.', 'error'); textEl.focus(); return; }

    let game;
    try { game = ChessyPGN.parseGame(text); }
    catch (err) { setStatus('Could not parse that PGN: ' + err.message, 'error'); return; }

    if (!game || !game.valid) {
      const where = game && game.ply ? ' (move ' + Math.ceil(game.ply / 2) + ')' : '';
      setStatus('Not a valid game' + where + ': ' + ((game && game.error) || 'unrecognised PGN') +
        '. Nothing was imported.', 'error');
      return;
    }

    const record = ChessyPGN.toRecord(game, { playerColor: chosenSide(), importedAt: Date.now() });
    submitBtn.disabled = true;
    setStatus('Importing…', 'info');
    CoachStore.importGame(record).then(function (outcome) {
      submitBtn.disabled = false;
      if (outcome === 'duplicate') {
        // Already archived — keep the dialog open so the message is seen; do
        // NOT mint a second game.
        setStatus('This game is already in your archive.', 'info');
        return;
      }
      // Committed. Refresh the list underneath, then close onto it.
      return Promise.resolve(CoachReview.refreshGames()).then(function () {
        close();
      });
    }).catch(function (err) {
      submitBtn.disabled = false;
      setStatus('Import failed: ' + (err && err.message ? err.message : 'storage unavailable') +
        '. Nothing was saved.', 'error');
    });
  });
})();
