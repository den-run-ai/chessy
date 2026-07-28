/*
 * Chessy Rust/WASM feasibility benchmark.
 *
 * This is intentionally isolated from the shipped worker. It compares the
 * experimental module with the current JavaScript engine over the same
 * 18-position (nine mirrored families) corpus as test/ai-bench.js.
 *
 * Usage:
 *   node experiments/wasm/bench.js
 *   node experiments/wasm/bench.js --wasm /path/to/chessy-ai.wasm
 *   node experiments/wasm/bench.js --baseline-wasm /path/to/reference.wasm
 *   node experiments/wasm/bench.js --depth 5 --reps 4 --min-ms 250
 *   node experiments/wasm/bench.js --require-go
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const performance = require('perf_hooks').performance;

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_WASM = path.join(__dirname, 'dist', 'chessy-ai-fast.wasm');
const ABI_VERSION = 1;
const RESULT_BYTES = 64;
const INPUT_BYTES = 1024;
const MAX_SEARCH_DEPTH = 111;
const NONE_U32 = 0xffffffff;
const SEED = 0xC0FFEE;

const STOP_REASONS = Object.freeze([
  'unknown',
  'max-depth',
  'time-limit',
  'node-limit',
  'mate',
  'game-over'
]);

// Keep this list byte-for-byte aligned with test/ai-bench.js. Each position
// is paired with a vertical mirror/color swap below.
const FAMILIES = Object.freeze([
  ['opening (Ruy Lopez)', 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5'],
  ['open middlegame (Dragon)', 'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1'],
  ['closed middlegame (KID)', 'r1bq1rk1/ppp1n1bp/3p2p1/3Pp3/2P1P3/2N2N2/PP3PPP/R1BQ1RK1 w - - 0 1'],
  ['tactical middlegame (Kiwipete)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['rook ending (Lucena)', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
  ['minor-piece ending', '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1'],
  ['promotion race', '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1'],
  ['pawn ending (zugzwang)', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  ['tactical defence (chessy202607240238)', 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27']
]);

function mirrorFen(fen) {
  const fields = fen.split(' ');
  function swap(piece) {
    return piece === piece.toUpperCase()
      ? piece.toLowerCase()
      : piece.toUpperCase();
  }
  fields[0] = fields[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (ch) {
      return /\d/.test(ch) ? ch : swap(ch);
    }).join('');
  }).join('/');
  fields[1] = fields[1] === 'w' ? 'b' : 'w';
  if (fields[2] !== '-') {
    fields[2] = fields[2].split('').map(swap).sort().join('');
  }
  if (fields[3] !== '-') {
    fields[3] = fields[3][0] + (9 - Number(fields[3][1]));
  }
  return fields.join(' ');
}

const POSITIONS = Object.freeze(FAMILIES.reduce(function (positions, family) {
  positions.push([family[0], family[1]]);
  positions.push([family[0] + ' (mirrored)', mirrorFen(family[1])]);
  return positions;
}, []));

function squareName(square) {
  return 'abcdefgh'[square % 8] + (8 - Math.floor(square / 8));
}

function safeCounter(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(label + ' exceeds JavaScript safe-integer range: ' + value);
  }
  return Number(value);
}

/*
 * Decode the experiment's native packed result. This deliberately does not
 * guess at layout changes: the two header fields make an ABI mismatch a hard
 * failure before any benchmark number can be trusted.
 */
