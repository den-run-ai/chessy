/* Replacing a non-empty unfinished game preserves it in Review as an
 * unscored abandoned snapshot. A failed checkpoint leaves the live game in
 * place unless the player explicitly chooses to start without saving. */
'use strict';
const fs = require('fs');
require('./helper').run('incomplete game', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function games() {
    return page.evaluate(function () { return CoachStore.listGames(); });
  }
  async function waitGameCount(n) {
    await page.waitForFunction(function (expected) {
      return CoachStore.listGames().then(function (rows) {
        return rows.length === expected;
      });
    }, n);
  }

  await t.newGame({ mode: 'pvp' });
  await mv('e2', 'e4');
  await mv('e7', 'e5');
  const abandonedId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });

  await page.click('#newGame');
  check(await page.locator('#newGameWarning').isVisible() &&
      (await page.textContent('#newGameWarning')).includes('save this one to Review'),
    'New Game warns that the unfinished game will be saved');
  check((await page.textContent('#newGameStart')).includes('Save & start'),
    'the primary action names the save-before-start behavior');
  await t.pick('mode', 'ai-b');
  await t.pick('difficulty', '3');
  await t.pick('timeControl', '300+3');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(1);

  const saved = (await games())[0];
  check(saved.id === abandonedId && saved.sans.join(' ') === 'e4 e5' &&
      saved.result === '*' && saved.reason === 'abandoned' && saved.plies === 2,
    'the exact displaced game is archived as unscored and abandoned');
  check(saved.mode === 'pvp' && saved.difficulty === '2' &&
      saved.timeControl === 'none' && saved.playerColor === 'both',
    'the checkpoint keeps the old game settings, not the next selections');
  const live = await page.evaluate(function () {
    const value = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      id: value.gameId, plies: value.history.length, mode: value.mode,
      difficulty: value.difficulty, timeControl: value.timeControl
    };
  });
  check(live.id !== abandonedId && live.plies === 0 && live.mode === 'ai-b' &&
      live.difficulty === '3' && live.timeControl === '300+3',
    'the new game starts only after the old checkpoint commits');

  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  const listText = await page.textContent('.game-item');
  check(listText.includes('Incomplete') && listText.includes('Abandoned') &&
      !listText.includes('· *'),
    'Review gives the partial game a clear Incomplete · Abandoned label');
  await page.click('.game-item');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('saved incomplete position'),
    'Review does not call the saved partial position the end of a game');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#reviewExportPgn')
  ]);
  const pgn = fs.readFileSync(await download.path(), 'utf8');
  check(pgn.includes('[Result "*"]') &&
      pgn.includes('[Termination "abandoned"]') &&
      pgn.includes('1. e4 e5 {abandoned} *'),
    'Review exports the abandoned snapshot as an ongoing PGN, not a loss');

  await page.click('#reviewBack');
  await page.click('#tabPlay');
  await page.click('#newGame');
  check(await page.locator('#newGameWarning').isHidden() &&
      (await page.textContent('#newGameStart')).trim() === 'Start game',
    'a zero-ply game is not presented as an archive-worthy game');
  await t.pick('mode', 'pvp');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await page.waitForTimeout(50);
  check((await games()).length === 1, 'zero-ply replacements do not clutter Review');

  // A failed direct checkpoint must not replace the only live copy.
  await mv('e2', 'e4');
  const retainedId = await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () {
      return Promise.reject(new Error('quota'));
    };
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf(
      'could not be saved') !== -1;
  });
  const retained = await page.evaluate(function () {
    const value = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: value.gameId, plies: value.history.length };
  });
  check(await page.locator('#newGameDialog[open]').count() === 1 &&
      retained.id === retainedId && retained.plies === 1,
    'a failed checkpoint keeps the dialog and current game intact');
  check(await page.locator('#newGameDiscard').isVisible(),
    'failure exposes an explicit start-without-saving escape');

  await page.evaluate(function () {
    CoachStore.archiveGame = CoachStore.__realArchiveGame;
  });
  await page.click('#newGameDiscard');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  const discarded = await page.evaluate(function () {
    const value = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: value.gameId, plies: value.history.length };
  });
  check(discarded.id !== retainedId && discarded.plies === 0 &&
      (await games()).length === 1,
    'Start without saving explicitly replaces the retained game without archiving it');

  // A retry from the same failure UI keeps ownership of the retained game
  // until the second write actually commits.
  await mv('e2', 'e4');
  const retryId = await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () {
      return Promise.reject(new Error('quota'));
    };
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf(
      'could not be saved') !== -1;
  });
  await page.evaluate(function () {
    CoachStore.archiveGame = CoachStore.__realArchiveGame;
  });
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(2);
  check((await games()).some(function (game) {
    return game.id === retryId && game.result === '*' &&
      game.reason === 'abandoned' && game.sans.join(' ') === 'e4';
  }), 'retry commits the retained game before starting');

  // The old live save remains authoritative until a held successful write
  // settles. Escape is deliberately ignored during that short commit window,
  // so a second attempt cannot steal ownership from the first.
  await mv('e2', 'e4');
  const heldId = await page.evaluate(function () {
    const real = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      return new Promise(function (resolve, reject) {
        window.__releaseHeldCheckpoint = function () {
          CoachStore.archiveGame = real;
          real(rec).then(resolve, reject);
        };
      });
    };
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf('Saving') !== -1;
  });
  await page.keyboard.press('Escape');
  const held = await page.evaluate(function () {
    const value = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      dialogOpen: document.getElementById('newGameDialog').open,
      startDisabled: document.getElementById('newGameStart').disabled,
      cancelDisabled: document.getElementById('newGameCancel').disabled,
      id: value.gameId,
      plies: value.history.length
    };
  });
  check(held.dialogOpen && held.startDisabled && held.cancelDisabled &&
      held.id === heldId && held.plies === 1,
    'a held checkpoint keeps the original live save and one owned modal');
  await page.evaluate(function () { window.__releaseHeldCheckpoint(); });
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(3);
  check((await games()).some(function (game) {
    return game.id === heldId && game.result === '*' && game.reason === 'abandoned';
  }), 'the replacement starts only after a held checkpoint succeeds');

  // A failed finished-game write can leave an older same-id revision parked
  // for recovery. The abandonment must remove that exact stale source after
  // its own commit, or Backup/reload would resurrect the obsolete finish.
  await mv('d2', 'd4');
  const pendingId = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    const map = {};
    map[live.gameId] = {
      w: 'w-stale-finish',
      rec: {
        id: live.gameId, source: 'play', tags: {}, sans: ['d4'],
        playerColor: 'both', clocks: [null], ai: [null],
        startedRelease: live.startedRelease || null,
        result: '1-0', reason: 'resignation', mode: live.mode,
        difficulty: live.difficulty, timeControl: live.timeControl,
        plies: 1, createdAt: 1
      }
    };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
    return live.gameId;
  });
  await t.newGame();
  await waitGameCount(4);
  const pendingAfter = await page.evaluate(function (id) {
    const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
    return {
      stillPending: !!(map && map[id]),
      game: null
    };
  }, pendingId);
  pendingAfter.game = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, pendingId);
  check(!pendingAfter.stillPending && pendingAfter.game &&
      pendingAfter.game.result === '*' && pendingAfter.game.reason === 'abandoned',
    'a committed abandonment supersedes the same-id pending finish');
  await page.reload();
  await page.waitForSelector('#board .square');
  const pendingAfterReload = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, pendingId);
  check(pendingAfterReload && pendingAfterReload.result === '*' &&
      pendingAfterReload.reason === 'abandoned',
    'boot recovery cannot overwrite the abandoned row with the stale finish');

  // Committing IndexedDB is not enough if removal of the captured recovery
  // source fails. Treat that as a failed checkpoint and retain the live game
  // until a retry can verify that the stale token is gone.
  await mv('c2', 'c4');
  const unclearedId = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    const map = {};
    map[live.gameId] = {
      w: 'w-cannot-clear',
      rec: {
        id: live.gameId, source: 'play', tags: {}, sans: ['c4'],
        playerColor: 'both', clocks: [null], ai: [null],
        result: '0-1', reason: 'resignation', mode: live.mode,
        difficulty: live.difficulty, timeControl: live.timeControl,
        plies: 1, createdAt: 2
      }
    };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
    window.__realStorageRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === 'chessy-pending-archive-v1') throw new Error('blocked');
      return window.__realStorageRemoveItem.call(this, key);
    };
    return live.gameId;
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf(
      'could not be saved') !== -1;
  });
  const unclearedLive = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: live.gameId, plies: live.history.length };
  });
  const unclearedStored = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, unclearedId);
  check(unclearedLive.id === unclearedId && unclearedLive.plies === 1,
    'an uncleared stale recovery token keeps the live game in place');
  check(!unclearedStored,
    'a failed stale-token removal does not half-commit the abandonment');
  await page.evaluate(function () {
    Storage.prototype.removeItem = window.__realStorageRemoveItem;
  });
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(5);
  check(await page.evaluate(function (id) {
    const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
    return !(map && map[id]);
  }, unclearedId), 'retry verifies that the stale recovery token was removed');

  // Hold the boot drain after restoring a finished live save. Undo + abandon
  // is a newer revision and must suppress the captured boot-finish snapshot.
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await waitGameCount(6);
  const bootId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.click('#gameOverClose');
  await page.addInitScript(function () {
    let mod;
    Object.defineProperty(window, 'ChessyArchive', {
      configurable: true,
      get: function () { return mod; },
      set: function (value) {
        const real = value.reconcilePending;
        value.reconcilePending = function () {
          if (localStorage.getItem('test-hold-incomplete-drain') === null) {
            return real.apply(value, arguments);
          }
          return new Promise(function (resolve, reject) {
            window.__releaseIncompleteDrain = function () {
              real.call(value).then(function (result) {
                resolve(result);
                setTimeout(function () { window.__incompleteDrainSettled = true; }, 0);
              }, reject);
            };
          });
        };
        mod = value;
      }
    });
  });
  await page.evaluate(function () {
    localStorage.setItem('test-hold-incomplete-drain', '1');
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');
  await t.newGame();
  await page.evaluate(function () { window.__releaseIncompleteDrain(); });
  await page.waitForFunction(function () { return window.__incompleteDrainSettled === true; });
  const afterBootDrain = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, bootId);
  check(afterBootDrain && afterBootDrain.result === '*' &&
      afterBootDrain.reason === 'abandoned' && afterBootDrain.plies === 3,
    'a stale boot-finish snapshot cannot overwrite the newer abandonment');
  await page.evaluate(function () {
    localStorage.removeItem('test-hold-incomplete-drain');
  });

  // Freeze the AI before the asynchronous release check. Trigger the move and
  // both New Game clicks in one task so no worker reply can beat the intent.
  await t.newGame({ mode: 'ai-b', timeControl: 'none' });
  const aiId = await page.evaluate(function () {
    const real = ChessyRuntime.ensureCurrent;
    ChessyRuntime.ensureCurrent = function () {
      return new Promise(function (resolve) {
        window.__releaseRuntimeGate = function () {
          ChessyRuntime.ensureCurrent = real;
          resolve(true);
        };
      });
    };
    document.querySelector('#board .square[data-index="52"]').click(); // e2
    document.querySelector('#board .square[data-index="36"]').click(); // e4
    const id = JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
    document.getElementById('newGame').click();
    document.getElementById('newGameStart').click();
    return id;
  });
  await page.waitForTimeout(700);
  const frozenAi = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { sans: live.history.map(function (entry) { return entry.san; }),
      open: document.getElementById('newGameDialog').open };
  });
  check(frozenAi.open && frozenAi.sans.join(' ') === 'e4',
    'the AI cannot change the accepted position during the runtime gate');
  await page.evaluate(function () { window.__releaseRuntimeGate(); });
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(7);
  const frozenAiRecord = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, aiId);
  check(frozenAiRecord && frozenAiRecord.sans.join(' ') === 'e4',
    'the checkpoint records the click-time AI position exactly');

  // Freeze a nearly-expired clock for the whole held commit. Without this,
  // the old game can flag and leave its modal operating on the fresh game.
  await t.newGame({ mode: 'pvp', timeControl: '300+3' });
  await mv('e2', 'e4');
  const clockId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await t.inject(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    live.clocks.bMs = 1500;
    localStorage.setItem('chessy-game-v1', JSON.stringify(live));
  });
  const restoredClock = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).clocks.bMs;
  });
  check(restoredClock > 500 && restoredClock <= 1500,
    'the clock-race fixture restores a genuinely near-expiry turn');
  await page.evaluate(function () {
    const real = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      return new Promise(function (resolve, reject) {
        window.__releaseClockCheckpoint = function () {
          CoachStore.archiveGame = real;
          real(rec).then(resolve, reject);
        };
      });
    };
    document.getElementById('newGame').click();
    document.getElementById('newGameStart').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf('Saving') !== -1;
  });
  await page.waitForTimeout(1800);
  const frozenClock = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      newGameOpen: document.getElementById('newGameDialog').open,
      gameOverOpen: document.getElementById('gameOverDialog').open,
      timeForfeit: live.timeForfeit,
      remaining: live.clocks.bMs
    };
  });
  check(frozenClock.newGameOpen && !frozenClock.gameOverOpen &&
      !frozenClock.timeForfeit && frozenClock.remaining > 0,
    'a low clock cannot flag while its incomplete checkpoint is pending');
  await page.evaluate(function () { window.__releaseClockCheckpoint(); });
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitGameCount(8);
  const clockRecord = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, clockId);
  check(clockRecord && clockRecord.result === '*' &&
      clockRecord.reason === 'abandoned' &&
      await page.locator('#gameOverDialog[open]').count() === 0,
    'the held timed game is archived incomplete with no stale result modal');

  // A rejected write is a decision state, not a return to live play. Keep a
  // near-expiry clock frozen while the failure UI blocks moves, then resume
  // that same remaining time only when the player explicitly cancels.
  await mv('e2', 'e4');
  await t.inject(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    live.clocks.bMs = 3000;
    localStorage.setItem('chessy-game-v1', JSON.stringify(live));
  });
  const failedClockFixture = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).clocks.bMs;
  });
  check(failedClockFixture > 1500 && failedClockFixture <= 3000,
    'the failed-save clock fixture retains enough CI timing headroom');
  await page.evaluate(function () {
    CoachStore.__failedClockArchive = CoachStore.archiveGame;
    CoachStore.archiveGame = function () {
      return Promise.reject(new Error('quota'));
    };
    document.getElementById('newGame').click();
    document.getElementById('newGameStart').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf(
      'could not be saved') !== -1;
  });
  const failedClockPausedAt = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).clocks.bMs;
  });
  await page.waitForTimeout(failedClockPausedAt + 400);
  const failedClock = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      dialogOpen: document.getElementById('newGameDialog').open,
      gameOverOpen: document.getElementById('gameOverDialog').open,
      active: document.getElementById('clockBlack').classList.contains('active'),
      timeForfeit: live.timeForfeit,
      remaining: live.clocks.bMs
    };
  });
  check(failedClock.dialogOpen && !failedClock.gameOverOpen &&
      !failedClock.active && !failedClock.timeForfeit &&
      failedClock.remaining === failedClockPausedAt,
    'a failed checkpoint keeps the blocked timed game frozen');
  await page.evaluate(function () {
    CoachStore.archiveGame = CoachStore.__failedClockArchive;
    delete CoachStore.__failedClockArchive;
  });
  await page.click('#newGameCancel');
  await page.waitForSelector('#gameOverDialog[open]');
  const resumedClock = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      dialogOpen: document.getElementById('newGameDialog').open,
      timeForfeit: live.timeForfeit
    };
  });
  check(!resumedClock.dialogOpen && resumedClock.timeForfeit &&
      resumedClock.timeForfeit.color === 'b',
    'Cancel resumes the same frozen clock and lets it expire normally');
  await page.click('#gameOverClose');

  // The same failed state must not restart a cancelled AI search behind the
  // modal. Cancel is the explicit instruction to resume from the exact FEN.
  await t.newGame({ mode: 'ai-b', difficulty: '1', timeControl: 'none' });
  const failedAiId = await page.evaluate(function () {
    CoachStore.__failedAiArchive = CoachStore.archiveGame;
    CoachStore.archiveGame = function () {
      return Promise.reject(new Error('quota'));
    };
    document.querySelector('#board .square[data-index="52"]').click(); // e2
    document.querySelector('#board .square[data-index="36"]').click(); // e4
    const id = JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
    document.getElementById('newGame').click();
    document.getElementById('newGameStart').click();
    return id;
  });
  await page.waitForFunction(function () {
    return document.getElementById('newGameStatus').textContent.indexOf(
      'could not be saved') !== -1;
  });
  await page.waitForTimeout(1000);
  const failedAi = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      id: live.gameId,
      sans: live.history.map(function (entry) { return entry.san; }),
      dialogOpen: document.getElementById('newGameDialog').open
    };
  });
  check(failedAi.dialogOpen && failedAi.id === failedAiId &&
      failedAi.sans.join(' ') === 'e4',
    'a failed checkpoint keeps the blocked AI position frozen');
  await page.evaluate(function () {
    CoachStore.archiveGame = CoachStore.__failedAiArchive;
    delete CoachStore.__failedAiArchive;
  });
  await page.click('#newGameCancel');
  await page.waitForFunction(function (id) {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return live.gameId === id && live.history.length === 2;
  }, failedAiId);
  const resumedAi = await page.evaluate(function () {
    const live = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      sans: live.history.map(function (entry) { return entry.san; }),
      dialogOpen: document.getElementById('newGameDialog').open
    };
  });
  check(!resumedAi.dialogOpen && resumedAi.sans.length === 2 &&
      resumedAi.sans[0] === 'e4',
    'Cancel resumes exactly one AI reply from the frozen position');
});
