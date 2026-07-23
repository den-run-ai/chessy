/*
 * Archive data controls (roadmap #23, Phase 4b2 — export). "Back up (JSON)"
 * downloads a versioned snapshot of the DURABLE archive (games + cards);
 * recomputable engine caches (analyses / analysisJobs) are omitted.
 * Restore (4b3) and fenced Delete-all (4b4) add their own suites.
 */
'use strict';
const fs = require('fs');
require('./helper').run('data-controls', async function (t) {
  const page = t.page, check = t.check;

  // Seed two imported games, a lesson card, and an analysis (which must NOT
  // appear in the backup — it is recomputable).
  await page.evaluate(function () {
    const a = ChessyPGN.toRecord(ChessyPGN.parseGame('1. e4 e5 2. Nf3 Nc6 *'), { playerColor: 'w' });
    const b = ChessyPGN.toRecord(ChessyPGN.parseGame('1. d4 d5 *'), { playerColor: 'b' });
    return CoachStore.importGame(a).then(function () { return CoachStore.importGame(b); })
      .then(function () { return CoachStore.addCard({ gameId: a.id, ply: 2, cause: 'test', due: 1, attempts: [] }); })
      .then(function () {
        return CoachStore.putAnalysis({ key: 'k1', gameId: a.id, ply: 2, gameRev: 'x',
          fingerprint: 'f', engineId: 'chessy', configHash: 'c', complete: true,
          result: { bestLines: [] }, createdAt: 1 });
      });
  });

  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#backupBtn')
  ]);
  const backupJson = fs.readFileSync(await download.path(), 'utf8');
  let backup = null;
  try { backup = JSON.parse(backupJson); } catch (e) { /* asserted below */ }

  check(/\.json$/.test(download.suggestedFilename()), 'the backup downloads as a .json file');
  check(backup && backup.format === 'chessy-coach-backup' && backup.version === 1 &&
    typeof backup.dbVersion === 'number', 'the backup is format-tagged and versioned');
  check(backup && backup.stores.games.length === 2 && backup.stores.cards.length === 1,
    'the backup contains the durable games and cards');
  check(backup && backup.stores.analyses === undefined && backup.stores.analysisJobs === undefined,
    'recomputable analyses / jobs are omitted from the backup');
  check(/Backed up 2 games and 1 card/.test(await page.$eval('#dataStatus', function (e) { return e.textContent; })),
    'the status reports what was backed up');

  // A finished game recoverable ONLY from the durability queue (its IndexedDB
  // write failed) must still be included in the backup, not silently dropped.
  await page.evaluate(function () {
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      parked: { w: 't', rec: { id: 'parked', source: 'play', sans: ['e4', 'e5'],
        result: '*', reason: 'imported', mode: 'pvp', plies: 2, createdAt: 5 } }
    }));
  });
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup2 = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'));
  check(backup2.stores.games.length === 3 &&
        backup2.stores.games.some(function (g) { return g.id === 'parked'; }),
    'a parked (pending-queue) game is included in the backup');
});
