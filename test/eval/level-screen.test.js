#!/usr/bin/env node
/*
 * Pure-function contract for the exploratory level-screen runner. No
 * Stockfish process or game is started here.
 */
'use strict';

const assert = require('assert');
const Screen = require('./level-screen');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

check('levels map to the durable product IDs, including Master', function () {
  assert.deepStrictEqual(Screen.LEVEL_IDS,
    { easy: '1', medium: '2', hard: '3', expert: '5', master: 'master' });
});

check('anchor settings match the frozen E4-v1 anchor UCI contract', function () {
  const protocol = require('../../eval/e4/protocol-v1.json');
  const uci = protocol.anchor.uci;
  const options = Object.fromEntries(Screen.ANCHOR_OPTIONS);
  assert.strictEqual(options.UCI_LimitStrength, String(uci.UCI_LimitStrength));
  assert.strictEqual(options.Threads, String(uci.Threads));
  assert.strictEqual(options.Hash, String(uci.Hash));
  assert.strictEqual(options.Ponder, String(uci.Ponder));
  assert.strictEqual(options.MultiPV, String(uci.MultiPV));
  assert.strictEqual(options.SyzygyPath, uci.SyzygyPath);
  assert.strictEqual(options['Move Overhead'], String(uci['Move Overhead']));
  assert.strictEqual(Screen.ANCHOR_MOVETIME_MS, protocol.anchor.go.movetimeMs);
  assert.strictEqual(Screen.DRAW_AT_PLIES, protocol.adjudication.drawAtPlies);
});

check('opening lines replay to UCI and reject ambiguous tokens', function () {
  const line = Screen.openingLine('e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6');
  assert.deepStrictEqual(line.uci,
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6', 'd7c6']);
  assert.strictEqual(line.state.turn, 'w');
  assert.throws(function () { Screen.openingLine('e4 e5 N'); }, /matched 0 moves/);
});

check('anchor moves must be well-formed and legal in the current position', function () {
  const state = Screen.openingLine('e4 e5').state;
  assert.ok(Screen.legalFromUci(state, 'g1f3'));
  assert.strictEqual(Screen.legalFromUci(state, 'e4e5'), null);
  assert.strictEqual(Screen.legalFromUci(state, '(none)'), null);
  assert.strictEqual(Screen.legalFromUci(state, undefined), null);
  const promo = globalThis.Chess.parseFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.strictEqual(Screen.uciOf(Screen.legalFromUci(promo, 'a7a8n')), 'a7a8n');
  assert.strictEqual(Screen.legalFromUci(promo, 'a7a8'), null);
});

check('results are scored from the Chessy side', function () {
  assert.strictEqual(Screen.chessyScore('1-0', 'white'), 1);
  assert.strictEqual(Screen.chessyScore('1-0', 'black'), 0);
  assert.strictEqual(Screen.chessyScore('0-1', 'black'), 1);
  assert.strictEqual(Screen.chessyScore('0-1', 'white'), 0);
  assert.strictEqual(Screen.chessyScore('1/2-1/2', 'white'), 0.5);
  assert.throws(function () { Screen.chessyScore('*', 'white'); });
});

check('even and odd opening blocks are disjoint and cover the list', function () {
  const even = Screen.selectOpenings('even', 100);
  const odd = Screen.selectOpenings('odd', 100);
  assert.strictEqual(even.length, 50);
  assert.strictEqual(odd.length, 50);
  assert.ok(even.every(function (i) { return odd.indexOf(i) < 0; }));
  assert.deepStrictEqual(even.concat(odd).sort(function (a, b) { return a - b; }),
    Array.from({ length: 100 }, function (_, i) { return i; }));
  assert.deepStrictEqual(Screen.selectOpenings('3-5', 100), [3, 4, 5]);
  assert.throws(function () { Screen.selectOpenings('5-3', 100); });
  assert.throws(function () { Screen.selectOpenings('0-100', 100); });
});

check('logistic Elo is symmetric and anchored at 50%', function () {
  assert.ok(Screen.eloFromScore(0.5) === 0);
  assert.ok(Math.abs(Screen.eloFromScore(0.75) - 190.85) < 0.01);
  assert.ok(Math.abs(Screen.eloFromScore(0.25) + Screen.eloFromScore(0.75)) < 1e-9);
  assert.ok(Number.isFinite(Screen.eloFromScore(1)));
  assert.ok(Number.isFinite(Screen.eloFromScore(0)));
});

check('summaries count W-D-L, colors and a reproducible clustered interval', function () {
  const records = [];
  for (let id = 0; id < 20; id++) {
    records.push({ openingId: id, chessyColor: 'white', score: id % 4 === 0 ? 0 : 1 });
    records.push({ openingId: id, chessyColor: 'black', score: id % 5 === 0 ? 1 : 0.5 });
  }
  const a = Screen.summarize(records, { anchor: 1500, replicates: 2000 });
  const b = Screen.summarize(records, { anchor: 1500, replicates: 2000 });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.games, 40);
  assert.strictEqual(a.openingClusters, 20);
  assert.strictEqual(a.win, 15 + 4);
  assert.strictEqual(a.draw, 16);
  assert.strictEqual(a.loss, 5);
  assert.strictEqual(a.score, (19 + 8) / 40);
  assert.strictEqual(a.scoreWhite, 15 / 20);
  assert.strictEqual(a.scoreBlack, (4 + 8) / 20);
  assert.ok(Math.abs(a.ratingEstimate - (1500 + Screen.eloFromScore(a.score))) < 1e-9);
  const [lo, hi] = a.bootstrap.score95;
  assert.ok(lo < a.score && a.score < hi);
  assert.ok(a.bootstrap.rating95[0] < a.ratingEstimate && a.ratingEstimate < a.bootstrap.rating95[1]);
  assert.ok(a.bootstrap.oneSidedLower95Rating > a.bootstrap.rating95[0]);
});

