/* Coaching vertical slice: archive → PGN import → hidden reflection →
 * engine verification → lesson card → spaced review → progress counts. */
'use strict';
require('./helper').run('coach', async function (t) {
  const page = t.page, check = t.check, mv = t.mv, idx = t.idx;
  const tsq = function (name) { return page.locator('#trainBoard .square').nth(idx(name)); };

  // Tabs exist; Play is current.
  check(await page.locator('.tab').count() === 4, 'four section tabs');
  check(await page.getAttribute('#tabPlay', 'aria-current') === 'page', 'Play tab current at boot');

  // A finished game is archived automatically (fool's mate, two players) —
  // and playing the IDENTICAL game again via Rematch archives again (the
  // dedupe keys on the game instance, not the move list).
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverRematch');
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');

  await page.click('#tabReview');
  check(await page.getAttribute('#tabReview', 'aria-current') === 'page', 'Review tab activates');
  check(await page.locator('#viewPlay').isHidden(), 'Play view hidden on Review tab');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2,
    'both finished games auto-archived (identical rematch is not deduped)');
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
    return document.querySelectorAll('.game-item').length === 3;
  });
  check(await page.locator('.game-item').count() === 3, 'imported game joins the archive');
  check((await page.textContent('.game-item')).includes('Anna vs Ben'),
    'imported game labelled from its PGN tags');

  // The archive survives a reload (IndexedDB, not localStorage).
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 3, 'archive survives reload');

  // Open the imported game (newest first) and browse to the last decision.
  await page.locator('.game-item').first().click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/7'), 'review starts at ply 0');

  // Retroactive scan: every decision analysed, biggest swings surfaced.
  await page.click('#scanGame');
  // While the scan is mid-flight, flag a moment and verify it — analysis
  // requests must queue behind each other (a second request used to orphan
  // the scan's pending reply and freeze the UI on "Scanning…").
  await page.click('#flagMoment'); // ply 0, played here: e4
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check((await page.textContent('#verifyResult')).includes('e4'),
    'verification completes while a scan is running (queued, not clobbered)');
  await page.waitForFunction(function () {
    const el = document.getElementById('scanStatus');
    return !el.hidden && !el.textContent.includes('Scanning');
  }, null, { timeout: 90000 });
  check((await page.textContent('#scanStatus')).includes('key moment'), 'scan reports key moments');
  const momentCount = await page.locator('.moment-item').count();
  check(momentCount >= 1 && momentCount <= 3, 'between 1 and 3 key moments listed');
  const momentText = await page.textContent('#momentList');
  check(momentText.includes('Nf6'), 'the decisive blunder (3… Nf6) is a key moment');
  check(!momentText.includes('Qxf7'),
    'moment list withholds the better move until reflection');
  check(await page.locator('#scanGame').textContent() === 'Re-scan game',
    'scan button switches to re-scan');

  // Clicking a moment jumps the browser to that decision.
  await page.locator('.moment-item', { hasText: 'Nf6' }).click();
  check((await page.textContent('#reviewStatus')).includes('played here: Nf6'),
    'moment click jumps to the position before the blunder');

  // The scan is persisted on the archived game record.
  const scanned = await page.evaluate(function () {
    return CoachStore.listGames().then(function (games) {
      const g = games[0];
      return { hasScan: !!g.scan, moments: g.scan ? g.scan.moments.length : 0, evals: g.scan ? g.scan.evals.length : 0 };
    });
  });
  check(scanned.hasScan && scanned.moments >= 1 && scanned.evals === 8,
    'scan stored on the game (evals for all 8 positions)');

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

  // Save the lesson card — double-click on purpose: the button must
  // disable before the async write, so only ONE card is created.
  await page.fill('#cardLesson', 'Look for forcing mates before anything else');
  await page.evaluate(function () {
    document.getElementById('saveCard').click();
    document.getElementById('saveCard').click();
  });
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('due in Train'),
    'card saved and scheduled');
  const cardCount = await page.evaluate(function () {
    return CoachStore.listCards().then(function (c) { return c.length; });
  });
  check(cardCount === 1, 'double-clicking Save creates exactly one card');

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
  // Grade with a double-click: the answer is consumed before the async
  // write, so exactly one attempt is recorded and one rung climbed.
  await page.evaluate(function () {
    document.getElementById('gradeGood').click();
    document.getElementById('gradeGood').click();
  });
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check(await page.locator('#trainCardBox').isHidden(), 'graded card leaves the due queue');

  // The card is rescheduled onto the 1-day rung, with the attempt recorded
  // exactly once despite the double-click.
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
  check(stats['Games archived'] === '3', 'progress counts archived games');
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
  check(roundTrip.exported === 3 && roundTrip.games === 6 && roundTrip.cards === 2,
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

  // Underpromotion cards must be answerable: the promotion picker opens on
  // a promoting answer instead of forcing the queen.
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.addCard({
      gameId: null, ply: 0,
      fenBefore: '8/P6k/8/8/8/8/6K1/8 w - - 0 1',
      playedSan: 'a8=Q', bestSan: 'a8=N',
      bestMove: { from: 8, to: 0, promotion: 'N' },
      bestScore: 0, playedScore: 0, lossCp: 120,
      cause: 'calculation', lesson: 'Check the underpromotion',
      reflection: {}, createdAt: now, due: now, step: -1, attempts: []
    });
  });
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('a7').click();
  await tsq('a8').click();
  await page.waitForSelector('#promotionDialog[open]');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('✓'),
    'underpromotion card answered correctly via the promotion picker');

  // A move that COMPLETES a threefold repetition is a draw — verification
  // must score it 0 from the prefix's repetition table, not analyse the
  // bare FEN as an ongoing position.
  await page.click('#tabReview');
  await page.click('#importPgnBtn');
  await page.fill('#importText', [
    '[Event "Rep"]',
    '',
    '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2',
    '[Event "Mate"]',
    '[White "Anna"]',
    '[Black "Ben"]',
    '',
    '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0'
  ].join('\n'));
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.locator('.game-item', { hasText: 'threefold' }).click();
  await page.click('#revEnd');
  await page.click('#revPrev'); // ply 7: ...Ng8 completes the threefold
  await page.click('#flagMoment');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check((await page.textContent('#verifyResult')).indexOf('eval +0.0') !== -1 ||
        (await page.textContent('#verifyResult')).includes('agrees'),
    'move completing a threefold verifies against the drawn (0.0) value');

  // Stale-verdict race: verify in game A, then switch to game B before the
  // probes finish — the late result must be discarded, never re-enabling
  // Save with the old position on the new game.
  await page.click('#reviewBack');
  await page.locator('.game-item', { hasText: 'threefold' }).click();
  await page.click('#flagMoment'); // ply 0 of game A
  await page.click('#reflectVerify');
  await page.click('#reviewBack'); // leave immediately, probes still queued
  await page.locator('.game-item', { hasText: 'Anna' }).click(); // game B
  await page.click('#flagMoment');
  await page.waitForTimeout(6000); // let game A's stale probes finish
  check(await page.locator('#saveCard').isDisabled(),
    'stale verification from the previous game is discarded (Save stays disabled)');
  // ...and a fresh verification on game B still works after the discard.
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check(!(await page.locator('#saveCard').isDisabled()),
    'a fresh verification after the discarded one enables Save normally');
});
