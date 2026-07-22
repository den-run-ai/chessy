/* Analysis worker: runs the deterministic ANALYSIS CONTRACT
 * (ChessyAnalysisCore.analyse) off the main thread, so a multi-candidate
 * deep-verify never blocks the UI or disturbs a live Play search (which uses
 * the separate ai-worker.js). The URL carries the page's release token (#37)
 * so engine/ai/analysis-core all come from the SAME release. */
importScripts(
  'engine.js' + self.location.search,
  'ai.js' + self.location.search,
  'analysis-core.js' + self.location.search
);

self.onmessage = function (e) {
  const d = e.data;
  const state = Chess.parseFen(d.fen);
  const contract = ChessyAnalysisCore.analyse(state, {
    positions: d.positions,
    playedMove: d.playedMove,
    nodeLimit: d.nodeLimit,
    maxDepth: d.maxDepth,
    multiPV: d.multiPV,
    pvLen: d.pvLen,
    verifyNodeLimit: d.verifyNodeLimit,
    stabilityNodeLimit: d.stabilityNodeLimit
  });
  self.postMessage({ id: d.id, contract: contract });
};
