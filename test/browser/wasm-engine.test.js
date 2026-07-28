/*
 * Experimental Rust/WASM engine toggle (#84/#113 flagged rollout): default
 * OFF (JavaScript answers), opt-in via the New Game dialog, per-move engine
 * provenance in the live save, page-level persistence across reloads, and
 * in-worker fallback to JavaScript when the module cannot be used.
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
  function firstAi() {
    return page.evaluate(function () {
      return {
        release: window.CHESSY_RELEASE,
        ai: JSON.parse(localStorage.getItem('chessy-game-v1')).history[0].ai
      };
    });
  }

  // ---- Default OFF: the JavaScript engine answers, labelled as such ----
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await waitForFirstAiMove();
  const defaultRun = await firstAi();
  check(defaultRun.ai.engine === 'js' && defaultRun.ai.engineFallback === null &&
      defaultRun.ai.source === 'worker',
    'default games use the JavaScript engine and record it');
  const defaultUnchecked = await page.evaluate(function () {
    document.getElementById('newGame').click();
    const checked = document.getElementById('engineWasm').checked;
    document.getElementById('newGameCancel').click();
    return !checked;
  });
  check(defaultUnchecked, 'the experimental-engine checkbox starts unchecked');

  // ---- Opt in through the dialog: the WASM engine answers ----
  await page.click('#newGame');
  await page.click('#engineWasm + span');
  await t.pick('mode', 'ai-w');
  await t.pick('difficulty', '1');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitForFirstAiMove();
  const wasmRun = await firstAi();
  check(wasmRun.ai.engine === 'wasm' && wasmRun.ai.engineFallback === null &&
      wasmRun.ai.source === 'worker' && wasmRun.ai.fallbackReason === null,
    'opted-in games record the WASM engine with no fallback');
  check(wasmRun.ai.release === wasmRun.release &&
      wasmRun.ai.depth === 1 && wasmRun.ai.maxDepth === 1 &&
      wasmRun.ai.stopReason === 'max-depth' &&
      Number.isInteger(wasmRun.ai.nodes) && wasmRun.ai.nodes > 0 &&
      wasmRun.ai.scorePov === 'white',
    'WASM telemetry carries release, budget, depth and counters like JS');
  check(Array.isArray(wasmRun.ai.pvUci) && wasmRun.ai.pvUci.length === 0 &&
      !Object.prototype.hasOwnProperty.call(wasmRun.ai, 'rootOrderUci'),
    'WASM raw-ABI evidence honestly omits PV and captured root order');
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
    'the debug PGN log names the WASM engine for opted-in moves');

  // ---- The preference is page-level and survives a reload ----
  await page.reload();
  await page.waitForSelector('#board .square');
  const persisted = await page.evaluate(function () {
    document.getElementById('newGame').click();
    const checked = document.getElementById('engineWasm').checked;
    document.getElementById('newGameCancel').click();
    return checked;
  });
  check(persisted, 'the experimental-engine preference survives a reload');

  // ---- In-worker fallback: an unusable module answers with JavaScript ----
  // ai.js fetches with HTTP 200 but is not WebAssembly, so instantiation
  // fails and the worker must answer with the JS engine, labelled.
  const fallback = await page.evaluate(function () {
    const release = window.CHESSY_RELEASE || '';
    return new Promise(function (resolve, reject) {
      const w = new Worker('assets/ai-worker.js' + (release ? '?r=' + release : ''));
      const timer = setTimeout(function () {
        w.terminate();
        reject(new Error('worker did not answer'));
      }, 15000);
      w.onmessage = function (e) {
        clearTimeout(timer);
        w.terminate();
        resolve(e.data);
      };
      w.postMessage({
        id: 1,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        maxDepth: 1, timeMs: 10000, quiesce: false, randomize: true,
        engine: 'wasm',
        wasmUrl: 'ai.js' + (release ? '?r=' + release : '')
      });
    });
  });
  check(fallback.engine === 'js' &&
      fallback.engineFallback === 'wasm-load-error' &&
      !!fallback.move && fallback.depth === 1,
    'an unusable module falls back to the JavaScript engine, labelled');
});
