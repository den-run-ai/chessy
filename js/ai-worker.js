/* AI Web Worker: runs the search off the main thread so the UI never
 * freezes while the computer thinks. */
importScripts('engine.js', 'ai.js');

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
