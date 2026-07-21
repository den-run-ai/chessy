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
  check(await page.evaluate(function () {
    return document.getElementById('trainBoard').contains(document.activeElement);
  }), 'grading moves focus onto the next card’s board (not left on a hidden button)');

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
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'trainRefresh',
    'grading the last card moves focus to the visible Refresh button');

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
  await page.waitForFunction(function () {
    return document.getElementById('trainBoard').contains(document.activeElement);
  });
  check(true, 'Refresh finding a card moves focus onto the board (Refresh hid itself)');

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
  check(!(await page.locator('#gradeGood').isDisabled()),
    'a failed grade re-enables the controls for the retry');
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
    CoachStore.gradeCard = function () {
      const args = arguments;
      const real = CoachStore.__realGradeCard;
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          real.apply(CoachStore, args).then(resolve, reject);
        }, 600);
      });
    };
  });
  await page.click('#gradeGood');
  check(await page.locator('#gradeGood').isDisabled() &&
        await page.locator('#gradeHard').isDisabled() &&
        await page.locator('#gradeAgain').isDisabled(),
    'grade buttons are visibly disabled while the write is in flight');
  await tsq('a7').click();        // second answer attempt while pending
  await page.click('#gradeGood', { force: true }); // second grade while pending
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

  // CONCURRENT grades of the same presented card (two windows showing
  // the same due card): IndexedDB serializes the transactions, so the
  // loser's mutate would otherwise run on the freshly updated card and
  // double-record. The expected-revision pin rejects it as 'stale'.
  const stale = await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards[0];
      const beforeCount = (c.attempts || []).length;
      const expect = { due: c.due, attempts: beforeCount };
      const mut = function (fresh) {
        fresh.attempts = (fresh.attempts || []).concat([{ at: 1, grade: 'good', correct: true }]);
        fresh.due = fresh.due + 60000;
        return fresh;
      };
      return CoachStore.gradeCard(c.id, expect, mut).then(function (first) {
        return CoachStore.gradeCard(c.id, expect, mut).then(function (second) {
          return CoachStore.listCards().then(function (afterCards) {
            const a = afterCards.find(function (x) { return x.id === c.id; });
            return {
              firstOk: !!first && first !== 'stale',
              second: second,
              added: (a.attempts || []).length - beforeCount
            };
          });
        });
      });
    });
  });
  check(stale.firstOk && stale.second === 'stale' && stale.added === 1,
    'a concurrent grade against the same presented revision is rejected as stale');

  // A card can OPEN in check (and an answer can give check): the training
  // board keeps the mini board's check highlight and announcement.
  await page.evaluate(function () {
    return CoachStore.addCard({
      gameId: 'g3', ply: 0,
      fenBefore: 'r1bqkbnr/pppp1Qpp/2n5/4p3/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3',
      playedSan: 'Kxf7', bestSan: 'Kxf7',
      bestMove: { from: 4, to: 13, promotion: null }, // e8 → f7
      bestScore: 0, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Address the check first', reflection: {},
      createdAt: Date.now(), due: Date.now() - 1, step: -1, attempts: []
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check(await page.locator('#trainBoard .square.check').count() === 1 &&
        (await page.getAttribute('#trainBoard .square.check', 'aria-label')).includes('in check'),
    'a card opening in check highlights and announces the checked king');
  await tsq('e8').click();
  await tsq('f7').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');

  // A 'stale' grade does NOT always mean another grade consumed the card:
  // a concurrent lesson re-save also revises it and leaves it due now —
  // the queue reloads so the revised card is re-presented, not skipped.
  await page.evaluate(function () {
    return CoachStore.addCard({
      gameId: 'g4', ply: 3,
      fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null },
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Original lesson', reflection: {},
      createdAt: Date.now(), due: Date.now() - 1, step: -1, attempts: []
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.evaluate(function () { // re-save from "another window"
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.gameId === 'g4'; });
      c.lesson = 'Revised elsewhere';
      c.due = c.due - 5000; // still due, different revision
      return CoachStore.updateCard(c);
    });
  });
  await page.click('#gradeGood'); // stale: the presented revision is gone
  await page.waitForSelector('#trainCardBox:not([hidden])', { timeout: 5000 });
  check((await page.textContent('#trainCount')).includes('1 due'),
    'a stale grade against a concurrently revised card re-presents it');
  check(await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.gameId === 'g4'; });
      return c.attempts.length === 0 && c.lesson === 'Revised elsewhere';
    });
  }), 'the stale grade recorded nothing against the revised card');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');

  // A stale grade whose reload TRANSIENTLY fails must not strand focus in
  // the now-hidden card box: loadTrain's catch clears the training state,
  // so the post-reload focus guard sees no card.
  await page.evaluate(function () {
    return CoachStore.addCard({
      gameId: 'g4b', ply: 3,
      fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null },
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Stale-reload-failure test', reflection: {},
      createdAt: Date.now(), due: Date.now() - 1, step: -1, attempts: []
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.evaluate(function () {
    // Revise the card (makes the pending grade stale) AND make the
    // follow-up reload reject once.
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.gameId === 'g4b'; });
      c.due = c.due - 5000;
      return CoachStore.updateCard(c);
    }).then(function () {
      CoachStore.__realDueCards = CoachStore.dueCards;
      CoachStore.dueCards = function () {
        CoachStore.dueCards = CoachStore.__realDueCards; // fail once only
        return Promise.reject(new Error('blocked'));
      };
    });
  });
  await page.click('#gradeGood'); // stale → reload → reload rejects
  await page.waitForSelector('#trainCardBox[hidden]', { state: 'attached', timeout: 5000 });
  check(await page.evaluate(function () {
    const box = document.getElementById('trainCardBox');
    // Not stranded in the now-hidden card box; focus was rescued to the
    // visible Refresh (browsers differ on resetting activeElement to the
    // body when the focused element is hidden, so we move it explicitly).
    return !box.contains(document.activeElement) &&
           document.activeElement === document.getElementById('trainRefresh');
  }), 'a failed stale-reload rescues focus to the visible Refresh, not the hidden card box');
  check(await page.locator('#trainRefresh').isVisible(),
    'a failed stale-reload leaves Refresh visible to retry');
  check((await page.textContent('#trainCount')) === '',
    'a failed reload clears the stale due count');
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');

  // A stale grade whose reload finds an EMPTY queue (a concurrent grade
  // consumed the last-due card) hides the focused grade button and shows
  // Refresh — focus must move to Refresh, not fall to the document.
  await page.evaluate(function () {
    return CoachStore.addCard({
      gameId: 'g4c', ply: 3,
      fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null },
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Empty-after-stale test', reflection: {},
      createdAt: Date.now(), due: Date.now() - 1, step: -1, attempts: []
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.evaluate(function () { // another window grades it away first
    return CoachStore.listCards().then(function (cards) {
      const c = cards.find(function (x) { return x.gameId === 'g4c'; });
      c.attempts = (c.attempts || []).concat([{ at: 1, grade: 'good', correct: true }]);
      c.due = Date.now() + 86400000; // climbs a rung: no longer due
      return CoachStore.updateCard(c);
    });
  });
  await page.click('#gradeGood'); // stale → reload → empty queue
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check(await page.evaluate(function () {
    return document.activeElement === document.getElementById('trainRefresh');
  }), 'a stale grade that empties the queue moves focus to the visible Refresh');

  // A grade settling AFTER the user left Train must not advance focus
  // into the hidden view.
  await page.evaluate(function () {
    return CoachStore.addCard({
      gameId: 'g5', ply: 3,
      fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null },
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Focus test', reflection: {},
      createdAt: Date.now(), due: Date.now() - 1, step: -1, attempts: []
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await tsq('d8').click();
  await tsq('h4').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.evaluate(function () {
    CoachStore.__realGradeCard = CoachStore.gradeCard;
    CoachStore.gradeCard = function () {
      const args = arguments;
      const real = CoachStore.__realGradeCard;
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          real.apply(CoachStore, args).then(resolve, reject);
        }, 500);
      });
    };
  });
  await page.click('#gradeGood');
  await page.click('#tabPlay'); // leave Train while the write is in flight
  await page.waitForTimeout(800);
  await page.evaluate(function () { CoachStore.gradeCard = CoachStore.__realGradeCard; });
  check(await page.evaluate(function () {
    return !document.getElementById('viewTrain').contains(document.activeElement);
  }), 'a grade settling after leaving Train does not pull focus into the hidden view');
  check(await page.locator('#viewPlay').isVisible(), 'the active view is undisturbed');

  // A transient queue-load failure leaves a visible retry control.
  await page.evaluate(function () {
    CoachStore.__realDueCards = CoachStore.dueCards;
    CoachStore.dueCards = function () { return Promise.reject(new Error('blocked')); };
  });
  await page.click('#tabTrain');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check((await page.textContent('#trainEmpty')).includes('unavailable') &&
        await page.locator('#trainRefresh').isVisible(),
    'a failed queue load surfaces the error WITH a visible Refresh to retry');
  await page.evaluate(function () { CoachStore.dueCards = CoachStore.__realDueCards; });
  await page.click('#trainRefresh');
  await page.waitForFunction(function () {
    return document.getElementById('trainEmpty').textContent.indexOf('No cards due') !== -1;
  });
  check(true, 'Refresh retries the load once storage is available again');
});