function decodeResult(memory, resultPointer) {
  if (!memory || !(memory.buffer instanceof ArrayBuffer)) {
    throw new Error('WASM export "memory" is not a WebAssembly.Memory-like object');
  }
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
      ' does not match harness version ' + ABI_VERSION);
  }
  if (bytes !== RESULT_BYTES) {
    throw new Error('WASM result struct is ' + bytes +
      ' bytes; harness requires exactly ' + RESULT_BYTES);
  }

  const packedMove = view.getUint32(8, true);
  let move = '-';
  if (packedMove !== NONE_U32) {
    if ((packedMove >>> 15) !== 0) {
      throw new Error('packed move has non-zero reserved bits: 0x' +
        packedMove.toString(16));
    }
    const from = packedMove & 63;
    const to = (packedMove >>> 6) & 63;
    const promotionCode = (packedMove >>> 12) & 7;
    const promotions = ['', 'Q', 'R', 'B', 'N'];
    if (promotionCode >= promotions.length) {
      throw new Error('packed move has invalid promotion code ' + promotionCode);
    }
    move = squareName(from) + squareName(to) + promotions[promotionCode];
  }

  const attempted = view.getUint32(20, true);
  const stopCode = view.getUint32(56, true);
  if (stopCode >= STOP_REASONS.length) {
    throw new Error('WASM result has invalid stop-reason code ' + stopCode);
  }
  return {
    move: move,
    score: view.getInt32(12, true),
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

function checkedPointer(value, label, byteLength, memory) {
  const pointer = Number(value);
  if (!Number.isSafeInteger(pointer) || pointer < 0 ||
      pointer + byteLength > memory.buffer.byteLength) {
    throw new Error(label + ' returned an out-of-bounds pointer: ' + value);
  }
  return pointer;
}

function brotliSize(bytes) {
  return zlib.brotliCompressSync(bytes, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11
    }
  }).byteLength;
}

async function loadWasmEngine(wasmPath, label) {
  const resolved = path.resolve(wasmPath || DEFAULT_WASM);
  const bytes = fs.readFileSync(resolved);
  const started = performance.now();
  const loaded = await WebAssembly.instantiate(bytes, {
    env: {
      now_ms: function () { return performance.now(); }
    }
  });
  const initMs = performance.now() - started;
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
  const initialMemoryBytes = exports.memory.buffer.byteLength;

  return {
    label: label || 'WASM',
    path: resolved,
    binaryBytes: bytes.byteLength,
    brotliBytes: brotliSize(bytes),
    initMs: initMs,
    initialMemoryBytes: initialMemoryBytes,
    search: function (fen, options) {
      const encoded = encoder.encode(fen);
      if (encoded.byteLength > INPUT_BYTES) {
        throw new RangeError(
          'encoded FEN exceeds WASM input capacity: ' +
          encoded.byteLength + ' > ' + INPUT_BYTES);
      }
      if (!Number.isInteger(options.maxDepth) ||
          options.maxDepth < 1 ||
          options.maxDepth > MAX_SEARCH_DEPTH) {
        throw new RangeError(
          'maxDepth must be an integer from 1 through ' + MAX_SEARCH_DEPTH);
      }
      const pointer = checkedPointer(
        inputPointer(), 'input_ptr()', encoded.byteLength, exports.memory);
      new Uint8Array(exports.memory.buffer, pointer, encoded.byteLength).set(encoded);
      const loadStatus = loadPosition(encoded.byteLength);
      if (loadStatus !== undefined && loadStatus !== 0) {
        throw new Error('load_position() failed with status ' + loadStatus);
      }

      const startedSearch = process.hrtime.bigint();
      const status = search(
        options.maxDepth,
        options.nodeLimit || 0,
        options.timeMs || 0,
        options.quiesce ? 1 : 0
      );
      const elapsedMs = Number(process.hrtime.bigint() - startedSearch) / 1e6;
      if (status !== 0) {
        throw new Error('search() failed with status ' + status);
      }
      const result = decodeResult(exports.memory, resultPointer());
      result.ms = elapsedMs;
      return result;
    },
    memoryBytes: function () {
      return exports.memory.buffer.byteLength;
    }
  };
}

const MAKE_RANDOM = [
  'function __wasmBenchRandom(seed) {',
  '  return function () {',
  '    seed = (seed + 0x6D2B79F5) | 0;',
  '    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);',
  '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;',
  '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;',
  '  };',
  '}'
].join('\n');

