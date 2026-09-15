/* Governed search contracts, v2. Preparation never authorizes activation. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const assert = require('assert/strict');
const ROOT = path.resolve(__dirname, '..');
const bench = require(path.join(ROOT, 'experiments/wasm/bench.js'));
const wasm = require(path.join(ROOT, 'assets/wasm-engine.js'));
require(path.join(ROOT, 'assets/engine.js'));
const Chess = globalThis.Chess;
const VERSION = 'chessy-engine-signatures-v2.1';
const ACTIVE = 'test/fixtures/engine-signatures/active.json';
const LEGACY = 'test/fixtures/wasm-r69-signatures.json';
const LEGACY_SHA = 'd500dece3ed9bfc83da5139cabf075734c1f1f465f295f9c8be7be23eccc6b6b';
const GENERATOR_SHA = '13df68a6f203239e4affa4ef3fe45001a57799a8513c2244e2fdfe7694be80a7';
const BUILD_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.sh'].map(x => 'experiments/wasm/' + x);
const FIELDS = ['move', 'score', 'depth', 'attemptedDepth', 'nodes', 'qnodes', 'cutoffs', 'researches', 'stopReason'];
const INPUTS = [...BUILD_FILES, 'experiments/wasm/src/engine.rs', 'experiments/wasm/src/eval.rs', 'experiments/wasm/src/lib.rs', 'experiments/wasm/src/search.rs'];
const IMPLEMENTATION = ['test/engine-signatures-v2.js', 'experiments/wasm/bench.js', 'assets/wasm-engine.js', 'assets/engine.js', LEGACY];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = (root, file) => fs.readFileSync(path.join(root, file));
const git = (root, args) => cp.execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
function commit(root, ref) {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw Error('require full immutable source commit SHA');
  assert.equal(git(root, ['rev-parse', ref + '^{commit}']).toString().trim(), ref);
  return ref;
}
function clean(root) {
  if (git(root, ['status', '--porcelain', '--untracked-files=all']).length) throw Error('refusing dirty or untracked working tree');
}
function historical(root) {
  assert.equal(sha(read(root, LEGACY)), LEGACY_SHA, 'immutable r69 fixture changed');
  assert.equal(sha(read(root, 'test/gen-wasm-signatures.js')), GENERATOR_SHA, 'immutable r69 generator changed');
}
function corpus(root = ROOT) {
  const fixture = JSON.parse(read(root, LEGACY));
  const positions = new Map(bench.POSITIONS);
  assert.equal(fixture.cases.length, 144);
  return fixture.cases.map((item, index) => {
    const fen = positions.get(item.name);
    assert.ok(fen, 'unknown corpus name');
    return { id: index, name: item.name, fen, config: item.config };
  });
}
function inventory(files, getter) {
  return Object.fromEntries(files.map(file => [file, sha(getter(file))]));
}
function source(root, ref) {
  commit(root, ref);
  const get = file => git(root, ['show', ref + ':' + file]);
  const tree = git(root, ['ls-tree', '-r', ref, '--', 'experiments/wasm']).toString().trim().split('\n');
  const actual = tree.filter(line => /\texperiments\/wasm\/src\//.test(line));
  assert.deepEqual(actual.map(line => line.split('\t')[1]).sort(), INPUTS.filter(x => x.includes('/src/')).sort(), 'unregistered Rust source path');
  for (const file of INPUTS) {
    const record = tree.find(line => line.endsWith('\t' + file));
    assert.ok(record && /^100(644|755) blob /.test(record), 'source must be an ordinary tracked file: ' + file);
  }
  for (const file of BUILD_FILES) assert.equal(sha(get(file)), sha(read(ROOT, file)), 'unpinned build contract: ' + file);
  const release = get('sw.js').toString().match(/const RELEASE = '(r\d+)';/);
  assert.ok(release, 'unrecognized source release');
  const files = inventory(INPUTS, get);
  return { commit: ref, tree: git(root, ['rev-parse', ref + '^{tree}']).toString().trim(), release: release[1], files, sourceSha256: sha(json(files)), shippedWasmSha256: sha(get('assets/chessy-ai-fast.wasm')) };
}
function pinnedEnvironment() {
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
    if (process.env[key]) throw Error('clear ambient ' + key);
  }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', SOURCE_DATE_EPOCH: '0' };
  for (const key of ['RUSTUP_HOME', 'CARGO_HOME', 'LD_LIBRARY_PATH', 'CHESSY_CARGO_BIN', 'CHESSY_RUSTC_BIN', 'CHESSY_WASM_OPT_BIN']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
function reproduce(root, record) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-signature-build-'));
  try {
    const get = file => git(root, ['show', record.commit + ':' + file]);
    const outputs = [];
    for (const repeat of [1, 2]) {
      const snapshot = path.join(scratch, 'build-' + repeat);
      for (const file of INPUTS) {
        fs.mkdirSync(path.dirname(path.join(snapshot, file)), { recursive: true });
        fs.writeFileSync(path.join(snapshot, file), get(file));
      }
      // Build outside the user checkout, with a fresh target and no candidate scripts/config.
      cp.execFileSync('sh', ['experiments/wasm/build.sh'], {
        cwd: snapshot, env: { ...pinnedEnvironment(), CARGO_HOME: path.join(scratch, 'cargo-home-' + repeat), CHESSY_CARGO_TARGET_DIR: path.join(scratch, 'target-' + repeat) },
        stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024
      });
      outputs.push(read(snapshot, 'experiments/wasm/dist/chessy-ai-fast.wasm'));
    }
    assert.equal(sha(outputs[0]), sha(outputs[1]), 'non-reproducible independent builds');
    assert.equal(sha(outputs[0]), record.shippedWasmSha256, 'rebuilt source does not match committed module');
    return { bytes: outputs[0], buildSha256: outputs.map(sha) };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function uci(move) { return move ? Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toUpperCase() : '-'; }
function normalize(result) {
  return Object.fromEntries(FIELDS.map(field => [field, field === 'move' ? uci(result.move) : result[field]]));
}
function mate(score) {
  assert.ok(Number.isInteger(score) && Math.abs(score) <= 1000000, 'invalid engine score');
  return Math.abs(score) >= 999000 ? { sign: Math.sign(score), encodedScore: score, plies: 1000000 - Math.abs(score) } : null;
}
function legalPv(fen, moves) {
  let state = Chess.newGameState(fen);
  return moves.map(move => {
    const found = Chess.legalMoves(state).find(candidate => uci(candidate) === uci(move));
    assert.ok(found, 'illegal forced-root PV');
    state = Chess.applyMove(state, found);
    return uci(move);
  });
}
function signatures(bytes, cases = corpus()) {
  // Strict production ABI-v2 loader; same retained bytes are hashed and consumed.
  const engine = wasm.loadSync(bytes);
  return cases.map(item => {
    const raw = engine.search(item.fen, item.config);
    const result = normalize(raw);
    let rootAnalysis = null;
    if (raw.move) {
      legalPv(item.fen, [raw.move]);
      // Ordinary search exports no PV. A separately specified exact-root probe
      // prevents an empty/stale PV being mislabeled as ordinary-search evidence.
      engine.beginAnalysis(item.fen, { nodeLimit: 5000, quiesce: item.config.quiesce });
      const depth = Math.max(1, Math.min(3, raw.depth));
      const root = engine.searchRoot(raw.move, depth, 16);
      rootAnalysis = { config: { totalDepth: depth, nodeLimit: 5000, pvLen: 16 }, ...normalize(root), complete: root.complete, mate: mate(root.score), pv: legalPv(item.fen, root.pv) };
    }
    return { ...item, result, mate: mate(raw.score), rootAnalysis };
  });
}
function changes(before, after, prefix = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [{ field: prefix, before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => changes(before[key], after[key], prefix ? prefix + '.' + key : key));
}
function diff(oldCases, newCases) {
  assert.equal(oldCases.length, 144);
  assert.equal(newCases.length, 144);
  return oldCases.map((before, index) => {
    const after = newCases[index];
    for (const key of ['id', 'name', 'fen', 'config']) assert.deepEqual(before[key], after[key], 'case inventory mismatch');
    return { id: before.id, name: before.name, changes: changes({ result: before.result, mate: before.mate, rootAnalysis: before.rootAnalysis }, { result: after.result, mate: after.mate, rootAnalysis: after.rootAnalysis }) };
  });
}
function prepare(root, oldRef, newRef, output) {
  clean(root); historical(root); clean(ROOT);
  const generatorCommit = git(ROOT, ['rev-parse', 'HEAD']).toString().trim();
  const cases = corpus();
  const identity = inventory(IMPLEMENTATION, file => read(ROOT, file));
  const oldSource = source(root, oldRef), newSource = source(root, newRef);
  const oldBuild = reproduce(root, oldSource), newBuild = reproduce(root, newSource);
  const oldCases = signatures(oldBuild.bytes, cases), newCases = signatures(newBuild.bytes, cases);
  const bundle = { schema: 2, protocol: VERSION, authority: 'proposal-only; requires prior trusted-base review before activation', generator: { commit: generatorCommit, files: identity }, corpusSha256: sha(json(cases)), abi: 2, toolchain: { rust: '1.97.1', rustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452', binaryen: 131, target: 'wasm32-unknown-unknown' }, old: { source: oldSource, buildSha256: oldBuild.buildSha256, cases: oldCases }, new: { source: newSource, buildSha256: newBuild.buildSha256, cases: newCases }, diff: diff(oldCases, newCases) };
  clean(root); clean(ROOT);
  assert.deepEqual(identity, inventory(IMPLEMENTATION, file => read(ROOT, file)), 'generator changed during execution');
  assert.equal(git(ROOT, ['rev-parse', 'HEAD']).toString().trim(), generatorCommit, 'generator commit changed');
  const bytes = Buffer.from(json(bundle));
  const filename = 'wasm-v2-' + sha(bytes) + '.json';
  // Exclusive directory ownership is the publication lock. Completion is last;
  // an existing or partial output is never overwritten or adopted.
  fs.mkdirSync(output);
  try {
    fs.writeFileSync(path.join(output, filename), bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'complete.json'), json({ schema: 1, bundle: filename, sha256: sha(bytes), status: 'unapproved-proposal' }), { flag: 'wx' });
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  return { output, filename, sha256: sha(bytes), changedCases: bundle.diff.filter(item => item.changes.length).length };
}
function evidencePath(value) {
  if (!/^test\/fixtures\/engine-signatures\/wasm-v2-[0-9a-f]{64}\.json$/.test(value)) throw Error('invalid versioned evidence path');
  return value;
}
function trustedEvidence(root, trustedBase, manifest) {
  commit(root, trustedBase);
  const file = evidencePath(manifest.evidence);
  const approved = git(root, ['show', trustedBase + ':' + file]);
  assert.equal(sha(approved), manifest.evidenceSha256, 'evidence absent or changed since trusted-base review');
  assert.equal(sha(read(root, file)), manifest.evidenceSha256, 'candidate evidence differs from reviewed evidence');
  assert.ok(file.endsWith(manifest.evidenceSha256 + '.json'), 'evidence filename must be content-addressed');
  const bundle = JSON.parse(approved);
  assert.equal(bundle.schema, 2); assert.equal(bundle.protocol, VERSION); assert.equal(bundle.abi, 2);
  assert.equal(bundle.corpusSha256, sha(json(corpus())));
  const baseActive = JSON.parse(git(root, ['show', trustedBase + ':' + ACTIVE]));
  if (baseActive.evidenceSha256 !== manifest.evidenceSha256) {
    assert.equal(bundle.old.source.shippedWasmSha256, sha(git(root, ['show', trustedBase + ':assets/chessy-ai-fast.wasm'])), 'proposal old module differs from trusted active runtime');
  }
  assert.deepEqual(bundle.toolchain, { rust: '1.97.1', rustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452', binaryen: 131, target: 'wasm32-unknown-unknown' }, 'toolchain identity drift');
  commit(root, bundle.generator.commit);
  assert.deepEqual(bundle.generator.files, inventory(IMPLEMENTATION, file => git(root, ['show', bundle.generator.commit + ':' + file])), 'generator source binding drift');
  assert.deepEqual(bundle.generator.files, inventory(IMPLEMENTATION, file => read(ROOT, file)), 'generator differs from trusted version');
  assert.deepEqual(bundle.diff, diff(bundle.old.cases, bundle.new.cases), 'incomplete or edited old/new diff');
  for (const role of ['old', 'new']) {
    assert.deepEqual(source(root, bundle[role].source.commit), bundle[role].source, 'source binding drift');
    assert.deepEqual(bundle[role].buildSha256, [bundle[role].source.shippedWasmSha256, bundle[role].source.shippedWasmSha256], 'build binding drift');
    const bytes = git(root, ['show', bundle[role].source.commit + ':assets/chessy-ai-fast.wasm']);
    assert.deepEqual(signatures(bytes), bundle[role].cases, 'recorded signatures do not reproduce');
  }
  return bundle;
}
function verify(root, trustedBase) {
  historical(root);
  const active = JSON.parse(read(root, ACTIVE));
  assert.equal(active.schema, 1, 'unknown active manifest schema');
  const bytes = read(root, 'assets/chessy-ai-fast.wasm');
  const currentSources = inventory(INPUTS, file => read(root, file));
  if (active.kind === 'legacy-r69-behavior') {
    // Hard anchors are part of the mechanism baseline, not candidate metadata.
    assert.equal(active.fixture, LEGACY); assert.equal(active.fixtureSha256, LEGACY_SHA);
    assert.equal(active.moduleSha256, '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f');
    assert.equal(sha(bytes), active.moduleSha256, 'module changed without reviewed rotation');
    assert.deepEqual(currentSources, source(root, 'd56a745c3bdb373e9fa23fca0d48b2b6e9f21114').files, 'engine source changed without reviewed rotation');
    const fixture = JSON.parse(read(root, LEGACY));
    const engine = wasm.loadSync(bytes);
    const positions = new Map(bench.POSITIONS);
    fixture.cases.forEach(item => assert.deepEqual(normalize(engine.search(positions.get(item.name), item.config)), item.result, item.name));
    return { active: 'r69-behavior / unchanged ABI-v2 runtime', cases: 144 };
  }
  assert.equal(active.kind, 'reviewed-abi-v2');
  if (!trustedBase) throw Error('ABI-v2 activation requires independently selected trusted base');
  const bundle = trustedEvidence(root, trustedBase, active);
  assert.equal(sha(bytes), bundle.new.source.shippedWasmSha256, 'active runtime module drift');
  assert.deepEqual(currentSources, bundle.new.source.files, 'active runtime source drift');
  assert.equal(active.sourceCommit, bundle.new.source.commit);
  assert.equal(active.sourceRelease, bundle.new.source.release);
  assert.equal(active.abi, 2);
  assert.deepEqual(signatures(bytes), bundle.new.cases);
  return { active: active.evidence, cases: 144 };
}
module.exports = { VERSION, ACTIVE, LEGACY, INPUTS, sha, json, clean, source, historical, corpus, signatures, mate, diff, changes, evidencePath, trustedEvidence, verify, prepare, pinnedEnvironment };
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  try {
    let result;
    if (command === 'prepare' && args.length === 4) result = prepare(path.resolve(args[0]), args[1], args[2], path.resolve(args[3]));
    else if (command === 'verify' && [1, 2].includes(args.length)) result = verify(path.resolve(args[0]), args[1]);
    else throw Error('usage: engine-signatures-v2.js prepare REPO OLD_FULL_SHA NEW_FULL_SHA NEW_OUTPUT_DIR | verify REPO [TRUSTED_BASE_FULL_SHA]');
    console.log(json(result));
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
