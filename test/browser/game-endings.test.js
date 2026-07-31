/* Manual game endings: resignation and draw by agreement are first-class,
 * recoverable results that freeze clocks/search and round-trip through PGN. */
'use strict';
const fs = require('fs');
require('./helper').run('game endings', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function liveSave() {
    return page.evaluate(function () {
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    });
  }

  async function waitArchived(id) {
    await page.waitForFunction(function (gameId) {
      return CoachStore.getGame(gameId).then(function (game) { return !!game; });
    }, id);
    return page.evaluate(function (gameId) {
      return CoachStore.getGame(gameId);
    }, id);
  }

  async function download(selector) {
    const event = await Promise.all([
      page.waitForEvent('download'),
      page.click(selector)
    ]);
    return fs.readFileSync(await event[0].path(), 'utf8');
  }

  function clockSeconds(text) {
    const parts = String(text).trim().split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  async function installHeldWorker() {
    await page.evaluate(function () {
      window.__endingWorker = {
        posts: 0,
        terminations: 0,
        worker: null,
        message: null,
        realPost: Worker.prototype.postMessage,
        realTerminate: Worker.prototype.terminate
      };
      Worker.prototype.postMessage = function (message) {
        window.__endingWorker.posts++;
        window.__endingWorker.worker = this;
        window.__endingWorker.message = message;
        // Deliberately hold the request: the ending control must terminate it.
      };
      Worker.prototype.terminate = function () {
        window.__endingWorker.terminations++;
        return window.__endingWorker.realTerminate.call(this);
      };
    });
  }

  async function restoreWorker() {
    await page.evaluate(function () {
      if (!window.__endingWorker) return;
      Worker.prototype.postMessage = window.__endingWorker.realPost;
      Worker.prototype.terminate = window.__endingWorker.realTerminate;
    });
  }

  // Both controls are explicit, accessible 44px touch targets. The reusable
  // confirmation is named/described and initially focuses the safe action.
  check(await page.locator('#offerDraw').count() === 1 &&
        await page.locator('#resign').count() === 1,
    'Play exposes Offer draw and Resign controls');
  const controlHeights = await page.evaluate(function () {
    return ['offerDraw', 'resign'].map(function (id) {
      return document.getElementById(id).getBoundingClientRect().height;
    });
  });
  check(controlHeights.every(function (height) { return height >= 44; }),
    'game-ending controls meet the 44px touch-target minimum');
  check(await page.locator(
    '#endGameDialog[aria-labelledby="endGameTitle"][aria-describedby="endGameDetail"]'
  ).count() === 1, 'the ending confirmation has an accessible name and description');

  // Timed hot-seat resignation: after 1. e4 it is Black's turn, so Black is
  // the resigning side. Opening the confirmation freezes the clock; Cancel
  // resumes the exact game, and confirmation then scores 1-0.
  await t.newGame({ mode: 'pvp', timeControl: '300+3' });
  await mv('e2', 'e4');
  await page.click('#resign');
  check(await page.locator('#endGameDialog[open]').count() === 1 &&
        await page.evaluate(function () {
          return document.activeElement === document.getElementById('endGameCancel');
        }),
    'Resign opens confirmation with Cancel initially focused');
  check((await page.textContent('#endGameDetail')).includes('Resign as Black') &&
        (await page.textContent('#endGameDetail')).includes('1-0'),
    'hot-seat resignation identifies the live side to move and result');
  const pausedBlack = (await liveSave()).clocks.bMs;
  await page.waitForTimeout(2200);
  const stillPausedBlack = (await liveSave()).clocks.bMs;
  check(Math.abs(stillPausedBlack - pausedBlack) < 50 &&
        !(await page.getAttribute('#clockBlack', 'class')).includes('active'),
    'opening the confirmation freezes the running clock');
  await page.click('#endGameCancel');
  await page.waitForTimeout(2200);
  const resumedBlack = clockSeconds(await page.textContent('#clockBlack b'));
  check(resumedBlack <= Math.ceil(stillPausedBlack / 1000) - 2,
    'Cancel resumes the same clock from its frozen value');

  await page.click('#resign');
  await page.click('#endGameConfirm');
  await page.waitForSelector('#gameOverDialog[open]');
  check((await page.textContent('#gameOverTitle')).includes('White wins') &&
        (await page.textContent('#gameOverDetail')).includes('resignation') &&
        (await page.textContent('#status')).includes('(1-0)'),
    'confirmed Black resignation ends the game 1-0');
  const resignedSave = await liveSave();
  check(resignedSave.manualEnding.kind === 'resignation' &&
        resignedSave.manualEnding.color === 'b' &&
        Number.isFinite(resignedSave.endedAt),
    'the live save persists a semantic resignation and completion time');
  const resignedId = resignedSave.gameId;
  const resigned = await waitArchived(resignedId);
  check(resigned.result === '1-0' && resigned.reason === 'resignation' &&
        resigned.sans.join(' ') === 'e4',
    'the archive records the exact resignation result and position');

  await page.click('#gameOverClose');
  const liveResignPgn = await download('#exportPgn');
  const liveResignDebugPgn = await download('#exportPgnLog');
  check(liveResignPgn.includes('[Result "1-0"]') &&
        liveResignPgn.includes('[Termination "normal"]') &&
        liveResignPgn.trim().endsWith('1-0') &&
        liveResignDebugPgn.includes('[Termination "normal"]'),
    'both Play PGNs export resignation with Result and Termination normal');

  const frozenAfterEnd = (await liveSave()).clocks.bMs;
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(1200);
  const restoredResign = await liveSave();
  check(restoredResign.gameId === resignedId &&
        restoredResign.endedAt === resignedSave.endedAt &&
        restoredResign.clocks.bMs === frozenAfterEnd &&
        (await page.textContent('#status')).includes('1-0') &&
        await page.locator('#resign:disabled').count() === 1,
    'reload restores the manual ending without restarting its clock');
  await page.click('#tabReview');
  check(await page.locator('#liveGameNote').isHidden(),
    'a manually ended timed game does not show the running-game banner');
  await page.evaluate(function (id) {
    return CoachReview.openArchivedGame(id);
  }, resignedId);
  await page.waitForSelector('#reviewFlow:not([hidden])');
  const reviewResignPgn = await download('#reviewExportPgn');
  check(reviewResignPgn.includes('[Result "1-0"]') &&
        reviewResignPgn.includes('[Termination "normal"]') &&
        reviewResignPgn.includes('{resignation} 1-0'),
    'Review faithfully re-exports the resignation result, termination and reason');

  // Undo reverses the adjudication itself, not the last board move, and
  // restarts the timed game.
  await page.click('#tabPlay');
  await page.click('#undo');
  const reopened = await liveSave();
  check(reopened.history.length === 1 && reopened.manualEnding === null &&
        (await page.textContent('#status')).includes('Black to move') &&
        (await page.getAttribute('#clockBlack', 'class')).includes('active'),
    'Undo reopens the exact adjudicated position and restarts its clock');

  // Draw by agreement is distinct from abandonment and round-trips through
  // both Play and Review.
  await t.newGame({ mode: 'pvp', timeControl: 'none' });
  await mv('d2', 'd4');
  await mv('d7', 'd5');
  await page.click('#offerDraw');
  check((await page.textContent('#endGameTitle')).includes('Offer a draw') &&
        (await page.textContent('#endGameDetail')).includes('White offers') &&
        !(await page.textContent('#status')).includes('1/2-1/2'),
    'a draw offer awaits explicit agreement instead of ending immediately');
  await page.click('#endGameConfirm');
  await page.waitForSelector('#gameOverDialog[open]');
  check((await page.textContent('#gameOverTitle')).includes('Draw') &&
        (await page.textContent('#gameOverDetail')).includes('draw agreement') &&
        (await page.textContent('#status')).includes('1/2-1/2'),
    'accepted draw offer ends by agreement');
  const drawSave = await liveSave();
  const drawId = drawSave.gameId;
  const draw = await waitArchived(drawId);
  check(draw.result === '1/2-1/2' && draw.reason === 'draw agreement' &&
        draw.result !== '*' && draw.reason !== 'abandoned',
    'agreed draw archives as a scored terminal game, not abandonment');
  await page.click('#gameOverClose');
  const liveDrawPgn = await download('#exportPgn');
  check(liveDrawPgn.includes('[Result "1/2-1/2"]') &&
        liveDrawPgn.includes('[Termination "normal"]') &&
        liveDrawPgn.trim().endsWith('1/2-1/2'),
    'Play exports an agreed draw with its exact result and termination');
  await page.evaluate(function (id) {
    return CoachReview.openArchivedGame(id);
  }, drawId);
  await page.waitForSelector('#reviewFlow:not([hidden])');
  const reviewDrawPgn = await download('#reviewExportPgn');
  const reviewDrawDebugPgn = await download('#reviewExportPgnLog');
  check(reviewDrawPgn.includes('[Result "1/2-1/2"]') &&
        reviewDrawPgn.includes('[Termination "normal"]') &&
        reviewDrawPgn.includes('{draw agreement} 1/2-1/2') &&
        reviewDrawDebugPgn.includes('[Termination "normal"]'),
    'both Review PGNs faithfully preserve the agreed draw');

  // White resigns while Black's computer search is in flight. The human side,
  // not state.turn, must lose; cancellation terminates the worker and fences
  // even a manually delivered stale reply.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'ai-b', difficulty: 'master', timeControl: 'none' });
  await installHeldWorker();
  await mv('e2', 'e4');
  await page.waitForFunction(function () {
    return window.__endingWorker.posts === 1 &&
      document.getElementById('status').textContent.indexOf('thinking') !== -1;
  });
  await page.click('#resign');
  check((await page.textContent('#endGameDetail')).includes('Resign as White'),
    'vs computer, Resign names the human side during the AI turn');
  const whiteSearchStats = await page.evaluate(function () {
    return {
      posts: window.__endingWorker.posts,
      terminations: window.__endingWorker.terminations
    };
  });
  check(whiteSearchStats.posts === 1 && whiteSearchStats.terminations === 1,
    'opening resignation confirmation terminates the in-flight worker');
  await page.click('#endGameConfirm');
  await page.waitForSelector('#gameOverDialog[open]');
  const aiWhiteId = (await liveSave()).gameId;
  const aiWhite = await waitArchived(aiWhiteId);
  await page.evaluate(function () {
    const held = window.__endingWorker;
    if (held.worker && held.worker.onmessage) {
      held.worker.onmessage({ data: {
        id: held.message.id,
        move: { from: 12, to: 28, promotion: null },
        engine: 'wasm'
      } });
    }
  });
  await page.waitForTimeout(50);
  check(aiWhite.result === '0-1' && aiWhite.reason === 'resignation' &&
        (await liveSave()).history.length === 1,
    'White resignation during Black search stays 0-1 and ignores a stale reply');
  await restoreWorker();

  // Black can likewise resign during Chessy's opening search. Canceling a
  // draw prompt resumes exactly one fresh worker; the subsequent resignation
  // terminates that replacement too.
  await page.click('#gameOverClose');
  await installHeldWorker();
  await t.newGame({ mode: 'ai-w', difficulty: 'master', timeControl: 'none' });
  await page.waitForFunction(function () { return window.__endingWorker.posts === 1; });
  await page.click('#offerDraw');
  check((await page.textContent('#endGameDetail')).includes('offline game') &&
        (await page.evaluate(function () {
          return window.__endingWorker.terminations;
        })) === 1,
    'draw confirmation also stops the computer opening search');
  await page.click('#endGameCancel');
  await page.waitForFunction(function () { return window.__endingWorker.posts === 2; });
  check((await page.evaluate(function () {
    return window.__endingWorker.terminations;
  })) === 1, 'Cancel starts one fresh search from the unchanged position');
  await page.click('#resign');
  check((await page.textContent('#endGameDetail')).includes('Resign as Black') &&
        (await page.evaluate(function () {
          return window.__endingWorker.terminations;
        })) === 2,
    'Black can resign and terminates the replacement opening search');
  await page.click('#endGameConfirm');
  await page.waitForSelector('#gameOverDialog[open]');
  const aiBlack = await waitArchived((await liveSave()).gameId);
  check(aiBlack.result === '1-0' && aiBlack.reason === 'resignation' &&
        aiBlack.plies === 0,
    'human Black resignation during the computer opening search is 1-0');
  await restoreWorker();

  // A poisoned ending must reject the whole live save. Even when its move
  // history and FEN are otherwise valid, boot must not leak that replayed
  // position into the fresh-game fallback.
  await t.inject(function (saved) {
    saved.manualEnding = { kind: 'victory-by-decree' };
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
  }, resignedSave);
  const afterMalformedEnding = await liveSave();
  check(afterMalformedEnding.history.length === 0 &&
        afterMalformedEnding.manualEnding === null &&
        (await page.textContent('#status')).includes('White to move'),
    'a malformed persisted ending is rejected into a genuinely fresh game');
});
