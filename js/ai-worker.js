/* AI Web Worker: runs the minimax search off the main thread so the UI
 * never freezes while the computer thinks. */
importScripts('engine.js', 'ai.js');

self.onmessage = function (e) {
  const state = Chess.parseFen(e.data.fen);
  const move = ChessAI.bestMove(state, e.data.depth, e.data.quiesce);
  self.postMessage({ id: e.data.id, move: move });
};
