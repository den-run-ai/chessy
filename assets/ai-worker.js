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
    quiesce: e.data.quiesce,
    positions: e.data.positions
  });
  self.postMessage({ id: e.data.id, move: result.move, depth: result.depth });
};
