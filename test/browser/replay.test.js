/* Replay/review UX: clickable move list, navigation, game-over actions,
 * undo during an AI search. */
'use strict';
require('./helper').run('replay', async function (t) {
  const page = t.page, check = t.check, mv = t.mv, sq = t.sq;

  // Two-player mode so both sides are human-driven and deterministic.
  await t.newGame({ mode: 'pvp' });

  // 1. e4 e5 2. Nf3 Nc6
  await mv('e2', 'e4'); await mv('e7', 'e5');
  await mv('g1', 'f3'); await mv('b8', 'c6');

  check(await page.locator('#moveList .ply').count() === 4, 'move list has 4 ply buttons');
  check((await page.textContent('#status')).includes('to move'), 'live status shown');

  // Click ply 1 (e4) -> review position after 1. e4.
  await page.locator('#moveList .ply').nth(0).click();
  check((await page.textContent('#status')).includes('Reviewing 1. e4 (1/4)'),
    'reviewing status after clicking first ply');
  check((await page.locator(sq('e4') + ' .piece').textContent()).trim() !== '',
    'viewed board: pawn on e4');
  check((await page.locator(sq('e5') + ' .piece').textContent()).trim() === '',
    'viewed board: e5 still empty (black reply not shown)');

  // Keyboard: ArrowLeft to start, ArrowRight forward.
  await page.keyboard.press('ArrowLeft');
  check((await page.textContent('#status')).includes('start position'), 'ArrowLeft reaches start position');
  check(await page.locator('#replayBack').isDisabled(), 'back button disabled at start');
  await page.keyboard.press('ArrowRight');
  check((await page.textContent('#status')).includes('1. e4'), 'ArrowRight steps forward');

  // End -> back to live.
  await page.keyboard.press('End');
  check((await page.textContent('#status')).includes('to move'), 'End returns to live');
  check(await page.locator('#replayLive').isDisabled(), 'live button disabled when live');

  // Board interaction is blocked while reviewing; a tap returns to live.
  await page.locator('#moveList .ply').nth(1).click();
  await page.click(sq('g2'));
  check((await page.textContent('#status')).includes('to move'), 'board tap while reviewing returns to live');
  check(!(await page.locator(sq('g2')).getAttribute('class')).includes('selected'),
    'the returning tap does not select a piece');

  // Browsing must not corrupt the live game.
  await mv('f1', 'b5');
  check(await page.locator('#moveList .ply').count() === 5, 'game continues correctly after replay browsing');

  // Undo while the AI is thinking (Master's 2s budget keeps it "thinking").
  await t.newGame({ mode: 'ai-b', difficulty: 'master' });
  await mv('e2', 'e4');
  await page.waitForFunction(function () {
    return document.getElementById('status').textContent.includes('thinking');
  });
  await page.click('#undo');
  await page.waitForFunction(function () {
    return !document.getElementById('status').textContent.includes('thinking');
  });
  check(await page.locator('#moveList .ply').count() === 0,
    'undo during AI search cancels it and takes back the human move');
  check((await page.locator(sq('e2') + ' .piece').textContent()).trim() !== '', 'pawn is back on e2');

  // Game-over dialog: fool's mate, then Review game — which now hands off
  // to the COACHING review of the just-archived game (reflection, lesson
  // cards), not the on-board replay.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  check((await page.textContent('#gameOverTitle')).includes('Black wins'), 'game-over dialog shown for checkmate');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'Review game opens the archived game in the coaching review');
  await page.click('#revNext');
  check((await page.textContent('#reviewStatus')).includes('Position 1/4'),
    'stepping through the coached game works');

  // The on-board replay still works from the Play tab.
  await page.click('#tabPlay');
  await page.keyboard.press('Home');
  check((await page.textContent('#status')).includes('start position'), 'on-board replay still reachable');
  await page.keyboard.press('End');
  await mv('f2', 'f3'); // must be ignored — game is over
  check(await page.locator('#moveList .ply').count() === 4, 'no moves playable after game over');

  // Rematch resets.
  await t.newGame({});
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverRematch');
  check(await page.locator('#moveList .ply').count() === 0, 'Rematch starts a fresh game');

  // Phone-sized regression: playing moves must never scroll the PAGE (the
  // move list sits below the fold; auto-revealing it yanked the board
  // off-screen). Only the move list scrolls internally.
  await page.setViewportSize({ width: 390, height: 700 });
  await t.newGame({ mode: 'pvp' });
  await mv('e2', 'e4'); await mv('e7', 'e5');
  await mv('g1', 'f3'); await mv('b8', 'c6');
  check(await page.evaluate(function () { return window.scrollY; }) === 0,
    'playing moves never scrolls the page — the board stays put');
  await page.setViewportSize({ width: 1280, height: 720 });
});
