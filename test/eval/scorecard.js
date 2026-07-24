/*
 * eval-v1 correctness scorecard (E1/E2 slice) — run with:
 *   node test/eval/scorecard.js            # frozen 64-case PR shard (CI default)
 *   node test/eval/scorecard.js --full     # the whole committed corpus
 *   node test/eval/scorecard.js --json      # machine-readable score vector
 *   node test/eval/scorecard.js --out f.json           # write the score vector
 *   node test/eval/scorecard.js --baseline b.json       # before/after vs a prior run
 *   node test/eval/scorecard.js --self-test             # prove the gate has teeth
 *
 * PUBLISH A SCORE VECTOR, NOT ONE HEADLINE NUMBER. This runner reports a
 * per-axis correctness vector over the frozen, license-clean corpus:
 *
 *   legalRoot        differential legal-move set (independent re-derivation +
 *                    unique SAN round-trip); non-empty iff the position is live
 *   terminalStatus   checkmate / stalemate / fifty-move / threefold /
 *                    insufficient-material verdict matches the engine
 *   specialMoves     en-passant / castling / promotion availability (and
 *                    restraint: absence where rights/paths forbid it)
 *   expectedLegal    each corpus-labelled move (e.g. a puzzle's key move) is
 *                    legal in its position — the corpus's own labels are valid
 *   pvReplay         every reported MultiPV line replays legally move-by-move
 *   perspectiveMate  analyse() mate distance + winning side match
 *   symmetry         best move is invariant under colour/rank mirroring
 *   determinism      analyse() is bit-identical across repeated runs
 *
 * GATE: correctness is strict — any failed check exits non-zero (100%, no
 * tolerated regression). This axis is version-independent (a correct engine
 * scores 100% regardless of its playing strength), so it is safe to gate now,
 * ahead of the strength/position-quality baselines that wait on #72.
 *
 * Development/build-time tool (uses node:crypto for the corpus integrity
 * check); never loaded by the browser app.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../../assets/engine.js');
require('../../assets/ai.js');
require('../../assets/analysis-core.js');
const oracle = require('./oracle.js');
const Chess = globalThis.Chess;
const AC = globalThis.ChessyAnalysisCore;

const CORPUS_DIR = path.join(__dirname, '..', '..', 'eval', 'corpus');

// ---------------------------------------------------------------------------
// shared helpers (must match gen-corpus.js)
// ---------------------------------------------------------------------------
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function uciOf(m) { return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : ''); }
function sameMove(a, b) {
  return a.from === b.from && a.to === b.to && (a.promotion || null) === (b.promotion || null);
}
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
// Build the position from the FROZEN, hash-verified `fen` whenever one is
// committed — do NOT re-derive it from move_history through the engine under
// test (a SAN/apply regression could otherwise be graded against a different,
// still-legal position than the one whose hash was verified). Only history-only
// fixtures (the threefold cases, which need the replayed repetition table) fall
// back to replay.
function stateOf(rec) {
  return rec.fen ? Chess.newGameState(rec.fen) : Chess.replaySans(rec.move_history);
}

// ---------------------------------------------------------------------------
// corpus load + integrity
// ---------------------------------------------------------------------------
// Normalize CRLF→LF before hashing so the digest is stable across checkout
// configurations (Windows core.autocrlf) — the .gitattributes rules pin these
// files to LF, and this is the defensive backstop.
function lf(s) { return s.replace(/\r\n/g, '\n'); }
function loadCorpus() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8'));
  const raw = lf(fs.readFileSync(path.join(CORPUS_DIR, manifest.ndjson), 'utf8'));
  if (sha256(raw) !== manifest.ndjson_sha256) {
    throw new Error('corpus integrity check FAILED: ' + manifest.ndjson +
      ' sha256 does not match manifest — regenerate with test/eval/gen-corpus.js');
  }
  const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { manifest, records };
}

// ---------------------------------------------------------------------------
// per-axis checks. Each returns an array of {ok, detail} results (usually one).
// ---------------------------------------------------------------------------
// Differential legal-move set: re-derive legality from pseudoMoves independently
// of legalMoves, and confirm each legal move's SAN round-trips uniquely.
function checkLegalRoot(rec, state) {
  const status = Chess.gameStatus(state);
  const legal = Chess.legalMoves(state);
  // Independent re-derivation: pseudo moves that do not leave the mover in check.
  const rederived = Chess.pseudoMoves(state).filter(m => !Chess.inCheck(Chess.applyMove(state, m), state.turn));
  // Compare the canonical UCI SETS (not just sizes): a regression that swaps one
  // legal root for a different illegal one while preserving the count must fail.
  const legalSet = legal.map(uciOf).sort();
  const rederivedSet = rederived.map(uciOf).sort();
  if (legalSet.length !== rederivedSet.length || legalSet.some((u, i) => u !== rederivedSet[i])) {
    return [{ ok: false, detail: 'legal set {' + legalSet.join(',') + '} != re-derived {' + rederivedSet.join(',') + '}' }];
  }
  // Non-empty iff live (mate/stalemate are the only zero-move terminals).
  const zeroMove = status.over && (status.reason === 'checkmate' || status.reason === 'stalemate');
  if ((legal.length === 0) !== zeroMove) {
    return [{ ok: false, detail: 'legal.length=' + legal.length + ' but zeroMoveTerminal=' + zeroMove }];
  }
  // Unique SAN round-trip for every legal move (exercises the notation path).
  for (const m of legal) {
    const san = Chess.toSan(state, m, legal);
    const hits = legal.filter(x => Chess.toSan(state, x, legal) === san);
    if (hits.length !== 1 || !sameMove(hits[0], m)) {
      return [{ ok: false, detail: 'SAN "' + san + '" is not a unique round-trip' }];
    }
  }
  // Independent oracle (chess.js, a separate rules implementation) when
  // available: a bug in Chessy's shared move-gen primitives cannot pass by
  // agreeing with itself. Count-stable — one result per case whether or not
  // the oracle ran; it only makes the check stricter. Skips a FEN chess.js
  // parses differently rather than failing spuriously.
  const oracleSet = oracle.legalUci(Chess.toFen(state));
  if (oracleSet && (oracleSet.length !== legalSet.length || oracleSet.some((u, i) => u !== legalSet[i]))) {
    return [{ ok: false, detail: 'chess.js oracle {' + oracleSet.join(',') + '} != engine {' + legalSet.join(',') + '}' }];
  }
  return [{ ok: true, detail: legal.length + ' legal roots' + (oracleSet ? ' (oracle✓)' : '') }];
}

function checkTerminalStatus(rec, state) {
  const s = Chess.gameStatus(state);
  // Live-position expectation: fifty-move / repetition / insufficient-material
  // terminals keep legal moves, so legalRoot cannot catch a wrongly-drawn
  // "notTerminal" record — score it here and require the game is NOT over.
  if (rec.assert.notTerminal) {
    return [{ ok: !s.over, detail: s.over ? 'expected live, engine over (' + s.reason + ')' : 'live' }];
  }
  const t = rec.assert.terminal;
  if (!s.over) return [{ ok: false, detail: 'expected ' + t.reason + ', engine live' }];
  if (s.reason !== t.reason) return [{ ok: false, detail: 'reason ' + s.reason + ' != ' + t.reason }];
  if (t.result && s.result !== t.result) return [{ ok: false, detail: 'result ' + s.result + ' != ' + t.result }];
  return [{ ok: true, detail: t.reason + ' ' + (t.result || '') }];
}

function checkSpecialMoves(rec, state) {
  const legal = Chess.legalMoves(state);
  const has = {
    enPassant: legal.some(m => m.ep),
    castleK: legal.some(m => m.castle === 'K'),
    castleQ: legal.some(m => m.castle === 'Q'),
    promotion: legal.some(m => m.promotion),
    promotionCapture: legal.some(m => m.promotion && m.captured)
  };
  const out = [];
  for (const [kind, want] of Object.entries(rec.assert.special)) {
    out.push({ ok: has[kind] === want, detail: kind + '=' + has[kind] + (has[kind] === want ? '' : ' want ' + want) });
  }
  return out;
}

function checkExpectedLegal(rec, state) {
  const legal = Chess.legalMoves(state);
  const out = [];
  for (const u of rec.expected_moves) {
    const ok = legal.some(m => uciOf(m) === u);
    out.push({ ok: ok, detail: 'labelled ' + u + (ok ? ' legal' : ' NOT legal') });
  }
  return out;
}

function checkPvReplay(rec, state, res) {
  // Lost PV output is a failure, not a vacuous pass: a live position must
  // report at least one line to replay.
  if (!res.bestLines.length) return [{ ok: false, detail: 'analyse returned no bestLines to replay' }];
  const fen = Chess.toFen(state);
  let maxLen = 0;
  for (const line of res.bestLines) {
    let s = Chess.newGameState(fen);
    const pv = line.pvUci || [];
    maxLen = Math.max(maxLen, pv.length);
    for (const u of pv) {
      const m = Chess.legalMoves(s).find(mv => uciOf(mv) === u);
      if (!m) return [{ ok: false, detail: 'illegal PV move ' + u + ' from ' + Chess.toFen(s) }];
      s = Chess.applyMove(s, m);
    }
  }
  // Fixtures marked multiPly must actually exercise a >1-ply continuation, so
  // a regression that truncates PVs to the root move is caught here too.
  if (rec.assert.multiPly && maxLen < 2) {
    return [{ ok: false, detail: 'multiPly expected but longest PV is ' + maxLen + ' ply' }];
  }
  return [{ ok: true, detail: res.bestLines.length + ' PV lines replay legally (max ' + maxLen + ' ply)' }];
}

function checkPerspectiveMate(rec, res) {
  const want = rec.assert.mate;
  if (!res.mate) return [{ ok: false, detail: 'analyse found no mate' }];
  const ok = res.mate.forWhite === want.forWhite && res.mate.inPlies === want.inPlies;
  return [{ ok: ok, detail: 'mate ' + JSON.stringify(res.mate) + (ok ? '' : ' != ' + JSON.stringify(want)) }];
}

function checkSymmetry(rec, res, opts) {
  const best = res.bestLines[0] ? res.bestLines[0].uci : '-';
  const mres = AC.analyse(Chess.newGameState(mirrorFen(rec.fen)), opts);
  const mbest = mres.bestLines[0] ? mres.bestLines[0].uci : '-';
  const ok = mirrorUci(best) === mbest;
  return [{ ok: ok, detail: best + ' mirrors to ' + mirrorUci(best) + (ok ? ' = ' + mbest : ' != ' + mbest) }];
}

// Full analysis signature: every stable field of the analyse() result — all
// MultiPV lines, scores, mate, depth/nodes, stability — excluding only the
// inherently variable elapsedMs. Shared with gen-corpus.js.
function analysisSignature(res) {
  const copy = Object.assign({}, res);
  delete copy.elapsedMs;
  return JSON.stringify(copy);
}
function checkDeterminism(rec, state, res, opts) {
  const ok = analysisSignature(res) === analysisSignature(AC.analyse(state, opts));
  return [{ ok: ok, detail: ok ? 'stable (full MultiPV signature)' : 'DIVERGED across runs' }];
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const AXES = ['legalRoot', 'terminalStatus', 'specialMoves', 'expectedLegal', 'pvReplay', 'perspectiveMate', 'symmetry', 'determinism'];

function run(records, opts, mutate) {
  const axes = {};
  for (const a of AXES) axes[a] = { checked: 0, pass: 0, fail: 0 };
  const failures = [];

  for (const rec0 of records) {
    const rec = mutate ? mutate(rec0) : rec0;
    const state = stateOf(rec);
    const a = rec.assert || {};
    // analyse() once per case if any analyse-based axis applies.
    const needAnalyse = a.mate || a.pvReplay || a.symmetry || a.determinism;
    const res = needAnalyse ? AC.analyse(state, opts) : null;

    const todo = [['legalRoot', () => checkLegalRoot(rec, state)]];
    if (a.terminal || a.notTerminal) todo.push(['terminalStatus', () => checkTerminalStatus(rec, state)]);
    if (a.special) todo.push(['specialMoves', () => checkSpecialMoves(rec, state)]);
    if (a.expectedLegal) todo.push(['expectedLegal', () => checkExpectedLegal(rec, state)]);
    if (a.pvReplay) todo.push(['pvReplay', () => checkPvReplay(rec, state, res)]);
    if (a.mate) todo.push(['perspectiveMate', () => checkPerspectiveMate(rec, res)]);
    if (a.symmetry) todo.push(['symmetry', () => checkSymmetry(rec, res, opts)]);
    if (a.determinism) todo.push(['determinism', () => checkDeterminism(rec, state, res, opts)]);

    for (const [axis, fn] of todo) {
      for (const r of fn()) {
        axes[axis].checked++;
        if (r.ok) axes[axis].pass++;
        else { axes[axis].fail++; failures.push({ id: rec.id, axis, detail: r.detail }); }
      }
    }
  }

  let checks = 0, pass = 0, fail = 0;
  for (const a of AXES) { checks += axes[a].checked; pass += axes[a].pass; fail += axes[a].fail; }
  return { axes, totals: { checks, pass, fail }, failures };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function scoreVector(mode, records, result, manifest) {
  return {
    corpus: manifest.corpus,
    generator_version: manifest.generator_version,
    mode: mode,
    cases: records.length,
    analyse_opts: manifest.analyse_opts,
    axes: result.axes,
    totals: result.totals,
    gate: result.totals.fail === 0 ? 'PASS' : 'FAIL'
  };
}

function printReport(sv, failures) {
  console.log('eval-v1 correctness scorecard — ' + sv.mode + ' (' + sv.cases + ' cases)');
  console.log('  corpus ' + sv.corpus + ' @ ' + sv.generator_version);
  const pad = s => (s + '                ').slice(0, 16);
  for (const axis of AXES) {
    const a = sv.axes[axis];
    if (!a.checked) { console.log('  ' + pad(axis) + '     — (no cases)'); continue; }
    const flag = a.fail === 0 ? 'ok ' : 'FAIL';
    console.log('  ' + pad(axis) + ' ' + flag + ' ' + a.pass + '/' + a.checked);
  }
  console.log('  ' + pad('TOTAL') + '      ' + sv.totals.pass + '/' + sv.totals.checks +
    ' checks  →  gate ' + sv.gate);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  FAIL [' + f.axis + '] ' + f.id + ' — ' + f.detail);
  }
}

function compareBaseline(baseline, sv, log) {
  log = log || console.log;
  log('\nbefore/after vs baseline (' + baseline.mode + '):');
  let regressed = false;
  // A comparison across different corpora, modes, or ANALYSE OPTIONS is not
  // apples-to-apples — refuse it rather than silently "pass". Equal pass counts
  // under a changed nodeLimit/multiPV/pvLen/quiesce evaluated a different search.
  const optsEq = JSON.stringify(baseline.analyse_opts) === JSON.stringify(sv.analyse_opts);
  if (baseline.corpus !== sv.corpus || baseline.mode !== sv.mode || !optsEq) {
    log('  INCOMPATIBLE baseline: ' + baseline.corpus + '/' + baseline.mode +
      ' opts=' + JSON.stringify(baseline.analyse_opts) + ' vs ' + sv.corpus + '/' + sv.mode +
      ' opts=' + JSON.stringify(sv.analyse_opts) + '  ← REGRESSION');
    return false;
  }
  for (const axis of AXES) {
    const b = baseline.axes[axis] || { pass: 0, checked: 0, fail: 0 };
    const a = sv.axes[axis];
    if (!a.checked && !b.checked) continue;
    const bStr = b.pass + '/' + b.checked, aStr = a.pass + '/' + a.checked;
    const delta = (a.pass - a.fail) - (b.pass - (b.fail || 0));
    // Regression = any new failure OR any LOSS of coverage/passes. Dropping a
    // case or an entire assertion category (checked/pass falling — even to 0)
    // must fail the guard, not slip through because fail stayed 0.
    const bad = a.fail > (b.fail || 0) || a.pass < b.pass || a.checked < b.checked;
    if (bad) regressed = true;
    log('  ' + (axis + '                ').slice(0, 16) + ' ' + bStr + ' → ' + aStr +
      (delta ? '  (' + (delta > 0 ? '+' : '') + delta + ')' : '') + (bad ? '  ← REGRESSION' : ''));
  }
  return !regressed;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const asJson = args.includes('--json');
  const selfTest = args.includes('--self-test');
  const outIdx = args.indexOf('--out');
  const baseIdx = args.indexOf('--baseline');

  const { manifest, records: all } = loadCorpus();
  const records = full ? all : all.filter(r => r.shard);
  const mode = full ? 'full' : 'shard';
  const opts = manifest.analyse_opts;

  const result = run(records, opts, null);
  const sv = scoreVector(mode, records, result, manifest);

  // In --json mode stdout must be ONLY the JSON document; all human-readable
  // diagnostics (baseline report, self-test prose, notices) go to stderr so the
  // command's stdout stays machine-parseable even with --baseline/--self-test.
  const diag = asJson ? console.error : console.log;
  if (asJson) {
    console.log(JSON.stringify(sv, null, 2));
  } else {
    printReport(sv, result.failures);
  }

  let baselineOk = true;
  if (baseIdx >= 0) {
    const baseline = JSON.parse(fs.readFileSync(args[baseIdx + 1], 'utf8'));
    baselineOk = compareBaseline(baseline, sv, diag);
  }
  if (outIdx >= 0) {
    fs.writeFileSync(args[outIdx + 1], JSON.stringify(sv, null, 2) + '\n');
    diag('\nscore vector written to ' + args[outIdx + 1]);
  }

  // Self-test: corrupt one expectation and confirm the gate FAILS. Guards
  // against a vacuous 100% (a gate that can never turn red is not a gate).
  if (selfTest) {
    const mutate = rec => {
      if (rec.id !== 'gen-matein1-backrank') return rec;
      const bad = JSON.parse(JSON.stringify(rec));
      bad.assert.mate = { forWhite: false, inPlies: 99 }; // deliberately wrong
      return bad;
    };
    const sr = run(records, opts, mutate);
    const detected = sr.totals.fail > 0;
    diag('\nself-test (inject a wrong mate expectation): gate ' +
      (detected ? 'correctly went RED ✓' : 'stayed green ✗ — GATE HAS NO TEETH'));
    if (!detected) process.exit(3);
  }

  const ok = sv.gate === 'PASS' && baselineOk;
  process.exit(ok ? 0 : 1);
}

main();
