/*
 * Production loader for the Rust/WASM engine module's raw ABI (version 2).
 *
 * The ordinary `search` entry point serves Play and the deterministic
 * analysis scan. Coaching analysis then uses a stateful exact-root API:
 * `beginAnalysis` starts one shared-budget phase and `searchRoot` scores one
 * forced legal root under a full window, copying its PV before a later phase
 * resets the module's transposition table.
 *
 * Game-prefix repetition history is loaded after every position. The ABI
 * accepts newline-delimited FENs, one line per occurrence; counts above three
 * are immaterial because a third occurrence is already terminal.
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.WasmEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const ABI_VERSION = 2;
  const RESULT_BYTES = 64;
  const INPUT_BYTES = 1024;
  const HISTORY_BYTES = 65536;
  const HISTORY_OCCURRENCES = 768;
  const MAX_SEARCH_DEPTH = 111;
  const NONE_U32 = 0xffffffff;
  const STOP_REASONS = ['unknown', 'max-depth', 'time-limit', 'node-limit', 'mate', 'game-over'];
  const PROMOTIONS = [null, 'Q', 'R', 'B', 'N'];
  const PROMOTION_CODES = { Q: 1, R: 2, B: 3, N: 4 };

  function safeCounter(view, offset, label) {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(label + ' exceeds JavaScript safe-integer range: ' + value);
    }
    return Number(value);
  }

  function decodePackedMove(packedMove, label) {
    if (packedMove === NONE_U32) return null;
    if ((packedMove >>> 15) !== 0) {
      throw new Error(label + ' has non-zero reserved bits: 0x' +
        packedMove.toString(16));
    }
    const promotionCode = (packedMove >>> 12) & 7;
    if (promotionCode >= PROMOTIONS.length) {
      throw new Error(label + ' has invalid promotion code ' + promotionCode);
    }
    return {
      from: packedMove & 63,
      to: (packedMove >>> 6) & 63,
      promotion: PROMOTIONS[promotionCode]
    };
  }

  function packMove(move) {
    if (!move || !Number.isInteger(move.from) || move.from < 0 || move.from >= 64 ||
        !Number.isInteger(move.to) || move.to < 0 || move.to >= 64 ||
        (move.promotion != null && !PROMOTION_CODES[move.promotion])) {
      throw new TypeError('analysis root is not a valid move object');
    }
    return move.from | (move.to << 6) |
      ((move.promotion ? PROMOTION_CODES[move.promotion] : 0) << 12);
  }

  function sameMove(a, b) {
    return !!a && !!b && a.from === b.from && a.to === b.to &&
      (a.promotion || null) === (b.promotion || null);
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
    const attempted = view.getUint32(20, true);
    const stopCode = view.getUint32(56, true);
    if (stopCode >= STOP_REASONS.length) {
      throw new Error('WASM result has invalid stop-reason code ' + stopCode);
    }
    return {
      move: decodePackedMove(view.getUint32(8, true), 'packed move'),
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

  function nowMs() {
    if (typeof performance !== 'undefined' &&
        performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function imports() {
    return { env: { now_ms: nowMs } };
  }

  function wrap(instance) {
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error('WASM module is missing required memory export "memory"');
    }
    const inputPointer = requiredFunction(exports, 'input_ptr');
    const historyPointer = requiredFunction(exports, 'history_ptr');
    const resultPointer = requiredFunction(exports, 'result_ptr');
    const pvPointer = requiredFunction(exports, 'pv_ptr');
    const pvLength = requiredFunction(exports, 'pv_len');
    const loadPosition = requiredFunction(exports, 'load_position');
    const loadHistory = requiredFunction(exports, 'load_history');
    const searchExport = requiredFunction(exports, 'search');
    const evaluateLoaded = requiredFunction(exports, 'evaluate_loaded');
    const fixedSearchExport = requiredFunction(exports, 'fixed_search');
    const analysisBegin = requiredFunction(exports, 'analysis_begin');
    const analysisRoot = requiredFunction(exports, 'analysis_root');
    const encoder = new TextEncoder();

    function writeBytes(pointerFunction, bytes, capacity, label) {
      if (bytes.byteLength > capacity) {
        throw new RangeError(label + ' exceeds WASM capacity: ' +
          bytes.byteLength + ' > ' + capacity);
      }
      const pointer = Number(pointerFunction());
      if (!Number.isSafeInteger(pointer) || pointer < 0 ||
          pointer + bytes.byteLength > exports.memory.buffer.byteLength) {
        throw new Error(label + ' pointer is out of bounds');
      }
      if (bytes.byteLength) {
        new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      }
    }

    function loadFen(fen) {
      if (typeof fen !== 'string') throw new TypeError('fen must be a string');
      const encoded = encoder.encode(fen);
      writeBytes(inputPointer, encoded, INPUT_BYTES, 'encoded FEN');
      const status = loadPosition(encoded.byteLength);
      if (status !== undefined && status !== 0) {
        throw new Error('load_position() failed with status ' + status);
      }
    }

    // A position from before the most recent pawn move or capture can never
    // recur: pawn squares cannot move backwards and captures never restore the
    // piece count. Keep only history with the current pawn placement and piece
    // count. In a valid live game that is at most the current <100 halfmove
    // window, so the fixed transport remains lossless rather than rejecting a
    // very long game whose irrelevant aggregate map has grown past capacity.
    function irreversibleSignature(fen) {
      if (typeof fen !== 'string') throw new TypeError('history FEN must be a string');
      const fields = fen.trim().split(/\s+/);
      if ((fields.length !== 4 && fields.length !== 6) ||
          (fields[1] !== 'w' && fields[1] !== 'b') ||
          !/^(?:-|[KQkq]+)$/.test(fields[2]) ||
          (fields[2] !== '-' && new Set(fields[2]).size !== fields[2].length) ||
          !/^(?:-|[a-h][1-8])$/.test(fields[3]) ||
          (fields.length === 6 &&
            (!/^\d+$/.test(fields[4]) || !/^\d+$/.test(fields[5])))) {
        throw new TypeError('history FEN has invalid fields');
      }
      const board = fields[0];
      const ranks = board.split('/');
      if (ranks.length !== 8) throw new TypeError('history FEN has an invalid board');
      let pieces = 0;
      const pawns = [];
      for (let rank = 0; rank < 8; rank++) {
        let file = 0;
        for (const character of ranks[rank]) {
          if (/[1-8]/.test(character)) {
            file += Number(character);
          } else if (/[prnbqkPRNBQK]/.test(character)) {
            if (file >= 8) throw new TypeError('history FEN has an invalid board');
            pieces++;
            if (character === 'p' || character === 'P') {
              pawns.push(character + (rank * 8 + file));
            }
            file++;
          } else {
            throw new TypeError('history FEN has an invalid board');
          }
        }
        if (file !== 8) throw new TypeError('history FEN has an invalid board');
      }
      return pieces + '|' + pawns.join(',');
    }

    function setHistory(positions, currentFen) {
      const lines = [];
      const currentSignature = irreversibleSignature(currentFen);
      if (positions != null) {
        if (typeof positions !== 'object' || Array.isArray(positions)) {
          throw new TypeError('positions must be an object map');
        }
        Object.keys(positions).sort().forEach(function (fen) {
          const count = positions[fen];
          if (!Number.isInteger(count) || count < 0) {
            throw new TypeError('position occurrence count must be a non-negative integer');
          }
          if (/[\r\n]/.test(fen)) {
            throw new TypeError('position history FEN contains a line break');
          }
          if (irreversibleSignature(fen) !== currentSignature) return;
          for (let i = 0; i < Math.min(count, 3); i++) {
            if (lines.length >= HISTORY_OCCURRENCES) {
              throw new RangeError('repetition history exceeds WASM occurrence capacity');
            }
            lines.push(fen);
          }
        });
      }
      const encoded = encoder.encode(lines.join('\n'));
      writeBytes(historyPointer, encoded, HISTORY_BYTES, 'encoded repetition history');
      const status = loadHistory(encoded.byteLength);
      if (status !== undefined && status !== 0) {
        throw new Error('load_history() failed with status ' + status);
      }
    }

    function prepare(fen, positions) {
      // load_position deliberately clears stale history, so this order is part
      // of ABI v2 rather than an interchangeable implementation detail.
      loadFen(fen);
      setHistory(positions, fen);
    }

    function checkedDepth(value, label) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_DEPTH) {
        throw new RangeError(label + ' must be an integer from 1 through ' +
          MAX_SEARCH_DEPTH);
      }
      return value;
    }

    function checkedFixedDepth(value, label) {
      if (!Number.isInteger(value) || value < 0 || value > MAX_SEARCH_DEPTH) {
        throw new RangeError(label + ' must be an integer from 0 through ' +
          MAX_SEARCH_DEPTH);
      }
      return value;
    }

    function checkedU32(value, label) {
      if (value == null) return 0;
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(label + ' must be an unsigned 32-bit integer');
      }
      return value;
    }

    function decodePv(maxLength) {
      const length = Number(pvLength());
      const pointer = Number(pvPointer());
      if (!Number.isSafeInteger(length) || length < 0 || length > maxLength ||
          !Number.isSafeInteger(pointer) || pointer < 0 ||
          pointer + length * 4 > exports.memory.buffer.byteLength) {
        throw new Error('WASM PV buffer is out of bounds');
      }
      const view = new DataView(exports.memory.buffer, pointer, length * 4);
      const pv = [];
      for (let i = 0; i < length; i++) {
        const move = decodePackedMove(view.getUint32(i * 4, true), 'PV move');
        if (!move) throw new Error('WASM PV contains an empty move');
        pv.push(move);
      }
      return pv;
    }

    return {
      memoryBytes: function () { return exports.memory.buffer.byteLength; },
      setHistory: setHistory,
      evaluate: function (fen) {
        prepare(fen, null);
        return evaluateLoaded();
      },
      search: function (fen, opts) {
        opts = opts || {};
        const maxDepth = checkedDepth(opts.maxDepth, 'maxDepth');
        prepare(fen, opts.positions || null);
        const status = searchExport(
          maxDepth,
          checkedU32(opts.nodeLimit, 'nodeLimit'),
          checkedU32(opts.timeMs, 'timeMs'),
          opts.quiesce ? 1 : 0
        );
        if (status !== 0) {
          throw new Error('search() failed with status ' + status);
        }
        return decodeResult(exports.memory, resultPointer());
      },
      fixedSearch: function (fen, opts) {
        opts = opts || {};
        const depth = checkedFixedDepth(opts.depth, 'fixed search depth');
        prepare(fen, opts.positions || null);
        const status = fixedSearchExport(
          depth,
          checkedU32(opts.nodeLimit, 'nodeLimit'),
          opts.quiesce ? 1 : 0
        );
        if (status !== 0 && status !== 4) {
          throw new Error('fixed_search() failed with status ' + status);
        }
        const result = decodeResult(exports.memory, resultPointer());
        result.complete = status === 0;
        return result;
      },
      beginAnalysis: function (fen, opts) {
        opts = opts || {};
        prepare(fen, opts.positions || null);
        const status = analysisBegin(
          checkedU32(opts.nodeLimit, 'analysis nodeLimit'),
          opts.quiesce ? 1 : 0
        );
        if (status !== 0) {
          throw new Error('analysis_begin() failed with status ' + status);
        }
      },
      searchRoot: function (move, totalDepth, pvLen) {
        const packed = packMove(move);
        const depth = checkedDepth(totalDepth, 'analysis totalDepth');
        const maxPv = checkedDepth(pvLen, 'analysis pvLen');
        const status = analysisRoot(packed, depth, maxPv);
        if (status !== 0 && status !== 4) {
          throw new Error('analysis_root() failed with status ' + status);
        }
        const result = decodeResult(exports.memory, resultPointer());
        if (status === 4) {
          result.complete = false;
          result.pv = [];
          return result;
        }
        if (!sameMove(result.move, move)) {
          throw new Error('analysis_root() returned a different root move');
        }
        result.pv = decodePv(maxPv);
        if (!result.pv.length || !sameMove(result.pv[0], move)) {
          throw new Error('analysis_root() PV does not begin with its forced root');
        }
        result.complete = true;
        return result;
      }
    };
  }

  async function load(wasmBytes) {
    const loaded = await WebAssembly.instantiate(wasmBytes, imports());
    return wrap(loaded.instance || loaded);
  }

  function loadSync(wasmBytes) {
    const module = wasmBytes instanceof WebAssembly.Module
      ? wasmBytes : new WebAssembly.Module(wasmBytes);
    return wrap(new WebAssembly.Instance(module, imports()));
  }

  return {
    load: load,
    loadSync: loadSync,
    decodeResult: decodeResult,
    ABI_VERSION: ABI_VERSION,
    RESULT_BYTES: RESULT_BYTES,
    HISTORY_BYTES: HISTORY_BYTES,
    HISTORY_OCCURRENCES: HISTORY_OCCURRENCES,
    STOP_REASONS: STOP_REASONS
  };
});
