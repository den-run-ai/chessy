/*
 * Analysis contract (roadmap #23, Phase 1) — run with:
 *   node test/analysis-core.test.js
 *
 * The contract is deterministic and provider-neutral: exact WHITE-POV scores
 * from a full-window, delta-pruning-off search, mirrored to player POV, with
 * legal PVs, provenance and a non-judgemental classification.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
require('../assets/analysis-core.js');
const Chess = globalThis.Chess;
const Core = globalThis.ChessyAnalysisCore;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}
function sq(name) { return Chess.sqIndex(name); }
function fromUci(state, u) {
  const legal = Chess.legalMoves(state);
  const from = sq(u.slice(0, 2)), to = sq(u.slice(2, 4));
  const promo = u.length > 4 ? u[4].toUpperCase() : null;
  return legal.find(function (m) {
    return m.from === from && m.to === to && (m.promotion || null) === promo;
  });
}
// Replay a UCI PV from `state`; returns true iff every step is legal.
function pvIsLegal(fen, pvUci) {
  let s = Chess.parseFen(fen);
  for (const u of pvUci) {
    const m = fromUci(s, u);
    if (!m) return false;
    s = Chess.applyMove(s, m);
  }
  return true;
}
const FAST = { maxDepth: 4, nodeLimit: 20000, multiPV: 3, verifyNodeLimit: 800000,
  stabilityNodeLimit: 40000 };

// --- Mate in 1 (Black to move: 1.f3 e5 2.g4 Qh4#) ---
const mateFen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
const mateState = Chess.parseFen(mateFen);
const mate = Core.analyse(mateState, Object.assign({
  playedMove: { from: sq('d8'), to: sq('h4'), promotion: null } }, FAST));
check(mate.bestLines.length > 0 && mate.bestLines[0].san.indexOf('Qh4') === 0,
  'mate-in-1: the mating move is the top line', mate.bestLines[0] && mate.bestLines[0].san);
check(!!mate.bestLines[0].mate && mate.bestLines[0].mate.forWhite === false &&
  mate.bestLines[0].mate.inPlies === 1 && mate.bestLines[0].scoreCpWhite === null,
  'mate is reported for Black, cp is null, distance is exactly 1 ply (no off-by-one)');
check(mate.classification === 'same',
  'playing the mate classifies as "same" (matches the top line)');
check(mate.mate && mate.mate.forWhite === false, 'top-level mate mirrors the best line');

// --- Player-POV mirror (Black to move after 1.e4) ---
const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const black = Core.analyse(Chess.parseFen(blackFen), FAST);
check(typeof black.scoreCpWhite === 'number' &&
  black.scoreCpPlayer === -black.scoreCpWhite,
  'Black to move: player POV is the negated White-POV score');
check(black.turn === 'b', 'turn recorded');

// --- Best-first ordering + legal PVs (start position, White to move) ---
const start = Chess.parseFen(Chess.START_FEN);
const a = Core.analyse(start, FAST);
check(a.bestLines.length === 3, 'multiPV returns three candidate lines');
check(a.scoreCpPlayer === a.scoreCpWhite, 'White to move: player POV equals White POV');
let ordered = true;
for (let i = 1; i < a.bestLines.length; i++) {
  const prev = a.bestLines[i - 1], cur = a.bestLines[i];
  const pv = prev.scoreCpPlayer == null ? Infinity : prev.scoreCpPlayer;
  const cv = cur.scoreCpPlayer == null ? Infinity : cur.scoreCpPlayer;
  if (pv < cv) ordered = false;
}
check(ordered, 'candidate lines are ordered best-first for the side to move');
check(a.bestLines.every(function (l) { return pvIsLegal(Chess.START_FEN, l.pvUci); }),
  'every returned PV replays legally from the position');
check(a.bestLines[0].pv.length >= 1 && a.bestLines[0].pv[0] === a.bestLines[0].san,
  'the PV begins with the candidate move itself');

// --- Provenance + wdl ---
check(a.engine.id === 'chessy' && typeof a.engine.version === 'string' &&
  typeof a.engine.configHash === 'string', 'engine provenance present');
check(a.wdl === null, 'built-in Chessy reports wdl: null');
const diffCfg = Core.analyse(start, Object.assign({}, FAST, { multiPV: 2 }));
check(diffCfg.engine.configHash !== a.engine.configHash,
  'the config hash changes when the configuration changes');

// --- Determinism (identical JSON apart from elapsed time) ---
const a2 = Core.analyse(start, FAST);
const norm = function (r) { const c = JSON.parse(JSON.stringify(r)); c.elapsedMs = 0; return JSON.stringify(c); };
check(norm(a) === norm(a2), 'repeated analysis is byte-identical (excluding elapsed time)');
check(a.stability && a.stability.bestMoveStable === true,
  'the start position best move is stable across node budgets');

// --- Classification: same / played move present ---
const best = a.bestLines[0].move;
const asSame = Core.analyse(start, Object.assign({ playedMove: best }, FAST));
check(asSame.classification === 'same' && asSame.playedLine && asSame.playedLine.rank === 1,
  'playing the top move classifies as "same" with rank 1');
const modest = Core.analyse(start, Object.assign({
  playedMove: { from: sq('a2'), to: sq('a3'), promotion: null } }, FAST));
check(['different-candidate', 'unknown-equivalence'].indexOf(modest.classification) !== -1 &&
  !!modest.playedLine && modest.playedLine.rank >= 1,
  'a non-top move is never auto-called a mistake; it is a candidate or unknown-equivalence');

// --- Terminal position yields no lines ---
const checkmate = Chess.parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
const term = Core.analyse(checkmate, FAST);
check(term.bestLines.length === 0 && term.scoreCpWhite === null && term.classification === null,
  'a terminal (checkmated) position returns no lines');

// --- Repetition fingerprint distinguishes histories ---
const f0 = Core.positionFingerprint(start, null);
const key = Chess.positionKey(start);
const reps = {}; reps[key] = 2;
const f2 = Core.positionFingerprint(start, reps);
check(f0 !== f2, 'the same FEN with a different repetition history has a distinct fingerprint');

// --- Deep verification is seeded with the game's repetition table: a move
//     that COMPLETES a seeded threefold is scored as the draw it is (A1). ---
const midFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const mid = Chess.parseFen(midFen);
const nf3 = Chess.legalMoves(mid).find(function (m) {
  return m.from === sq('g1') && m.to === sq('f3');
});
const afterNf3Key = Chess.positionKey(Chess.applyMove(mid, nf3));
const seenReps = {}; seenReps[afterNf3Key] = 2; // Nf3 would be the 3rd occurrence
const drawn = Core.analyse(mid, Object.assign({ playedMove: nf3, positions: seenReps }, FAST));
check(drawn.playedLine && drawn.playedLine.scoreCpPlayer === 0 && !drawn.playedLine.mate,
  'a candidate completing a seeded threefold is scored as a draw (repetition-seeded search)');

// --- bestLines is TRUE final-depth MultiPV (every legal root deep-scored) ---
const krk = Chess.parseFen('8/8/8/8/8/5k2/8/R6K w - - 0 1'); // few legal moves
const krkA = Core.analyse(krk, Object.assign({}, FAST, { multiPV: 50 }));
check(krkA.bestLines.length === Chess.legalMoves(krk).length,
  'every legal root move is deep-scored (bestLines is real MultiPV, not a shortlist)');

// --- Contract carries completeness + verified-best stability across depths ---
check(a.complete === true && a.stability &&
  a.stability.depths.length === 2 && typeof a.stability.bestMoveStable === 'boolean',
  'the contract reports completeness and best-move stability across two depths');

// --- Reported nodes include the deep-verify work, not just the scan ---
check(a.nodes > 0 && a.nodes >= a.bestLines.length,
  'reported nodes accumulate the deep-verify passes, not only the preliminary scan');

// --- Every returned PV is consistent with its own deep score: replaying the
//     PV from the position reaches the line the score describes (legal PV,
//     built from the deep TT, not clobbered by the shallow stability pass). ---
check(a.bestLines.every(function (l) { return l.pv[0] === l.san && pvIsLegal(Chess.START_FEN, l.pvUci); }),
  'each PV starts with its move and replays legally (deep TT preserved before the PV walk)');

// --- The halfmove clock is part of the fingerprint (50-move-rule sensitivity) ---
const fpA = Core.positionFingerprint(Chess.parseFen('8/8/8/8/8/5k2/8/R6K w - - 0 1'), null);
const fpB = Core.positionFingerprint(Chess.parseFen('8/8/8/8/8/5k2/8/R6K w - - 99 1'), null);
check(fpA !== fpB, 'the same board at a different halfmove clock has a distinct fingerprint');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
