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
});
