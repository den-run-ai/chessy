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
          CoachStore.putJob({
            gameId: 'rev', sourceRev: 'old-ending', analysisRev: 'old-analysis',
            state: 'done', checked: 4,
            pass: 2, cursorPly: 4, verifyIndex: 1,
            candidates: [{ ply: 1 }, { ply: 2 }, { ply: 3 }],
            shortlist: [{ ply: 1 }, { ply: 3 }],
            moments: [{ ply: 1 }, { ply: 3 }],
            unresolved: [1, { ply: 3 }],
            retry: { attempt: 1 }, error: 'temporary'
          }),
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
        function plies(name) {
          return (jb[name] || []).map(function (m) {
            return typeof m === 'number' ? m : m.ply;
          }).join(',');
        }
        return {
          analysisPlies: an.join(','),
          jobCursor: jb.cursorPly,
          candidates: plies('candidates'), shortlist: plies('shortlist'),
          moments: plies('moments'), unresolved: plies('unresolved'),
          jobState: jb.state, pass: jb.pass, verifyIndex: jb.verifyIndex,
          checked: jb.checked,
          sourceInvalid: jb.sourceRev === null && jb.analysisRev === null,
          transientCleared: !Object.prototype.hasOwnProperty.call(jb, 'retry') &&
            !Object.prototype.hasOwnProperty.call(jb, 'error'),
          cardCount: revCards.length
        };
      });
  });
  check(pruned.analysisPlies === '1',
    'a revised ending drops analyses at/after the divergence, keeps the shared prefix');
  check(pruned.jobCursor === 2 && pruned.candidates === '1' &&
        pruned.shortlist === '1' && pruned.moments === '1' &&
        pruned.unresolved === '1',
    'the scan job rewinds and prunes every ply-bearing list at the divergence');
  check(pruned.jobState === 'paused' && pruned.pass === 1 &&
        pruned.verifyIndex === 0 &&
        pruned.checked === 2 && pruned.sourceInvalid && pruned.transientCleared,
    'a revised game invalidates scan ownership and resets transient pass-2 state');
  check(pruned.cardCount === 0, 'the card flagged past the divergence is pruned too');

  // A checkpoint's source check and job put share one transaction. A same-id
  // replacement that wins serialization must reject the stale checkpoint
  // instead of receiving it after the revision transaction.
  const guarded = await page.evaluate(function () {
    const original = {
      id: 'guarded-job', source: 'play', tags: {}, sans: ['e4', 'e5'],
      playerColor: 'w', clocks: [null, null], result: '*', reason: '',
      mode: 'pvp', difficulty: '2', timeControl: 'none', plies: 2, createdAt: 1
    };
    return CoachStore.putGame(original)
      .then(function () {
        return CoachStore.putJobIfGame({
          gameId: original.id, state: 'paused', cursorPly: 1, moments: []
        }, original);
      })
      .then(function (first) {
        const revised = Object.assign({}, original, {
          sans: ['d4', 'd5'], createdAt: 2
        });
        return CoachStore.putGame(revised).then(function () {
          return CoachStore.putJobIfGame({
            gameId: original.id, state: 'done', cursorPly: 2, moments: []
          }, original).then(function (stale) {
            return CoachStore.getJob(original.id).then(function (job) {
              return { first: first, stale: stale, cursor: job.cursorPly, state: job.state };
            });
          });
        });
      });
  });
  check(guarded.first === true && guarded.stale === false &&
        guarded.cursor === 1 && guarded.state === 'paused',
    'an atomic source guard refuses a late checkpoint for a same-id replacement');

  // Corrupt/relic job shapes are recomputable cache state, not a reason to
  // abort the user-data transaction that archives a revised ending.
  const malformedJob = await page.evaluate(function () {
    function game(sans) {
      return { id: 'malformed-job', source: 'play', tags: {}, sans: sans,
        playerColor: 'both', clocks: sans.map(function () { return null; }),
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2',
        timeControl: 'none', plies: sans.length, createdAt: 1 };
    }
    return CoachStore.archiveGame(game(['e4', 'e5', 'Nf3']))
      .then(function () {
        return CoachStore.putJob({
          gameId: 'malformed-job', sourceRev: 'old', state: 'done',
          cursorPly: 'not-a-ply', verifyIndex: 9,
          candidates: {}, shortlist: 'bad', moments: { ply: 2 }, unresolved: false,
          retry: true, error: 'stale'
        });
      })
      .then(function () {
        // Diverges at ply 1. This must commit even though every list is malformed.
        return CoachStore.archiveGame(game(['e4', 'c5', 'Nf3']));
      })
      .then(function () {
        return Promise.all([
          CoachStore.getGame('malformed-job'),
          CoachStore.getJob('malformed-job')
        ]);
      })
      .then(function (r) {
        const job = r[1];
        return {
          gameSans: r[0].sans.join(','),
          arraysEmpty: ['candidates', 'shortlist', 'moments', 'unresolved']
            .every(function (name) {
              return Array.isArray(job[name]) && job[name].length === 0;
            }),
          cursor: job.cursorPly, state: job.state, pass: job.pass,
          verifyIndex: job.verifyIndex, sourceInvalid: job.sourceRev === null,
          transientCleared: !Object.prototype.hasOwnProperty.call(job, 'retry') &&
            !Object.prototype.hasOwnProperty.call(job, 'error')
        };
      });
  });
  check(malformedJob.gameSans === 'e4,c5,Nf3' && malformedJob.arraysEmpty,
    'malformed scan lists cannot abort a revised-game archive transaction');
  check(malformedJob.cursor === 1 && malformedJob.state === 'paused' &&
        malformedJob.pass === 1 && malformedJob.verifyIndex === 0 &&
        malformedJob.sourceInvalid && malformedJob.transientCleared,
    'a malformed scan job is reset to a safe pass-1 checkpoint');

  // Restore/Delete-all share cancelAnalysis(). It must invalidate the scan
  // generation before cancelling the shared worker, so the promise resolved by
  // cancel cannot checkpoint/restart against cleared data.
  await page.evaluate(function () {
    window.__scanCancelOrder = [];
    window.__hadMomentScan = Object.prototype.hasOwnProperty.call(window, 'ChessyMomentScan');
    window.__realMomentScan = window.ChessyMomentScan;
    window.__realAnalysisCancel = ChessyAnalysisService.cancel;
    window.ChessyMomentScan = {
      invalidate: function () { window.__scanCancelOrder.push('scan'); }
    };
    ChessyAnalysisService.cancel = function () { window.__scanCancelOrder.push('analysis'); };
  });
  await page.click('#tabReview');
  await page.waitForSelector('#gameListWrap:not([hidden])');
  // Navigating away from Play legitimately cancels foreground analysis. The
  // assertion below is specifically about the destructive operation's own
  // ordering, so start its trace after that navigation-side cancellation.
  await page.evaluate(function () { window.__scanCancelOrder.length = 0; });
  await page.click('#deleteAllBtn');
  await page.click('#deleteAllConfirm');
  await page.waitForFunction(function () {
    return document.getElementById('dataStatus').textContent.indexOf('deleted') !== -1;
  });
  const cancelOrder = await page.evaluate(function () {
    const order = window.__scanCancelOrder.slice();
    ChessyAnalysisService.cancel = window.__realAnalysisCancel;
    if (window.__hadMomentScan) window.ChessyMomentScan = window.__realMomentScan;
    else delete window.ChessyMomentScan;
    delete window.__scanCancelOrder;
    delete window.__hadMomentScan;
    delete window.__realMomentScan;
    delete window.__realAnalysisCancel;
    return order;
  });
  check(cancelOrder[0] === 'scan' && cancelOrder[1] === 'analysis',
    'destructive operations invalidate scan ownership before cancelling analysis');
});
