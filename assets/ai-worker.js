/* AI Web Worker: runs the search off the main thread so the UI never
 * freezes while the computer thinks. The worker URL carries the page's
 * release token (#37); forward it so engine/ai come from the SAME release
 * (the service worker caches each release's assets under distinct keys). */
importScripts('engine.js' + self.location.search, 'ai.js' + self.location.search);

self.onmessage = function (e) {
  const state = Chess.parseFen(e.data.fen);
  const result = ChessAI.think(state, {
    maxDepth: e.data.maxDepth,
    timeMs: e.data.timeMs,
    // A node budget (analysis/Verify) makes a probe reproducible where a
    // wall-clock timeMs (Play) cannot; forward both so each caller's chosen
    // budget reaches the search.
    nodeLimit: e.data.nodeLimit,
    quiesce: e.data.quiesce,
    positions: e.data.positions,
    // Forward the determinism controls so an analysis/Verify probe searches
    // reproducibly (a fixed seed or randomize:false) instead of falling back
    // to Math.random and possibly preferring a different move each run.
    seed: e.data.seed,
    randomize: e.data.randomize
  });
  self.postMessage({ id: e.data.id, move: result.move, depth: result.depth, score: result.score });
};
