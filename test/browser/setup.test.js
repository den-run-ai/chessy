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

  // An AI worker that stays ALIVE but never replies must not leave the
  // game stuck on "Computer is thinking…": the watchdog replaces it after
  // the search budget and the synchronous fallback makes the move. The
  // Worker stub swallows postMessage exactly like a wedged worker — and
  // affects every later navigation, so this test must stay LAST.
  await page.addInitScript(function () {
    window.Worker = function () {
      this.postMessage = function () {};
      this.terminate = function () {};
    };
  });
  await t.inject(function () { localStorage.removeItem('chessy-game-v1'); });
  await t.newGame({ mode: 'ai-w', difficulty: 'master' }); // AI is White: moves first
  await page.waitForFunction(function () {
    return document.querySelectorAll('#moveList .ply').length >= 1;
  }, null, { timeout: 20000 });
  check(true, 'silent worker: the watchdog falls back and the computer still moves');
  check(!(await page.textContent('#status')).includes('thinking'),
    'status leaves "thinking" after the fallback move');
});
