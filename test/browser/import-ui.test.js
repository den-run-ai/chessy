/*
 * PGN import dialog (roadmap #23, Phase 4b1): the Review-panel UI over the
 * already-tested parse/validate/importGame core (see import.test.js). Asserts
 * the transport + feedback contract:
 *  - a valid paste commits one game and shows it in the list;
 *  - a repeat paste is reported as a duplicate, never a second game;
 *  - an invalid paste writes nothing and explains why;
 *  - the player's side reaches the stored record (Unknown → null).
 */
'use strict';
require('./helper').run('import-ui', async function (t) {
  const page = t.page, check = t.check;

  const VALID = [
    '[Event "Test"]', '[White "Alice"]', '[Black "Bob"]', '[Result "1-0"]', '',
    '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0'
  ].join('\n');

  async function listCount() {
    return page.$$eval('#gameList button', function (els) { return els.length; });
  }
  async function dialogOpen() {
    return page.$eval('#importDialog', function (d) { return d.open === true; });
  }
  async function status() {
    return page.$eval('#importStatus', function (e) {
      return { text: e.textContent, kind: e.dataset.kind || '' };
    });
  }

  // Reach the Review list and open the dialog.
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  check(await listCount() === 0, 'the archive starts empty');
  check(await page.$eval('#importOpen', function (b) { return !b.hidden; }),
    'the Review list offers an Import PGN affordance');

  await page.click('#importOpen');
  check(await dialogOpen(), 'clicking Import opens the import dialog');

  // A valid paste, imported as White, commits exactly one game and closes.
  await page.fill('#importText', VALID);
  await page.click('input[name="importSide"][value="w"] + span');
  await page.click('#importSubmit');
  await page.waitForSelector('#importDialog:not([open])', { timeout: 5000 }).catch(function () {});
  check(!(await dialogOpen()), 'a valid import closes the dialog');
  check(await listCount() === 1, 'the imported game appears in the list');

  const stored = await page.evaluate(function () {
    return CoachStore.listGames().then(function (gs) {
      const g = gs.find(function (x) { return x.source === 'import'; });
      return g && { plies: g.plies, color: g.playerColor, firstUci: g.moves[0].uci };
    });
  });
  check(stored && stored.plies === 6 && stored.firstUci === 'e2e4',
    'the stored record carries the canonical moves');
  check(stored && stored.color === 'w', 'the chosen side (White) reaches the record');

  // Re-importing the same PGN is a duplicate: message shown, no second game,
  // dialog stays open so the message is seen.
  await page.click('#importOpen');
  await page.fill('#importText', VALID);
  await page.click('#importSubmit');
  await page.waitForFunction(function () {
    return document.getElementById('importStatus').textContent.indexOf('already') !== -1;
  }, { timeout: 5000 }).catch(function () {});
  const dup = await status();
  check(/already/i.test(dup.text) && await dialogOpen(),
    'a repeated import reports a duplicate and keeps the dialog open');
  check(await listCount() === 1, 'a duplicate import adds no second game');

  // An invalid paste writes nothing and explains itself.
  await page.fill('#importText', '[Result "*"]\n\n1. e4 e5 2. Kzz *');
  await page.click('#importSubmit');
  await page.waitForFunction(function () {
    return document.getElementById('importStatus').dataset.kind === 'error';
  }, { timeout: 5000 }).catch(function () {});
  const bad = await status();
  check(bad.kind === 'error' && /not a valid game|nothing was imported/i.test(bad.text),
    'an illegal move is reported as invalid');
  check(await listCount() === 1, 'a rejected import adds no game');

  // Unknown side leaves playerColor null (every ply stays flaggable).
  await page.fill('#importText', '[Event "Unk"]\n\n1. d4 d5 2. c4 e6 *');
  await page.click('input[name="importSide"][value="unknown"] + span');
  await page.click('#importSubmit');
  await page.waitForSelector('#importDialog:not([open])', { timeout: 5000 }).catch(function () {});
  const unknown = await page.evaluate(function () {
    return CoachStore.listGames().then(function (gs) {
      const g = gs.find(function (x) { return x.plies === 4; });
      return g ? g.playerColor : 'missing';
    });
  });
  check(unknown === null, 'Unknown side stores playerColor null');
  check(await listCount() === 2, 'the second valid import brings the list to two games');

  // The actual FILE-UPLOAD path (not only pasted text): choosing a .pgn file
  // reads it into the textarea, and Import commits it like a paste. Prior text
  // is cleared when a file is chosen, so the file — not stale content — is the
  // source of truth.
  await page.click('#importOpen');
  await page.fill('#importText', 'STALE typed content that must be discarded');
  // The checked side pill uses the AA-contrast dark accent, not #7fa650.
  const pillBg = await page.$eval('input[name="importSide"]:checked + span', function (s) {
    return getComputedStyle(s).backgroundColor;
  });
  check(pillBg === 'rgb(93, 122, 58)', 'the selected side pill uses the AA-contrast accent');
  await page.setInputFiles('#importFile', {
    name: 'game.pgn', mimeType: 'application/x-chess-pgn',
    buffer: Buffer.from('[Event "File"]\n\n1. c4 c5 2. g3 g6 *')
  });
  await page.waitForFunction(function () {
    return document.getElementById('importText').value.indexOf('c4') !== -1;
  }, { timeout: 5000 });
  check(!(await page.$eval('#importText', function (e) { return e.value; })).includes('STALE'),
    'choosing a file discards the prior typed text');
  await page.click('input[name="importSide"][value="b"] + span');
  check(!(await page.$eval('#importSubmit', function (b) { return b.disabled; })),
    'Import is enabled once the file finished reading');
  await page.click('#importSubmit');
  await page.waitForSelector('#importDialog:not([open])', { timeout: 5000 }).catch(function () {});
  check(await listCount() === 3, 'a game chosen via file upload imports');

  // A SetUp/FEN game reports the REAL board move number on error, not "move 1":
  // this position starts at move 20, White to move, with an illegal first ply.
  await page.click('#importOpen');
  await page.fill('#importText',
    '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 20"]\n\n20. Kzz *');
  await page.click('#importSubmit');
  await page.waitForFunction(function () {
    return document.getElementById('importStatus').dataset.kind === 'error';
  }, { timeout: 5000 }).catch(function () {});
  const setupErr = await status();
  check(/move 20/.test(setupErr.text),
    'a SetUp/FEN game reports the real move number (20), not move 1');
  // Error text uses the AA-contrast red, not the low-contrast --danger.
  const errColor = await page.$eval('#importStatus', function (e) {
    return getComputedStyle(e).color;
  });
  check(errColor === 'rgb(242, 139, 130)', 'the error status uses the AA-contrast colour');
  await page.click('#importCancel');
  check(!(await dialogOpen()), 'cancel closes the dialog');
  check(await listCount() === 3, 'a rejected SetUp/FEN import adds no game');
});
