/*
 * Fenced Delete-all (roadmap #23, Phase 4b4). Deleting all training data must
 * clear EVERY store, be fenced (dialog + explicit confirm), and — critically —
 * leave nothing that reappears after a reload: the boot re-archive of the
 * locally saved finished game and the durability queue are the resurrection
 * vectors, and both are fenced.
 */
'use strict';
require('./helper').run('delete-all', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function counts() {
    return page.evaluate(function () {
      return Promise.all([CoachStore.listGames(), CoachStore.listCards()])
        .then(function (r) { return { games: r[0].length, cards: r[1].length }; });
    });
  }

  // Play a game to completion: it is archived AND saved to chessy-game-v1, so a
  // boot re-archive on the next load is a real resurrection vector.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4'); // fool's mate
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#gameList button').length >= 1;
  }, { timeout: 5000 });
  check((await counts()).games === 1, 'the played game is archived');
  check(await page.evaluate(function () {
    try { return !!JSON.parse(localStorage.getItem('chessy-game-v1')); } catch (e) { return false; }
  }), 'the finished game is saved locally (a reload would re-archive it)');

  // Seed a recomputable analysis + scan job too, to prove Delete-all clears
  // every store, not just games/cards.
  await page.evaluate(function () {
    return Promise.all([
      CoachStore.putAnalysis({ key: 'k', gameId: 'g', ply: 0, gameRev: 'x', fingerprint: 'f',
        engineId: 'e', configHash: 'c', complete: true, result: {}, createdAt: 1 }),
      CoachStore.putJob({ gameId: 'g', state: 'paused', cursorPly: 0, moments: [] })
    ]);
  });

  // Delete all — fenced.
  await page.click('#reviewBack');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  await page.click('#deleteAllBtn');
  check(await page.$eval('#deleteAllDialog', function (d) { return d.open === true; }),
    'Delete all opens a confirm dialog (first fence)');
  check(await page.evaluate(function () {
    return document.activeElement && document.activeElement.id === 'deleteAllCancel';
  }), 'Delete all initially focuses Cancel, not Delete');
  await page.click('#deleteAllConfirm');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  }, { timeout: 5000 });
  const afterDelete = await counts();
  check(afterDelete.games === 0 && afterDelete.cards === 0, 'delete-all empties games and cards');
  const leftovers = await page.evaluate(function () {
    return Promise.all([CoachStore.listAnalysesForGame('g'), CoachStore.getJob('g')])
      .then(function (r) { return { analyses: r[0].length, job: r[1] ? 1 : 0 }; });
  });
  check(leftovers.analyses === 0 && leftovers.job === 0, 'analyses and scan jobs are cleared too');
  check(await page.evaluate(function () { return localStorage.getItem('chessy-pending-archive-v1'); }) === null,
    'the durability queue is dropped');
  // The live finished game's exact ENDING is fenced — by signature (id + moves
  // + result + reason), not a timestamp (which a pre-archive save may lack, or
  // a clock change may skew) and not the bare id (so a later Undo → revised
  // finish still archives).
  check(await page.evaluate(function () {
    var saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    if (!saved) return false;
    var sans = (saved.history || []).map(function (h) { return h.san; });
    return ChessyArchive.isFencedEnding(saved.gameId, sans, '0-1', 'checkmate');
  }), 'the live finished game ending is fenced by signature');

  // RELOAD: boot re-runs reconcilePending and the saved-finished-game
  // re-archive. The identity fence (dropped queue + fenced game id) must keep
  // the archive empty regardless of any timestamp.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(1500); // let any boot archive work settle
  const afterReload = await counts();
  check(afterReload.games === 0 && afterReload.cards === 0,
    'the archive is STILL empty after reload — the cleared game does not resurrect');

  // Quota fallback: if the ending fence cannot be persisted, the app removes
  // the saved finished game instead, so it still cannot resurrect on boot. We
  // force the fence to fail by overriding fenceEnding (WebKit does not allow
  // reassigning localStorage.setItem, so patch the archive method directly).
  const fallback = await page.evaluate(function () {
    // The reload above replayed the finished fool's mate, so the LIVE state
    // (which the app.js listener reads — not any blob) is a finished game with
    // its save still in localStorage.
    var real = ChessyArchive.fenceEnding;
    ChessyArchive.fenceEnding = function () { return false; }; // fence that cannot persist
    var had = !!localStorage.getItem('chessy-game-v1');
    document.dispatchEvent(new CustomEvent('chessy:archivecleared'));
    var still = !!localStorage.getItem('chessy-game-v1');
    ChessyArchive.fenceEnding = real;
    return { had: had, still: still };
  });
  check(fallback.had && !fallback.still,
    'quota: when the fence cannot persist, the saved finished game is removed instead');

  // ---- P1: a REJECTED clear preserves every recovery source. A parked
  // durability-queue entry can be the only copy of a game precisely when
  // IndexedDB is failing, so a failed delete must not have dropped it. ----
  const preserved = await page.evaluate(function () {
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      keep: { w: 't', rec: { id: 'keep', sans: ['e4'], result: '*', reason: 'imported' } } }));
    var realDelete = CoachStore.deleteAllData;
    CoachStore.deleteAllData = function () { return Promise.reject(new Error('storage unavailable')); };
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      // Let the rejected promise settle and the status paint.
      setTimeout(function () {
        CoachStore.deleteAllData = realDelete;
        resolve({
          status: document.getElementById('dataStatus').textContent,
          queue: localStorage.getItem('chessy-pending-archive-v1'),
          keepFenced: ChessyArchive.isFencedEnding('keep', ['e4'], '*', 'imported')
        });
      }, 200);
    });
  });
  check(/Delete failed/.test(preserved.status), 'a rejected clear reports failure');
  check(preserved.queue !== null && preserved.keepFenced === false,
    'a rejected clear preserves the durability queue and fences nothing');

  // ---- P1: a game finishing DURING a failed clear is PARKED, not lost. Even
  // if the player rematches (overwriting the live save) before reloading, the
  // parked entry survives to boot-reconcile. ----
  const parkedOnFail = await page.evaluate(function () {
    localStorage.removeItem('chessy-pending-archive-v1');
    var realDelete = CoachStore.deleteAllData;
    // A clear that rejects, but ONLY after a live finish had a chance to record.
    CoachStore.deleteAllData = function () {
      var st = { over: true, result: '1-0', reason: 'checkmate' };
      // While suspended (the delete set it), this finish must park, not commit.
      return ChessyArchive.record({ history: [{ san: 'e4' }] }, { mode: 'pvp' }, st, 'mid-delete', {})
        .then(function () { return Promise.reject(new Error('storage unavailable')); });
    };
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      setTimeout(function () {
        CoachStore.deleteAllData = realDelete;
        var q = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || '{}');
        resolve({ parked: !!q['mid-delete'],
          fenced: ChessyArchive.isFencedEnding('mid-delete', ['e4'], '1-0', 'checkmate') });
      }, 200);
    });
  });
  check(parkedOnFail.parked === true && parkedOnFail.fenced === false,
    'a finish during a FAILED clear is parked (recoverable), not fenced or lost');

  // ---- Durable fencing confirmation: if the queue cannot be neutralized, a
  // successful clear reports a QUALIFIED success, not a clean one. ----
  const qualified = await page.evaluate(function () {
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      x: { w: 't', rec: {
        id: 'x', source: 'play', sans: [], result: '*', reason: 'imported',
        mode: 'pvp', plies: 0, createdAt: 1
      } } }));
    var realDrop = ChessyArchive.dropPendingQueue;
    var realFenceBatch = ChessyArchive.fenceEndings;
    ChessyArchive.fenceEndings = function () { return false; }; // blocked fence write
    ChessyArchive.dropPendingQueue = function () { return false; }; // blocked removal
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      setTimeout(function () {
        ChessyArchive.dropPendingQueue = realDrop;
        ChessyArchive.fenceEndings = realFenceBatch;
        var el = document.getElementById('dataStatus');
        resolve({ text: el.textContent, kind: el.dataset.kind });
      }, 300);
    });
  });
  check(/Reload once storage is available/.test(qualified.text) && qualified.kind === 'error',
    'a delete whose recovery could not be neutralized reports a qualified success');

  // The persisted save can be older than the live state when a later save
  // failed. Delete-all must neutralize that on-disk finished game too, even
  // when the live game is new and unfinished.
  await t.newGame({ mode: 'pvp' });
  const staleBlob = await page.evaluate(function () {
    let s = Chess.newGameState();
    function play(from, to) {
      const legal = Chess.legalMoves(s);
      s = Chess.playMove(s, legal.find(function (m) {
        return Chess.sqName(m.from) === from && Chess.sqName(m.to) === to;
      }));
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4');
    const blob = JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', difficulty: '2',
      timeControl: 'none', clocks: null, timeForfeit: null, flipped: false,
      gameId: 'stale-finished-game', endedAt: 42
    });
    localStorage.setItem('chessy-game-v1', blob);
    localStorage.removeItem('chessy-pending-archive-v1');
    return blob;
  });

  // A temporary read failure is not proof that the persisted recovery source
  // is absent. If it cannot be removed either, success must be qualified.
  await page.evaluate(function () {
    const realGet = Storage.prototype.getItem;
    const realRemove = Storage.prototype.removeItem;
    window.__restoreSavedGameStorage = function () {
      Storage.prototype.getItem = realGet;
      Storage.prototype.removeItem = realRemove;
      delete window.__restoreSavedGameStorage;
    };
    Storage.prototype.getItem = function (key) {
      if (key === 'chessy-game-v1') throw new Error('read blocked');
      return realGet.call(this, key);
    };
    Storage.prototype.removeItem = function (key) {
      if (key === 'chessy-game-v1') throw new Error('remove blocked');
      return realRemove.call(this, key);
    };
    document.getElementById('deleteAllBtn').click();
    document.getElementById('deleteAllConfirm').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent
      .indexOf('Reload once storage is available') !== -1;
  }, { timeout: 5000 });
  const unreadable = await page.evaluate(function () {
    window.__restoreSavedGameStorage();
    const el = document.getElementById('dataStatus');
    return { text: el.textContent, kind: el.dataset.kind,
      saveStillPresent: localStorage.getItem('chessy-game-v1') !== null };
  });
  check(/Reload once storage is available/.test(unreadable.text) &&
      unreadable.kind === 'error' && unreadable.saveStillPresent,
    'an unreadable and unremovable saved game yields qualified success');

  await page.evaluate(function () {
    document.getElementById('deleteAllBtn').click();
    document.getElementById('deleteAllConfirm').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  }, { timeout: 5000 });
  check(await page.evaluate(function () {
    return ChessyArchive.isFencedEnding(
      'stale-finished-game', ['f3', 'e5', 'g4', 'Qh4#'], '0-1', 'checkmate') ||
      localStorage.getItem('chessy-game-v1') === null;
  }), 'Delete-all neutralizes a different finished game in the persisted save');

  // Recreate that exact stale blob from outside the app so pagehide cannot
  // overwrite the fixture. Its persisted fence must still prevent recovery.
  await t.inject(function (blob) {
    localStorage.setItem('chessy-game-v1', blob);
  }, staleBlob);
  await page.waitForTimeout(500);
  check((await counts()).games === 0,
    'the separately persisted stale finish stays deleted after a fresh boot');

  // The UI holds the store write barrier for the whole destructive operation.
  const blockedDuringDelete = await page.evaluate(function () {
    const realDelete = CoachStore.deleteAllData;
    let release;
    CoachStore.deleteAllData = function () {
      return new Promise(function (resolve) { release = resolve; });
    };
    document.getElementById('deleteAllBtn').click();
    document.getElementById('deleteAllConfirm').click();
    return Promise.all([
      CoachStore.addCard({ gameId: 'late', ply: 0, due: 0, step: -1, attempts: [],
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' })
        .then(function () { return 'accepted'; }, function () { return 'rejected'; }),
      CoachStore.importGame({ id: 'late', sans: [], result: '*', createdAt: 1 })
        .then(function () { return 'accepted'; }, function () { return 'rejected'; })
    ]).then(function (outcomes) {
      release(true);
      return new Promise(function (resolve) {
        setTimeout(function () {
          CoachStore.deleteAllData = realDelete;
          resolve(outcomes);
        }, 100);
      });
    });
  });
  check(blockedDuringDelete.every(function (v) { return v === 'rejected'; }),
    'transaction and direct writes are rejected until Delete-all settles');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  }, { timeout: 5000 });

  // Delay the boot re-offer, replace its live save with a new unfinished game,
  // then clear the archive. Releasing recovery afterward must not reinsert the
  // pre-clear boot snapshot.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.addInitScript(function () {
    Object.defineProperty(window, 'ChessyArchive', {
      configurable: true,
      set: function (value) {
        const realReconcile = value.reconcilePending;
        value.reconcilePending = function () {
          return new Promise(function (resolve, reject) {
            window.__releaseBootRecovery = function () {
              delete window.__releaseBootRecovery;
              Promise.resolve(realReconcile.call(value)).then(resolve, reject);
            };
          });
        };
        Object.defineProperty(window, 'ChessyArchive', {
          configurable: true, writable: true, value: value
        });
      }
    });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForFunction(function () { return typeof window.__releaseBootRecovery === 'function'; });
  await t.newGame({ mode: 'pvp' });
  await page.evaluate(function () {
    document.getElementById('deleteAllBtn').click();
    document.getElementById('deleteAllConfirm').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  }, { timeout: 5000 });
  await page.evaluate(function () { window.__releaseBootRecovery(); });
  await page.waitForTimeout(300);
  check((await counts()).games === 0,
    'a delayed pre-clear boot snapshot is invalidated instead of reinserted');
});
