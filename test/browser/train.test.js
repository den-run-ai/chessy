/* Train: due-card queue on the fixed 1/3/7/14/30/90-day ladder, honest
 * exact-match wording, atomic grading, no background timers. */
'use strict';
require('./helper').run('train', async function (t) {
  const page = t.page, check = t.check, idx = t.idx;
  const tsq = function (name) { return page.locator('#trainBoard .square').nth(idx(name)); };

  // Seed two valid due cards plus four unusable rows directly (the reflection
  // flow is covered by its own suite): a mate-in-one, an underpromotion, a
  // terminal position, an illegal saved move, a corrupt FEN, and damaged
  // structured Calculation evidence. Every bad
  // row must be quarantined without hiding either valid card.
  await page.evaluate(function () {
    const now = Date.now();
    let state = Chess.newGameState();
    ['f3', 'e5', 'g4'].forEach(function (san) {
      const legal = Chess.legalMoves(state);
      const move = legal.find(function (candidate) {
        return Chess.toSan(state, candidate, legal) === san;
      });
      state = Chess.playMove(state, move);
    });
    const structured = ChessyCalculation.build(state, {
      threatKind: 'none',
      candidateStatus: 'listed',
      candidates: 'Qh4#',
      calculationStatus: 'line',
      line: 'Qh4#',
      evaluation: 'winning'
    }).value;
    const structuredFen = Chess.toFen(state);
    const badStructured = JSON.parse(JSON.stringify(structured));
    badStructured.calculation.line[0].san += '!';
    return CoachStore.putGame({
      id: 'g1', sans: ['f3', 'e5', 'g4', 'Qh4#'],
      playerColor: 'b', setupFen: null
    }).then(function () {
      return CoachStore.addCard({
      gameId: 'g1', ply: 3,
      fenBefore: structuredFen,
      playedSan: 'Qh4#', bestSan: 'Qh4#',
      bestMove: { from: 3, to: 39, promotion: null }, // d8 → h4
      bestScore: -999999, depth: 3, kind: 'match', cause: 'match',
      lesson: 'Look for forcing mates first', reflection: structured,
      createdAt: now - 1000, due: now - 1000, step: -1, attempts: []
      });
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
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'terminal', ply: 4,
        fenBefore: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
        playedSan: 'Qh4#', bestSan: 'e4',
        bestMove: { from: 52, to: 36, promotion: null },
        kind: 'terminal', cause: 'calculation', lesson: 'terminal row',
        createdAt: now + 1, due: now - 3000, step: -1, attempts: []
      });
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'illegal-best', ply: 2,
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
        playedSan: 'e4', bestSan: 'e4',
        bestMove: { from: 52, to: 36, promotion: null },
        kind: 'illegal-best', cause: 'calculation', lesson: 'illegal move row',
        createdAt: now + 2, due: now - 2000, step: -1, attempts: []
      });
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'damaged', ply: 0, fenBefore: 'not a fen',
        playedSan: 'e4', bestSan: 'e4',
        bestMove: { from: 52, to: 36, promotion: null },
        kind: 'quarantined', cause: 'calculation', lesson: 'damaged row',
        createdAt: now + 1, due: now - 500, step: -1, attempts: []
      });
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'g1', ply: 3,
        fenBefore: structuredFen,
        playedSan: 'Qh4#', bestSan: 'Qh4#',
        bestMove: { from: 3, to: 39, promotion: null },
        bestScore: -999999, depth: 3, kind: 'bad-e3', cause: 'match',
        lesson: 'damaged structured row', reflection: badStructured,
        createdAt: now + 3, due: now - 4000, step: -1, attempts: []
      });
    });
  });

  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('2 due'), 'both cards due');
  check((await page.textContent('#trainSkipped')).includes('Skipped 4 malformed due cards'),
    'Train reports every unusable due card while loading valid cards');
  check(await page.evaluate(function () {
    return CoachStore.listCards().then(function (cards) {
      const damaged = cards.find(function (card) { return card.kind === 'quarantined'; });
      const terminal = cards.find(function (card) { return card.kind === 'terminal'; });
      const illegal = cards.find(function (card) { return card.kind === 'illegal-best'; });
      const badE3 = cards.find(function (card) { return card.kind === 'bad-e3'; });
      return cards.length === 6 && damaged && damaged.fenBefore === 'not a fen' &&
        terminal && terminal.bestSan === 'e4' &&
        illegal && illegal.bestMove.from === 52 &&
        badE3 && badE3.reflection.calculation.line[0].san.endsWith('!');
    });
  }), 'Train quarantine does not delete or rewrite unusable stored cards');
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

  // ---- E2 (#76): verified equivalent moves ------------------------------
  // Fresh slate, then three cards on a two-rooks mate-in-one position:
  //  A) candidates-coverage evidence accepting BOTH mating rook moves —
  //     answering with the non-saved one is verified equivalent;
  //  B) all-roots stable accepted-only evidence — an absent answer remains
  //     unknown because omission cannot prove rejection after restore/damage;
  //  C) candidates coverage on a DIFFERENT position (a hanging queen the
  //     attempt fails to take), answered OUTSIDE the covered set — the live
  //     engine check settles it as not equivalent by a decisive cp gap. (A
  //     mate-in-one is deliberately NOT used here: its search stops at depth
  //     one, whose single-depth "stability" the criterion refuses to reject
  //     on — honest unknown, not a verdict.)
  await page.evaluate(function () {
    return CoachStore.deleteAllData().then(function () {
      const F = 'k7/8/1K6/8/8/8/8/6RR w - - 0 1';
      const FC = 'rnbqkbnr/pppppppp/8/8/4r3/3P4/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
      const state = Chess.parseFen(F);
      state.positions = {};
      state.positions[Chess.positionKey(state)] = 1;
      state.history = [];
      const legal = Chess.legalMoves(state);
      const stateC = Chess.parseFen(FC);
      stateC.positions = {};
      stateC.positions[Chess.positionKey(stateC)] = 1;
      stateC.history = [];
      const legalC = Chess.legalMoves(stateC);
      const now = Date.now();
      const mate = { forWhite: true, inPlies: 1 };
      const bestEntry = { uci: 'g1g8', san: 'Rg8#', scoreCpWhite: null,
        scoreCpPlayer: null, mate: mate };
      const altEntry = { uci: 'h1h8', san: 'Rh8#', scoreCpWhite: null,
        scoreCpPlayer: null, mate: mate };
      const criterion = JSON.parse(JSON.stringify({
        id: ChessyEquivalence.CRITERION.id,
        version: ChessyEquivalence.CRITERION.version,
        basis: ChessyEquivalence.CRITERION.basis,
        params: ChessyEquivalence.CRITERION.params }));
      function evidence(coverage) {
        return {
          criterion: JSON.parse(JSON.stringify(criterion)),
          provider: { engineId: 'chessy-js', version: 'seeded', configHash: 'seeded' },
          positionFingerprint:
            ChessyAnalysisCore.positionFingerprint(state, state.positions),
          turn: 'w', depth: 9, complete: true,
          coverage: coverage,
          candidateLineCount: coverage === 'all-roots' ? legal.length : 3,
          legalRootCount: legal.length,
          coveredRootCount: coverage === 'all-roots' ? legal.length : 3,
          stability: { depths: [8, 9], bestMoveStable: true },
          best: JSON.parse(JSON.stringify(bestEntry)),
          accepted: [JSON.parse(JSON.stringify(bestEntry)),
            JSON.parse(JSON.stringify(altEntry))]
        };
      }
      const pawnBest = { uci: 'd3e4', san: 'dxe4', scoreCpWhite: 455,
        scoreCpPlayer: 455, mate: null };
      const evidenceC = {
        criterion: JSON.parse(JSON.stringify(criterion)),
        provider: { engineId: 'chessy-js', version: 'seeded', configHash: 'seeded' },
        positionFingerprint:
          ChessyAnalysisCore.positionFingerprint(stateC, stateC.positions),
        turn: 'w', depth: 9, complete: true,
        coverage: 'candidates', candidateLineCount: 3,
        legalRootCount: legalC.length, coveredRootCount: 3,
        stability: { depths: [8, 9], bestMoveStable: true },
        best: JSON.parse(JSON.stringify(pawnBest)),
        accepted: [JSON.parse(JSON.stringify(pawnBest))]
      };
      function card(gameId, due, fen, bestUci, bestSan, eq) {
        return {
          gameId: gameId, ply: 0, fenBefore: fen,
          playedSan: 'Kb1', bestSan: bestSan,
          bestMove: { from: Chess.sqIndex(bestUci.slice(0, 2)),
            to: Chess.sqIndex(bestUci.slice(2, 4)), promotion: null },
          bestScore: 900, depth: 9, kind: 'differ', cause: 'calculation',
          lesson: 'Take what hangs', reflection: {},
          createdAt: now, due: due, step: -1, attempts: [],
          equivalence: eq
        };
      }
      function game(id, fen, san) {
        return {
          id: id, source: 'play', tags: {}, sans: [san], setupFen: fen,
          playerColor: 'w', clocks: [], result: '*', reason: 'abandoned',
          mode: 'pvp', difficulty: '2', timeControl: 'none', plies: 1,
          createdAt: now
        };
      }
      return Promise.all([
        CoachStore.putGame(game('eqA', F, 'Rg8#')),
        CoachStore.putGame(game('eqB', F, 'Rg8#')),
        CoachStore.putGame(game('eqgame', FC, 'dxe4'))
      ]).then(function () {
        return CoachStore.addCard(card('eqA', now - 3000, F, 'g1g8', 'Rg8#',
          evidence('candidates')));
      }).then(function () {
        return CoachStore.addCard(card('eqB', now - 2000, F, 'g1g8', 'Rg8#',
          evidence('all-roots')));
      }).then(function () {
        return CoachStore.addCard(card('eqgame', now - 1000, FC, 'd3e4', 'dxe4',
          evidenceC));
      });
    });
  });
  await page.click('#trainRefresh');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('3 due'),
    'the evidence-bearing cards load (validateCardRecord accepts them)');

  // A) verified equivalent: the OTHER mating rook move is accepted.
  await tsq('h1').click();
  await tsq('h8').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  const eqOutcome = await page.textContent('#trainOutcome');
  check(eqOutcome.includes('✓') && eqOutcome.includes('accepts it as equivalent') &&
        eqOutcome.includes('Suggested grade: Good'),
    'an accepted-set answer is verified equivalent with a Good suggestion');
  check(await page.locator('#trainCheck').isHidden(),
    'a card-evidence verdict needs no live check');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainReveal[hidden]', { state: 'attached' });
  check(await page.evaluate(function () {
    return Promise.all([CoachStore.listCards(), CoachStore.getGame('eqA')])
      .then(function (stored) {
      const cards = stored[0];
      const c = cards.find(function (x) { return x.gameId === 'eqA'; });
      const a = c.attempts[0];
      return c.attempts.length === 1 && a.correct === false &&
        a.attemptedUci === 'h1h8' && a.attemptedSan === 'Rh8#' &&
        a.verdict === 'equivalent' && a.equivalent === true &&
        a.evidenceSource === 'card-evidence' &&
        !!a.criterion && a.criterion.version >= 1 &&
        !!a.provider && a.provider.engineId === 'chessy-js' &&
        a.recommendedGrade === 'good' && a.grade === 'good' &&
        Number.isFinite(a.presentedDue) && a.priorStep === -1 &&
        c.step === 0 &&
        CoachStore.validateCardRecord(c, null, stored[1]) === null;
    });
  }), 'the attempt records verdict, provenance, suggested+chosen grade, due and step');

  // Enriched attempt history is itself a restore trust boundary. Every field
  // is an atomic bundle, the move/SAN/correct flag must match this card, and
  // card evidence must point back to this card's exact criterion/provider.
  const attemptGate = await page.evaluate(function () {
    return Promise.all([
      CoachStore.listCards(), CoachStore.getGame('eqA'), CoachStore.exportAll()
    ]).then(function (stored) {
      const card = stored[0].find(function (x) { return x.gameId === 'eqA'; });
      const game = stored[1];
      const backup = stored[2];
      function clone(value) { return JSON.parse(JSON.stringify(value)); }
      function reject(mutator) {
        const forged = clone(card);
        mutator(forged.attempts[0]);
        return !!CoachStore.validateCardRecord(forged, null, game);
      }
      const forgedBackup = clone(backup);
      const backupCard = forgedBackup.stores.cards.find(function (x) {
        return x.gameId === 'eqA';
      });
      backupCard.attempts[0].equivalent = false;
      return {
        genuine: CoachStore.validateCardRecord(card, null, game),
        backupGenuine: CoachStore.validateBackup(backup),
        backupForged: CoachStore.validateBackup(forgedBackup),
        partial: reject(function (a) { delete a.provider; }),
        badGrade: reject(function (a) { a.grade = 'easy'; }),
        illegalUci: reject(function (a) { a.attemptedUci = 'a1a1'; }),
        badSan: reject(function (a) { a.attemptedSan = 'Rh8'; }),
        badCorrect: reject(function (a) { a.correct = true; }),
        badEquivalent: reject(function (a) { a.equivalent = false; }),
        badReason: reject(function (a) { a.verdictReason = 'cp-gap'; }),
        badSource: reject(function (a) { a.evidenceSource = 'live-analysis'; }),
        badCriterion: reject(function (a) { a.criterion.version += 1; }),
        badProvider: reject(function (a) { a.provider.configHash = 'other'; }),
        badGap: reject(function (a) { a.gapCp = 31.5; }),
        badRecommendation: reject(function (a) { a.recommendedGrade = 'again'; })
      };
    });
  });
  check(attemptGate.genuine === null && attemptGate.backupGenuine === null &&
        !!attemptGate.backupForged && attemptGate.partial &&
        attemptGate.badGrade && attemptGate.illegalUci && attemptGate.badSan &&
        attemptGate.badCorrect && attemptGate.badEquivalent &&
        attemptGate.badReason && attemptGate.badSource &&
        attemptGate.badCriterion && attemptGate.badProvider &&
        attemptGate.badGap && attemptGate.badRecommendation,
    'card and restore validation reject partial, forged or contradictory attempt evidence');

  // B) Even all-roots + stable-best metadata cannot turn absence from an
  // accepted-ONLY snapshot into a negative verdict. Hold the source read so
  // the live check cannot settle before the player grades the honest unknown.
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await page.evaluate(function () {
    CoachStore.__eqBRealGetGame = CoachStore.getGame;
    CoachStore.getGame = function (id) {
      if (id !== 'eqB') return CoachStore.__eqBRealGetGame(id);
      return new Promise(function (resolve) {
        window.__eqBReleaseSource = function () {
          CoachStore.__eqBRealGetGame(id).then(resolve);
        };
      });
    };
  });
  await tsq('h1').click();
  await tsq('h2').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  const neOutcome = await page.textContent('#trainOutcome');
  check(neOutcome.includes('≠') && neOutcome.includes('grade yourself honestly') &&
        !neOutcome.includes('Suggested grade: Again'),
    'absence from all-roots accepted-only evidence remains unknown');
  check((await page.textContent('#trainCheck')).includes('Checking'),
    'an absent move is sent to live checking instead of inferred wrong');
  await page.click('#gradeAgain');
  await page.waitForSelector('#trainReveal[hidden]', { state: 'attached' });
  check(await page.evaluate(function () {
    window.__eqBReleaseSource();
    CoachStore.getGame = CoachStore.__eqBRealGetGame;
    return Promise.all([CoachStore.listCards(), CoachStore.getGame('eqB')])
      .then(function (stored) {
      const cards = stored[0];
      const c = cards.find(function (x) { return x.gameId === 'eqB'; });
      const a = c.attempts[0];
      return a.verdict === 'unknown' && a.equivalent === null &&
        a.evidenceSource === null && a.criterion === null &&
        a.provider === null && a.recommendedGrade === null &&
        a.grade === 'again' &&
        CoachStore.validateCardRecord(c, null, stored[1]) === null;
    });
  }), 'the absent attempt records an honest unknown verdict and the player’s grade');

  // C) outside the covered set: unknown → the live engine check settles it.
  // a3 ignores the hanging rook on e4 (dxe4 wins it outright), so the
  // criterion must reject it by a decisive cp gap — and the analysis (same
  // identity construction as reflection's) lands in the shared cache. A
  // full opening board keeps quiescence tame so the deep profile COMPLETES;
  // a budget-capped partial would honestly refuse to judge instead (which
  // is why sparse queen endings are deliberately not used here).
  await page.waitForSelector('#trainCardBox:not([hidden])');

  // First prove that leaving Train cancels the owner-scoped deep job. A
  // controlled worker stalls after dispatch; navigation must terminate it,
  // clear the hidden status, and make late progress unable to repaint. The
  // ungraded card remains due and is presented again on re-entry.
  await page.evaluate(function () {
    window.__trainCancelHadFactory =
      Object.prototype.hasOwnProperty.call(window, 'CHESSY_ANALYSIS_WORKER_FACTORY');
    window.__trainCancelRealFactory = window.CHESSY_ANALYSIS_WORKER_FACTORY;
    window.__trainCancelRealCancel = ChessyAnalysisService.cancel;
    window.__trainCancelOwners = [];
    window.__trainCancelWorkers = [];
    ChessyAnalysisService.cancel = function (owner) {
      window.__trainCancelOwners.push(arguments.length ? owner : '(global)');
      return window.__trainCancelRealCancel.apply(ChessyAnalysisService, arguments);
    };
    window.CHESSY_ANALYSIS_WORKER_FACTORY = function () {
      const fake = {
        terminated: false,
        posts: [],
        onmessage: null,
        onerror: null,
        postMessage: function (msg) { this.posts.push(msg); },
        terminate: function () { this.terminated = true; }
      };
      window.__trainCancelWorkers.push(fake);
      return fake;
    };
  });
  await tsq('a2').click();
  await tsq('a3').click();
  await page.waitForFunction(function () {
    return window.__trainCancelWorkers.length === 1 &&
      window.__trainCancelWorkers[0].posts.length === 1;
  });
  await page.click('#tabPlay');
  const leftTrain = await page.evaluate(function () {
    const worker = window.__trainCancelWorkers[0];
    const post = worker.posts[0];
    const note = document.getElementById('trainCheck');
    const before = {
      owner: window.__trainCancelOwners[window.__trainCancelOwners.length - 1],
      terminated: worker.terminated,
      hidden: note.hidden,
      text: note.textContent,
      playVisible: !document.getElementById('viewPlay').hidden,
      focusOutside: !document.getElementById('viewTrain')
        .contains(document.activeElement)
    };
    // A terminated Worker cannot really reply, but invoke the captured handler
    // to model a queued event that crossed the cancellation boundary.
    worker.onmessage({
      data: {
        v: ChessyAnalysisService.PROTOCOL,
        jobId: post.jobId,
        progress: {
          phase: 'root-verification',
          completedRoots: 1,
          totalRoots: 20,
          elapsedMs: 10
        }
      }
    });
    return before;
  });
  await page.waitForTimeout(100);
  check(leftTrain.owner === 'train' && leftTrain.terminated &&
        leftTrain.hidden && leftTrain.text === '' &&
        leftTrain.playVisible && leftTrain.focusOutside &&
        await page.locator('#trainCheck').isHidden() &&
        (await page.textContent('#trainCheck')) === '',
    'leaving Train terminates only its live check and late progress cannot repaint the hidden view');
  await page.evaluate(function () {
    ChessyAnalysisService.cancel = window.__trainCancelRealCancel;
    if (window.__trainCancelHadFactory) {
      window.CHESSY_ANALYSIS_WORKER_FACTORY = window.__trainCancelRealFactory;
    } else {
      delete window.CHESSY_ANALYSIS_WORKER_FACTORY;
    }
  });
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  check((await page.textContent('#trainCount')).includes('1 due'),
    'the cancelled, ungraded card remains due when Train is reopened');

  await tsq('a2').click();
  await tsq('a3').click();
  await page.waitForSelector('#trainReveal:not([hidden])');
  check((await page.textContent('#trainOutcome')).includes('grade yourself honestly'),
    'an uncovered answer keeps the honest differs wording while the check runs');
  await page.waitForFunction(function () {
    return document.getElementById('trainCheck').textContent.indexOf('Chessy checked') !== -1;
  }, null, { timeout: 90000 });
  const liveNote = await page.textContent('#trainCheck');
  check(liveNote.includes('✗') && liveNote.includes('a3') &&
        liveNote.includes('falls short of dxe4') &&
        liveNote.includes('Suggested grade: Again'),
    'the live check rejects the rook-ignoring attempt by its gap (' + liveNote + ')');
  await page.click('#gradeAgain');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  check(await page.evaluate(function () {
    return Promise.all([CoachStore.listCards(), CoachStore.getGame('eqgame')])
      .then(function (stored) {
      const cards = stored[0];
      const c = cards.find(function (x) { return x.gameId === 'eqgame'; });
      const a = c.attempts[0];
      return a.verdict === 'not-equivalent' && a.equivalent === false &&
        a.evidenceSource === 'live-analysis' &&
        !!a.provider && typeof a.provider.engineId === 'string' &&
        !!a.criterion && Number.isInteger(a.criterion.version) &&
        CoachStore.validateCardRecord(c, null, stored[1]) === null;
    });
  }), 'the live-checked attempt records live-analysis provenance');
  check(await page.evaluate(function () {
    return CoachStore.listAnalysesForGame('eqgame').then(function (rows) {
      return rows.length >= 1;
    });
  }), 'the live check cached its analysis under the shared identity');

  // Poison only an INNER analysis field while retaining the matching cache
  // identity. Train must reject and evict that row, then force an immediate
  // identical retry past IndexedDB even while the delete is still pending.
  const goodCachedResult = await page.evaluate(function () {
    return Promise.all([
      CoachStore.listAnalysesForGame('eqgame'), CoachStore.listCards()
    ]).then(function (stored) {
      const row = stored[0][0];
      const good = JSON.parse(JSON.stringify(row.result));
      row.result.bestLines[0].san = 'forged SAN';
      const card = stored[1].find(function (x) { return x.gameId === 'eqgame'; });
      card.due = Date.now() - 1;
      return Promise.all([
        CoachStore.putAnalysis(row), CoachStore.updateCard(card)
      ]).then(function () { return good; });
    });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await page.evaluate(function () {
    window.__poisonDispatches = ChessyAnalysisService.stats().dispatches;
    window.__poisonInvalidations = 0;
    window.__poisonRealInvalidate = ChessyAnalysisService.invalidate;
    ChessyAnalysisService.invalidate = function (req) {
      window.__poisonInvalidations++;
      return window.__poisonRealInvalidate(req);
    };
    window.__poisonRealDelete = CoachStore.deleteAnalysis;
    window.__poisonDeleteStarted = false;
    CoachStore.deleteAnalysis = function (key) {
      window.__poisonDeleteStarted = true;
      return new Promise(function (resolve, reject) {
        window.__poisonReleaseDelete = function () {
          return window.__poisonRealDelete(key).then(resolve, reject);
        };
      });
    };
  });
  await tsq('a2').click();
  await tsq('a3').click();
  await page.waitForFunction(function () {
    return document.getElementById('trainCheck').textContent
      .indexOf('could not fully check') !== -1 &&
      window.__poisonDeleteStarted;
  });
  check(await page.evaluate(function () {
    return window.__poisonInvalidations === 1 &&
      ChessyAnalysisService.stats().dispatches === window.__poisonDispatches;
  }), 'a malformed matching-key cache hit is rejected and scheduled for eviction');

  await page.click('#tabPlay');
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  await page.evaluate(function () {
    window.__poisonWorkers = [];
    window.__poisonHadFactory =
      Object.prototype.hasOwnProperty.call(window, 'CHESSY_ANALYSIS_WORKER_FACTORY');
    window.__poisonRealFactory = window.CHESSY_ANALYSIS_WORKER_FACTORY;
    window.CHESSY_ANALYSIS_WORKER_FACTORY = function () {
      const fake = {
        posts: [], onmessage: null, onerror: null, terminated: false,
        postMessage: function (msg) { this.posts.push(msg); },
        terminate: function () { this.terminated = true; }
      };
      window.__poisonWorkers.push(fake);
      return fake;
    };
  });
  await tsq('a2').click();
  await tsq('a3').click();
  await page.waitForFunction(function () {
    return window.__poisonWorkers.length === 1 &&
      window.__poisonWorkers[0].posts.length === 1;
  });
  check(await page.evaluate(function () {
    return ChessyAnalysisService.stats().dispatches ===
      window.__poisonDispatches + 1;
  }), 'the immediate identical retry bypasses the still-present poisoned row');
  await page.evaluate(function (result) {
    const fake = window.__poisonWorkers[0];
    fake.onmessage({
      data: {
        v: ChessyAnalysisService.PROTOCOL,
        jobId: fake.posts[0].jobId,
        result: result
      }
    });
  }, goodCachedResult);
  await page.waitForFunction(function () {
    return document.getElementById('trainCheck').textContent
      .indexOf('Chessy checked') !== -1;
  });
  await page.evaluate(function () {
    const released = window.__poisonReleaseDelete();
    CoachStore.deleteAnalysis = window.__poisonRealDelete;
    ChessyAnalysisService.invalidate = window.__poisonRealInvalidate;
    if (window.__poisonHadFactory) {
      window.CHESSY_ANALYSIS_WORKER_FACTORY = window.__poisonRealFactory;
    } else {
      delete window.CHESSY_ANALYSIS_WORKER_FACTORY;
    }
    return released;
  });
  await page.waitForFunction(function () {
    return CoachStore.listAnalysesForGame('eqgame').then(function (rows) {
      return rows.some(function (row) {
        return row.result && row.result.bestLines &&
          row.result.bestLines[0] &&
          row.result.bestLines[0].san !== 'forged SAN';
      });
    });
  });
  check(true, 'the fresh validated result replaces the evicted poisoned cache entry');
  await page.click('#gradeAgain');
  await page.waitForSelector('#trainEmpty:not([hidden])');
});