function loadJsEngine() {
  const context = vm.createContext({ console: console });
  vm.runInContext(MAKE_RANDOM, context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'assets', 'engine.js'), 'utf8'),
    context,
    { filename: 'assets/engine.js' }
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'assets', 'ai.js'), 'utf8'),
    context,
    { filename: 'assets/ai.js' }
  );

  return {
    label: 'JavaScript',
    search: function (fen, options) {
      // This is the current ai-bench.js contract: the root shuffle is reset
      // to the same seed before every search. The experimental WASM engine
      // embeds the same seed until a seed/history ABI is deliberately added.
      vm.runInContext('Math.random = __wasmBenchRandom(' + SEED + ')', context);
      const state = context.Chess.parseFen(fen);
      const startedSearch = process.hrtime.bigint();
      const result = context.ChessAI.think(state, {
        maxDepth: options.maxDepth,
        nodeLimit: options.nodeLimit || undefined,
        timeMs: options.timeMs || undefined,
        quiesce: options.quiesce
      });
      const elapsedMs = Number(process.hrtime.bigint() - startedSearch) / 1e6;
      return {
        move: result.move
          ? context.Chess.sqName(result.move.from) +
            context.Chess.sqName(result.move.to) +
            (result.move.promotion || '')
          : '-',
        score: result.score,
        depth: result.depth,
        attemptedDepth: result.attemptedDepth,
        nodes: result.nodes,
        qnodes: result.qnodes || 0,
        cutoffs: result.cutoffs || 0,
        researches: result.researches || 0,
        stopReason: result.stopReason,
        ms: elapsedMs
      };
    }
  };
}

const SIGNATURE_FIELDS = Object.freeze([
  'move',
  'score',
  'depth',
  'attemptedDepth',
  'nodes',
  'qnodes',
  'cutoffs',
  'researches',
  'stopReason'
]);

function signatureDifferences(candidate, baseline) {
  return SIGNATURE_FIELDS.filter(function (field) {
    return candidate[field] !== baseline[field];
  }).map(function (field) {
    return field + ': candidate=' + candidate[field] +
      ', baseline=' + baseline[field];
  });
}

function sameSearch(a, b) {
  return signatureDifferences(a, b).length === 0;
}

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function geometricMean(values) {
  return Math.exp(values.reduce(function (sum, value) {
    return sum + Math.log(value);
  }, 0) / values.length);
}

function summarize(samples, label) {
  const first = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (!sameSearch(samples[i], first)) {
      throw new Error(label + ' changed across identical timed repetitions: ' +
        signatureDifferences(samples[i], first).join('; '));
    }
  }
  const timings = samples.map(function (sample) { return sample.ms; });
  const med = median(timings);
  return Object.assign({}, first, {
    ms: med,
    madMs: median(timings.map(function (timing) {
      return Math.abs(timing - med);
    }))
  });
}

function runBatch(engine, fen, options, batch) {
  const samples = [];
  for (let i = 0; i < batch; i++) {
    samples.push(engine.search(fen, options));
  }
  const result = summarize(samples, engine.label + ' timing batch');
  result.ms = samples.reduce(function (sum, sample) {
    return sum + sample.ms;
  }, 0) / samples.length;
  return result;
}

function orderedPair(wasm, js, fen, options, wasmFirst, batch) {
  if (wasmFirst) {
    const candidate = runBatch(wasm, fen, options, batch);
    return [candidate, runBatch(js, fen, options, batch)];
  }
  const baseline = runBatch(js, fen, options, batch);
  return [runBatch(wasm, fen, options, batch), baseline];
}

