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
      moves: [
        { san: 'f3', nags: ['$6'] },
        { san: 'e5', nags: ['$1'] },
        { san: 'g4', nags: ['$2'] },
        { san: 'Qh4#', nags: ['$4'] }
      ],
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
    ChessyAnalysisService.analyse = function (req) {
      const state = Chess.parseFen(req.fen);
      const legal = Chess.legalMoves(state);
      const played = req.opts.playedMove;
      const different = legal.find(function (move) {
        return move.from !== played.from || move.to !== played.to ||
          (move.promotion || null) !== (played.promotion || null);
      }) || played;
      const loss = req.ply === 0 ? 450 : 150;
      const whiteScore = function (moverScore) {
        return state.turn === 'w' ? moverScore : -moverScore;
      };
      const uci = function (move) {
        return Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '');
      };
      const line = function (move, moverScore, rank, amongCandidates) {
        const san = Chess.toSan(state, move, legal);
        const moveUci = uci(move);
        return {
          move: move,
          uci: moveUci,
          san: san,
          scoreCpWhite: whiteScore(moverScore),
          scoreCpPlayer: moverScore,
          mate: null,
          pv: [san],
          pvUci: [moveUci],
          rank: rank,
          amongCandidates: amongCandidates
        };
      };
      const identity = ChessyAnalysisCore.identity(state,
        Object.assign({}, req.opts, { positions: req.positions }));
      return Promise.resolve({
        complete: true,
        turn: state.turn,
        wdl: null,
        depth: req.opts.nodeLimit === 80000 ? 4 : 2,
        nodes: 100,
        qnodes: 20,
        elapsedMs: 1,
        engine: {
          id: identity.engineId,
          version: identity.version,
          configHash: identity.configHash
        },
        positionFingerprint: identity.positionFingerprint,
        scoreCpWhite: whiteScore(100),
        scoreCpPlayer: 100,
        mate: null,
        bestLines: [line(different, 100, 1, true)],
        playedLine: line(played, 100 - loss, 2, false),
        classification: 'unknown-equivalence',
        internalScore: 999,
        stability: req.opts.nodeLimit === 80000
          ? { depths: [3, 4], bestMoveStable: true } : null
      });
    };
    window.__fastScanAnalyse = ChessyAnalysisService.analyse;
    ChessyAnalysisResult.validate = function (result) {
      return {
        ok: true,
        topMove: result.bestLines && result.bestLines[0] &&
          result.bestLines[0].move,
        playedMove: result.playedLine && result.playedLine.move
      };
    };
    ChessyMomentSelector.quickCandidate = function (result, meta) {
      return {
        ply: meta.ply,
        playedSan: meta.playedSan,
        turn: meta.turn,
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
      history: document.getElementById('reviewMoveList').textContent,
      historyCount: document.querySelectorAll(
        '#reviewMoveList .review-ply:not(.empty)').length,
      historyScores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      historyMarks: document.querySelectorAll('#reviewMoveList .review-nag').length,
      publicReport: ChessyMomentScan.state().report,
      progressSeen: window.__scanProgressSeen,
      cards: (await CoachStore.listCards()).length
    };
  });
  check(completed.jobColor === 'w' && completed.state === 'done',
    'Start scans only the explicitly chosen side and checkpoints completion');
  check(completed.progressSeen.some(function (s) {
    return s.indexOf('Checking moves') !== -1;
  }) && completed.progressSeen.some(function (s) {
    return s.indexOf('Confirming suggestions') !== -1;
  }), 'the live status reports both scan passes as they progress');
  check(completed.count === 2 &&
        completed.labels.join('|') === '1. f3|2. g4',
    'Review shows at most two suggestions using move number and played SAN only');
  check(!/999|collapse|best move|better move|e4/i.test(completed.panel),
    'the Review scan surface leaks no scores, categories, or alternative moves');
  check(completed.historyCount === 4 &&
        /f3/.test(completed.history) && /e5/.test(completed.history) &&
        /g4/.test(completed.history) && /Qh4#/.test(completed.history) &&
        completed.historyScores === 0 && completed.historyMarks === 0 &&
        completed.publicReport === undefined,
    'the SAN ledger is complete while score and source/generated NAGs remain gated');
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
  await page.selectOption('#reflectThreatKind', 'move');
  await page.fill('#reflectThreat', 'stale answer');
  await page.selectOption('#reflectCandidatesKind', 'listed');
  await page.fill('#reflectCandidates', 'stale candidates');
  await page.selectOption('#reflectLineKind', 'line');
  await page.fill('#reflectLine', 'stale line');
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
      threatKind: document.getElementById('reflectThreatKind').value,
      threat: document.getElementById('reflectThreat').value,
      candidatesKind: document.getElementById('reflectCandidatesKind').value,
      candidates: document.getElementById('reflectCandidates').value,
      lineKind: document.getElementById('reflectLineKind').value,
      line: document.getElementById('reflectLine').value,
      evaluation: document.getElementById('reflectEval').value,
      inputErrorHidden: document.getElementById('reflectInputError').hidden,
      focus: document.activeElement.id,
      pauses: window.__scanPauseCalls,
      scanDisabled: document.getElementById('scanStart').disabled &&
        document.querySelector('#scanMomentList .scan-moment').disabled,
      cards: (await CoachStore.listCards()).length
    };
  });
  check(opened.ply === 0 && opened.formVisible && opened.verifyHidden,
    'a suggestion navigates to its ply and opens the existing reflect-first form');
  check(opened.threatKind === '' && opened.threat === '' &&
        opened.candidatesKind === '' && opened.candidates === '' &&
        opened.lineKind === '' && opened.line === '' &&
        opened.evaluation === '' && opened.inputErrorHidden &&
        opened.focus === 'reflectThreatKind',
    'suggestion reflection is fresh and blank, with focus on the first prompt');
  check(opened.pauses >= 3 && opened.scanDisabled && opened.cards === 0,
    'suggestion reflection pauses ownership, locks scan controls, and creates no card');

  // A VALID structured submit—not merely opening the form—crosses Gate 0.
  // It reveals this row only; imported PGN and Chessy-generated punctuation
  // remain visibly distinct.
  await page.selectOption('#reflectThreatKind', 'none');
  await page.selectOption('#reflectCandidatesKind', 'none');
  await page.selectOption('#reflectLineKind', 'none');
  await page.selectOption('#reflectEval', 'worse');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#reviewMoveList .review-eval').length === 1;
  });
  const firstScore = await page.evaluate(function () {
    const state = ChessyMomentScan.state();
    return {
      unlocked: state.reportUnlocked,
      report: state.report,
      scores: Array.from(document.querySelectorAll('#reviewMoveList .review-eval'))
        .map(function (node) { return node.textContent; }),
      sourceMarks: Array.from(document.querySelectorAll(
        '#reviewMoveList .review-nag.source'))
        .map(function (node) { return node.textContent; }),
      chessyMarks: Array.from(document.querySelectorAll(
        '#reviewMoveList .review-nag.chessy'))
        .map(function (node) { return node.textContent; }),
      note: document.getElementById('reviewHistoryNote').textContent,
      cards: 0
    };
  });
  check(firstScore.unlocked === false && firstScore.report.length === 1 &&
        firstScore.report[0].ply === 0 &&
        firstScore.scores.join('|') === '-3.5' &&
        firstScore.sourceMarks.join('|') === 'PGN ?!' &&
        firstScore.chessyMarks.join('|') === 'Chessy ??' &&
        /remaining suggested moment/.test(firstScore.note),
    'one submitted reflection reveals one score with distinct PGN and Chessy marks');

  // Forge the old cache field for the OTHER suggestion, then cross a real
  // page boundary. Only the genuine first form submission may survive.
  await page.evaluate(async function () {
    const job = await CoachStore.getJob('phase5-review-ui');
    job.reflected = job.moments.map(function (moment) {
      return { ply: moment.ply, playedSan: moment.playedSan };
    });
    await CoachStore.putJob(job);
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.evaluate(function () {
    // Reinstall the deterministic engine boundary for the remainder of this
    // integration suite; the page reload intentionally destroyed all stubs.
    ChessyAnalysisService.analyse = function (req) {
      const state = Chess.parseFen(req.fen);
      const legal = Chess.legalMoves(state);
      const played = req.opts.playedMove;
      const different = legal.find(function (move) {
        return move.from !== played.from || move.to !== played.to ||
          (move.promotion || null) !== (played.promotion || null);
      }) || played;
      const loss = req.ply === 0 ? 450 : 150;
      const whiteScore = function (score) {
        return state.turn === 'w' ? score : -score;
      };
      const uci = function (move) {
        return Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '');
      };
      const line = function (move, score, rank, amongCandidates) {
        const san = Chess.toSan(state, move, legal);
        const moveUci = uci(move);
        return {
          move: move, uci: moveUci, san: san,
          scoreCpWhite: whiteScore(score), scoreCpPlayer: score,
          mate: null, pv: [san], pvUci: [moveUci], rank: rank,
          amongCandidates: amongCandidates
        };
      };
      const identity = ChessyAnalysisCore.identity(state,
        Object.assign({}, req.opts, { positions: req.positions }));
      return Promise.resolve({
        complete: true, turn: state.turn,
        wdl: null,
        depth: req.opts.nodeLimit === 80000 ? 4 : 2,
        nodes: 100, qnodes: 20, elapsedMs: 1,
        engine: { id: identity.engineId, version: identity.version,
          configHash: identity.configHash },
        positionFingerprint: identity.positionFingerprint,
        scoreCpWhite: whiteScore(100), scoreCpPlayer: 100, mate: null,
        bestLines: [line(different, 100, 1, true)],
        playedLine: line(played, 100 - loss, 2, false),
        classification: 'unknown-equivalence',
        stability: req.opts.nodeLimit === 80000
          ? { depths: [3, 4], bestMoveStable: true } : null
      });
    };
    window.__fastScanAnalyse = ChessyAnalysisService.analyse;
    ChessyAnalysisResult.validate = function (result) {
      return { ok: true,
        topMove: result.bestLines && result.bestLines[0] &&
          result.bestLines[0].move,
        playedMove: result.playedLine && result.playedLine.move };
    };
    ChessyMomentSelector.quickCandidate = function (result, meta) {
      return {
        ply: meta.ply,
        playedSan: meta.playedSan,
        turn: meta.turn,
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
    return CoachReview.openArchivedGame('phase5-review-ui');
  });
  await page.waitForFunction(function () {
    const state = ChessyMomentScan.state();
    return state && state.state === 'done' &&
      document.querySelectorAll('#reviewMoveList .review-eval').length === 1;
  });
  const afterSubmitReload = await page.evaluate(async function () {
    const state = ChessyMomentScan.state();
    const game = await CoachStore.getGame('phase5-review-ui');
    const job = await CoachStore.getJob('phase5-review-ui');
    return {
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      report: state.report,
      receipts: (await CoachStore.listValidReflectionReceipts(game)).length,
      cards: (await CoachStore.listCards()).length,
      cacheField: Object.prototype.hasOwnProperty.call(job, 'reflected')
    };
  });
  check(afterSubmitReload.unlocked === false &&
        afterSubmitReload.completed === 1 &&
        afterSubmitReload.report.length === 1 &&
        afterSubmitReload.receipts === 1 && afterSubmitReload.cards === 0 &&
        afterSubmitReload.cacheField === false,
    'real submit → reload restores one durable receipt and ignores forged job rows');

  // Reflect on the second suggestion to unlock all scanned scores and every
  // source annotation. Opponent moves receive quick estimates, but no
  // Chessy-generated NAG because nominations were explicitly White-only.
  await page.evaluate(function () { CoachReview.goToPly(2); });
  await page.locator('#scanMomentList .scan-moment').nth(1).click();
  await page.selectOption('#reflectThreatKind', 'none');
  await page.selectOption('#reflectCandidatesKind', 'none');
  await page.selectOption('#reflectLineKind', 'none');
  await page.selectOption('#reflectEval', 'worse');
  await page.click('#reflectVerify');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#reviewMoveList .review-eval').length === 4;
  });
  const fullScore = await page.evaluate(async function () {
    const state = ChessyMomentScan.state();
    return {
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      required: state.reflectionRequired,
      report: state.report,
      historyCount: document.querySelectorAll(
        '#reviewMoveList .review-ply:not(.empty)').length,
      scores: Array.from(document.querySelectorAll('#reviewMoveList .review-eval'))
        .map(function (node) { return node.textContent; }),
      sourceMarks: Array.from(document.querySelectorAll(
        '#reviewMoveList .review-nag.source'))
        .map(function (node) { return node.textContent; }),
      chessyMarks: Array.from(document.querySelectorAll(
        '#reviewMoveList .review-nag.chessy'))
        .map(function (node) { return node.textContent; }),
      note: document.getElementById('reviewHistoryNote').textContent,
      cards: (await CoachStore.listCards()).length
    };
  });
  check(fullScore.unlocked === true &&
        fullScore.completed === fullScore.required &&
        fullScore.report.length === 4 && fullScore.historyCount === 4 &&
        fullScore.scores.join('|') === '-3.5|≈ +0.5|-0.5|≈ +0.5' &&
        fullScore.sourceMarks.join('|') === 'PGN ?!|PGN !|PGN ?|PGN ??' &&
        fullScore.chessyMarks.join('|') === 'Chessy ??|Chessy ?!' &&
        /White’s perspective/.test(fullScore.note) && fullScore.cards === 0,
    'all required reflections unlock every White-POV score without inventing opponent NAGs');
  await page.setViewportSize({ width: 360, height: 740 });
  const unlockedOverflow = await page.evaluate(function () {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  check(unlockedOverflow <= 1,
    'scores plus PGN/Chessy badges do not overflow a narrow phone viewport');
  await page.setViewportSize({ width: 1280, height: 720 });

  // A same-ending rearchive can still change the exact scan source through
  // its clock/time-control evidence. That revision must revoke the already
  // rendered Gate-0 authority synchronously with the durable commit, delete
  // its receipts, and leave a newly loaded scan locked.
  const sourceRevisionRevoked = await page.evaluate(async function () {
    const original = await CoachStore.getGame('phase5-review-ui');
    let invalidations = 0;
    function invalidated(e) {
      if (e.detail && e.detail.gameId === original.id) invalidations++;
    }
    document.addEventListener(
      'chessy:reflectionsourceinvalidated', invalidated);
    const revised = Object.assign({}, original, {
      clocks: [
        { thinkMs: 1000, wMs: 59000, bMs: 60000 },
        { thinkMs: 1200, wMs: 59000, bMs: 58800 },
        { thinkMs: 900, wMs: 58100, bMs: 58800 },
        { thinkMs: 1100, wMs: 58100, bMs: 57700 }
      ],
      timeControl: '60+1',
      createdAt: original.createdAt + 1
    });
    const changed = CoachStore.reflectionSourceRevision(original) !==
      CoachStore.reflectionSourceRevision(revised);
    await CoachStore.archiveGame(revised);
    document.removeEventListener(
      'chessy:reflectionsourceinvalidated', invalidated);
    return {
      changed: changed,
      invalidations: invalidations,
      stateNull: ChessyMomentScan.state() === null,
      scores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      receipts: (await CoachStore.exportAll()).stores.reflectionReceipts
        .filter(function (r) { return r.gameId === original.id; }).length
    };
  });
  check(sourceRevisionRevoked.changed &&
        sourceRevisionRevoked.invalidations === 1 &&
        sourceRevisionRevoked.stateNull &&
        sourceRevisionRevoked.scores === 0 &&
        sourceRevisionRevoked.receipts === 0,
    'clock/time-control revision revokes the loaded report and durable receipts');

  await page.evaluate(function () {
    return CoachReview.openArchivedGame('phase5-review-ui');
  });
  await page.waitForFunction(function () {
    const state = ChessyMomentScan.state();
    return state && state.state === 'idle';
  });
  const revisedSourceLocked = await page.evaluate(async function () {
    const state = ChessyMomentScan.state();
    const game = await CoachStore.getGame('phase5-review-ui');
    return {
      completed: state.reflectionCompleted,
      unlocked: state.reportUnlocked,
      report: Object.prototype.hasOwnProperty.call(state, 'report'),
      scores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      receipts: (await CoachStore.listValidReflectionReceipts(game)).length
    };
  });
  check(revisedSourceLocked.completed === 0 &&
        revisedSourceLocked.unlocked === false &&
        revisedSourceLocked.report === false &&
        revisedSourceLocked.scores === 0 &&
        revisedSourceLocked.receipts === 0,
    'the revised source loads with Gate 0 locked until a new reflection');

  // Rebuild recomputable scan work for the revised source so later lifecycle
  // checks exercise a completed current-source job. Reanalysis must not
  // recreate the deleted user-action receipts or unlock any score.
  await page.evaluate(function () {
    return ChessyMomentScan.start(CoachReview.current(), { restart: true });
  });
  await page.waitForFunction(function () {
    const state = ChessyMomentScan.state();
    return state && state.state === 'done';
  });
  const revisedSourceRescanned = await page.evaluate(async function () {
    const state = ChessyMomentScan.state();
    const game = await CoachStore.getGame('phase5-review-ui');
    return {
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      report: Object.prototype.hasOwnProperty.call(state, 'report'),
      receipts: (await CoachStore.listValidReflectionReceipts(game)).length
    };
  });
  check(revisedSourceRescanned.unlocked === false &&
        revisedSourceRescanned.completed === 0 &&
        revisedSourceRescanned.report === false &&
        revisedSourceRescanned.receipts === 0,
    'rescanning the revised source cannot recreate reflection authority');

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
    const start = document.getElementById('scanStart');
    return !start.hidden && !start.disabled && start.textContent === 'Start scan';
  });
  check(await page.locator('#scanMomentList .scan-moment').count() === 0 &&
        await page.locator('#scanSuggestions').isHidden() &&
        await page.locator('#scanResume').isHidden(),
    'a same-id source revision cannot repaint or resume the previous game’s work');

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
