/*
 * Late-move-reduction regression suite — run with: node test/ai-lmr.js
 *
 * LMR is a selective heuristic that can prune the principal variation (see
 * PR #55), so its safety rests entirely on WHICH moves it reduces and on the
 * mandatory full-depth re-search when a reduced scout beats the bound. These
 * tests pin both:
 *
 *   1. Eligibility / exclusions — the pure predicate ChessAI.lmrReduces is
 *      exercised directly, one gate per case, so a regression that (say)
 *      starts reducing captures or checks fails a named assertion instead of
 *      only nudging a self-play score.
 *   2. Mandatory full-depth re-search — the ctx.lmr / ctx.lmrRe counters
 *      (reductions applied / reduced scouts re-searched at full depth) prove
 *      the re-search path actually fires and stays bounded (lmrRe <= lmr).
 *
 * Reductions live inside searchNode at depth >= 4. ChessAI.search(state, depth,
 * ...) runs its TOP node at exactly `depth`, so search(state, 4, ...) makes the
 * root itself the only reducing node — every counted reduction is a root move,
 * which is what lets these assertions reason exactly.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail != null ? ' — ' + detail : '')); }
}

// Does move m give check to the side NOT to move? (mirrors the predicate's own
// "gives check" test, computed independently here so the fixtures are honest.)
function givesCheck(state, m) {
  const next = Chess.applyMove(state, m);
  const enemy = state.turn === 'w' ? 'b' : 'w';
  return Chess.isAttacked(next.board, next.board.indexOf(enemy + 'K'), state.turn);
}
function find(state, pred, what) {
  const m = Chess.legalMoves(state).find(pred);
  if (!m) throw new Error('fixture broken: no ' + what + ' move in ' + Chess.toFen(state));
  return m;
}
// Vertical mirror + color swap (a1<->a8, White<->Black) — turns a White-to-move
// fixture into its Black-to-move twin so the minimizing branch is exercised.
function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) { return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(); };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) { return /\d/.test(c) ? c : swap(c); }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}
// Convenience: is this move reduced under otherwise-maximally-eligible
// conditions, overriding only the fields a case wants to probe?
function reduces(state, m, over) {
  over = over || {};
  const ctx = over.ctx || ChessAI.makeCtx(true, Infinity);
  const depth = over.depth != null ? over.depth : 4;
  const legalCount = over.legalCount != null ? over.legalCount : 3;
  const inChk = !!over.inChk;
  const ttPk = over.ttPk != null ? over.ttPk : 0;
  const ply = over.ply != null ? over.ply : 0;
  return ChessAI.lmrReduces(state, Chess.applyMove(state, m), m, depth, legalCount, inChk, ttPk, ply, ctx);
}

// --- Predicate: eligibility & every exclusion, one gate at a time ---
console.log('LMR eligibility predicate');

// A rich, quiet middlegame (White to move, not in check, 40 legal moves) —
// the natural habitat of LMR.
const MID = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1';
const mid = Chess.parseFen(MID);
check(!Chess.isAttacked(mid.board, mid.board.indexOf('wK'), 'b'), 'fixture: MID side to move is not in check');

const quiet = find(mid, function (m) { return !m.captured && !m.promotion && !givesCheck(mid, m); }, 'quiet');
const capture = find(mid, function (m) { return !!m.captured; }, 'capture');

check(reduces(mid, quiet) === true, 'quiet late move at depth 4 IS reduced (baseline eligibility)');
check(reduces(mid, quiet, { depth: 3 }) === false, 'depth < 4 is NOT reduced (depth gate)');
check(reduces(mid, quiet, { depth: 4 }) === true, 'depth == 4 IS reduced (depth-gate boundary)');
check(reduces(mid, quiet, { legalCount: 2 }) === false, 'a 3rd-or-earlier move is NOT reduced (legalCount gate)');
check(reduces(mid, quiet, { legalCount: 3 }) === true, 'the 4th move IS reduced (legalCount boundary)');
check(reduces(mid, quiet, { inChk: true }) === false, 'no move is reduced while in check (evasion exclusion)');
check(reduces(mid, capture) === false, 'a capture is NOT reduced (capture exclusion)');

// Hash move and killer moves are trusted, never reduced.
check(reduces(mid, quiet, { ttPk: ChessAI.packMove(quiet) }) === false, 'the hash move is NOT reduced');
const kctx1 = ChessAI.makeCtx(true, Infinity); kctx1.killers[0] = [ChessAI.packMove(quiet), 0];
check(reduces(mid, quiet, { ctx: kctx1 }) === false, 'a primary killer is NOT reduced');
const kctx2 = ChessAI.makeCtx(true, Infinity); kctx2.killers[0] = [0, ChessAI.packMove(quiet)];
check(reduces(mid, quiet, { ctx: kctx2 }) === false, 'a secondary killer is NOT reduced');

// Quiescence gate: with quiescence OFF (Expert mode) the reduced scout has no
// horizon to catch tactics, so LMR is disabled entirely — the same move that
// is reduced under quiescence is left full-width here.
const qoffCtx = ChessAI.makeCtx(false, Infinity);
check(reduces(mid, quiet, { ctx: qoffCtx }) === false, 'no move is reduced when quiescence is off (Expert mode)');

// Promotions are never reduced.
const PROMO = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
const promoState = Chess.parseFen(PROMO);
const promo = find(promoState, function (m) { return m.promotion === 'Q'; }, 'promotion');
check(reduces(promoState, promo) === false, 'a promotion is NOT reduced (promotion exclusion)');

// A quiet move that gives check is excluded; the same-shaped quiet move that
// does NOT give check is reduced — isolating the checking-move gate.
const RK = '4k3/8/8/8/8/8/8/R3K3 w - - 0 1';
const rk = Chess.parseFen(RK);
const rookCheck = find(rk, function (m) { return m.piece === 'wR' && Chess.sqName(m.to) === 'a8'; }, 'Ra8 (checking)');
const rookQuiet = find(rk, function (m) { return m.piece === 'wR' && Chess.sqName(m.to) === 'a4'; }, 'Ra4 (quiet)');
check(givesCheck(rk, rookCheck) && !rookCheck.captured, 'fixture: Ra8 is a quiet checking move');
check(reduces(rk, rookCheck) === false, 'a quiet move that gives check is NOT reduced (checking-move exclusion)');
check(reduces(rk, rookQuiet) === true, 'a quiet non-checking rook move IS reduced (control for the check gate)');

// --- Integration: the counters as the search actually drives them ---
console.log('LMR counters over a real search');

// Whole-tree depth gate: at search depth 3 no node ever reaches depth >= 4,
// so not a single reduction can occur.
{
  const ctx = ChessAI.makeCtx(true, Infinity);
  ChessAI.search(mid, 3, -Infinity, Infinity, true, { ctx: ctx });
  check(ctx.lmr === 0, 'search depth 3 applies zero reductions (whole-tree depth gate)', 'lmr=' + ctx.lmr);
}
// At search depth 4 the root reduces its late quiet moves, and some reduced
// scout beats the bound and is re-searched at full depth.
{
  const ctx = ChessAI.makeCtx(true, Infinity);
  ChessAI.search(mid, 4, -Infinity, Infinity, true, { ctx: ctx });
  check(ctx.lmr > 0, 'search depth 4 applies reductions', 'lmr=' + ctx.lmr);
  check(ctx.lmrRe > 0, 'search depth 4 forces at least one full-depth re-search', 'lmrRe=' + ctx.lmrRe);
  check(ctx.lmrRe <= ctx.lmr, 'every re-search corresponds to a reduction (lmrRe <= lmr)',
    'lmr=' + ctx.lmr + ' lmrRe=' + ctx.lmrRe);
}
// Quiescence gate end-to-end: the SAME position at the SAME depth reduces
// nothing with quiescence off (Expert) but reduces with it on (Master). This
// is the fix for the Expert-mode node regression — full-width search there.
{
  const off = ChessAI.makeCtx(false, Infinity);
  ChessAI.search(mid, 4, -Infinity, Infinity, false, { ctx: off });
  check(off.lmr === 0, 'search depth 4 with quiescence off applies zero reductions (Expert)', 'lmr=' + off.lmr);
  const on = ChessAI.makeCtx(true, Infinity);
  ChessAI.search(mid, 4, -Infinity, Infinity, true, { ctx: on });
  check(on.lmr > 0, 'search depth 4 with quiescence on applies reductions (Master)', 'lmr=' + on.lmr);
}
// Minimizing branch: the mirror of MID (Black to move) drives the
// `if (red && score < beta)` re-search path, symmetric to White's maximizing
// re-search above — so the Black side gets the same reduce-then-verify guard.
{
  const midB = Chess.parseFen(mirrorFen(MID));
  check(midB.turn === 'b', 'fixture: mirrored MID has Black to move');
  const ctx = ChessAI.makeCtx(true, Infinity);
  ChessAI.search(midB, 4, -Infinity, Infinity, true, { ctx: ctx });
  check(ctx.lmr > 0, 'minimizing root (Black) applies reductions', 'lmr=' + ctx.lmr);
  check(ctx.lmrRe > 0, 'minimizing root forces a full-depth re-search', 'lmrRe=' + ctx.lmrRe);
  check(ctx.lmrRe <= ctx.lmr, 'minimizing: every re-search corresponds to a reduction (lmrRe <= lmr)',
    'lmr=' + ctx.lmr + ' lmrRe=' + ctx.lmrRe);
}

// A root that is in check reduces nothing even with enough evasions to clear
// the legalCount gate — the exclusion is the check, not move scarcity.
{
  const CHK = '4k3/8/8/8/8/5n2/8/R3K2R w KQ - 0 1';
  const chk = Chess.parseFen(CHK);
  check(Chess.isAttacked(chk.board, chk.board.indexOf('wK'), 'b'), 'fixture: CHK root is in check');
  check(Chess.legalMoves(chk).length >= 4, 'fixture: CHK root has >= 4 evasions (legalCount gate would pass)');
  const ctx = ChessAI.makeCtx(true, Infinity);
  ChessAI.search(chk, 4, -Infinity, Infinity, true, { ctx: ctx });
  check(ctx.lmr === 0, 'an in-check root applies zero reductions', 'lmr=' + ctx.lmr);
}

// think() surfaces the counters and the search is deterministic under a fixed
// mode: identical runs must agree on nodes AND the LMR counters.
{
  const opts = { maxDepth: 6, nodeLimit: 120000, randomize: false, quiesce: true };
  const a = ChessAI.think(mid, opts);
  const b = ChessAI.think(mid, opts);
  check(typeof a.lmr === 'number' && typeof a.lmrRe === 'number', 'think() reports lmr and lmrRe');
  check(a.lmr > 0 && a.lmrRe > 0, 'think() to depth 6 both reduces and re-searches',
    'lmr=' + a.lmr + ' lmrRe=' + a.lmrRe);
  check(a.lmrRe <= a.lmr, 'think(): lmrRe <= lmr', 'lmr=' + a.lmr + ' lmrRe=' + a.lmrRe);
  check(a.lmr === b.lmr && a.lmrRe === b.lmrRe && a.nodes === b.nodes,
    'deterministic mode reproduces identical lmr/lmrRe/nodes',
    a.lmr + '/' + a.lmrRe + '/' + a.nodes + ' vs ' + b.lmr + '/' + b.lmrRe + '/' + b.nodes);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