function benchmarkPosition(wasm, js, fen, index, options, reps, minimumMs) {
  const warm = orderedPair(wasm, js, fen, options, index % 2 === 0, 1);
  const batch = Math.max(1, Math.ceil(
    minimumMs / Math.min(warm[0].ms, warm[1].ms)));
  const wasmSamples = [];
  const jsSamples = [];
  const ratioLogs = [];
  for (let repetition = 0; repetition < reps; repetition++) {
    const pair = orderedPair(
      wasm,
      js,
      fen,
      options,
      (index + repetition) % 2 === 0,
      batch
    );
    wasmSamples.push(pair[0]);
    jsSamples.push(pair[1]);
    ratioLogs.push(Math.log(
      (pair[0].nodes / pair[0].ms) /
      (pair[1].nodes / pair[1].ms)
    ));
  }
  const medianLog = median(ratioLogs);
  return {
    wasm: summarize(wasmSamples, wasm.label),
    js: summarize(jsSamples, js.label),
    speedRatio: Math.exp(medianLog),
    speedMadLog: median(ratioLogs.map(function (value) {
      return Math.abs(value - medianLog);
    })),
    batch: batch,
    firstWasmMs: warm[0].ms
  };
}

function option(args, name, fallback) {
  const index = args.indexOf('--' + name);
  return index < 0 ? fallback : args[index + 1];
}

function parseOptions(argv) {
  const depth = Number(option(argv, 'depth', 5));
  const reps = Number(option(argv, 'reps', 4));
  const minimumMs = Number(option(argv, 'min-ms', 250));
  if (!Number.isInteger(depth) || depth < 1 || depth > 64) {
    throw new Error('--depth must be an integer from 1 to 64');
  }
  if (!Number.isInteger(reps) || reps < 2 || reps > 20 || reps % 2 !== 0) {
    throw new Error('--reps must be an even integer from 2 to 20');
  }
  if (!Number.isFinite(minimumMs) || minimumMs <= 0) {
    throw new Error('--min-ms must be positive');
  }
  return {
    depth: depth,
    reps: reps,
    minimumMs: minimumMs,
    wasmPath: option(argv, 'wasm', DEFAULT_WASM),
    baselineWasmPath: option(argv, 'baseline-wasm', null),
    requireGo: argv.includes('--require-go')
  };
}

function gateOutcome(geomeanRatio, familyRatios) {
  const slowFamilies = familyRatios.filter(function (family) {
    return family.ratio < 1;
  });
  if (geomeanRatio < 1.25) {
    return {
      code: 'NO-GO',
      reason: 'geomean is below the 1.25x early-stop floor'
    };
  }
  if (geomeanRatio < 1.35) {
    return {
      code: 'PROFILE-ONCE',
      reason: 'geomean is 1.25x-1.35x; permit one bounded profiling correction'
    };
  }
  if (slowFamilies.length) {
    return {
      code: 'NO-GO',
      reason: slowFamilies.length + ' mirrored family/families are slower than JavaScript'
    };
  }
  return {
    code: 'GO-TO-DEVICES',
    reason: 'geomean is at least 1.35x and no mirrored family is slower'
  };
}

