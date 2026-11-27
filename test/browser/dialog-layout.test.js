/* Dialog actions must be reachable without scrolling the settings or text.
 * Use geometry and hit testing before Playwright clicks (which auto-scroll). */
'use strict';
require('./helper').run('dialog-layout', async function (t) {
  const page = t.page, check = t.check;

  async function visibleActions(dialogId, label) {
    const layout = await page.evaluate(function (id) {
      const dialog = document.getElementById(id);
      const bounds = dialog.getBoundingClientRect();
      const content = dialog.querySelector('.dialog-content') || dialog;
      const buttons = Array.from(dialog.querySelectorAll('.setup-actions .btn, .gameover-actions .btn'))
        .filter(function (button) { return !button.hidden; });
      return {
        withinViewport: bounds.top >= 0 && bounds.left >= 0 &&
          bounds.bottom <= innerHeight && bounds.right <= innerWidth,
        noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth + 1 &&
          content.scrollWidth <= content.clientWidth + 1,
        actions: buttons.map(function (button) {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            id: button.id,
            visible: r.top >= bounds.top && r.bottom <= bounds.bottom &&
              r.left >= bounds.left && r.right <= bounds.right &&
              r.top >= 0 && r.bottom <= innerHeight &&
              !!hit && (hit === button || button.contains(hit)),
            touchTarget: r.height >= 44 && r.width >= 44
          };
        })
      };
    }, dialogId);
    check(layout.withinViewport && layout.noHorizontalOverflow,
      label + ': dialog fits the viewport without horizontal scrolling');
    layout.actions.forEach(function (button) {
      check(button.visible && button.touchTarget,
        label + ': ' + button.id + ' is visible and touch-sized without scrolling');
    });
  }

  for (const size of [
    { width: 320, height: 568 }, { width: 375, height: 600 },
    { width: 390, height: 664 }, { width: 667, height: 375 },
    { width: 667, height: 320 }
  ]) {
    await page.setViewportSize(size);
    await page.click('#newGame');
    const label = size.width + '×' + size.height;
    await visibleActions('newGameDialog', label + ' New Game');
    await page.evaluate(function () {
      const dialog = document.getElementById('newGameDialog');
      const content = dialog.querySelector('.dialog-content') || dialog;
      content.scrollTop = content.scrollHeight;
    });
    await visibleActions('newGameDialog', label + ' after scrolling settings');
    await page.keyboard.press('Escape');
    check(await page.evaluate(function () { return document.activeElement.id === 'newGame'; }),
      label + ': Escape returns focus to New game');
  }

  // Rotate/resize while already open, as Safari's toolbar and orientation
  // changes do, instead of relying only on initial dialog placement.
  await page.setViewportSize({ width: 390, height: 664 });
  await page.click('#newGame');
  await page.setViewportSize({ width: 667, height: 320 });
  await visibleActions('newGameDialog', 'open dialog after rotation');
  await page.keyboard.press('Escape');

  // A failed checkpoint offers a third, longer action. None may disappear
  // behind the bottom edge when its explanation grows or text is enlarged.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.click('#newGame');
  await page.evaluate(function () {
    document.documentElement.style.fontSize = '20px';
    document.getElementById('newGameStatus').textContent =
      'The game could not be saved. Try saving again, cancel, or start without saving. '.repeat(5);
    document.getElementById('newGameStart').textContent = 'Try saving again';
    document.getElementById('newGameDiscard').hidden = false;
  });
  await visibleActions('newGameDialog', 'enlarged text and archive failure');
  // Keyboard focus must scroll an off-screen option into the content area,
  // leaving the fixed actions unobscured.
  await page.focus('input[name="timeControl"][value="1800+20"]');
  check(await page.evaluate(function () {
    const option = document.querySelector('input[name="timeControl"][value="1800+20"] + span');
    const r = option.getBoundingClientRect();
    const body = document.querySelector('#newGameDialog .dialog-content').getBoundingClientRect();
    const actions = document.querySelector('#newGameDialog .setup-actions').getBoundingClientRect();
    return r.top >= body.top && r.bottom <= Math.min(body.bottom, actions.top);
  }), 'keyboard focus reveals the chosen time control above the actions');
  await visibleActions('newGameDialog', 'after focusing the final option');
  await page.keyboard.press('ArrowLeft');
  check(await page.$eval('input[name="timeControl"][value="900+10"]', function (input) {
    return input.checked && input === document.activeElement;
  }), 'radio options retain arrow-key selection');
  await page.keyboard.press('Tab');
  check(await page.evaluate(function () { return document.activeElement.id === 'newGameStart'; }),
    'Tab reaches Start from the final radio group');
  await page.keyboard.press('Escape');
  await page.evaluate(function () { document.documentElement.style.fontSize = ''; });

  // Import shares the long-content failure. Keep its native form submission
  // working even though its buttons are outside the scrolling body.
  await page.click('#tabReview');
  await page.click('#importOpen');
  await visibleActions('importDialog', 'Import');
  check(await page.$eval('#importText', function (input) {
    return parseFloat(getComputedStyle(input).fontSize) >= 16;
  }), 'Import text is large enough to avoid iOS focus zoom');
  await page.fill('#importText', '[Event "Small-screen import"]\n\n1. e4 e5 *');
  await page.click('#importSubmit');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  check(await page.locator('#gameList button').count() === 1,
    'the visible Import action still submits and archives the form');

  // The same layout protects confirmation/result controls if their messages
  // wrap to many lines. Inspect their real markup without destructive clicks.
  await page.setViewportSize({ width: 568, height: 320 });
  for (const fixture of [
    ['restoreConfirmDialog', 'restoreConfirmText'],
    ['deleteAllDialog', 'deleteAllText'],
    ['endGameDialog', 'endGameDetail'],
    ['gameOverDialog', 'gameOverDetail']
  ]) {
    await page.evaluate(function (ids) {
      document.getElementById(ids[1]).textContent = 'A long message that must remain scrollable. '.repeat(40);
      document.getElementById(ids[0]).showModal();
    }, fixture);
    await visibleActions(fixture[0], fixture[0] + ' long message');
    await page.evaluate(function (id) { document.getElementById(id).close(); }, fixture[0]);
  }
});
