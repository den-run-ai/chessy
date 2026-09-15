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
      playerColor: 'both',
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
    while (!ChessyMomentScan.state() ||
           ChessyMomentScan.state().state !== 'idle') {
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    const calls = [];
    const events = [];
    document.addEventListener('chessy:scanchange', function (e) {
      events.push(e.detail);
    });

    // Controlled async boundaries keep this integration test fast. The result
    // still carries real analysis provenance/line shapes so the production
    // notation policy and durable summary boundary run unchanged.
    const realAnalyse = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function (req, owner) {
      calls.push({ ply: req.ply, nodeLimit: req.opts.nodeLimit, owner: owner });
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
      const line = function (move, moverScore, rank, amongCandidates) {
        const san = Chess.toSan(state, move, legal);
        const uci = Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '');
        return {
          move: move,
          uci: uci,
          san: san,
          scoreCpWhite: whiteScore(moverScore),
          scoreCpPlayer: moverScore,
          mate: null,
          pv: [san],
          pvUci: [uci],
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

    const done = await ChessyMomentScan.start(CoachReview.current(), { restart: true });
    const stored = await CoachStore.getJob(game.id);
    const cards = await CoachStore.listCards();

    ChessyAnalysisService.analyse = realAnalyse;

    return {
      loaded: !!ChessyAnalysisResult && !!ChessyMomentSelector &&
        !!ChessyAnalysisNotation && !!ChessyMomentScan,
      doneState: done.state,
      callPlies: calls.map(function (c) { return c.ply; }).join(','),
      quickCalls: calls.filter(function (c) { return c.nodeLimit !== 80000; }).length,
      deepCalls: calls.filter(function (c) { return c.nodeLimit === 80000; }).length,
      owners: calls.every(function (c) { return c.owner === 'moment-scan'; }),
      storedState: stored && stored.state,
      storedSchema: stored && stored.schema,
      storedMoments: stored && stored.moments,
      storedSummaries: stored && stored.moveSummaries,
      storedDeepResults: stored && stored.deepResults,
      storedQuickResults: stored && stored.quickResults,
      storedQuickEvidence: stored && stored.quickEvidence,
      storedQuickSummaries: stored && stored.quickSummaries,
      publicMoments: ChessyMomentScan.state().moments,
      publicReport: ChessyMomentScan.state().report,
      historyButtons: document.querySelectorAll('#reviewMoveList .review-ply:not(.empty)').length,
      historyText: document.getElementById('reviewMoveList').textContent,
      visibleScores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      visibleMarks: document.querySelectorAll('#reviewMoveList .review-nag').length,
      startLeaked: /internalScore|candidates|shortlist|bestUtility|loss|scoreCpWhite|annotation/.test(
        JSON.stringify(done)),
      leaked: events.some(function (e) {
        const text = JSON.stringify(e);
        return /internalScore|loss|bestMove|bestUtility|playedUtility|defensive|collapse|scoreCpWhite|annotation/.test(text);
      }),
      cardCount: cards.length
    };
  });

  check(outcome.loaded, 'analysis, notation and scan modules load in release order');
  check(outcome.doneState === 'done' && outcome.storedState === 'done',
    'a completed scan is durably checkpointed in analysisJobs');
  check(outcome.callPlies === '0,1,2,3,0,1' &&
        outcome.quickCalls === 4 && outcome.deepCalls === 2,
    'the browser controller scores every move then deep-checks two side-separated decisions');
  check(outcome.owners,
    'every batch request carries moment-scan ownership');
  check(outcome.storedMoments.length === 2 && outcome.publicMoments.length === 2 &&
        Object.keys(outcome.publicMoments[0]).sort().join(',') === 'playedSan,ply',
    'public proposals contain only move location and played SAN');
  check(outcome.storedSummaries.length === 4 && outcome.publicReport === undefined,
    'score summaries persist privately without crossing Gate 0');
  check(outcome.storedSchema === 3 && outcome.storedDeepResults.length === 2 &&
        outcome.storedQuickResults.length === 4 &&
        outcome.storedDeepResults.every(function (row) {
          return row.resultPolicy === 'critical-deep-result-v1' &&
            row.result && row.result.stability.bestMoveStable === true;
        }) &&
        outcome.storedQuickEvidence.length === 4 &&
        outcome.storedQuickSummaries.length === 4 &&
        outcome.storedQuickResults.every(function (row) {
          return row.resultPolicy === 'critical-quick-result-v1' &&
            row.result && row.result.complete === true &&
            !Object.prototype.hasOwnProperty.call(row.result, 'internalScore');
        }) &&
        outcome.storedQuickEvidence.every(function (row) {
          return typeof row.bestUci === 'string' && typeof row.bestSan === 'string' &&
            row.profile.indexOf('quick') === 0;
        }),
    'schema-v3 checkpoints retain full validated quick/deep results for exact reload');
  check(!outcome.leaked && !outcome.startLeaked,
    'events and start() never leak internal score/category/better-move evidence');
  check(outcome.historyButtons === 4 &&
        /f3/.test(outcome.historyText) && /e5/.test(outcome.historyText) &&
        /g4/.test(outcome.historyText) && /Qh4#/.test(outcome.historyText) &&
        outcome.visibleScores === 0 && outcome.visibleMarks === 0,
    'the complete SAN ledger is visible while score and annotation overlays stay hidden');
  check(outcome.cardCount === 0,
    'scanning creates no lesson cards automatically');

  const forgedJob = await page.evaluate(async function () {
    const review = CoachReview.current();
    const job = await CoachStore.getJob(review.game.id);
    job.reflected = job.moments.map(function (moment) {
      return { ply: moment.ply, playedSan: moment.playedSan };
    });
    await CoachStore.putJob(job);
    ChessyMomentScan.invalidate();
    const state = await ChessyMomentScan.load(review);
    const normalized = await CoachStore.getJob(review.game.id);
    return {
      report: state.report,
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      retained: Object.prototype.hasOwnProperty.call(normalized, 'reflected')
    };
  });
  check(forgedJob.report === undefined && forgedJob.unlocked === false &&
        forgedJob.completed === 0 && forgedJob.retained === false,
    'forged analysisJobs.reflected rows cannot unlock and are discarded');

  const firstReveal = await page.evaluate(async function () {
    const review = CoachReview.current();
    const reflection = ChessyCalculation.build(review.states[0], {
      threatKind: 'none', candidateStatus: 'none',
      calculationStatus: 'none', evaluation: 'unclear'
    }).value;
    await ChessyMomentScan.recordReflection(review, 0, reflection);
    const state = ChessyMomentScan.state();
    return {
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      report: state.report,
      scores: Array.from(document.querySelectorAll('#reviewMoveList .review-eval'))
        .map(function (node) { return node.textContent; }),
      marks: Array.from(document.querySelectorAll('#reviewMoveList .review-nag.chessy'))
        .map(function (node) { return node.textContent; })
    };
  });
  check(firstReveal.unlocked === false && firstReveal.completed === 1 &&
        firstReveal.report.length === 1 && firstReveal.report[0].ply === 0 &&
        firstReveal.scores.join('|') === '-3.5' &&
        firstReveal.marks.join('|') === 'Chessy ??',
    'one reflection reveals only that row’s White-POV score and deep annotation');

  const tamperedReceipt = await page.evaluate(async function () {
    await new Promise(function (resolve, reject) {
      const open = indexedDB.open('chessy-coach');
      open.onsuccess = function () {
        const db = open.result;
        const t = db.transaction('reflectionReceipts', 'readwrite');
        const index = t.objectStore('reflectionReceipts').index('gameId');
        const cursor = index.openCursor(IDBKeyRange.only('phase5-browser'));
        cursor.onsuccess = function () {
          const c = cursor.result;
          if (!c) return;
          const row = c.value;
          row.playedSan = 'forged';
          c.update(row);
        };
        t.oncomplete = function () { db.close(); resolve(); };
        t.onerror = function () { reject(t.error); };
      };
      open.onerror = function () { reject(open.error); };
    });
    const review = CoachReview.current();
    ChessyMomentScan.invalidate();
    const state = await ChessyMomentScan.load(review);
    const raw = await new Promise(function (resolve, reject) {
      const open = indexedDB.open('chessy-coach');
      open.onsuccess = function () {
        const db = open.result;
        const t = db.transaction('reflectionReceipts', 'readonly');
        const req = t.objectStore('reflectionReceipts').index('gameId')
          .getAll(IDBKeyRange.only('phase5-browser'));
        req.onsuccess = function () { resolve(req.result); db.close(); };
        req.onerror = function () { reject(req.error); };
      };
      open.onerror = function () { reject(open.error); };
    });
    return {
      completed: state.reflectionCompleted,
      report: state.report,
      preserved: raw.length === 1 && raw[0].playedSan === 'forged'
    };
  });
  check(tamperedReceipt.completed === 0 && tamperedReceipt.report === undefined &&
        tamperedReceipt.preserved,
    'reload replays receipts, quarantining but preserving a malformed row');

  // A genuine resubmission replaces the damaged exact-revision/ply record.
  await page.evaluate(async function () {
    const review = CoachReview.current();
    const reflection = ChessyCalculation.build(review.states[0], {
      threatKind: 'none', candidateStatus: 'none',
      calculationStatus: 'none', evaluation: 'unclear'
    }).value;
    await ChessyMomentScan.recordReflection(review, 0, reflection);
  });

  const fullReveal = await page.evaluate(async function () {
    const review = CoachReview.current();
    const reflection = ChessyCalculation.build(review.states[1], {
      threatKind: 'none', candidateStatus: 'none',
      calculationStatus: 'none', evaluation: 'unclear'
    }).value;
    await ChessyMomentScan.recordReflection(review, 1, reflection);
    const state = ChessyMomentScan.state();
    return {
      unlocked: state.reportUnlocked,
      completed: state.reflectionCompleted,
      required: state.reflectionRequired,
      report: state.report,
      scores: Array.from(document.querySelectorAll('#reviewMoveList .review-eval'))
        .map(function (node) { return node.textContent; }),
      marks: Array.from(document.querySelectorAll('#reviewMoveList .review-nag.chessy'))
        .map(function (node) { return node.textContent; })
    };
  });
  check(fullReveal.unlocked === true &&
        fullReveal.completed === fullReveal.required &&
        fullReveal.report.length === 4 &&
        fullReveal.scores.join('|') === '-3.5|+0.5|≈ -0.5|≈ +0.5' &&
        fullReveal.marks.join('|') === 'Chessy ??|Chessy ?!',
    'all required structured reflections unlock the complete score trail');

  // Reload destroys the in-memory controller owner but not the durable job or
  // its revision-bound structured-reflection receipts.
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
      report: state && state.report,
      unlocked: state && state.reportUnlocked,
      scores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      stored: await CoachStore.getJob('phase5-browser')
    };
  });
  check(reloaded.state === 'done' && reloaded.stored &&
        reloaded.stored.state === 'done' &&
        reloaded.moments.length === 2 && reloaded.unlocked === true &&
        reloaded.report.length === 4 && reloaded.scores === 4,
    'completed proposals and the reflected score trail survive a real page reload');

  const revoked = await page.evaluate(async function () {
    await CoachStore.archiveGame({
      id: 'phase5-browser', source: 'play', tags: {},
      sans: ['e4', 'e5'], playerColor: 'w', clocks: [null, null],
      result: '*', reason: 'revised', mode: 'pvp', difficulty: '2',
      timeControl: 'none', plies: 2, createdAt: 2
    });
    const exported = await CoachStore.exportAll();
    return {
      state: ChessyMomentScan.state(),
      scores: document.querySelectorAll('#reviewMoveList .review-eval').length,
      receipts: exported.stores.reflectionReceipts.filter(function (receipt) {
        return receipt.gameId === 'phase5-browser';
      }).length
    };
  });
  check(revoked.state === null && revoked.scores === 0 && revoked.receipts === 0,
    'a same-id archive revision revokes loaded Gate-0 authority on commit');
});
