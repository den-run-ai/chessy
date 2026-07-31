/* New Game dialog, validated localStorage restore, offline status note. */
'use strict';
require('./helper').run('setup', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

  // The release check is asynchronous. The button disables after the first
  // click, but duplicate programmatic events are still generation-fenced;
  // cancelling while the check is pending prevents every callback.
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
  await page.evaluate(function () {
    const start = document.getElementById('newGameStart');
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.click('#newGameCancel');
  await page.evaluate(function () { window.__resolveRuntimeCheck(true); });
  await page.waitForTimeout(0);
  const cancelled = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: saved.gameId, plies: saved.history.length };
  });
  check(cancelled.id === activeId && cancelled.plies === 1,
    'Cancel fences concurrent pending Start clicks');

  // Without cancellation, only the latest duplicate Start callback acts.
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
  await page.evaluate(function () {
    const start = document.getElementById('newGameStart');
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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

  // A valid rootless legacy save (with AI metadata) is restored, including
  // settings. Missing rootOrderUci remains the backwards-compatible marker.
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

  // A captured root order is trusted evidence, not a best-effort list. The
  // live-save loader must check the RAW list against the exact pre-move
  // position before sanitizeTelemetry can filter bad entries and let poisoned
  // evidence reach the archive.
  const rootedSave = await page.evaluate(function () {
    const data = JSON.parse(localStorage.getItem('chessy-game-v1'));
    data.history[0].ai.rootOrderUci =
      Chess.legalMoves(Chess.newGameState()).map(function (move) {
        return Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '');
      }).reverse();
    return data;
  });
  await t.inject(function (data) {
    localStorage.setItem('chessy-game-v1', JSON.stringify(data));
  }, rootedSave);
  check(await page.locator('#moveList .ply').count() === 1,
    'complete legal root-order evidence restores');

  const roots = rootedSave.history[0].ai.rootOrderUci;
  const substituted = roots.slice();
  substituted[0] = 'a1a8';
  const duplicated = roots.slice();
  duplicated[0] = duplicated[1];
  const malformed = roots.slice();
  malformed[0] = 'not-uci';
  const poisonedRoots = [
    { label: 'truncated', value: roots.slice(1) },
    { label: 'substituted', value: substituted },
    { label: 'duplicate', value: duplicated },
    { label: 'malformed', value: malformed }
  ];
  for (const poison of poisonedRoots) {
    const data = JSON.parse(JSON.stringify(rootedSave));
    data.history[0].ai.rootOrderUci = poison.value;
    await t.inject(function (saved) {
      localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
    }, data);
    check(await page.locator('#moveList .ply').count() === 0,
      poison.label + ' live-save root order is rejected');
  }

  const positionAwareSave = await page.evaluate(function () {
    function byUci(state, wanted) {
      return Chess.legalMoves(state).find(function (move) {
        const uci = Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '');
        return uci === wanted;
      });
    }
    let state = Chess.newGameState();
    state = Chess.playMove(state, byUci(state, 'e2e4'));
    const blackRoots = Chess.legalMoves(state).map(function (move) {
      return Chess.sqName(move.from) + Chess.sqName(move.to) +
        (move.promotion ? move.promotion.toLowerCase() : '');
    }).reverse();
    state = Chess.playMove(state, byUci(state, 'e7e5'));
    state.history[1].ai = {
      depth: 1, quiesce: false, ms: 12, rootOrderUci: blackRoots
    };
    return {
      fen: Chess.toFen(state), history: state.history,
      mode: 'pvp', difficulty: '2'
    };
  });
  await t.inject(function (data) {
    localStorage.setItem('chessy-game-v1', JSON.stringify(data));
  }, positionAwareSave);
  check(await page.locator('#moveList .ply').count() === 2,
    'later-ply root order is checked against its pre-move position');

  const foreignPosition = JSON.parse(JSON.stringify(positionAwareSave));
  foreignPosition.history[1].ai.rootOrderUci = roots.slice();
  await t.inject(function (data) {
    localStorage.setItem('chessy-game-v1', JSON.stringify(data));
  }, foreignPosition);
  check(await page.locator('#moveList .ply').count() === 0,
    'same-length root order from another position is rejected');

  // Offline status reaches a real "ready" state via a service-worker
  // install (localhost is a secure context; the origin is fresh per run).
  await page.waitForFunction(function () {
    return document.getElementById('installNote').textContent.includes('Ready offline');
  }, null, { timeout: 15000 });
  check(true, 'offline note reaches "Ready offline" after SW install');
  // Play is worker/WASM-only. A failed attempt gets exactly one fresh worker;
  // the second failure leaves the exact position unchanged and exposes a
  // Retry control. This stub affects every later navigation, so keep it last.
  await page.addInitScript(function () {
    window.__chessyTestWorkerCount = 0;
    window.__chessyTestWorkerPostCount = 0;
    window.__chessyHeldZeroTimers = [];
    window.__chessyHoldNextZeroTimer = false;
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function (fn, delay) {
      // A constructor failure and a loud-worker retry both yield through a
      // zero-delay timer. Tests can hold exactly the next such product timer
      // so a replacement request is installed before the stale callback runs.
      if (window.__chessyHoldNextZeroTimer && delay === 0) {
        window.__chessyHoldNextZeroTimer = false;
        const args = Array.prototype.slice.call(arguments, 2);
        window.__chessyHeldZeroTimers.push(function () {
          fn.apply(window, args);
        });
        return 0;
      }
      // Product watchdog = timeMs (5000) + margin (3000). Compress it only
      // during the explicit silent-worker phase.
      if (window.__chessyFastWatchdog && delay === 8000) delay = 50;
      return realSetTimeout(fn, delay);
    };
    window.__chessyFlushHeldZeroTimers = function () {
      const held = window.__chessyHeldZeroTimers.splice(0);
      held.forEach(function (fn) { fn(); });
      return held.length;
    };
    window.Worker = function () {
      const worker = this;
      const number = ++window.__chessyTestWorkerCount;
      if (window.__chessyTestWorkerMode === 'constructor-error') {
        window.__chessyHoldNextZeroTimer = true;
        throw new Error('synthetic Worker constructor failure');
      }
      this.postMessage = function (request) {
        window.__chessyTestWorkerPostCount++;
        if (window.__chessyTestWorkerMode === 'error') {
          setTimeout(function () {
            if (worker.onerror) worker.onerror({ preventDefault: function () {} });
          }, 20);
        } else if (window.__chessyTestWorkerMode === 'success') {
          setTimeout(function () {
            if (worker.onmessage) worker.onmessage({ data: {
              id: request.id,
              move: { from: 52, to: 36, promotion: null },
              engine: 'wasm',
              depth: 3, attemptedDepth: 4, nodes: 10000, qnodes: 5000,
              cutoffs: 10, researches: 1, score: 20, scorePov: 'white',
              stopReason: 'node-limit', elapsedMs: 3
            } });
          }, 20);
        } else if (window.__chessyTestWorkerMode === 'illegal') {
          setTimeout(function () {
            if (worker.onmessage) worker.onmessage({ data: {
              id: request.id,
              move: { from: 0, to: 0, promotion: null },
              engine: 'wasm',
              depth: 1, attemptedDepth: 2, nodes: 1, qnodes: 0,
              cutoffs: 0, researches: 0, score: 0, scorePov: 'white',
              stopReason: 'node-limit', elapsedMs: 1
            } });
          }, 20);
        } else if (window.__chessyTestWorkerMode === 'first-error') {
          setTimeout(function () {
            if (number === 1) {
              if (worker.onerror) worker.onerror({ preventDefault: function () {} });
            } else if (worker.onmessage) {
              worker.onmessage({ data: {
                id: request.id,
                move: { from: 52, to: 36, promotion: null },
                engine: 'wasm',
                depth: 3, attemptedDepth: 4, nodes: 10000, qnodes: 5000,
                cutoffs: 10, researches: 1, score: 20, scorePov: 'white',
                stopReason: 'node-limit', elapsedMs: 3
              } });
            }
          }, 20);
        } else if (window.__chessyTestWorkerMode === 'hold-error-retry') {
          setTimeout(function () {
            window.__chessyHoldNextZeroTimer = true;
            if (worker.onerror) worker.onerror({ preventDefault: function () {} });
          }, 20);
        } else if (window.__chessyTestWorkerMode === 'manual-success') {
          window.__chessyManualWorkerReply = function () {
            if (worker.onmessage) worker.onmessage({ data: {
              id: request.id,
              move: { from: 52, to: 36, promotion: null },
              engine: 'wasm',
              depth: 3, attemptedDepth: 4, nodes: 10000, qnodes: 5000,
              cutoffs: 10, researches: 1, score: 20, scorePov: 'white',
              stopReason: 'node-limit', elapsedMs: 3
            } });
          };
        }
      };
      this.terminate = function () {};
    };
    window.__chessyTestWorkerMode = 'first-error';
  });
  await t.inject(function () { localStorage.removeItem('chessy-game-v1'); });

  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length === 1;
  }, null, { timeout: 3000 });
  const automatic = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      ai: saved.history[0].ai
    };
  });
  check(automatic.workers === 2 &&
      automatic.ai.engine === 'wasm' &&
      automatic.ai.source === 'worker' &&
      automatic.ai.engineFallback === null,
    'one loud failure automatically retries in a fresh worker and accepts WASM');

  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'error';
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return !document.getElementById('aiError').hidden;
  }, null, { timeout: 3000 });
  const failed = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      plies: saved.history.length,
      fen: saved.fen,
      status: document.getElementById('status').textContent
    };
  });
  check(failed.workers === 3 && failed.plies === 0,
    'two loud failures use one initial and one fresh worker, with no move');
  check(failed.fen === startFen &&
      failed.status.includes('position unchanged'),
    'final worker failure visibly preserves the exact board position');

  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'success';
    document.getElementById('aiRetry').click();
  });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length >= 1;
  }, null, { timeout: 3000 });
  const recovered = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      ai: saved.history[0].ai,
      errorHidden: document.getElementById('aiError').hidden
    };
  });
  check(recovered.workers === 4 && recovered.errorHidden &&
      recovered.ai.engine === 'wasm' && recovered.ai.source === 'worker' &&
      recovered.ai.engineFallback === null &&
      recovered.ai.fallbackReason === null,
    'Retry starts a new worker and accepts only its WASM result');

  // Alive-but-silent workers follow the same bounded policy. Compress the two
  // watchdogs in this controlled phase; production still uses 8 seconds each.
  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'silent';
    window.__chessyFastWatchdog = true;
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return !document.getElementById('aiError').hidden;
  }, null, { timeout: 3000 });
  const silent = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      plies: saved.history.length,
      fen: saved.fen,
      workers: window.__chessyTestWorkerCount
    };
  });
  check(silent.plies === 0 && silent.fen === startFen &&
      silent.workers === 5,
    'two watchdogs stop after one fresh-worker retry and preserve the board');

  await page.evaluate(function () {
    window.__chessyFastWatchdog = false;
    window.__chessyTestWorkerMode = 'illegal';
    document.getElementById('aiRetry').click();
  });
  await page.waitForFunction(function () {
    return window.__chessyTestWorkerCount === 7 &&
      !document.getElementById('aiError').hidden;
  }, null, { timeout: 3000 });
  const illegal = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { plies: saved.history.length, fen: saved.fen };
  });
  check(illegal.plies === 0 && illegal.fen === startFen,
    'an illegal worker reply is rejected twice and never reaches the board');

  await t.newGame({ mode: 'pvp' });
  check(await page.locator('#aiError[hidden]').count() === 1 &&
      await page.locator('#moveList .ply').count() === 0,
    'New game recovers from an engine error without accepting a move');

  // Hold both zero-delay recovery shapes from superseded requests. The first
  // request cannot construct a Worker; the second constructs one, fails
  // loudly, and queues its fresh-worker retry. A third New game installs a
  // live successor before either old callback is released.
  const raceBase = await page.evaluate(function () {
    return {
      workers: window.__chessyTestWorkerCount,
      posts: window.__chessyTestWorkerPostCount
    };
  });
  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'constructor-error';
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return window.__chessyHeldZeroTimers.length === 1;
  });

  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'hold-error-retry';
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  await page.waitForFunction(function () {
    return window.__chessyHeldZeroTimers.length === 2;
  }, null, { timeout: 3000 });

  await page.evaluate(function () {
    window.__chessyTestWorkerMode = 'manual-success';
  });
  await t.newGame({ mode: 'ai-w', difficulty: '1' });
  const successorBeforeFlush = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      posts: window.__chessyTestWorkerPostCount,
      plies: saved.history.length,
      fen: saved.fen,
      errorHidden: document.getElementById('aiError').hidden,
      status: document.getElementById('status').textContent
    };
  });
  check(successorBeforeFlush.workers === raceBase.workers + 3 &&
      successorBeforeFlush.posts === raceBase.posts + 2 &&
      successorBeforeFlush.plies === 0 &&
      successorBeforeFlush.fen === startFen &&
      successorBeforeFlush.errorHidden &&
      successorBeforeFlush.status.includes('Computer is thinking'),
    'successor owns one worker request before stale zero-delay callbacks run');

  const flushed = await page.evaluate(function () {
    return window.__chessyFlushHeldZeroTimers();
  });
  await page.waitForTimeout(30);
  const successorAfterFlush = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      posts: window.__chessyTestWorkerPostCount,
      plies: saved.history.length,
      fen: saved.fen,
      errorHidden: document.getElementById('aiError').hidden,
      status: document.getElementById('status').textContent
    };
  });
  check(flushed === 2 &&
      successorAfterFlush.workers === successorBeforeFlush.workers &&
      successorAfterFlush.posts === successorBeforeFlush.posts &&
      successorAfterFlush.plies === 0 &&
      successorAfterFlush.fen === startFen &&
      successorAfterFlush.errorHidden &&
      successorAfterFlush.status.includes('Computer is thinking'),
    'superseded constructor recovery and retry dispatch cannot act on successor');

  await page.evaluate(function () {
    window.__chessyManualWorkerReply();
  });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length === 1;
  }, null, { timeout: 3000 });
  const raceRecovered = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      workers: window.__chessyTestWorkerCount,
      posts: window.__chessyTestWorkerPostCount,
      ai: saved.history[0].ai,
      errorHidden: document.getElementById('aiError').hidden
    };
  });
  check(raceRecovered.workers === successorBeforeFlush.workers &&
      raceRecovered.posts === successorBeforeFlush.posts &&
      raceRecovered.errorHidden &&
      raceRecovered.ai.engine === 'wasm' &&
      raceRecovered.ai.source === 'worker',
    'successor still completes through its original WASM worker');
});
