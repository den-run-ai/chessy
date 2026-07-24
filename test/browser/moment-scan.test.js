/*
 * Phase 5a scan integration in a real browser/IndexedDB. Pure validator,
 * selector and controller semantics live in their fast Node suites; this test
 * pins module loading, durable job round-trip and the spoiler-safe event edge.
 */
'use strict';
require('./helper').run('moment-scan', async function (t) {
  const page = t.page, check = t.check;

  const outcome = await page.evaluate(async function () {
    const game = {
      id: 'phase5-browser',
      source: 'play',
      tags: {},
      sans: ['f3', 'e5', 'g4', 'Qh4#'],
      playerColor: 'w',
      clocks: [
        { thinkMs: 1000, wMs: 59000, bMs: 60000 },
        { thinkMs: 1200, wMs: 59000, bMs: 58800 },
        { thinkMs: 900, wMs: 58100, bMs: 58800 },
        { thinkMs: 1100, wMs: 58100, bMs: 57700 }
      ],
      result: '0-1',
      reason: 'checkmate',
      mode: 'pvp',
      difficulty: '2',
      timeControl: '1+0',
      plies: 4,
      createdAt: 1
    };
    await CoachStore.putGame(game);
    await CoachReview.openArchivedGame(game.id);

    const calls = [];
    const events = [];
    document.addEventListener('chessy:scanchange', function (e) {
      events.push(e.detail);
    });

    // Controlled async boundaries keep this integration test fast. Their
    // strict behavior is covered by analysis-result.test.js and
    // moment-selector.test.js.
    const realAnalyse = ChessyAnalysisService.analyse;
    const realValidate = ChessyAnalysisResult.validate;
    const realQuick = ChessyMomentSelector.quickCandidate;
    const realShortlist = ChessyMomentSelector.shortlist;
    const realAccept = ChessyMomentSelector.acceptDeep;
    ChessyAnalysisService.analyse = function (req, owner) {
      calls.push({ ply: req.ply, nodeLimit: req.opts.nodeLimit, owner: owner });
      return Promise.resolve({
        complete: true,
        stability: req.opts.nodeLimit === 80000
          ? { bestMoveStable: true } : null
      });
    };
    ChessyAnalysisResult.validate = function () { return { ok: true }; };
    ChessyMomentSelector.quickCandidate = function (result, meta) {
      return { ply: meta.ply, playedSan: meta.playedSan, internalScore: 999 };
    };
    ChessyMomentSelector.shortlist = function (candidates) {
      return candidates.slice(0, 2);
    };
    ChessyMomentSelector.acceptDeep = function (quick, result, meta) {
      return { ply: meta.ply, playedSan: meta.playedSan };
    };

    const done = await ChessyMomentScan.start(CoachReview.current(), { restart: true });
    const stored = await CoachStore.getJob(game.id);
    const cards = await CoachStore.listCards();

    ChessyAnalysisService.analyse = realAnalyse;
    ChessyAnalysisResult.validate = realValidate;
    ChessyMomentSelector.quickCandidate = realQuick;
    ChessyMomentSelector.shortlist = realShortlist;
    ChessyMomentSelector.acceptDeep = realAccept;

    return {
      loaded: !!ChessyAnalysisResult && !!ChessyMomentSelector && !!ChessyMomentScan,
      doneState: done.state,
      callPlies: calls.map(function (c) { return c.ply; }).join(','),
      quickCalls: calls.filter(function (c) { return c.nodeLimit !== 80000; }).length,
      deepCalls: calls.filter(function (c) { return c.nodeLimit === 80000; }).length,
      owners: calls.every(function (c) { return c.owner === 'moment-scan'; }),
      storedState: stored && stored.state,
      storedMoments: stored && stored.moments,
      publicMoments: ChessyMomentScan.state().moments,
      startLeaked: /internalScore|candidates|shortlist|bestUtility|loss/.test(
        JSON.stringify(done)),
      leaked: events.some(function (e) {
        const text = JSON.stringify(e);
        return /internalScore|loss|bestMove|bestUtility|playedUtility|defensive|collapse/.test(text);
      }),
      cardCount: cards.length
    };
  });

  check(outcome.loaded, 'all three Phase 5 scan modules load in release order');
  check(outcome.doneState === 'done' && outcome.storedState === 'done',
    'a completed scan is durably checkpointed in analysisJobs');
  check(outcome.callPlies === '0,2,0,2' &&
        outcome.quickCalls === 2 && outcome.deepCalls === 2,
    'the browser controller scans only White decisions then deep-checks at most two');
  check(outcome.owners,
    'every batch request carries moment-scan ownership');
  check(outcome.storedMoments.length === 2 && outcome.publicMoments.length === 2 &&
        Object.keys(outcome.publicMoments[0]).sort().join(',') === 'playedSan,ply',
    'public proposals contain only move location and played SAN');
  check(!outcome.leaked && !outcome.startLeaked,
    'events and start() never leak internal score/category/better-move evidence');
  check(outcome.cardCount === 0,
    'scanning creates no lesson cards automatically');

  // Reload destroys the in-memory controller owner but not the durable job.
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.evaluate(function () {
    return CoachReview.openArchivedGame('phase5-browser');
  });
  await page.waitForFunction(function () {
    const state = ChessyMomentScan.state();
    return state && state.state === 'done' &&
      document.getElementById('scanProgress').textContent
        .indexOf('Scan complete') !== -1;
  });
  const reloaded = await page.evaluate(async function () {
    const state = ChessyMomentScan.state();
    return {
      state: state && state.state,
      moments: state && state.moments,
      stored: await CoachStore.getJob('phase5-browser')
    };
  });
  check(reloaded.state === 'done' && reloaded.stored &&
        reloaded.stored.state === 'done' &&
        reloaded.moments.length === 2,
    'completed spoiler-safe proposals survive a real page reload');
});
