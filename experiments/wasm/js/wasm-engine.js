/*
 * Loader/adapter for the Zig WASM play-search module (raw ABI).
 *
 * Works in Node (pass a Buffer/Uint8Array of chessy.wasm) and in browsers /
 * workers (pass an ArrayBuffer). The adapter mirrors ChessAI.think()'s result
 * shape closely enough for differential comparison:
 *   { move: {from,to,promotion}, moveStr, score, depth, attemptedDepth,
 *     nodes, qnodes, cutoffs, researches, stopReason, rootOrderUci }
 *
 * Search options: { maxDepth, timeMs, nodeLimit, quiesce, seed }.
 *   - seed replicates ai.js's seeded root shuffle (mulberry32); omit for
 *     randomize:false semantics (no shuffle).
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.ChessyWasm = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const FILES = 'abcdefgh';
  const STOP_REASONS = ['max-depth', 'time-limit', 'node-limit', 'mate', 'game-over'];
  const PROMO_LETTER = [null, 'P', 'N', 'B', 'R', 'Q', 'K'];

  function sqName(i) { return FILES[i % 8] + (8 - Math.floor(i / 8)); }

  async function load(wasmBytes, importsExtra) {
    const imports = {
      env: Object.assign({ now_ms: function () { return Date.now(); } },
        importsExtra || {})
    };
    const result = await WebAssembly.instantiate(wasmBytes, imports);
    const instance = result.instance || result; // Module path vs bytes path
    const ex = instance.exports;
    const mem = ex.memory;
    const inPtr = ex.inPtr();
    const outPtr = ex.outPtr();
    const encoder = new TextEncoder();

    function writeFen(fen) {
      const bytes = encoder.encode(fen);
      if (bytes.length > 255) throw new Error('FEN too long');
      new Uint8Array(mem.buffer, inPtr, bytes.length).set(bytes);
      return bytes.length;
    }

    function readOut() {
      const out = new Int32Array(mem.buffer, outPtr, 300);
      if (out[0] !== 0) return { error: 'bad FEN input' };
      const from = out[1], to = out[2], promoType = out[3];
      const promotion = from >= 0 && promoType ? PROMO_LETTER[promoType] : null;
      const move = from >= 0 ? { from: from, to: to, promotion: promotion } : null;
      const rootN = out[12];
      const rootOrderUci = [];
      for (let i = 0; i < rootN; i++) {
        const pk = out[13 + i];
        const f = (pk >> 9) & 63, t = (pk >> 3) & 63, pi = pk & 7;
        const promo = pi === 1 ? 'q' : pi === 2 ? 'r' : pi === 3 ? 'b' : pi === 4 ? 'n' : '';
        rootOrderUci.push(sqName(f) + sqName(t) + promo);
      }
      return {
        move: move,
        moveStr: move
          ? sqName(move.from) + sqName(move.to) + (move.promotion || '')
          : '-',
        score: out[4],
        depth: out[5],
        attemptedDepth: out[6] < 0 ? null : out[6],
        nodes: out[7],
        qnodes: out[8],
        cutoffs: out[9],
        researches: out[10],
        stopReason: STOP_REASONS[out[11]] || 'unknown',
        rootOrderUci: rootOrderUci
      };
    }

    return {
      instance: instance,
      memoryBytes: function () { return mem.buffer.byteLength; },
      reset: function () { ex.reset(); },
      search: function (fen, opts) {
        opts = opts || {};
        const len = writeFen(fen);
        const status = ex.search(
          len,
          opts.maxDepth || 0,
          opts.timeMs || 0,
          opts.nodeLimit == null ? -1 : opts.nodeLimit,
          opts.quiesce ? 1 : 0,
          opts.seed == null ? 0 : 1,
          opts.seed == null ? 0 : (opts.seed | 0)
        );
        if (status !== 0) return { error: 'bad FEN input' };
        return readOut();
      },
      perft: function (fen, depth) {
        const len = writeFen(fen);
        return ex.perft(len, depth);
      },
      evalFen: function (fen) {
        const len = writeFen(fen);
        return ex.evalFen(len);
      }
    };
  }

  return { load: load };
});
