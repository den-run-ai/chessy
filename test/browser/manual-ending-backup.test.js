/* Transport/fencing coverage for app-level endings that are terminal while
 * their final board is still playable. */
'use strict';
const fs = require('fs');
require('./helper').run('manual ending backup', async function (t) {
  const page = t.page, check = t.check;

  async function putManualSave(id, manualEnding, fenMode) {
    return page.evaluate(function (args) {
      let s = Chess.newGameState();
      const legal = Chess.legalMoves(s);
      const e4 = legal.find(function (move) {
        return Chess.sqName(move.from) === 'e2' &&
          Chess.sqName(move.to) === 'e4';
      });
      s = Chess.playMove(s, e4);
      const saved = {
        fen: Chess.toFen(s),
        history: s.history,
        mode: 'pvp',
        difficulty: '2',
        timeControl: 'none',
        clocks: null,
        timeForfeit: null,
        manualEnding: args.manualEnding,
        flipped: false,
        gameId: args.id,
        endedAt: 84
      };
      if (args.fenMode === 'missing') delete saved.fen;
      if (args.fenMode === 'mismatch') {
        saved.fen = Chess.toFen(Chess.newGameState());
      }
      const blob = JSON.stringify(saved);
      localStorage.setItem('chessy-game-v1', blob);
      localStorage.removeItem('chessy-pending-archive-v1');
      return blob;
    }, { id: id, manualEnding: manualEnding, fenMode: fenMode });
  }

  async function backup() {
    const pair = await Promise.all([
      page.waitForEvent('download'),
      page.click('#backupBtn')
    ]);
    return JSON.parse(fs.readFileSync(await pair[0].path(), 'utf8'));
  }

  await page.click('#tabReview');

  // This game exists only in the live-save slot. Its board is nonterminal, so
  // recognizing the semantic adjudication is the only way Backup can retain it.
  await putManualSave('manual-resign-only', {
    kind: 'resignation', color: 'w'
  });
  const resignedBackup = await backup();
  const resigned = resignedBackup.stores.games.find(function (game) {
    return game.id === 'manual-resign-only';
  });
  check(resigned && resigned.sans.join(' ') === 'e4' &&
        resigned.result === '0-1' && resigned.reason === 'resignation' &&
        resigned.createdAt === 84,
    'Backup reconstructs a local-save-only resignation with its exact result');

  await putManualSave('malformed-manual', {
    kind: 'resignation', color: 'green'
  });
  const malformedBackup = await backup();
  check(!malformedBackup.stores.games.some(function (game) {
    return game.id === 'malformed-manual';
  }), 'a malformed manual ending cannot fabricate a completed backup row');

  await putManualSave('manual-missing-fen', {
    kind: 'resignation', color: 'w'
  }, 'missing');
  const missingFenBackup = await backup();
  check(!missingFenBackup.stores.games.some(function (game) {
    return game.id === 'manual-missing-fen';
  }), 'a manual ending without a saved FEN cannot fabricate a backup row');

  await putManualSave('manual-mismatched-fen', {
    kind: 'draw-agreement'
  }, 'mismatch');
  const mismatchedFenBackup = await backup();
  check(!mismatchedFenBackup.stores.games.some(function (game) {
    return game.id === 'manual-mismatched-fen';
  }), 'a manual ending whose saved FEN disagrees with replay is excluded');

  // Delete-all uses the same reconstruction path to fence a finished save that
  // differs from the app closure's current live game.
  const drawBlob = await putManualSave('manual-draw-only', {
    kind: 'draw-agreement'
  });
  await page.click('#deleteAllBtn');
  await page.click('#deleteAllConfirm');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  }, { timeout: 5000 });
  check(await page.evaluate(function () {
    return ChessyArchive.isFencedEnding(
      'manual-draw-only', ['e4'], '1/2-1/2', 'draw agreement') ||
      localStorage.getItem('chessy-game-v1') === null;
  }), 'Delete-all neutralizes a local-save-only agreed draw by exact ending');

  // Recreate the exact saved draw outside the app. Its fence must prevent boot
  // reconciliation from resurrecting the cleared game.
  await t.inject(function (blob) {
    localStorage.setItem('chessy-game-v1', blob);
  }, drawBlob);
  await page.waitForTimeout(300);
  check(await page.evaluate(function () {
    return CoachStore.listGames().then(function (games) {
      return games.length === 0;
    });
  }), 'the fenced agreed draw stays deleted after a fresh boot');
});
