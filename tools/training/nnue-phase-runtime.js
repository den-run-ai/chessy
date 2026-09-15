#!/usr/bin/env node
'use strict';

// Diagnostic mechanism probe. Its CLI emits synthetic parameters only. This
// cannot admit a fitted model, open a holdout, update a shipped asset, or assert
// strength. Actual candidate admission remains a separate frozen experiment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {performance} = require('node:perf_hooks');
const Reference = require('../../test/training/h4-v3-reference');
const Wasm = require('../../assets/wasm-engine');
const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = path.join(__dirname, 'nnue-phase-runtime.rs.in');
const IMPLEMENTATION = [__filename, TEMPLATE,
  path.join(ROOT, 'test/training/h4-v3-reference.js'), path.join(ROOT, 'assets/wasm-engine.js')];
const CRATE_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.sh',
  'src/engine.rs', 'src/eval.rs', 'src/lib.rs', 'src/search.rs'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok, message) => {if (!ok) throw new Error(message);};
const encode = value => JSON.stringify(value, null, 2) + '\n';

// Already exposed authored fixtures, including promotion, mop-up and phases.
// No incident, natural-data, certification or formal strength set is accessed.
const FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
  '8/3k1p2/4p1p1/4n3/8/2B2P2/4K1P1/8 w - - 0 1',
  '8/1P3k2/8/8/8/8/1p3K2/8 w - - 0 1',
  '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1',
  '8/8/8/8/8/8/3k4/R3K3 w - - 0 1',
  '8/8/8/8/8/8/4K3/r3k3 b - - 0 1',
];
const PARITY_FENS = FENS.flatMap(fen => [fen, fen.replace(/ ([wb]) /, (_, t) => t === 'w' ? ' b ' : ' w ')]);

function synthetic(hidden) {
  check([4, 8].includes(hidden), 'hidden must be 4 or 8');
  const metadata = Reference.expectedMetadata(hidden);
  const bytes = Buffer.alloc(metadata.parameterBytes);
  let offset = 0, state = 0x4e4e5545;
  const next = bound => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % (2 * bound + 1) - bound;};
  const i16 = value => {bytes.writeInt16LE(value, offset); offset += 2;};
  const i32 = value => {bytes.writeInt32LE(value, offset); offset += 4;};
  for (let i = 0; i < 768 * hidden; i++) i16(next(2048));
  for (let i = 0; i < hidden; i++) i32(8192 + next(4096));
  for (let i = 0; i < 4 * hidden; i++) i16(next(256));
  i32(1234567); i32(-2345678);
  check(offset === bytes.length, 'synthetic serialization differs');
  return {bytes, metadata, model: Reference.loadModel(bytes, metadata)};
}

function rustArray(values) {
  return '[' + values.map(value => Array.isArray(value) ? rustArray(value) : String(value)).join(', ') + ']';
}

function once(source, anchor, replacement) {
  check(source.split(anchor).length === 2, 'missing or ambiguous Rust anchor: ' + anchor);
  return source.replace(anchor, replacement);
}

function render(source, template, model, implementation) {
  check(['refresh', 'fused'].includes(implementation), 'implementation must be refresh or fused');
  check(!source.includes('NNUE_'), 'source already contains neural integration');
  const weightRows = Array.from({length: 768}, (_, i) => model.w1.slice(i * model.hidden, (i + 1) * model.hidden));
  const parameters = {
    HIDDEN: model.hidden, W1: rustArray(weightRows), B1: rustArray(model.b1),
    W2: rustArray(model.w2), B2: rustArray(model.b2),
    FIXTURES: PARITY_FENS.map(fen => `            (b"${fen}", ${Reference.infer(model, fen, 0)}),`).join('\n'),
  };
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    check(Object.hasOwn(parameters, key), 'unknown template parameter'); return String(parameters[key]);
  });
  check(!rendered.includes('{{'), 'unexpanded template parameter');
  // Keep a pristine HCE function for the existing authored evaluator tests.
  // The compiler eliminates its duplicate body from non-test WASM builds.
  const functionStart = 'pub fn evaluate(position: &Position) -> i32 {';
  const testStart = '\n#[cfg(test)]\nmod tests {';
  check(source.split(testStart).length === 2, 'evaluator test boundary differs');
  const [production, tests] = source.split(testStart);
  const start = production.indexOf(functionStart);
  check(start >= 0, 'evaluate function not found');
  const original = production.slice(start);
  check(original.endsWith('    score\n}\n'), 'evaluator return anchor differs');
  let candidate = original;
  if (implementation === 'refresh') {
    candidate = once(candidate, '    score\n}\n', '    score + nnue_refresh(position)\n}\n');
  } else {
    candidate = once(candidate, '    let board = &position.board;', '    let mut nnue_acc = [NNUE_B1; 2];\n    let board = &position.board;');
    candidate = once(candidate, '        let color = engine::piece_color(piece).unwrap();',
      '        nnue_add_piece(&mut nnue_acc, piece, square);\n        let color = engine::piece_color(piece).unwrap();');
    candidate = once(candidate, '    score\n}\n', '    score + nnue_finish(nnue_acc, position.turn, phase)\n}\n');
  }
  const oldTestFunction = original.replace(functionStart, '#[cfg(test)]\nfn evaluate_hce(position: &Position) -> i32 {');
  return production.slice(0, start) + candidate + '\n' + oldTestFunction + '\n' + rendered + testStart +
    tests.replace('assert_eq!(evaluate(&position), expected)', 'assert_eq!(evaluate_hce(&position), expected)');
}

