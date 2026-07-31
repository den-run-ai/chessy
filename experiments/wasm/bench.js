/*
 * Chessy Rust/WASM feasibility benchmark.
 *
 * This is intentionally isolated from the shipped worker. It measures one
 * module or performs a paired candidate/reference-WASM comparison over the
 * 18-position (nine mirrored families) corpus. The removed JavaScript search
 * is not loaded; shallow exactness is checked against the frozen r69 WASM
 * signatures in test/fixtures/wasm-r69-signatures.json.
 *
 * Usage:
 *   node experiments/wasm/bench.js
 *   node experiments/wasm/bench.js --wasm /path/to/chessy-ai.wasm
 *   node experiments/wasm/bench.js --baseline-wasm /path/to/reference.wasm
 *   node experiments/wasm/bench.js --depth 5 --reps 4 --min-ms 250
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const performance = require('perf_hooks').performance;

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_WASM = path.join(__dirname, 'dist', 'chessy-ai-fast.wasm');
const FROZEN_SIGNATURE_PATH = path.join(
  ROOT, 'test', 'fixtures', 'wasm-r69-signatures.json');
// The production loader deliberately accepts only the current ABI. Developer
// comparison harnesses also need to measure the frozen r69 ABI-v1 module
// against ABI-v2 candidates. Versions 1 and 2 share this exact ordinary-search
// surface: input/result pointers, load_position(len), search(d,nodes,ms,q), and
// the 64-byte result layout below. Do not add a future version here unless that
// whole surface has been reviewed as byte- and call-compatible.
const ABI_VERSION = 2;
const ORDINARY_ABI_VERSIONS = Object.freeze([1, 2]);
const RESULT_BYTES = 64;
const INPUT_BYTES = 1024;
const MAX_SEARCH_DEPTH = 111;
const EXPERIMENT_METRIC_SLOTS = 16;
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
 * Decode the experiment's native packed ordinary-search result. This
 * deliberately accepts only the two reviewed, layout-compatible ABIs and does
 * not guess at future layout changes.
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
  if (!ORDINARY_ABI_VERSIONS.includes(version)) {
    throw new Error('WASM result ABI version ' + version +
      ' is not supported by the ordinary-search harness (expected 1 or 2)');
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
    abiVersion: version,
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

function requiredFunction(exports, name, arity) {
  if (typeof exports[name] !== 'function') {
    throw new Error('WASM module is missing required function export "' + name + '"');
  }
  if (Number.isInteger(arity) && exports[name].length !== arity) {
    throw new Error('WASM export "' + name + '" has arity ' +
      exports[name].length + '; ordinary-search harness requires ' + arity);
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

async function loadOrdinaryWasmBytes(wasmBytes, label, source) {
  if (!ArrayBuffer.isView(wasmBytes) || wasmBytes.byteLength === 0) {
    throw new TypeError('ordinary WASM bytes must be a non-empty typed array');
  }
  const bytes = wasmBytes;
  const resolved = source || '<in-memory WASM>';
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
  const inputPointer = requiredFunction(exports, 'input_ptr', 0);
  const resultPointer = requiredFunction(exports, 'result_ptr', 0);
  const loadPosition = requiredFunction(exports, 'load_position', 1);
  const search = requiredFunction(exports, 'search', 4);
  const experimentMetric = typeof exports.experiment_metric === 'function'
    ? exports.experiment_metric
    : null;
  const encoder = new TextEncoder();
  const initialMemoryBytes = exports.memory.buffer.byteLength;
  const initialResult = decodeResult(exports.memory, resultPointer());

  return {
    abiVersion: initialResult.abiVersion,
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
      if (experimentMetric) {
        result.experimentMetrics = [];
        for (let index = 0; index < EXPERIMENT_METRIC_SLOTS; index++) {
          const value = experimentMetric(index);
          if (typeof value !== 'bigint' || value < 0n ||
              value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('experiment_metric(' + index +
              ') must return a non-negative safe u64, got ' + String(value));
          }
          result.experimentMetrics.push(Number(value));
        }
      } else {
        result.experimentMetrics = null;
      }
      result.ms = elapsedMs;
      return result;
    },
    memoryBytes: function () {
      return exports.memory.buffer.byteLength;
    }
  };
}

async function loadWasmEngine(wasmPath, label) {
  const resolved = path.resolve(wasmPath || DEFAULT_WASM);
  return loadOrdinaryWasmBytes(
    fs.readFileSync(resolved), label, resolved);
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

function signatureKey(name, options) {
  return [
    name,
    options.maxDepth,
    options.nodeLimit || 0,
    options.timeMs || 0,
    options.quiesce ? 1 : 0
  ].join('\u0000');
}

function loadFrozenSignatures() {
  const fixture = JSON.parse(fs.readFileSync(FROZEN_SIGNATURE_PATH, 'utf8'));
  if (fixture.schema !== 1 ||
      JSON.stringify(fixture.fields) !== JSON.stringify(SIGNATURE_FIELDS) ||
      !Array.isArray(fixture.cases)) {
    throw new Error('invalid frozen WASM signature fixture');
  }
  const byKey = new Map();
  for (const item of fixture.cases) {
    if (!item || typeof item.name !== 'string' ||
        !item.config || !item.result) {
      throw new Error('malformed frozen WASM signature case');
    }
    const key = signatureKey(item.name, item.config);
    if (byKey.has(key)) {
      throw new Error('duplicate frozen WASM signature case: ' + item.name);
    }
    byKey.set(key, Object.freeze(Object.assign({}, item.result)));
  }
  return Object.freeze({
    schema: fixture.schema,
    source: fixture.source,
    sourceCommit: fixture.sourceCommit,
    sourceWasmSha256: fixture.sourceWasmSha256,
    fields: SIGNATURE_FIELDS,
    cases: Object.freeze(fixture.cases.slice()),
    byKey: byKey
  });
}

const FROZEN_SIGNATURES = loadFrozenSignatures();

function frozenSignature(name, options) {
  return FROZEN_SIGNATURES.byKey.get(signatureKey(name, options)) || null;
}

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

function orderedPair(candidateEngine, referenceEngine, fen, options,
  candidateFirst, batch) {
  if (candidateFirst) {
    const candidate = runBatch(candidateEngine, fen, options, batch);
    return [candidate, runBatch(referenceEngine, fen, options, batch)];
  }
  const reference = runBatch(referenceEngine, fen, options, batch);
  return [runBatch(candidateEngine, fen, options, batch), reference];
}

function benchmarkPair(candidateEngine, referenceEngine, fen, index, options,
  reps, minimumMs) {
  const warm = orderedPair(
    candidateEngine, referenceEngine, fen, options, index % 2 === 0, 1);
  const batch = Math.max(1, Math.ceil(
    minimumMs / Math.min(warm[0].ms, warm[1].ms)));
  const candidateSamples = [];
  const referenceSamples = [];
  const ratioLogs = [];
  for (let repetition = 0; repetition < reps; repetition++) {
    const pair = orderedPair(
      candidateEngine,
      referenceEngine,
      fen,
      options,
      (index + repetition) % 2 === 0,
      batch
    );
    candidateSamples.push(pair[0]);
    referenceSamples.push(pair[1]);
    ratioLogs.push(Math.log(
      (pair[0].nodes / pair[0].ms) /
      (pair[1].nodes / pair[1].ms)
    ));
  }
  const medianLog = median(ratioLogs);
  return {
    candidate: summarize(candidateSamples, candidateEngine.label),
    reference: summarize(referenceSamples, referenceEngine.label),
    speedRatio: Math.exp(medianLog),
    speedMadLog: median(ratioLogs.map(function (value) {
      return Math.abs(value - medianLog);
    })),
    batch: batch,
    firstCandidateMs: warm[0].ms
  };
}

function benchmarkSingle(engine, fen, options, reps, minimumMs) {
  const warm = runBatch(engine, fen, options, 1);
  const batch = Math.max(1, Math.ceil(minimumMs / warm.ms));
  const samples = [];
  for (let repetition = 0; repetition < reps; repetition++) {
    samples.push(runBatch(engine, fen, options, batch));
  }
  return {
    result: summarize(samples, engine.label),
    batch: batch,
    firstMs: warm.ms
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
  if (argv.includes('--require-go')) {
    throw new Error('--require-go was retired with the JavaScript speed baseline; ' +
      'use --baseline-wasm for an explicit paired comparison');
  }
  return {
    depth: depth,
    reps: reps,
    minimumMs: minimumMs,
    wasmPath: option(argv, 'wasm', DEFAULT_WASM),
    baselineWasmPath: option(argv, 'baseline-wasm', null)
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
      reason: slowFamilies.length +
        ' mirrored family/families are slower than the reference'
    };
  }
  return {
    code: 'GO-TO-DEVICES',
    reason: 'geomean is at least 1.35x and no mirrored family is slower'
  };
}

async function main(argv) {
  const config = parseOptions(argv || process.argv.slice(2));
  const candidate = await loadWasmEngine(config.wasmPath, 'Candidate WASM');
  const reference = config.baselineWasmPath
    ? await loadWasmEngine(config.baselineWasmPath, 'Reference WASM')
    : null;
  const options = {
    maxDepth: config.depth,
    nodeLimit: 0,
    timeMs: 0,
    quiesce: true
  };
  const positionRatios = [];
  const positionNps = [];
  let firstSearchMs = null;
  let frozenChecked = 0;

  console.log('Chessy WASM benchmark');
  console.log('candidate: ' + candidate.path +
    ' (ordinary result ABI ' + candidate.abiVersion + ')');
  if (reference) {
    console.log('reference: ' + reference.path +
      ' (ordinary result ABI ' + reference.abiVersion + ')');
  }
  console.log('depth ' + config.depth + ', seed 0x' + SEED.toString(16) +
    ', quiescence on, no history');
  console.log('timing: full-depth warm-up; ' + config.reps +
    ' paired AB/BA repetitions; >= ' + config.minimumMs +
    ' ms per batched side');
  console.log('');

  for (let index = 0; index < POSITIONS.length; index++) {
    const name = POSITIONS[index][0];
    const fen = POSITIONS[index][1];
    let result;
    let detail;
    if (reference) {
      const pair = benchmarkPair(
        candidate,
        reference,
        fen,
        index,
        options,
        config.reps,
        config.minimumMs
      );
      if (firstSearchMs === null) firstSearchMs = pair.firstCandidateMs;
      const differences = signatureDifferences(
        pair.candidate, pair.reference);
      if (differences.length) {
        throw new Error('candidate/reference mismatch at ' + name + ': ' +
          differences.join('; '));
      }
      result = pair.candidate;
      positionRatios.push(pair.speedRatio);
      detail =
        candidate.label + ' ' +
        pair.candidate.ms.toFixed(2).padStart(8) + ' ms' +
        '  ' + reference.label + ' ' +
        pair.reference.ms.toFixed(2).padStart(8) + ' ms' +
        '  NPS ' + pair.speedRatio.toFixed(3) + 'x' +
        (pair.batch > 1 ? '  batch ' + pair.batch : '');
    } else {
      const single = benchmarkSingle(
        candidate, fen, options, config.reps, config.minimumMs);
      if (firstSearchMs === null) firstSearchMs = single.firstMs;
      result = single.result;
      const nps = result.nodes / result.ms * 1000;
      positionNps.push(nps);
      detail =
        candidate.label + ' ' +
        result.ms.toFixed(2).padStart(8) + ' ms' +
        '  ' + Math.round(nps).toLocaleString('en-US').padStart(12) + ' nps' +
        (single.batch > 1 ? '  batch ' + single.batch : '');
    }

    const frozen = frozenSignature(name, options);
    if (frozen) {
      const differences = signatureDifferences(result, frozen);
      if (differences.length) {
        throw new Error('frozen r69 signature mismatch at ' + name + ': ' +
          differences.join('; '));
      }
      frozenChecked++;
    }
    console.log(
      name.padEnd(42) +
      String(result.nodes).padStart(9) + ' n  d' + result.depth +
      '  ' + result.move.padEnd(6) + '  ' + detail
    );
  }

  const outcome = {
    code: reference ? 'COMPARISON-ONLY' : 'MEASURE-ONLY',
    reason: reference
      ? 'explicit candidate/reference-WASM comparison'
      : 'absolute candidate timing; no implicit search implementation baseline'
  };

  console.log('');
  if (reference) {
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
    console.log('candidate/reference exact parity: PASS (18/18)');
    console.log('geomean paired NPS ratio: ' +
      geometricMean(positionRatios).toFixed(4) + 'x');
    console.log('worst-family NPS ratio:   ' +
      sortedFamilies[0].ratio.toFixed(4) + 'x (' +
      sortedFamilies[0].name + ')');
    console.log('p10-family NPS ratio:     ' +
      sortedFamilies[p10Index].ratio.toFixed(4) + 'x (' +
      sortedFamilies[p10Index].name + ')');
  } else {
    console.log('geomean absolute NPS: ' +
      Math.round(geometricMean(positionNps)).toLocaleString('en-US'));
  }
  console.log('frozen r69 signatures: ' +
    (frozenChecked ? 'PASS (' + frozenChecked + '/18)' :
      'not available for depth ' + config.depth));
  console.log('binary: ' + candidate.binaryBytes + ' bytes raw, ' +
    candidate.brotliBytes + ' bytes Brotli');
  console.log('instantiation: ' + candidate.initMs.toFixed(2) +
    ' ms; first search: ' + firstSearchMs.toFixed(2) + ' ms');
  console.log('linear memory: ' + candidate.initialMemoryBytes +
    ' bytes initial, ' + candidate.memoryBytes() + ' bytes final/peak-observed');
  console.log('decision: ' + outcome.code + ' — ' + outcome.reason);
  return outcome;
}

module.exports = Object.freeze({
  ABI_VERSION: ABI_VERSION,
  ORDINARY_ABI_VERSIONS: ORDINARY_ABI_VERSIONS,
  RESULT_BYTES: RESULT_BYTES,
  EXPERIMENT_METRIC_SLOTS: EXPERIMENT_METRIC_SLOTS,
  NONE_U32: NONE_U32,
  SEED: SEED,
  STOP_REASONS: STOP_REASONS,
  FAMILIES: FAMILIES,
  POSITIONS: POSITIONS,
  decodeResult: decodeResult,
  loadOrdinaryWasmBytes: loadOrdinaryWasmBytes,
  loadWasmEngine: loadWasmEngine,
  FROZEN_SIGNATURES: FROZEN_SIGNATURES,
  frozenSignature: frozenSignature,
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