// ---- Resume, snapshot and output-lock contract ----

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const Presets = require('../../assets/level-presets.js');

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(__dirname, 'level-screen.js');
// Independent oracle: the files a game process loads, listed here rather than
// read from the runner, and hashed here rather than by the runner.
const EXPECTED_INPUTS = {
  wasmSha256: 'assets/chessy-ai-fast.wasm',
  loaderSha256: 'assets/wasm-engine.js',
  rulesSha256: 'assets/engine.js',
  presetsSha256: 'assets/level-presets.js',
  bridgeSha256: 'test/wasm-test-engine.js',
  openingsSha256: 'test/ai-match-openings.js',
  openingProtocolSha256: 'test/ai-match-protocol.js',
  runnerSha256: 'test/eval/level-screen.js'
};
const EXPECTED_KEYS = ['schema', 'level', 'anchor', 'openings', 'stockfishSha256']
  .concat(Object.keys(EXPECTED_INPUTS));

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-screen-test-'));
}

function block(level, anchor) {
  const identity = Screen.runIdentity(ROOT, RUNNER, level, anchor, '0-1');
  const preset = Presets.get(Screen.LEVEL_IDS[level]);
  const jobs = [0, 1].flatMap(function (id) {
    return [{ openingId: id, chessyColor: 'white' }, { openingId: id, chessyColor: 'black' }];
  });
  const record = function (id, color) {
    return plain({ schema: Screen.SCHEMA, level: level, preset: preset,
      anchor: anchor, openingId: id, chessyColor: color, score: 1 });
  };
  const header = plain(Object.assign({ commit: 'x', loadavg: [1] }, identity));
  return { identity: identity, preset: preset, jobs: jobs, record: record, header: header };
}

check('the run identity names every loaded input and hashes it from the given root', function () {
  assert.deepStrictEqual(Screen.RUN_IDENTITY_KEYS.slice().sort(), EXPECTED_KEYS.slice().sort());
  assert.deepStrictEqual(Object.assign({}, Screen.SNAPSHOT_FILES), EXPECTED_INPUTS);
  const exe = path.join(ROOT, 'test', 'ai-match-protocol.js');
  const id = Screen.runIdentity(ROOT, exe, 'medium', 1700, '0-1');
  Object.keys(EXPECTED_INPUTS).forEach(function (k) {
    assert.strictEqual(id[k], sha(path.join(ROOT, EXPECTED_INPUTS[k])), k);
  });
  assert.strictEqual(id.stockfishSha256, sha(exe));
  assert.deepStrictEqual([id.schema, id.level, id.anchor, id.openings],
    [Screen.SCHEMA + '.run', 'medium', 1700, '0-1']);
});

