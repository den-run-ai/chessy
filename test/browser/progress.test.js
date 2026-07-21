/* Progress: read-only descriptive counts — no accuracy headline. */
'use strict';
require('./helper').run('progress', async function (t) {
  const page = t.page, check = t.check;

  // Seed one game and two cards (one graded correct on first try, one
  // graded incorrect) directly — the flows that create them have their
  // own suites.
  await page.evaluate(function () {
    const now = Date.now();
    return CoachStore.putGame({
      id: 'g1', source: 'play', tags: {}, sans: ['f3', 'e5', 'g4', 'Qh4#'],
      playerColor: 'both', clocks: [null, null, null, null], result: '0-1',
      reason: 'checkmate', mode: 'pvp', difficulty: '2', timeControl: 'none',
      plies: 4, createdAt: now
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'g1', ply: 3, fenBefore: 'x', playedSan: 'Qh4#', bestSan: 'Qh4#',
        bestMove: { from: 3, to: 39, promotion: null }, bestScore: 0, depth: 3,
        kind: 'match', cause: 'match', lesson: 'a', reflection: {},
        createdAt: now, due: now + 86400000, step: 0,
        attempts: [{ at: now - 1000, grade: 'good', correct: true },
                   { at: now - 500, grade: 'good', correct: true }]
      });
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'g1', ply: 0, fenBefore: 'y', playedSan: 'f3', bestSan: 'e4',
        bestMove: { from: 52, to: 36, promotion: null }, bestScore: 30, depth: 3,
        kind: 'differ', cause: 'sound-alternative', lesson: 'b', reflection: {},
        createdAt: now, due: now - 1, step: -1,
        attempts: [{ at: now - 800, grade: 'again', correct: false }]
      });
    });
  });

  await page.click('#tabProgress');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#progressStats dt').length > 0;
  });
  const stats = await page.evaluate(function () {
    const out = {};
    const dl = document.getElementById('progressStats');
    const dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd');
    dts.forEach(function (dt, i) { out[dt.textContent] = dds[i].textContent; });
    return out;
  });
  check(stats['Games archived'] === '1', 'counts archived games');
  check(stats['Lesson cards'] === '2', 'counts lesson cards');
  check(stats['Cards due now'] === '1', 'counts due cards');
  check(stats['Reviews (30 days)'] === '3', 'counts every recent attempt');
  check(stats['Matched Chessy’s saved move on first try (30 days)'] === '1/2',
    'the narrow exact-match signal counts FIRST tries only and is labelled as such');
  check(!Object.keys(stats).some(function (k) { return /accuracy/i.test(k); }),
    'no headline accuracy number');
  const causes = await page.textContent('#causeStats');
  check(causes.includes('Good move (matched Chessy)') && causes.includes('My move was also sound'),
    'per-cause tallies use the player-owned labels');

  // The snapshot is read-only and re-renders on entry.
  await page.click('#tabPlay');
  await page.evaluate(function () {
    return CoachStore.putGame({
      id: 'g2', source: 'play', tags: {}, sans: ['e4'], playerColor: 'both',
      clocks: [null], result: '*', reason: '', mode: 'pvp', difficulty: '2',
      timeControl: 'none', plies: 1, createdAt: Date.now()
    });
  });
  await page.click('#tabProgress');
  await page.waitForFunction(function () {
    return document.getElementById('progressStats').textContent.indexOf('Games archived2') !== -1;
  });
  check(true, 'entering the view re-renders fresh counts');

  // Phone width: the long first-try stat label must WRAP, not force the
  // page to scroll sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(function () {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  check(overflow <= 0,
    'no horizontal overflow at phone width (long stat labels wrap; ' + overflow + 'px)');
  await page.setViewportSize({ width: 1280, height: 720 });

  // A read failure AFTER a successful render must not leave a stale cause
  // snapshot beneath the "unavailable" message — both lists clear.
  check((await page.textContent('#causeStats')).trim().length > 0,
    'cause tallies are populated before the failure');
  await page.click('#tabPlay');
  await page.evaluate(function () {
    CoachStore.__realListCards = CoachStore.listCards;
    CoachStore.listCards = function () { return Promise.reject(new Error('blocked')); };
  });
  await page.click('#tabProgress');
  await page.waitForFunction(function () {
    return document.getElementById('progressStats').textContent.indexOf('unavailable') !== -1;
  });
  check((await page.textContent('#causeStats')).trim() === '',
    'a failed progress read clears the stale cause tallies too');
  await page.evaluate(function () { CoachStore.listCards = CoachStore.__realListCards; });
});
