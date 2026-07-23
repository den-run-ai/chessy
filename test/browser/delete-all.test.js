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
});
