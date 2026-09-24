#!/usr/bin/env node
/*
 * EXPLORATORY Play-level screen against pinned Stockfish 18 UCI_Elo anchors.
 *
 * This is diagnostic development evidence, NOT E4-v1 exploration or
 * certification: E4-v1 requires frozen opening manifests, the declared minimum
 * physical device and the #84 baseline before any admissible game. The screen
 * reuses E4-v1's anchor settings (UCI_LimitStrength, Threads 1, Hash 64,
 * MultiPV 1, Move Overhead 10, movetime 1000 ms, ucinewgame + Clear Hash before
 * every game) and its 180-ply draw adjudication, but plays the long-used
 * development opening list in test/ai-match-openings.js. Results never
 * certify a rating and must not be pooled with E4 evidence.
 *
 * The Chessy side is driven exactly like the product worker request:
 * engine.search(fen, { maxDepth, timeMs, nodeLimit, quiesce,
 * positions: state.positions }) using the shipped preset for an untimed game.
 * A thrown search gets one identical retry (the product's fresh-worker retry);
 * a second failure, an illegal move, or a search slower than the product
 * watchdog (timeMs + 3000 ms) loses the game for Chessy. An illegal, missing
 * or late Stockfish move loses for Stockfish.
 *
 * A run holds an exclusive <out>.lock from its resume read to its last append.
 * Its games execute a private read-only snapshot of the runner, rules, loader,
 * WASM, presets, opening list and Stockfish, whose hashes head its .runs line.
 * A resume must match the block's recorded inputs, or it is refused. After
 * the last game it writes <out>.complete.json, a no-replace receipt binding
 * the exact NDJSON and .runs bytes to the complete schedule; --summarize
 * requires it, and a sealed block cannot be resumed.
 *
 *   node test/eval/level-screen.js --stockfish <exe> --level easy \
 *     --anchor 1500 --openings even --out <file.ndjson> [--concurrency 4]
 *   node test/eval/level-screen.js --summarize <file.ndjson> [...]
 *   node test/eval/level-screen.js --seal <file.ndjson> [...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const util = require('util');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'assets', 'engine.js'));
const Presets = require(path.join(ROOT, 'assets', 'level-presets.js'));

const SCHEMA = 'chessy.level-screen.exploratory.v1';
const LEVEL_IDS = Object.freeze({
  easy: '1', medium: '2', hard: '3', expert: '5', master: 'master'
});
const DRAW_AT_PLIES = 180;
const ANCHOR_MOVETIME_MS = 1000;
const ANCHOR_MOVE_TIMEOUT_MS = 15000;
const PRODUCT_WATCHDOG_SLACK_MS = 3000;
const ANCHOR_OPTIONS = Object.freeze([
  ['UCI_LimitStrength', 'true'],
  ['Threads', '1'],
  ['Hash', '64'],
  ['Ponder', 'false'],
  ['MultiPV', '1'],
  ['SyzygyPath', ''],
  ['Move Overhead', '10']
]);

function uciOf(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function openingLine(sans) {
  const strip = function (s) { return s.replace(/[+#]$/, ''); };
  let state = Chess.newGameState();
  const uci = [];
  for (const san of sans.split(' ')) {
    const legal = Chess.legalMoves(state);
    const hits = legal.filter(function (m) {
      return strip(Chess.toSan(state, m, legal)) === strip(san);
    });
    if (hits.length !== 1) {
      throw new Error('opening token "' + san + '" matched ' + hits.length + ' moves');
    }
    uci.push(uciOf(hits[0]));
    state = Chess.playMove(state, hits[0]);
  }
  return { state: state, uci: uci };
}

function legalFromUci(state, text) {
  if (typeof text !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) return null;
  return Chess.legalMoves(state).find(function (m) { return uciOf(m) === text; }) || null;
}

// Score from Chessy's perspective for a finished rules result.
function chessyScore(result, chessyColor) {
  if (result === '1/2-1/2') return 0.5;
  const whiteWon = result === '1-0';
  if (!whiteWon && result !== '0-1') throw new Error('unknown result ' + result);
  return (whiteWon === (chessyColor === 'white')) ? 1 : 0;
}

// Opening selection is fixed before any game: 'even' and 'odd' are disjoint
// halves that interleave the list's families; 'a-b' is an inclusive range.
function selectOpenings(spec, count) {
  const out = [];
  if (spec === 'even' || spec === 'odd') {
    for (let i = spec === 'even' ? 0 : 1; i < count; i += 2) out.push(i);
    return out;
  }
  const m = /^(\d+)-(\d+)$/.exec(String(spec));
  if (!m) throw new Error('--openings must be even, odd or a-b');
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo > hi || hi >= count) throw new Error('opening range out of bounds');
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

// ---- Descriptive statistics (logistic Elo; opening-cluster bootstrap) ----

function eloFromScore(score) {
  const s = Math.min(Math.max(score, 1e-6), 1 - 1e-6);
  return -400 * Math.log10(1 / s - 1);
}

// Deterministic mulberry32 so the reported interval is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(records, opts) {
  opts = opts || {};
  const replicates = opts.replicates || 10000;
  const seed = opts.seed == null ? 20260924 : opts.seed;
  const w = records.filter(function (r) { return r.score === 1; }).length;
  const d = records.filter(function (r) { return r.score === 0.5; }).length;
  const l = records.filter(function (r) { return r.score === 0; }).length;
  const n = records.length;
  const points = w + d / 2;
  const score = n ? points / n : NaN;
  const clusters = new Map();
  records.forEach(function (r) {
    if (!clusters.has(r.openingId)) clusters.set(r.openingId, { pts: 0, n: 0 });
    const c = clusters.get(r.openingId);
    c.pts += r.score;
    c.n += 1;
  });
  const list = Array.from(clusters.values());
  const draws = [];
  const next = rng(seed);
  for (let b = 0; b < replicates && list.length; b++) {
    let pts = 0;
    let games = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[Math.floor(next() * list.length)];
      pts += c.pts;
      games += c.n;
    }
    draws.push(pts / games);
  }
  draws.sort(function (a, b) { return a - b; });
  const white = records.filter(function (r) { return r.chessyColor === 'white'; });
  const black = records.filter(function (r) { return r.chessyColor === 'black'; });
  const mean = function (rs) {
    return rs.length ? rs.reduce(function (a, r) { return a + r.score; }, 0) / rs.length : NaN;
  };
  const anchor = opts.anchor;
  const toRating = function (s) { return anchor + eloFromScore(s); };
  return {
    games: n,
    openingClusters: list.length,
    win: w,
    draw: d,
    loss: l,
    score: score,
    scoreWhite: mean(white),
    scoreBlack: mean(black),
    eloDiff: eloFromScore(score),
    ratingEstimate: toRating(score),
    bootstrap: {
      replicates: replicates,
      seed: seed,
      clusterUnit: 'opening (both colors together)',
      score95: [quantile(draws, 0.025), quantile(draws, 0.975)],
      rating95: [toRating(quantile(draws, 0.025)), toRating(quantile(draws, 0.975))],
      oneSidedLower95Rating: toRating(quantile(draws, 0.05))
    }
  };
}

// ---- Stockfish UCI anchor ----

function startAnchor(exe, elo) {
  const child = cp.spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let waiter = null;
  const lines = [];
  let exited = false;
  child.on('exit', function () {
    exited = true;
    if (waiter) { const w = waiter; waiter = null; w.reject(new Error('anchor exited')); }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      lines.push(line);
      if (waiter && waiter.test(line)) {
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  });
  function send(cmd) {
    if (exited) throw new Error('anchor exited');
    child.stdin.write(cmd + '\n');
  }
  function until(test, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (exited) { reject(new Error('anchor exited')); return; }
      waiter = { test: test, resolve: resolve, reject: reject };
      waiter.timer = setTimeout(function () {
        if (waiter) { waiter = null; reject(new Error('anchor timeout')); }
      }, timeoutMs);
    });
  }
  return {
    lines: lines,
    init: async function () {
      send('uci');
      await until(function (l) { return l === 'uciok'; }, 10000);
      const idName = lines.find(function (l) { return l.indexOf('id name ') === 0; }) || '';
      ANCHOR_OPTIONS.forEach(function (o) { send('setoption name ' + o[0] + ' value ' + o[1]); });
      send('setoption name UCI_Elo value ' + elo);
      send('isready');
      await until(function (l) { return l === 'readyok'; }, 10000);
      return idName.slice('id name '.length);
    },
    newGame: async function () {
      send('ucinewgame');
      send('setoption name Clear Hash');
      send('isready');
      await until(function (l) { return l === 'readyok'; }, 10000);
    },
    move: async function (uciMoves) {
      send('position startpos' + (uciMoves.length ? ' moves ' + uciMoves.join(' ') : ''));
      send('go movetime ' + ANCHOR_MOVETIME_MS);
      const line = await until(function (l) { return l.indexOf('bestmove ') === 0; },
        ANCHOR_MOVE_TIMEOUT_MS);
      return line.split(/\s+/)[1];
    },
    quit: function () {
      try { send('quit'); } catch (e) { /* already gone */ }
      setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 500);
    }
  };
}

