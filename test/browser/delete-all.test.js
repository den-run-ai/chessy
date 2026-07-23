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
      x: { w: 't', rec: { id: 'x', sans: [], result: '*', reason: 'imported' } } }));
    var realDrop = ChessyArchive.dropPendingQueue;
    ChessyArchive.dropPendingQueue = function () { return false; }; // blocked removal
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      setTimeout(function () {
        ChessyArchive.dropPendingQueue = realDrop;
        var el = document.getElementById('dataStatus');
        resolve({ text: el.textContent, kind: el.dataset.kind });
      }, 300);
    });
  });
  check(/Reload once storage is available/.test(qualified.text) && qualified.kind === 'error',
    'a delete whose recovery could not be neutralized reports a qualified success');

  // ---- P1 (persisted-save resurrection): chessy-game-v1 can hold a DIFFERENT
  // finished game than the live in-memory one — e.g. save() failed (quota) when
  // a new game started, so the persisted record is a PRIOR finish while the live
  // game is the new one. The app.js listener only fences the LIVE game's id; a
  // stale save carrying a different id would slip past it and re-archive on the
  // next boot. Delete-all must reconstruct and fence the PERSISTED save directly.
  // Build the stale blob from a REAL finished save (its move format is the app's
  // own), only swapping in an id that no live game can ever hold — so fencing
  // THAT id can only have come from the persisted-save path, not the listener. --
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4'); // fool's mate again
  await page.waitForSelector('#gameOverDialog[open]');
  const staleBlob = await page.evaluate(function () {
    var real = JSON.parse(localStorage.getItem('chessy-game-v1'));
    real.gameId = 'stale-finished-game'; // distinct from any live game's id
    return JSON.stringify(real);
  });
  await page.click('#gameOverReview'); // dismiss the game-over dialog
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.click('#reviewBack');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  const persistedP1 = await page.evaluate(function (blob) {
    localStorage.setItem('chessy-game-v1', blob);
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      setTimeout(function () {
        resolve({
          fenced: ChessyArchive.isFencedEnding('stale-finished-game',
            ['f3', 'e5', 'g4', 'Qh4#'], '0-1', 'checkmate'),
          removed: localStorage.getItem('chessy-game-v1') === null
        });
      }, 300);
    });
  }, staleBlob);
  check(persistedP1.fenced === true || persistedP1.removed === true,
    'Delete-all neutralizes a DIFFERENT finished game persisted in chessy-game-v1, not just the live game');
  // And it stays gone across a reload — the actual resurrection guarantee.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(1200);
  check((await counts()).games === 0,
    'the stale persisted save does not resurrect after reload');

  // ---- TT8GM: a training/derived write fired DURING an in-flight delete is
  // rejected, so it cannot commit behind the clear and recreate cleared data.
  // The delete engages the store write-lock (via suspendArchive) for its whole
  // duration, before deleteAllData resolves. ----
  const writeDuringDelete = await page.evaluate(function () {
    var realDelete = CoachStore.deleteAllData;
    var release;
    CoachStore.deleteAllData = function () {
      return new Promise(function (res) { release = res; })
        .then(function () { return realDelete(); });
    };
    return new Promise(function (resolve) {
      document.getElementById('deleteAllBtn').click();
      document.getElementById('deleteAllConfirm').click();
      // The delete is now in-flight and the write-lock is held.
      setTimeout(function () {
        CoachStore.gradeCard('anything', 3).then(
          function () { return 'accepted'; }, function () { return 'rejected'; }
        ).then(function (outcome) {
          release(); // let the (stubbed) delete complete
          setTimeout(function () { CoachStore.deleteAllData = realDelete; resolve(outcome); }, 150);
        });
      }, 50);
    });
  });
  check(writeDuringDelete === 'rejected',
    'a training write during an in-flight delete is rejected (cannot recreate cleared data)');
});
