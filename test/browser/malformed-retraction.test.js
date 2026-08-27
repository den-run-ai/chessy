/* A malformed Undo tombstone is still durable authority that its game may
 * have been withdrawn. Recovery must preserve it, attribute the failure,
 * suppress same-id archive/Review output, and make Backup fail closed while
 * unrelated queue entries continue to drain. */
'use strict';
require('./helper').run('malformed undo tombstones', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  await t.newGame({ mode: 'pvp', timeControl: 'none' });
  await mv('e2', 'e4');
  await page.click('#resign');
  await page.click('#endGameConfirm');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForFunction(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return saved && CoachStore.getGame(saved.gameId).then(function (rec) { return !!rec; });
  });

  const seed = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return CoachStore.getGame(saved.gameId).then(function (rec) {
      return { saved: saved, rec: rec };
    });
  });
  check(!!seed.rec && seed.rec.reason === 'resignation',
    'the fixture starts from a durably archived manual resignation');
  await page.click('#gameOverClose');

  const ending = {
    id: seed.rec.id,
    sans: seed.rec.sans,
    result: seed.rec.result,
    reason: seed.rec.reason
  };
  const variants = [
    {
      name: 'invalid reason',
      mutate: function (entry) { entry.ending.reason = 'damaged'; }
    },
    {
      name: 'missing SAN data',
      mutate: function (entry) { delete entry.ending.sans; }
    },
    {
      name: 'unexpected wrapper field',
      mutate: function (entry) { entry.unexpected = { retained: true }; }
    },
    {
      name: 'missing operation discriminator',
      mutate: function (entry) { delete entry.op; }
    },
    {
      name: 'missing writer token',
      mutate: function (entry) { delete entry.w; }
    },
    {
      name: 'wrong ending game id',
      mutate: function (entry) { entry.ending.id = 'other-game'; }
    },
    {
      name: 'invalid result',
      mutate: function (entry) { entry.ending.result = '*'; }
    },
    {
      name: 'unexpected ending field',
      mutate: function (entry) { entry.ending.unexpected = true; }
    },
    {
      name: 'missing ending object',
      mutate: function (entry) { delete entry.ending; }
    }
  ];

  for (let n = 0; n < variants.length; n++) {
    const variant = variants[n];
    const otherId = 'malformed-retraction-other-' + n;
    const entry = {
      w: 'w-malformed-' + n,
      op: 'retract',
      ending: {
        id: ending.id,
        sans: ending.sans.slice(),
        result: ending.result,
        reason: ending.reason
      }
    };
    variant.mutate(entry);
    const unrelated = {
      id: otherId, source: 'play', tags: {}, sans: ['d4'],
      playerColor: 'both', clocks: [null], ai: [null],
      result: '1-0', reason: 'resignation', mode: 'pvp', difficulty: '2',
      timeControl: 'none', plies: 1, createdAt: 9000 + n
    };

    // Start each mutation with no committed copy of the stale outcome. The
    // finished live save remains its tempting boot-rearchive source.
    await page.evaluate(function (expected) {
      return CoachStore.retractGameEnding(expected);
    }, ending);
    await t.inject(function (payload) {
      localStorage.setItem('chessy-game-v1', JSON.stringify(payload.saved));
      const map = {};
      map[payload.id] = payload.entry;
      map[payload.unrelated.id] = { w: 'w-unrelated-' + payload.n, rec: payload.unrelated };
      localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
    }, {
      saved: seed.saved,
      id: ending.id,
      entry: entry,
      unrelated: unrelated,
      n: n
    });

    await page.waitForFunction(function (payload) {
      return Promise.all([
        CoachStore.getGame(payload.id),
        CoachStore.getGame(payload.otherId)
      ]).then(function (rows) {
        const map = JSON.parse(
          localStorage.getItem('chessy-pending-archive-v1') || 'null');
        return !rows[0] && !!rows[1] && !!map && !!map[payload.id] && !map[payload.otherId];
      });
    }, { id: ending.id, otherId: otherId });
    await page.waitForSelector('#archiveBootNote:not([hidden])');

    const firstBoot = await page.evaluate(function (payload) {
      const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1'));
      const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
      return {
        exact: JSON.stringify(map[payload.id]) === JSON.stringify(payload.entry),
        reopened: saved && saved.manualEnding === null && saved.endedAt === null,
        warning: document.getElementById('archiveBootNote').textContent,
        warningVisible: !document.getElementById('archiveBootNote').hidden
      };
    }, { id: ending.id, entry: entry });
    check(firstBoot.exact,
      variant.name + ': the malformed tombstone is preserved losslessly after reload one');
    check(firstBoot.reopened,
      variant.name + ': boot reopens the withdrawn live result instead of rearchiving it');
    check(firstBoot.warningVisible &&
          firstBoot.warning.indexOf('archive recovery data is damaged') !== -1,
      variant.name + ': boot surfaces the blocked game\'s archive recovery warning');

    const reconcile = await page.evaluate(function (id) {
      return ChessyArchive.reconcilePending().then(
        function () { return { resolved: true, ids: [] }; },
        function (err) {
          return { resolved: false, ids: err.failedGameIds || [],
            malformed: !!err.malformedRetraction };
        });
    }, ending.id);
    check(!reconcile.resolved && reconcile.malformed &&
          reconcile.ids.length === 1 && reconcile.ids[0] === ending.id,
    variant.name + ': reconcile attributes the blocking failure to the affected game id');

    const direct = await page.evaluate(function (payload) {
      const state = {
        history: payload.sans.map(function (san) { return { san: san }; })
      };
      const settings = { mode: 'pvp', difficulty: '2', timeControl: 'none' };
      const status = { over: true, result: payload.result, reason: payload.reason };
      return ChessyArchive.record(state, settings, status, payload.id, {})
        .then(function () { return { rejected: false }; }, function (err) {
          return { rejected: true, ids: err.failedGameIds || [] };
        });
    }, ending);
    check(direct.rejected && direct.ids[0] === ending.id,
      variant.name + ': same-id archive writes are blocked without replacing the tombstone');

    await page.reload();
    await page.waitForSelector('#board .square');
    await page.waitForSelector('#archiveBootNote:not([hidden])');
    const secondBoot = await page.evaluate(function (payload) {
      const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1'));
      return CoachStore.getGame(payload.id).then(function (stale) {
        return {
          exact: JSON.stringify(map[payload.id]) === JSON.stringify(payload.entry),
          stale: !!stale,
          warningVisible: !document.getElementById('archiveBootNote').hidden
        };
      });
    }, { id: ending.id, entry: entry });
    check(secondBoot.exact && !secondBoot.stale && secondBoot.warningVisible,
      variant.name + ': reload two keeps the tombstone, warning, and no stale archive row');

    // Even if an old row lands out of order behind recovery, Review must hide
    // the blocked id. Backup refuses to advertise a complete snapshot while
    // the lossless tombstone cannot be interpreted.
    await page.evaluate(function (rec) { return CoachStore.archiveGame(rec); }, seed.rec);
    const review = await page.evaluate(function (id) {
      return CoachReview.openArchivedGame(id).then(function () {
        return {
          list: !document.getElementById('gameListWrap').hidden,
          flow: !document.getElementById('reviewFlow').hidden
        };
      });
    }, ending.id);
    check(review.list && !review.flow,
      variant.name + ': Review suppresses an out-of-order stale row with the blocked id');

    const unexpectedDownload = page.waitForEvent('download', { timeout: 1000 })
      .then(function () { return true; }, function () { return false; });
    await page.click('#backupBtn');
    await page.waitForFunction(function () {
      return document.getElementById('dataStatus').textContent.indexOf('Backup failed:') === 0;
    });
    const backupStatus = await page.textContent('#dataStatus');
    check(backupStatus.indexOf('pending-game recovery queue is malformed') !== -1,
      variant.name + ': Backup fails closed while the malformed tombstone is parked');
    check(!(await unexpectedDownload),
      variant.name + ': blocked Backup emits no partial download');
    check(await page.evaluate(function (payload) {
      const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1'));
      return JSON.stringify(map[payload.id]) === JSON.stringify(payload.entry);
    }, { id: ending.id, entry: entry }),
    variant.name + ': Review and Backup do not mutate the quarantined tombstone');
  }

  // If the whole queue cannot be decoded, no per-id classifier is available.
  // Preserve those bytes and quarantine every ending instead of deleting the
  // only possible withdrawal authority and guessing that rearchive is safe.
  await page.evaluate(function (expected) {
    return CoachStore.retractGameEnding(expected);
  }, ending);
  await t.inject(function (saved) {
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
    localStorage.setItem('chessy-pending-archive-v1', '{broken-json');
  }, seed.saved);
  await page.waitForSelector('#archiveBootNote:not([hidden])');
  check(await page.evaluate(function (id) {
    return CoachStore.getGame(id).then(function (stale) {
      return !stale &&
        localStorage.getItem('chessy-pending-archive-v1') === '{broken-json';
    });
  }, ending.id),
  'an unreadable whole queue is preserved and globally blocks stale rearchive');
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForSelector('#archiveBootNote:not([hidden])');
  check(await page.evaluate(function (id) {
    return CoachStore.getGame(id).then(function (stale) {
      return !stale &&
        localStorage.getItem('chessy-pending-archive-v1') === '{broken-json';
    });
  }, ending.id),
  'the unreadable whole-queue quarantine survives a second reload');
});
