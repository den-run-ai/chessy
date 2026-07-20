/* Game archive: finished games are stored in IndexedDB, deduped per game
 * instance, and browsable position by position in the Review view. */
'use strict';
require('./helper').run('coach', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  // Tabs exist; Play is current.
  check(await page.locator('.tab').count() === 2, 'Play and Review section tabs');
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

  // Reload → undo → reproduce the SAME ending: gameSeq is saved with the
  // game, so the re-shown ending carries the same signature and the
  // database's unique index refuses the duplicate — and "Review game"
  // still opens the coaching review of THAT record (the ConstraintError
  // path re-associates the handoff by signature lookup).
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
  check((await page.textContent('.game-item')).includes('Two players'),
    'archived game labelled with its mode');

  // The archive survives a reload (IndexedDB, not localStorage).
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2, 'archive survives reload');

  // The stored record retains the coaching evidence fields.
  const stored = await page.evaluate(function () {
    return CoachStore.listGames().then(function (games) {
      const g = games[0];
      return {
        source: g.source, plies: g.plies, playerColor: g.playerColor,
        clocks: Array.isArray(g.clocks) && g.clocks.length === g.sans.length,
        sig: typeof g.sig === 'string' && g.sig.indexOf('f3 e5 g4 Qh4#') !== -1
      };
    });
  });
  check(stored.source === 'play' && stored.plies === 4 && stored.playerColor === 'both' &&
        stored.clocks && stored.sig,
    'archived record carries source, plies, player color, per-move clocks and signature');

  // The unique signature index is the durable dedupe: a direct duplicate
  // insert (same instance, moves, result) is refused by the database.
  const dupName = await page.evaluate(function () {
    return CoachStore.listGames().then(function (games) {
      const g = games[0];
      return CoachStore.addGame({
        source: 'play', sig: g.sig, gameSeq: g.gameSeq, sans: g.sans,
        result: g.result, plies: g.plies, createdAt: Date.now()
      }).then(function () { return 'added'; }, function (e) { return e.name; });
    });
  });
  check(dupName === 'ConstraintError', 'duplicate signature insert is refused by the DB');

  // Browse the archived game position by position.
  await page.locator('.game-item').first().click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'), 'review starts at ply 0');
  check((await page.textContent('#reviewStatus')).includes('played here: f3'),
    'position browser shows the move played here');
  check(await page.locator('#revStart').isDisabled(), 'Start disabled at ply 0');
  await page.click('#revNext');
  check((await page.textContent('#reviewStatus')).includes('Position 1/4'), 'Next steps forward');
  check((await page.textContent('#reviewStatus')).includes('Black to move'),
    'side to move tracks the position');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'), 'End reaches the final position');
  check(await page.locator('#revNext').isDisabled(), 'Next disabled at the end');
  await page.click('#revPrev');
  check((await page.textContent('#reviewStatus')).includes('played here: Qh4'),
    'Prev steps back to the last decision');
  await page.click('#reviewBack');
  await page.waitForSelector('.game-item');
  check(await page.locator('#reviewFlow').isHidden(), 'Back returns to the game list');

  // ---- PGN import ----
  // A bad PGN reports instead of breaking.
  await page.click('#importPgnBtn');
  await page.fill('#importText', '1. e4 e5 2. zz9');
  await page.click('#importStart');
  await page.waitForFunction(function () {
    return document.getElementById('importError').textContent.indexOf('Import failed') !== -1;
  });
  check((await page.textContent('#importError')).includes('illegal or unknown SAN'),
    'illegal PGN reports an import error');

  // SetUp/FEN games are out of scope for this slice and say so.
  await page.fill('#importText', '[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Ka2 *');
  await page.click('#importStart');
  await page.waitForFunction(function () {
    return document.getElementById('importError').textContent.indexOf('set-up position') !== -1;
  });
  check(true, 'SetUp/FEN games are reported as unsupported');

  // Empty text is a distinct message.
  await page.fill('#importText', '   ');
  await page.click('#importStart');
  await page.waitForFunction(function () {
    return document.getElementById('importError').textContent.indexOf('No games found') !== -1;
  });
  check(true, 'empty import reports "no games found"');

  // A real game imports, closes the dialog and joins the archive.
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
  check((await page.textContent('#gameList')).includes('Anna vs Ben'),
    'imported game labelled from its PGN tags');

  // A tagless multi-game paste imports every game.
  await page.click('#importPgnBtn');
  await page.fill('#importText', '1. e4 e5 1-0\n\n1. d4 d5 1/2-1/2');
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.waitForFunction(function () {
    return document.querySelectorAll('.game-item').length === 5;
  });
  check(true, 'tagless multi-game paste imports both games');

  // Claim-based draws don't override the recorded result: this game ends in
  // a threefold-CLAIMABLE position, but the player resigned instead — the
  // declared 0-1 must be archived, not Chessy's automatic 1/2-1/2.
  await page.click('#importPgnBtn');
  await page.fill('#importText',
    '[White "Claim"]\n[Result "0-1"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 0-1');
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  const claimed = await page.evaluate(function () {
    return CoachStore.listGames().then(function (games) {
      const g = games.find(function (x) { return x.tags && x.tags.White === 'Claim'; });
      return { result: g.result, reason: g.reason };
    });
  });
  check(claimed.result === '0-1' && claimed.reason === '',
    'a claimable-draw position keeps the declared result (0-1, not auto-1/2-1/2)');

  // A batch landing after its dialog was closed must not close a NEWLY
  // reopened dialog (or discard its fresh paste).
  await page.click('#importPgnBtn');
  await page.evaluate(function () {
    CoachStore.__realAddGame = CoachStore.addGame;
    CoachStore.addGame = function (g) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { CoachStore.__realAddGame(g).then(resolve, reject); }, 1500);
      });
    };
  });
  await page.fill('#importText', '1. e4 e5 *');
  await page.click('#importStart');
  await page.click('#importCancel'); // close mid-batch
  await page.click('#importPgnBtn'); // reopen: a NEW dialog session
  check(await page.evaluate(function () { return document.getElementById('importStart').disabled; }),
    'Import stays locked while the previous batch is still writing');
  await page.fill('#importText', '1. d4 d5 *');
  await page.waitForFunction(function () {
    return !document.getElementById('importStart').disabled;
  }, null, { timeout: 15000 });
  check(await page.evaluate(function () { return document.getElementById('importDialog').open; }),
    'the old batch landing does not close the reopened dialog');
  check((await page.inputValue('#importText')) === '1. d4 d5 *', 'the new paste survives');
  await page.evaluate(function () { CoachStore.addGame = CoachStore.__realAddGame; });
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });

  // The imported archive survives a reload and replays in the browser.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 8, 'imported games survive reload');
  await page.locator('.game-item', { hasText: 'Anna vs Ben' }).click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/7'),
    'imported game opens in the position browser');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'),
    'imported game replays to its end');
  await page.click('#revStart');

  // ---- Retroactive scan + hidden reflection + lesson cards ----
  // Start a scan, then flag a moment and verify it while the scan is
  // mid-flight — analysis requests must queue behind each other (a second
  // request used to orphan the scan's pending reply and freeze the UI).
  await page.click('#scanGame');
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
  await page.click('#reflectVerify');
  check(await page.locator('#reflectVerify').isDisabled(),
    'Verify disables while analysis is in flight (no duplicate probe pairs)');
  await page.waitForFunction(function () {
    const el = document.getElementById('verifyResult');
    return el.textContent && !el.textContent.includes('Analysing');
  }, null, { timeout: 60000 });
  check((await page.textContent('#verifyResult')).includes('e4'),
    'verification completes while a scan is running (queued, not clobbered)');
  check(!(await page.locator('#reflectVerify').isDisabled()),
    'Verify re-enables once its request settles');
  await page.waitForFunction(function () {
    const el = document.getElementById('scanStatus');
    return !el.hidden && !el.textContent.includes('Scanning');
  }, null, { timeout: 90000 });
  check((await page.textContent('#scanStatus')).includes('key moment'), 'scan reports key moments');
  const momentCount = await page.locator('.moment-item').count();
  check(momentCount >= 1 && momentCount <= 2, 'between 1 and 2 key moments listed');
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
      const g = games.find(function (x) { return x.tags && x.tags.White === 'Anna'; });
      return { hasScan: !!g.scan, moments: g.scan ? g.scan.moments.length : 0, evals: g.scan ? g.scan.evals.length : 0 };
    });
  });
  check(scanned.hasScan && scanned.moments >= 1 && scanned.evals === 8,
    'scan stored on the game (evals for all 8 positions)');

  await page.click('#revEnd');
  check(await page.locator('#flagMoment').isDisabled(), 'cannot flag the end position (no move played)');
  await page.click('#revPrev');
  check((await page.textContent('#reviewStatus')).includes('played here: Qxf7#'),
    'position browser shows the final decision');

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
  }, null, { timeout: 60000 });
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
    return document.getElementById('cardSaved').textContent.includes('Lesson card saved');
  });
  const cardCount = await page.evaluate(function () {
    return CoachStore.listCards().then(function (c) { return c.length; });
  });
  check(cardCount === 1, 'double-clicking Save creates exactly one card');
  const savedCard = await page.evaluate(function () {
    return CoachStore.listCards().then(function (c) { return c[0]; });
  });
  check(savedCard.kind === 'pattern' && savedCard.cause === 'pattern' &&
        savedCard.step === -1 && savedCard.due <= Date.now() &&
        !!savedCard.bestMove && savedCard.reflection.threat === 'mate on f7',
    'saved card carries verdict, reflection and immediate-due scheduling');

  // A move that COMPLETES a threefold repetition is a draw — verification
  // must score it 0 from the prefix's repetition table, not analyse the
  // bare FEN as an ongoing position.
  await page.click('#reviewBack');
  await page.click('#importPgnBtn');
  await page.fill('#importText', [
    '[Event "Rep"]',
    '',
    '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2',
    '[Event "Mate"]',
    '[White "Cara"]',
    '[Black "Dan"]',
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
  await page.locator('.game-item', { hasText: 'Cara' }).click(); // game B
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
  // Flagging a NEW moment resets every reflection field — including the
  // evaluation select, which would otherwise carry a stale answer into
  // the next card.
  check(await page.evaluate(function () { return document.getElementById('reflectEval').value; }) === '',
    'flagging a new moment clears the previous evaluation');
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
    return document.getElementById('cardSaved').textContent.includes('Lesson card saved');
  });
  check(true, 'error card saved after cause + lesson provided');

  // An imported game that CONTINUES past an engine-automatic draw (an
  // unclaimed threefold) has moves played from positions the engine
  // scores as over — those moments are not flaggable (analysis has no
  // move to return; the card would be unanswerable).
  await page.click('#reviewBack');
  await page.click('#importPgnBtn');
  await page.fill('#importText',
    '[White "Cont"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 5. Nf3 Nf6 *');
  await page.click('#importStart');
  await page.waitForFunction(function () { return !document.getElementById('importDialog').open; });
  await page.locator('.game-item', { hasText: 'Cont' }).click();
  await page.click('#revEnd');
  await page.click('#revPrev');
  await page.click('#revPrev'); // ply 8: 5. Nf3 played FROM the completed threefold
  check((await page.textContent('#reviewStatus')).includes('not flaggable'),
    'status explains why a drawn-by-rule position cannot be flagged');
  check(await page.locator('#flagMoment').isDisabled(),
    'moves played from an engine-terminal position are not flaggable');
  await page.click('#revPrev'); // ply 7: 4… Ng8 — position before it is NOT terminal
  check(!(await page.locator('#flagMoment').isDisabled()),
    'ordinary positions in the same game remain flaggable');
  await page.click('#reviewBack');

  // Play is undisturbed by the excursion.
  await page.click('#tabPlay');
  check(await page.locator('#viewPlay').isVisible(), 'Play tab returns to the game');
});