async function main(argv) {
  const config = parseOptions(argv || process.argv.slice(2));
  const wasm = await loadWasmEngine(config.wasmPath, 'Candidate WASM');
  const js = config.baselineWasmPath
    ? await loadWasmEngine(config.baselineWasmPath, 'Reference WASM')
    : loadJsEngine();
  if (config.requireGo && config.baselineWasmPath) {
    throw new Error('--require-go is only valid against the JavaScript baseline');
  }
  const options = {
    maxDepth: config.depth,
    nodeLimit: 0,
    timeMs: 0,
    quiesce: true
  };
  const positionRatios = [];
  let firstSearchMs = null;

  console.log('Chessy WASM feasibility screen');
  console.log('candidate: ' + wasm.path);
  if (config.baselineWasmPath) {
    console.log('reference: ' + js.path);
  }
  console.log('depth ' + config.depth + ', seed 0x' + SEED.toString(16) +
    ', quiescence on, no history');
  console.log('timing: full-depth warm-up; ' + config.reps +
    ' paired AB/BA repetitions; >= ' + config.minimumMs +
    ' ms per batched side');
  console.log('');

  for (let index = 0; index < POSITIONS.length; index++) {
    const name = POSITIONS[index][0];
    const pair = benchmarkPosition(
      wasm,
      js,
      POSITIONS[index][1],
      index,
      options,
      config.reps,
      config.minimumMs
    );
    if (firstSearchMs === null) firstSearchMs = pair.firstWasmMs;
    const differences = signatureDifferences(pair.wasm, pair.js);
    if (differences.length) {
      throw new Error('exact-search mismatch at ' + name + ': ' +
        differences.join('; '));
    }
    positionRatios.push(pair.speedRatio);
    console.log(
      name.padEnd(42) +
      String(pair.wasm.nodes).padStart(9) + ' n  d' + pair.wasm.depth +
      '  ' + pair.wasm.move.padEnd(6) +
      '  ' + wasm.label + ' ' +
      pair.wasm.ms.toFixed(2).padStart(8) + ' ms' +
      '  ' + js.label + ' ' +
      pair.js.ms.toFixed(2).padStart(8) + ' ms' +
      '  NPS ' + pair.speedRatio.toFixed(3) + 'x' +
      (pair.batch > 1 ? '  batch ' + pair.batch : '')
    );
  }

  const familyRatios = FAMILIES.map(function (family, index) {
    return {
      name: family[0],
      ratio: Math.sqrt(
        positionRatios[index * 2] * positionRatios[index * 2 + 1])
    };
  });
  const sortedFamilies = familyRatios.slice().sort(function (a, b) {
    return a.ratio - b.ratio;
  });
  const p10Index = Math.max(0, Math.ceil(0.1 * sortedFamilies.length) - 1);
  const geomeanRatio = geometricMean(positionRatios);
  const outcome = config.baselineWasmPath
    ? {
        code: 'COMPARISON-ONLY',
        reason: 'candidate/reference ratio; JavaScript device gate not evaluated'
      }
    : gateOutcome(geomeanRatio, familyRatios);

  console.log('');
  console.log('exact-search parity: PASS (18/18)');
  console.log('geomean paired NPS ratio: ' + geomeanRatio.toFixed(4) + 'x');
  console.log('worst-family NPS ratio:   ' +
    sortedFamilies[0].ratio.toFixed(4) + 'x (' +
    sortedFamilies[0].name + ')');
  console.log('p10-family NPS ratio:     ' +
    sortedFamilies[p10Index].ratio.toFixed(4) + 'x (' +
    sortedFamilies[p10Index].name + ')');
  console.log('binary: ' + wasm.binaryBytes + ' bytes raw, ' +
    wasm.brotliBytes + ' bytes Brotli');
  console.log('instantiation: ' + wasm.initMs.toFixed(2) +
    ' ms; first search: ' + firstSearchMs.toFixed(2) + ' ms');
  console.log('linear memory: ' + wasm.initialMemoryBytes + ' bytes initial, ' +
    wasm.memoryBytes() + ' bytes final/peak-observed');
  console.log('decision: ' + outcome.code + ' — ' + outcome.reason);

  if (config.requireGo && outcome.code !== 'GO-TO-DEVICES') {
    process.exitCode = 2;
  }
  return outcome;
}

module.exports = Object.freeze({
  ABI_VERSION: ABI_VERSION,
  RESULT_BYTES: RESULT_BYTES,
  NONE_U32: NONE_U32,
  SEED: SEED,
  STOP_REASONS: STOP_REASONS,
  FAMILIES: FAMILIES,
  POSITIONS: POSITIONS,
  decodeResult: decodeResult,
  loadWasmEngine: loadWasmEngine,
  loadJsEngine: loadJsEngine,
  signatureDifferences: signatureDifferences,
  gateOutcome: gateOutcome,
  main: main
});

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (error) {
    console.error('FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  });
}
