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
  const savedGame = await page.evaluate(function () {
    const s = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { gameId: s.gameId, endedAt: s.endedAt };
  });
  const savedId = savedGame.gameId;
  await page.reload();
  await page.waitForSelector('#board .square');
  await waitGameCount(1);
  check((await games())[0].id === savedId,
    'boot re-archives a finished game whose write was lost (same UUID)');
  check(Number.isFinite(savedGame.endedAt) && (await games())[0].createdAt === savedGame.endedAt,
    'the reconciled record keeps the persisted completion time, not the boot time');

  // Undoing a finished game voids its completion time: a DIFFERENT finish
  // reached after the undo must archive under its own time.
  await page.click('#undo');
  check((await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).endedAt;
  })) === null, 'undo clears the persisted completion time');

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

  // A SAME-tab replay edit (close dialog → undo → different finish) is
  // NOT a clone: it revises this instance's one record instead of adding
  // a second game.
  const tabEdit = await page.evaluate(function () {
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const over = { over: true, result: '0-1', reason: 'checkmate' };
    const mk = function (sans) {
      return { history: sans.map(function (s) { return { san: s }; }) };
    };
    return ChessyArchive.record(mk(['e4', 'e5']), cfg, over, 'tab-edit-test',
      { tab: 'T1', endedAt: 1111 })
      .then(function () {
        return ChessyArchive.record(mk(['e4', 'c5']), cfg, over, 'tab-edit-test',
          { tab: 'T1', endedAt: 2222 });
      })
      .then(function (secondId) {
        return CoachStore.getGame('tab-edit-test').then(function (g) {
          return { secondId: secondId, sans: g.sans.join(' '), createdAt: g.createdAt };
        });
      });
  });
  await waitGameCount(4);
  check(tabEdit.secondId === 'tab-edit-test' && tabEdit.sans === 'e4 c5' &&
        tabEdit.createdAt === 2222,
    'a same-tab replay edit overwrites the one record (revised ending, no fork)');

  // Re-offering an ending never transfers ownership: another tab's boot
  // reconcile of the same ending keeps the original writer's tab, so the
  // reconciler cannot later overwrite the owner's game by diverging.
  const ownership = await page.evaluate(function () {
    const mk = function (sans, tab, createdAt) {
      return { id: 'owner-test', source: 'play', tags: {}, sans: sans,
        playerColor: 'both', clocks: sans.map(function () { return null; }),
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2',
        timeControl: 'none', plies: sans.length, createdAt: createdAt, tab: tab };
    };
    return CoachStore.archiveGame(mk(['e4'], 'TAB-A', 1000))
      .then(function () { return CoachStore.archiveGame(mk(['e4'], 'TAB-B', 2000)); })
      .then(function () { return CoachStore.getGame('owner-test'); })
      .then(function (g) {
        return CoachStore.archiveGame(mk(['d4'], 'TAB-B', 3000)).then(function (forkId) {
          return { keptTab: g.tab, keptAt: g.createdAt, forkId: forkId };
        });
      });
  });
  await waitGameCount(6);
  check(ownership.keptTab === 'TAB-A' && ownership.keptAt === 1000 &&
        ownership.forkId !== 'owner-test',
    "same-ending reconcile keeps the owner's tab — the reconciler's divergence forks");

  // Durability slots: records parked by tabs that died before their
  // IndexedDB commits are recovered on the next boot, then cleared. Slots
  // are PER TAB, so two cloned tabs that both died mid-commit — sharing a
  // gameId but holding divergent endings — each recover (one forks).
  await page.evaluate(function () {
    const park = function (tab, id, sans, createdAt) {
      localStorage.setItem('chessy-pending-archive-v1:' + tab, JSON.stringify({
        id: id, source: 'play', tags: {},
        sans: sans, playerColor: 'both', clocks: sans.map(function () { return null; }),
        result: '1-0', reason: 'resignation', mode: 'pvp', difficulty: '2',
        timeControl: 'none', plies: sans.length, createdAt: createdAt, tab: tab
      }));
    };
    park('DEAD-TAB', 'parked-game', ['e4', 'e5'], 7777);
    park('CLONE-A', 'shared-pend', ['c4', 'c5'], 8888);
    park('CLONE-B', 'shared-pend', ['d4', 'd5'], 9999);
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await waitGameCount(9);
  const drained = await games();
  check(drained.some(function (g) { return g.id === 'parked-game' && g.createdAt === 7777; }),
    'a parked record from a dead tab is recovered on boot');
  check(drained.some(function (g) { return g.sans[0] === 'c4'; }) &&
        drained.some(function (g) { return g.sans[0] === 'd4'; }) &&
        drained.some(function (g) { return g.id === 'shared-pend'; }),
    'cloned tabs’ divergent parked records BOTH recover (one keeps the id, one forks)');
  check(await page.evaluate(function () {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i).indexOf('chessy-pending-archive-v1:') === 0) return false;
    }
    return true;
  }), 'all recovered durability slots are cleared');

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
