/*
 * Rust/WASM-only Play backend: successful moves come only from the worker,
 * JavaScript selection/fallback UI is absent, and legacy JavaScript telemetry
 * remains readable after the runtime migration.
 */
'use strict';
require('./helper').run('wasm-engine', async function (t) {
  const page = t.page, check = t.check;

  function waitForFirstAiMove() {
    return page.waitForFunction(function () {
      const raw = localStorage.getItem('chessy-game-v1');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      return saved.history && saved.history[0] && saved.history[0].ai;
    }, null, { timeout: 10000 });
  }

  // A stale opt-out from r70 is inert; there is no longer an engine choice.
  await page.evaluate(function () {
    localStorage.setItem('chessy-wasm-engine-v1', 'off');
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await waitForFirstAiMove();
  const run = await page.evaluate(function () {
    return {
      release: window.CHESSY_RELEASE,
      ai: JSON.parse(localStorage.getItem('chessy-game-v1')).history[0].ai,
      hasChoice: !!document.getElementById('engineWasm'),
      hasAlgorithm: typeof ChessAI !== 'undefined'
    };
  });
  check(run.ai.engine === 'wasm' && run.ai.engineFallback === null &&
      run.ai.source === 'worker' && run.ai.fallbackReason === null,
    'Play records only a worker-produced Rust/WASM move');
  check(run.ai.release === run.release &&
      run.ai.maxDepth === 30 && run.ai.nodeLimit === 10000 &&
      run.ai.timeMs === 5000 && run.ai.quiesce === true &&
      run.ai.nodes === run.ai.nodeLimit &&
      run.ai.stopReason === 'node-limit' &&
      run.ai.depth >= 1 &&
      run.ai.attemptedDepth === run.ai.depth + 1 &&
      run.ai.scorePov === 'white',
    'WASM telemetry carries the Easy budget and counters');
  check(Array.isArray(run.ai.pvUci) && run.ai.pvUci.length === 0 &&
      !Object.prototype.hasOwnProperty.call(run.ai, 'rootOrderUci'),
    'the v2 Play result honestly omits PV and captured root order');
  check(!run.hasChoice && !run.hasAlgorithm,
    'the engine opt-out and production JavaScript search global are absent');

  const debugPgn = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    let s = Chess.newGameState();
    saved.history.forEach(function (entry, i) {
      const move = Chess.legalMoves(s).find(function (m) {
        return m.from === entry.move.from && m.to === entry.move.to &&
          (m.promotion || null) === (entry.move.promotion || null);
      });
      s = Chess.playMove(s, move);
      s.history[i].ai = entry.ai;
    });
    return Chess.toPgn(s, {}, true);
  });
  check(debugPgn.includes('engine wasm') &&
      !debugPgn.includes('engine-fallback'),
    'the debug PGN log names only the WASM engine');

  const workerFailures = await page.evaluate(function () {
    const release = window.CHESSY_RELEASE || '';
    function ask(fen, wasmAsset) {
      return new Promise(function (resolve, reject) {
        const worker = new Worker('assets/ai-worker.js' +
          (release ? '?r=' + release : ''));
        const timer = setTimeout(function () {
          worker.terminate();
          reject(new Error('worker failure probe timed out'));
        }, 10000);
        worker.onmessage = function (event) {
          clearTimeout(timer);
          worker.terminate();
          resolve(event.data);
        };
        worker.postMessage({
          id: 7, fen: fen, maxDepth: 1, timeMs: 1000,
          nodeLimit: 1000, quiesce: false, positions: {},
          wasmUrl: wasmAsset + (release ? '?r=' + release : '')
        });
      });
    }
    return Promise.all([
      ask(Chess.START_FEN, 'ai-telemetry.js'),
      ask('not a fen', 'chessy-ai-fast.wasm')
    ]);
  });
  check(workerFailures[0].error === 'wasm-load-error' &&
      !workerFailures[0].move && !workerFailures[0].engine,
    'a WASM load failure returns no substitute move');
  check(workerFailures[1].error === 'wasm-search-error' &&
      !workerFailures[1].move && !workerFailures[1].engine,
    'a WASM search failure returns no substitute move');

  // A pre-r71 live save may legitimately contain the retired paths. Restoring
  // it must preserve—not relabel—its forensic provenance.
  await t.inject(function () {
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      history: [{
        move: { from: 52, to: 36, promotion: null },
        san: 'e4',
        ai: {
          release: 'r70', depth: 3, attemptedDepth: 4, maxDepth: 30,
          quiesce: true, timeMs: 5000, nodeLimit: 10000,
          ms: 812, elapsedMs: 812, searchMs: 123,
          nodes: 10000, qnodes: 5000, cutoffs: 10, researches: 1,
          score: 20, scorePov: 'white', pvUci: [],
          stopReason: 'node-limit', source: 'sync-fallback',
          fallbackReason: 'watchdog', engine: 'js',
          engineFallback: 'wasm-load-error'
        }
      }],
      positions: {},
      mode: 'pvp', difficulty: '1', timeControl: 'none'
    }));
  });
  const legacy = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).history[0].ai;
  });
  check(legacy.engine === 'js' &&
      legacy.engineFallback === 'wasm-load-error' &&
      legacy.source === 'sync-fallback' &&
      legacy.fallbackReason === 'watchdog',
    'legacy JS/fallback telemetry remains accepted without changing provenance');
});