// ---- One game (runs in a child process) ----

async function playOne(spec) {
  const Wasm = require(path.join(ROOT, 'test', 'wasm-test-engine.js'));
  const OPENINGS = require(path.join(ROOT, 'test', 'ai-match-openings.js'));
  const preset = Presets.get(LEVEL_IDS[spec.level]);
  if (!preset) throw new Error('unknown level ' + spec.level);
  const opening = OPENINGS[spec.openingId];
  const line = openingLine(opening[1]);
  let state = line.state;
  const moves = line.uci.slice();
  const anchor = startAnchor(spec.stockfish, spec.anchor);
  const anchorName = await anchor.init();
  await anchor.newGame();
  const chessyTurn = spec.chessyColor === 'white' ? 'w' : 'b';
  const stats = { moves: 0, depthSum: 0, nodesSum: 0, msSum: 0, maxMs: 0,
    retries: 0, depths: {}, stops: {}, ttSaturated: 0 };
  let result = null;
  let reason = null;
  const watchdogMs = preset.timeMs + PRODUCT_WATCHDOG_SLACK_MS;
  try {
    while (!result) {
      const status = Chess.gameStatus(state);
      if (status.over) {
        result = chessyScore(status.result, spec.chessyColor);
        reason = status.reason || 'rules';
        break;
      }
      if (moves.length >= DRAW_AT_PLIES) {
        result = 0.5;
        reason = 'ply-cap';
        break;
      }
      if (state.turn === chessyTurn) {
        const request = {
          maxDepth: preset.maxDepth,
          timeMs: preset.timeMs,
          nodeLimit: preset.nodeLimit,
          quiesce: preset.quiesce,
          positions: state.positions
        };
        let r = null;
        let started = Date.now();
        for (let attempt = 0; attempt < 2 && !r; attempt++) {
          started = Date.now();
          try {
            r = Wasm.engine.search(Chess.toFen(state), request);
          } catch (error) {
            stats.retries++;
            stats.lastError = String(error && error.message || error);
          }
        }
        const ms = Date.now() - started;
        if (!r) { result = 0; reason = 'chessy-search-failure'; break; }
        if (ms > watchdogMs) { result = 0; reason = 'chessy-watchdog'; break; }
        const legal = Chess.legalMoves(state);
        const move = r.move && legal.find(function (m) {
          return m.from === r.move.from && m.to === r.move.to &&
            (m.promotion || null) === (r.move.promotion || null);
        });
        if (!move) { result = 0; reason = 'chessy-illegal'; break; }
        stats.moves++;
        stats.depthSum += r.depth;
        stats.nodesSum += r.nodes;
        stats.msSum += ms;
        stats.maxMs = Math.max(stats.maxMs, ms);
        stats.depths[r.depth] = (stats.depths[r.depth] || 0) + 1;
        stats.stops[r.stopReason] = (stats.stops[r.stopReason] || 0) + 1;
        if (r.ttSaturated === true) stats.ttSaturated++;
        moves.push(uciOf(move));
        state = Chess.playMove(state, move);
      } else {
        let text;
        try {
          text = await anchor.move(moves);
        } catch (error) {
          result = 1;
          reason = 'anchor-failure:' + error.message;
          break;
        }
        const move = legalFromUci(state, text);
        if (!move) { result = 1; reason = 'anchor-illegal:' + text; break; }
        moves.push(uciOf(move));
        state = Chess.playMove(state, move);
      }
    }
  } finally {
    anchor.quit();
  }
  return {
    schema: SCHEMA,
    level: spec.level,
    preset: preset,
    anchor: spec.anchor,
    anchorEngine: anchorName,
    openingId: spec.openingId,
    openingName: opening[0],
    chessyColor: spec.chessyColor,
    score: result,
    reason: reason,
    plies: moves.length,
    openingPlies: line.uci.length,
    moves: moves.join(' '),
    chessy: stats
  };
}

