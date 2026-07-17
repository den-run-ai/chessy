/* Board accessibility: ARIA grid, roving tab stop, arrow-key navigation,
 * stateful square announcements. */
'use strict';
require('./helper').run('a11y', async function (t) {
  const page = t.page, check = t.check, idx = t.idx, sq = t.sq, mv = t.mv;
  const active = function () {
    return page.evaluate(function () { return document.activeElement.dataset.index || null; });
  };

  await t.newGame({ mode: 'pvp' });

  check(await page.locator('#board > [role="row"]').count() === 8, 'board has 8 ARIA rows');
  check(await page.locator('#board [role="gridcell"]').count() === 64, 'board has 64 gridcells');
  check(await page.locator('#board .square[tabindex="0"]').count() === 1, 'exactly one roving tab stop');

  await page.locator('#board .square[tabindex="0"]').focus();
  check(Number(await active()) === idx('e2'), 'initial tab stop is e2');
  await page.keyboard.press('ArrowUp');
  check(Number(await active()) === idx('e3'), 'ArrowUp moves focus to e3');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  check(Number(await active()) === idx('f4'), 'ArrowUp+ArrowRight reaches f4');
  await page.keyboard.press('Home');
  check(Number(await active()) === idx('a4'), 'Home jumps to row start (a4)');
  check(await page.locator('#board .square[tabindex="0"]').count() === 1,
    'tab stop stays unique after navigation');

  // Play 1. e4 with the keyboard alone.
  await page.locator(sq('e2')).focus();
  await page.keyboard.press('Enter');
  const sel = await page.locator(sq('e2')).getAttribute('aria-label');
  check(sel.includes('white pawn') && sel.includes('selected'),
    'selected pawn announces "white pawn, selected"');
  check((await page.locator(sq('e4')).getAttribute('aria-label')).includes('legal move'),
    'target square announces "legal move"');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const e4 = await page.locator(sq('e4')).getAttribute('aria-label');
  check(e4.includes('white pawn') && e4.includes('last move'),
    'e4 played via keyboard, announces pawn + last move');

  // Replay keys work outside the board...
  await page.locator('#status').click();
  await page.keyboard.press('ArrowLeft');
  check((await page.textContent('#status')).includes('start position'),
    'ArrowLeft outside the board still drives replay');
  await page.keyboard.press('End');
  check((await page.textContent('#status')).includes('to move'), 'End outside the board returns to live');

  // ...but move board focus when pressed inside it.
  await page.locator(sq('e4')).focus();
  await page.keyboard.press('ArrowLeft');
  check(!(await page.textContent('#status')).includes('Reviewing'),
    'ArrowLeft inside the board does not trigger replay');
  check(Number(await active()) === idx('d4'), 'it moves board focus instead (d4)');

  // Flipped board: directions invert to stay visually correct.
  await page.click('#flip');
  await page.locator(sq('d4')).focus();
  await page.keyboard.press('ArrowUp');
  check(Number(await active()) === idx('d3'), 'flipped: ArrowUp moves toward rank 1 (d3)');
  await page.keyboard.press('ArrowRight');
  check(Number(await active()) === idx('c3'), 'flipped: ArrowRight moves toward the a-file (c3)');
  await page.click('#flip');

  // In-check announcement on the mated king.
  await t.newGame({});
  await mv('f2', 'f3'); await mv('e7', 'e5'); await mv('g2', 'g4'); await mv('d8', 'h4');
  const king = await page.locator(sq('e1')).getAttribute('aria-label');
  check(king.includes('white king') && king.includes('in check'), 'mated king announces "in check"');
});
