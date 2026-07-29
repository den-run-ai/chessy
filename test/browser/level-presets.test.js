/*
 * Product difficulty contract: stable persisted IDs select the recalibrated
 * node/time budgets, the default Rust/WASM backend executes them, and the
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
        ai.maxDepth === 30 && ai.timeMs === 5000 &&
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

  const setupCopy = (await page.textContent('#newGameDialog'))
    .replace(/\s+/g, ' ').trim();
  check(setupCopy.includes('default Rust/WASM backend') &&
      setupCopy.includes('may stop early') &&
      setupCopy.includes('Not FIDE, Chess.com, or Lichess ratings'),
    'setup qualifies target bands by backend, device, and rating scale');
});
