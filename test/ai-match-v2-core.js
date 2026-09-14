/* Trusted v2 registration, game mechanics and raw-record validation. */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
require('../assets/engine');
const Chess = globalThis.Chess;
const P = require('./ai-match-protocol-v2');
const O = require('./ai-match-openings-v2');
const U = require('./ai-match-opening-utils-v2');
const ROOT = path.resolve(__dirname, '..');
const MODULE = 'assets/chessy-ai-fast.wasm';
const TRUSTED_FILES = Object.freeze([
  'test/ai-match-protocol-v2.js', 'test/ai-match-v2-core.js',
  'test/ai-match-v2.js', 'test/ai-match-agg-v2.js',
  'test/ai-match-openings-v2.js', 'test/ai-match-opening-utils-v2.js',
  'test/match-stats.js', 'assets/engine.js', 'assets/wasm-engine.js',
  'eval/match-v2/openings.json', '.github/workflows/ai-match-v2.yml'
]);
const BUILD_FILES = Object.freeze([
  'experiments/wasm/build.sh', 'experiments/wasm/Cargo.toml',
  'experiments/wasm/Cargo.lock', 'experiments/wasm/rust-toolchain.toml'
]);
function check(ok, message) { if (!ok) throw new Error(message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function same(a, b, what) { check(canonical(a) === canonical(b), what + ' mismatch'); }
function integer(value, min, max, what) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid ' + what);
}
function digest(value, what) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid ' + what); }
function commit(value) { check(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'exact commit SHA required'); }
function git(args) { return cp.execFileSync('git', ['--no-replace-objects', ...args], { cwd: ROOT, maxBuffer: 1 << 27 }); }
function revision(sha, file) { commit(sha); return git(['show', sha + ':' + file]); }
function fileMap(sha, files) {
  return Object.fromEntries(files.map(file => [file, sha256(revision(sha, file))]));
}
function engineIdentity(sha) {
  commit(sha);
  const sources = git(['ls-tree', '-r', '--name-only', sha, '--', 'experiments/wasm/src/'])
    .toString().trim().split('\n');
  check(sources.length >= 4 && sources.every(p => /^experiments\/wasm\/src\/.+\.rs$/.test(p)),
    'unexpected Rust source inventory');
  return { commit: sha, moduleSha256: sha256(revision(sha, MODULE)),
    sourceSha256: sha256(canonical(fileMap(sha, sources))),
    buildSha256: sha256(canonical(fileMap(sha, BUILD_FILES))) };
}
function registration({ base, candidate, harness, profile, run }) {
  check(Object.hasOwn(P.PROFILES, profile), 'unknown profile');
  check(base !== candidate, 'base and candidate commits must differ');
  commit(harness);
  check(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/.test(run),
    'canonical GitHub run URL required');
  return { ...P.CONTRACT, profile, protocol: P.PROFILES[profile],
    manifest: { version: P.OPENINGS_MANIFEST_VERSION, sha256: O.sha256, count: O.openings.length },
    base: engineIdentity(base), candidate: engineIdentity(candidate),
    harness: { commit: harness, files: fileMap(harness, TRUSTED_FILES) },
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
    run, attempt: 1 };
}
function validateRegistration(r, local = true) {
  check(r && Object.hasOwn(P.PROFILES, r.profile), 'unknown registration profile');
  const expected = local ? registration({ base: r.base.commit, candidate: r.candidate.commit,
    harness: r.harness.commit, profile: r.profile, run: r.run }) : {
    ...P.CONTRACT, profile: r.profile, protocol: P.PROFILES[r.profile],
    manifest: { version: P.OPENINGS_MANIFEST_VERSION, sha256: O.sha256, count: 400 },
    base: r.base, candidate: r.candidate, harness: r.harness, runtime: r.runtime,
    run: r.run, attempt: 1
  };
  same(r, expected, 'frozen registration');
  check(r.base.commit !== r.candidate.commit, 'identical commits');
  for (const side of [r.base, r.candidate]) {
    commit(side.commit);
    for (const key of ['moduleSha256', 'sourceSha256', 'buildSha256']) digest(side[key], key);
  }
  if (local) {
    for (const file of TRUSTED_FILES) {
      check(sha256(fs.readFileSync(path.join(ROOT, file))) === r.harness.files[file],
        'trusted working file differs from frozen commit: ' + file);
    }
  }
  return r;
}
function readRegistration(file, expectedHash) {
  digest(expectedHash, 'out-of-band registration SHA-256');
  const bytes = fs.readFileSync(file);
  check(sha256(bytes) === expectedHash, 'registration digest mismatch');
  const r = JSON.parse(bytes);
  check(bytes.equals(Buffer.from(canonical(r) + '\n')), 'noncanonical registration bytes');
  return validateRegistration(r);
}
function initialState(opening) {
  const state = U.replayPgn(opening.pgn, opening.id).state;
  same(Chess.toFen(state), opening.fen, 'opening endpoint');
  return state;
}
function moveName(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase();
}
function legalMove(state, name) {
  const move = Chess.legalMoves(state).find(m => moveName(m) === name);
  check(move, 'illegal raw move ' + name);
  return move;
}
function outcome(state, plies, cap) {
  const status = Chess.gameStatus(state);
  if (status.over) return { result: status.result, reason: status.reason };
  return plies === cap ? { result: '1/2-1/2', reason: 'ply-cap' } : null;
}
function historyHash(state) { return sha256(canonical(state.positions)); }
function validateSearch(result, nodes) {
  for (const key of ['nodes', 'qnodes', 'cutoffs', 'researches']) integer(result[key], 0, Number.MAX_SAFE_INTEGER, key);
  integer(result.depth, 0, P.CONTRACT.maxDepth, 'completed depth');
  if (result.attemptedDepth !== null) integer(result.attemptedDepth, result.depth, P.CONTRACT.maxDepth, 'attempted depth');
  integer(result.score, -2147483648, 2147483647, 'score');
  check(result.scorePov === 'white', 'wrong score POV');
  check(result.nodes > 0 && result.nodes <= nodes && result.qnodes <= result.nodes, 'invalid search node counters');
  check(['node-limit', 'max-depth', 'mate'].includes(result.stopReason), 'invalid fixed-node stop reason');
  if (result.stopReason === 'node-limit') {
    check(result.nodes === nodes, 'node-limit counter mismatch');
    check(result.attemptedDepth === null ? result.depth > 0 : result.attemptedDepth > result.depth,
      'invalid interrupted depth');
  } else {
    check(result.attemptedDepth === null, 'completed search has interrupted iteration');
    if (result.stopReason === 'max-depth') check(result.depth === P.CONTRACT.maxDepth, 'maximum depth not reached');
    else check(result.depth > 0 && Math.abs(result.score) >= 999000 && Math.abs(result.score) <= 1000000,
      'mate stop without completed mate score');
  }
  check(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0, 'invalid elapsed time');
}
// The injected engines in fixture tests do not load the holdout or any WASM.
// All game history is replayed and passed on every actual ABI-v2 search.
function playGame(engines, opening, candidateColor, nodes, emit, cap = P.CONTRACT.maxPlies) {
  let state = initialState(opening), ply = 0;
  for (;;) {
    const terminal = outcome(state, ply, cap);
    if (terminal) { emit({ type: 'end', ply, ...terminal, fen: Chess.toFen(state) }); return; }
    const side = state.turn === candidateColor ? 'candidate' : 'base';
    const started = performance.now();
    const raw = engines[side].search(Chess.toFen(state), {
      maxDepth: P.CONTRACT.maxDepth, quiesce: true, nodeLimit: nodes, positions: state.positions
    });
    const result = { score: raw.score, scorePov: raw.scorePov, depth: raw.depth,
      attemptedDepth: raw.attemptedDepth, nodes: raw.nodes, qnodes: raw.qnodes,
      cutoffs: raw.cutoffs, researches: raw.researches, stopReason: raw.stopReason,
      elapsedMs: performance.now() - started };
    // Retain even invalid engine output before validation can fail.
    const row = { type: 'move', ply, side, fen: Chess.toFen(state),
      historySha256: historyHash(state), move: raw.move ? moveName(raw.move) : null, search: result };
    emit(row);
    validateSearch(result, nodes);
    state = Chess.playMove(state, legalMove(state, row.move));
    ply++;
  }
}
function parseCanonicalLines(bytes) {
  check(bytes.length > 0 && bytes[bytes.length - 1] === 10, 'truncated raw artifact');
  return bytes.toString('utf8').slice(0, -1).split('\n').map(line => {
    const row = JSON.parse(line);
    check(canonical(row) === line, 'noncanonical/duplicate-key raw JSON');
    return row;
  });
}
module.exports = { ROOT, MODULE, TRUSTED_FILES, check, sha256, canonical, same, integer,
  registration, validateRegistration, readRegistration, revision, initialState, moveName,
  legalMove, outcome, historyHash, validateSearch, playGame, parseCanonicalLines };
