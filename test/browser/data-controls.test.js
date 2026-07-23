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

  // A parked REVISION (same id as a committed row, but newer moves) is the
  // authoritative copy when its write failed, so it must REPLACE the stale
  // committed row in the backup, not be dropped as a duplicate id.
  const revId = await page.evaluate(function () {
    const g = ChessyPGN.toRecord(ChessyPGN.parseGame('1. e4 e5 *'), { playerColor: 'w' });
    return CoachStore.importGame(g).then(function () {
      const map = {};
      map[g.id] = { w: 't', rec: { id: g.id, source: 'play', sans: ['d4', 'd5', 'c4'],
        result: '1-0', reason: 'resignation', mode: 'pvp', plies: 3, createdAt: 9 } };
      localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
      return g.id;
    });
  });
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup3 = JSON.parse(fs.readFileSync(await dl3.path(), 'utf8'));
  const revved = backup3.stores.games.find(function (g) { return g.id === revId; });
  check(revved && revved.sans.join(',') === 'd4,d5,c4',
    'a parked revision replaces the stale committed row of the same id');

  // A finished game saved ONLY in chessy-game-v1 (not in IndexedDB, not parked)
  // is reconstructed into the backup, so an unrecomputable game is not dropped.
  await page.evaluate(function () {
    localStorage.removeItem('chessy-pending-archive-v1');
    let s = Chess.newGameState();
    function play(fromName, toName) {
      const legal = Chess.legalMoves(s);
      const m = legal.find(function (x) {
        return Chess.sqName(x.from) === fromName && Chess.sqName(x.to) === toName;
      });
      s = Chess.playMove(s, m);
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', difficulty: '2',
      timeControl: 'none', clocks: null, timeForfeit: null, flipped: false,
      gameId: 'only-in-save', endedAt: 42 }));
  });
  const [dl4] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup4 = JSON.parse(fs.readFileSync(await dl4.path(), 'utf8'));
  const onlySave = backup4.stores.games.find(function (g) { return g.id === 'only-in-save'; });
  check(onlySave && onlySave.result === '0-1' && onlySave.reason === 'checkmate' &&
        onlySave.sans.length === 4,
    'a finished game saved only in chessy-game-v1 is reconstructed into the backup');
  // An in-progress save is NOT archived, so it must not appear in the backup.
  await page.evaluate(function () {
    let s = Chess.newGameState();
    const legal = Chess.legalMoves(s);
    s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === 'e2'; }));
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'in-progress', endedAt: null }));
  });
  const [dl5] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup5 = JSON.parse(fs.readFileSync(await dl5.path(), 'utf8'));
  check(!backup5.stores.games.some(function (g) { return g.id === 'in-progress'; }),
    'an in-progress local save is not reconstructed into the backup');

  // Clear the local-save / queue fixtures before the merge-semantics cases.
  await page.evaluate(function () {
    localStorage.removeItem('chessy-game-v1');
    localStorage.removeItem('chessy-pending-archive-v1');
  });

  // IDENTICAL ending re-offered while parked: keep the committed row's EARLIER
  // completion time (archiveGame's same-ending rule), not the parked later one.
  const dateId = await page.evaluate(function () {
    const g = { id: 'date-x', source: 'play', sans: ['e4'], result: '*', reason: 'imported',
      mode: 'pvp', plies: 1, createdAt: 100 };
    return CoachStore.putGame(g).then(function () {
      localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
        'date-x': { w: 't', rec: { id: 'date-x', source: 'play', sans: ['e4'], result: '*',
          reason: 'imported', mode: 'pvp', plies: 1, createdAt: 200 } } }));
      return 'date-x';
    });
  });
  const [dl6] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup6 = JSON.parse(fs.readFileSync(await dl6.path(), 'utf8'));
  const dated = backup6.stores.games.find(function (g) { return g.id === dateId; });
  check(dated && dated.createdAt === 100,
    'an identical parked ending keeps the earliest committed completion time');

  // A parked REVISION prunes lesson cards from the abandoned continuation.
  await page.evaluate(function () {
    localStorage.removeItem('chessy-pending-archive-v1');
    const g = { id: 'rev-x', source: 'play', sans: ['e4', 'e5', 'Nf3'], result: '*', reason: 'imported',
      mode: 'pvp', plies: 3, createdAt: 1 };
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    return CoachStore.putGame(g)
      .then(function () { return CoachStore.addCard({ gameId: 'rev-x', ply: 1, cause: 't', due: 1, attempts: [], fenBefore: fen }); })
      .then(function () { return CoachStore.addCard({ gameId: 'rev-x', ply: 2, cause: 't', due: 1, attempts: [], fenBefore: fen }); })
      .then(function () {
        // Revision diverges at ply 1 (e4 → d4), so both cards (ply 1 and 2) prune.
        localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
          'rev-x': { w: 't', rec: { id: 'rev-x', source: 'play', sans: ['d4', 'd5'], result: '1-0',
            reason: 'resignation', mode: 'pvp', plies: 2, createdAt: 2 } } }));
      });
  });
  const [dl7] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup7 = JSON.parse(fs.readFileSync(await dl7.path(), 'utf8'));
  check(!backup7.stores.cards.some(function (c) { return c.gameId === 'rev-x'; }),
    'a parked revision prunes lesson cards from the abandoned continuation');

  // A finished local save that REVISES the committed game (no pending record —
  // archive.js failed to load, say) still wins over the stale committed row.
  await page.evaluate(function () {
    localStorage.removeItem('chessy-pending-archive-v1');
    let s = Chess.newGameState();
    function play(f, t) {
      const legal = Chess.legalMoves(s);
      s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate revision
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'save-rev', endedAt: 9 }));
    // Committed row for the SAME id holds an abandoned, different ending.
    return CoachStore.putGame({ id: 'save-rev', source: 'play', sans: ['e4', 'e5'], result: '*',
      reason: 'imported', mode: 'pvp', plies: 2, createdAt: 1 });
  });
  const [dl8] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backup8 = JSON.parse(fs.readFileSync(await dl8.path(), 'utf8'));
  const saveRev = backup8.stores.games.find(function (g) { return g.id === 'save-rev'; });
  check(saveRev && saveRev.result === '0-1' && saveRev.sans.length === 4,
    'a finished local save revising the committed game wins over the stale row');
});
