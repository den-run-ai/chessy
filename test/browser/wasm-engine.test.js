/*
 * Rust/WASM Play backend (#84/#113): default ON, explicit standard-engine
 * opt-out, per-move engine provenance in the live save, page-level preference
 * persistence across reloads, and in-worker fallback to JavaScript when the
 * module cannot be used.
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

  // ---- Default ON: the WASM engine answers, labelled as such ----
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await waitForFirstAiMove();
  const defaultRun = await firstAi();
  check(defaultRun.ai.engine === 'wasm' && defaultRun.ai.engineFallback === null &&
      defaultRun.ai.source === 'worker' && defaultRun.ai.fallbackReason === null,
    'default games use the Rust/WASM engine and record it');
  check(defaultRun.ai.release === defaultRun.release &&
      defaultRun.ai.maxDepth === 30 && defaultRun.ai.nodeLimit === 10000 &&
      defaultRun.ai.timeMs === 5000 && defaultRun.ai.quiesce === true &&
      defaultRun.ai.nodes === defaultRun.ai.nodeLimit &&
      defaultRun.ai.stopReason === 'node-limit' &&
      defaultRun.ai.depth >= 1 &&
      defaultRun.ai.attemptedDepth === defaultRun.ai.depth + 1 &&
      defaultRun.ai.scorePov === 'white',
    'WASM telemetry carries the recalibrated Easy budget and counters');
  check(Array.isArray(defaultRun.ai.pvUci) && defaultRun.ai.pvUci.length === 0 &&
      !Object.prototype.hasOwnProperty.call(defaultRun.ai, 'rootOrderUci'),
    'WASM raw-ABI evidence honestly omits PV and captured root order');
  const defaultChecked = await page.evaluate(function () {
    document.getElementById('newGame').click();
    const checked = document.getElementById('engineWasm').checked;
    document.getElementById('newGameCancel').click();
    return checked;
  });
  check(defaultChecked, 'the faster-engine checkbox starts checked');

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
    'the debug PGN log names the default WASM engine');

  // ---- Opt out through the dialog: the standard engine answers ----
  await page.click('#newGame');
  await page.click('#engineWasm + span');
  await t.pick('mode', 'ai-w');
  await t.pick('difficulty', '1');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await waitForFirstAiMove();
  const jsRun = await firstAi();
  check(jsRun.ai.engine === 'js' && jsRun.ai.engineFallback === null &&
      jsRun.ai.source === 'worker',
    'opted-out games use the standard engine and record it');

  // ---- The preference is page-level and survives a reload ----
  await page.reload();
  await page.waitForSelector('#board .square');
  const persisted = await page.evaluate(function () {
    document.getElementById('newGame').click();
    const checked = document.getElementById('engineWasm').checked;
    document.getElementById('newGameCancel').click();
    return !checked;
  });
  check(persisted, 'the standard-engine opt-out survives a reload');

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
