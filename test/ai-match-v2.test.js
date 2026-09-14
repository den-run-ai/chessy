'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('./ai-match-v2-core');
const P = require('./ai-match-protocol-v2');
const O = require('./ai-match-openings-v2');
const { aggregate } = require('./ai-match-agg-v2');
const { args } = require('./ai-match-v2');
const Chess = globalThis.Chess;
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
const hash = 'a'.repeat(64);
function identity(n) { return { commit: String(n).repeat(40), moduleSha256: hash, sourceSha256: hash, buildSha256: hash }; }
const registration = { ...P.CONTRACT, profile: 'evaluator-easy', protocol: P.PROFILES['evaluator-easy'],
  manifest: { version: P.OPENINGS_MANIFEST_VERSION, sha256: O.sha256, count: 400 },
  base: identity(1), candidate: identity(2), harness: { commit: '3'.repeat(40), files: {} },
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  run: 'https://github.com/den-run-ai/chessy/actions/runs/123', attempt: 1 };
const registrationDigest = C.sha256(C.canonical(registration) + '\n');
function search(move, nodes = 10000) { return { move, score: 0, scorePov: 'white',
  depth: 3, attemptedDepth: 4, nodes, qnodes: 100, cutoffs: 2, researches: 0, stopReason: 'node-limit' }; }