function outsideRepository(output) {
  const resolved = path.resolve(output);
  const parent = fs.realpathSync(path.dirname(resolved));
  check(path.join(parent, path.basename(resolved)) === resolved, 'output parent must be canonical');
  for (let current = parent; ; current = path.dirname(current)) {
    check(!fs.existsSync(path.join(current, '.git')), 'research output must be outside a Git checkout');
    if (current === path.dirname(current)) break;
  }
  return resolved;
}

function prepare(output, hidden, implementation) {
  output = outsideRepository(output);
  const implementationInputs = IMPLEMENTATION.map(filename => ({path: path.relative(ROOT, filename), sha256: sha(fs.readFileSync(filename))}));
  const baselineWasmSha256 = sha(fs.readFileSync(path.join(ROOT, 'assets/chessy-ai-fast.wasm')));
  const fixture = synthetic(hidden);
  check(JSON.stringify(fs.readdirSync(path.join(ROOT, 'experiments/wasm/src')).sort()) ===
    JSON.stringify(CRATE_FILES.filter(name => name.startsWith('src/')).map(name => name.slice(4))), 'Rust source inventory differs');
  const captured = CRATE_FILES.map(name => ({name, bytes: fs.readFileSync(path.join(ROOT, 'experiments/wasm', name))}));
  const template = fs.readFileSync(TEMPLATE);
  const source = captured.find(item => item.name === 'src/eval.rs');
  const patched = render(source.bytes.toString('utf8'), template.toString('utf8'), fixture.model, implementation);
  fs.mkdirSync(output); // exclusive no-replace directory; no existing-file writes
  fs.mkdirSync(path.join(output, 'src'));
  const emitted = [];
  for (const item of captured) {
    const bytes = item.name === 'src/eval.rs' ? Buffer.from(patched) : item.bytes;
    fs.writeFileSync(path.join(output, item.name), bytes, {flag: 'wx'});
    emitted.push({path: item.name, sha256: sha(bytes), bytes: bytes.length});
  }
  fs.writeFileSync(path.join(output, 'synthetic.bin'), fixture.bytes, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'synthetic.json'), encode(fixture.metadata), {flag: 'wx'});
  const receipt = {
    schema: 'chessy.nnue-phase-synthetic-build.v1', researchOnly: true, syntheticOnly: true,
    fitEligible: false, productionIntegrationAllowed: false, strengthClaimAllowed: false,
    hidden, implementation, parameters: fixture.metadata.parameterBytes,
    fixtureSha256: sha(fixture.bytes), metadataSha256: sha(encode(fixture.metadata)),
    baselineWasmSha256,
    sourceInputs: captured.map(item => ({path: item.name, sha256: sha(item.bytes)})),
    implementationSha256: sha(fs.readFileSync(__filename)), templateSha256: sha(template),
    implementationInputs,
    emitted, parityFixtures: PARITY_FENS.length, dataScope: 'exposed authored evaluator fixtures only',
  };
  for (const item of implementationInputs) check(sha(fs.readFileSync(path.join(ROOT, item.path))) === item.sha256, 'probe implementation changed during preparation');
  for (const item of captured) check(sha(fs.readFileSync(path.join(ROOT, 'experiments/wasm', item.name))) === sha(item.bytes), 'source changed during preparation');
  check(sha(fs.readFileSync(path.join(ROOT, 'assets/chessy-ai-fast.wasm'))) === baselineWasmSha256, 'shipped baseline changed during preparation');
  fs.writeFileSync(path.join(output, 'synthetic-receipt.json'), encode(receipt), {flag: 'wx'});
  return receipt;
}

