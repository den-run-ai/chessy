/* AI Web Worker: runs the search off the main thread so the UI never
 * freezes while the computer thinks. The worker URL carries the page's
 * release token (#37); forward it so engine/ai come from the SAME release
 * (the service worker caches each release's assets under distinct keys). */
importScripts('engine.js' + self.location.search,
  'ai.js' + self.location.search,
  'wasm-engine.js' + self.location.search);

/* Experimental Rust/WASM engine (#84/#113 device probe): the page opts a
 * request in per message. The module is fetched and instantiated once per
 * worker, only on the first opted-in request, so default-off players pay
 * no memory or startup cost. EVERY wasm failure — load or search — answers
 * with the JavaScript engine instead and labels the reply, so a Play move
 * can never be lost to the experiment. A worker whose module failed to
 * load stays on JavaScript for its lifetime (the page-level watchdog and
 * new-game paths create fresh workers). */
let wasmLoad = null;      // Promise for the singleton engine instance
let wasmLoadFailed = false;

function loadWasmEngine(wasmUrl) {
  if (!wasmLoad) {
    wasmLoad = fetch(wasmUrl).then(function (resp) {
      if (!resp.ok) throw new Error('wasm fetch failed: ' + resp.status);
      return resp.arrayBuffer();
    }).then(function (bytes) {
      return WasmEngine.load(bytes);
    });
    wasmLoad.catch(function () { wasmLoadFailed = true; });
  }
  return wasmLoad;
}

function jsThink(data) {
  const state = Chess.parseFen(data.fen);
  const result = ChessAI.think(state, {
    maxDepth: data.maxDepth,
    timeMs: data.timeMs,
    // A node budget (analysis/Verify) makes a probe reproducible where a
    // wall-clock timeMs (Play) cannot; forward both so each caller's chosen
    // budget reaches the search.
    nodeLimit: data.nodeLimit,
    quiesce: data.quiesce,
    positions: data.positions,
    // Forward the determinism controls so an analysis/Verify probe searches
    // reproducibly (a fixed seed or randomize:false) instead of falling back
    // to Math.random and possibly preferring a different move each run.
    seed: data.seed,
    randomize: data.randomize,
    rootOrderUci: data.rootOrderUci
  });
  return Object.assign({ engine: 'js' }, result);
}

async function think(data) {
  if (data.engine !== 'wasm' || !data.wasmUrl) return jsThink(data);
  let engine;
  try {
    if (wasmLoadFailed) throw new Error('wasm module previously failed to load');
    engine = await loadWasmEngine(data.wasmUrl);
  } catch (e) {
    return Object.assign({ engineFallback: 'wasm-load-error' }, jsThink(data));
  }
  try {
    const started = Date.now();
    const result = engine.search(data.fen, {
      maxDepth: data.maxDepth,
      timeMs: data.timeMs,
      nodeLimit: data.nodeLimit,
      quiesce: data.quiesce
    });
    result.elapsedMs = Date.now() - started;
    result.engine = 'wasm';
    return result;
  } catch (e) {
    return Object.assign({ engineFallback: 'wasm-search-error' }, jsThink(data));
  }
}

// Serialize replies in arrival order: a request that triggers the one-time
// module load must not be overtaken by a later request racing past it.
let queue = Promise.resolve();

self.onmessage = function (e) {
  queue = queue.then(function () {
    return think(e.data);
  }).then(function (result) {
    // Return the complete, JSON-safe search evidence. Play records it
    // alongside the move so an archived incident can be attributed to a
    // release, engine, budget and completed draft instead of being
    // reconstructed from SAN alone.
    self.postMessage(Object.assign({ id: e.data.id }, result));
  });
};
