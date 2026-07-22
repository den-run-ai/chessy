/*
 * Coaching-analysis service (Phase 3a) in a real browser: a dedicated Web
 * Worker runs the contract off the main thread, and validated results round-trip
 * through the IndexedDB analyses store. Verifies parity with a direct core call,
 * a real cache hit that skips dispatch, a SetUp/FEN (non-standard) position,
 * preservation of complete:false, and that the heavy search never runs on the
 * page's main thread.
 */
'use strict';
require('./helper').run('analysis-service', async function (t) {
  const page = t.page, check = t.check;

  const FAST = { maxDepth: 3, nodeLimit: 8000, multiPV: 3, nodeBudget: 200000 };

  // --- Worker result parity: identical to a direct analysis-core call ---
  const parity = await page.evaluate(async function (opts) {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const viaWorker = await ChessyAnalysisService.analyse(
      { gameId: 'parity', ply: 1, gameRev: 1, fen: fen, opts: opts });
    const direct = ChessyAnalysisCore.analyse(Chess.parseFen(fen), opts);
    const norm = function (r) { const c = JSON.parse(JSON.stringify(r)); c.elapsedMs = 0; return JSON.stringify(c); };
    return { equal: !!viaWorker && norm(viaWorker) === norm(direct), lines: viaWorker ? viaWorker.bestLines.length : -1 };
  }, FAST);
  check(parity.equal && parity.lines > 0,
    'the worker result is byte-identical to a direct analysis-core call (excluding elapsed)');

  // --- Real IndexedDB cache: a repeat request is a hit that dispatches nothing ---
  const cache = await page.evaluate(async function (opts) {
    const req = { gameId: 'cache-1', ply: 2, gameRev: 1, fen: Chess.START_FEN, opts: opts };
    const before = ChessyAnalysisService.stats().dispatches;
    const r1 = await ChessyAnalysisService.analyse(req);
    // The cache write is best-effort (not awaited by analyse); wait for it.
    const ident = ChessyAnalysisCore.identity(Chess.parseFen(Chess.START_FEN), opts);
    const key = CoachStore.analysisKey(req.gameId, req.ply, ident.positionFingerprint, ident.engineId, ident.configHash);
    let rec = null;
    for (let i = 0; i < 200 && !rec; i++) { rec = await CoachStore.getAnalysis(key); if (!rec) await new Promise(function (r) { setTimeout(r, 20); }); }
    const mid = ChessyAnalysisService.stats().dispatches;
    const r2 = await ChessyAnalysisService.analyse(req);
    const after = ChessyAnalysisService.stats().dispatches;
    const norm = function (r) { const c = JSON.parse(JSON.stringify(r)); c.elapsedMs = 0; return JSON.stringify(c); };
    return { firstDispatched: mid === before + 1, hitNoDispatch: after === mid,
      persisted: !!rec && rec.gameRev === 1, same: !!r1 && !!r2 && norm(r1) === norm(r2) };
  }, FAST);
  check(cache.firstDispatched && cache.persisted && cache.hitNoDispatch && cache.same,
    'a repeat request is served from the IndexedDB cache with no new worker dispatch');

  // --- A SetUp/FEN (non-standard) historic position analyzes correctly ---
  const setup = await page.evaluate(async function () {
    const fen = '8/8/8/8/8/5k2/8/R6K w - - 0 1'; // K+R vs K, White to move
    const r = await ChessyAnalysisService.analyse(
      { gameId: 'setup', ply: 0, gameRev: 1, fen: fen,
        opts: { maxDepth: 4, nodeLimit: 12000, multiPV: 50, nodeBudget: 400000 } });
    const legal = Chess.legalMoves(Chess.parseFen(fen)).length;
    let allLegal = true;
    for (const l of r.bestLines) {
      let st = Chess.parseFen(fen);
      for (const u of l.pvUci) {
        const mv = Chess.legalMoves(st).find(function (m) {
          return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : '') === u;
        });
        if (!mv) { allLegal = false; break; }
        st = Chess.applyMove(st, mv);
      }
    }
    return { turn: r.turn, count: r.bestLines.length, legal: legal, allLegal: allLegal };
  });
  check(setup.turn === 'w' && setup.count === setup.legal && setup.allLegal,
    'a SetUp/FEN historic position analyzes correctly (real MultiPV, every PV replays legally)');

  // --- complete:false is preserved through the worker and the cache ---
  const partial = await page.evaluate(async function () {
    const opts = { maxDepth: 4, nodeLimit: 8000, multiPV: 3, nodeBudget: 1 }; // tiny budget aborts deep-verify
    const req = { gameId: 'partial', ply: 0, gameRev: 1, fen: Chess.START_FEN, opts: opts };
    const r = await ChessyAnalysisService.analyse(req);
    const ident = ChessyAnalysisCore.identity(Chess.parseFen(Chess.START_FEN), opts);
    const key = CoachStore.analysisKey(req.gameId, req.ply, ident.positionFingerprint, ident.engineId, ident.configHash);
    let rec = null;
    for (let i = 0; i < 200 && !rec; i++) { rec = await CoachStore.getAnalysis(key); if (!rec) await new Promise(function (r) { setTimeout(r, 20); }); }
    return { res: r && r.complete, rec: rec && rec.complete, recResult: rec && rec.result && rec.result.complete };
  });
  check(partial.res === false && partial.rec === false && partial.recResult === false,
    'a partial (complete:false) result is preserved through the worker and the cache, never marked complete');

  // --- The heavy search runs ONLY in the worker: the page main thread never
  //     invokes ChessyAnalysisCore.analyse (patched here as a tripwire). ---
  const offMain = await page.evaluate(async function (opts) {
    let calls = 0;
    const real = ChessyAnalysisCore.analyse;
    ChessyAnalysisCore.analyse = function () { calls++; return real.apply(this, arguments); };
    const r = await ChessyAnalysisService.analyse(
      { gameId: 'offmain', ply: 0, gameRev: 1, fen: Chess.START_FEN, opts: opts });
    ChessyAnalysisCore.analyse = real;
    return { ran: !!r && r.bestLines.length > 0, mainCalls: calls };
  }, FAST);
  check(offMain.ran && offMain.mainCalls === 0,
    'the heavy contract search runs only in the worker; the page main thread never invokes it');
});
