/* Coaching vertical slice: archive → PGN import → hidden reflection →
 * engine verification → lesson card → spaced review → progress counts. */
'use strict';
require('./helper').run('coach', async function (t) {
  const page = t.page, check = t.check, mv = t.mv, idx = t.idx;
  const tsq = function (name) { return page.locator('#trainBoard .square').nth(idx(name)); };

  // Tabs exist; Play is current.
  check(await page.locator('.tab').count() === 4, 'four section tabs');
  check(await page.getAttribute('#tabPlay', 'aria-current') === 'page', 'Play tab current at boot');

  // A finished game is archived automatically (fool's mate, two players).
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');

  await page.click('#tabReview');
  check(await page.getAttribute('#tabReview', 'aria-current') === 'page', 'Review tab activates');
  check(await page.locator('#viewPlay').isHidden(), 'Play view hidden on Review tab');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 1, 'finished game auto-archived');
  check((await page.textContent('.game-item')).includes('0-1'), 'archived game shows its result');

  // Import a PGN through the dialog; a bad PGN reports instead of breaking.
  await page.click('#importPgnBtn');
  await page.fill('#importText', '1. e4 e5 2. zz9');
  await page.click('#importStart');
  check((await page.textContent('#importError')).includes('Import failed'),
    'illegal PGN reports an import error');
  await page.fill('#importText', [
    '[Event "Test import"]',
    '[White "Anna"]',
    '[Black "Ben"]',
    '[Result "1-0"]',
    '',
    '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0'
  ].join('\n'));
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.waitForFunction(function () {
    return document.querySelectorAll('.game-item').length === 2;
  });
  check(await page.locator('.game-item').count() === 2, 'imported game joins the archive');
  check((await page.textContent('.game-item')).includes('Anna vs Ben'),
    'imported game labelled from its PGN tags');

  // The archive survives a reload (IndexedDB, not localStorage).
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2, 'archive survives reload');

  // Open the imported game (newest first) and browse to the last decision.
  await page.locator('.game-item').first().click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/7'), 'review starts at ply 0');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'), 'end position reached');
  check(await page.locator('#flagMoment').isDisabled(), 'cannot flag the end position (no move played)');
  await page.click('#revPrev');
  check((await page.textContent('#reviewStatus')).includes('played here: Qxf7#'),
    'position browser shows the move played here');

  // Hidden reflection gates the engine: no verdict before the form.
  await page.click('#flagMoment');
  check(await page.locator('#reflectForm').isVisible(), 'reflection form opens on flag');
  check(await page.locator('#verifyBox').isHidden(), 'engine verdict hidden until reflection submitted');
  await page.fill('#reflectThreat', 'mate on f7');
  await page.fill('#reflectCandidates', 'Qxf7');
  await page.selectOption('#reflectEval', 'winning');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 30000 });
  check((await page.textContent('#verifyResult')).includes('Qxf7'),
    'engine verdict references the move');

  // Save the lesson card.
  await page.fill('#cardLesson', 'Look for forcing mates before anything else');
  await page.click('#saveCard');
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('due in Train'),
    'card saved and scheduled');

  // Train: the new card is due immediately; answer on the board.
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('1 due'), 'one card due');
  check((await page.textContent('#trainPrompt')).includes('White to move'),
    'training prompt names the side to move');
  await tsq('h5').click(); // queen
  await tsq('f7').click(); // the mating capture
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('✓'), 'correct answer recognized');
  check((await page.textContent('#trainLesson')).includes('Look for forcing mates'),
    'reveal repeats the saved lesson');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check(await page.locator('#trainCardBox').isHidden(), 'graded card leaves the due queue');

  // The card is rescheduled onto the 1-day rung, with the attempt recorded.
  const card = await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) { return cards[0]; });
  });
  check(card.step === 0 && card.due > Date.now() + 20 * 3600 * 1000,
    'Good schedules the first 1-day interval');
  check(card.attempts.length === 1 && card.attempts[0].correct === true,
    'attempt recorded as correct');

  // Progress: honest counts.
  await page.click('#tabProgress');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#progressStats dt').length > 0;
  });
  const stats = await page.evaluate(function () {
    const out = {};
    const dl = document.getElementById('progressStats');
    const dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd');
    dts.forEach(function (dt, i) { out[dt.textContent] = dds[i].textContent; });
    return out;
  });
  check(stats['Games archived'] === '2', 'progress counts archived games');
  check(stats['Lesson cards'] === '1', 'progress counts lesson cards');
  check(stats['Cards due now'] === '0', 'progress counts due cards');
  check(stats['Reviews (30 days)'] === '1', 'progress counts recent reviews');
  check((await page.textContent('#causeStats')).includes('Missed a threat'),
    'per-cause counts shown');

  // Backup round-trip through the real DB, then Delete All via the button.
  const roundTrip = await page.evaluate(function () {
    return CoachStore.exportAll().then(function (data) {
      return CoachStore.importAll(data).then(function () {
        return Promise.all([CoachStore.listGames(), CoachStore.listCards()]);
      }).then(function (r) {
        return { games: r[0].length, cards: r[1].length, exported: data.games.length };
      });
    });
  });
  check(roundTrip.exported === 2 && roundTrip.games === 4 && roundTrip.cards === 2,
    'export/import round-trip appends a full copy');

  page.once('dialog', function (d) { d.accept(); });
  await page.click('#deleteData');
  await page.waitForFunction(function () {
    return document.getElementById('dataNote').textContent.includes('deleted');
  });
  const empty = await page.evaluate(function () {
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()])
      .then(function (r) { return r[0].length + r[1].length; });
  });
  check(empty === 0, 'Delete all training data clears the archive');
});
