/*
 * eval-v1 corpus generator (E1, OFFLINE) — run with: node test/eval/gen-corpus.js
 *
 * DETERMINISTIC and OFFLINE: derives the frozen corpus from the committed raw
 * CC0 sources (eval/corpus/sources/, produced online by test/eval/fetch-corpus.js)
 * plus engine-generated stateful/adversarial fixtures. PR CI reproduces this with
 * no network. Writes:
 *
 *   eval/corpus/eval-v1.ndjson  — one JSON record per line (the frozen cases)
 *   eval/corpus/manifest.json   — counts, split policy, shared analyse opts,
 *                                 generator version, sha256 of the ndjson
 *
 * Every record carries the provenance schema from the eval-v1 tracker. The
 * `assert` block is the machine-checked expectation the correctness scorecard
 * verifies.
 *
 * SELF-VALIDATING: every case is replayed through the engine (and, for
 * analyse-based asserts, the analysis contract) with the SAME opts the scorecard
 * uses, so a bad fixture fails generation instead of shipping silently. Source
 * files are sha256-checked against sources/PROVENANCE.json first.
 *
 * LICENSE PROVENANCE (see eval/LICENSE-REPORT.md)
 *   - CC0-1.0: Lichess Open Database puzzles + lichess chess-openings (both CC0),
 *     committed as a small frozen sample under sources/.
 *   - MIT: original stateful/adversarial + endgame fixtures authored here
 *     (source_id "chessy-eval-generator"), validated by the engine.
 *   No third-party database is vendored beyond the compact committed samples.
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
const GEN_SOURCE = 'https://github.com/den-run-ai/chessy';
const SHARD_SIZE = 64;
const SRC_DIR = path.join(__dirname, '..', '..', 'eval', 'corpus', 'sources');

// analyse() options for BOTH generation-time validation and the scorecard.
// Recorded into the manifest so build/run parity is provable.
const ANALYSE_OPTS = { nodeLimit: 3000, nodeBudget: 2000000, multiPV: 3, pvLen: 4, quiesce: true };

const RATING_BANDS = [['<1000', 0, 999], ['1000-1399', 1000, 1399], ['1400-1799', 1400, 1799],
  ['1800-2199', 1800, 2199], ['2200+', 2200, Infinity]];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function uciOf(m) { return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : ''); }
function findUci(state, uci) { return Chess.legalMoves(state).find(m => uciOf(m) === uci) || null; }

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
function bandOf(rating) { const b = RATING_BANDS.find(x => rating >= x[1] && rating <= x[2]); return b ? b[0] : null; }
function splitGroupOf(key) {
  const h = parseInt(sha256(key).slice(0, 8), 16) % 100;
  return h < 70 ? 'train' : h < 85 ? 'val' : 'test';
}

function loadProvenance() {
  const prov = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'PROVENANCE.json'), 'utf8'));
  for (const [file, meta] of Object.entries(prov.sources)) {
    const raw = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    if (sha256(raw) !== meta.sha256) {
      throw new Error('source ' + file + ' sha256 != PROVENANCE.json — re-run test/eval/fetch-corpus.js');
    }
  }
  return prov;
}

// ---------------------------------------------------------------------------
// engine oracle + assertion checkers
// ---------------------------------------------------------------------------
function stateOf(rec) { return rec.move_history ? Chess.replaySans(rec.move_history) : Chess.newGameState(rec.fen); }
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

function validate(rec) {
  const state = stateOf(rec);
  const a = rec.assert || {};
  const status = Chess.gameStatus(state);
  if (a.notTerminal && status.over) throw new Error(rec.id + ': expected live, engine over (' + status.reason + ')');
  if (a.terminal) {
    if (!status.over) throw new Error(rec.id + ': expected terminal ' + a.terminal.reason + ', engine live');
    if (status.reason !== a.terminal.reason) throw new Error(rec.id + ': reason ' + status.reason + ' != ' + a.terminal.reason);
    if (a.terminal.result && status.result !== a.terminal.result) throw new Error(rec.id + ': result ' + status.result + ' != ' + a.terminal.result);
  }
  if (a.special) for (const [kind, want] of Object.entries(a.special)) {
    if (hasSpecial(state, kind) !== want) throw new Error(rec.id + ': special ' + kind + ' != ' + want);
  }
  if (a.expectedLegal) for (const u of rec.expected_moves) {
    if (!findUci(state, u)) throw new Error(rec.id + ': labelled move ' + u + ' is not legal');
  }
  if (a.mate || a.pvReplay || a.symmetry || a.determinism) {
    const res = AC.analyse(state, ANALYSE_OPTS);
    if (a.mate) {
      if (!res.mate || res.mate.forWhite !== a.mate.forWhite || res.mate.inPlies !== a.mate.inPlies) {
        throw new Error(rec.id + ': mate ' + JSON.stringify(res.mate) + ' != ' + JSON.stringify(a.mate));
      }
    }
    if (a.pvReplay) replayPvs(rec.fen || Chess.toFen(state), res);
    if (a.symmetry) {
      const best = res.bestLines[0] ? res.bestLines[0].uci : '-';
      const mres = AC.analyse(Chess.newGameState(mirrorFen(rec.fen)), ANALYSE_OPTS);
      const mbest = mres.bestLines[0] ? mres.bestLines[0].uci : '-';
      if (mirrorUci(best) !== mbest) throw new Error(rec.id + ': symmetry broke (' + best + ' -> ' + mbest + ')');
    }
    if (a.determinism) {
      if (analysisSignature(res) !== analysisSignature(AC.analyse(state, ANALYSE_OPTS))) {
        throw new Error(rec.id + ': analyse not deterministic');
      }
    }
  }
}
// Full analysis signature (every stable field, excluding only elapsedMs) — the
// same determinism signature the scorecard uses.
function analysisSignature(res) { const c = Object.assign({}, res); delete c.elapsedMs; return JSON.stringify(c); }
function replayPvs(fen, res) {
  for (const line of res.bestLines) {
    let s = Chess.newGameState(fen);
    for (const u of (line.pvUci || [])) {
      const m = Chess.legalMoves(s).find(mv => uciOf(mv) === u);
      if (!m) throw new Error('illegal PV move ' + u + ' in ' + Chess.toFen(s));
      s = Chess.applyMove(s, m);
    }
  }
}

// ---------------------------------------------------------------------------
// 1) openings from the committed CC0 lichess chess-openings sample
// ---------------------------------------------------------------------------
function sansOf(pgn) { return pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/).filter(Boolean); }

function buildOpenings(prov) {
  const tsv = fs.readFileSync(path.join(SRC_DIR, 'openings-v1.tsv'), 'utf8');
  const rows = tsv.split('\n').slice(1).filter(Boolean).map(l => l.split('\t'));
  const out = [], seenFen = new Set();
  let skipped = 0;
  for (const [eco, name, pgn] of rows) {
    let state, fen;
    try { state = Chess.replaySans(sansOf(pgn)); fen = Chess.toFen(state); }  // notation edge cases → skip deterministically
    catch (e) { skipped++; continue; }
    const fen4 = fen.split(' ').slice(0, 4).join(' ');
    if (Chess.gameStatus(state).over || seenFen.has(fen4)) { skipped++; continue; }
    seenFen.add(fen4);
    const id = 'open-' + eco.toLowerCase() + '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
    out.push({
      id: id, source_url: prov.sources['openings-v1.tsv'].source_url, source_id: eco + ' ' + name,
      license: 'CC0-1.0', retrieval_date: prov.retrieval_date, source_sha: sha256(eco + '\t' + name + '\t' + pgn),
      fen: fen, move_history: sansOf(pgn), phase: 'opening', themes: ['opening', 'eco-' + eco[0].toLowerCase()],
      rating_band: null, branching: branchingOf(state), split_group: splitGroupOf(id),
      generator_version: GENERATOR_VERSION, seed: null, core: false,
      assert: { notTerminal: true }
    });
  }
  if (out.length < 20) throw new Error('too few usable openings (' + out.length + ', skipped ' + skipped + ')');
  return out;
}

// ---------------------------------------------------------------------------
// 2) puzzles from the committed CC0 Lichess Open Database sample
// ---------------------------------------------------------------------------
// Lichess convention: FEN precedes the opponent's SETUP move (Moves[0]); after
// it, the solver is to move and Moves[1] is the key move. We store the position
// AFTER the setup move as `fen`, keep the key move as the labelled expectation,
// and record source_fen/setup_move for reproducibility.
function buildPuzzles(prov) {
  const csv = fs.readFileSync(path.join(SRC_DIR, 'lichess-puzzles-v1.csv'), 'utf8');
  const rows = csv.split('\n').slice(1).filter(Boolean);
  const out = [];
  let skipped = 0;
  for (const line of rows) {
    const f = line.split(',');
    if (f.length < 9) { skipped++; continue; }
    const [pid, srcFen, movesStr, ratingStr, , , , themesStr, gameUrl] = f;
    const moves = movesStr.split(' ');
    const rating = Number(ratingStr);
    if (moves.length < 2 || !Number.isFinite(rating)) { skipped++; continue; }
    let st0, setup, st1, key;
    try {
      st0 = Chess.newGameState(srcFen);
      setup = findUci(st0, moves[0]);
      if (!setup) { skipped++; continue; }
      st1 = Chess.applyMove(st0, setup);
      key = findUci(st1, moves[1]);
      if (!key || Chess.gameStatus(st1).over) { skipped++; continue; }
    } catch (e) { skipped++; continue; }
    const themes = themesStr ? themesStr.split(' ') : [];
    const phase = themes.includes('opening') ? 'opening' : themes.includes('endgame') ? 'endgame' : 'middlegame';
    // split-before-extract: keep same-game puzzles together via the game id.
    // Lichess URLs may be side-qualified (/GAMEID/black#ply): take the segment
    // BEFORE a trailing white/black, not the side word itself.
    const segs = gameUrl.split('#')[0].split('/').filter(Boolean);
    let last = segs.pop();
    if ((last === 'white' || last === 'black') && segs.length) last = segs.pop();
    const gameId = last || pid;
    const id = 'puzzle-' + pid;
    out.push({
      id: id, source_url: prov.sources['lichess-puzzles-v1.csv'].source_url, source_id: pid,
      license: 'CC0-1.0', retrieval_date: prov.retrieval_date, source_sha: sha256(line),
      fen: Chess.toFen(st1), source_fen: srcFen, setup_move: moves[0], expected_moves: [moves[1]],
      phase: phase, themes: themes, rating_band: bandOf(rating), branching: branchingOf(st1),
      split_group: splitGroupOf('game:' + gameId), generator_version: GENERATOR_VERSION, seed: null, core: false,
      assert: { notTerminal: true, expectedLegal: true }
    });
  }
  if (out.length < 20) throw new Error('too few usable puzzles (' + out.length + ', skipped ' + skipped + ')');
  return out;
}

// ---------------------------------------------------------------------------
// 3) engine-generated stateful/adversarial + endgame fixtures (original, MIT)
// ---------------------------------------------------------------------------
const GEN_CASES = [
  ['ep-white-open', 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', 'opening', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-black-open', 'rnbqkbnr/1ppppppp/8/8/pP6/8/P1PPPPPP/RNBQKBNR b KQkq b3 0 2', 'opening', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-white-endgame', '4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1', 'endgame', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],
  ['ep-black-endgame', '4k3/8/8/8/2Pp4/8/8/4K3 b - c3 0 1', 'endgame', ['en-passant'], { special: { enPassant: true }, notTerminal: true }],

  ['castle-both-white', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'middlegame', ['castling'], { special: { castleK: true, castleQ: true }, notTerminal: true }],
  ['castle-both-black', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1', 'middlegame', ['castling'], { special: { castleK: true, castleQ: true }, notTerminal: true }],
  ['castle-through-check', 'r3k3/8/8/8/8/8/5r2/R3K2R w KQq - 0 1', 'middlegame', ['castling', 'restraint'], { special: { castleK: false, castleQ: true }, notTerminal: true }],
  ['castle-queenside-only', 'r3k3/pppppppp/8/8/8/8/PPPPPPPP/R3K3 w Qq - 0 1', 'middlegame', ['castling'], { special: { castleK: false, castleQ: true }, notTerminal: true }],
  ['castle-none', '4k3/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1', 'middlegame', ['castling', 'restraint'], { special: { castleK: false, castleQ: false }, notTerminal: true }],

  ['promo-push', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'endgame', ['promotion'], { special: { promotion: true }, notTerminal: true }],
  ['promo-capture', '3r1k2/4P3/8/8/8/8/8/4K3 w - - 0 1', 'endgame', ['promotion'], { special: { promotion: true, promotionCapture: true }, notTerminal: true }],
  ['promo-underpromo-fork', '8/2q1P1k1/8/8/8/8/P7/4K3 w - - 0 1', 'endgame', ['promotion', 'underpromotion'], { special: { promotion: true }, notTerminal: true }],
  ['promo-black', '4k3/8/8/8/8/8/7p/4K3 b - - 0 1', 'endgame', ['promotion'], { special: { promotion: true }, notTerminal: true }],

  ['stalemate-qf7', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'endgame', ['stalemate'], { terminal: { reason: 'stalemate', result: '1/2-1/2' } }, { mirror: true }],
  ['stalemate-qb6', 'k7/8/1Q6/8/8/8/8/K7 b - - 0 1', 'endgame', ['stalemate'], { terminal: { reason: 'stalemate', result: '1/2-1/2' } }, { mirror: true }],

  ['mate-fools', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 'opening', ['checkmate'], { terminal: { reason: 'checkmate', result: '0-1' } }],
  ['mate-backrank-done', 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1', 'middlegame', ['checkmate', 'back-rank'], { terminal: { reason: 'checkmate', result: '1-0' } }],
  ['mate-scholars', 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4', 'opening', ['checkmate'], { terminal: { reason: 'checkmate', result: '1-0' } }],

  ['matein1-backrank', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'middlegame', ['mate-in-1', 'back-rank'], { mate: { forWhite: true, inPlies: 1 }, pvReplay: true, symmetry: true, determinism: true }, { mirror: true }],
  ['matein1-kr', '3k4/8/3K4/8/8/8/8/7R w - - 0 1', 'endgame', ['mate-in-1'], { mate: { forWhite: true, inPlies: 1 }, pvReplay: true, symmetry: true, determinism: true }, { mirror: true }],

  ['fifty-at-99', '4k3/8/8/8/8/8/8/R3K3 w - - 99 200', 'endgame', ['fifty-move'], { notTerminal: true }],
  ['fifty-at-100', '4k3/8/8/8/8/8/8/R3K3 w - - 100 200', 'endgame', ['fifty-move'], { terminal: { reason: 'fifty-move rule', result: '1/2-1/2' } }],
  ['fifty-at-100-black', '4k3/8/8/8/8/8/8/R3K3 b - - 100 200', 'endgame', ['fifty-move'], { terminal: { reason: 'fifty-move rule', result: '1/2-1/2' } }],

  ['threefold-knight-shuffle', null, 'opening', ['threefold', 'repetition'], { terminal: { reason: 'threefold repetition', result: '1/2-1/2' } }, { move_history: ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'] }],
  ['threefold-queenside-knights', null, 'opening', ['threefold', 'repetition'], { terminal: { reason: 'threefold repetition', result: '1/2-1/2' } }, { move_history: ['Nc3', 'Nc6', 'Nb1', 'Nb8', 'Nc3', 'Nc6', 'Nb1', 'Nb8'] }],

  ['insufficient-kk', '4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'endgame', ['insufficient-material', 'dead-position'], { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],
  ['insufficient-kbk', '4k3/8/8/8/8/8/5B2/4K3 w - - 0 1', 'endgame', ['insufficient-material', 'dead-position'], { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],
  ['insufficient-knk', '4k3/8/8/8/8/8/5N2/4K3 w - - 0 1', 'endgame', ['insufficient-material', 'dead-position'], { terminal: { reason: 'insufficient material', result: '1/2-1/2' } }],

  ['endgame-kpk-live', '4k3/8/3K4/4P3/8/8/8/8 w - - 0 1', 'endgame', ['kpk'], { notTerminal: true }],
  ['endgame-lucena-live', '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1', 'endgame', ['rook-endgame'], { notTerminal: true }]
];

function genCase(spec) {
  const [id, fen, phase, themes, assert, extra] = spec;
  const ex = extra || {};
  const rec = {
    id: 'gen-' + id, source_url: GEN_SOURCE, source_id: 'chessy-eval-generator', license: 'MIT',
    retrieval_date: null, source_sha: sha256((fen || '') + '|' + (ex.move_history ? ex.move_history.join(' ') : '')),
    fen: fen, move_history: ex.move_history || undefined, phase: phase, themes: themes,
    rating_band: null, branching: 0, split_group: splitGroupOf('gen-' + id),
    generator_version: GENERATOR_VERSION, seed: null, core: true, assert: assert
  };
  if (rec.fen === null) delete rec.fen;
  rec.branching = branchingOf(stateOf(rec));
  return rec;
}
function mirrorCase(rec) {
  const a = rec.assert, ma = {};
  if (a.notTerminal) ma.notTerminal = true;
  if (a.terminal) ma.terminal = { reason: a.terminal.reason, result: flipResult(a.terminal.result) };
  if (a.special) ma.special = Object.assign({}, a.special);
  if (a.mate) ma.mate = { forWhite: !a.mate.forWhite, inPlies: a.mate.inPlies };
  if (a.pvReplay) ma.pvReplay = true;
  if (a.symmetry) ma.symmetry = true;
  if (a.determinism) ma.determinism = true;
  const fen = mirrorFen(rec.fen);
  const twin = Object.assign({}, rec, { id: rec.id + '-mir', fen: fen, source_sha: sha256(fen + '|'), split_group: splitGroupOf(rec.id + '-mir'), assert: ma });
  twin.branching = branchingOf(Chess.newGameState(fen));
  return twin;
}
function buildGenerated() {
  const out = [];
  for (const spec of GEN_CASES) {
    const rec = genCase(spec);
    out.push(rec);
    if (spec[5] && spec[5].mirror) out.push(mirrorCase(rec));
  }
  return out;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
function build() {
  const prov = loadProvenance();
  const openings = buildOpenings(prov);
  const puzzles = buildPuzzles(prov);
  const generated = buildGenerated();
  const records = generated.concat(openings, puzzles);

  const ids = new Set();
  for (const rec of records) {
    if (ids.has(rec.id)) throw new Error('duplicate id ' + rec.id);
    ids.add(rec.id);
    validate(rec);
  }

  // Frozen PR shard: all correctness-critical generated cases, then fill to
  // exactly SHARD_SIZE with the CC0 sample (sorted by id for stability).
  const core = records.filter(r => r.core).sort((a, b) => a.id < b.id ? -1 : 1);
  const sortId = (a, b) => a.id < b.id ? -1 : 1;
  const shardOpenings = records.filter(r => !r.core && r.id.startsWith('open-')).sort(sortId);
  const shardPuzzles = records.filter(r => !r.core && r.id.startsWith('puzzle-')).sort(sortId);
  if (core.length > SHARD_SIZE) throw new Error('core cases exceed shard size');
  // Interleave openings and puzzles so the frozen shard exercises both CC0
  // categories (and the expectedLegal axis) in PR CI, not just openings.
  const fill = [], need = SHARD_SIZE - core.length;
  for (let i = 0, j = 0; fill.length < need && (i < shardOpenings.length || j < shardPuzzles.length);) {
    if (i < shardOpenings.length && fill.length < need) fill.push(shardOpenings[i++]);
    if (j < shardPuzzles.length && fill.length < need) fill.push(shardPuzzles[j++]);
  }
  const shardIds = new Set(core.concat(fill).map(r => r.id));
  for (const rec of records) rec.shard = shardIds.has(rec.id);
  if (records.filter(r => r.shard).length !== SHARD_SIZE) throw new Error('shard size mismatch');

  return { records, prov };
}

function write(records, prov) {
  const outDir = path.join(__dirname, '..', '..', 'eval', 'corpus');
  const KEY_ORDER = ['id', 'source_url', 'source_id', 'license', 'retrieval_date', 'source_sha',
    'fen', 'source_fen', 'setup_move', 'move_history', 'expected_moves', 'phase', 'themes',
    'rating_band', 'branching', 'split_group', 'generator_version', 'seed', 'core', 'shard', 'assert'];
  const ordered = r => { const o = {}; for (const k of KEY_ORDER) if (r[k] !== undefined) o[k] = r[k]; return o; };
  const ndjson = records.map(r => JSON.stringify(ordered(r))).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'eval-v1.ndjson'), ndjson);

  const byCat = {};
  for (const r of records) {
    const cat = r.core ? (r.themes[0] || 'generated') : (r.id.startsWith('puzzle-') ? 'puzzle' : 'opening');
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  const bySplit = { train: 0, val: 0, test: 0 };
  for (const r of records) bySplit[r.split_group]++;
  const byLicense = {};
  for (const r of records) byLicense[r.license] = (byLicense[r.license] || 0) + 1;

  const manifest = {
    corpus: 'eval-v1', generator_version: GENERATOR_VERSION, retrieval_date: prov.retrieval_date,
    total: records.length, shard_size: records.filter(r => r.shard).length,
    counts_by_category: byCat, counts_by_split: bySplit, counts_by_license: byLicense,
    split_policy: '70/15/15 train/val/test by stable id/game hash; same-game puzzles share a split; never tune on the test split',
    analyse_opts: ANALYSE_OPTS, ndjson: 'eval-v1.ndjson', ndjson_sha256: sha256(ndjson),
    sources: prov.sources, schema: KEY_ORDER,
    note: 'Derived offline from committed CC0 sources (eval/corpus/sources/, fetched by test/eval/fetch-corpus.js) + engine-generated MIT fixtures. See eval/LICENSE-REPORT.md.'
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const { records, prov } = build();
const manifest = write(records, prov);
console.log('eval-v1 corpus generated and validated (offline, from committed CC0 sources):');
console.log('  cases:      ' + manifest.total + ' (shard ' + manifest.shard_size + ')');
console.log('  by license: ' + JSON.stringify(manifest.counts_by_license));
console.log('  by category:' + JSON.stringify(manifest.counts_by_category));
console.log('  by split:   ' + JSON.stringify(manifest.counts_by_split));
console.log('  ndjson sha256 ' + manifest.ndjson_sha256.slice(0, 12) + '…');