function seal(rows) {
  const prefix = rows.map(C.canonical).join('\n') + '\n';
  return Buffer.from(prefix + C.canonical({ type: 'complete', games: 40, rows: rows.length, sha256: C.sha256(prefix) }) + '\n');
}
function mutate(buffer, fn) {
  const rows = C.parseCanonicalLines(buffer); rows.pop(); fn(rows); return seal(rows);
}
test('profile thresholds and budgets remain distinct; no production admission', () => {
  assert.strictEqual(P.PROFILES['evaluator-easy'].nodes, 10000);
  assert.strictEqual(P.PROFILES['selective-hard'].nodes, 230000);
  assert.strictEqual(P.PROFILES['evaluator-easy'].lowerBoundThreshold, 0.50);
  assert.strictEqual(P.PROFILES['selective-hard'].lowerBoundThreshold, 0.49);
  assert.match(P.CONTRACT.admission, /diagnostic-only/);
  for (const profile of ['constructor', '__proto__', 'toString', 'unknown']) {
    assert.throws(() => C.registration({ profile }), /unknown profile/);
    assert.throws(() => C.validateRegistration({ ...registration, profile }, false), /unknown registration profile/);
  }
  for (const change of [ { protocol: P.PROFILES['selective-hard'] }, { maxPlies: 179 },
    { estimator: 'iid-games' }, { attempt: 2 }, { admission: 'formal' }, { selection: 'selected-openings' } ]) {
    assert.throws(() => C.validateRegistration({ ...registration, ...change }, false));
  }
});
test('CLI rejects seed slots, ambiguous duplicate/missing flags, and extra arguments', () => {
  for (const argv of [['--seeds', '4'], ['--slot'], ['--base', ''], ['--slot', '1', '--slot', '2'], ['--pairs', '1']]) {
    assert.throws(() => args(argv));
  }
});
test('registration authenticates immutable Git blobs, external digest and trusted files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-v2-registration-'));
  try {
    const files = [...C.TRUSTED_FILES, C.MODULE,
      'experiments/wasm/build.sh', 'experiments/wasm/Cargo.toml',
      'experiments/wasm/Cargo.lock', 'experiments/wasm/rust-toolchain.toml',
      ...['engine', 'eval', 'lib', 'search'].map(n => 'experiments/wasm/src/' + n + '.rs')];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(C.ROOT, file), path.join(dir, file));
    }
    const git = args => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['add', '.']); git(['commit', '-qm', 'base']); const base = git(['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(dir, C.MODULE), 'fixture-only-do-not-execute');
    git(['add', C.MODULE]); git(['commit', '-qm', 'candidate']); const candidate = git(['rev-parse', 'HEAD']);
    const fixture = require(path.join(dir, 'test/ai-match-v2-core'));
    const plan = fixture.registration({ base, candidate, harness: candidate, profile: 'evaluator-easy', run: registration.run });
    assert.notStrictEqual(plan.base.moduleSha256, plan.candidate.moduleSha256);
    git(['replace', base, candidate]);
    assert.deepStrictEqual(fixture.registration({ base, candidate, harness: candidate,
      profile: 'evaluator-easy', run: registration.run }), plan);
    const file = path.join(dir, 'registration.json'), bytes = fixture.canonical(plan) + '\n';
    fs.writeFileSync(file, bytes);
    fixture.readRegistration(file, fixture.sha256(bytes));
    assert.throws(() => fixture.readRegistration(file, hash), /digest mismatch/);
    fs.appendFileSync(path.join(dir, 'test/match-stats.js'), '\n// dirty trusted file\n');
    assert.throws(() => fixture.readRegistration(file, fixture.sha256(bytes)), /trusted working file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('mate on exact cap takes precedence over artificial draw', () => {
  const opening = { id: 'fixture', pgn: '1. f3 e5 2. g4',
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2' };
  const events = [];
  const engine = { search(fen, opts) {
    assert.strictEqual(opts.nodeLimit, 10000);
    assert.ok(Object.keys(opts.positions).length >= 4);
    return { ...search(C.legalMove(Chess.parseFen(fen), 'd8h4'), 4),
      qnodes: 0, score: -999999, stopReason: 'mate', depth: 1, attemptedDepth: null };
  } };
  C.playGame({ base: engine, candidate: engine }, opening, 'w', 10000, e => events.push(e), 1);
  assert.strictEqual(events[1].reason, 'checkmate');
  assert.strictEqual(events[1].result, '0-1');
});
test('invalid search records are emitted before the game fails', () => {
  const opening = { id: 'fixture', pgn: '1. e4', fen: Chess.toFen(Chess.playMove(Chess.newGameState(), C.legalMove(Chess.newGameState(), 'e2e4'))) };
  const events = [];
  const engine = { search() { return search(null); } };
  assert.throws(() => C.playGame({ base: engine, candidate: engine }, opening, 'w', 10000, e => events.push(e)));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].move, null);
});
test('successive searches receive exact prefix histories and ordinary cap is a draw', () => {
  const opening = { id: 'fixture', pgn: '1. e4 e5 2. Nf3',
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' };
  let expected = C.initialState(opening), calls = 0;
  const events = [], script = ['b8c6', 'f1c4', 'g8f6'];
  const engine = { search(fen, opts) {
    assert.strictEqual(fen, Chess.toFen(expected));
    assert.deepStrictEqual(opts.positions, expected.positions);
    const move = C.legalMove(expected, script[calls++]);
    expected = Chess.playMove(expected, move);
    return search(move);
  } };
  C.playGame({ base: engine, candidate: engine }, opening, 'w', 10000, e => events.push(e), 3);
  assert.strictEqual(calls, 3);
  assert.strictEqual(events[3].reason, 'ply-cap');
  assert.strictEqual(events[3].result, '1/2-1/2');
});
test('bounded fixed-node early mate is valid; time stops and counter overflow are invalid', () => {
  const record = { ...search(null, 4), score: 999999, attemptedDepth: null,
    qnodes: 0, stopReason: 'mate', elapsedMs: 1 };
  C.validateSearch(record, 10000);
  for (const change of [{ stopReason: 'time-limit' }, { nodes: 10001 },
    { elapsedMs: NaN }, { qnodes: 9 }, { depth: 31 }, { depth: 0 },
    { stopReason: 'max-depth' }, { score: 0 }, { attemptedDepth: 3 }, { nodes: 0 }]) {
    assert.throws(() => C.validateSearch({ ...record, ...change }, 10000));
  }
});
// Rules-only fixtures: find reversible legal cycles without asking any search
// engine to score a holdout endpoint. This constructs artificial draws, not
// a candidate experiment. Both colors use identical predetermined moves.
function quietMoves(state) {
  return Chess.legalMoves(state).filter(m => !state.board[m.to] &&
    String(state.board[m.from]).toLowerCase() !== 'p' && !m.promotion);
}
function cycle(state) {
  const key = Chess.positionKey(state);
  for (const a of quietMoves(state)) {
    const s1 = Chess.playMove(state, a);
    for (const b of quietMoves(s1)) {
      const s2 = Chess.playMove(s1, b);
      const c = Chess.legalMoves(s2).find(m => m.from === a.to && m.to === a.from);
      if (!c) continue;
      const s3 = Chess.playMove(s2, c);
      const d = Chess.legalMoves(s3).find(m => m.from === b.to && m.to === b.from);
      if (!d) continue;
      if (Chess.positionKey(Chess.playMove(s3, d)) === key) return [a, b, c, d].map(C.moveName);
    }
  }
  return null;
}
console.log('Constructing rules-only repetition fixtures (no candidate searches)');
const buffers = [];
for (let slot = 0; slot < 20; slot++) {
  const rows = [{ type: 'header', schema: 'chessy-match-v2-raw-1', registrationSha256: registrationDigest, slot }];
  for (let op = slot * 20; op < (slot + 1) * 20; op++) {
    const opening = O.openings[op];
    for (const color of ['w', 'b']) {
      const game = opening.id + ':' + color;
      rows.push({ type: 'start', opening: op, candidateColor: color, game });
      let state = C.initialState(opening), ply = 0, moves = null, cycleStart = 0;
      while (!Chess.gameStatus(state).over && ply < 180) {
        if (!moves) { moves = cycle(state); cycleStart = ply; }
        const move = moves ? moves[(ply - cycleStart) % 4] : C.moveName(Chess.legalMoves(state)[0]);
        const result = search(null); delete result.move;
        rows.push({ type: 'move', game, ply, side: state.turn === color ? 'candidate' : 'base',
          fen: Chess.toFen(state), historySha256: C.historyHash(state), move,
          search: { ...result, elapsedMs: 1 } });
        state = Chess.playMove(state, C.legalMove(state, move)); ply++;
      }
      const status = Chess.gameStatus(state);
      rows.push({ type: 'end', game, ply, result: status.over ? status.result : '1/2-1/2',
        reason: status.over ? status.reason : 'ply-cap', fen: Chess.toFen(state) });
    }
  }
  buffers.push(seal(rows));
}
test('complete 20-shard fixture has 800 games and strict strength does not pass identity draws', () => {
  const result = aggregate(buffers, registration, registrationDigest);
  assert.strictEqual(result.games, 800);
  assert.strictEqual(result.openingEndpoints, 400);
  assert.strictEqual(result.lower95, 0.5);
  assert.strictEqual(result.endpointThresholdExceeded, false);
  assert.strictEqual(result.formalPass, false);
});
test('incomplete, duplicate, mixed-run, malformed, truncated and extra artifacts fail closed', () => {
  assert.throws(() => aggregate(buffers.slice(1), registration, registrationDigest));
  assert.throws(() => aggregate(buffers, registration, hash), /registration\/expected digest mismatch/);
  const changes = [
    b => b[1] = b[0],
    b => b[0] = mutate(b[0], rows => rows[0].registrationSha256 = 'b'.repeat(64)),
    b => b[0] = b[0].subarray(0, b[0].length - 2),
    b => b[0] = Buffer.from(b[0].toString().replace('"depth":3', '"depth":4')),
    b => b[0] = mutate(b[0], rows => rows.push({ type: 'failure', message: 'failed' })),
    b => b[0] = Buffer.from(b[0].toString().replace('"slot":0', '"slot":0,"slot":0'))
  ];
  for (const change of changes) { const b = buffers.slice(); change(b); assert.throws(() => aggregate(b, registration, registrationDigest)); }
});
test('recomputed digests cannot hide schedule, repetition, move, telemetry or adjudication tampering', () => {
  const mutations = [
    rows => rows[1].candidateColor = 'b',
    rows => rows[2].historySha256 = 'b'.repeat(64),
    rows => rows[2].move = 'a1a8',
    rows => rows[2].search.nodes = 9999,
    rows => rows[2].search.seed = 1,
    rows => rows[2].side = rows[2].side === 'base' ? 'candidate' : 'base',
    rows => rows.splice(2, 1),
    rows => rows.find(r => r.type === 'end').result = '1-0',
    rows => rows.find(r => r.type === 'end').reason = 'ply-cap'
  ];
  for (const fn of mutations) {
    const b = buffers.slice(); b[0] = mutate(b[0], fn);
    assert.throws(() => aggregate(b, registration, registrationDigest));
  }
});
test('workflow holds trusted main, immutable registration, all shards, preserved failures and no verdict promotion', () => {
  const workflow = fs.readFileSync('.github/workflows/ai-match-v2.yml', 'utf8');
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /ref: \$\{\{ needs\.register\.outputs\.harness \}\}/);
  assert.match(workflow, /REGISTRATION_SHA256: \$\{\{ needs\.register\.outputs\.digest \}\}/);
  assert.match(workflow, /test "\$SHARDS_RESULT" = success/);
  assert.match(workflow, /name: Preserve raw records including failures\n        if: always\(\)/);
  assert.doesNotMatch(workflow, /pull_request_target|continue-on-error|seedbase/);
});
console.log(checks + ' v2 execution tests passed; no holdout search was performed');
