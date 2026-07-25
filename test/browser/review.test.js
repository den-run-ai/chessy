/* Read-only Review: archived-game list, position browser, game-over
 * handoff by game UUID, and the live-clock guard rails around it. */
'use strict';
const fs = require('fs');
require('./helper').run('review', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  check(await page.locator('#tabPlay').count() === 1 && await page.locator('#tabReview').count() === 1,
    'Play and Review section tabs');
  check(await page.getAttribute('#tabPlay', 'aria-current') === 'page', 'Play tab current at boot');

  // Finish a game, then "Review game" hands off to the archived record.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'Review game opens the archived record in the coaching review');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewBack',
    'the asynchronous handoff moves focus into the review flow');

  // Save the SELECTED archived game, not a closure over Play's live state.
  // The clean Review export deliberately has no "+ log" control: archive rows
  // do not retain the AI search telemetry needed to reproduce that file.
  check(await page.locator('#reviewExportPgn').isVisible(),
    'an opened archived game offers a Save PGN action');
  const [reviewDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#reviewExportPgn')
  ]);
  const reviewPgn = fs.readFileSync(await reviewDownload.path(), 'utf8');
  check(/\.pgn$/.test(reviewDownload.suggestedFilename()) &&
        reviewPgn.includes('[White "Human"]') &&
        reviewPgn.includes('[Black "Human"]') &&
        reviewPgn.includes('[TimeControl "-"]'),
    'Review downloads a named PGN with reconstructed Play metadata');
  check(reviewPgn.includes('[Result "0-1"]') &&
        reviewPgn.includes('1. f3 e5 2. g4 Qh4# {checkmate} 0-1'),
    'Review exports the complete selected game and its archived result');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewExportPgn',
    'saving keeps keyboard focus on the visible Review action');

  // Browse position by position.
  check((await page.textContent('#reviewStatus')).includes('played here: f3'),
    'position browser shows the move played here');
  check(await page.locator('#revStart').isDisabled(), 'Start disabled at ply 0');
  await page.click('#revNext');
  check((await page.textContent('#reviewStatus')).includes('Position 1/4') &&
        (await page.textContent('#reviewStatus')).includes('Black to move'),
    'Next steps forward and tracks the side to move');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('end of game'), 'End reaches the final position');
  check(await page.locator('#revNext').isDisabled(), 'Next disabled at the end');
  // The final checkmate position keeps the Play board's check semantics:
  // highlighted king, "in check" in its ARIA label, and the status line.
  check((await page.textContent('#reviewStatus')).includes('(in check)'),
    'the checkmate final position reports check in the status');
  check(await page.locator('#reviewBoard .square.check').count() === 1 &&
        (await page.getAttribute('#reviewBoard .square.check', 'aria-label')).includes('in check'),
    'the review board highlights and announces the checked king');
  await page.click('#revPrev');
  check((await page.textContent('#reviewStatus')).includes('played here: Qh4'),
    'Prev steps back to the last decision');
  await page.click('#reviewBack');
  await page.waitForSelector('.game-item');
  check(await page.locator('#reviewFlow').isHidden(), 'Back returns to the game list');
  check(await page.locator('#reviewExportPgn').isHidden(),
    'the per-game export action is hidden when no archived game is selected');
  await page.waitForFunction(function () {
    return document.activeElement && document.activeElement.className === 'game-item';
  });
  check(true, 'Back moves focus onto the game list (not left on a hidden button)');
  check((await page.textContent('.game-item')).includes('0-1') &&
        (await page.textContent('.game-item')).includes('Two players'),
    'game list shows result and mode');

  // Rematch → second entry; the list survives a reload.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#tabReview');
  check(await page.getAttribute('#tabReview', 'aria-current') === 'page', 'Review tab activates');
  check(await page.locator('#viewPlay').isHidden(), 'Play view hidden on Review tab');
  await page.waitForSelector('.game-item');
  check(await page.locator('.game-item').count() === 2, 'both archived games listed after reload');

  // Opening an archived game works from the list too.
  await page.locator('.game-item').first().click();
  check((await page.textContent('#reviewStatus')).includes('Position 0/4'),
    'list click opens the position browser');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'reviewBack',
    'opening from the list moves focus into the review flow');
  await page.click('#reviewBack');

  // A missing record (failed archive write) lands on the game list, not a
  // wrong game: simulate by handing off a nonexistent id.
  await page.evaluate(function () { return CoachReview.openArchivedGame('no-such-id'); });
  check(await page.locator('#reviewFlow').isHidden() &&
        await page.locator('#gameListWrap').isVisible(),
    'a missing record falls back to the game list');
  check(await page.evaluate(function () { return document.activeElement.id; }) === 'tabReview',
    'fallback still moves focus into Review');

  // A failed REPLACEMENT archive must not open the previous archived
  // ending of the same instance: after undo → replayed finish whose write
  // fails, "Review game" lands on the game list — the record on disk is
  // STALE, and opening it by gameId would show a wrong game.
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () { return Promise.reject(new Error('quota')); };
  });
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForSelector('.game-item'); // the list is cleared during the refresh
  check(await page.locator('#gameListWrap').isVisible() &&
        await page.locator('#reviewFlow').isHidden(),
    'a failed replacement archive lands on the game list, not the stale record');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });

  // Arrow keys drive the coach board / Play replay in their own views only:
  // in Review, pressing ArrowLeft must not rewind the Play replay view.
  await page.keyboard.press('ArrowLeft');
  await page.click('#tabPlay');
  check((await page.textContent('#status')).toLowerCase().indexOf('start position') === -1,
    'replay keys pressed in Review do not drive the Play board');

  // Play is undisturbed.
  check(await page.locator('#viewPlay').isVisible(), 'Play tab returns to the game');

  // A SLOW archive write must not let "Review game" yank the user away
  // after they have moved on: a new game started while the write is in
  // flight supersedes the queued handoff (the game stays reachable from
  // the Review list).
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      return new Promise(function (resolve) {
        window.__releaseArchive = function () {
          resolve(CoachStore.__realArchiveGame(rec));
        };
      });
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');        // handoff queued on the held write
  await t.newGame({ mode: 'pvp' });           // the user moves on
  await page.evaluate(function () { window.__releaseArchive(); });
  await page.waitForTimeout(300);             // let the stale handoff settle
  check(await page.locator('#viewPlay').isVisible() &&
        await page.locator('#viewReview').isHidden(),
    'a stale Review-game handoff does not override later navigation');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });

  // Intervening NAVIGATION alone (Review → back to Play, no new game)
  // also invalidates the queued handoff — landing back where the user
  // just chose to be and then yanking them to Review would be the same
  // surprise. (A generation counter, not a final-view check: the dialog
  // can legitimately open outside Play when a timed game flags there.)
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      return new Promise(function (resolve) {
        window.__releaseArchive = function () {
          resolve(CoachStore.__realArchiveGame(rec));
        };
      });
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');        // handoff queued on the held write
  await page.click('#tabReview');             // the user looks around…
  await page.click('#tabPlay');               // …and settles back in Play
  await page.evaluate(function () { window.__releaseArchive(); });
  await page.waitForTimeout(300);
  check(await page.locator('#viewPlay').isVisible() &&
        await page.locator('#viewReview').isHidden(),
    'a Review → Play round trip while the write settles also drops the handoff');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });

  // UNDO while the write settles also invalidates the handoff: the very
  // ending it would open is being taken back — yanking the user to
  // Review of the obsolete finish mid-edit would be worse than either
  // navigation case (gameId is unchanged and no view change fires).
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      return new Promise(function (resolve) {
        window.__releaseArchive = function () {
          resolve(CoachStore.__realArchiveGame(rec));
        };
      });
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');        // handoff queued on the held write
  await page.click('#undo');                  // the ending is taken back
  await page.evaluate(function () { window.__releaseArchive(); });
  await page.waitForTimeout(300);
  check(await page.locator('#viewPlay').isVisible() &&
        await page.locator('#viewReview').isHidden(),
    'Undo while the write settles drops the queued handoff');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });

  // The page-level archive failure note lives OUTSIDE the view
  // containers: a late failure shown after the user wandered into Review
  // must stay visible there, not vanish with the hidden Play view.
  await page.evaluate(function () {
    const el = document.getElementById('archiveBootNote');
    el.hidden = false;
    el.textContent = 'This game could not be archived (storage unavailable).';
  });
  await page.click('#tabReview');
  check(await page.locator('#archiveBootNote').isVisible(),
    'the archive failure note stays visible in the Review view');
  await page.click('#tabPlay');
  await page.evaluate(function () { document.getElementById('archiveBootNote').hidden = true; });

  // Entering Review clears the previous list SYNCHRONOUSLY: a revised
  // game's old button captured the obsolete record and must not stay
  // clickable while a slow archive read is in flight.
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');   // a rendered list to go stale
  await page.click('#tabPlay');
  await page.evaluate(function () {
    CoachStore.__realListGames = CoachStore.listGames;
    CoachStore.listGames = function () {
      return new Promise(function (resolve) {
        window.__releaseList = function () { resolve(CoachStore.__realListGames()); };
      });
    };
  });
  await page.click('#tabReview');
  check(await page.locator('.game-item').count() === 0,
    'entering Review clears stale game buttons before the archive read');
  await page.evaluate(function () { window.__releaseList(); });
  await page.waitForSelector('.game-item');
  check(true, 'the refreshed list arrives once the read settles');
  await page.evaluate(function () { CoachStore.listGames = CoachStore.__realListGames; });
  await page.click('#tabPlay');

  // An imported SetUp/FEN game replays and exports from its OWN initial
  // position, not the standard start. Start with Black on move 17 so the
  // download also proves custom-side/fullmove numbering.
  const setupFen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 17';
  await page.evaluate(function () {
    return CoachStore.putGame({
      id: 'setup-game', source: 'import',
      tags: {
        Event: 'Quoted "event" \\ path',
        White: 'Alice', Black: 'Bob', Result: '0-1',
        SetUp: '0', FEN: 'not the archived setup'
      },
      setupFen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 17',
      preComment: 'Start here',
      sans: ['Ke7', 'e4'],
      moves: [
        { san: 'Ke7', nags: ['$1'], comment: 'Only move' },
        { san: 'e4', nags: ['$6'], comment: '[%clk 0:04:58]' }
      ],
      playerColor: null, clocks: [null, { ms: 298000 }],
      result: '1-0', reason: 'resignation', mode: 'import', difficulty: null,
      timeControl: 'unknown', plies: 2, createdAt: Date.now() + 100000
    });
  });
  await page.evaluate(function () { return CoachReview.openArchivedGame('setup-game'); });
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/2') !== -1;
  });
  check(await page.locator('#reviewFlow').isVisible() &&
        (await page.textContent('#reviewStatus')).includes('Black to move') &&
        (await page.textContent('#reviewStatus')).includes('played here: Ke7'),
    'a SetUp/FEN import replays from its custom initial position in Review');
  const [setupDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#reviewExportPgn')
  ]);
  const setupPgn = fs.readFileSync(await setupDownload.path(), 'utf8');
  const parsedSetup = await page.evaluate(function (text) {
    const parsed = ChessyPGN.parseGame(text);
    return {
      valid: parsed.valid,
      error: parsed.error,
      setupFen: parsed.setupFen,
      result: parsed.result,
      event: parsed.tags.Event,
      date: parsed.tags.Date,
      preComment: parsed.preComment,
      firstNags: parsed.moves[0] && parsed.moves[0].nags,
      firstComment: parsed.moves[0] && parsed.moves[0].comment,
      secondClock: parsed.moves[1] && parsed.moves[1].clkMs
    };
  }, setupPgn);
  check(setupPgn.includes('17... Ke7 $1 {Only move} 18. e4 $6') &&
        setupPgn.includes('[Result "1-0"]') &&
        !setupPgn.includes('1. f3 e5'),
    'export uses the selected archive, its move number and authoritative result—not Play');
  check(parsedSetup.valid && parsedSetup.setupFen === setupFen &&
        parsedSetup.result === '1-0' &&
        parsedSetup.event === 'Quoted "event" \\ path' &&
        parsedSetup.date === '????.??.??',
    'downloaded SetUp/FEN PGN reparses with its exact setup, result and escaped tags',
    parsedSetup.error);
  check(parsedSetup.preComment === 'Start here' &&
        parsedSetup.firstNags.indexOf('$1') !== -1 &&
        parsedSetup.firstComment === 'Only move' &&
        parsedSetup.secondClock === 298000,
    'Review export preserves imported comments, NAGs and clock annotations');
  await page.click('#revEnd');
  check((await page.textContent('#reviewStatus')).includes('Position 2/2') &&
        (await page.textContent('#reviewStatus')).includes('end of game'),
    'the SetUp/FEN game browses through to its end');
  await page.click('#reviewBack');
  await page.click('#tabPlay');
});
