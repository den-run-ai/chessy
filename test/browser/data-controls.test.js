/*
 * Archive data controls (roadmap #23, Phase 4b2/4b3). "Back up (JSON)"
 * downloads a versioned snapshot of the DURABLE archive (games + cards);
 * recomputable engine caches (analyses / analysisJobs) are omitted. Restore
 * replaces the archive atomically from a validated backup and fences its
 * recovery sources by ENDING SIGNATURE, clearing the derived caches too.
 * Covers the validation gates (numeric version, game metadata, card fenBefore,
 * structural setup FEN), the sync-abort atomicity, the suspend-during-replace
 * guard, and that a revised ending of the same game instance is not fenced.
 * Fenced Delete-all (4b4) has its own suite.
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
      .then(function () { return CoachStore.addCard({ gameId: a.id, ply: 2, cause: 'test', due: 1, step: -1, attempts: [],
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        playedSan: 'e5', bestSan: 'e5', bestMove: { from: 52, to: 36, promotion: null } }); })
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

  // Backup still reads the raw durability queue when archive.js is absent
  // (partial offline release), honours the persisted ending fence without the
  // archive helper, and keeps prototype-sensitive ids as data.
  await page.evaluate(function () {
    ChessyArchive.fenceEnding(
      'raw-fenced', ['Nf3'], '*', 'imported');
    window.__archiveForBackup = window.ChessyArchive;
    window.ChessyArchive = undefined;
    const map = Object.create(null);
    map['raw-only'] = { w: 't1', rec: { id: 'raw-only', source: 'play',
      sans: ['d4'], result: '*', reason: 'imported', mode: 'pvp',
      plies: 1, createdAt: 6 } };
    map['__proto__'] = { w: 't2', rec: { id: '__proto__', source: 'play',
      sans: ['c4'], result: '*', reason: 'imported', mode: 'pvp',
      plies: 1, createdAt: 7 } };
    map['raw-fenced'] = { w: 't3', rec: { id: 'raw-fenced', source: 'play',
      sans: ['Nf3'], result: '*', reason: 'imported', mode: 'pvp',
      plies: 1, createdAt: 8 } };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
  });
  const [rawDl] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const rawBackup = JSON.parse(fs.readFileSync(await rawDl.path(), 'utf8'));
  check(rawBackup.stores.games.some(function (g) { return g.id === 'raw-only'; }),
    'backup includes a raw pending record when ChessyArchive is unavailable');
  check(rawBackup.stores.games.some(function (g) { return g.id === '__proto__'; }),
    'backup round-trips a prototype-sensitive game id');
  check(!rawBackup.stores.games.some(function (g) { return g.id === 'raw-fenced'; }),
    'backup excludes a fenced raw pending record when ChessyArchive is unavailable');
  await page.evaluate(function () {
    window.ChessyArchive = window.__archiveForBackup;
    delete window.__archiveForBackup;
    localStorage.removeItem('chessy-pending-archive-v1');
    localStorage.removeItem('chessy-archive-fenced-v1');
  });

  // An unreadable queue is unknown, not empty: fail the backup rather than
  // claim success while potentially omitting its only finished game.
  await page.evaluate(function () {
    const realGet = Storage.prototype.getItem;
    window.__restorePendingRead = function () {
      Storage.prototype.getItem = realGet;
      delete window.__restorePendingRead;
    };
    Storage.prototype.getItem = function (key) {
      if (key === 'chessy-pending-archive-v1') throw new Error('blocked');
      return realGet.call(this, key);
    };
    document.getElementById('backupBtn').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').dataset.kind === 'error';
  }, { timeout: 5000 });
  check(/pending-game recovery queue/.test(await page.textContent('#dataStatus')),
    'backup fails safely when the pending recovery queue cannot be read');
  await page.evaluate(function () { window.__restorePendingRead(); });

  // An unreadable fence is likewise unknown, not empty. With a recoverable
  // parked ending present, fail rather than exporting a possibly-cleared game.
  await page.evaluate(function () {
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'fence-unknown': { w: 't', rec: { id: 'fence-unknown', source: 'play',
        sans: ['e4'], result: '*', reason: 'imported', mode: 'pvp',
        plies: 1, createdAt: 8 } }
    }));
    const realGet = Storage.prototype.getItem;
    window.__restoreFenceRead = function () {
      Storage.prototype.getItem = realGet;
      delete window.__restoreFenceRead;
    };
    Storage.prototype.getItem = function (key) {
      if (key === 'chessy-archive-fenced-v1') throw new Error('blocked');
      return realGet.call(this, key);
    };
    document.getElementById('backupBtn').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').dataset.kind === 'error' &&
      document.getElementById('dataStatus').textContent.indexOf('archive-clear fence') !== -1;
  }, { timeout: 5000 });
  check(/archive-clear fence/.test(await page.textContent('#dataStatus')),
    'backup fails safely when the persisted ending fence cannot be read');
  await page.evaluate(function () {
    window.__restoreFenceRead();
    localStorage.removeItem('chessy-pending-archive-v1');
  });

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
  // ---- Restore replaces the archive from a validated backup (UI path). ----
  // Add another game and a PARKED durability-queue entry, then restore the
  // 2-game backup: the extra games go, and the parked ending is fenced. (The
  // backup-merge tests above left a few extra imported games, so assert the
  // archive is replaced DOWN to the backup rather than a fixed pre-count.)
  await page.evaluate(function () {
    localStorage.removeItem('chessy-game-v1'); // clear the reconstructed-save fixtures above
    localStorage.setItem('chessy-pending-archive-v1',
      JSON.stringify({ ghost: { w: 't', rec: { id: 'ghost', sans: [], result: '*', reason: 'imported' } } }));
    return CoachStore.importGame(ChessyPGN.toRecord(ChessyPGN.parseGame('1. f4 f5 *'), { playerColor: 'w' }));
  });
  check(await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); }) > 2,
    'extra games and a parked queue entry exist before restore');
  await page.setInputFiles('#restoreFile', {
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupJson)
  });
  await page.waitForSelector('#restoreConfirmDialog[open]', { timeout: 5000 });
  check(/2 games/.test(await page.$eval('#restoreConfirmText', function (e) { return e.textContent; })),
    'the restore confirm previews what will be replaced');
  await page.click('#restoreConfirm');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('Restored') !== -1;
  }, { timeout: 5000 });
  const restored = await page.evaluate(function () {
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (r) {
      return { g: r[0].length, c: r[1].length,
        pending: localStorage.getItem('chessy-pending-archive-v1'),
        ghostFenced: ChessyArchive.isFencedEnding('ghost', [], '*', 'imported') };
    });
  });
  check(restored.g === 2 && restored.c === 1,
    'restore replaces the archive with the backup (third game removed)');
  check(restored.pending === null && restored.ghostFenced === true,
    'restore fences recovery: the durability queue is dropped and its parked ending is fenced');

  // ---- P1: a SYNCHRONOUS enqueue failure aborts the whole restore, leaving
  // the existing archive intact — the preceding clear() must not commit. ----
  const atomic = await page.evaluate(function () {
    // A record with full valid metadata (so it PASSES validateBackup) but a
    // function field that makes store.add() throw DataCloneError synchronously.
    const bad = { format: 'chessy-coach-backup', version: 1, dbVersion: 6,
      stores: { games: [{ id: 'boom', sans: [], result: '*', plies: 0, createdAt: 1,
        oops: function () {} }], cards: [] } };
    return CoachStore.listGames().then(function (before) {
      return CoachStore.restoreAll(bad).then(
        function () { return false; }, function () { return true; }
      ).then(function (threw) {
        return CoachStore.listGames().then(function (after) {
          return { threw: threw, before: before.length, after: after.length };
        });
      });
    });
  });
  check(atomic.threw && atomic.after === 2 && atomic.after === atomic.before,
    'a synchronous enqueue failure aborts the restore and leaves the archive intact');

  // ---- A backup from a NEWER format/schema is refused, with no change. ----
  const future = await page.evaluate(function () {
    const f = { format: 'chessy-coach-backup', version: 99, dbVersion: 6, stores: { games: [], cards: [] } };
    return CoachStore.restoreAll(f).then(function () { return 'restored'; }, function (e) { return e.message; })
      .then(function (msg) { return CoachStore.listGames().then(function (g) { return { msg: msg, count: g.length }; }); });
  });
  check(/newer app version/.test(future.msg) && future.count === 2,
    'a backup from a newer version is refused and changes nothing');

  // ---- An invalid file surfaces an error and writes nothing. ----
  await page.setInputFiles('#restoreFile', {
    name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json{')
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').dataset.kind === 'error';
  }, { timeout: 5000 });
  check(/not valid json/i.test(await page.$eval('#dataStatus', function (e) { return e.textContent; })),
    'a non-JSON restore file is rejected with no change');
  check(await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); }) === 2,
    'the archive is untouched after a bad restore file');

  // ---- A structurally-valid backup whose game cannot be REPLAYED (illegal
  // SAN) is rejected up front — the archive is never cleared for it. ----
  await page.setInputFiles('#restoreFile', {
    name: 'unplayable.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'chessy-coach-backup', version: 1, dbVersion: 6,
      stores: { games: [{ id: 'u', source: 'import', sans: ['e4', 'Zz9'], result: '*', mode: 'import',
        plies: 2, createdAt: 1 }], cards: [] } }))
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('unplayable') !== -1;
  }, { timeout: 5000 });
  check(await page.$eval('#restoreConfirmDialog', function (d) { return !d.open; }),
    'an unreplayable backup never opens the confirm dialog');
  check(await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); }) === 2,
    'an unreplayable backup leaves the archive untouched (no destructive clear)');

  // ---- validateBackup: metadata that Review/Train dereference is REQUIRED, so
  // a structurally-thin backup can't erase the archive and then render broken.
  const rejects = await page.evaluate(function () {
    const F = 'chessy-coach-backup';
    const cases = {
      // A truncated file with only the format tag + empty stores (no version).
      noVersion: { format: F, stores: { games: [], cards: [] } },
      // A game missing result / plies / createdAt (Review would show
      // "undefined", "NaN moves", "Invalid Date").
      thinGame: { format: F, version: 1, dbVersion: 6,
        stores: { games: [{ id: 'g', sans: [] }], cards: [] } },
      // A card whose fenBefore is unparseable (Train's Chess.parseFen chokes,
      // dropping the whole training load).
      badCardFen: { format: F, version: 1, dbVersion: 6,
        stores: { games: [], cards: [{ id: 1, gameId: 'g', due: 0, fenBefore: 'bad' }] } }
    };
    const out = {};
    Object.keys(cases).forEach(function (k) { out[k] = CoachStore.validateBackup(cases[k]); });
    return out;
  });
  check(!!rejects.noVersion, 'a backup with no numeric version is rejected');
  check(!!rejects.thinGame, 'a game missing result/plies/createdAt is rejected');
  check(!!rejects.badCardFen, 'a card with an unparseable fenBefore is rejected');

  // A structurally-invalid setupFen is rejected by store validation even when
  // the optional PGN module is unavailable.
  await page.evaluate(function () {
    window.__savedChessyPGN = window.ChessyPGN;
    window.ChessyPGN = undefined;
  });
  await page.setInputFiles('#restoreFile', {
    name: 'badfen.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'chessy-coach-backup', version: 1, dbVersion: 6,
      stores: { games: [{ id: 'bf', source: 'import', sans: [], setupFen: 'bad', result: '*',
        mode: 'import', plies: 0, createdAt: 1 }], cards: [] } }))
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('invalid setupFen') !== -1;
  }, { timeout: 5000 });
  await page.evaluate(function () {
    window.ChessyPGN = window.__savedChessyPGN;
    delete window.__savedChessyPGN;
  });
  check(await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); }) === 2,
    'store-side FEN validation works without pgn.js and leaves the archive untouched');

  // ---- Restore clears the recomputable caches (analyses + jobs) in the SAME
  // transaction, so orphaned engine data for removed games can't hoard quota.
  const caches = await page.evaluate(function () {
    return CoachStore.putAnalysis({ key: 'orphan', gameId: 'gone', ply: 1, gameRev: 'x',
      fingerprint: 'f', engineId: 'chessy', configHash: 'c', complete: true,
      result: { bestLines: [] }, createdAt: 1 })
      .then(function () { return CoachStore.putJob({ gameId: 'gone', state: 'paused', cursorPly: 0, moments: [] }); })
      .then(function () {
        return CoachStore.restoreAll({ format: 'chessy-coach-backup', version: 1, dbVersion: 6,
          stores: { games: [], cards: [] } });
      })
      .then(function () {
        return Promise.all([CoachStore.getAnalysis('orphan'), CoachStore.getJob('gone')]);
      });
  });
  check(caches[0] === undefined && caches[1] === undefined,
    'restore clears orphaned analyses and jobs in the same atomic transaction');

  // ---- Ending-signature fence: a REVISED ending of the same game instance
  // (same id, different moves) is NOT fenced, so an Undo → different finish
  // still archives; the exact fenced ending stays fenced.
  const revised = await page.evaluate(function () {
    ChessyArchive.fenceEnding('u1', ['e4', 'e5'], '1-0', 'checkmate');
    return {
      same: ChessyArchive.isFencedEnding('u1', ['e4', 'e5'], '1-0', 'checkmate'),
      revised: ChessyArchive.isFencedEnding('u1', ['e4', 'e5', 'Nf3'], '0-1', 'resignation')
    };
  });
  check(revised.same === true, 'the exact cleared ending stays fenced');
  check(revised.revised === false, 'a revised ending of the same game instance is not fenced');

  // ---- Suspend: while a destructive replace is in flight, a live game that
  // finishes must NOT land on top of it — but it must be PARKED (not dropped)
  // so a FAILED operation doesn't permanently lose it.
  const suspended = await page.evaluate(function () {
    localStorage.removeItem('chessy-pending-archive-v1');
    ChessyArchive.setSuspended(true);
    const st = { over: true, result: '1-0', reason: 'checkmate' };
    return ChessyArchive.record({ history: [{ san: 'e4' }] }, { mode: 'pvp' }, st, 'live-during-op', {})
      .then(function (id) {
        ChessyArchive.setSuspended(false);
        const q = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || '{}');
        return { id: id, parked: !!q['live-during-op'] };
      });
  });
  check(suspended.id === null, 'a live game finishing during a suspended replace is not committed');
  check(suspended.parked === true,
    'the suspended finish is PARKED, so a failed operation does not lose it');

  // Reference-counted suspension: writes resume only when the LAST overlapping
  // operation ends, never after the first of two.
  const refcounted = await page.evaluate(function () {
    ChessyArchive.setSuspended(true);
    ChessyArchive.setSuspended(true);   // two operations
    const a = ChessyArchive.operationActive();
    ChessyArchive.setSuspended(false);  // first ends
    const b = ChessyArchive.operationActive();
    ChessyArchive.setSuspended(false);  // second ends
    const c = ChessyArchive.operationActive();
    return { a: a, b: b, c: c };
  });
  check(refcounted.a === true && refcounted.b === true && refcounted.c === false,
    'suspension is reference-counted across overlapping operations');

  // ---- validateBackup: array-valued stores and non-array card attempts are
  // rejected before the destructive transaction.
  const moreRejects = await page.evaluate(function () {
    const F = 'chessy-coach-backup';
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const game = { id: 'g', sans: ['e4'], result: '*', plies: 1, createdAt: 1 };
    function card(step) {
      return { id: 1, gameId: 'g', ply: 0, due: 0, step: step,
        fenBefore: startFen, attempts: [] };
    }
    function backup(c, games) {
      return { format: F, version: 1, dbVersion: 6,
        stores: { games: games === undefined ? [game] : games, cards: [c] } };
    }
    return {
      arrayStores: CoachStore.validateBackup({ format: F, version: 1, dbVersion: 6, stores: [] }),
      badAttempts: CoachStore.validateBackup({ format: F, version: 1, dbVersion: 6, stores: {
        games: [], cards: [{ id: 1, gameId: 'g', due: 0, step: 0,
          fenBefore: startFen, attempts: {} }] } }),
      emptyStores: CoachStore.validateBackup({
        format: F, version: 1, dbVersion: 6, stores: {} }),
      noStep: CoachStore.validateBackup(backup(card(undefined))),
      fractionalStep: CoachStore.validateBackup(backup(card(0.5))),
      belowLadder: CoachStore.validateBackup(backup(card(-2))),
      aboveLadder: CoachStore.validateBackup(backup(card(6))),
      badAttemptEntry: CoachStore.validateBackup(backup(Object.assign(card(0), {
        attempts: [{ at: 'yesterday', correct: 'yes' }]
      }))),
      missingGame: CoachStore.validateBackup(backup(card(0), [])),
      missingPly: CoachStore.validateBackup(backup(Object.assign(card(0), { ply: 1 }))),
      learnStep: CoachStore.validateBackup(backup(card(-1))),
      lastDayStep: CoachStore.validateBackup(backup(card(5)))
    };
  });
  check(!!moreRejects.arrayStores, 'a backup whose stores is an array is rejected');
  check(!!moreRejects.badAttempts, 'a card with a non-array attempts is rejected');
  check(!!moreRejects.emptyStores, 'a backup missing the games/cards arrays is rejected');
  check(!!moreRejects.noStep && !!moreRejects.fractionalStep &&
      !!moreRejects.belowLadder && !!moreRejects.aboveLadder,
    'missing, fractional, and out-of-ladder card steps are rejected');
  check(!!moreRejects.badAttemptEntry,
    'malformed attempt entries are rejected before Progress reads them');
  check(!!moreRejects.missingGame && !!moreRejects.missingPly,
    'cards must reference a restored game and one of its played plies');
  check(moreRejects.learnStep === null && moreRejects.lastDayStep === null,
    'the supported -1 through 5 card steps remain valid');

  // All read-write entry points share the same destructive-operation barrier;
  // reads and the destructive transaction itself remain available.
  const locked = await page.evaluate(function () {
    function outcome(p) {
      return p.then(function () { return 'accepted'; }, function () { return 'rejected'; });
    }
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    CoachStore.setOpLock(true);
    return Promise.all([
      outcome(CoachStore.addCard({ gameId: 'locked', ply: 0, due: 0, step: -1,
        attempts: [], fenBefore: fen })),
      outcome(CoachStore.putAnalysis({ key: 'locked', gameId: 'locked', ply: 0 })),
      outcome(CoachStore.importGame({ id: 'locked-import', sans: [], result: '*', createdAt: 1 })),
      outcome(CoachStore.archiveGame({ id: 'locked-archive', sans: [], result: '*',
        reason: 'imported', createdAt: 1 })),
      outcome(CoachStore.gradeCard('missing', null, function (c) { return c; })),
      outcome(CoachStore.upsertCardByMoment({ gameId: 'locked', ply: 0 }, {
        due: 0, step: -1, attempts: [], fenBefore: fen
      }))
    ]).then(function (results) {
      CoachStore.setOpLock(false);
      return CoachStore.putAnalysis({ key: 'unlocked', gameId: 'g', ply: 0 })
        .then(function () { return results.concat('resumed'); });
    });
  });
  check(locked.slice(0, 6).every(function (v) { return v === 'rejected'; }),
    'direct and shared transaction write paths reject while the barrier is held');
  check(locked[6] === 'resumed', 'writes resume after the barrier is released');

  await page.setInputFiles('#restoreFile', {
    name: 'focus.json', mimeType: 'application/json', buffer: Buffer.from(backupJson)
  });
  await page.waitForSelector('#restoreConfirmDialog[open]', { timeout: 5000 });
  check(await page.evaluate(function () {
    return document.activeElement && document.activeElement.id === 'restoreCancel';
  }), 'Restore initially focuses Cancel, not Replace');
  await page.click('#restoreCancel');

  // ---- An oversized restore file is rejected before it is read.
  const beforeHuge = await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); });
  await page.setInputFiles('#restoreFile', {
    name: 'huge.json', mimeType: 'application/json',
    buffer: Buffer.alloc(32 * 1024 * 1024 + 1, 0x20) // 32 MB + 1, over the limit
  });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('too large') !== -1;
  }, { timeout: 5000 });
  check(await page.$eval('#restoreConfirmDialog', function (d) { return !d.open; }),
    'an oversized restore file never opens the confirm dialog');
  check(await page.evaluate(function () { return CoachStore.listGames().then(function (g) { return g.length; }); }) === beforeHuge,
    'an oversized restore file changes nothing');

  // ---- A fenced ending is excluded from a later backup: a game a restore
  // deliberately removed must not be silently carried back into an export.
  const fencedOut = await page.evaluate(function () {
    // A finished local save whose ending is already fenced.
    let s = Chess.newGameState();
    function play(f, t) {
      const legal = Chess.legalMoves(s);
      s = Chess.playMove(s, legal.find(function (x) { return Chess.sqName(x.from) === f && Chess.sqName(x.to) === t; }));
    }
    play('f2', 'f3'); play('e7', 'e5'); play('g2', 'g4'); play('d8', 'h4'); // fool's mate
    const sans = s.history.map(function (h) { return h.san; });
    ChessyArchive.fenceEnding('fenced-save', sans, '0-1', 'checkmate');
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: Chess.toFen(s), history: s.history, mode: 'pvp', gameId: 'fenced-save', endedAt: 7 }));
    localStorage.removeItem('chessy-pending-archive-v1');
    return CoachStore.exportAll().then(function (data) { return data; });
  });
  const [dlF] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const backupF = JSON.parse(fs.readFileSync(await dlF.path(), 'utf8'));
  check(!backupF.stores.games.some(function (g) { return g.id === 'fenced-save'; }),
    'a fenced ending is excluded from a later backup');

  // ---- Durable fencing confirmation: if the queue cannot be neutralized, a
  // successful restore reports a QUALIFIED success (not a clean one), so the
  // user knows a reload could resurrect the surviving recovery source.
  await page.evaluate(function () {
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'x', history: [], mode: 'pvp', gameId: 'gone', endedAt: 1 }));
    window.__realDrop = ChessyArchive.dropPendingQueue;
    ChessyArchive.dropPendingQueue = function () { return false; }; // simulate blocked removal
  });
  await page.setInputFiles('#restoreFile', {
    name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(backupJson)
  });
  await page.waitForSelector('#restoreConfirmDialog[open]', { timeout: 5000 });
  await page.click('#restoreConfirm');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('Restored') !== -1;
  }, { timeout: 5000 });
  const qualified = await page.evaluate(function () {
    ChessyArchive.dropPendingQueue = window.__realDrop;
    const el = document.getElementById('dataStatus');
    return { text: el.textContent, kind: el.dataset.kind };
  });
  check(/Reload once storage is available/.test(qualified.text) && qualified.kind === 'error',
    'a restore whose recovery could not be neutralized reports a qualified success');

  // ---- Mutex: a second restore is refused while the first is still in flight
  // (overlapping destructive operations would share one suspension and fence).
  await page.evaluate(function () {
    window.__realRestore = CoachStore.restoreAll;
    let resolve1;
    CoachStore.restoreAll = function () { return new Promise(function (r) { resolve1 = r; }); };
    window.__finish1 = function () { resolve1({ games: 0, cards: 0 }); };
  });
  await page.setInputFiles('#restoreFile', { name: 'a.json', mimeType: 'application/json', buffer: Buffer.from(backupJson) });
  await page.waitForSelector('#restoreConfirmDialog[open]', { timeout: 5000 });
  await page.click('#restoreConfirm'); // restore 1 → pending (deferred)
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('Restoring') !== -1;
  }, { timeout: 5000 });
  await page.setInputFiles('#restoreFile', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backupJson) });
  await page.waitForSelector('#restoreConfirmDialog[open]', { timeout: 5000 });
  await page.click('#restoreConfirm'); // restore 2 → must be refused
  check(/Another data operation/.test(await page.$eval('#dataStatus', function (e) { return e.textContent; })),
    'a second restore is refused while one is in flight');
  await page.evaluate(function () { window.__finish1(); CoachStore.restoreAll = window.__realRestore; });
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('Restored') !== -1;
  }, { timeout: 5000 });

  // ---- Review invalidation: resetToList force-closes an open game so a stale
  // review on a just-removed game can't keep taking Verify/Save actions.
  const closed = await page.evaluate(function () {
    return CoachStore.listGames().then(function (gs) {
      if (!gs.length) return { skipped: true };
      return Promise.resolve(CoachReview.openArchivedGame(gs[0].id)).then(function () {
        const wasOpen = !document.getElementById('reviewFlow').hidden;
        return Promise.resolve(CoachReview.resetToList()).then(function () {
          return { wasOpen: wasOpen, nowList: !document.getElementById('gameListWrap').hidden &&
            document.getElementById('reviewFlow').hidden };
        });
      });
    });
  });
  check(closed.skipped || (closed.wasOpen && closed.nowList),
    'resetToList force-closes an open review back to a fresh list');
});
