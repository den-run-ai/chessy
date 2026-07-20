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

  // The imported archive survives a reload and replays in the browser.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 5, 'imported games survive reload');
  await page.locator('.game-item', { hasText: 'Anna vs Ben' }).click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/7'),
    'imported game opens in the position browser');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'),
    'imported game replays to its end');
  await page.click('#reviewBack');

  // Play is undisturbed by the excursion.
  await page.click('#tabPlay');
  check(await page.locator('#viewPlay').isVisible(), 'Play tab returns to the game');
});
