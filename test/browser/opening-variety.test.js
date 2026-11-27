/* Opening variety is per game, reproducible on retry/Undo/reload, and confined
 * to early Play. Real workers calculate every accepted move. */
'use strict';
require('./helper').run('opening-variety', async function (t) {
  const page = t.page, check = t.check;
  await page.addInitScript(function () {
    const NativeWorker = window.Worker;
    window.__openingRequests = [];
    window.__openingWorkerCount = 0;
    window.Worker = function (url, options) {
      const worker = new NativeWorker(url, options);
      if (!String(url).includes('ai-worker.js')) return worker;
      const instance = ++window.__openingWorkerCount;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = function (request) {
        window.__openingRequests.push({ instance: instance,
          request: JSON.parse(JSON.stringify(request)) });
        if (window.__openingFailNext) {
          window.__openingFailNext = false;
          throw new Error('synthetic Play send failure');
        }
        return post(request);
      };
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
    // A real new game still supplies a fresh UUID; fixed test IDs make this
    // regression reproducible without depending on random collision odds.
    crypto.randomUUID = function () {
      const next = Number(sessionStorage.getItem('opening-test-id') || 0) + 1;
      sessionStorage.setItem('opening-test-id', String(next));
      return '00000000-0000-4000-8000-' + String(next).padStart(12, '0');
    };
  });
  await page.goto(t.url);
  await page.waitForSelector('#board .square');
  await page.evaluate(function () { window.__openingFailNext = true; });
  await t.newGame({ mode: 'ai-w', difficulty: '2', timeControl: 'none' });

  async function firstMove() {
    await page.waitForFunction(function () {
      const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
      return saved.history.length === 1 && saved.history[0].ai;
    });
    return page.evaluate(function () {
      return JSON.parse(localStorage.getItem('chessy-game-v1'));
    });
  }
  const first = await firstMove();
  const attempts = await page.evaluate(function () { return window.__openingRequests; });
  check(attempts.length === 2 && attempts[0].instance !== attempts[1].instance &&
      JSON.stringify(attempts[0].request) === JSON.stringify(attempts[1].request),
    'fresh-worker retry preserves the exact position, budget and opening seed');
  const request = attempts[1].request, evidence = first.history[0].ai;
  check(Number.isInteger(request.rootSeed) && request.rootSeed >= 0 &&
      request.rootSeed <= 0xffffffff && evidence.randomize === true &&
      (evidence.seed >>> 0) === request.rootSeed && evidence.engine === 'wasm',
    'the real opening search consumes and records its reproducible seed');

  await page.click('#undo');
  const undone = await firstMove();
  check(undone.gameId === first.gameId && undone.fen === first.fen &&
      undone.history[0].ai.seed === evidence.seed &&
      undone.history[0].ai.score === evidence.score &&
      undone.history[0].ai.depth === evidence.depth,
    'Undo and replaying the same computer opening keep the same seeded result');

  // Reload just before the AI turn, with the same durable game identity.
  await t.inject(function (id) {
    localStorage.setItem('chessy-game-v1', JSON.stringify({
      gameId: id, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      history: [], mode: 'ai-w', difficulty: '2', timeControl: 'none'
    }));
  }, first.gameId);
  const reloaded = await firstMove();
  check(reloaded.fen === first.fen && reloaded.history[0].ai.seed === evidence.seed,
    'reloading a pending opening retains its game seed and calculated move');

  await t.newGame({});
  const next = await firstMove();
  check(next.gameId !== first.gameId && next.history[0].ai.randomize === true &&
      next.history[0].ai.seed !== evidence.seed,
    'a new game receives fresh opening variety');

  // These fixed IDs independently exercise zero and the unsigned high bit;
  // neither may disable variety or lose bits in signed legacy telemetry.
  for (const fixture of [
    { id: '00000000-0000-4000-8000-00061d2f17f4', seed: 0 },
    { id: '00000000-0000-4000-8000-000000000001', seed: 3313455222 }
  ]) {
    await t.inject(function (id) {
      localStorage.setItem('chessy-game-v1', JSON.stringify({
        gameId: id, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        history: [], mode: 'ai-w', difficulty: '1', timeControl: 'none'
      }));
    }, fixture.id);
    const edge = await firstMove();
    const rootSeed = await page.evaluate(function () {
      return window.__openingRequests[0].request.rootSeed;
    });
    check(rootSeed === fixture.seed && edge.history[0].ai.randomize === true &&
        (edge.history[0].ai.seed >>> 0) === fixture.seed,
      'seed ' + fixture.seed + ' remains enabled and retains all 32 bits');
  }

  // Reach the cutoff through a legal nonterminal opening, then let the real
  // computer play. Later searches must retain deterministic default ordering.
  const later = await page.evaluate(function () {
    let state = Chess.newGameState();
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6',
      'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5']
      .forEach(function (uci) {
        const move = Chess.legalMoves(state).find(function (m) {
          return Chess.sqName(m.from) + Chess.sqName(m.to) === uci;
        });
        if (!move) throw new Error('illegal opening fixture ' + uci);
        state = Chess.playMove(state, move);
      });
    return { gameId: 'opening-cutoff', fen: Chess.toFen(state),
      history: state.history, mode: 'ai-w', difficulty: '1', timeControl: 'none' };
  });
  await t.inject(function (saved) {
    localStorage.setItem('chessy-game-v1', JSON.stringify(saved));
  }, later);
  await page.waitForFunction(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return saved.history.length === 13 && saved.history[12].ai;
  });
  const afterOpening = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { request: window.__openingRequests[0].request, ai: saved.history[12].ai };
  });
  check(afterOpening.request.rootSeed === null &&
      afterOpening.ai.seed === null && afterOpening.ai.randomize === false,
    'after six full moves, Play uses the ordinary deterministic search');
}, { startOnBlank: true });
