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

  // Reload → undo → reproduce the SAME ending: the persisted signatures
  // (and gameSeq, saved with the game) still dedupe across the reload —
  // and "Review game" still opens the coaching review of THAT record (the
  // dedupe path re-associates the handoff by lookup; it used to fall back
  // to the Play replay because the archive promise died with the reload).
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'a re-shown ending after reload hands off to the coaching review of its record');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewBack',
    'the asynchronous handoff moves focus into the review flow');

  await page.click('#tabReview');
  check(await page.getAttribute('#tabReview', 'aria-current') === 'page', 'Review tab activates');
  check(await page.locator('#viewPlay').isHidden(), 'Play view hidden on Review tab');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2,
    'rematch archives again; a reloaded, replayed ending does not (2 games)');
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
  await page.click('#reflectVerify'); // EMPTY reflection: required fields block
  check(await page.locator('#verifyBox').isHidden(),
    'empty reflection cannot summon the engine (fields are required)');
  // Whitespace passes native `required` but is not reflection: the submit
  // handler trims before re-validating, so spaces-only answers block too.
  await page.fill('#reflectThreat', '   ');
  await page.fill('#reflectCandidates', '  ');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  check(await page.locator('#verifyBox').isHidden(),
    'whitespace-only reflection is rejected (trimmed before validation)');
  await page.fill('#reflectThreat', 'nothing concrete yet');
  await page.fill('#reflectCandidates', 'e4, d4');
  await page.selectOption('#reflectEval', 'equal');
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
  check(!momentText.includes('pawns') && !momentText.includes('swing'),
    'moment list withholds the loss magnitude until reflection');
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

  // The played mate IS Chessy's move: a positive PATTERN card — no cause
  // diagnosis is asked for, but the lesson sentence is still required.
  check(await page.locator('#causeLabel').isHidden(),
    'cause picker hidden for a good-move (pattern) verdict');
  await page.click('#saveCard'); // lesson still empty: validation blocks
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('lesson'),
    'saving requires a one-sentence lesson');

  // Save the lesson card — double-click on purpose: the button must
  // disable before the async write, so only ONE card is created.
  await page.fill('#cardLesson', 'Look for forcing mates before anything else');
  await page.evaluate(function () {
    document.getElementById('saveCard').click();
    document.getElementById('saveCard').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.includes('due in Train');
  });
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
  check(await page.locator('#trainBoard .square[tabindex="0"]').count() === 1,
    'training board has a single roving tab stop');
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
  check((await page.textContent('#causeStats')).includes('Good move (pattern)'),
    'pattern cards counted separately from error causes');

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

  // A cancelled JSON restore stops before writing anything further.
  const cancelledRestore = await page.evaluate(function () {
    return CoachStore.listGames().then(function (before) {
      return CoachStore.exportAll().then(function (data) {
        return CoachStore.importAll(data, function () { return true; })
          .then(function () { return { result: 'completed' }; },
                function (e) { return { result: String((e && e.message) || e) }; });
      }).then(function (r) {
        return CoachStore.listGames().then(function (after) {
          r.unchanged = after.length === before.length;
          return r;
        });
      });
    });
  });
  check(cancelledRestore.result.indexOf('cancelled') !== -1 && cancelledRestore.unchanged,
    'cancelled JSON restore writes nothing (' + cancelledRestore.result + ')');

  // A restore that FAILS mid-way (here: an uncloneable card record) rolls
  // back its committed prefix — a retry must not duplicate the games that
  // made it in before the failure.
  const rollback = await page.evaluate(function () {
    const data = {
      format: 'chessy-coach', version: 1,
      games: [{ id: 7, source: 'import', tags: {}, sans: ['e4'], playerColor: 'both',
        clocks: null, result: '*', reason: '', mode: null, difficulty: null,
        timeControl: null, plies: 1, createdAt: 1 }],
      cards: [{ id: 9, gameId: 7, bad: function () {} }] // DataCloneError on put
    };
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (before) {
      return CoachStore.importAll(data).then(
        function () { return { failed: false }; },
        function () {
          return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (after) {
            return {
              failed: true,
              unchanged: after[0].length === before[0].length && after[1].length === before[1].length
            };
          });
        });
    });
  });
  check(rollback.failed && rollback.unchanged,
    'a failed restore rolls back its committed prefix (no partial import)');

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
  await t.pick('importColor', 'b'); // "I played Black" — used by the scan below
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.locator('.game-item', { hasText: 'threefold' }).click();
  await page.click('#revEnd');
  await page.click('#revPrev'); // ply 7: ...Ng8 completes the threefold
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'nothing');
  await page.fill('#reflectCandidates', 'Ng8, Nd5');
  await page.selectOption('#reflectEval', 'equal');
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
  await page.fill('#reflectThreat', 'nothing');
  await page.fill('#reflectCandidates', 'Nf3');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await page.click('#reviewBack'); // leave immediately, probes still queued
  await page.locator('.game-item', { hasText: 'Anna' }).click(); // game B
  await page.click('#flagMoment');
  await page.waitForTimeout(6000); // let game A's stale probes finish
  check(await page.locator('#saveCard').isDisabled(),
    'stale verification from the previous game is discarded (Save stays disabled)');
  // ...and a fresh verification on game B still works after the discard.
  await page.fill('#reflectThreat', 'nothing yet');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check(!(await page.locator('#saveCard').isDisabled()),
    'a fresh verification after the discarded one enables Save normally');

  // Color-aware scan: this game was imported as "I played Black", so only
  // Black's decisions may become moments — the winner's moves are not the
  // trainee's lesson material.
  await page.click('#scanGame');
  await page.waitForFunction(function () {
    const el = document.getElementById('scanStatus');
    return !el.hidden && !el.textContent.includes('Scanning');
  }, null, { timeout: 90000 });
  const colorMoments = await page.textContent('#momentList');
  check(colorMoments.includes('(Black)') && !colorMoments.includes('(White)'),
    'scan surfaces only the trainee color’s decisions');
  check((await page.textContent('#scanStatus')).includes('Black'),
    'scan status names the coached side');

  // Error card end to end: open the blunder moment, reflect, verify, and
  // the cause diagnosis becomes required before saving.
  await page.locator('.moment-item', { hasText: 'Nf6' }).click();
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'Qxf7 mate threat');
  await page.fill('#reflectCandidates', 'Nf6, g6');
  await page.selectOption('#reflectEval', 'worse');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check(!(await page.locator('#causeLabel').isHidden()),
    'cause picker shown for an error verdict');
  await page.fill('#cardLesson', 'Check every mate threat on f7 first');
  await page.click('#saveCard'); // cause still unpicked: validation blocks
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('cause'),
    'error cards require a cause diagnosis');
  await page.selectOption('#cardCause', 'threat-scan');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.includes('due in Train');
  });
  check(true, 'error card saved after cause + lesson provided');

  // Archive dedupe retains EVERY ending signature per game instance:
  // finishing line A, undoing into line B, then reproducing A must not
  // archive A twice (the old single-slot dedupe only remembered B).
  const abaCount = await page.evaluate(function () {
    const settings = { mode: 'pvp', difficulty: '2', timeControl: 'none' };
    const status = { over: true, result: '1-0', reason: 'aba-test' };
    const lineA = { history: [{ san: 'e4' }, { san: 'e5' }] };
    const lineB = { history: [{ san: 'd4' }] };
    return Coach.archiveGame(lineA, settings, status, 99)
      .then(function () { return Coach.archiveGame(lineB, settings, status, 99); })
      .then(function () { return Coach.archiveGame(lineA, settings, status, 99); })
      .then(function () { return CoachStore.listGames(); })
      .then(function (games) {
        return games.filter(function (g) { return g.reason === 'aba-test'; }).length;
      });
  });
  check(abaCount === 2, 'A-B-A endings in one game instance archive each line once (got ' + abaCount + ')');

  // ...and the dedupe path re-associates the handoff: after A→B→A the last
  // archiveGame call was a dedupe hit for line A, so "Review game" must
  // open line A's record (2 plies) — not line B's, the last one written.
  await page.evaluate(function () { Coach.openLatestArchived(); });
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });
  check((await page.textContent('#reviewStatus')).includes('Position 0/2'),
    'A-B-A: the handoff reopens line A (2 plies), not line B (1 ply)');

  // Cancelling a running multi-game import stops the remaining writes: the
  // chain imports one game at a time and Cancel bumps the batch token.
  const beforeCancel = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  await page.click('#tabReview');
  await page.click('#importPgnBtn');
  const manyGames = Array.from({ length: 40 }, function (x, i) {
    return '[Event "Bulk ' + i + '"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
  }).join('\n');
  await page.fill('#importText', manyGames);
  await page.click('#importStart');
  await page.click('#importCancel'); // cancel while the batch is writing
  await page.waitForTimeout(1500);   // give any (wrongly) surviving chain time to run
  const afterCancel = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  check(afterCancel - beforeCancel < 40,
    'Cancel stops a running import (' + (afterCancel - beforeCancel) + '/40 written before cancel)');
  check(!(await page.evaluate(function () { return document.getElementById('importStart').disabled; })),
    'Import button re-enabled after a cancelled batch');

  // Delete-all invalidates an active scan: a scan finishing after the wipe
  // must not put() its game back into the cleared store. The 7-ply mate
  // game scans for ~3s, leaving a real window for the wipe to land mid-scan.
  await page.click('#tabReview'); // refresh the list
  await page.locator('.game-item', { hasText: 'Anna' }).first().click();
  await page.click('#scanGame');
  await page.click('#tabProgress');
  page.once('dialog', function (d) { d.accept(); });
  await page.click('#deleteData');
  await page.waitForFunction(function () {
    return document.getElementById('dataNote').textContent.includes('deleted');
  });
  await page.waitForTimeout(6000); // the abandoned scan would have finished by now
  const resurrected = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  check(resurrected === 0, 'delete-all is not undone by a scan finishing afterwards (got ' + resurrected + ' games)');

  // Escape (the native <dialog> cancel path) must cancel a running import
  // batch just like the Cancel button does.
  await page.click('#tabReview');
  await page.click('#importPgnBtn');
  await page.fill('#importText', manyGames);
  await page.click('#importStart');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  const afterEsc = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  check(afterEsc < 40, 'Escape cancels a running import (' + afterEsc + '/40 written)');

  // A delete in ANOTHER tab invalidates this tab's in-flight scan too:
  // the coaching generation is broadcast via a storage event.
  await page.click('#importPgnBtn');
  await page.fill('#importText',
    '[White "Solo"]\n[Black "Two"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0');
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.locator('.game-item', { hasText: 'Solo' }).click();
  await page.click('#scanGame'); // ~3 s of probes ahead
  const page2 = await t.context.newPage();
  await page2.goto(t.url);
  await page2.waitForSelector('#board .square');
  await page2.click('#tabProgress');
  page2.once('dialog', function (d) { d.accept(); });
  await page2.click('#deleteData');
  await page2.waitForFunction(function () {
    return document.getElementById('dataNote').textContent.includes('deleted');
  });
  await page2.close();
  await page.waitForTimeout(6000); // the first tab's abandoned scan window
  const crossTab = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  check(crossTab === 0,
    'a delete in another tab stops this tab’s scan from resurrecting data (got ' + crossTab + ')');

  // A cross-tab delete also clears THIS tab's active coaching UI: a due
  // card left on screen could otherwise be graded afterwards, recreating
  // it under the new generation (past the undo checks).
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.addCard({
      gameId: null, ply: 0,
      fenBefore: '8/P6k/8/8/8/8/6K1/8 w - - 0 1',
      playedSan: 'a8=Q', bestSan: 'a8=N',
      bestMove: { from: 8, to: 0, promotion: 'N' },
      bestScore: 0, playedScore: 0, lossCp: 120,
      cause: 'calculation', lesson: 'x', reflection: {},
      createdAt: now, due: now, step: -1, attempts: []
    });
  });
  await page.click('#tabTrain');
  await page.waitForSelector('#trainCardBox:not([hidden])');
  const page3 = await t.context.newPage();
  await page3.goto(t.url);
  await page3.waitForSelector('#board .square');
  await page3.click('#tabProgress');
  page3.once('dialog', function (d) { d.accept(); });
  await page3.click('#deleteData');
  await page3.waitForFunction(function () {
    return document.getElementById('dataNote').textContent.includes('deleted');
  });
  await page3.close();
  await page.waitForSelector('#trainEmpty:not([hidden])', { timeout: 5000 });
  check(await page.locator('#trainCardBox').isHidden(),
    'a cross-tab delete clears this tab’s active training card');

  // Delete All must not be undone by a JSON restore whose file was picked
  // BEFORE the delete: the generation is captured when the file is chosen,
  // so a delete landing while the (possibly large) file is still being
  // read invalidates the restore before its first write. The FileReader is
  // stubbed so the test controls exactly when the read completes.
  const backupJson = JSON.stringify({
    format: 'chessy-coach', version: 1, exportedAt: 1,
    games: [{ id: 1, source: 'import', tags: {}, sans: ['e4'], playerColor: 'both',
      clocks: null, result: '*', reason: '', mode: null, difficulty: null,
      timeControl: null, plies: 1, createdAt: 1 }],
    cards: []
  });
  await page.click('#tabProgress');
  await page.evaluate(function () {
    window.__RealFileReader = window.FileReader;
    window.FileReader = function () {
      window.__pendingReader = this;
      this.readAsText = function () { /* completes only when the test fires onload */ };
    };
  });
  await page.setInputFiles('#importFile', {
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupJson)
  });
  page.once('dialog', function (d) { d.accept(); });
  await page.click('#deleteData'); // delete while the "read" is in flight
  await page.waitForFunction(function () {
    return document.getElementById('dataNote').textContent.includes('deleted');
  });
  await page.evaluate(function (json) {
    const r = window.__pendingReader;
    r.result = json;
    r.onload(); // the read completes AFTER the delete
    window.FileReader = window.__RealFileReader;
  }, backupJson);
  await page.waitForTimeout(500);
  const readRace = await page.evaluate(function () {
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()])
      .then(function (r) { return r[0].length + r[1].length; });
  });
  check(readRace === 0,
    'Delete All is not undone by a restore whose file read finishes after it (got ' + readRace + ')');

  // A card that comes due while the user sits in Train (the "Again" retry
  // path) requeues automatically — no tab round-trip required. The empty
  // state names the unlock time while waiting.
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.addCard({
      gameId: null, ply: 0,
      fenBefore: '8/P6k/8/8/8/8/6K1/8 w - - 0 1',
      playedSan: 'a8=Q', bestSan: 'a8=N',
      bestMove: { from: 8, to: 0, promotion: 'N' },
      bestScore: 0, playedScore: 0, lossCp: 120,
      cause: 'calculation', lesson: 'x', reflection: {},
      createdAt: now, due: now + 1500, step: -1, attempts: []
    });
  });
  await page.click('#tabTrain');
  await page.waitForSelector('#trainEmpty:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('trainEmpty').textContent.includes('unlocks');
  }, null, { timeout: 5000 });
  check(true, 'Train names the next near-term due time while waiting');
  await page.waitForSelector('#trainCardBox:not([hidden])', { timeout: 10000 });
  check(true, 'a card coming due while in Train requeues automatically');
  // Consume it so later checks see a clean slate.
  const tsq2 = function (name) { return page.locator('#trainBoard .square').nth(idx(name)); };
  await tsq2('a7').click();
  await tsq2('a8').click();
  await page.waitForSelector('#promotionDialog[open]');
  await page.click('#promotionChoices [aria-label="Promote to knight"]');
  await page.waitForSelector('#trainReveal:not([hidden])');
  await page.click('#gradeGood');
  await page.waitForSelector('#trainEmpty:not([hidden])');

  // "Review game" opens the game that JUST finished — the handoff awaits
  // the in-flight archive write instead of trusting a stale id.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp' });
  await mv('e2', 'e4'); await mv('e7', 'e5');
  await mv('d1', 'h5'); await mv('b8', 'c6');
  await mv('f1', 'c4'); await mv('g8', 'f6');
  await mv('h5', 'f7'); // 7-ply scholar's mate
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await t.newGame({});
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4'); // 4-ply fool's mate
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview'); // immediately — the write may be in flight
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'Review game opens the 4-ply game that just finished, not the earlier 7-ply one');

  // A finished game whose archive write was LOST (tab died between the
  // localStorage save and the IndexedDB commit) is reconciled on boot: the
  // restored game re-offers itself and the persisted dedupe decides.
  const gamesBefore = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  await page.evaluate(function () {
    localStorage.removeItem('chessy-coach-sigs-v1'); // the "lost" write: no signature…
    return CoachStore.listGames().then(function (games) {
      return CoachStore.deleteGame(games[0].id);     // …and no record
    });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForFunction(function (n) {
    return CoachStore.listGames().then(function (g) { return g.length === n; });
  }, gamesBefore, { timeout: 5000 });
  check(true, 'boot re-archives a restored finished game whose write was lost');
  // …and the reconcile is idempotent: another boot must not duplicate it.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(600);
  const gamesAfter = await page.evaluate(function () {
    return CoachStore.listGames().then(function (g) { return g.length; });
  });
  check(gamesAfter === gamesBefore,
    'boot reconcile dedupes on the next reload (got ' + gamesAfter + ', want ' + gamesBefore + ')');
});
