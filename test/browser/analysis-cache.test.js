/*
 * Bounded analyses cache (#82): the recomputable `analyses` store holds at
 * most policy.max entries; maintenance prunes the least-recently-used down
 * to policy.trimTo, deterministically (recency, then key), never touching
 * a protected fresh key, durable stores, or scan state — and the app runs
 * one such pass per boot.
 */
'use strict';
require('./helper').run('analysis-cache', async function (t) {
  const page = t.page, check = t.check;

  const policy = await page.evaluate(function () {
    return CoachStore.analysesCachePolicy();
  });
  check(!!policy && Number.isInteger(policy.max) && Number.isInteger(policy.trimTo) &&
    policy.trimTo < policy.max && policy.trimTo > 0,
    'the cache policy is published (max ' + policy.max + ', trim to ' + policy.trimTo + ')');

  // Durable rows that must survive every pruning scenario below, plus a
  // resumable-scan job (recomputable, but pruning must still not touch it).
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.putGame({
      id: 'gd', source: 'play', tags: {}, sans: ['f3', 'e5', 'g4', 'Qh4#'],
      playerColor: 'both', clocks: [null, null, null, null], result: '0-1',
      reason: 'checkmate', mode: 'pvp', difficulty: '2', timeControl: 'none',
      plies: 4, createdAt: now
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'gd', ply: 3, fenBefore: 'x', playedSan: 'Qh4#', bestSan: 'Qh4#',
        bestMove: { from: 3, to: 39, promotion: null }, bestScore: 0, depth: 3,
        kind: 'match', cause: 'match', lesson: 'a', reflection: {},
        createdAt: now, due: now + 86400000, step: 0, attempts: []
      });
    }).then(function () {
      return CoachStore.putJob({ gameId: 'gd', state: 'paused', pass: 1,
        cursorPly: 0, moments: [], updatedAt: now });
    });
  });

  function seed(entries) {
    return page.evaluate(function (list) {
      return Promise.all(list.map(function (e) {
        return CoachStore.putAnalysis({
          key: e.key, gameId: 'gcache', ply: 0,
          createdAt: e.createdAt, usedAt: e.usedAt, result: { v: e.key }
        });
      }));
    }, entries);
  }
  function wipeCache() {
    return page.evaluate(function () {
      return CoachStore.listAnalysesForGame('gcache').then(function (rows) {
        return Promise.all(rows.map(function (r) {
          return CoachStore.deleteAnalysis(r.key);
        }));
      });
    });
  }
  function maintain(opts) {
    return page.evaluate(function (o) {
      return CoachStore.maintainAnalysesCache(o || undefined);
    }, opts || null);
  }
  function cacheKeys() {
    return page.evaluate(function () {
      return CoachStore.listAnalysesForGame('gcache').then(function (rows) {
        return rows.map(function (r) { return r.key; }).sort();
      });
    });
  }
  function pad(i) { return 'k' + String(i).padStart(4, '0'); }

  // --- At the cap: zero prunes, zero deletions. Recency deliberately runs
  // AGAINST key order (higher key = older), so later scenarios prove the
  // prune sorts by recency, not key.
  const base = [];
  for (let i = 0; i < policy.max; i++) {
    base.push({ key: pad(i), createdAt: 1000 + (policy.max - i), usedAt: 1000 + (policy.max - i) });
  }
  await seed(base);
  const atCap = await maintain();
  check(atCap.count === policy.max && atCap.pruned === 0,
    'a cache exactly AT the cap is left alone (count ' + atCap.count + ', pruned 0)');

  // --- One over the cap: prune down to trimTo, strictly oldest-first, with
  // the fresh write protected. Survivors are exactly the newest entries.
  await seed([{ key: 'knew', createdAt: 999999, usedAt: 999999 }]);
  const over = await maintain({ protectKey: 'knew' });
  const overKeys = await cacheKeys();
  const expectPruned = policy.max + 1 - policy.trimTo;
  const oldestSurvivorIdx = policy.max - 1 - (expectPruned - 1); // higher i = older
  check(over.count === policy.max + 1 && over.pruned === expectPruned,
    'exceeding the cap prunes exactly count−trimTo entries (' + over.pruned + ')');
  check(overKeys.length === policy.trimTo && overKeys.indexOf('knew') !== -1,
    'the cache is back at trimTo with the fresh protected key intact');
  check(overKeys.indexOf(pad(0)) !== -1 && overKeys.indexOf(pad(oldestSurvivorIdx - 1)) !== -1 &&
    overKeys.indexOf(pad(oldestSurvivorIdx)) === -1 && overKeys.indexOf(pad(policy.max - 1)) === -1,
    'only the OLDEST entries were removed — newest survive, boundary is exact');

  // --- protectKey shields the fresh write even when it is the globally
  // oldest entry (a skewed clock stamping it in the past).
  await wipeCache();
  const prot = [{ key: 'pold', createdAt: 1, usedAt: 1 }];
  for (let i = 0; i < policy.max; i++) {
    prot.push({ key: pad(i), createdAt: 5000 + i, usedAt: 5000 + i });
  }
  await seed(prot);
  const protRes = await maintain({ protectKey: 'pold' });
  const protKeys = await cacheKeys();
  check(protRes.pruned === policy.max + 1 - policy.trimTo &&
    protKeys.indexOf('pold') !== -1 && protKeys.length === policy.trimTo,
    'a protected key survives pruning even as the globally oldest entry');

  // --- Legacy rows without usedAt order by createdAt, and rows with neither
  // timestamp prune first of all.
  await wipeCache();
  const legacy = [
    { key: 'legacy-none' },                 // no usedAt, no createdAt → recency 0
    { key: 'legacy-created', createdAt: 10 } // createdAt only → recency 10
  ];
  for (let i = 0; i < policy.max - 1; i++) {
    legacy.push({ key: pad(i), createdAt: 5000 + i, usedAt: 5000 + i });
  }
  await seed(legacy);
  const legRes = await maintain();
  const legKeys = await cacheKeys();
  const legPruned = policy.max + 1 - policy.trimTo;
  const legOldestSurvivor = legPruned - 2; // after the two legacy rows go first
  check(legRes.pruned === legPruned &&
    legKeys.indexOf('legacy-none') === -1 && legKeys.indexOf('legacy-created') === -1,
    'rows with no recency fields prune first, then createdAt-only legacy rows');
  check(legKeys.indexOf(pad(legOldestSurvivor - 1)) === -1 &&
    legKeys.indexOf(pad(legOldestSurvivor)) !== -1,
    'the remaining prunes take the oldest stamped rows, boundary exact');

  // --- touchAnalysis refreshes recency (a touched oldest entry survives the
  // next prune) and never creates entries for missing keys.
  await wipeCache();
  const forTouch = [];
  for (let i = 0; i <= policy.max; i++) { // one over cap
    forTouch.push({ key: pad(i), createdAt: 2000 + i, usedAt: 2000 + i });
  }
  await seed(forTouch);
  const touchRes = await page.evaluate(function () {
    return CoachStore.touchAnalysis('k0000').then(function (hit) {
      return CoachStore.touchAnalysis('missing-key').then(function (miss) {
        return { hit: hit, miss: miss };
      });
    });
  });
  check(touchRes.hit === true && touchRes.miss === false,
    'touch re-stamps an existing entry and is a no-op for a missing key');
  const touchMaintain = await maintain();
  const touchKeys = await cacheKeys();
  const touchPruned = policy.max + 1 - policy.trimTo;
  check(touchMaintain.pruned === touchPruned &&
    touchKeys.indexOf('k0000') !== -1 &&
    touchKeys.indexOf(pad(1)) === -1 && touchKeys.indexOf(pad(touchPruned)) === -1 &&
    touchKeys.indexOf(pad(touchPruned + 1)) !== -1 &&
    touchKeys.indexOf('missing-key') === -1,
    'a touched entry is rescued from pruning; the untouched oldest go instead');

  // --- Same-key reuse: a re-put replaces its entry, never duplicates it.
  const reuse = await page.evaluate(function () {
    return CoachStore.listAnalysesForGame('gcache').then(function (before) {
      return CoachStore.putAnalysis({
        key: 'k0000', gameId: 'gcache', ply: 0,
        createdAt: 3, usedAt: 3, result: { v: 'replaced' }
      }).then(function () {
        return CoachStore.listAnalysesForGame('gcache').then(function (after) {
          const row = after.find(function (r) { return r.key === 'k0000'; });
          return { before: before.length, after: after.length,
            replaced: !!row && row.result && row.result.v === 'replaced' };
        });
      });
    });
  });
  check(reuse.before === reuse.after && reuse.replaced,
    'same-key reuse is preserved: a re-put replaces, count is stable');

  // --- The destructive-operation lock blocks maintenance like every write.
  const locked = await page.evaluate(function () {
    CoachStore.setOpLock(true);
    return CoachStore.maintainAnalysesCache().then(
      function () { CoachStore.setOpLock(false); return 'resolved'; },
      function (e) { CoachStore.setOpLock(false); return 'rejected: ' + e.message; });
  });
  check(locked.indexOf('rejected') === 0,
    'maintenance respects the data-operation lock (' + locked + ')');

  // --- Boot maintenance: reload with an over-cap cache; app.js trims it.
  await wipeCache();
  const boot = [];
  for (let i = 0; i <= policy.max + 40; i++) {
    boot.push({ key: pad(i), createdAt: 7000 + i, usedAt: 7000 + i });
  }
  await seed(boot);
  await page.goto(t.url);
  await page.waitForSelector('#board .square');
  let bootCount = -1;
  for (let tries = 0; tries < 50; tries++) {
    bootCount = await page.evaluate(function () {
      return CoachStore.listAnalysesForGame('gcache').then(function (rows) {
        return rows.length;
      });
    });
    if (bootCount === policy.trimTo) break;
    await page.waitForTimeout(100);
  }
  check(bootCount === policy.trimTo,
    'boot runs one maintenance pass: an over-cap cache is trimmed (' + bootCount + ')');

  // --- Durable stores and scan state are untouched by everything above.
  const durables = await page.evaluate(function () {
    return Promise.all([
      CoachStore.listGames(), CoachStore.listCards(), CoachStore.getJob('gd')
    ]).then(function (r) {
      return { games: r[0].length, cards: r[1].length,
        gameOk: r[0].length === 1 && r[0][0].id === 'gd' && r[0][0].plies === 4,
        cardOk: r[1].length === 1 && r[1][0].gameId === 'gd',
        jobOk: !!r[2] && r[2].gameId === 'gd' && r[2].state === 'paused' };
    });
  });
  check(durables.gameOk && durables.cardOk && durables.jobOk,
    'games, cards and scan state all survive pruning untouched');
});
