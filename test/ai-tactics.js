/*
 * Fixed-node AI regression suite — run with: node test/ai-tactics.js
 *
 * Every search uses the Rust/WASM engine's deterministic root order under a
 * fixed nodeLimit, so results are reproducible and immune to timer noise.
 * Mirrored (rank-flipped, color-swapped) twins of each positional test keep
 * the engine honest about color symmetry. Several tests allow multiple
 * equally-good moves; `avoid` tests assert restraint instead.
 *
 * These complement — never replace — the engine.test.js Tier A assertions.
 */
'use strict';
require('../assets/engine.js');
const WasmAI = require('./wasm-test-engine.js');
const Chess = globalThis.Chess;

const MATE_NEAR = 999000;

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
  const r = WasmAI.searchState(Chess.parseFen(fen), {
    maxDepth: 30, nodeLimit: nodes, quiesce: true,
    positions: positions || null
  });
  return {
    uci: r.move ? Chess.sqName(r.move.from) + Chess.sqName(r.move.to) + (r.move.promotion || '') : '-',
    score: r.score, depth: r.depth, move: r.move
  };
}

function fixed(fen, depth, quiesce, positions, nodeLimit) {
  return WasmAI.fixedSearchState(Chess.parseFen(fen), {
    depth: depth,
    quiesce: quiesce !== false,
    positions: positions || null,
    nodeLimit: nodeLimit || 0
  });
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
  // f8=Q stalemates, f8=B/N cannot win; f8=R and Kf6 both force mate. Two
  // separate facts are asserted so neither is overstated (a 12k budget change
  // must not hide a regression): at the ORIGINAL 12000-node budget the engine
  // still avoids the losing promotions and returns a legal winning move, and
  // only at 20000 nodes does the tuned tapered eval (deeper endgame tables
  // spend the horizon differently) also PROVE the mate score.
  ['picks a winning move at 12k budget (f8=R or Kf6)', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1',
    ['f7f8R', 'f5f6'], 12000, ['f7f8Q', 'f7f8B', 'f7f8N']],
  ['proves mate at 20k budget, never f8=Q', '8/5P1k/8/5K2/8/8/8/8 w - - 0 1', null, 20000,
    ['f7f8Q', 'f7f8B', 'f7f8N'], true],
  ['underpromote N, royal fork', '8/2q1P1k1/8/8/8/8/P7/4K3 w - - 0 1', ['e7e8N'], 12000],
  ['take the rook, not the knight', '6k1/8/8/2r3n1/8/4B3/8/6K1 w - - 0 1', ['e3c5'], 8000],
  ['decline the poisoned pawn', '6k1/8/3p4/4p2Q/8/8/8/6K1 w - - 0 1', null, 8000, ['h5e5']],
  ['K+P: only Ke6 keeps the win', '4k3/8/3K4/4P3/8/8/8/8 w - - 0 1', ['d6e6'], 30000],
  // --- Attacker side of the game chessy202607240238 quiet-mate horizon. The
  // regression below guards the DEFENDER (Chessy must not walk into the mate);
  // these guard the ATTACKER (Chessy must SEE it). The forced win is
  // 28.Ne7+ Rxe7 29.Qh7+ Kf8 30.Qh8#, whose final blow Qh8# is a QUIET
  // (non-capturing) check. quiesce_node's bounded quiet-check extension is what
  // lets a shallow search PROVE the deeper two mates within the budgets below —
  // remove the extension (QCHECK_PLIES = 0) and both requireMate assertions
  // bite: the mate-in-2 is scored by material at depth 2 (~-444, not a mate)
  // and the mate-in-3 is not found until a whole extra main-search ply (the
  // engine plays Ng4 for ~-228 at 150k nodes instead of Ne7+). The node budgets
  // sit in a machine-independent deterministic-node window: wide
  // enough above the extension-assisted mate depth to never false-fail, tight
  // enough below the plain-quiescence depth to keep proving the extension is
  // load-bearing. The mate-in-1 is main-search-visible either way and stands as
  // documentation of the motif (and a guard that a quiet mate-in-1 is never
  // lost) — it is the one case the extension does not change.
  ['find the quiet mate Qh8# (mate-in-1)', '5k2/1ppqrppQ/1b2n3/3pP3/1P5B/3B3P/r5P1/2R4K w - - 2 30', ['h7h8'], 4000, null, true],
  ['find the mating attack Qh7+ (mate-in-2)', '6k1/1ppqrpp1/1b2n3/3pP2Q/1P5B/3B3P/r5P1/2R4K w - - 0 29', ['h5h7'], 3000, null, true],
  ['find the mating attack Ne7+ (mate-in-3)', '4r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/r5P1/2R4K w - - 0 28', null, 150000, null, true]
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

// --- Horizon quiet-mate defence (regression for game log chessy202607240238).
// At the old 2s Master budget the engine completed only depth 5 and played
// 27...Rxa2??, walking into the forced 28.Ne7+ Rxe7 29.Qh7+ Kf8 30.Qh8#. The
// mating blow Qh8# is a quiet check one ply past a captures-only quiescence
// horizon. Ground truth is a deliberately small, test-only exact forced-mate
// solver (full width, no evaluation, memoised) — never the engine under test —
// so the assertion is
// "the move Chessy plays allows no forced mate", not "Chessy plays move X".
console.log('horizon quiet-mate defence (game chessy202607240238)');
(function () {
  const memoF = new Map(), memoD = new Map();
  // Legal successors, each tagged with whether the move gives check and a cheap
  // "likely escape" score (king move / capture) used only to order for an
  // earlier cutoff — ordering never changes the exact boolean result.
  function succ(state) {
    const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const out = [];
    for (const m of Chess.pseudoMoves(state)) {
      const nx = Chess.applyMove(state, m);
      const ks = m.piece[1] === 'K' ? m.to : kingSq;
      if (Chess.isAttacked(nx.board, ks, enemy)) continue; // illegal
      out.push({
        nx: nx,
        chk: Chess.isAttacked(nx.board, nx.board.indexOf(enemy + 'K'), turn) ? 1 : 0,
        esc: (m.piece[1] === 'K' ? 1 : 0) + (m.captured ? 1 : 0)
      });
    }
    return out;
  }
  // Can the side to move force checkmate within `plies` plies (attacker and
  // defender moves both counted)? Tries checking moves first to cut off sooner.
  function forcesMate(state, plies) {
    if (plies <= 0) return false;
    const k = Chess.positionKey(state) + '|' + plies;
    const c = memoF.get(k); if (c !== undefined) return c;
    const s = succ(state).sort(function (a, b) { return b.chk - a.chk; });
    let r = false;
    for (const e of s) { if (defenderMated(e.nx, plies - 1)) { r = true; break; } }
    memoF.set(k, r); return r;
  }
  // Is the side to move checkmated now, or unable to avoid forced mate within
  // `plies`? Returns false the moment one reply escapes (likely escapes first).
  function defenderMated(state, plies) {
    const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
    const kingSq = state.board.indexOf(turn + 'K');
    const s = succ(state);
    if (!s.length) return Chess.isAttacked(state.board, kingSq, enemy); // mate vs stalemate
    if (plies <= 0) return false;
    const k = Chess.positionKey(state) + '|' + plies;
    const c = memoD.get(k); if (c !== undefined) return c;
    s.sort(function (a, b) { return b.esc - a.esc; });
    let r = true;
    for (const e of s) { if (!forcesMate(e.nx, plies - 1)) { r = false; break; } }
    memoD.set(k, r); return r;
  }

  const fen = 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27';
  const MATE_PLIES = 5;      // 28.Ne7+ Rxe7 29.Qh7+ Kf8 30.Qh8#
  const blunder = 'a8a2';    // 27...Rxa2??
  for (const flip of [false, true]) {
    const f = flip ? mirrorFen(fen) : fen;
    const bad = flip ? mirrorMove(blunder) : blunder;
    const st = Chess.parseFen(f);
    const badMove = Chess.legalMoves(st).find(function (m) {
      return Chess.sqName(m.from) + Chess.sqName(m.to) === bad;
    });
    // (1) Independent ground truth: the historical move allows a forced mate.
    check(!!badMove && forcesMate(Chess.applyMove(st, badMove), MATE_PLIES),
      'solver: ' + bad + ' allows a forced mate in ' + MATE_PLIES + (flip ? ' (mirrored)' : ''),
      'solver did not confirm the known mate');
    // (2) The engine, at a budget that completes depth 5, does not play it.
    const r = solve(f, 400000);
    check(r.uci !== bad && isLegal(f, r.move),
      'engine avoids the mate-allowing ' + bad + (flip ? ' (mirrored)' : ''),
      'played ' + r.uci + ' (d' + r.depth + ' ' + r.score + ')');
    // (3) Exact guarantee (original only — the no-mate proof is full-width and
    // ~5s): the move actually chosen allows NO forced mate in MATE_PLIES, so
    // this catches any mate-allowing choice, not just the historical blunder.
    if (!flip) {
      check(!forcesMate(Chess.applyMove(st, r.move), MATE_PLIES),
        'engine choice ' + r.uci + ' allows no forced mate in ' + MATE_PLIES,
        'chose ' + r.uci + ', still allows mate');
    }
  }
})();

// --- Conversion: play out a won ending against itself under a small budget.
console.log('conversion');
function convert(name, fen, maxPlies, nodesPerMove) {
  let state = Chess.newGameState(fen);
  let plies = 0;
  let illegal = false;
  while (plies < maxPlies && !Chess.gameStatus(state).over) {
    const r = WasmAI.searchState(state, {
      maxDepth: 30, nodeLimit: nodesPerMove, quiesce: true,
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
// 40k, not 20k: the quiet-check extension searches the winning side's many
// checks in the K+R mating net, so the depth that drives the mop-up costs more
// nodes to reach at a FIXED node budget (real Master play is time-budgeted and
// unaffected). At 20k the check-laden search now drifts to the fifty-move rule.
convert('K+R vs K converts', '8/8/8/4k3/8/8/8/K3R3 w - - 0 1', 60, 40000);

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

// --- Repetition awareness inside quiescence ---
// fenS is Black-to-move in check and its only evasion reaches fenA. A
// depth-zero fixed search therefore reaches fenA from quiescence rather than
// from the main search. Loading two prior fenA occurrences must turn that leaf
// into a history-based draw. The no-history control remains materially winning.
console.log('quiescence repetition');
(function () {
  const fenA = '8/8/8/4k3/8/8/B7/K6Q w - - 6 20';   // Black Ke5, White Ka1/Ba2/Qh1
  const fenS = '8/8/4k3/8/8/8/B7/K6Q b - - 5 20';   // Black Ke6 (in check), Ke5 -> fenA
  const matVal = WasmAI.evaluateState(Chess.parseFen(fenA));
  const history = {};
  history[Chess.positionKey(Chess.parseFen(fenA))] = 2;
  const repeated = fixed(fenS, 0, true, history);
  check(repeated.complete && repeated.score === 0,
    'depth-zero quiescence honors a game-history threefold',
    'complete=' + repeated.complete + ' score=' + repeated.score +
      ' (material would be ' + matVal + ')');

  const free = fixed(fenS, 0, true, {});
  check(free.complete && free.score === matVal,
    'without repetition history the same quiescence leaf is material',
    'complete=' + free.complete + ' score=' + free.score + ' (expected ' + matVal + ')');
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
  // A tuned piece-square evaluation gives the side to move a few-centipawn
  // zugzwang disadvantage here (it must step its king off the ideal square),
  // so the static score is a small nonzero rather than exactly 0. That does
  // not endanger the fortress — a full playout from this position stays a
  // draw (neither king can break through the locked pawns) — so the assertion
  // is that the score is within a fraction of the smallest positional term of
  // a draw, not bit-exactly 0.
  check(Math.abs(r.score) <= 8, name, 'score ' + r.score + ' (d' + r.depth + ')');
}

// --- Iterative search agrees with the exact full-window ABI ---
// The old JavaScript-only tests reached into alpha/beta windows and shared TT
// contexts. Those are private Rust details now. The externally useful
// invariant is that a completed iterative search has the same white-POV score
// as the ABI's deterministic full-window search at that depth.
console.log('iterative/fixed full-window agreement');
for (const [fen, depth] of [
  ['k7/2K5/8/8/4q3/3P4/PP3PPP/RNBQ1BNR w - - 0 1', 1],
  ['k7/4Rb2/r1p4P/5P2/3PKp1p/7P/Pp4B1/1R6 w - - 5 45', 2],
  ['r1b1k1nr/pppp1p1p/4pqpb/6N1/3n4/2N1P1P1/PPPP3P/R1BQKB1R w KQkq - 4 9', 2]
]) {
  const exact = fixed(fen, depth, true, {});
  const iterative = WasmAI.searchState(Chess.parseFen(fen), {
    maxDepth: depth,
    quiesce: true
  });
  check(exact.complete, 'full-window fixed search completes (' + fen.slice(0, 12) +
    ' d' + depth + ')', 'stop ' + exact.stopReason);
  check(iterative.depth === depth && iterative.score === exact.score,
    'iterative score matches fixed full-window score (' + fen.slice(0, 12) +
      ' d' + depth + ')',
    'iterative d' + iterative.depth + '/' + iterative.score +
      ', fixed ' + exact.score);
  check(isLegal(fen, iterative.move),
    'iterative search returns a legal move (' + fen.slice(0, 12) +
      ' d' + depth + ')');
}

// --- Fixed-search abort recovery ---
// A budget abort is an ordinary ABI result, not a thrown sentinel or a
// JavaScript context that callers can inspect. A later call must start clean.
console.log('fixed-search abort recovery');
(function () {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const baseline = fixed(START, 1, false, {});
  const aborted = fixed(START, 3, false, {}, 3);
  check(!aborted.complete && aborted.stopReason === 'node-limit',
    'finite node budget reports an incomplete fixed search',
    'complete=' + aborted.complete + ' stop=' + aborted.stopReason);
  check(aborted.attemptedDepth === 3,
    'aborted fixed search reports its attempted depth',
    'attemptedDepth=' + aborted.attemptedDepth);
  const recovered = fixed(START, 1, false, {});
  check(baseline.complete && recovered.complete && recovered.score === baseline.score,
    'a fixed search after abort starts from clean state',
    'baseline=' + baseline.score + ' recovered=' + recovered.score);
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
