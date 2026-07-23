/*
 * eval-v1 corpus generator (E1) — run with: node test/eval/gen-corpus.js
 *
 * Regenerates the FROZEN, license-clean evaluation corpus committed under
 * eval/corpus/. This is a DEVELOPMENT/BUILD-TIME tool (it uses node:crypto);
 * it is never loaded by the browser app. It writes two files:
 *
 *   eval/corpus/eval-v1.ndjson  — one JSON record per line (the frozen cases)
 *   eval/corpus/manifest.json   — counts, split policy, shared analyse opts,
 *                                 generator version and a sha256 of the ndjson
 *
 * Every record carries the provenance schema from the eval-v1 tracker
 * (id, source_url, source_id, license, retrieval_date, source_sha, fen,
 * move_history?, phase, themes, rating_band, branching, split_group,
 * generator_version, seed?, assert). The `assert` block is the machine-checked
 * expectation the correctness scorecard verifies.
 *
 * SELF-VALIDATING: before writing, the generator replays every case through
 * the Chessy engine (and, for analyse-based asserts, the analysis contract)
 * using the SAME opts the scorecard uses. A case whose committed expectation
 * disagrees with the engine is a generation-time failure, not a silent bad
 * fixture — so the committed corpus is guaranteed self-consistent.
 *
 * LICENSE PROVENANCE
 *   - Opening positions are standard published opening theory (public-domain
 *     chess facts); classification names/ECO come from the CC0 lichess
 *     chess-openings project. The FEN is derived here by replaying the line
 *     through Chessy's own engine. Marked license "CC0-1.0".
 *   - Stateful/adversarial + endgame fixtures are ORIGINAL positions authored
 *     for this repository and validated by the engine. Marked license "MIT"
 *     (this repository's license) with source_id "chessy-eval-generator".
 *   No third-party game/puzzle databases are vendored (see eval/LICENSE-REPORT.md).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../../assets/engine.js');
require('../../assets/ai.js');
require('../../assets/analysis-core.js');
const Chess = globalThis.Chess;
const AC = globalThis.ChessyAnalysisCore;

const GENERATOR_VERSION = 'eval-v1.0.0';
const RETRIEVAL_DATE = '2026-07-23';           // corpus freeze date (constant, not wall-clock)
const OPENINGS_SOURCE = 'https://github.com/lichess-org/chess-openings'; // CC0-1.0
const GEN_SOURCE = 'https://github.com/den-run-ai/chessy';               // MIT
const SHARD_SIZE = 64;

// The analyse() options used for BOTH generation-time validation and the
// scorecard run. Recorded into the manifest so build/run parity is provable.
// Small, deterministic node budgets keep the frozen PR shard fast; correctness
// (legal PV, mate perspective, colour symmetry) holds at shallow depth.
const ANALYSE_OPTS = { nodeLimit: 3000, nodeBudget: 2000000, multiPV: 3, pvLen: 4, quiesce: true };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function sqName(i) { return Chess.sqName(i); }
function uciOf(m) { return sqName(m.from) + sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : ''); }

function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
  p[0] = p[0].split('/').reverse().map(r =>
    r.split('').map(c => /\d/.test(c) ? c : swap(c)).join('')).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] && p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] && p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}
function mirrorUci(u) { return u[0] + (9 - Number(u[1])) + u[2] + (9 - Number(u[3])) + u.slice(4); }
function flipResult(r) { return r === '1-0' ? '0-1' : r === '0-1' ? '1-0' : r; }

// Deterministic 70/15/15 train/val/test split by hashing the id (stable across
// runs/machines). Leakage rule: cases sharing a split_group base stay together;
// generated singletons hash independently.
function splitGroupOf(id) {
  const h = parseInt(sha256(id).slice(0, 8), 16) % 100;
  return h < 70 ? 'train' : h < 85 ? 'val' : 'test';
}

// ---------------------------------------------------------------------------
// engine-derived facts + assertion checkers (the generation-time oracle)
// ---------------------------------------------------------------------------
function stateOf(rec) {
  if (rec.move_history) return Chess.replaySans(rec.move_history);
  return Chess.newGameState(rec.fen);   // seeds the repetition table from the FEN
}
function branchingOf(state) { return Chess.legalMoves(state).length; }

function hasSpecial(state, kind) {
  const legal = Chess.legalMoves(state);
  switch (kind) {
    case 'enPassant': return legal.some(m => m.ep);
    case 'castleK': return legal.some(m => m.castle === 'K');
    case 'castleQ': return legal.some(m => m.castle === 'Q');
    case 'promotion': return legal.some(m => m.promotion);
    case 'promotionCapture': return legal.some(m => m.promotion && m.captured);
    default: throw new Error('unknown special ' + kind);
  }
}

// Validate one case's assert block against the live engine. Throws on mismatch.
function validate(rec) {
  const state = stateOf(rec);
  const a = rec.assert || {};
  const status = Chess.gameStatus(state);

  if (a.notTerminal && status.over) {
    throw new Error(rec.id + ': expected non-terminal, engine says over (' + status.reason + ')');
  }
  if (a.terminal) {
    if (!status.over) throw new Error(rec.id + ': expected terminal ' + a.terminal.reason + ', engine says live');
    if (status.reason !== a.terminal.reason) {
      throw new Error(rec.id + ': terminal reason ' + status.reason + ' != ' + a.terminal.reason);
    }
    if (a.terminal.result && status.result !== a.terminal.result) {
      throw new Error(rec.id + ': terminal result ' + status.result + ' != ' + a.terminal.result);
    }
  }
  if (a.special) {
    for (const [kind, want] of Object.entries(a.special)) {
      const got = hasSpecial(state, kind);
      if (got !== want) throw new Error(rec.id + ': special ' + kind + ' = ' + got + ', want ' + want);
    }
  }
  // analyse-based asserts (mate perspective, legal PV replay, symmetry, determinism)
  if (a.mate || a.pvReplay || a.symmetry || a.determinism) {
    const res = AC.analyse(state, ANALYSE_OPTS);
    if (a.mate) {
      if (!res.mate) throw new Error(rec.id + ': expected mate, analyse found none');
      if (res.mate.forWhite !== a.mate.forWhite || res.mate.inPlies !== a.mate.inPlies) {
        throw new Error(rec.id + ': mate ' + JSON.stringify(res.mate) + ' != ' + JSON.stringify(a.mate));
      }
    }
    if (a.pvReplay) replayPvs(rec.fen || Chess.toFen(state), res); // throws on illegal PV move
    if (a.symmetry) {
      const best = res.bestLines[0] ? res.bestLines[0].uci : '-';
      const mres = AC.analyse(Chess.newGameState(mirrorFen(rec.fen)), ANALYSE_OPTS);
      const mbest = mres.bestLines[0] ? mres.bestLines[0].uci : '-';
      if (mirrorUci(best) !== mbest) {
        throw new Error(rec.id + ': symmetry broke (' + best + ' -> ' + mirrorUci(best) + ' != ' + mbest + ')');
      }
    }
    if (a.determinism) {
      const res2 = AC.analyse(state, ANALYSE_OPTS);
      const k1 = JSON.stringify([res.bestLines[0], res.scoreCpWhite]);
      const k2 = JSON.stringify([res2.bestLines[0], res2.scoreCpWhite]);
      if (k1 !== k2) throw new Error(rec.id + ': analyse not deterministic');
    }
  }
}

// Replay every reported PV from the given FEN, asserting each move is legal in
// the position it is played from. This is the analysis contract's core promise.
function replayPvs(fen, res) {
  for (const line of res.bestLines) {
    let s = Chess.newGameState(fen);
    for (const u of (line.pvUci || [])) {
      const legal = Chess.legalMoves(s);
      const m = legal.find(mv => uciOf(mv) === u);
      if (!m) throw new Error('illegal PV move ' + u + ' in ' + Chess.toFen(s));
      s = Chess.applyMove(s, m);
    }
  }
}

// ---------------------------------------------------------------------------
// case authoring
// ---------------------------------------------------------------------------
// Opening theory (standard published lines; names per CC0 lichess
// chess-openings). FEN derived by replaying the SAN line through the engine.
const OPENING_LINES = [
  ['Italian Game', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Two Knights Defense', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['Ruy Lopez Morphy', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6'],
  ['Ruy Lopez Berlin', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Scotch Game', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4'],
  ['Four Knights', 'e4 e5 Nf3 Nc6 Nc3 Nf6'],
  ['Petrov Defense', 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4'],
  ['Philidor Defense', 'e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6'],
  ['Vienna Game', 'e4 e5 Nc3 Nf6 Bc4 Nc6'],
  ["King's Gambit Accepted", 'e4 e5 f4 exf4 Nf3 g5'],
  ['Sicilian Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Sicilian Dragon', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'],
  ['Sicilian Scheveningen', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6'],
  ['Sicilian Taimanov', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6'],
  ['Sicilian Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5'],
  ['Sicilian Rossolimo', 'e4 c5 Nf3 Nc6 Bb5 g6'],
  ['Sicilian Alapin', 'e4 c5 c3 Nf6 e5 Nd5'],
  ['French Winawer', 'e4 e6 d4 d5 Nc3 Bb4'],
  ['French Classical', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['French Tarrasch', 'e4 e6 d4 d5 Nd2 Nf6'],
  ['Caro-Kann Classical', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Caro-Kann Advance', 'e4 c6 d4 d5 e5 Bf5'],
  ['Scandinavian Defense', 'e4 d5 exd5 Qxd5 Nc3 Qa5'],
  ['Pirc Defense', 'e4 d6 d4 Nf6 Nc3 g6'],
  ["Queen's Gambit Declined", 'd4 d5 c4 e6 Nc3 Nf6'],
  ["Queen's Gambit Accepted", 'd4 d5 c4 dxc4 Nf3 Nf6'],
  ['Slav Defense', 'd4 d5 c4 c6 Nf3 Nf6'],
  ['Nimzo-Indian', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ["King's Indian Defense", 'd4 Nf6 c4 g6 Nc3 Bg7'],
  ['Grunfeld Defense', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['English Opening', 'c4 e5 Nc3 Nf6 Nf3 Nc6'],
  ['Reti Opening', 'Nf3 d5 c4 e6 g3 Nf6']
];

function openingCase(name, line) {
  const sans = line.split(' ');
  const state = Chess.replaySans(sans);
  const fen = Chess.toFen(state);
  const id = 'open-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return {
    id: id,
    source_url: OPENINGS_SOURCE,
    source_id: name,
    license: 'CC0-1.0',
    retrieval_date: RETRIEVAL_DATE,
    source_sha: sha256(line),
    fen: fen,
    move_history: sans,
    phase: 'opening',
    themes: ['opening'],
    rating_band: null,
    branching: branchingOf(state),
    split_group: splitGroupOf(id),
    generator_version: GENERATOR_VERSION,
    seed: null,
    core: false,
    assert: { notTerminal: true }
  };
}

// Generated fixture: [id, fen, phase, themes, assert, {mirror?, move_history?}]
const GEN_CASES = [
  // --- en passant ------------------------------------------------------------
  ['ep-white-open', 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3',
    'opening', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-black-open', 'rnbqkbnr/1ppppppp/8/8/pP6/8/P1PPPPPP/RNBQKBNR b KQkq b3 0 2',
    'opening', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-white-endgame', '4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1',
    'endgame', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-black-endgame', '4k3/8/8/8/2Pp4/8/8/4K3 b - c3 0 1',
    'endgame', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],

  // --- castling rights -------------------------------------------------------
  ['castle-both-white', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
    'middlegame', ['castling'], { special: { castleK: true, castleQ: true }, notTerminal: true }],
  ['castle-both-black', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1',
    'middlegame', ['castling'], { special: { castleK: true, castleQ: true }, notTerminal: true }],
  // Kingside blocked through check (Bf2->? rook on f2 attacks f1): O-O illegal, O-O-O legal.
  ['castle-through-check', 'r3k3/8/8/8/8/8/5r2/R3K2R w KQq - 0 1',
    'middlegame', ['castling', 'restraint'],
    { special: { castleK: false, castleQ: true }, notTerminal: true }],
  // Queenside only right present.
  ['castle-queenside-only', 'r3k3/pppppppp/8/8/8/8/PPPPPPPP/R3K3 w Qq - 0 1',
    'middlegame', ['castling'], { special: { castleK: false, castleQ: true }, notTerminal: true }],
  // No rights at all: no castle move.
  ['castle-none', '4k3/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1',
    'middlegame', ['castling', 'restraint'],
    { special: { castleK: false, castleQ: false }, notTerminal: true }],

  // --- promotion -------------------------------------------------------------
  ['promo-push', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
    'endgame', ['promotion'], { special: { promotion: true }, notTerminal: true }],
  ['promo-capture', '3r1k2/4P3/8/8/8/8/8/4K3 w - - 0 1',
    'endgame', ['promotion'], { special: { promotion: true, promotionCapture: true }, notTerminal: true }],
  ['promo-underpromo-fork', '8/2q1P1k1/8/8/8/8/P7/4K3 w - - 0 1',
    'endgame', ['promotion', 'underpromotion'], { special: { promotion: true }, notTerminal: true }],
  ['promo-black', '4k3/8/8/8/8/8/7p/4K3 b - - 0 1',
    'endgame', ['promotion'], { special: { promotion: true }, notTerminal: true }],

  // --- stalemate (terminal, side to move stalemated) -------------------------
  ['stalemate-qf7', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    'endgame', ['stalemate'], { terminal: { reason: 'stalemate', result: '1/2-1/2' } }, { mirror: true }],
  ['stalemate-qb6', 'k7/8/1Q6/8/8/8/8/K7 b - - 0 1',
    'endgame', ['stalemate'], { terminal: { reason: 'stalemate', result: '1/2-1/2' } }, { mirror: true }],

  // --- checkmate (terminal, already mated) -----------------------------------
  ['mate-fools', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    'opening', ['checkmate'], { terminal: { reason: 'checkmate', result: '0-1' } }],
  ['mate-backrank-done', 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1',
    'middlegame', ['checkmate', 'back-rank'], { terminal: { reason: 'checkmate', result: '1-0' } }],
  ['mate-scholars', 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
    'opening', ['checkmate'], { terminal: { reason: 'checkmate', result: '1-0' } }],

  // --- mate-in-1 (live; analyse must report the mate score + perspective) ----
  ['matein1-backrank', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    'middlegame', ['mate-in-1', 'back-rank'],
    { mate: { forWhite: true, inPlies: 1 }, pvReplay: true, symmetry: true, determinism: true },
    { mirror: true }],
  ['matein1-kr', '3k4/8/3K4/8/8/8/8/7R w - - 0 1',
    'endgame', ['mate-in-1'],
    { mate: { forWhite: true, inPlies: 1 }, pvReplay: true, symmetry: true, determinism: true },
    { mirror: true }],

  // --- fifty-move boundary ---------------------------------------------------
  ['fifty-at-99', '4k3/8/8/8/8/8/8/R3K3 w - - 99 200',
    'endgame', ['fifty-move'], { notTerminal: true }],
  ['fifty-at-100', '4k3/8/8/8/8/8/8/R3K3 w - - 100 200',
    'endgame', ['fifty-move'], { terminal: { reason: 'fifty-move rule', result: '1/2-1/2' } }],
  ['fifty-at-100-black', '4k3/8/8/8/8/8/8/R3K3 b - - 100 200',
    'endgame', ['fifty-move'], { terminal: { reason: 'fifty-move rule', result: '1/2-1/2' } }],

  // --- threefold repetition (move_history from the start) --------------------
  ['threefold-knight-shuffle', null, 'opening', ['threefold', 'repetition'],
    { terminal: { reason: 'threefold repetition', result: '1/2-1/2' } },
    { move_history: ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'] }],
  ['threefold-queenside-knights', null, 'opening', ['threefold', 'repetition'],
    { terminal: { reason: 'threefold repetition', result: '1/2-1/2' } },
    { move_history: ['Nc3', 'Nc6', 'Nb1', 'Nb8', 'Nc3', 'Nc6', 'Nb1', 'Nb8'] }],

  // --- insufficient material / dead position ---------------------------------
  ['insufficient-kk', '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    'endgame', ['insufficient-material', 'dead-position'],
    { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],
  ['insufficient-kbk', '4k3/8/8/8/8/8/5B2/4K3 w - - 0 1',
    'endgame', ['insufficient-material', 'dead-position'],
    { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],
  ['insufficient-knk', '4k3/8/8/8/8/8/5N2/4K3 w - - 0 1',
    'endgame', ['insufficient-material', 'dead-position'],
    { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],

  // --- endgame legality (large branching / long-range pieces) ----------------
  ['endgame-kpk-live', '4k3/8/3K4/4P3/8/8/8/8 w - - 0 1',
    'endgame', ['kpk'], { notTerminal: true }],
  ['endgame-lucena-live', '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1',
    'endgame', ['rook-endgame'], { notTerminal: true }]
];

function genCase(spec) {
  const [id, fen, phase, themes, assert, extra] = spec;
  const ex = extra || {};
  const rec = {
    id: 'gen-' + id,
    source_url: GEN_SOURCE,
    source_id: 'chessy-eval-generator',
    license: 'MIT',
    retrieval_date: RETRIEVAL_DATE,
    source_sha: sha256((fen || '') + '|' + (ex.move_history ? ex.move_history.join(' ') : '')),
    fen: fen,
    move_history: ex.move_history || undefined,
    phase: phase,
    themes: themes,
    rating_band: null,
    branching: 0, // filled below
    split_group: splitGroupOf('gen-' + id),
    generator_version: GENERATOR_VERSION,
    seed: null,
    core: true,
    assert: assert
  };
  if (rec.fen === null) delete rec.fen;
  rec.branching = branchingOf(stateOf(rec));
  return rec;
}

// Mirror a FEN-based generated case into its colour-swapped twin (keeps the
// engine honest about colour symmetry; results/mate perspective flip).
function mirrorCase(rec) {
  const a = rec.assert;
  const ma = {};
  if (a.notTerminal) ma.notTerminal = true;
  if (a.terminal) ma.terminal = { reason: a.terminal.reason, result: flipResult(a.terminal.result) };
  if (a.special) ma.special = Object.assign({}, a.special);
  if (a.mate) ma.mate = { forWhite: !a.mate.forWhite, inPlies: a.mate.inPlies };
  if (a.pvReplay) ma.pvReplay = true;
  if (a.symmetry) ma.symmetry = true;
  if (a.determinism) ma.determinism = true;
  const fen = mirrorFen(rec.fen);
  const twin = Object.assign({}, rec, {
    id: rec.id + '-mir',
    fen: fen,
    source_sha: sha256(fen + '|'),
    split_group: splitGroupOf(rec.id + '-mir'),
    assert: ma
  });
  twin.branching = branchingOf(Chess.newGameState(fen));
  return twin;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
function build() {
  const records = [];
  for (const [name, line] of OPENING_LINES) records.push(openingCase(name, line));
  for (const spec of GEN_CASES) {
    const rec = genCase(spec);
    records.push(rec);
    if (spec[5] && spec[5].mirror) records.push(mirrorCase(rec));
  }

  // Validate EVERY case against the engine (throws on any mismatch).
  const ids = new Set();
  for (const rec of records) {
    if (ids.has(rec.id)) throw new Error('duplicate id ' + rec.id);
    ids.add(rec.id);
    validate(rec);
  }

  // Frozen PR shard: all correctness-critical generated cases, then fill to
  // exactly SHARD_SIZE with openings (sorted by id for stability).
  const core = records.filter(r => r.core).sort((a, b) => a.id < b.id ? -1 : 1);
  const openings = records.filter(r => !r.core).sort((a, b) => a.id < b.id ? -1 : 1);
  if (core.length > SHARD_SIZE) throw new Error('core cases (' + core.length + ') exceed shard size ' + SHARD_SIZE);
  const fill = SHARD_SIZE - core.length;
  if (fill > openings.length) throw new Error('not enough openings to fill the ' + SHARD_SIZE + '-case shard');
  const shardIds = new Set(core.concat(openings.slice(0, fill)).map(r => r.id));
  for (const rec of records) rec.shard = shardIds.has(rec.id);
  if (records.filter(r => r.shard).length !== SHARD_SIZE) throw new Error('shard size mismatch');

  return records;
}

function write(records) {
  const outDir = path.join(__dirname, '..', '..', 'eval', 'corpus');
  fs.mkdirSync(outDir, { recursive: true });

  // Stable key order per record for a deterministic diff-friendly ndjson.
  const KEY_ORDER = ['id', 'source_url', 'source_id', 'license', 'retrieval_date', 'source_sha',
    'fen', 'move_history', 'phase', 'themes', 'rating_band', 'branching', 'split_group',
    'generator_version', 'seed', 'core', 'shard', 'assert'];
  const ordered = r => {
    const o = {};
    for (const k of KEY_ORDER) if (r[k] !== undefined) o[k] = r[k];
    return o;
  };
  const ndjson = records.map(r => JSON.stringify(ordered(r))).join('\n') + '\n';
  const ndPath = path.join(outDir, 'eval-v1.ndjson');
  fs.writeFileSync(ndPath, ndjson);

  const byCat = {};
  for (const r of records) {
    const cat = r.core ? (r.themes[0] || 'generated') : 'opening';
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  const bySplit = { train: 0, val: 0, test: 0 };
  for (const r of records) bySplit[r.split_group]++;

  const manifest = {
    corpus: 'eval-v1',
    generator_version: GENERATOR_VERSION,
    retrieval_date: RETRIEVAL_DATE,
    total: records.length,
    shard_size: records.filter(r => r.shard).length,
    counts_by_category: byCat,
    counts_by_split: bySplit,
    split_policy: '70/15/15 train/val/test by stable id hash; never tune on the test split',
    analyse_opts: ANALYSE_OPTS,
    ndjson: 'eval-v1.ndjson',
    ndjson_sha256: sha256(ndjson),
    licenses: {
      'CC0-1.0': 'Opening theory positions (names/ECO from lichess chess-openings, CC0); FEN derived by replaying the line through the Chessy engine.',
      'MIT': 'Original stateful/adversarial + endgame fixtures authored for this repository (chessy-eval-generator), validated by the engine.'
    },
    schema: KEY_ORDER,
    note: 'Frozen, license-clean. No third-party game/puzzle databases vendored. See eval/LICENSE-REPORT.md.'
  };
  const mPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + '\n');

  return { ndPath, mPath, manifest };
}

const records = build();
const { ndPath, mPath, manifest } = write(records);
console.log('eval-v1 corpus generated and validated:');
console.log('  cases:      ' + manifest.total + ' (shard ' + manifest.shard_size + ')');
console.log('  by split:   ' + JSON.stringify(manifest.counts_by_split));
console.log('  by category:' + JSON.stringify(manifest.counts_by_category));
console.log('  ndjson:     ' + path.relative(process.cwd(), ndPath) + ' (sha256 ' + manifest.ndjson_sha256.slice(0, 12) + '…)');
console.log('  manifest:   ' + path.relative(process.cwd(), mPath));
