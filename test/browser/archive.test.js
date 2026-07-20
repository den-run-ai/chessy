/* Game archive foundation: finished games persist to IndexedDB, keyed on
 * the game's UUID (idempotent re-archive), with failures surfaced. */
'use strict';
require('./helper').run('archive', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function games() {
    return page.evaluate(function () { return CoachStore.listGames(); });
  }
  async function waitGameCount(n) {
    for (let i = 0; i < 50; i++) {
      if ((await games()).length === n) return;
      await page.waitForTimeout(100);
    }
    throw new Error('expected ' + n + ' archived games, got ' + (await games()).length);
  }

  // A finished game is archived automatically.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  check(await page.locator('#archiveNote').isHidden(), 'no archive-failure note on success');
  await waitGameCount(1);
  const first = (await games())[0];
  check(typeof first.id === 'string' && first.id.length > 0, 'record keyed on the game UUID');
  check(first.source === 'play' && first.plies === 4 && first.playerColor === 'both' &&
        first.result === '0-1' && first.reason === 'checkmate' &&
        Array.isArray(first.clocks) && first.clocks.length === 4 &&
        first.sans.join(' ') === 'f3 e5 g4 Qh4#',
    'record carries moves, result, player color and per-move clock evidence');

  // Rematch with the IDENTICAL moves is a new game instance → new record.
  await page.click('#gameOverRematch');
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await waitGameCount(2);
  const pair = await games();
  check(pair[0].id !== pair[1].id, 'identical rematch archives under a fresh UUID');

  // Reload → undo → reproduce the SAME ending: the UUID is persisted with
  // the saved game, so the re-archive is an idempotent overwrite.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.waitForTimeout(300); // let any (wrong) duplicate write land
  await waitGameCount(2);
  check(true, 'a replayed ending after reload overwrites its record (still 2 games)');

  // Boot reconcile: if the archive write was lost (tab died before the
  // IndexedDB commit), the next boot re-offers the restored finished game.
  // deleteDatabase also exercises the store's onversionchange handler —
  // the open connection must yield, not block.
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      const req = indexedDB.deleteDatabase('chessy-coach');
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
  });
  const savedId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await waitGameCount(1);
  check((await games())[0].id === savedId,
    'boot re-archives a finished game whose write was lost (same UUID)');

  // A FAILED archive write is surfaced in the game-over dialog.
  await page.evaluate(function () {
    CoachStore.__realPutGame = CoachStore.putGame;
    CoachStore.putGame = function () { return Promise.reject(new Error('quota')); };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForSelector('#archiveNote:not([hidden])');
  check((await page.textContent('#archiveNote')).includes('could not be archived'),
    'a failed archive write is reported in the game-over dialog');
  await page.evaluate(function () { CoachStore.putGame = CoachStore.__realPutGame; });
  await page.click('#gameOverClose');
});
