/*
 * Production loader for the Rust/WASM engine module's raw ABI (version 1) —
 * the same decoder contract as experiments/wasm/bench.js (the canonical
 * Node reference) and experiments/wasm/probe/spike-abi.js (the validated
 * probe port). Any header mismatch is a hard failure so an incompatible
 * binary can never look like a working engine; the worker treats every
 * throw as "fall back to the JavaScript engine".
 *
 * The result is normalized to ChessAI.think's shape as far as the raw ABI
 * carries it: move is a {from, to, promotion} object resolvable against
 * Chess.legalMoves. The ABI has no seed/randomize/positions inputs — root
 * order uses the module's fixed embedded shuffle seed and repetition is
 * search-local (no game-prefix history), which is why the engine ships
 * behind an explicitly experimental toggle.
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.WasmEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const ABI_VERSION = 1;
  const RESULT_BYTES = 64;
  const INPUT_BYTES = 1024;
  const MAX_SEARCH_DEPTH = 111;
  const NONE_U32 = 0xffffffff;
  const STOP_REASONS = ['unknown', 'max-depth', 'time-limit', 'node-limit', 'mate', 'game-over'];
  const PROMOTIONS = [null, 'Q', 'R', 'B', 'N'];

  function safeCounter(view, offset, label) {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(label + ' exceeds JavaScript safe-integer range: ' + value);
    }
    return Number(value);
  }

  function decodeResult(memory, resultPointer) {
    const pointer = Number(resultPointer);
    if (!Number.isSafeInteger(pointer) || pointer < 0 ||
        pointer + RESULT_BYTES > memory.buffer.byteLength) {
      throw new Error('result_ptr() returned an out-of-bounds pointer: ' + resultPointer);
    }
    const view = new DataView(memory.buffer, pointer, RESULT_BYTES);
    const version = view.getUint32(0, true);
    const bytes = view.getUint32(4, true);
    if (version !== ABI_VERSION) {
      throw new Error('WASM result ABI version ' + version +
        ' does not match loader version ' + ABI_VERSION);
    }
    if (bytes !== RESULT_BYTES) {
      throw new Error('WASM result struct is ' + bytes +
        ' bytes; loader requires exactly ' + RESULT_BYTES);
    }
    const packedMove = view.getUint32(8, true);
    let move = null;
    if (packedMove !== NONE_U32) {
      if ((packedMove >>> 15) !== 0) {
        throw new Error('packed move has non-zero reserved bits: 0x' +
          packedMove.toString(16));
      }
      const promotionCode = (packedMove >>> 12) & 7;
      if (promotionCode >= PROMOTIONS.length) {
        throw new Error('packed move has invalid promotion code ' + promotionCode);
      }
      move = {
        from: packedMove & 63,
        to: (packedMove >>> 6) & 63,
        promotion: PROMOTIONS[promotionCode]
      };
    }
    const attempted = view.getUint32(20, true);
    const stopCode = view.getUint32(56, true);
    if (stopCode >= STOP_REASONS.length) {
      throw new Error('WASM result has invalid stop-reason code ' + stopCode);
    }
    return {
      move: move,
      score: view.getInt32(12, true),
      scorePov: 'white',
      depth: view.getUint32(16, true),
      attemptedDepth: attempted === NONE_U32 ? null : attempted,
      nodes: safeCounter(view, 24, 'nodes'),
      qnodes: safeCounter(view, 32, 'qnodes'),
      cutoffs: safeCounter(view, 40, 'cutoffs'),
      researches: safeCounter(view, 48, 'researches'),
      stopReason: STOP_REASONS[stopCode]
    };
  }

  function requiredFunction(exports, name) {
    if (typeof exports[name] !== 'function') {
      throw new Error('WASM module is missing required function export "' + name + '"');
    }
    return exports[name];
  }

  async function load(wasmBytes) {
    const loaded = await WebAssembly.instantiate(wasmBytes, {
      env: {
        now_ms: function () { return performance.now(); }
      }
    });
    const instance = loaded.instance || loaded;
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error('WASM module is missing required memory export "memory"');
    }
    const inputPointer = requiredFunction(exports, 'input_ptr');
    const resultPointer = requiredFunction(exports, 'result_ptr');
    const loadPosition = requiredFunction(exports, 'load_position');
    const search = requiredFunction(exports, 'search');
    const encoder = new TextEncoder();

    return {
      memoryBytes: function () { return exports.memory.buffer.byteLength; },
      search: function (fen, opts) {
        opts = opts || {};
        const encoded = encoder.encode(fen);
        if (encoded.byteLength > INPUT_BYTES) {
          throw new RangeError('encoded FEN exceeds WASM input capacity: ' +
            encoded.byteLength + ' > ' + INPUT_BYTES);
        }
        if (!Number.isInteger(opts.maxDepth) ||
            opts.maxDepth < 1 || opts.maxDepth > MAX_SEARCH_DEPTH) {
          throw new RangeError('maxDepth must be an integer from 1 through ' +
            MAX_SEARCH_DEPTH);
        }
        const pointer = Number(inputPointer());
        if (!Number.isSafeInteger(pointer) || pointer < 0 ||
            pointer + encoded.byteLength > exports.memory.buffer.byteLength) {
          throw new Error('input_ptr() returned an out-of-bounds pointer');
        }
        new Uint8Array(exports.memory.buffer, pointer, encoded.byteLength).set(encoded);
        const loadStatus = loadPosition(encoded.byteLength);
        if (loadStatus !== undefined && loadStatus !== 0) {
          throw new Error('load_position() failed with status ' + loadStatus);
        }
        // ABI: zero nodeLimit/timeMs mean unlimited; a non-zero status (for
        // example 2, fixed-TT saturation) means the result buffer must not
        // be trusted — surface it and let the caller fall back.
        const status = search(
          opts.maxDepth,
          opts.nodeLimit || 0,
          opts.timeMs || 0,
          opts.quiesce ? 1 : 0
        );
        if (status !== 0) {
          throw new Error('search() failed with status ' + status);
        }
        return decodeResult(exports.memory, resultPointer());
      }
    };
  }

  return {
    load: load,
    decodeResult: decodeResult,
    ABI_VERSION: ABI_VERSION,
    RESULT_BYTES: RESULT_BYTES,
    STOP_REASONS: STOP_REASONS
  };
});
