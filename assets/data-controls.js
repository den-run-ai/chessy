/*
 * Chessy data controls (roadmap #23, Phase 4b): single-game PGN import and
 * the archive's data controls — JSON backup, atomic restore, and a fenced
 * "delete all training data". Lives in the Review game-list panel; the parse
 * + validate happens in memory (ChessyPGN) and the store commits once or not
 * at all (CoachStore.importGame / restoreAll / deleteAll).
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof ChessyPGN === 'undefined' ||
      typeof CoachReview === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  function status(el, msg, ok) {
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('err', !ok);
  }

  // The side radios ARE the "prompt for the player's side": Unknown/both
  // leaves it null, so every ply stays flaggable (reflection treats a
  // non-w/b color as two-players-at-one-board).
  function selectedSide() {
    const el = document.querySelector('input[name="importSide"]:checked');
    const v = el ? el.value : '';
    return v === 'w' || v === 'b' ? v : null;
  }

  function doImport(text) {
    const el = $('importStatus');
    const game = ChessyPGN.parseGame(text);
    if (!game.valid) {
      status(el, 'Could not import: ' + game.error +
        (game.ply ? ' (move ' + game.ply + ')' : '') + '. Nothing was saved.', false);
      return;
    }
    const now = Date.now();
    const rec = ChessyPGN.toRecord(game,
      { playerColor: selectedSide(), importedAt: now, createdAt: now });
    CoachStore.importGame(rec).then(function (outcome) {
      if (outcome === 'duplicate') {
        status(el, 'Already imported — this exact game is already in your archive.', true);
      } else {
        status(el, 'Imported ' + game.plies + ' plies (' + game.result + ').', true);
        $('importPgn').value = '';
      }
      return CoachReview.refreshGames();
    }).catch(function () { status(el, 'Import failed — storage unavailable.', false); });
  }

  $('importBtn').addEventListener('click', function () {
    const text = $('importPgn').value.trim();
    if (!text) { status($('importStatus'), 'Paste a PGN or choose a file first.', false); return; }
    doImport(text);
  });
  $('importFile').addEventListener('change', function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { $('importPgn').value = String(reader.result || ''); };
    reader.onerror = function () { status($('importStatus'), 'Could not read the file.', false); };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---- Export (JSON backup download) ----
  $('exportData').addEventListener('click', function () {
    const el = $('dataStatus');
    CoachStore.exportAll().then(function (dump) {
      dump.exportedAt = Date.now();
      const name = 'chessy-backup-' + new Date(dump.exportedAt).toISOString().slice(0, 10) + '.json';
      try {
        const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      } catch (err) { /* download unsupported: still report the snapshot below */ }
      status(el, 'Exported ' + dump.games.length + ' games and ' + dump.cards.length + ' cards.', true);
    }).catch(function () { status(el, 'Export failed — storage unavailable.', false); });
  });

  // ---- Restore (atomic replace from a backup file) ----
  $('restoreData').addEventListener('click', function () { $('restoreFile').click(); });
  $('restoreFile').addEventListener('change', function (e) {
    const el = $('dataStatus');
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let dump;
      try { dump = JSON.parse(String(reader.result || '')); }
      catch (err) { status(el, 'Not a valid backup file — nothing was changed.', false); return; }
      CoachStore.restoreAll(dump).then(function () {
        status(el, 'Restored ' + dump.games.length + ' games and ' + dump.cards.length + ' cards.', true);
        return CoachReview.refreshGames();
      }).catch(function () {
        status(el, 'Restore failed — the backup was invalid; your data is unchanged.', false);
      });
    };
    reader.onerror = function () { status(el, 'Could not read the file.', false); };
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file
  });

  // ---- Fenced delete-all (two explicit clicks, no data lost by accident) ----
  $('deleteData').addEventListener('click', function () {
    $('deleteConfirm').hidden = false;
    $('dataStatus').hidden = true;
  });
  $('deleteCancel').addEventListener('click', function () { $('deleteConfirm').hidden = true; });
  $('deleteConfirmBtn').addEventListener('click', function () {
    $('deleteConfirm').hidden = true;
    CoachStore.deleteAll().then(function () {
      status($('dataStatus'), 'All training data deleted.', true);
      return CoachReview.refreshGames();
    }).catch(function () { status($('dataStatus'), 'Delete failed — storage unavailable.', false); });
  });
})();