// ---- Parent: fixed schedule, bounded pool, append-only NDJSON ----

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitOutput(args) {
  try {
    return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function arg(argv, name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

function parseRecords(text, label) {
  return text.split('\n').map(function (l, i) {
    if (!l) return null;
    try {
      return JSON.parse(l);
    } catch (error) {
      throw new Error(label + ' line ' + (i + 1) + ' is not JSON (truncated append?)');
    }
  }).filter(Boolean);
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return parseRecords(fs.readFileSync(file, 'utf8'), file);
}

function slotOf(r) {
  return r.openingId + ':' + r.chessyColor;
}

// Every file a game process loads, relative to the repository root, keyed by
// its identity field. A run copies them (and Stockfish) into a private
// read-only snapshot and executes only that, so the bytes it hashes are the
// bytes its games run.
const SNAPSHOT_FILES = Object.freeze({
  wasmSha256: 'assets/chessy-ai-fast.wasm',
  loaderSha256: 'assets/wasm-engine.js',
  rulesSha256: 'assets/engine.js',
  presetsSha256: 'assets/level-presets.js',
  bridgeSha256: 'test/wasm-test-engine.js',
  openingsSha256: 'test/ai-match-openings.js',
  openingProtocolSha256: 'test/ai-match-protocol.js',
  runnerSha256: 'test/eval/level-screen.js'
});
const SNAPSHOT_STOCKFISH = 'stockfish';

// Every input that changes what a block's games measure, including how many
// games share the host (wall-clock searches depend on it). A block's .runs
// headers and records must agree on all of them; commit, host and load are
// descriptive only.
const RUN_IDENTITY_KEYS = Object.freeze(['schema', 'level', 'anchor', 'openings',
  'concurrency', 'stockfishSha256'].concat(Object.keys(SNAPSHOT_FILES)));

// `root` holds SNAPSHOT_FILES at their relative paths; `exe` is Stockfish.
function runIdentity(root, exe, level, anchor, openings, concurrency) {
  const identity = {
    schema: SCHEMA + '.run',
    level: level,
    anchor: anchor,
    openings: openings,
    concurrency: concurrency,
    stockfishSha256: sha256File(exe)
  };
  Object.keys(SNAPSHOT_FILES).forEach(function (key) {
    identity[key] = sha256File(path.join(root, SNAPSHOT_FILES[key]));
  });
  return identity;
}

function makeSnapshot(exe) {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'chessy-level-screen-'));
  try {
    Object.keys(SNAPSHOT_FILES).forEach(function (key) {
      const rel = SNAPSHOT_FILES[key];
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o444);
    });
    const stockfish = path.join(dir, SNAPSHOT_STOCKFISH);
    fs.copyFileSync(exe, stockfish, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stockfish, 0o555);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir: dir,
    runner: path.join(dir, SNAPSHOT_FILES.runnerSha256),
    stockfish: path.join(dir, SNAPSHOT_STOCKFISH),
    remove: function () { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

function identityDiff(a, b) {
  return RUN_IDENTITY_KEYS.filter(function (k) {
    return !util.isDeepStrictEqual(a[k], b[k]);
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Resume after a host interruption only fills the missing slots of the SAME
// block: every earlier header must carry this invocation's identity and every
// earlier record its level, anchor, preset and a distinct scheduled slot.
// Anything else is refused, so a changed candidate needs a fresh --out.
function checkResume(identity, preset, jobs, headers, records) {
  if (records.length && !headers.length) {
    throw new Error('existing games have no .runs header; use a fresh --out');
  }
  headers.forEach(function (h, i) {
    const diff = identityDiff(h, identity);
    if (diff.length) {
      throw new Error('.runs header ' + (i + 1) + ' differs in ' + diff.join(', ') +
        '; a changed screen needs a fresh --out');
    }
  });
  const scheduled = new Set(jobs.map(slotOf));
  const expected = plain(preset);
  const done = new Set();
  records.forEach(function (r, i) {
    if (r.schema !== SCHEMA || r.level !== identity.level || r.anchor !== identity.anchor ||
        !util.isDeepStrictEqual(r.preset, expected)) {
      throw new Error('record ' + (i + 1) + ' was played by a different level, anchor or ' +
        'preset; a changed screen needs a fresh --out');
    }
    const slot = slotOf(r);
    if (!scheduled.has(slot)) throw new Error('record ' + (i + 1) + ' is outside this schedule');
    if (done.has(slot)) throw new Error('record ' + (i + 1) + ' repeats slot ' + slot);
    done.add(slot);
  });
  return jobs.filter(function (j) { return !done.has(slotOf(j)); });
}

// A summary covers exactly one block: one level, anchor and preset, each
// schedule slot at most once, and (when present) consistent .runs headers.
function validateBlock(records, headers) {
  headers = headers || [];
  const first = records[0] || headers[0];
  if (!first) return;
  const slots = new Set();
  records.forEach(function (r, i) {
    if (r.schema !== SCHEMA || r.level !== first.level || r.anchor !== first.anchor ||
        !util.isDeepStrictEqual(r.preset, records[0].preset)) {
      throw new Error('record ' + (i + 1) + ' mixes levels, anchors or presets');
    }
    const slot = slotOf(r);
    if (slots.has(slot)) throw new Error('record ' + (i + 1) + ' repeats slot ' + slot);
    slots.add(slot);
  });
  headers.forEach(function (h, i) {
    const diff = identityDiff(h, headers[0]);
    if (diff.length || h.level !== first.level || h.anchor !== first.anchor) {
      throw new Error('.runs header ' + (i + 1) + ' does not match this block' +
        (diff.length ? ' (' + diff.join(', ') + ')' : ''));
    }
  });
}

// ---- Completion receipt: written once, after the last game ----

const RECEIPT_SCHEMA = SCHEMA + '.complete';

function receiptPath(out) {
  return out + '.complete.json';
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// The receipt a complete block must carry, computed from the exact bytes it
// binds: every scheduled slot played once, headers from one run identity, and
// every record replayed through the rules from its scheduled opening line.
// `openings` is the opening list with the hashes of its source and protocol
// files. Headers written before the full identity existed (identityComplete
// false) are authenticated by that replay rather than by recorded hashes.
function completionOf(dataBytes, runsBytes, openings, label) {
  const records = parseRecords(dataBytes.toString('utf8'), label);
  const headers = parseRecords(runsBytes.toString('utf8'), label + '.runs');
  if (!records.length || !headers.length) throw new Error(label + ' is incomplete: no games');
  validateBlock(records, headers);
  const header = headers[0];
  if (header.openingsSha256 !== undefined && header.openingsSha256 !== openings.sha256) {
    throw new Error(label + ' was played from another opening list');
  }
  const expected = [];
  selectOpenings(header.openings, openings.list.length).forEach(function (id) {
    expected.push(id + ':white', id + ':black');
  });
  const played = new Set(records.map(slotOf));
  const missing = expected.filter(function (slot) { return !played.has(slot); });
  if (missing.length || records.length !== expected.length ||
      header.scheduledGames !== expected.length) {
    throw new Error(label + ' is incomplete: ' + records.length + ' of ' + expected.length +
      ' scheduled games');
  }
  const lines = {};
  records.forEach(function (r, i) {
    const where = label + ' record ' + (i + 1);
    const opening = openings.list[r.openingId];
    if (r.openingName !== opening[0]) throw new Error(where + ' does not name its scheduled opening');
    if (!lines[r.openingId]) lines[r.openingId] = openingLine(opening[1]).uci;
    const prefix = lines[r.openingId];
    const moves = typeof r.moves === 'string' && r.moves ? r.moves.split(' ') : [];
    if (r.openingPlies !== prefix.length || r.plies !== moves.length ||
        prefix.some(function (u, k) { return moves[k] !== u; })) {
      throw new Error(where + ' does not start with its scheduled opening line');
    }
    let state = Chess.newGameState();
    moves.forEach(function (u, k) {
      const move = legalFromUci(state, u);
      if (!move) throw new Error(where + ' ply ' + (k + 1) + ' is not a legal move');
      state = Chess.playMove(state, move);
    });
  });
  const identity = {};
  RUN_IDENTITY_KEYS.forEach(function (k) {
    if (header[k] !== undefined) identity[k] = header[k];
  });
  const identityComplete = RUN_IDENTITY_KEYS.every(function (k) {
    return header[k] !== undefined;
  });
  return {
    records: records,
    headers: headers,
    receipt: {
      schema: RECEIPT_SCHEMA,
      identity: identity,
      identityComplete: identityComplete,
      replayedAgainst: {
        openingsSha256: openings.sha256,
        openingProtocolSha256: openings.protocolSha256
      },
      scheduledGames: expected.length,
      games: records.length,
      ndjsonSha256: sha256Bytes(dataBytes),
      runsSha256: sha256Bytes(runsBytes)
    }
  };
}

// Write the receipt with no-replace semantics. The caller holds the lock. The
// runner always records the full identity, so its own seal requires it.
function sealBlock(out, openings, sealedBy) {
  const done = completionOf(fs.readFileSync(out), fs.readFileSync(out + '.runs'),
    openings, out);
  if (sealedBy === 'runner' && !done.receipt.identityComplete) {
    throw new Error(out + ' lacks part of the run identity');
  }
  const receipt = Object.assign({}, done.receipt, { sealedBy: sealedBy });
  try {
    fs.writeFileSync(receiptPath(out), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(out + ' is already sealed');
    throw error;
  }
  return receipt;
}

// Publication requires a receipt that still binds the exact bytes present.
function verifySealed(out, openings) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath(out), 'utf8'));
  } catch (error) {
    throw new Error(out + ' is not sealed: missing or unreadable ' + receiptPath(out));
  }
  const done = completionOf(fs.readFileSync(out), fs.readFileSync(out + '.runs'),
    openings, out);
  const stored = Object.assign({}, receipt);
  delete stored.sealedBy;
  const diff = Object.keys(done.receipt).filter(function (k) {
    return !util.isDeepStrictEqual(stored[k], done.receipt[k]);
  });
  if (diff.length || Object.keys(stored).length !== Object.keys(done.receipt).length) {
    throw new Error(out + ' does not match its completion receipt (' +
      (diff.join(', ') || 'fields') + ')');
  }
  return { records: done.records, headers: done.headers, receipt: receipt };
}

function sourceOpenings(root) {
  const file = path.join(root || ROOT, SNAPSHOT_FILES.openingsSha256);
  return {
    list: require(file),
    sha256: sha256File(file),
    protocolSha256: sha256File(path.join(root || ROOT, SNAPSHOT_FILES.openingProtocolSha256))
  };
}

// The snapshot's Stockfish must answer UCI before a header is written; a
// TMPDIR mounted noexec, for example, fails here instead of mid-run.
function preflightStockfish(exe) {
  const r = cp.spawnSync(exe, [], { input: 'uci\nquit\n', encoding: 'utf8', timeout: 15000 });
  if (r.error || !/^uciok\s*$/m.test(r.stdout || '')) {
    throw new Error('the snapshot Stockfish ' + exe + ' did not start (' +
      (r.error ? r.error.code || r.error.message : 'no uciok') +
      '); TMPDIR must allow executing programs');
  }
}

// One exclusive, no-replace lock covers the NDJSON and its .runs sidecar from
// the resume read until the last append, so two runs cannot fill the same
// slots. A lock left by a killed run is never broken automatically.
function acquireLock(out) {
  const lockPath = out + '.lock';
  const token = process.pid + '@' + os.hostname() + ' ' +
    crypto.randomBytes(8).toString('hex') + '\n';
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(out + ' is locked (' + lockPath + '); delete that file only after ' +
      'confirming no runner is using this --out');
  }
  try {
    fs.writeSync(fd, token);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
    throw error;
  }
  fs.closeSync(fd);
  return {
    path: lockPath,
    release: function () {
      try {
        if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
      } catch (error) { /* already gone */ }
    }
  };
}

// One output has one lock path however it is spelled. A symbolic link that
// points nowhere is refused: its lock and sidecar would not follow its target.
function canonicalOut(out) {
  const resolved = path.resolve(out);
  let link = null;
  try {
    link = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (link) {
    if (link.isSymbolicLink() && !fs.existsSync(resolved)) {
      throw new Error('--out ' + out + ' is a dangling symbolic link');
    }
    return fs.realpathSync(resolved);
  }
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}

const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

async function runSchedule(argv) {
  const exe = arg(argv, 'stockfish');
  const level = arg(argv, 'level');
  const anchor = Number(arg(argv, 'anchor'));
  const outArg = arg(argv, 'out');
  const openings = arg(argv, 'openings', 'even');
  const concurrency = Number(arg(argv, 'concurrency', String(Math.max(1, os.cpus().length))));
  if (!exe || !LEVEL_IDS[level] || !Number.isInteger(anchor) || !outArg ||
      !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('usage: --stockfish <exe> --level <name> --anchor <elo> ' +
      '--openings <spec> --out <file> [--concurrency <n >= 1>]');
  }
  const out = canonicalOut(outArg);
  const lock = acquireLock(out);
  if (fs.existsSync(receiptPath(out))) {
    lock.release();
    throw new Error(out + ' is already sealed as complete; use a fresh --out');
  }
  const children = new Set();
  let snapshot = null;
  const killChildren = function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } });
  };
  // Idempotent, synchronous cleanup. The 'exit' hook also covers an uncaught
  // error that would otherwise skip the finally below.
  const cleanup = function () {
    killChildren();
    if (snapshot) snapshot.remove();
    lock.release();
  };
  const onSignal = function () {
    cleanup();
    process.exit(130);
  };
  STOP_SIGNALS.forEach(function (s) { process.once(s, onSignal); });
  process.on('exit', cleanup);
  try {
    snapshot = makeSnapshot(exe);
    preflightStockfish(snapshot.stockfish);
    const identity = runIdentity(snapshot.dir, snapshot.stockfish, level, anchor, openings,
      concurrency);
    // The schedule and preset come from the snapshot the games will load.
    const OPENINGS = require(path.join(snapshot.dir, SNAPSHOT_FILES.openingsSha256));
    const preset = require(path.join(snapshot.dir, SNAPSHOT_FILES.presetsSha256))
      .get(LEVEL_IDS[level]);
    const jobs = [];
    selectOpenings(openings, OPENINGS.length).forEach(function (id) {
      jobs.push({ openingId: id, chessyColor: 'white' });
      jobs.push({ openingId: id, chessyColor: 'black' });
    });
    const pending = checkResume(identity, preset, jobs, readRecords(out + '.runs'),
      readRecords(out));
    const meta = Object.assign({}, identity, {
      scheduledGames: jobs.length,
      alreadyRecorded: jobs.length - pending.length,
      node: process.version,
      cpu: (os.cpus()[0] || {}).model,
      commit: gitOutput(['rev-parse', 'HEAD']),
      dirty: gitOutput(['status', '--porcelain']) !== '',
      os: os.type() + ' ' + os.release() + ' ' + os.arch(),
      loadavg: os.loadavg()
    });
    fs.appendFileSync(out + '.runs', JSON.stringify(meta) + '\n');
    let next = 0;
    let finished = 0;
    let failed = null;
    const fail = function (error) {
      failed = failed || error;
      killChildren();
    };
    async function worker() {
      while (next < pending.length && !failed) {
        const job = pending[next++];
        const spec = Object.assign({ level: level, anchor: anchor,
          stockfish: snapshot.stockfish }, job);
        const record = await new Promise(function (resolve, reject) {
          const child = cp.fork(snapshot.runner, ['--game', JSON.stringify(spec)],
            { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
          children.add(child);
          let reply = null;
          let settled = false;
          const settle = function (fn, value) {
            if (settled) return;
            settled = true;
            children.delete(child);
            fn(value);
          };
          child.on('message', function (m) { reply = m; });
          child.on('error', function (error) {
            settle(reject, new Error('game worker could not run: ' + error.message));
          });
          child.on('exit', function (code, signal) {
            if (reply && reply.ok) settle(resolve, reply.record);
            else settle(reject, new Error('game worker failed: ' + (reply && reply.error) +
              ' code ' + code + (signal ? ' signal ' + signal : '')));
          });
        });
        if (failed) return;
        // The snapshot is private and read-only; refuse to record a game if it
        // was altered anyway.
        const diff = identityDiff(
          runIdentity(snapshot.dir, snapshot.stockfish, level, anchor, openings, concurrency),
          identity);
        if (diff.length) {
          throw new Error('the run snapshot changed (' + diff.join(', ') + '); game not recorded');
        }
        fs.appendFileSync(out, JSON.stringify(record) + '\n');
        finished++;
        process.stdout.write(level + '@' + anchor + ' ' + (meta.alreadyRecorded + finished) + '/' +
          jobs.length + ' op' + record.openingId + ' ' + record.chessyColor + ' ' +
          record.score + ' ' + record.reason + ' ' + record.plies + 'p\n');
      }
    }
    const pool = [];
    for (let i = 0; i < concurrency; i++) pool.push(worker().catch(fail));
    await Promise.all(pool);
    if (failed) throw failed;
    // Data first, then the completion receipt last.
    const openingsNow = sourceOpenings(snapshot.dir);
    sealBlock(out, openingsNow, 'runner');
    const records = verifySealed(out, openingsNow).records;
    console.log(JSON.stringify(summarize(records, { anchor: anchor }), null, 2));
  } finally {
    STOP_SIGNALS.forEach(function (s) { process.removeListener(s, onSignal); });
    process.removeListener('exit', cleanup);
    cleanup();
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--game') {
    playOne(JSON.parse(argv[1])).then(function (record) {
      process.send({ ok: true, record: record }, function () { process.exit(0); });
    }, function (error) {
      process.send({ ok: false, error: String(error && error.stack || error) },
        function () { process.exit(1); });
    });
  } else if (argv[0] === '--seal') {
    // Seal an already complete block (for example one recorded before
    // receipts existed). Refuses incomplete blocks and existing receipts.
    const openings = sourceOpenings();
    argv.slice(1).forEach(function (file) {
      const out = canonicalOut(file);
      const lock = acquireLock(out);
      try {
        const receipt = sealBlock(out, openings, 'seal-command');
        console.log(out + ': sealed ' + receipt.games + ' games');
      } finally {
        lock.release();
      }
    });
  } else if (argv[0] === '--summarize') {
    const openings = sourceOpenings();
    const files = argv.slice(1);
    files.forEach(function (file) {
      const sealed = verifySealed(file, openings);
      const records = sealed.records;
      const summary = summarize(records, { anchor: records[0].anchor });
      summary.sealedBy = sealed.receipt.sealedBy;
      summary.identityComplete = sealed.receipt.identityComplete;
      const reasons = {};
      records.forEach(function (r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      summary.reasons = reasons;
      summary.level = records[0].level;
      summary.anchor = records[0].anchor;
      console.log(JSON.stringify(summary, null, 2));
    });
  } else {
    runSchedule(argv).catch(function (error) {
      console.error(error && error.stack || error);
      process.exit(1);
    });
  }
}

module.exports = {
  SCHEMA: SCHEMA,
  LEVEL_IDS: LEVEL_IDS,
  DRAW_AT_PLIES: DRAW_AT_PLIES,
  ANCHOR_OPTIONS: ANCHOR_OPTIONS,
  ANCHOR_MOVETIME_MS: ANCHOR_MOVETIME_MS,
  uciOf: uciOf,
  openingLine: openingLine,
  legalFromUci: legalFromUci,
  chessyScore: chessyScore,
  selectOpenings: selectOpenings,
  eloFromScore: eloFromScore,
  summarize: summarize,
  SNAPSHOT_FILES: SNAPSHOT_FILES,
  RUN_IDENTITY_KEYS: RUN_IDENTITY_KEYS,
  runIdentity: runIdentity,
  makeSnapshot: makeSnapshot,
  canonicalOut: canonicalOut,
  readRecords: readRecords,
  completionOf: completionOf,
  sealBlock: sealBlock,
  verifySealed: verifySealed,
  receiptPath: receiptPath,
  sourceOpenings: sourceOpenings,
  checkResume: checkResume,
  validateBlock: validateBlock,
  acquireLock: acquireLock
};
