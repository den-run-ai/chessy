/* Game archive foundation: finished games persist to IndexedDB, keyed on
 * the game's UUID (idempotent re-archive that keeps the original
 * createdAt; a DIVERGENT completion under the same key — cloned tabs —
 * forks a fresh id instead of overwriting), with failures surfaced both
 * in the game-over dialog and, for the boot reconcile, on the page. */
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
  // the saved game, so the re-archive is an idempotent overwrite — and it
  // keeps the ORIGINAL createdAt (listGames sorts by createdAt; a re-shown
  // game must not jump to the top of the chronology).
  const overwriteId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  const createdAtBefore = (await games()).filter(function (g) {
    return g.id === overwriteId;
  })[0].createdAt;
  await page.waitForTimeout(50); // ensure a rewritten createdAt would differ
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.waitForTimeout(300); // let any (wrong) duplicate write land
  await waitGameCount(2);
  const overwritten = (await games()).filter(function (g) { return g.id === overwriteId; })[0];
  check(!!overwritten, 'a replayed ending after reload overwrites its record (still 2 games)');
  check(overwritten.createdAt === createdAtBefore,
    'the overwrite keeps the original createdAt');

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

  // A game can be over before the first move (time forfeit on the initial
  // position) — it is archived, not skipped.
  const zeroPlyId = await page.evaluate(function () {
    return ChessyArchive.record(
      { history: [] },
      { mode: 'pvp', difficulty: '3', timeControl: '5+0' },
      { over: true, result: '0-1', reason: 'time forfeit' },
      'zero-ply-forfeit');
  });
  await waitGameCount(2);
  check(zeroPlyId === 'zero-ply-forfeit' && (await games()).some(function (g) {
    return g.id === 'zero-ply-forfeit' && g.plies === 0 && g.reason === 'time forfeit';
  }), 'a zero-ply time forfeit is archived');

  // A CLONED tab shares the persisted gameId but may play a different
  // continuation: its divergent completion must fork a fresh id (both
  // finished games survive), never overwrite the first tab's record.
  const cloneStoredId = await page.evaluate(function () {
    const sharedId = JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
    return ChessyArchive.record(
      { history: [{ san: 'f3' }, { san: 'e6' }, { san: 'g4' }, { san: 'Qh4#' }] },
      { mode: 'pvp', difficulty: '3', timeControl: 'none' },
      { over: true, result: '0-1', reason: 'checkmate' },
      sharedId);
  });
  await waitGameCount(3);
  const afterClone = await games();
  check(cloneStoredId !== savedId &&
        afterClone.some(function (g) { return g.id === savedId && g.sans[1] === 'e5'; }) &&
        afterClone.some(function (g) { return g.id === cloneStoredId && g.sans[1] === 'e6'; }),
    'a divergent completion from a cloned tab forks a fresh id — both games kept');

  // A FAILED archive write is surfaced in the game-over dialog.
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () { return Promise.reject(new Error('quota')); };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForSelector('#archiveNote:not([hidden])');
  check((await page.textContent('#archiveNote')).includes('could not be archived'),
    'a failed archive write is reported in the game-over dialog');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });
  await page.click('#gameOverClose');

  // A BOOT-TIME reconcile failure has no open dialog to report into: it
  // must surface in the always-visible page note. Break IndexedDB before
  // the scripts run, then boot the finished saved game (whose archive
  // write above was rejected, so the reconcile really does try to write).
  await page.addInitScript(function () {
    Object.defineProperty(window, 'indexedDB',
      { get: function () { return undefined; }, configurable: true });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForSelector('#archiveBootNote:not([hidden])', { timeout: 5000 });
  check((await page.textContent('#archiveBootNote')).includes('could not be archived'),
    'a boot-time reconcile failure is reported outside the closed dialog');
});