check('a resume fills only the missing slots of the same block', function () {
  const b = block('medium', 1700);
  assert.deepStrictEqual(Screen.checkResume(b.identity, b.preset, b.jobs, [], []), b.jobs);
  // Descriptive fields (commit, load) may differ between a start and a resume.
  const pending = Screen.checkResume(b.identity, b.preset, b.jobs,
    [b.header, Object.assign({}, b.header, { commit: 'y', loadavg: [3] })],
    [b.record(0, 'white'), b.record(1, 'black')]);
  assert.deepStrictEqual(pending,
    [{ openingId: 0, chessyColor: 'black' }, { openingId: 1, chessyColor: 'white' }]);
});

check('a resume with a changed candidate, anchor or schedule is refused', function () {
  const b = block('medium', 1700);
  const games = [b.record(0, 'white')];
  EXPECTED_KEYS.forEach(function (k) {
    const header = Object.assign({}, b.header);
    header[k] = k === 'anchor' ? 1900 : 'changed';
    assert.throws(function () {
      Screen.checkResume(b.identity, b.preset, b.jobs, [header], games);
    }, new RegExp('differs in ' + k), k + ' change must be refused');
  });
  // A header from an older runner lacks the newer inputs and is refused.
  const legacy = Object.assign({}, b.header);
  delete legacy.openingsSha256;
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [legacy], games);
  }, /openingsSha256/);
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [], games);
  }, /no \.runs header/);
  const hard = block('hard', 1700);
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header], [hard.record(0, 'white')]);
  }, /different level, anchor or preset/);
  const retuned = b.record(0, 'white');
  retuned.preset.nodeLimit += 1;
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header], [retuned]);
  }, /different level, anchor or preset/);
  const otherAnchor = b.record(0, 'white');
  otherAnchor.anchor = 1500;
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header], [otherAnchor]);
  }, /different level, anchor or preset/);
  const otherSchema = b.record(0, 'white');
  otherSchema.schema = 'something-else';
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header], [otherSchema]);
  }, /different level, anchor or preset/);
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header], [b.record(7, 'white')]);
  }, /outside this schedule/);
  assert.throws(function () {
    Screen.checkResume(b.identity, b.preset, b.jobs, [b.header],
      [b.record(0, 'white'), b.record(0, 'white')]);
  }, /repeats slot 0:white/);
});

check('a summary refuses mixed blocks and duplicate slots', function () {
  const b = block('medium', 1700);
  Screen.validateBlock([b.record(0, 'white'), b.record(0, 'black')], [b.header, b.header]);
  Screen.validateBlock([b.record(0, 'white')], []);
  Screen.validateBlock([], [b.header]);
  assert.throws(function () {
    Screen.validateBlock([b.record(0, 'white'), b.record(0, 'white')], []);
  }, /repeats slot/);
  const mixes = [
    block('hard', 1700).record(0, 'black'),
    Object.assign(b.record(0, 'black'), { anchor: 1900 }),
    Object.assign(b.record(0, 'black'), { schema: 'other' }),
    Object.assign(b.record(0, 'black'), { preset: Object.assign({}, b.preset, { maxDepth: 3 }) })
  ];
  mixes.forEach(function (other, i) {
    assert.throws(function () {
      Screen.validateBlock([b.record(0, 'white'), other], []);
    }, /mixes/, 'mix ' + i);
  });
  assert.throws(function () {
    Screen.validateBlock([b.record(0, 'white')],
      [b.header, Object.assign({}, b.header, { presetsSha256: 'changed' })]);
  }, /presetsSha256/);
  assert.throws(function () {
    Screen.validateBlock([b.record(0, 'white')], [block('medium', 1900).header]);
  }, /does not match this block/);
});

