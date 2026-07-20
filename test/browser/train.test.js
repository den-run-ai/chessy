/* Train: due-card queue on the fixed 1/3/7/14/30/90-day ladder, honest
 * exact-match wording, atomic grading, no background timers. */
'use strict';
require('./helper').run('train', async function (t) {
  const page = t.page, check = t.check, idx = t.idx;
  const tsq = function (name) { return page.locator('#trainBoard .square').nth(idx(name)); };

  // Seed two due cards directly (the reflection flow is covered by its own
  // suite): a mate-in-one and an underpromotion.
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.addCard({
      gameId: 'g1', ply: 3,
      fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null }, // d8 → h4
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Look for forcing mates first', reflection: {},
      createdAt: now - 1000, due: now - 1000, step: -1, attempts: []
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'g2', ply: 0,
        fenBefore: '8/P6k/8/8/8/8/6K1/8 w - - 0 1',
        playedSan: 'a8=Q', bestSan: 'a8=N',
        bestMove: { from: 8, to: 0, promotion: 'N' },
        bestScore: 0, depth: 3, kind: 'differ', cause: 'calculation',
        lesson: 'Check the underpromotion', reflection: {},
        createdAt: now, due: now, step: -1, attempts: []
      });
    });
  });

  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('2 due'), 'both cards due');
  check((await page.textContent('#trainPrompt')).includes('Black to move') &&
        (await page.textContent('#trainPrompt')).includes('You played Qh4#'),
    'prompt names the side to move and recalls the played move');

  // The train board is a real ARIA grid with a roving tab stop.
  check(await page.getAttribute('#trainBoard', 'role') === 'grid', 'trainBoard is an ARIA grid');
  check(await page.locator('#trainBoard .square[tabindex="0"]').count() === 1,
    'trainBoard has a single roving tab stop');

  // Selecting a piece announces it; answer with the saved move.
  await tsq('d8').click();
  check((await tsq('d8').getAttribute('aria-label')).includes('selected'),
    'train board announces the selected piece');
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('✓'), 'matching answer recognized');
  check((await page.textContent('#trainLesson')).includes('Look for forcing mates'),
    'reveal repeats the saved lesson');

  // Grade with a double-click: the answer is consumed before the atomic
  // write, so exactly one attempt is recorded and one rung climbed.
  await page.evaluate(function () {
    document.getElementById('gradeGood').click();
    document.getElementById('gradeGood').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('trainCount').textContent.indexOf('1 due') !== -1;
  });

  // Second card: underpromotion through the named picker; a queen answer
  // DIFFERS (honest wording), then Again reschedules for later today.
  await tsq('a7').click();
  check((await tsq('a8').getAttribute('aria-label')).includes('legal move'),
    'train board announces legal-move targets');
  await tsq('a8').click();
  await page.waitForSelector('#promotionDialog[open]');
  await page.click('#promotionChoices [aria-label="Promote to queen"]');
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('≠') &&
        (await page.textContent('#trainOutcome')).includes('grade yourself honestly'),
    'a differing answer is reported honestly, not declared wrong');
  check((await page.textContent('#trainLesson')).includes('Line went wrong on the reply'),
    'reveal names the player-diagnosed cause');
  await page.click('#gradeAgain');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check((await page.textContent('#trainEmpty')).includes('Refresh') &&
        await page.locator('#trainRefresh').isVisible(),
    'an empty queue offers Refresh instead of arming background timers');

  // Ladder state: Good climbed to step 0 (~1 day, one correct attempt);
  // Again dropped off the ladder (~10 min, one incorrect attempt).
  const graded = await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const byKind = {};
      for (const c of cards) byKind[c.kind] = c;
      return {
        goodStep: byKind.match.step, goodDue: byKind.match.due,
        goodAttempts: byKind.match.attempts.length, goodCorrect: byKind.match.attempts[0].correct,
        againStep: byKind.differ.step, againDue: byKind.differ.due,
        againAttempts: byKind.differ.attempts.length, againCorrect: byKind.differ.attempts[0].correct
      };
    });
  });
  check(graded.goodStep === 0 && graded.goodDue > Date.now() + 20 * 3600 * 1000 &&
        graded.goodAttempts === 1 && graded.goodCorrect === true,
    'Good schedules the first 1-day rung with exactly one (correct) attempt');
  check(graded.againStep === -1 && graded.againDue < Date.now() + 3600 * 1000 &&
        graded.againAttempts === 1 && graded.againCorrect === false,
    'Again drops off the ladder for a ten-minute retry (one incorrect attempt)');

  // Refresh reconsiders due times: force the Again card due and refresh.
  await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.kind === 'differ'; });
      c.due = Date.now() - 1;
      return CoachStore.updateCard(c);
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('1 due'),
    'Refresh reconsiders "Again" cards without background timers');

  // A failed grade write keeps the card on screen and reports it.
  await tsq('a7').click();
  await tsq('a8').click();
  await page.waitForSelector('#promotionDialog[open]');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('✓'),
    'underpromotion answered correctly via the named picker');
  await page.evaluate(function () {
    CoachStore.__realGradeCard = CoachStore.gradeCard;
    CoachStore.gradeCard = function () { return Promise.reject(new Error('quota')); };
  });
  await page.click('#gradeGood');
  await page.waitForFunction(function () {
    return document.getElementById('trainOutcome').textContent.indexOf('Could not save') !== -1;
  });
  await page.evaluate(function () { CoachStore.gradeCard = CoachStore.__realGradeCard; });
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check(true, 'a failed grade write keeps the card and the retry succeeds');

  // A SLOW grade write must keep BOTH the board and the grade buttons
  // disabled until it settles: a second answer or grade fired while the
  // write is pending would record a duplicate attempt / climb two rungs.
  await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.kind === 'differ'; });
      c.due = Date.now() - 1;
      return CoachStore.updateCard(c);
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  const before = await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.kind === 'differ'; });
      return { attempts: c.attempts.length, step: c.step };
    });
  });
  await tsq('a7').click();
  await tsq('a8').click();
  await page.waitForSelector('#promotionDialog[open]');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.evaluate(function () {
    CoachStore.__realGradeCard = CoachStore.gradeCard;
    CoachStore.gradeCard = function (id, mutate) {
      const real = CoachStore.__realGradeCard;
      return new Promise(function (resolve, reject) {
        setTimeout(function () { real(id, mutate).then(resolve, reject); }, 600);
      });
    };
  });
  await page.click('#gradeGood');
  await tsq('a7').click();        // second answer attempt while pending
  await page.click('#gradeGood'); // second grade while pending
  await page.waitForSelector('#trainEmpty:not([hidden])', { timeout: 5000 });
  await page.evaluate(function () { CoachStore.gradeCard = CoachStore.__realGradeCard; });
  const after = await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.kind === 'differ'; });
      return { attempts: c.attempts.length, step: c.step };
    });
  });
  check(after.attempts === before.attempts + 1 && after.step === before.step + 1,
    'a pending grade write blocks a second answer/grade (one attempt, one rung)');
});
