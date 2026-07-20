/* Read-only Review: archived-game list, position browser, game-over
 * handoff by game UUID, and the live-clock guard rails around it. */
'use strict';
require('./helper').run('review', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  check(await page.locator('#tabPlay').count() === 1 && await page.locator('#tabReview').count() === 1,
    'Play and Review section tabs');
  check(await page.getAttribute('#tabPlay', 'aria-current') === 'page', 'Play tab current at boot');

  // Finish a game, then "Review game" hands off to the archived record.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'Review game opens the archived record in the coaching review');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewBack',
    'the asynchronous handoff moves focus into the review flow');

  // Browse position by position.
  check((await page.textContent('#reviewStatus')).includes('played here: f3'),
    'position browser shows the move played here');
  check(await page.locator('#revStart').isDisabled(), 'Start disabled at ply 0');
  await page.click('#revNext');
  check((await page.textContent('#reviewStatus')).includes('Position 1/4') &&
        (await page.textContent('#reviewStatus')).includes('Black to move'),
    'Next steps forward and tracks the side to move');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'), 'End reaches the final position');
  check(await page.locator('#revNext').isDisabled(), 'Next disabled at the end');
  await page.click('#revPrev');
  check((await page.textContent('#reviewStatus')).includes('played here: Qh4'),
    'Prev steps back to the last decision');
  await page.click('#reviewBack');
  await page.waitForSelector('.game-item');
  check(await page.locator('#reviewFlow').isHidden(), 'Back returns to the game list');
  await page.waitForFunction(function () {
    return document.activeElement && document.activeElement.className === 'game-item';
  });
  check(true, 'Back moves focus onto the game list (not left on a hidden button)');
  check((await page.textContent('.game-item')).includes('0-1') &&
        (await page.textContent('.game-item')).includes('Two players'),
    'game list shows result and mode');

  // Rematch → second entry; the list survives a reload.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  check(await page.getAttribute('#tabReview', 'aria-current') === 'page', 'Review tab activates');
  check(await page.locator('#viewPlay').isHidden(), 'Play view hidden on Review tab');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2, 'both archived games listed after reload');

  // Opening an archived game works from the list too.
  await page.locator('.game-item').first().click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'list click opens the position browser');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewBack',
    'opening from the list moves focus into the review flow');
  await page.click('#reviewBack');

  // A missing record (failed archive write) lands on the game list, not a
  // wrong game: simulate by handing off a nonexistent id.
  await page.evaluate(function () { return CoachReview.openArchivedGame('no-such-id'); });
  check(await page.locator('#reviewFlow').isHidden() &&
        await page.locator('#gameListWrap').isVisible(),
    'a missing record falls back to the game list');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'tabReview',
    'fallback still moves focus into Review');

  // A failed REPLACEMENT archive must not open the previous archived
  // ending of the same instance: after undo → replayed finish whose write
  // fails, "Review game" lands on the game list — the record on disk is
  // STALE, and opening it by gameId would show a wrong game.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () { return Promise.reject(new Error('quota')); };
  });
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  check(await page.locator('#gameListWrap').isVisible() &&
        await page.locator('#reviewFlow').isHidden(),
    'a failed replacement archive lands on the game list, not the stale record');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });

  // Arrow keys drive the coach board / Play replay in their own views only:
  // in Review, pressing ArrowLeft must not rewind the Play replay view.
  await page.keyboard.press('ArrowLeft');
  await page.click('#tabPlay');
  check((await page.textContent('#status')).toLowerCase().indexOf('start position') === -1,
    'replay keys pressed in Review do not drive the Play board');

  // Play is undisturbed.
  check(await page.locator('#viewPlay').isVisible(), 'Play tab returns to the game');
});
