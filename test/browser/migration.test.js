/* IndexedDB schema migration: the v5→v6 upgrade is NON-DESTRUCTIVE.
 *
 * v5 was the first RELEASED schema, so real users have shipped games and
 * lesson cards in it. The old upgrade code deleted every object store on
 * any version bump (safe only for the throwaway v1–v4 previews); v6 must
 * instead ADD the analyses + analysisJobs stores while leaving all v5 data
 * exactly where it is. This suite seeds a genuine v5 database from OUTSIDE
 * the app, then boots the app (which opens at v6) and checks nothing was
 * lost and the new stores work. */
'use strict';
require('./helper').run('migration', async function (t) {
  const page = t.page, check = t.check, url = t.url;

  // Raw-IDB helper: delete chessy-coach, then recreate it at version 5 with
  // the EXACT old schema (wipe-all + games + cards[due,gameId]) and seed a
  // game and a lesson card — the data a shipped v5 user would hold. Runs on
  // the app-less blank origin so the app's store.js (v6) can't open first.
  await page.goto(url + 'blank');
  await page.evaluate(function () {
    return new Promise(function (resolve, reject) {
      const del = indexedDB.deleteDatabase('chessy-coach');
      del.onblocked = del.onerror = del.onsuccess = function () {
        const req = indexedDB.open('chessy-coach', 5);
        req.onupgradeneeded = function () {
          const db = req.result;
          for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
          db.createObjectStore('games', { keyPath: 'id' });
          const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
          cards.createIndex('due', 'due');
          cards.createIndex('gameId', 'gameId');
        };
        req.onsuccess = function () {
          const db = req.result;
          const tr = db.transaction(['games', 'cards'], 'readwrite');
          tr.objectStore('games').put({
            id: 'v5-game', source: 'play', tags: {}, sans: ['e4', 'e5'],
            playerColor: 'w', clocks: [null, null], result: '1-0',
            reason: 'checkmate', mode: 'ai-b', difficulty: '2',
            timeControl: 'none', plies: 2, createdAt: 5000
          });
          tr.objectStore('cards').put({
            gameId: 'v5-game', ply: 0, lesson: 'preserved across the migration',
            cause: 'match', kind: 'match', due: 1000, step: -1,
            bestMove: { from: 52, to: 36, promotion: null },
            attempts: [{ at: 1, grade: 'good', correct: true }]
          });
          tr.oncomplete = function () { db.close(); resolve(); };
          tr.onerror = function () { reject(tr.error); };
        };
        req.onerror = function () { reject(req.error); };
      };
    });
  });

  // Boot the real app: its store.js opens chessy-coach at v6, triggering the
  // v5→v6 upgrade.
  await page.goto(url);
  await page.waitForSelector('#board .square');

  // The v5 game survived byte-for-byte.
  const game = await page.evaluate(function () { return CoachStore.getGame('v5-game'); });
  check(!!game && game.sans.join(' ') === 'e4 e5' && game.createdAt === 5000,
    'v5→v6: the shipped game survives the upgrade unchanged');

  // The v5 card survived, with its attempt history and working `due` index.
  const cards = await page.evaluate(function () { return CoachStore.listCards(); });
  check(cards.length === 1 && cards[0].lesson === 'preserved across the migration' &&
        cards[0].attempts.length === 1,
    'v5→v6: the shipped lesson card survives with its attempt history');
  const due = await page.evaluate(function () { return CoachStore.dueCards(2000); });
  check(due.length === 1 && due[0].gameId === 'v5-game',
    'v5→v6: the card indexes (due/gameId) survive and still resolve');

  // The database is now v6 and carries all four stores.
  const shape = await page.evaluate(function () {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open('chessy-coach');
      req.onsuccess = function () {
        const db = req.result;
        const names = Array.from(db.objectStoreNames).sort();
        const version = db.version;
        db.close();
        resolve({ version: version, names: names });
      };
      req.onerror = function () { reject(req.error); };
    });
  });
  check(shape.version === 6, 'the upgraded database reports version 6');
  check(shape.names.join(',') === 'analyses,analysisJobs,cards,games',
    'v6 adds the analyses + analysisJobs stores alongside the preserved games/cards');

  // The new stores are usable, and analysisKey folds in the fields that
  // change a result — the SAME FEN with a different repetition history is a
  // DISTINCT cache entry.
  const analyses = await page.evaluate(function () {
    const kA = CoachStore.analysisKey('v5-game', 3, 'FEN#repA', 'chessy', 'cfg1');
    const kB = CoachStore.analysisKey('v5-game', 3, 'FEN#repB', 'chessy', 'cfg1');
    return CoachStore.putAnalysis({ key: kA, gameId: 'v5-game', ply: 3, scoreCpWhite: 40 })
      .then(function () {
        return CoachStore.putAnalysis({ key: kB, gameId: 'v5-game', ply: 3, scoreCpWhite: 0 });
      })
      .then(function () { return CoachStore.getAnalysis(kA); })
      .then(function (a) {
        return CoachStore.listAnalysesForGame('v5-game').then(function (all) {
          return { distinct: kA !== kB, roundTrip: a && a.scoreCpWhite, count: all.length };
        });
      });
  });
  check(analyses.distinct && analyses.roundTrip === 40 && analyses.count === 2,
    'analyses round-trip; a differing repetition fingerprint is a distinct entry');

  const job = await page.evaluate(function () {
    return CoachStore.putJob({ gameId: 'v5-game', state: 'scanning', cursorPly: 2, moments: [] })
      .then(function () { return CoachStore.getJob('v5-game'); });
  });
  check(!!job && job.state === 'scanning' && job.cursorPly === 2,
    'analysisJobs round-trips a resumable scan record');

  // A FRESH install (no prior DB) creates all four stores from nothing —
  // the create-if-absent path must not depend on a preview having existed.
  const fresh = await page.evaluate(function () {
    return new Promise(function (resolve) {
      const del = indexedDB.deleteDatabase('chessy-coach');
      del.onblocked = del.onerror = del.onsuccess = function () { resolve(); };
    });
  });
  void fresh;
  const freshShape = await page.evaluate(function () {
    // First CoachStore call reopens the DB from nothing at v6.
    return CoachStore.putGame({ id: 'fresh', source: 'play', tags: {}, sans: [],
      playerColor: 'both', clocks: [], result: '1-0', reason: 'x', mode: 'pvp',
      difficulty: '1', timeControl: 'none', plies: 0, createdAt: 1 })
      .then(function () {
        return CoachStore.putAnalysis({ key: 'k', gameId: 'fresh', ply: 0, scoreCpWhite: 0 });
      })
      .then(function () { return CoachStore.putJob({ gameId: 'fresh', state: 'idle', cursorPly: 0, moments: [] }); })
      .then(function () {
        return new Promise(function (resolve, reject) {
          const req = indexedDB.open('chessy-coach');
          req.onsuccess = function () {
            const db = req.result;
            const out = { version: db.version, names: Array.from(db.objectStoreNames).sort().join(',') };
            db.close();
            resolve(out);
          };
          req.onerror = function () { reject(req.error); };
        });
      });
  });
  check(freshShape.version === 6 && freshShape.names === 'analyses,analysisJobs,cards,games',
    'a fresh install creates all four v6 stores from nothing');

  // Revising an archived ending prunes the derived data (cards, analyses,
  // scan job) from the FIRST DIVERGENT ply, leaving the shared prefix.
  const pruned = await page.evaluate(function () {
    const mk = function (sans) {
      return { id: 'rev', source: 'play', tags: {}, sans: sans,
        playerColor: 'both', clocks: sans.map(function () { return null; }),
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2',
        timeControl: 'none', plies: sans.length, createdAt: 1 };
    };
    return CoachStore.archiveGame(mk(['e4', 'e5', 'Nf3', 'Nc6']))
      .then(function () {
        return Promise.all([
          CoachStore.putAnalysis({ key: 'rev|1', gameId: 'rev', ply: 1, scoreCpWhite: 10 }),
          CoachStore.putAnalysis({ key: 'rev|3', gameId: 'rev', ply: 3, scoreCpWhite: 20 }),
          CoachStore.putJob({ gameId: 'rev', state: 'done', cursorPly: 4,
            moments: [{ ply: 1 }, { ply: 3 }] }),
          CoachStore.upsertCardByMoment({ gameId: 'rev', ply: 3, lesson: 'drop' },
            { createdAt: 1, attempts: [] })
        ]);
      })
      .then(function () { // revised ending diverges at ply 2
        return CoachStore.archiveGame(mk(['e4', 'e5', 'Bc4', 'Bc5']));
      })
      .then(function () {
        return Promise.all([
          CoachStore.listAnalysesForGame('rev'),
          CoachStore.getJob('rev'),
          CoachStore.listCards()
        ]);
      })
      .then(function (r) {
        const an = r[0].map(function (a) { return a.ply; }).sort();
        const jb = r[1];
        const revCards = r[2].filter(function (c) { return c.gameId === 'rev'; });
        return {
          analysisPlies: an.join(','),
          jobCursor: jb.cursorPly, jobMoments: jb.moments.map(function (m) { return m.ply; }).join(','),
          jobState: jb.state,
          cardCount: revCards.length
        };
      });
  });
  check(pruned.analysisPlies === '1',
    'a revised ending drops analyses at/after the divergence, keeps the shared prefix');
  check(pruned.jobCursor === 2 && pruned.jobMoments === '1' && pruned.jobState === 'paused',
    'the scan job rewinds its cursor to the divergence and drops later moments');
  check(pruned.cardCount === 0, 'the card flagged past the divergence is pruned too');
});
