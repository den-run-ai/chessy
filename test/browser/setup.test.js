/* New Game dialog, validated localStorage restore, offline status note. */
'use strict';
require('./helper').run('setup', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  check((await page.textContent('#setupSummary')).includes('White vs computer'), 'summary shows default mode');
  check((await page.textContent('#setupSummary')).includes('Medium'), 'summary shows default difficulty');

  // Cancel must not change anything.
  await page.click('#newGame');
  check(await page.locator('#newGameDialog[open]').count() === 1, 'New game opens the setup dialog');
  await t.pick('mode', 'pvp');
  await t.pick('difficulty', 'master');
  await page.click('#newGameCancel');
  check((await page.textContent('#setupSummary')).includes('White vs computer · Medium'),
    'cancelling the dialog keeps the current settings');

  // Start applies the settings and resets the game.
  await t.newGame({ mode: 'pvp' });
  check((await page.textContent('#setupSummary')).trim() === 'Two players', 'pvp summary has no difficulty');
  check(await page.locator('#moveList .ply').count() === 0, 'starting resets the game');

  // A game in progress survives opening+cancelling the dialog.
  await mv('e2', 'e4');
  await page.click('#newGame');
  await page.click('#newGameCancel');
  check(await page.locator('#moveList .ply').count() === 1, 'cancelled dialog leaves the game untouched');

  // The release check is asynchronous. Rapid Start clicks coalesce at the
  // runtime layer and are generation-fenced here; cancelling while the check
  // is pending must prevent every queued callback from replacing the game.
  const activeId = await page.evaluate(function () {
    window.__realChessyRuntime = window.ChessyRuntime;
    window.__installRuntimeCheck = function () {
      window.__runtimeCheck = new Promise(function (resolve) {
        window.__resolveRuntimeCheck = resolve;
      });
      window.ChessyRuntime = {
        ensureCurrent: function () { return window.__runtimeCheck; }
      };
    };
    window.__installRuntimeCheck();
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.click('#newGameStart');
  await page.click('#newGameCancel');
  await page.evaluate(function () { window.__resolveRuntimeCheck(true); });
  await page.waitForTimeout(0);
  const cancelled = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: saved.gameId, plies: saved.history.length };
  });
  check(cancelled.id === activeId && cancelled.plies === 1,
    'Cancel fences concurrent pending Start clicks');

  // Without cancellation, only the latest concurrent Start callback acts.
  const canCountUuids = await page.evaluate(function () {
    window.__installRuntimeCheck();
    window.__uuidCalls = 0;
    try {
      window.__realRandomUUID = crypto.randomUUID;
      crypto.randomUUID = function () {
        window.__uuidCalls++;
        return '00000000-0000-4000-8000-' + String(window.__uuidCalls).padStart(12, '0');
      };
      return crypto.randomUUID !== window.__realRandomUUID;
    } catch (e) {
      return false;
    }
  });
  await page.click('#newGame');
  await page.click('#newGameStart');
  await page.click('#newGameStart');
  await page.evaluate(function () { window.__resolveRuntimeCheck(true); });
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  const concurrent = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    const out = { plies: saved.history.length, uuidCalls: window.__uuidCalls };
    if (window.__realRandomUUID) crypto.randomUUID = window.__realRandomUUID;
    window.ChessyRuntime = window.__realChessyRuntime;
    return out;
  });
  check(concurrent.plies === 0 && (!canCountUuids || concurrent.uuidCalls === 1),
    'concurrent Start clicks create exactly one new game');

  await t.newGame({});

  // Persistence round-trip.
  await mv('e2', 'e4'); await mv('e7', 'e5'); await mv('g1', 'f3');
  await page.reload();
  await page.waitForSelector('#board .square');
  check(await page.locator('#moveList .ply').count() === 3, 'reload restores the game (3 plies)');
  check((await page.textContent('#setupSummary')).trim() === 'Two players', 'reload restores the settings');

  // Tampered FEN: final position no longer matches the replayed moves.
  await t.inject(function () {
    const d = JSON.parse(localStorage.getItem('chessy-game-v1'));
    d.fen = d.fen.replace(' b ', ' w ');
    localStorage.setItem('chessy-game-v1', JSON.stringify(d));
  });
  check(await page.locator('#moveList .ply').count() === 0, 'tampered FEN rejected -> fresh game');

  // Illegal recorded move: replay validation rejects the save.
  await t.inject(function () {
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      history: [{ move: { from: 0, to: 32 }, san: 'Ra4' }],
      mode: 'pvp', difficulty: '2'
    }));
  });
  check(await page.locator('#moveList .ply').count() === 0, 'illegal recorded move rejected -> fresh game');

  // Garbage JSON: rejected without breaking boot.
  await t.inject(function () {
    localStorage.setItem('chessy-game-v1', '{"fen": 42, "history": "x"');
  });
  check((await page.textContent('#status')).includes('to move'), 'garbage save rejected, app boots normally');

  // A valid save (with AI metadata) is restored, including settings.
  await t.inject(function () {
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      history: [{ move: { from: 52, to: 36, promotion: null }, san: 'e4',
                  ai: { depth: 3, quiesce: false, ms: 120 } }],
      mode: 'ai-w', difficulty: '3'
    }));
  });
  check(await page.locator('#moveList .ply').count() === 1, 'valid single-move save restored');
  check((await page.textContent('#setupSummary')).includes('Black vs computer · Hard'),
    'mode/difficulty restored from save');

  // Offline status reaches a real "ready" state via a service-worker
  // install (localhost is a secure context; the origin is fresh per run).
  await page.waitForFunction(function () {
    return document.getElementById('installNote').textContent.includes('Ready offline');
  }, null, { timeout: 15000 });
  check(true, 'offline note reaches "Ready offline" after SW install');
  // Worker failures retry the SAME AI move synchronously, so their recorded
  // timing must include time already spent waiting for the worker. This
  // controllable stub first fails loudly, then stays alive but silent; it
  // affects every later navigation, so these tests must stay LAST.
  await page.addInitScript(function () {
    window.__chessyTestWorkerCount = 0;
    window.Worker = function () {
      const worker = this;
      window.__chessyTestWorkerCount++;
      // 'birth-error' workers fail on LOAD, before any message — the
      // persistently-unloadable-script case.
      if (window.__chessyTestWorkerMode === 'birth-error') {
        setTimeout(function () { if (worker.onerror) worker.onerror({}); }, 50);
      }
      this.postMessage = function () {
        if (window.__chessyTestWorkerMode === 'error') {
          setTimeout(function () { if (worker.onerror) worker.onerror({}); }, 750);
        }
      };
      this.terminate = function () {};
    };
    // Survives reloads so a phase can exercise the boot-time worker.
    window.__chessyTestWorkerMode = sessionStorage.getItem('chessy-test-worker-mode') || 'error';
  });
  await t.inject(function () { localStorage.removeItem('chessy-game-v1'); });

  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length >= 1;
  }, null, { timeout: 5000 });
  const failedAi = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return saved.history[0].ai;
  });
  check(failedAi.ms >= 700,
    'failed worker: AI timing includes the pre-error wait (' + failedAi.ms + 'ms)');
  check(failedAi.source === 'sync-fallback' &&
      failedAi.fallbackReason === 'worker-error',
    'failed worker telemetry identifies the loud-error fallback');
  check(Number.isFinite(failedAi.searchMs) && failedAi.ms >= failedAi.searchMs &&
      Number.isInteger(failedAi.nodes) && failedAi.nodes > 0,
    'failed worker fallback retains search time and counters');

  await page.evaluate(function () { window.__chessyTestWorkerMode = 'silent'; });
  await t.newGame({ mode: 'ai-w', difficulty: 'master' }); // AI is White: moves first
  // The silent-worker fallback waits the full watchdog (Master timeMs + 3000 =
  // 8s) and THEN runs a synchronous think for the same budget, so allow well
  // beyond that combined wait.
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length >= 1;
  }, null, { timeout: 30000 });
  check(true, 'silent worker: the watchdog falls back and the computer still moves');
  check(!(await page.textContent('#status')).includes('thinking'),
    'status leaves "thinking" after the fallback move');
  const stalledAi = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return saved.history[0].ai;
  });
  check(stalledAi.ms >= 4900,
    'silent worker: AI timing includes the watchdog wait (' + stalledAi.ms + 'ms)');
  check(stalledAi.source === 'sync-fallback' &&
      stalledAi.fallbackReason === 'watchdog',
    'silent worker telemetry identifies the watchdog fallback');
  check(Number.isFinite(stalledAi.searchMs) && stalledAi.ms >= stalledAi.searchMs &&
      Number.isInteger(stalledAi.nodes) && stalledAi.nodes > 0,
    'watchdog fallback retains search time and counters');

  // A PERSISTENTLY unloadable worker script fires onerror on every fresh
  // instance before any message. The app must drop to synchronous mode —
  // not spawn replacements in a loop whose startup errors keep restarting
  // (and so forever postponing) the pending synchronous fallback.
  await page.evaluate(function () {
    sessionStorage.setItem('chessy-test-worker-mode', 'birth-error');
    localStorage.removeItem('chessy-game-v1');
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForTimeout(300); // let the boot worker's startup error land
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length >= 1;
  }, null, { timeout: 20000 });
  check(!(await page.textContent('#status')).includes('thinking'),
    'unloadable worker: the computer still moves via the synchronous path');
  const spawned = await page.evaluate(function () { return window.__chessyTestWorkerCount; });
  check(spawned <= 2,
    'unloadable worker is not respawned in a loop (' + spawned + ' constructed)');
});
