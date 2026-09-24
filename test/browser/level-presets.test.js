/*
 * Product difficulty contract: stable persisted IDs select the recalibrated
 * node/time budgets, the Rust/WASM-only backend executes them, and the
 * setup copy labels numeric bands as targets rather than certified ratings.
 */
'use strict';
require('./helper').run('level-presets', async function (t) {
  const page = t.page, check = t.check;
  const levels = [
    { id: '1', name: 'Easy', target: '1500', nodeLimit: 10000 },
    { id: '2', name: 'Medium', target: '1700', nodeLimit: 36000 },
    { id: '3', name: 'Hard', target: '1900', nodeLimit: 230000 },
    { id: '5', name: 'Expert', target: '2100', nodeLimit: 1440000 },
    { id: 'master', name: 'Master', target: '2300+', nodeLimit: null }
  ];

  for (const level of levels) {
    await t.newGame({ mode: 'ai-w', difficulty: level.id });
    await page.waitForFunction(function () {
      const raw = localStorage.getItem('chessy-game-v1');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      return saved.history && saved.history[0] && saved.history[0].ai;
    }, null, { timeout: 15000 });
    const result = await page.evaluate(function (id) {
      const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
      const input = document.querySelector(
        'input[name="difficulty"][value="' + id + '"]');
      return {
        ai: saved.history[0].ai,
        copy: input && input.parentElement.textContent
      };
    }, level.id);
    const ai = result.ai;
    check(result.copy.includes(level.name) &&
        result.copy.includes('target ' + level.target),
      level.name + ' presents its rating as a target');
    check(ai.engine === 'wasm' && ai.engineFallback === null &&
        ai.maxDepth === (level.id === 'master' ? 111 : 30) &&
        ai.timeMs === (level.id === 'master' ? 8000 : 5000) &&
        ai.quiesce === true && ai.nodeLimit === level.nodeLimit,
      level.name + ' executes the declared default-WASM preset');
    if (level.nodeLimit === null) {
      check(ai.stopReason === 'time-limit' &&
          Number.isInteger(ai.nodes) && ai.nodes > 0,
        'Master spends the wall-clock budget');
    } else {
      const completedBudget = ai.stopReason === 'node-limit' &&
        ai.nodes === level.nodeLimit;
      const hitSafetyCeiling = ai.stopReason === 'time-limit' &&
        Number.isInteger(ai.nodes) && ai.nodes > 0 &&
        ai.nodes <= level.nodeLimit;
      check((completedBudget || hitSafetyCeiling) && ai.depth >= 1 &&
          ai.attemptedDepth === ai.depth + 1,
        level.name + ' respects its node target and time safety ceiling');
    }
  }

  // Seed on the app-less page: pagehide would overwrite an in-app edit.
  // A fixed eight-second request here loses on time before returning.
  await t.newGame({ mode: 'pvp', difficulty: 'master', timeControl: '300+3' });
  await t.inject(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    saved.mode = 'ai-w';
    saved.clocks = { wMs: 2000, bMs: 300000 };
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
  });
  await page.waitForFunction(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return saved.history[0] && saved.history[0].ai;
  }, null, { timeout: 10000 });
  const timed = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(timed.history[0].ai.timeMs > 0 && timed.history[0].ai.timeMs <= 500 &&
      timed.history[0].ai.maxDepth === 111 && timed.history[0].ai.nodeLimit === null &&
      !timed.timeForfeit && timed.clocks.wMs > 0,
    'near-expired Master clock dispatches a bounded real WASM search without flagging');

  await t.inject(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    saved.mode = 'pvp';
    saved.difficulty = 'constructor';
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
  });
  const restored = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1'));
  });
  check(restored.difficulty === '2' && restored.history.length === 1,
    'prototype-property difficulty falls back to Medium without losing the game');

  // An AI clock that is already empty flags before any search is sized or
  // dispatched: a 1 ms "budget" must not race the ticker for a free move.
  await t.newGame({ mode: 'pvp', difficulty: 'master', timeControl: '300+3' });
  await page.addInitScript(function () {
    const NativeWorker = window.Worker;
    window.__aiWorkers = 0;
    window.Worker = function (url, options) {
      if (String(url).indexOf('ai-worker') >= 0) window.__aiWorkers++;
      return new NativeWorker(url, options);
    };
    window.Worker.prototype = NativeWorker.prototype;
  });
  await t.inject(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    saved.mode = 'ai-w';
    saved.clocks = { wMs: 0, bMs: 300000 };
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
  });
  await page.waitForFunction(function () {
    return document.getElementById('gameOverDialog') &&
      document.getElementById('gameOverDialog').open;
  }, null, { timeout: 10000 });
  await page.waitForTimeout(400);
  const flagged = await page.evaluate(function () {
    return {
      saved: JSON.parse(localStorage.getItem('chessy-game-v1')),
      workers: window.__aiWorkers,
      title: document.getElementById('gameOverTitle').textContent
    };
  });
  check(flagged.workers === 0 && flagged.saved.history.length === 0 &&
      flagged.saved.timeForfeit && flagged.saved.timeForfeit.color === 'w' &&
      flagged.title === 'Black wins!',
    'an AI clock already at zero flags without dispatching a search');

  const setupCopy = (await page.textContent('#newGameDialog'))
    .replace(/\s+/g, ' ').trim();
  check(setupCopy.includes('Rust/WASM backend') &&
      setupCopy.includes('may stop early') &&
      setupCopy.includes('Not FIDE, Chess.com, or Lichess ratings'),
    'setup qualifies target bands by backend, device, and rating scale');
});
