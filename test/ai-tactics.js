/*
 * Fixed-node AI regression suite — run with: node test/ai-tactics.js
 *
 * Every search runs deterministic (randomize:false) under a fixed nodeLimit,
 * so results are reproducible across machines and immune to timer noise.
 * Mirrored (rank-flipped, color-swapped) twins of each positional test keep
 * the engine honest about color symmetry. Several tests allow multiple
 * equally-good moves; `avoid` tests assert restraint instead.
 *
 * These complement — never replace — the engine.test.js Tier A assertions.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

const MATE = 1000000, MATE_NEAR = MATE - 1000; // mirror ai.js

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

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
function mirrorMove(uci) { // e.g. a1a8 -> a8a1, f7f8R -> f2f1R
  return uci[0] + (9 - Number(uci[1])) + uci[2] + (9 - Number(uci[3])) + uci.slice(4);
}

function solve(fen, nodes, positions) {
  const r = ChessAI.think(Chess.parseFen(fen), {
    maxDepth: 30, nodeLimit: nodes, quiesce: true, randomize: false,
    positions: positions || null
  });
  return {
    uci: r.move ? Chess.sqName(r.move.from) + Chess.sqName(r.move.to) + (r.move.promotion || '') : '-',
    score: r.score, depth: r.depth, move: r.move
  };
}

// Is `move` (an engine result move object) actually legal in this position?
// Existence alone (`!!move`) would let a broken engine pass an avoid-only or
// smoke-test spec by returning a non-null but illegal move, so every spec
// checks membership in the position's own legal-move list.
function isLegal(fen, move) {
  return !!move && Chess.legalMoves(Chess.parseFen(fen)).some(function (m) {
    return m.from === move.from && m.to === move.to && m.promotion === move.promotion;
  });
}

// [name, fen, allowed-moves (or null), nodes, avoided-moves, requireMate]
// Each spec runs as written AND mirrored.
const SPECS = [
  ['back-rank mate in 1', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ['a1a8'], 4000],
  ['knight royal fork', '4r3/1k6/8/1N6/8/8/8/2K5 w - - 0 1', ['b5d6'], 8000],
  ['queen double attack', 'r5k1/8/8/8/8/8/8/3Q2K1 w - - 0 1', ['d1d5'], 8000],
  ['K+R opposition mate in 1', '3k4/8/3K4/8/8/8/8/7R w - - 0 1', ['h1h8'], 4000],
  ['back-rank mate by capture', '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1', ['d1d8'], 4000],
  // f8=Q stalemates, f8=B/N cannot win; f8=R and Kf6 both force mate — the
  // test is that the engine keeps a forced win (mate score) without the
  // losing promotions.
  ['underpromotion or outflank, never f8=Q', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1', null, 12000,
    ['f7f8Q', 'f7f8B', 'f7f8N'], true],
  ['underpromote N, royal fork', '8/2q1P1k1/8/8/8/8/P7/4K3 w - - 0 1', ['e7e8N'], 12000],
  ['take the rook, not the knight', '6k1/8/8/2r3n1/8/4B3/8/6K1 w - - 0 1', ['e3c5'], 8000],
  ['decline the poisoned pawn', '6k1/8/3p4/4p2Q/8/8/8/6K1 w - - 0 1', null, 8000, ['h5e5']],
  ['K+P: only Ke6 keeps the win', '4k3/8/3K4/4P3/8/8/8/8 w - - 0 1', ['d6e6'], 30000]
];

console.log('fixed-node tactics/defence');
for (const [name, fen, allowed, nodes, avoided, requireMate] of SPECS) {
  for (const flip of [false, true]) {
    const f = flip ? mirrorFen(fen) : fen;
    const ok = flip ? (allowed || []).map(mirrorMove) : allowed;
    const bad = flip ? (avoided || []).map(mirrorMove) : avoided;
    const r = solve(f, nodes);
    const label = name + (flip ? ' (mirrored)' : '');
    // A LEGAL move must always come back — otherwise an avoid-only spec
    // ('-', or any illegal UCI, is not in the avoid list) would pass a broken
    // engine that returned no move or an illegal one.
    check(r.uci !== '-' && isLegal(f, r.move), label + ' [returns a legal move]', 'got ' + r.uci);
    if (ok && ok.length) check(ok.indexOf(r.uci) >= 0, label, 'got ' + r.uci + ' (d' + r.depth + ' ' + r.score + ')');
    if (bad && bad.length) check(bad.indexOf(r.uci) < 0, label + ' [restraint]', 'played ' + r.uci);
    // The forced win must keep the correct SIGN, not just any mate magnitude:
    // the original (White to move, White winning) must score positive, its
    // color-swapped mirror (Black winning) negative. Math.abs would let the
    // engine claim a mate for the WRONG side and still pass.
    if (requireMate) {
      const wantMate = flip ? -MATE_NEAR : MATE_NEAR;
      check(flip ? r.score < wantMate : r.score > wantMate,
        label + ' [mate seen, winning side]', 'score ' + r.score);
    }
  }
}

// --- Conversion: play out a won ending against itself under a small budget.
console.log('conversion');
function convert(name, fen, maxPlies, nodesPerMove) {
  let state = Chess.newGameState(fen);
  let plies = 0;
  let illegal = false;
  while (plies < maxPlies && !Chess.gameStatus(state).over) {
    const r = ChessAI.think(state, {
      maxDepth: 30, nodeLimit: nodesPerMove, quiesce: true, randomize: false,
      positions: state.positions
    });
    if (!r.move) break;
    // Chess.playMove trusts its argument — it applies whatever move it is
    // given without confirming legality. Validate against the position's own
    // legal moves first, or a regression that returned an illegal move would
    // drive the playout through an impossible position and could reach a
    // bogus "checkmate" that passes the assertion below.
    const legal = Chess.legalMoves(state).some(function (m) {
      return m.from === r.move.from && m.to === r.move.to && m.promotion === r.move.promotion;
    });
    if (!legal) { illegal = true; break; }
    state = Chess.playMove(state, r.move);
    plies++;
  }
  if (illegal) {
    check(false, name + ' [returns a legal move]',
      'engine returned an illegal move during the conversion playout');
    return;
  }
  const status = Chess.gameStatus(state);
  check(status.reason === 'checkmate', name + ' (mated in ' + plies + ' plies)',
    'ended ' + (status.reason || 'unfinished') + ' after ' + plies + ' plies');
}
convert('K+Q vs K converts', '8/8/8/4k3/8/8/8/K3Q3 w - - 0 1', 40, 3000);
convert('K+R vs K converts', '8/8/8/4k3/8/8/8/K3R3 w - - 0 1', 60, 20000);

// --- Repetition at a fixed node budget (mirrors the Tier A depth tests).
console.log('repetition');
const winning = Chess.parseFen('7k/8/5K2/8/8/8/8/3Q4 w - - 0 1');
const winMoves = Chess.legalMoves(winning);
const keep = winMoves.find(function (m) { return Chess.sqName(m.to) === 'd2'; });
const repAll = {};
for (const m of winMoves) {
  if (m !== keep) repAll[Chess.positionKey(Chess.applyMove(winning, m))] = 2;
}
const avoided = solve('7k/8/5K2/8/8/8/8/3Q4 w - - 0 1', 6000, repAll);
check(avoided.move.from === keep.from && avoided.move.to === keep.to,
  'winning side avoids threefold', 'got ' + avoided.uci);

const losing = Chess.parseFen('7k/8/5K2/8/8/8/8/3Q4 b - - 0 1');
const loseMoves = Chess.legalMoves(losing);
const escapeRep = {};
escapeRep[Chess.positionKey(Chess.applyMove(losing, loseMoves[0]))] = 2;
const sought = solve('7k/8/5K2/8/8/8/8/3Q4 b - - 0 1', 6000, escapeRep);
check(sought.move.from === loseMoves[0].from && sought.move.to === loseMoves[0].to,
  'losing side heads for threefold', 'got ' + sought.uci);

// --- Repetition awareness INSIDE quiescence (regression). The main search
// scores repetitions as draws, but a repetition first reached PAST the horizon
// — a check evasion into a position that already stands twice, or that closes a
// cycle on a search-path ancestor — must also score 0, not by its material.
// Setup: fenS is Black-to-move IN CHECK (bishop a2 pins the a2–g8 diagonal);
// Black's king can step to e5, reaching fenA (White up Q+B, eval ~ +1182). The
// e5 escape is a check evasion resolved only in quiescence (depth-0 search with
// quiesce on), so it exercises the quiescence prelude, not the main search.
console.log('quiescence repetition');
(function () {
  const fenA = '8/8/8/4k3/8/8/B7/K6Q w - - 6 20';   // Black Ke5, White Ka1/Ba2/Qh1
  const fenS = '8/8/4k3/8/8/8/B7/K6Q b - - 5 20';   // Black Ke6 (in check), Ke5 -> fenA
  const S = Chess.parseFen(fenS), A = Chess.parseFen(fenA);
  const matVal = ChessAI.evaluate(A.board); // ~ +1182, the non-draw material score

  // (a) Search-path repetition: fenA seeded as an ancestor -> the e5 evasion
  // closes the cycle and the quiescence value is the draw (0), not the material.
  let ctx = ChessAI.makeCtx(true, Infinity);
  const vPath = ChessAI.search(S, 0, -Infinity, Infinity, true, { ctx: ctx, ancestors: [fenA] });
  check(vPath === 0, 'quiescence honors a search-path repetition (draw, not material)',
    'value ' + vPath + ' (material would be ' + matVal + ')');
  // ...and the draw's PATH dependency propagates as repPly, so no shallower node
  // caches it in the TT. The cycle closed on the seeded ancestor at path index 0.
  check(ctx.repPly === 0, 'quiescence path draw propagates repPly (TT-contamination guard)',
    'repPly ' + ctx.repPly + ' (expected 0)');

  // (b) A true game-history threefold seen only in quiescence also scores 0,
  // and is path-INDEPENDENT (repPly stays Infinity, so it remains cacheable).
  ctx = ChessAI.makeCtx(true, Infinity);
  ctx.gameCounts.set(ChessAI.repKey(A), 2); // fenA already stands twice
  const vHist = ChessAI.search(S, 0, -Infinity, Infinity, true, { ctx: ctx });
  check(vHist === 0, 'quiescence honors a game-history threefold',
    'value ' + vHist + ' (material would be ' + matVal + ')');
  check(ctx.repPly === Infinity, 'quiescence game-history draw stays cacheable (repPly=Infinity)',
    'repPly ' + ctx.repPly);

  // (c) Control: with neither seeded, the same evasion is a plain material leaf.
  ctx = ChessAI.makeCtx(true, Infinity);
  const vFree = ChessAI.search(S, 0, -Infinity, Infinity, true, { ctx: ctx });
  check(vFree === matVal, 'without a repetition the quiescence leaf is material',
    'value ' + vFree + ' (expected ' + matVal + ')');
})();

// --- Null-window scout vs a warm, wide-window TT (regression). A score a WIDER
// search produced with delta pruning active is not a sound null-window bound;
// the TT must withhold it from a quiescent null scout (offering only the hash
// move). Invariant: a null scout that reuses a warm, wide-window-populated
// context must return exactly what a FRESH-context scout returns.
console.log('null-scout TT safety');
(function () {
  const cases = [
    ['r1b1k1nr/pppp1p1p/4pqpb/6N1/3n4/2N1P1P1/PPPP3P/R1BQKB1R w KQkq - 4 9', 4],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 4], // Kiwipete
    ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', 4]
  ];
  for (const [fen, d] of cases) {
    const st = Chess.parseFen(fen);
    const vFull = ChessAI.search(st, d, -Infinity, Infinity, true);       // true value
    const lo = vFull - 1, hi = vFull;                                     // scout straddling it
    const vFresh = ChessAI.search(st, d, lo, hi, true);                   // fresh-context scout
    const ctx = ChessAI.makeCtx(true, Infinity);
    ChessAI.search(st, d, -Infinity, Infinity, true, { ctx: ctx });      // warm the TT (wide window)
    const vWarm = ChessAI.search(st, d, lo, hi, true, { ctx: ctx });     // reuse the warm TT
    check(vWarm === vFresh, 'warm wide-window TT does not corrupt a null scout',
      fen.split(' ')[0].slice(0, 12) + ' d' + d + ': fresh ' + vFresh + ' warm ' + vWarm);
  }
})();

// --- Zugzwang/fortress: mutual-zugzwang blocked pawns are a dead draw.
console.log('zugzwang');
for (const [name, fen] of [
  ['blocked-pawn mutual zugzwang is a draw', '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1'],
  // The diagram is its own mirror — the color-swapped twin is the same
  // board with Black to move.
  ['blocked-pawn mutual zugzwang is a draw (mirrored)', '8/8/4k3/4p3/4P3/4K3/8/8 b - - 0 1']
]) {
  const r = solve(fen, 15000);
  check(r.score === 0, name, 'score ' + r.score + ' (d' + r.depth + ')');
}

// --- PVS soundness vs an INDEPENDENT minimax oracle (regression) ---
// The property that must hold: PVS introduces no false fail-low/high. With
// delta pruning absent (quiescence OFF) the search is exact alpha-beta, so
// ChessAI.search's full-window value must equal the true minimax value and a
// null-window scout must correctly bracket it. A future change that corrupted
// PVS could bend the full-window value AND both scouts consistently, so the
// reference must NOT come from the code under test. `oracle()` below is a
// plain, self-contained alpha-beta (no PVS, no TT, no quiescence, no delta
// pruning) over the engine's own evaluation — an independent witness. It DOES
// reproduce the engine's search-path repetition rule, so it solves the same
// minimax problem the engine does (see the comment in oracle()).
console.log('PVS soundness (independent minimax oracle)');
// `path` carries the repetition keys of the search-path ancestors (the root
// included, exactly as ChessAI.search pushes the root before recursing).
function oracle(state, depth, alpha, beta, ply, path) {
  const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
  const kingSq = state.board.indexOf(turn + 'K');
  const maximizing = turn === 'w';
  const inChk = Chess.isAttacked(state.board, kingSq, enemy);
  if (state.halfmove >= 100 && !inChk) return 0;
  if (Chess.insufficientMaterial(state.board)) return 0;
  // Search-path repetition: production ChessAI.search scores the FIRST
  // recurrence of any ancestor position (root included) as a draw — the
  // deliberate twofold path heuristic. Model it here with the same key
  // (ChessAI.repKey, ep-normalized identically) and ordering (before the
  // leaf), or the oracle is not solving the same minimax problem: a legal
  // cycle back to an ancestor would score as a static leaf here but 0 in the
  // engine, and an unrelated eval/ordering change that let such a cycle reach
  // the root value would fail this regression despite sound PVS.
  const key = ChessAI.repKey(state);
  for (let j = 0; j < path.length; j++) if (path[j] === key) return 0;
  const legal = [];
  for (const m of Chess.pseudoMoves(state)) {
    const nx = Chess.applyMove(state, m);
    const ks = m.piece[1] === 'K' ? m.to : kingSq;
    if (!Chess.isAttacked(nx.board, ks, enemy)) legal.push(nx);
  }
  if (!legal.length) return inChk ? (maximizing ? -(MATE - ply) : (MATE - ply)) : 0;
  if (depth <= 0) return ChessAI.evaluate(state.board);
  let best = maximizing ? -Infinity : Infinity;
  path.push(key);
  for (const nx of legal) {
    const s = oracle(nx, depth - 1, alpha, beta, ply + 1, path);
    if (maximizing) { if (s > best) best = s; if (best > alpha) alpha = best; }
    else { if (s < best) best = s; if (best < beta) beta = best; }
    if (beta <= alpha) break;
  }
  path.pop();
  return best;
}
const PVS_FEN = 'r1b1k1nr/pppp1p1p/4pqpb/6N1/3n4/2N1P1P1/PPPP3P/R1BQKB1R w KQkq - 4 9';
const pvsState = Chess.parseFen(PVS_FEN);
const vOracle = oracle(pvsState, 4, -Infinity, Infinity, 0, []);   // independent truth
const vFull = ChessAI.search(pvsState, 4, -Infinity, Infinity, false); // PVS full window
check(vFull === vOracle, 'PVS full-window value equals independent minimax', 'oracle=' + vOracle + ' pvs=' + vFull);
const scoutBelow = ChessAI.search(pvsState, 4, vOracle - 1, vOracle, false); // must fail high (>= vOracle)
const scoutAbove = ChessAI.search(pvsState, 4, vOracle, vOracle + 1, false); // must fail low (<= vOracle)
check(scoutBelow >= vOracle, 'null-window scout below the true value fails high', 'v=' + vOracle + ' scout=' + scoutBelow);
check(scoutAbove <= vOracle, 'null-window scout above the true value fails low', 'v=' + vOracle + ' scout=' + scoutAbove);
const pvsMove = solve(PVS_FEN, 60000);
check(pvsMove.uci !== '-' && isLegal(PVS_FEN, pvsMove.move),
  'sharp position returns a legal move (quiescence on)', 'got ' + pvsMove.uci);

// --- ABORT unwind: a finite node budget that runs out mid-search must not
// leave stale ancestor keys on a REUSED context, or the next search treats
// them as repetition ancestors and returns a false draw (0). Regression for
// the AI-0 fix to ChessAI.search's path unwinding.
console.log('ABORT unwind (reused finite-budget context)');
(function () {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const fresh = ChessAI.search(Chess.parseFen(START), 1, -Infinity, Infinity, false);
  // Abort a depth-3 search after 3 nodes on a reusable context...
  const ctx = ChessAI.makeCtx(false, Infinity, 3);
  let aborted = false;
  try { ChessAI.search(Chess.parseFen(START), 3, -Infinity, Infinity, false, { ctx: ctx }); }
  catch (e) { aborted = true; }
  check(aborted, 'finite node budget aborts the search', 'expected an ABORT throw');
  check(ctx.path1.length === 0 && ctx.path2.length === 0,
    'ABORT unwinds the search path (no stale ancestors)',
    'path1=' + ctx.path1.length + ' path2=' + ctx.path2.length);
  // ...then replenish the budget and reuse the context: the depth-1 score must
  // match a fresh context, not the poisoned 0 a stale ancestor would force.
  ctx.nodes = 0; ctx.nodeLimit = Infinity;
  const reused = ChessAI.search(Chess.parseFen(START), 1, -Infinity, Infinity, false, { ctx: ctx });
  check(reused === fresh, 'reused context is not poisoned by a prior ABORT',
    'fresh=' + fresh + ' reused=' + reused);
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