const median = numbers => {
  const values = [...numbers].sort((a, b) => a - b), middle = Math.floor(values.length / 2);
  check(values.length > 0 && values.every(Number.isFinite), 'empty or nonfinite statistic');
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

function benchEvaluation(bytes) {
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {env: {now_ms: () => performance.now()}});
  const api = instance.exports;
  return fen => {
    const encoded = Buffer.from(fen);
    new Uint8Array(api.memory.buffer, api.input_ptr(), encoded.length).set(encoded);
    check(api.load_position(encoded.length) === 0, 'microbench FEN rejected');
    for (let i = 0; i < 1000; i++) api.evaluate_loaded();
    const start = performance.now(); let sum = 0;
    for (let i = 0; i < 10000; i++) sum += api.evaluate_loaded();
    return {elapsedMs: performance.now() - start, repetitions: 10000, checksum: sum};
  };
}

function measure(directory, output) {
  check(!fs.existsSync(output), 'measurement output already exists');
  const receiptBytes = fs.readFileSync(path.join(directory, 'synthetic-receipt.json'));
  const receipt = JSON.parse(receiptBytes);
  check(receipt.schema === 'chessy.nnue-phase-synthetic-build.v1' && receipt.syntheticOnly === true &&
    receipt.productionIntegrationAllowed === false && receipt.strengthClaimAllowed === false, 'synthetic receipt required');
  const expected = synthetic(receipt.hidden);
  check(sha(expected.bytes) === receipt.fixtureSha256 && sha(encode(expected.metadata)) === receipt.metadataSha256, 'fixture identity differs');
  check(sha(fs.readFileSync(__filename)) === receipt.implementationSha256 && sha(fs.readFileSync(TEMPLATE)) === receipt.templateSha256,
    'probe implementation changed since source preparation');
  check(Array.isArray(receipt.implementationInputs) && receipt.implementationInputs.length === IMPLEMENTATION.length,
    'complete implementation closure required');
  receipt.implementationInputs.forEach((item, i) => {
    check(item.path === path.relative(ROOT, IMPLEMENTATION[i]) && sha(fs.readFileSync(IMPLEMENTATION[i])) === item.sha256,
      'probe implementation closure changed');
  });
  check(['refresh', 'fused'].includes(receipt.implementation), 'implementation identity differs');
  check(Array.isArray(receipt.emitted) && Array.isArray(receipt.sourceInputs) &&
    JSON.stringify(receipt.emitted.map(item => item.path)) === JSON.stringify(CRATE_FILES) &&
    JSON.stringify(receipt.sourceInputs.map(item => item.path)) === JSON.stringify(CRATE_FILES), 'complete source inventory required');
  for (const [index, item] of receipt.emitted.entries()) {
    const emittedBytes = fs.readFileSync(path.join(directory, item.path));
    check(sha(emittedBytes) === item.sha256 && emittedBytes.length === item.bytes, 'generated source changed');
    const originalBytes = fs.readFileSync(path.join(ROOT, 'experiments/wasm', item.path));
    check(sha(originalBytes) === receipt.sourceInputs[index].sha256, 'baseline source changed');
    const wantedBytes = item.path === 'src/eval.rs' ? Buffer.from(render(originalBytes.toString('utf8'),
      fs.readFileSync(TEMPLATE, 'utf8'), expected.model, receipt.implementation)) : originalBytes;
    check(emittedBytes.equals(wantedBytes), 'generated source does not reproduce from fixed synthetic parameters');
  }
  const baselineBytes = fs.readFileSync(path.join(ROOT, 'assets/chessy-ai-fast.wasm'));
  const candidateBytes = fs.readFileSync(path.join(directory, 'dist/chessy-ai-fast.wasm'));
  check(sha(baselineBytes) === receipt.baselineWasmSha256, 'shipped baseline changed');
  const baseline = Wasm.loadSync(baselineBytes), candidate = Wasm.loadSync(candidateBytes);
  const parity = PARITY_FENS.map(fen => {
    const baselineCp = baseline.evaluate(fen), actual = candidate.evaluate(fen);
    const wanted = Reference.infer(expected.model, fen, baselineCp);
    return {fen, baselineCp, actual, wanted, mismatch: actual !== wanted};
  });
  check(parity.every(item => !item.mismatch), 'compiled candidate/independent BigInt parity failed');
  const engines = {baseline, candidate};
  const evaluate = {baseline: benchEvaluation(baselineBytes), candidate: benchEvaluation(candidateBytes)};
  const records = [];
  // Complete paired fixed plan, alternating first engine to reduce order bias.
  for (let repetition = 0; repetition < 4; repetition++) {
    for (let position = 0; position < FENS.length; position++) {
      const order = (repetition + position) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const name of order) {
        const fen = FENS[position];
        records.push({kind: 'evaluation', name, position, repetition, ...evaluate[name](fen)});
        for (const nodeLimit of [4096, 16384]) {
          const start = performance.now();
          const result = engines[name].search(fen, {maxDepth: 111, nodeLimit, timeMs: 0, quiesce: true});
          records.push({kind: 'search', name, position, repetition, nodeLimit,
            elapsedMs: performance.now() - start, nodes: result.nodes, qnodes: result.qnodes,
            depth: result.depth, stopReason: result.stopReason});
        }
      }
    }
  }
  const ratios = {};
  for (const [key, kind, budget] of [['evaluation', 'evaluation'], ['search4096', 'search', 4096], ['search16384', 'search', 16384]]) {
    const pairs = [], npsRatios = [];
    let bothConsumedNodeBudget = 0;
    for (let repetition = 0; repetition < 4; repetition++) for (let position = 0; position < FENS.length; position++) {
      const rows = records.filter(row => row.kind === kind && row.position === position && row.repetition === repetition && row.nodeLimit === budget);
      check(rows.length === 2 && rows[0].name !== rows[1].name, 'incomplete paired benchmark inventory');
      const baseline = rows.find(row => row.name === 'baseline'), candidate = rows.find(row => row.name === 'candidate');
      check(baseline.elapsedMs > 0 && candidate.elapsedMs > 0, 'nonpositive elapsed time');
      pairs.push(candidate.elapsedMs / baseline.elapsedMs);
      if (kind === 'search') {
        check(baseline.nodes > 0 && candidate.nodes > 0 && baseline.qnodes <= baseline.nodes && candidate.qnodes <= candidate.nodes,
          'invalid search node counters');
        npsRatios.push((candidate.nodes / candidate.elapsedMs) / (baseline.nodes / baseline.elapsedMs));
        bothConsumedNodeBudget += Number(baseline.nodes === budget && candidate.nodes === budget);
      }
    }
    ratios[key] = {pairedMedianTimeRatio: median(pairs), pairs: pairs.length};
    if (kind === 'search') Object.assign(ratios[key], {
      pairedMedianNpsRatio: median(npsRatios), bothConsumedNodeBudget,
      note: 'NPS uses actual visited nodes, including searches ending before the requested budget.',
    });
  }
  const size = bytes => ({sha256: sha(bytes), rawBytes: bytes.length,
    brotliBytes: zlib.brotliCompressSync(bytes, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11}}).length});
  const result = {
    schema: 'chessy.nnue-phase-synthetic-cost.v1', status: 'completed', researchOnly: true,
    syntheticOnly: true, strengthClaimAllowed: false, productionIntegrationAllowed: false,
    sourceReceiptSha256: sha(receiptBytes), hidden: receipt.hidden, implementation: receipt.implementation,
    runtime: {node: process.versions.node, v8: process.versions.v8, brotli: process.versions.brotli},
    modules: {baseline: size(baselineBytes), candidate: size(candidateBytes)},
    parity, ratios, records,
    limitations: ['Synthetic parameters cannot establish fitted-model strength or saturation.',
      'Full refresh/fused accumulation is not an incremental make/unmake NNUE implementation.',
      'Fixed-node search follows different synthetic evaluation trajectories; no Elo/time gain is inferred.',
      'Desktop V8 timing does not satisfy the physical-device runtime gate.'],
  };
  fs.writeFileSync(output, encode(result), {flag: 'wx'});
  return {hidden: result.hidden, implementation: result.implementation, modules: result.modules,
    ratios, parityRows: parity.length, parityMismatches: parity.filter(row => row.mismatch).length};
}

module.exports = {synthetic, render, prepare, measure, outsideRepository, median, FENS, PARITY_FENS, sha};
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 3) console.log(encode(prepare(args[0], Number(args[1]), args[2])));
  else if (command === 'measure' && args.length === 2) console.log(encode(measure(...args)));
  else throw new Error('usage: nnue-phase-runtime.js prepare OUTPUT HIDDEN refresh|fused; measure DIRECTORY RESULT.json');
}
