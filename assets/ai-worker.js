/* Rust/WASM-only Play worker. Search never runs on the main thread and this
 * worker deliberately does not load the retired JavaScript search algorithm.
 * Its URL carries the page's release token; forward it so the loader and
 * binary always come from the same immutable release unit. */
importScripts('wasm-engine.js' + self.location.search);

let wasmLoad = null;      // Promise for the singleton engine instance

function loadWasmEngine(wasmUrl) {
  if (!wasmLoad) {
    wasmLoad = fetch(wasmUrl).then(function (resp) {
      if (!resp.ok) throw new Error('wasm fetch failed: ' + resp.status);
      return resp.arrayBuffer();
    }).then(function (bytes) {
      return WasmEngine.load(bytes);
    });
  }
  return wasmLoad;
}

async function think(data) {
  if (!data || typeof data.wasmUrl !== 'string' || !data.wasmUrl) {
    throw { kind: 'wasm-load-error' };
  }
  let engine;
  try {
    engine = await loadWasmEngine(data.wasmUrl);
  } catch (e) {
    throw { kind: 'wasm-load-error' };
  }
  try {
    const started = Date.now();
    const result = engine.search(data.fen, {
      maxDepth: data.maxDepth,
      timeMs: data.timeMs,
      nodeLimit: data.nodeLimit,
      quiesce: data.quiesce,
      positions: data.positions
    });
    result.elapsedMs = Date.now() - started;
    result.engine = 'wasm';
    return result;
  } catch (e) {
    throw { kind: 'wasm-search-error' };
  }
}

// Serialize replies in arrival order: a request that triggers the one-time
// module load must not be overtaken by a later request racing past it.
let queue = Promise.resolve();

self.onmessage = function (e) {
  const data = e.data;
  queue = queue.then(function () {
    return think(data);
  }).then(function (result) {
    self.postMessage(Object.assign({ id: data && data.id }, result));
  }, function (error) {
    // A structured failure lets the page terminate this worker and retry the
    // exact unchanged position once in a fresh worker. Never answer with a
    // move from another engine.
    self.postMessage({
      id: data && data.id,
      error: error && (error.kind === 'wasm-load-error' ||
        error.kind === 'wasm-search-error')
        ? error.kind : 'worker-error'
    });
  });
};
