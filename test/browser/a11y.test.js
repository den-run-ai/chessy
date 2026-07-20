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

  // Game-over dialog carries an accessible name + description.
  check(await page.locator('#gameOverDialog[aria-labelledby="gameOverTitle"]').count() === 1,
    'game-over dialog is labelled by its title');
  await page.click('#gameOverClose');

  // En passant is announced (and highlighted) as the capture it is, even
  // though the destination square is empty.
  await t.newGame({});
  await mv('e2', 'e4'); await mv('a7', 'a6'); await mv('e4', 'e5'); await mv('d7', 'd5');
  await page.click(sq('e5'));
  const epCell = page.locator(sq('d6'));
  check((await epCell.getAttribute('aria-label')).includes('capture available'),
    'en-passant destination announces "capture available"');
  check((await epCell.getAttribute('class')).includes('hint-capture'),
    'en-passant destination shows the capture highlight');

  // Promotion buttons have explicit action names (the glyph codepoint is
  // the "black" piece for both colors, so the text alone misleads).
  await t.newGame({});
  await mv('a2', 'a4'); await mv('b7', 'b5');
  await mv('a4', 'b5'); await mv('a7', 'a6');
  await mv('b5', 'a6'); await mv('e7', 'e6');
  await mv('a6', 'a7'); await mv('e6', 'e5');
  await mv('a7', 'b8'); // capture-promotion on b8
  check(await page.locator('#promotionDialog[open]').count() === 1, 'promotion dialog opens');
  check(await page.locator('#promotionChoices [aria-label="Promote to queen"]').count() === 1,
    'promotion buttons are named ("Promote to queen")');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  check((await page.locator(sq('b8')).getAttribute('aria-label')).includes('white knight'),
    'named promotion button promotes to the chosen piece');

  // ---- Contrast gates (WCAG 1.4.3 text, 1.4.11 focus indicator) ----
  // Computed straight from the live styles so a palette change that breaks
  // the ratios fails here, not in a manual audit.
  const ratios = await page.evaluate(function () {
    function resolve(css) {
      const d = document.createElement('div');
      d.style.color = css;
      document.body.appendChild(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }
    function lum(css) {
      const m = resolve(css).match(/\d+(\.\d+)?/g).map(Number);
      function f(v) {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      }
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
    }
    function ratio(a, b) {
      const x = lum(a), y = lum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }
    const primary = getComputedStyle(document.getElementById('newGame'));
    const tab = getComputedStyle(document.getElementById('tabPlay')); // aria-current at boot
    // The focus ring color comes from the stylesheet rule — programmatic
    // .focus() does not reliably match :focus-visible across engines.
    let ring = null;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText && rule.selectorText.indexOf('.square:focus-visible') !== -1) {
          ring = rule.style.getPropertyValue('outline-color') || rule.style.outlineColor;
        }
      }
    }
    const light = getComputedStyle(document.querySelector('#board .square.light'));
    const dark = getComputedStyle(document.querySelector('#board .square.dark'));
    return {
      btn: ratio(primary.color, primary.backgroundColor),
      tab: ratio(tab.color, tab.backgroundColor),
      ringLight: ring ? ratio(ring, light.backgroundColor) : 0,
      ringDark: ring ? ratio(ring, dark.backgroundColor) : 0
    };
  });
  check(ratios.btn >= 4.5, 'primary button text contrast ≥ 4.5:1 (' + ratios.btn.toFixed(2) + ')');
  check(ratios.tab >= 4.5, 'active tab text contrast ≥ 4.5:1 (' + ratios.tab.toFixed(2) + ')');
  check(ratios.ringLight >= 3 && ratios.ringDark >= 3,
    'square focus ring ≥ 3:1 against both square colors (' +
    ratios.ringLight.toFixed(2) + ', ' + ratios.ringDark.toFixed(2) + ')');

  // ---- The Review board shares the Play board's grid semantics ----
  check(await page.getAttribute('#reviewBoard', 'role') === 'grid', 'reviewBoard is an ARIA grid');
  check(await page.locator('#reviewBoard [role="row"]').count() === 8, 'reviewBoard has 8 ARIA rows');
  check(await page.locator('#reviewBoard [role="gridcell"]').count() === 64, 'reviewBoard has 64 gridcells');
  check(await page.locator('#reviewBoard .square[tabindex="0"]').count() === 1,
    'reviewBoard has a single roving tab stop');
  check(await page.locator('#reviewBoard button.square').count() === 64,
    'review board squares are focusable buttons (keyboard-inspectable)');
});
