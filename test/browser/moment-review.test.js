/*
 * Phase 5b Review surface: scanning is explicit, progress and proposals are
 * spoiler-safe, imported games require a side, suggestions enter a fresh
 * reflect-first flow, and a running timed game blocks batch work.
 */
'use strict';
require('./helper').run('moment-review', async function (t) {
  const page = t.page, check = t.check;

  await page.evaluate(async function () {
    const game = {
      id: 'phase5-review-ui',
      source: 'import',
      tags: {},
      sans: ['f3', 'e5', 'g4', 'Qh4#'],
      playerColor: null,
      clocks: [null, null, null, null],
      result: '0-1',
      reason: 'checkmate',
      mode: 'pvp',
      difficulty: '2',
      timeControl: null,
      plies: 4,
      createdAt: Date.now() + 10000
    };
    await CoachStore.putGame(game);

    // Keep the controller and IndexedDB checkpoints real while replacing the
    // expensive engine boundaries with deterministic, spoiler-rich sentinels.
    // Only {ply, playedSan} may cross from the controller into this UI.
    window.__scanReal = {
      analyse: ChessyAnalysisService.analyse,
      validate: ChessyAnalysisResult.validate,
      quick: ChessyMomentSelector.quickCandidate,
      shortlist: ChessyMomentSelector.shortlist,
      accept: ChessyMomentSelector.acceptDeep,
      pause: ChessyMomentScan.pause
    };
    window.__scanPauseCalls = 0;
    ChessyAnalysisService.analyse = function () {
      return Promise.resolve({ complete: true, internalScore: 999 });
    };
    window.__fastScanAnalyse = ChessyAnalysisService.analyse;
    ChessyAnalysisResult.validate = function () { return { ok: true }; };
    ChessyMomentSelector.quickCandidate = function (result, meta) {
      return {
        ply: meta.ply,
        playedSan: meta.playedSan,
        internalScore: 999,
        category: 'collapse',
        bestSan: 'e4'
      };
    };
    ChessyMomentSelector.shortlist = function (candidates) {
      return candidates.slice(0, 2);
    };
    ChessyMomentSelector.acceptDeep = function (quick, result, meta) {
      return {
        ply: meta.ply,
        playedSan: meta.playedSan,
        internalScore: 999,
        category: 'collapse',
        bestSan: 'e4'
      };
    };
    const realPause = ChessyMomentScan.pause;
    ChessyMomentScan.pause = function () {
      window.__scanPauseCalls++;
      return realPause.apply(this, arguments);
    };
    await CoachReview.openArchivedGame(game.id);
  });

  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent.indexOf('Choose White') !== -1;
  });
  check(await page.locator('#scanSideChoice').isVisible(),
    'an imported game with unknown ownership asks for White, Black or Both');
  check(await page.locator('#scanStart').isDisabled(),
    'scan cannot start until the imported side is chosen');
  check(await page.getAttribute('#scanProgress', 'role') === 'status' &&
        await page.getAttribute('#scanProgress', 'aria-live') === 'polite' &&
        await page.getAttribute('#scanMeter', 'aria-label') ===
          'Critical-moment scan progress',
    'scan progress has a named meter and an accessible polite live status');

  await page.evaluate(function () {
    window.__scanProgressSeen = [];
    document.addEventListener('chessy:scanchange', function () {
      window.__scanProgressSeen.push(
        document.getElementById('scanProgress').textContent);
    });
  });
  await page.check('input[name="scanColor"][value="w"]');
  check(!(await page.locator('#scanStart').isDisabled()),
    'choosing a side enables the explicit Start scan action');
  await page.click('#scanStart');
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent.indexOf('Scan complete') !== -1;
  });

  const completed = await page.evaluate(async function () {
    const job = await CoachStore.getJob('phase5-review-ui');
    return {
      jobColor: job && job.scanColor,
      state: job && job.state,
      count: document.querySelectorAll('#scanMomentList .scan-moment').length,
      labels: Array.from(document.querySelectorAll('#scanMomentList .scan-moment'))
        .map(function (b) { return b.textContent; }),
      panel: document.getElementById('momentScan').textContent,
      progressSeen: window.__scanProgressSeen,
      cards: (await CoachStore.listCards()).length
    };
  });
  check(completed.jobColor === 'w' && completed.state === 'done',
    'Start scans only the explicitly chosen side and checkpoints completion');
  check(completed.progressSeen.some(function (s) {
    return s.indexOf('Checking decisions') !== -1;
  }) && completed.progressSeen.some(function (s) {
    return s.indexOf('Confirming suggestions') !== -1;
  }), 'the live status reports both scan passes as they progress');
  check(completed.count === 2 &&
        completed.labels.join('|') === '1. f3|2. g4',
    'Review shows at most two suggestions using move number and played SAN only');
  check(!/999|collapse|best move|better move|e4/i.test(completed.panel),
    'the Review scan surface leaks no scores, categories, or alternative moves');
  check(completed.cards === 0,
    'a completed scan creates no lesson cards');

  // A deferred first analysis leaves enough time to exercise the real Pause
  // button. Pause must be enabled as soon as running ownership is announced,
  // supersede the pending Start completion, and durably preserve the cursor.
  await page.evaluate(function () {
    ChessyAnalysisService.analyse = function () {
      return new Promise(function (resolve) {
        window.__deferredScanResolve = resolve;
      });
    };
  });
  await page.click('#scanStart'); // completed state labels this "Scan again"
  await page.waitForSelector('#scanPause:not([hidden])');
  check(!(await page.locator('#scanPause').isDisabled()) &&
        ['scanPause', 'scanProgress'].includes(
          await page.evaluate(function () { return document.activeElement.id; })),
    'Pause becomes usable without leaving focus on the hidden Start control');
  await page.click('#scanPause');
  await page.waitForSelector('#scanResume:not([hidden])');
  const paused = await page.evaluate(function () {
    return CoachStore.getJob('phase5-review-ui');
  });
  check(paused.state === 'paused' && paused.cursorPly === 0 && paused.checked === 0,
    'Pause checkpoints the unchanged next-decision cursor');
  check(['scanResume', 'scanProgress'].includes(
    await page.evaluate(function () { return document.activeElement.id; })),
    'Pause moves focus to Resume or the stable progress status');

  // Reopen to prove the explicit side and paused state survive a page-level
  // Review round trip, then finish from the exact checkpoint.
  await page.click('#reviewBack');
  await page.waitForSelector('.game-item');
  await page.locator('.game-item').first().click();
  await page.waitForSelector('#scanResume:not([hidden])');
  check(await page.locator('input[name="scanColor"][value="w"]').isChecked() &&
        await page.locator('input[name="scanColor"][value="w"]').isDisabled(),
    'reload remembers the chosen side and locks it while paused work is resumable');
  await page.evaluate(function () {
    ChessyAnalysisService.analyse = window.__fastScanAnalyse;
  });
  await page.click('#scanResume');
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent.indexOf('Scan complete') !== -1;
  });
  check(await page.locator('#scanMomentList .scan-moment').count() === 2 &&
        await page.evaluate(function () {
          return document.activeElement.id === 'scanStart' &&
            !document.activeElement.hidden;
        }),
    'Resume finishes from the durable cursor and focuses the visible Scan again action');

  // A suggestion is only a navigation/reflection prompt. It must clear stale
  // answers, pause batch ownership, and reveal no engine output.
  await page.evaluate(function () { CoachReview.goToPly(2); });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'stale answer');
  await page.fill('#reflectCandidates', 'stale candidates');
  await page.selectOption('#reflectEval', 'winning');
  check(await page.locator('#scanStart').isDisabled() &&
        await page.locator('input[name="scanColor"][value="w"]').isDisabled() &&
        await page.locator('#scanMomentList .scan-moment').first().isDisabled(),
    'manual Flag disables every scan and side control while reflection is active');
  await page.evaluate(function () { CoachReview.goToPly(1); });
  check(!(await page.locator('#scanStart').isDisabled()) &&
        !(await page.locator('#scanMomentList .scan-moment').first().isDisabled()),
    'leaving the flagged position re-enables the scan controls');
  await page.click('#scanMomentList .scan-moment');
  const opened = await page.evaluate(async function () {
    return {
      ply: CoachReview.current().ply,
      formVisible: !document.getElementById('reflectForm').hidden,
      verifyHidden: document.getElementById('verifyBox').hidden,
      threat: document.getElementById('reflectThreat').value,
      candidates: document.getElementById('reflectCandidates').value,
      evaluation: document.getElementById('reflectEval').value,
      focus: document.activeElement.id,
      pauses: window.__scanPauseCalls,
      scanDisabled: document.getElementById('scanStart').disabled &&
        document.querySelector('#scanMomentList .scan-moment').disabled,
      cards: (await CoachStore.listCards()).length
    };
  });
  check(opened.ply === 0 && opened.formVisible && opened.verifyHidden,
    'a suggestion navigates to its ply and opens the existing reflect-first form');
  check(opened.threat === '' && opened.candidates === '' &&
        opened.evaluation === '' && opened.focus === 'reflectThreat',
    'suggestion reflection is fresh and blank, with focus on the first prompt');
  check(opened.pauses >= 3 && opened.scanDisabled && opened.cards === 0,
    'suggestion reflection pauses ownership, locks scan controls, and creates no card');

  const guarded = await page.evaluate(function () {
    const before = CoachReview.current().ply;
    const invalid = [
      CoachReview.goToPly(-1),
      CoachReview.goToPly(99),
      CoachReview.goToPly(1.5)
    ];
    const afterInvalid = CoachReview.current().ply;
    CoachReview.goToPly(CoachReview.current().gs.history.length);
    return {
      invalid: invalid,
      unchanged: afterInvalid === before,
      terminalBegin: ChessyReflection.beginCurrent(),
      formHidden: document.getElementById('reflectForm').hidden
    };
  });
  check(guarded.invalid.every(function (v) { return v === false; }) &&
        guarded.unchanged,
    'the public Review navigation seam rejects stale or malformed plies');
  check(guarded.terminalBegin === false && guarded.formHidden,
    'the reflection seam rejects the terminal end position');

  // SetUp/FEN games carry their own move number and side to move. Labels must
  // come from the replayed state, never from standard-start ply parity.
  await page.evaluate(async function () {
    await CoachStore.putGame({
      id: 'phase5-custom-label',
      source: 'import',
      tags: { SetUp: '1' },
      setupFen: '8/8/8/8/8/5k2/8/R6K b - - 0 37',
      sans: ['Ke4', 'Ra4+'],
      playerColor: 'both',
      clocks: [null, null],
      result: '*',
      reason: 'imported',
      mode: 'pvp',
      difficulty: '2',
      timeControl: null,
      plies: 2,
      createdAt: Date.now() + 20000
    });
    return CoachReview.openArchivedGame('phase5-custom-label');
  });
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent === 'Not scanned yet.';
  });
  await page.click('#scanStart');
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent.indexOf('Scan complete') !== -1;
  });
  const customLabels = await page.locator('#scanMomentList .scan-moment').allTextContents();
  check(customLabels.join('|') === '37… Ke4|38. Ra4+',
    'custom-FEN suggestions use the position’s fullmove and side to move');

  // Replace this record under the same id WHILE a fresh scan is awaiting its
  // first result. The controller's atomic source guard stops without emitting
  // another public snapshot; Review must clear the last "running" state rather
  // than leave a permanent Pause button.
  await page.evaluate(function () {
    ChessyAnalysisService.analyse = function () {
      return new Promise(function (resolve) {
        window.__sameIdResolve = resolve;
      });
    };
  });
  await page.click('#scanStart');
  await page.waitForSelector('#scanPause:not([hidden])');
  await page.waitForFunction(function () {
    return typeof window.__sameIdResolve === 'function';
  });
  await page.evaluate(async function () {
    await CoachStore.archiveGame({
      id: 'phase5-custom-label',
      source: 'import',
      tags: { SetUp: '1' },
      setupFen: '8/8/8/8/8/5k2/8/R6K b - - 0 37',
      sans: ['Kf4'],
      playerColor: 'both',
      clocks: [null],
      result: '*',
      reason: 'revised import',
      mode: 'pvp',
      difficulty: '2',
      timeControl: null,
      plies: 1,
      createdAt: Date.now() + 30000
    });
    window.__sameIdResolve({ complete: true, internalScore: 999 });
  });
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent
      .indexOf('Return to All games') !== -1;
  });
  const replacedMidRun = await page.evaluate(function () {
    return {
      pauseHidden: document.getElementById('scanPause').hidden,
      startVisible: !document.getElementById('scanStart').hidden,
      startDisabled: document.getElementById('scanStart').disabled,
      state: ChessyMomentScan.state(),
      focus: document.activeElement.id
    };
  });
  check(replacedMidRun.pauseHidden && replacedMidRun.startVisible &&
        replacedMidRun.startDisabled && replacedMidRun.state === null &&
        replacedMidRun.focus === 'scanProgress',
    'same-id replacement clears stale running UI, focuses status, and requires reopening');

  // Reopening binds the UI to the revised source and cannot repaint the old
  // source's suggestions.
  await page.evaluate(function () {
    ChessyAnalysisService.analyse = window.__fastScanAnalyse;
    return CoachReview.openArchivedGame('phase5-custom-label');
  });
  await page.waitForFunction(function () {
    return !document.getElementById('scanResume').hidden;
  });
  check(await page.locator('#scanMomentList .scan-moment').count() === 0 &&
        await page.locator('#scanSuggestions').isHidden(),
    'a same-id source revision cannot repaint the previous game’s suggestions');

  // A live timed game owns the CPU and clock-sensitive foreground. Review may
  // stay open, but every scan action and side choice must be disabled. Start a
  // deferred scan first: leaving Review pauses it, and opening Review alongside
  // the live clock must never auto-resume it.
  await page.evaluate(async function () {
    ChessyAnalysisService.analyse = function () {
      return new Promise(function (resolve) {
        window.__liveDeferredResolve = resolve;
      });
    };
    await CoachReview.openArchivedGame('phase5-review-ui');
  });
  await page.waitForFunction(function () {
    return document.getElementById('scanStart').textContent === 'Scan again' &&
      !document.getElementById('scanStart').disabled;
  });
  await page.click('#scanStart');
  await page.waitForSelector('#scanPause:not([hidden])');
  await page.click('#tabPlay');
  await t.newGame({ mode: 'pvp', timeControl: '300+3' });
  await page.evaluate(function () {
    CoachReview.showView('review');
    return CoachReview.openArchivedGame('phase5-review-ui');
  });
  await page.waitForSelector('#liveGameNote:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent.indexOf('timed game') !== -1;
  });
  check(await page.locator('#scanResume').isVisible() &&
        await page.locator('#scanResume').isDisabled() &&
        await page.locator('input[name="scanColor"][value="w"]').isDisabled(),
    'a running timed game leaves interrupted work paused and disables Resume and side choice');
  check((await page.textContent('#scanProgress')).includes('Return to Play'),
    'the live-game gate never auto-resumes and explains how to resolve it');
});
