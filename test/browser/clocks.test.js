/* Chess clocks: time controls, increments, recording, flag falls, undo. */
'use strict';
require('./helper').run('clocks', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;
  const clockText = async function (sel) { return (await page.textContent(sel + ' b')).trim(); };
  const secs = function (s) { const m = s.split(':'); return Number(m[0]) * 60 + Number(m[1]); };

  check(await page.locator('#clocks').isHidden(), 'clocks hidden in untimed games');

  // 5+3 two-player game.
  await t.newGame({ mode: 'pvp', timeControl: '300+3' });
  check(await page.locator('#clocks').isVisible(), 'clocks shown for timed game');
  check(await clockText('#clockWhite') === '5:00', 'white starts at 5:00');
  check(await clockText('#clockBlack') === '5:00', 'black starts at 5:00');
  check((await page.getAttribute('#clockWhite', 'class')).includes('active'), 'white clock active first');
  check((await page.textContent('#setupSummary')).includes('5+3'), 'summary shows the time control');

  await mv('e2', 'e4');
  const wAfter = secs(await clockText('#clockWhite'));
  check(wAfter > 300 && wAfter <= 303, 'increment applied after the move (' + wAfter + 's)');
  check((await page.getAttribute('#clockBlack', 'class')).includes('active'), 'clock passes to black');

  // Leaving Play while the clocks run surfaces the live-game banner in the
  // coach views (the clock keeps ticking there and can flag); clicking it
  // returns to Play, where the banner never shows.
  check(await page.locator('#liveGameNote').isHidden(), 'no live-game banner while in Play');
  await page.click('#tabReview');
  await page.waitForSelector('#liveGameNote:not([hidden])');
  const note = await page.textContent('#liveGameNote');
  check(note.includes('Timed game running') && note.includes('White'),
    'coach views show the running-clocks banner');
  await page.click('#liveGameNote');
  check(await page.locator('#viewPlay').isVisible(), 'the banner returns to Play');
  check(await page.locator('#liveGameNote').isHidden(), 'banner hides back in Play');
  check(await page.evaluate(function () {
    return document.activeElement.classList.contains('square') &&
           !!document.activeElement.closest('#board');
  }), 'the banner hands focus to the Play board, not a now-hidden element');

  // Think time + remaining clocks recorded on the move.
  const rec = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).history[0].clock;
  });
  check(!!rec && rec.thinkMs >= 0 && rec.wMs > 300000 && rec.bMs === 300000,
    'move records thinkMs and both remaining clocks');

  // Replay keeps the LIVE clocks visible and active while showing the viewed
  // move's historical values in a separately labelled snapshot. Otherwise a
  // player can flag while the only clock on screen appears frozen (#34).
  await mv('e7', 'e5');
  await page.locator('#moveList .ply').nth(0).click();
  const replayLiveBefore = secs(await clockText('#clockWhite'));
  check((await page.getAttribute('#clockWhite', 'class')).includes('active'),
    'replay keeps the live side active');
  check(await page.locator('#replayClockSnapshot').isVisible() &&
        (await page.textContent('#replayClockLabel')).includes('after 1. e4') &&
        secs(await page.textContent('#replayClockWhite')) === Math.ceil(rec.wMs / 1000),
    'replay labels the recorded clock snapshot separately');
  const replaySnapshotBefore = secs(await page.textContent('#replayClockWhite'));
  await page.waitForTimeout(1600);
  const replayLiveAfter = secs(await clockText('#clockWhite'));
  check(replayLiveAfter <= replayLiveBefore - 1,
    'the visible live clock keeps decreasing during replay (' +
      replayLiveBefore + 's -> ' + replayLiveAfter + 's)');
  check(secs(await page.textContent('#replayClockWhite')) === replaySnapshotBefore,
    'the separately labelled historical replay snapshot stays fixed');
  await page.keyboard.press('End');
  check(await page.locator('#replayClockSnapshot').isHidden(),
    'returning live hides the historical clock snapshot');

  // Persistence: reload restores clocks and control.
  await page.reload();
  await page.waitForSelector('#board .square');
  check(await page.locator('#clocks').isVisible(), 'clocks survive reload');
  const wRestored = secs(await clockText('#clockWhite'));
  check(wRestored > 295 && wRestored <= 303, 'white clock restored (' + wRestored + 's)');

  // Regression: reload must not refund time that ticked since the last
  // full render — the ticker never writes localStorage, so without the
  // pagehide save a reload restored the stale value and handed the elapsed
  // time back to the player.
  const beforeWait = secs(await clockText('#clockWhite'));
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForSelector('#board .square');
  const afterReload = secs(await clockText('#clockWhite'));
  check(afterReload <= beforeWait - 2,
    'reload does not refund clock time (' + beforeWait + 's -> ' + afterReload + 's)');

  // Cheap final warning: if replay is open when the live side enters its last
  // 20 seconds, return to live automatically before the flag can appear.
  await t.inject(function () {
    const d = JSON.parse(localStorage.getItem('chessy-game-v1'));
    d.clocks.wMs = 19500; // white to move after 1. e4 e5
    localStorage.setItem('chessy-game-v1', JSON.stringify(d));
  });
  await page.locator('#moveList .ply').nth(0).click();
  await page.waitForFunction(function () {
    return document.getElementById('replayLive').disabled &&
      document.getElementById('clockWhite').classList.contains('low');
  }, { timeout: 5000 });
  check(!(await page.textContent('#status')).includes('Reviewing') &&
        (await page.getAttribute('#clockWhite', 'class')).includes('active'),
    'low live time automatically leaves replay with its warning visible');

  // Flag: give the side to move 700 ms and wait for the forfeit.
  await t.inject(function () {
    const d = JSON.parse(localStorage.getItem('chessy-game-v1'));
    d.clocks.wMs = 700; // white to move after 1. e4 e5
    localStorage.setItem('chessy-game-v1', JSON.stringify(d));
  });
  await page.waitForSelector('#gameOverDialog[open]', { timeout: 10000 });
  check((await page.textContent('#gameOverTitle')).includes('Black wins'), 'flag fall: black wins on time');
  check((await page.textContent('#gameOverDetail')).includes('time forfeit'), 'reason is time forfeit');
  check(await clockText('#clockWhite') === '0:00', 'flagged clock shows 0:00');

  // Undo rewinds the forfeit along with the move.
  await page.click('#gameOverClose');
  await page.click('#undo');
  check((await page.textContent('#status')).includes('to move'), 'undo after flag resumes the game');
  check(secs(await clockText('#clockWhite')) > 295, 'undo restores the recorded clock');

  // New untimed game hides the clocks again.
  await t.newGame({ timeControl: 'none' });
  check(await page.locator('#clocks').isHidden(), 'switching back to untimed hides clocks');

  // A promotion is not a move until the player chooses a piece. In
  // particular, the chooser must not outlive a flag or edit a newer game.
  // Use a real, replayable opening rather than a custom board injection.
  const promotionSave = await page.evaluate(function () {
    let s = Chess.newGameState();
    ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'e7e6', 'a6a7', 'e6e5']
      .forEach(function (uci) {
        const move = Chess.legalMoves(s).find(function (m) {
          return Chess.sqName(m.from) + Chess.sqName(m.to) === uci;
        });
        s = Chess.playMove(s, move);
      });
    return {
      fen: Chess.toFen(s), history: s.history,
      mode: 'pvp', difficulty: '2', timeControl: '300+3',
      clocks: { wMs: 60000, bMs: 60000 }
    };
  });

  async function openPromotion(id) {
    await t.inject(function (saved) {
      localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
    }, Object.assign({}, promotionSave, { gameId: id }));
    await mv('a7', 'b8');
    await page.evaluate(function () {
      window.__retiredPromotionButton = document.querySelector(
        '#promotionChoices [aria-label="Promote to queen"]');
    });
  }

  function expirePromotionClock() {
    const now = Date.now;
    Date.now = function () { return now() + 120000; };
  }

  // The ticker sees the flag while the dialog is open. A retained click
  // simulates already queued input, independently of the dialog being closed.
  const flaggedId = 'clock-promotion-flag';
  await openPromotion(flaggedId);
  await page.evaluate(expirePromotionClock);
  await page.waitForSelector('#gameOverDialog[open]');
  check(!await page.locator('#promotionDialog').evaluate(function (d) { return d.open; }),
    'flagging while choosing a promotion closes the obsolete picker');
  await page.click('#gameOverClose');
  const afterFlagClick = await page.evaluate(function () {
    window.__retiredPromotionButton.click();
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(afterFlagClick.history.length === 8 && afterFlagClick.fen === promotionSave.fen &&
        afterFlagClick.timeForfeit.color === 'w' && afterFlagClick.clocks.wMs === 0,
    'a promotion click after flag leaves the terminal board, history and clock unchanged');
  await page.waitForFunction(function (id) {
    return CoachStore.getGame(id).then(function (game) { return !!game; });
  }, flaggedId);
  const flaggedArchive = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, flaggedId);
  check(flaggedArchive.sans.length === 8 && flaggedArchive.result === '0-1' &&
        flaggedArchive.reason === 'time forfeit',
    'the archive keeps the unpromoted position and original time-forfeit result');
  await page.reload();
  await page.waitForSelector('#board .square');
  const reloadedFlag = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(reloadedFlag.fen === promotionSave.fen && reloadedFlag.history.length === 8 &&
        reloadedFlag.timeForfeit.color === 'w',
    'the unchanged time-forfeit position survives reload');

  // The click and the time jump happen within the same event-loop turn, so
  // the 200 ms ticker cannot rescue a missing pre-commit deadline check.
  await openPromotion('clock-promotion-before-tick');
  const beforeTick = await page.evaluate(function () {
    const now = Date.now;
    Date.now = function () { return now() + 120000; };
    window.__retiredPromotionButton.click();
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(beforeTick.history.length === 8 && beforeTick.fen === promotionSave.fen &&
        beforeTick.timeForfeit && beforeTick.timeForfeit.color === 'w' &&
        beforeTick.clocks.wMs === 0,
    'a promotion at an expired deadline flags before committing or awarding increment');

  await openPromotion('clock-promotion-cancel');
  await page.keyboard.press('Escape');
  await page.waitForFunction(function () {
    return !document.getElementById('promotionDialog').open;
  });
  const cancelled = await page.evaluate(function () {
    window.__retiredPromotionButton.click();
    return JSON.parse(localStorage.getItem('chessy-game-v1')).history.length;
  });
  check(cancelled === 8, 'Escape retires the promotion callback without moving');
  await mv('a7', 'b8');
  await page.evaluate(function () { window.__retiredPromotionButton.click(); });
  check(await page.locator('#promotionDialog[open]').count() === 1,
    'a retired button cannot dismiss or choose a newer promotion');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  const validPromotion = await page.evaluate(function () {
    window.__retiredPromotionButton.click();
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(validPromotion.history.length === 9 && validPromotion.history[8].move.promotion === 'N',
    'a fresh underpromotion commits exactly once after cancellation');

  // Native modals normally block these controls. Exercise their event
  // handlers directly to verify that an already queued transition retires
  // the callback as well as hiding the dialog.
  await openPromotion('clock-promotion-undo');
  const afterUndo = await page.evaluate(function () {
    document.getElementById('undo').click();
    window.__retiredPromotionButton.click();
    return {
      open: document.getElementById('promotionDialog').open,
      plies: JSON.parse(localStorage.getItem('chessy-game-v1')).history.length
    };
  });
  check(!afterUndo.open && afterUndo.plies === 7,
    'Undo retires a promotion without allowing its stale move into the rewound position');

  await openPromotion('clock-promotion-replay');
  const afterReplay = await page.evaluate(function () {
    document.getElementById('replayStart').click();
    window.__retiredPromotionButton.click();
    return {
      open: document.getElementById('promotionDialog').open,
      plies: JSON.parse(localStorage.getItem('chessy-game-v1')).history.length
    };
  });
  check(!afterReplay.open && afterReplay.plies === 8,
    'replay retires a promotion and preserves the live position');

  await openPromotion('clock-promotion-new-game');
  await page.evaluate(function () { document.getElementById('newGame').click(); });
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  const afterNewGame = await page.evaluate(function () {
    window.__retiredPromotionButton.click();
    return {
      open: document.getElementById('promotionDialog').open,
      plies: JSON.parse(localStorage.getItem('chessy-game-v1')).history.length
    };
  });
  check(!afterNewGame.open && afterNewGame.plies === 0,
    'New Game retires a promotion without letting its callback change the new game');

  // Ordinary moves have the same admission boundary as promotions. Hold the
  // clock jump and input in one event-loop turn so no ticker can flag first.
  const ordinarySave = await page.evaluate(function () {
    let s = Chess.newGameState();
    ['e2e4', 'e7e5'].forEach(function (uci) {
      s = Chess.playMove(s, Chess.legalMoves(s).find(function (m) {
        return Chess.sqName(m.from) + Chess.sqName(m.to) === uci;
      }));
    });
    return {
      fen: Chess.toFen(s), history: s.history,
      mode: 'pvp', difficulty: '2', timeControl: '300+3',
      clocks: { wMs: 60000, bMs: 300000 }
    };
  });
  async function seedOrdinary(id, ai) {
    await t.inject(function (saved) {
      localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
    }, Object.assign({}, ordinarySave, { gameId: id, mode: ai ? 'ai-w' : 'pvp' }));
  }
  async function checkUnchangedFlag(id, label) {
    const saved = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    });
    check(saved.fen === ordinarySave.fen && saved.history.length === 2 &&
        saved.timeForfeit && saved.timeForfeit.color === 'w' &&
        saved.clocks.wMs === 0,
      label + ': expires before changing the board, history or clock increment');
    await page.waitForFunction(function (gameId) {
      return CoachStore.getGame(gameId).then(function (game) { return !!game; });
    }, id);
    const archive = await page.evaluate(function (gameId) {
      return CoachStore.getGame(gameId);
    }, id);
    check(archive.sans.length === 2 && archive.result === '0-1' &&
        archive.reason === 'time forfeit',
      label + ': archives the original position and time-forfeit result');
    await page.reload();
    await page.waitForSelector('#board .square');
    const restored = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    });
    check(restored.fen === ordinarySave.fen && restored.history.length === 2 &&
        restored.timeForfeit && restored.timeForfeit.color === 'w',
      label + ': preserves the original terminal position on reload');
  }

  await seedOrdinary('clock-human-before-tick');
  await page.click(t.sq('g1'));
  await page.evaluate(function () {
    const now = Date.now;
    Date.now = function () { return now() + 120000; };
    document.querySelector('#board [data-index="45"]').click(); // Nf3
  });
  await checkUnchangedFlag('clock-human-before-tick', 'late human move');

  // Charge the exact admission instant, even if applying a legal move takes
  // the wall clock across the deadline before its increment is recorded.
  await seedOrdinary('clock-human-admitted');
  await page.click(t.sq('g1'));
  const humanAdmitted = await page.evaluate(function () {
    const now = Date.now, playMove = Chess.playMove, admittedAt = now();
    Date.now = function () { return admittedAt; };
    Chess.playMove = function (s, m) {
      const next = playMove(s, m);
      Date.now = function () { return admittedAt + 120000; };
      return next;
    };
    try {
      document.querySelector('#board [data-index="45"]').click();
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    } finally { Date.now = now; Chess.playMove = playMove; }
  });
  check(humanAdmitted.history.length === 3 && !humanAdmitted.timeForfeit &&
      humanAdmitted.history[2].clock.thinkMs < 60000 && humanAdmitted.clocks.wMs > 3000,
    'an admitted human move uses one clock snapshot for deadline and increment');

  // Hold a genuine WASM worker reply at the page boundary. Delivering it in
  // the same turn as the jump must not append an already-expired AI move.
  await page.addInitScript(function () {
    const NativeWorker = window.Worker;
    window.Worker = function (url, options) {
      const native = new NativeWorker(url, options);
      if (String(url).indexOf('ai-worker') < 0) return native;
      const worker = {
        postMessage: function (request) { native.postMessage(request); },
        terminate: function () { native.terminate(); },
        onmessage: null, onerror: null
      };
      native.onmessage = function (event) {
        window.__heldClockReply = function () {
          if (worker.onmessage) worker.onmessage(event);
        };
      };
      native.onerror = function (event) {
        if (worker.onerror) worker.onerror(event);
      };
      return worker;
    };
  });
  async function waitForHeldReply() {
    await page.waitForFunction(function () {
      return typeof window.__heldClockReply === 'function';
    }, null, { timeout: 10000 });
  }
  await seedOrdinary('clock-ai-before-tick', true);
  await waitForHeldReply();
  await page.evaluate(function () {
    const now = Date.now;
    Date.now = function () { return now() + 120000; };
    window.__heldClockReply();
    window.__heldClockReply(); // already queued duplicate from the retired worker
  });
  await checkUnchangedFlag('clock-ai-before-tick', 'late AI reply');

  await seedOrdinary('clock-ai-admitted', true);
  await waitForHeldReply();
  const aiAdmitted = await page.evaluate(function () {
    const now = Date.now, playMove = Chess.playMove, admittedAt = now();
    Date.now = function () { return admittedAt; };
    Chess.playMove = function (s, m) {
      const next = playMove(s, m);
      Date.now = function () { return admittedAt + 120000; };
      return next;
    };
    try {
      window.__heldClockReply();
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    } finally { Date.now = now; Chess.playMove = playMove; }
  });
  check(aiAdmitted.history.length === 3 && !aiAdmitted.timeForfeit &&
      aiAdmitted.history[2].clock.thinkMs < 60000 && aiAdmitted.clocks.wMs > 3000,
    'an admitted AI move uses one clock snapshot for deadline and increment');
});