check('the committed r80 screen blocks each pass the block check', function () {
  const dir = path.join(ROOT, 'eval', 'level-screen-r80');
  // Start/resume headers per block, as the README reports them.
  const expected = {
    'relabel-easy-1500.ndjson': [0],
    'stage1-easy-1500.ndjson': [0],
    'stage1-medium-1700.ndjson': [0],
    'stage1-hard-1900.ndjson': [0],
    'stage1-expert-2100.ndjson': [0],
    'stage2-expert-2300.ndjson': [0, 54],
    'stage1-master-2300.ndjson': [0, 0]
  };
  const files = fs.readdirSync(dir).filter(function (f) { return /\.ndjson$/.test(f); });
  assert.deepStrictEqual(files.slice().sort(), Object.keys(expected).sort());
  files.forEach(function (f) {
    const records = Screen.readRecords(path.join(dir, f));
    const headers = Screen.readRecords(path.join(dir, f + '.runs'));
    assert.strictEqual(records.length, 100, f);
    assert.deepStrictEqual(headers.map(function (h) { return h.alreadyRecorded; }),
      expected[f], f);
    Screen.validateBlock(records, headers);
  });
});

check('one exclusive lock guards an output until its owner releases it', function () {
  const dir = tempDir();
  try {
    const out = path.join(dir, 'block.ndjson');
    const first = Screen.acquireLock(out);
    assert.throws(function () { Screen.acquireLock(out); }, /is locked/);
    // A lock this owner did not write (a replacement) is left in place.
    fs.writeFileSync(first.path, 'someone else\n');
    first.release();
    assert.ok(fs.existsSync(first.path));
    fs.unlinkSync(first.path);
    const second = Screen.acquireLock(out);
    second.release();
    assert.ok(!fs.existsSync(second.path));
    Screen.acquireLock(out).release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('an output has one canonical path; a dangling link is refused', function () {
  const dir = fs.realpathSync(tempDir());
  try {
    const out = path.join(dir, 'block.ndjson');
    assert.strictEqual(Screen.canonicalOut(out), out);
    assert.strictEqual(Screen.canonicalOut(path.join(dir, '.', 'x', '..', 'block.ndjson')), out);
    fs.writeFileSync(out, '');
    fs.symlinkSync(out, path.join(dir, 'alias.ndjson'));
    assert.strictEqual(Screen.canonicalOut(path.join(dir, 'alias.ndjson')), out);
    fs.symlinkSync(path.join(dir, 'missing.ndjson'), path.join(dir, 'broken.ndjson'));
    assert.throws(function () {
      Screen.canonicalOut(path.join(dir, 'broken.ndjson'));
    }, /is a dangling symbolic link/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('a truncated NDJSON line is reported, not skipped', function () {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'block.ndjson');
    fs.writeFileSync(file, '{"a":1}\n{"a":');
    assert.throws(function () { Screen.readRecords(file); }, /line 2 is not JSON/);
    assert.deepStrictEqual(Screen.readRecords(path.join(dir, 'missing.ndjson')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- End-to-end runs against a scripted UCI anchor ----
// The fake anchor plays the first legal move in UCI order. FAKE_SF_DELAY_MS
// slows each reply; FAKE_SF_TAMPER edits the running binary itself (inside the
// run's snapshot); FAKE_SF_EDIT names a source file it edits mid-run.

function fakeStockfish(dir, name) {
  const file = path.join(dir, name || 'fakefish');
  fs.writeFileSync(file, '#!' + process.execPath + '\n' +
    "'use strict';\n" +
    'const fs = require("fs");\n' +
    'require(' + JSON.stringify(path.join(ROOT, 'assets', 'engine.js')) + ');\n' +
    'const uci = function (m) { return Chess.sqName(m.from) + Chess.sqName(m.to) +\n' +
    '  (m.promotion ? m.promotion.toLowerCase() : ""); };\n' +
    'const delay = Number(process.env.FAKE_SF_DELAY_MS || 0);\n' +
    'let moves = [];\n' +
    'let edited = false;\n' +
    'require("readline").createInterface({ input: process.stdin }).on("line", function (l) {\n' +
    '  l = l.trim();\n' +
    '  if (l === "uci") process.stdout.write("id name FakeFish\\nuciok\\n");\n' +
    '  else if (l === "isready") process.stdout.write("readyok\\n");\n' +
    '  else if (l.indexOf("position startpos") === 0) {\n' +
    '    const tail = l.split(" moves ")[1];\n' +
    '    moves = tail ? tail.split(" ") : [];\n' +
    '  } else if (l.indexOf("go") === 0) {\n' +
    '    if (!edited) {\n' +
    '      edited = true;\n' +
    '      if (process.env.FAKE_SF_TAMPER) {\n' +
    '        fs.chmodSync(__filename, 0o755);\n' +
    '        fs.appendFileSync(__filename, "\\n// tampered\\n");\n' +
    '      }\n' +
    '      if (process.env.FAKE_SF_EDIT) fs.appendFileSync(process.env.FAKE_SF_EDIT, "\\n// edited\\n");\n' +
    '    }\n' +
    '    let state = Chess.newGameState();\n' +
    '    moves.forEach(function (u) {\n' +
    '      state = Chess.playMove(state, Chess.legalMoves(state).find(function (m) { return uci(m) === u; }));\n' +
    '    });\n' +
    '    const legal = Chess.legalMoves(state).map(uci).sort();\n' +
    '    setTimeout(function () {\n' +
    '      process.stdout.write("bestmove " + (legal[0] || "(none)") + "\\n");\n' +
    '    }, delay);\n' +
    '  } else if (l === "quit") process.exit(0);\n' +
    '});\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function runCli(args, env) {
  return new Promise(function (resolve) {
    const child = cp.spawn(process.execPath, [RUNNER].concat(args), {
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', function (d) { output += d; });
    child.stderr.on('data', function (d) { output += d; });
    child.on('exit', function (code) { resolve({ code: code, output: output }); });
  });
}

function snapshotsLeft() {
  return fs.readdirSync(os.tmpdir()).filter(function (f) {
    return f.indexOf('chessy-level-screen-') === 0;
  });
}

async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

async function endToEnd() {
  const dir = fs.realpathSync(tempDir());
  const before = snapshotsLeft();
  const readText = function (f) { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  try {
    const sf = fakeStockfish(dir);
    const out = path.join(dir, 'block.ndjson');
    const base = ['--stockfish', sf, '--level', 'easy', '--anchor', '1500',
      '--openings', '0-0', '--out', out, '--concurrency', '2'];

    await checkAsync('a run plays its schedule from a snapshot of the hashed inputs', async function () {
      const r = await runCli(base);
      assert.strictEqual(r.code, 0, r.output);
      const records = Screen.readRecords(out);
      const headers = Screen.readRecords(out + '.runs');
      assert.deepStrictEqual(records.map(function (x) { return x.openingId + ':' + x.chessyColor; })
        .sort(), ['0:black', '0:white']);
      records.forEach(function (x) {
        assert.strictEqual(x.anchorEngine, 'FakeFish');
        assert.deepStrictEqual(x.preset, plain(Presets.get('1')));
      });
      assert.strictEqual(headers.length, 1);
      Object.keys(EXPECTED_INPUTS).forEach(function (k) {
        assert.strictEqual(headers[0][k], sha(path.join(ROOT, EXPECTED_INPUTS[k])), k);
      });
      assert.strictEqual(headers[0].stockfishSha256, sha(sf));
      assert.strictEqual(headers[0].alreadyRecorded, 0);
      assert.ok(!fs.existsSync(out + '.lock'));
    });

    await checkAsync('a resume of the same block refills only its missing slot', async function () {
      const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
      const dropped = JSON.parse(lines.pop());
      fs.writeFileSync(out, lines.join('\n') + '\n');
      const r = await runCli(base);
      assert.strictEqual(r.code, 0, r.output);
      const records = Screen.readRecords(out);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[1].openingId + ':' + records[1].chessyColor,
        dropped.openingId + ':' + dropped.chessyColor);
      assert.deepStrictEqual(Screen.readRecords(out + '.runs').map(function (h) {
        return h.alreadyRecorded;
      }), [0, 1]);
    });

    await checkAsync('a resume with a changed anchor, engine, openings or concurrency writes nothing', async function () {
      const games = readText(out);
      const runs = readText(out + '.runs');
      const other = fakeStockfish(dir, 'otherfish');
      fs.appendFileSync(other, '\n// a different build\n');
      const cases = [
        [base.map(function (a) { return a === '1500' ? '1900' : a; }), /differs in anchor/],
        [base.map(function (a) { return a === sf ? other : a; }), /differs in stockfishSha256/],
        [base.map(function (a) { return a === '0-0' ? '0-1' : a; }), /differs in openings/],
        [base.map(function (a) { return a === '2' ? '0' : a; }), /usage/]
      ];
      for (const c of cases) {
        const r = await runCli(c[0]);
        assert.strictEqual(r.code, 1, r.output);
        assert.ok(c[1].test(r.output), r.output);
        assert.strictEqual(readText(out), games);
        assert.strictEqual(readText(out + '.runs'), runs);
        assert.ok(!fs.existsSync(out + '.lock'));
      }
    });

    await checkAsync('a second run on the same output is refused while the first holds it', async function () {
      const shared = path.join(dir, 'shared.ndjson');
      const args = ['--stockfish', sf, '--level', 'easy', '--anchor', '1500',
        '--openings', '0-0', '--out', shared, '--concurrency', '1'];
      const first = runCli(args, { FAKE_SF_DELAY_MS: '100' });
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(shared + '.lock') && Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 20); });
      }
      assert.ok(fs.existsSync(shared + '.lock'), 'first run took the lock');
      const relative = path.relative(process.cwd(), shared);
      const second = await runCli(args.map(function (a) { return a === shared ? relative : a; }));
      const firstDone = await first;
      assert.strictEqual(second.code, 1, second.output);
      assert.ok(/is locked/.test(second.output), second.output);
      assert.strictEqual(firstDone.code, 0, firstDone.output);
      const records = Screen.readRecords(shared);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(new Set(records.map(function (x) {
        return x.openingId + ':' + x.chessyColor;
      })).size, 2);
      assert.strictEqual(Screen.readRecords(shared + '.runs').length, 1);
    });

    await checkAsync('a source edit during the run does not reach its games', async function () {
      const source = fakeStockfish(dir, 'editedfish');
      const original = sha(source);
      const edited = path.join(dir, 'edited.ndjson');
      const r = await runCli(['--stockfish', source, '--level', 'easy', '--anchor', '1500',
        '--openings', '0-0', '--out', edited, '--concurrency', '1'], { FAKE_SF_EDIT: source });
      assert.strictEqual(r.code, 0, r.output);
      assert.notStrictEqual(sha(source), original, 'the source was edited mid-run');
      assert.strictEqual(Screen.readRecords(edited).length, 2);
      assert.strictEqual(Screen.readRecords(edited + '.runs')[0].stockfishSha256, original);
    });

    await checkAsync('a game is not recorded once its snapshot changes', async function () {
      const tampered = path.join(dir, 'tampered.ndjson');
      const r = await runCli(['--stockfish', sf, '--level', 'easy', '--anchor', '1500',
        '--openings', '0-0', '--out', tampered, '--concurrency', '1'], { FAKE_SF_TAMPER: '1' });
      assert.strictEqual(r.code, 1, r.output);
      assert.ok(/snapshot changed \(stockfishSha256\)/.test(r.output), r.output);
      assert.deepStrictEqual(Screen.readRecords(tampered), []);
      assert.ok(!fs.existsSync(tampered + '.lock'));
    });

    await checkAsync('a dangling --out link is refused before anything is written', async function () {
      const link = path.join(dir, 'broken.ndjson');
      fs.symlinkSync(path.join(dir, 'nowhere', 'x.ndjson'), link);
      const r = await runCli(base.map(function (a) { return a === out ? link : a; }));
      assert.strictEqual(r.code, 1, r.output);
      assert.ok(/is a dangling symbolic link/.test(r.output), r.output);
      assert.ok(!fs.existsSync(link + '.lock') && !fs.existsSync(link + '.runs'));
    });

    assert.deepStrictEqual(snapshotsLeft().filter(function (f) {
      return before.indexOf(f) < 0;
    }), [], 'every run removed its snapshot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

endToEnd().then(function () {
  console.log('\nlevel-screen: ' + passed + ' passed');
}, function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
