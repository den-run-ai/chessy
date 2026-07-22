/* Phase 4b — the Review data controls: PGN import from the UI, and
 * JSON backup / atomic restore / fenced delete-all over the whole archive. */
'use strict';
require('./helper').run('data', async function (t) {
  const page = t.page, check = t.check;

  async function importCount() {
    return page.evaluate(function () {
      return CoachStore.listGames().then(function (gs) {
        return gs.filter(function (g) { return g.source === 'import'; }).length;
      });
    });
  }

  await page.click('#tabReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  // Open both disclosure panels for the run.
  await page.evaluate(function () {
    document.getElementById('importDetails').open = true;
    document.getElementById('dataDetails').open = true;
  });

  // --- Import a valid PGN through the UI ---
  const pgn = '[Event "T"]\n[White "Me"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0';
  await page.fill('#importPgn', pgn);
  await page.check('input[name="importSide"][value="w"]');
  await page.click('#importBtn');
  await page.waitForFunction(function () {
    const e = document.getElementById('importStatus');
    return e && !e.hidden && e.textContent.indexOf('Imported') !== -1;
  });
  check(await importCount() === 1, 'a valid PGN imports one game through the UI');
  check((await page.locator('.game-item').count()) >= 1, 'the imported game appears in the list');
  check(await page.evaluate(function () {
    return CoachStore.listGames().then(function (gs) {
      const g = gs.find(function (x) { return x.source === 'import'; });
      return g && g.playerColor === 'w' && g.moves[0].uci === 'e2e4';
    });
  }), 'the imported record carries the chosen side and canonical moves');

  // --- Re-import dedupes ---
  await page.fill('#importPgn', pgn);
  await page.check('input[name="importSide"][value="w"]');
  await page.click('#importBtn');
  await page.waitForFunction(function () {
    return document.getElementById('importStatus').textContent.indexOf('Already imported') !== -1;
  });
  check(await importCount() === 1, 'a repeated import is deduped to one game');

  // --- Invalid PGN writes nothing and says so ---
  await page.fill('#importPgn', '[Result "*"]\n\n1. e4 e5 2. Kzz *');
  await page.click('#importBtn');
  await page.waitForFunction(function () {
    return document.getElementById('importStatus').textContent.indexOf('Could not import') !== -1;
  });
  check(await importCount() === 1, 'an invalid PGN adds no game');

  // --- Export → delete-all → restore round-trips every store ---
  const roundtrip = await page.evaluate(function () {
    return CoachStore.upsertCardByMoment({ gameId: 'data-card', ply: 0, lesson: 'keep me' },
      { createdAt: 1, attempts: [] })
      .then(function () { return CoachStore.putAnalysis({ key: 'k1', gameId: 'data-card', ply: 0, scoreCpWhite: 5 }); })
      .then(function () { return CoachStore.exportAll(); })
      .then(function (dump) {
        return CoachStore.deleteAll().then(function () {
          return CoachStore.listGames().then(function (g) {
            return CoachStore.listCards().then(function (c) {
              return { dump: dump, emptyGames: g.length, emptyCards: c.length };
            });
          });
        });
      })
      .then(function (s) {
        return CoachStore.restoreAll(s.dump).then(function () {
          return Promise.all([CoachStore.listGames(), CoachStore.listCards(),
            CoachStore.listAnalysesForGame('data-card')]).then(function (r) {
            return { dumpGames: s.dump.games.length, dumpCards: s.dump.cards.length,
              emptyGames: s.emptyGames, emptyCards: s.emptyCards,
              gamesAfter: r[0].length, cardsAfter: r[1].length, analysesAfter: r[2].length };
          });
        });
      });
  });
  check(roundtrip.emptyGames === 0 && roundtrip.emptyCards === 0,
    'delete-all clears every store');
  check(roundtrip.gamesAfter === roundtrip.dumpGames && roundtrip.cardsAfter === roundtrip.dumpCards &&
    roundtrip.analysesAfter === 1,
    'restore brings back games, cards and analyses exactly');

  // --- An invalid backup is rejected atomically (no data change) ---
  const badRestore = await page.evaluate(function () {
    return CoachStore.listGames().then(function (before) {
      return CoachStore.restoreAll({ games: 'nope' })
        .then(function () { return { err: null }; }, function (e) { return { err: String(e.message || e) }; })
        .then(function (res) {
          return CoachStore.listGames().then(function (after) {
            return { err: res.err, before: before.length, after: after.length };
          });
        });
    });
  });
  check(!!badRestore.err && badRestore.before === badRestore.after,
    'an invalid backup is rejected and changes nothing');

  // --- Fenced delete: cancel keeps data, confirm clears it ---
  await page.click('#deleteData');
  check(await page.locator('#deleteConfirm').isVisible(), 'delete asks for confirmation first');
  await page.click('#deleteCancel');
  check(await page.locator('#deleteConfirm').isHidden(), 'cancel backs out of the delete');
  check((await page.evaluate(function () { return CoachStore.listGames(); })).length > 0,
    'cancelling delete keeps the data');
  await page.click('#deleteData');
  await page.click('#deleteConfirmBtn');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  });
  check((await page.evaluate(function () { return CoachStore.listGames(); })).length === 0 &&
    (await page.evaluate(function () { return CoachStore.listCards(); })).length === 0,
    'confirming delete clears all training data');
});
