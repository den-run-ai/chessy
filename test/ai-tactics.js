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

function solveDepth(fen, depth, nodes, seed) {
  const opts = { maxDepth: depth, quiesce: true };
  if (nodes != null) opts.nodeLimit = nodes;
  if (seed == null) opts.randomize = false; else opts.seed = seed;
  const r = ChessAI.think(Chess.parseFen(fen), opts);
  return {
    uci: r.move ? Chess.sqName(r.move.from) + Chess.sqName(r.move.to) + (r.move.promotion || '') : '-',
    score: r.score, depth: r.depth, nodes: r.nodes, move: r.move
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
  // (non-capturing) check. quiesceNode's bounded quiet-check extension is what
  // lets a shallow search PROVE the deeper two mates within the budgets below —
  // remove the extension (QCHECK_PLIES = 0) and both requireMate assertions
  // bite: the mate-in-2 is scored by material at depth 2 (~-444, not a mate)
  // and the mate-in-3 is not found until a whole extra main-search ply (the
  // engine plays Ng4 for ~-228 at 150k nodes instead of Ne7+). The node budgets
  // sit in a machine-independent (deterministic, randomize:false) window: wide
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

// --- Original-game positional decisions before the final tactical blunder.
// Moves 18 and 25 are restraint guards: current main already avoids the two
// historical choices, so the evaluation change must not reopen them. Move 26
// is the direct oracle-regret correction: only ...g6 is independently accepted.
console.log('tracked Master decisions (game chessy202607240238)');
(function () {
  const decisions = [
    {
      name: 'move 18 avoids ...Qg5',
      fen: 'r3r1k1/1pp2ppp/4n2q/p1bpPN2/8/2PB2B1/PP4PP/R3Q2K b - - 1 18',
      avoid: 'h6g5'
    },
    {
      name: 'move 25 avoids ...Bb6',
      fen: 'r3r1k1/1ppq1ppp/4n3/3pPN2/1P1b3B/3B3P/P3Q1P1/2R4K b - - 4 25',
      avoid: 'd4b6'
    }
  ];
  for (const spec of decisions) {
    for (const flip of [false, true]) {
      const fen = flip ? mirrorFen(spec.fen) : spec.fen;
      const bad = flip ? mirrorMove(spec.avoid) : spec.avoid;
      const r = solveDepth(fen, 5);
      const suffix = flip ? ' (mirrored)' : '';
      check(r.depth === 5, spec.name + suffix + ' [depth 5 completes]',
        'completed d' + r.depth + ' in ' + r.nodes + ' nodes');
      check(isLegal(fen, r.move) && r.uci !== bad, spec.name + suffix,
        'played ' + r.uci + ' in ' + r.nodes + ' nodes');
    }
  }

  const fen26 = 'r3r1k1/1ppq1ppp/1b2n3/3pPN2/1P4QB/3B3P/P5P1/2R4K b - - 6 26';
  for (const flip of [false, true]) {
    const fen = flip ? mirrorFen(fen26) : fen26;
    const required = flip ? 'g2g3' : 'g7g6';
    const r = solveDepth(fen, 5, 190000);
    const suffix = flip ? ' (mirrored)' : '';
    check(r.depth === 5, 'move 26 completes depth 5 within 190k nodes' + suffix,
      'completed d' + r.depth + ' in ' + r.nodes + ' nodes');
    check(isLegal(fen, r.move) && r.uci === required,
      'move 26 chooses the accepted defence ' + required + suffix,
      'played ' + r.uci + ' (d' + r.depth + ', ' + r.nodes + ' nodes)');
  }
})();

// --- Horizon quiet-mate defence (regression for game log chessy202607240238).
// At the old 2s Master budget the engine completed only depth 5 and played
// 27...Rxa2??, walking into the forced 28.Ne7+ Rxe7 29.Qh7+ Kf8 30.Qh8#. The
// mating blow Qh8# is a QUIET check one ply past a captures-only quiescence
// horizon, so the depth-5 leaf scored the position by its (still winning!)
// material and grabbed a2. quiesceNode's bounded quiet-check extension now sees
// it. Ground truth is an INDEPENDENT exact forced-mate solver (full width, no
// evaluation, memoised) — never the engine under test — so the assertion is
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
  // Exhaustive use of the independent solver above found exactly these moves
  // avoid a forced mate inside the tracked five-ply horizon.
  const safe = new Set(['f7f6', 'g7g6', 'g7g5', 'e6f8', 'e6g5']);
  const safeMirror = new Set(['f2f3', 'g2g3', 'g2g4', 'e3f1', 'e3g4']);
  // Independent deterministic ceilings per completed depth. The mirrored
  // position gets separate headroom because generation-order node counts are
  // not mirror invariant. These are algorithmic gates, not a wall-clock proxy;
  // test/ai-master.js separately runs the literal production 5-second budget.
  const limits = {
    original: [0, 0, 5500, 12000, 50000, 200000],
    mirror:   [0, 0, 6000, 12000, 57000, 200000]
  };
  let finalOriginal = null;
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

    const allowed = flip ? safeMirror : safe;
    const budget = flip ? limits.mirror : limits.original;
    for (let depth = 2; depth <= 5; depth++) {
      // Depth 3 is the production-critical shallow decision, so also vary the
      // seeded root shuffle. Deeper iterations converge to the same order.
      const seeds = depth === 3 ? [null, 0, 1, 0xC0FFEE] : [null];
      for (const seed of seeds) {
        const r = solveDepth(f, depth, budget[depth], seed);
        const suffix = (flip ? ' mirrored' : '') + ' d' + depth +
          (seed == null ? '' : ' seed ' + seed);
        check(r.depth === depth, 'move 27 completes' + suffix + ' within ' + budget[depth] + ' nodes',
          'completed d' + r.depth + ' in ' + r.nodes + ' nodes');
        check(isLegal(f, r.move) && allowed.has(r.uci),
          'move 27 chooses a solver-safe defence at' + suffix,
          'played ' + r.uci + ' (' + r.nodes + ' nodes)');
        if (!flip && depth === 5) finalOriginal = { state: st, result: r };
      }
    }
  }
  // Exact full-width proof on the canonical depth-5 choice. The static safe
  // set makes every shallower/mirrored gate cheap; this guards the set's use
  // against a future search returning an unclassified mate-allowing move.
  check(finalOriginal && !forcesMate(
    Chess.applyMove(finalOriginal.state, finalOriginal.result.move), MATE_PLIES),
  'canonical depth-5 choice allows no forced mate in ' + MATE_PLIES,
  finalOriginal ? 'chose ' + finalOriginal.result.uci : 'depth 5 did not complete');
})();

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

  // (c) Control: with neither repetition seeded, the same evasion remains a
  // decisive non-draw. It need not equal the immediate static evaluation:
  // bounded quiet checks may improve the quiescence value beyond that leaf.
  ctx = ChessAI.makeCtx(true, Infinity);
  const vFree = ChessAI.search(S, 0, -Infinity, Infinity, true, { ctx: ctx });
  check(vFree > 0, 'without a repetition quiescence keeps the winning score',
    'value ' + vFree + ' (static evaluation ' + matVal + ')');
})();

// --- Null-window scout vs a warm, wide-window TT (regression). With delta
// pruning removed, a quiescence-derived TT score is a sound alpha-beta bound
// servable to any window; this pins that invariant so a future selective
// pruning cannot silently reintroduce window-sensitive TT scores. Invariant: a
// null scout that reuses a warm, wide-window-populated context must return
// exactly what a FRESH-context scout returns.
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
  // A tuned piece-square evaluation gives the side to move a few-centipawn
  // zugzwang disadvantage here (it must step its king off the ideal square),
  // so the static score is a small nonzero rather than exactly 0. That does
  // not endanger the fortress — a full playout from this position stays a
  // draw (neither king can break through the locked pawns) — so the assertion
  // is that the score is within a fraction of the smallest positional term of
  // a draw, not bit-exactly 0.
  check(Math.abs(r.score) <= 8, name, 'score ' + r.score + ' (d' + r.depth + ')');
}

// --- PVS soundness vs an INDEPENDENT minimax oracle (regression) ---
// The property that must hold: PVS introduces no false fail-low/high. Scope:
// with delta pruning removed the search is an EXACT transform of full-window
// alpha-beta over Chessy's SAME completed, bounded tree — not exact chess
// minimax (quiescence still has the QMAX horizon, stand-pat, and the deliberate
// twofold path-repetition rule). So ChessAI.search's full-window value must
// equal a plain alpha-beta over the same tree and a null-window scout must
// bracket it. The reference must NOT come from the code under test. `oracle()`
// below is a plain, self-contained alpha-beta (no PVS, no TT, quiescence OFF)
// over the engine's own evaluation; the quiescence-ON exactness block that
// follows adds a second independent oracle that DOES descend into captures.
// Both reproduce the engine's search-path repetition rule.
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

// --- PVS + aspiration exactness WITH QUIESCENCE (permanent regression) ---
// The play search runs quiescence; delta pruning removed, it must equal a
// plain alpha-beta that itself descends into captures. `oracleQ` is that
// independent witness: alpha-beta to the horizon, then a self-contained
// quiescence mirroring quiesceNode's rules (insufficient material, terminal
// mate/stalemate, 50-move, QMAX=16, stand-pat, capture/promotion filter, check
// evasions and the selective follow-up quiet-mate layer) — but with NO
// delta pruning, NO TT, NO move ordering.
// Ordinary alpha-beta cutoffs and quiescence stand-pat remain (that is what it
// shares with production); it just lacks the selective pruning and TT that make
// production fast, so it is near-exponential and the positions are kept
// shallow/small. Includes BOTH delta-review witnesses, the exact regressions
// that motivated removing delta pruning.
const QMAX_ORACLE = 16;
const QCHECK_PLIES_ORACLE = 2; // mirror ai.js QCHECK_PLIES (bounded quiet-check extension)
function oracleQuiesce(state, alpha, beta, ply, qply, path, afterCheck) {
  if (Chess.insufficientMaterial(state.board)) return 0;
  const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
  const kingSq = state.board.indexOf(turn + 'K');
  const maximizing = turn === 'w';
  const inChk = Chess.isAttacked(state.board, kingSq, enemy);
  const key = ChessAI.repKey(state);
  for (let j = 0; j < path.length; j++) if (path[j] === key) return 0;
  const legal = [];
  for (const m of Chess.pseudoMoves(state)) {
    const nx = Chess.applyMove(state, m);
    const ks = m.piece[1] === 'K' ? m.to : kingSq;
    if (!Chess.isAttacked(nx.board, ks, enemy)) legal.push([m, nx]);
  }
  if (!legal.length) return inChk ? (maximizing ? -(MATE - ply) : (MATE - ply)) : 0;
  if (state.halfmove >= 100) return 0;
  if (qply >= QMAX_ORACLE) return ChessAI.evaluate(state.board);
  let best;
  if (inChk) { best = maximizing ? -Infinity : Infinity; }
  else {
    best = ChessAI.evaluate(state.board);
    if (maximizing) { if (best >= beta) return best; if (best > alpha) alpha = best; }
    else { if (best <= alpha) return best; if (best < beta) beta = best; }
  }
  path.push(key);
  // Same selective quiet-check extension as quiesceNode: all quiet checks at
  // qply 0; after a forced check evasion, only an immediate quiet mate at qply 1.
  // `legal` already carries each move's applied state.
  const genChecks = qply < QCHECK_PLIES_ORACLE && (qply === 0 || afterCheck);
  const moves = inChk ? legal : legal.filter(function (e) {
    if (e[0].captured || e[0].promotion) return true;
    if (!genChecks) return false;
    if (!Chess.isAttacked(e[1].board, e[1].board.indexOf(enemy + 'K'), turn)) return false;
    return qply === 0 || Chess.legalMoves(e[1]).length === 0;
  });
  for (const e of moves) {
    const s = oracleQuiesce(e[1], alpha, beta, ply + 1, qply + 1, path, inChk);
    if (maximizing) { if (s > best) best = s; if (best > alpha) alpha = best; }
    else { if (s < best) best = s; if (best < beta) beta = best; }
    if (beta <= alpha) break;
  }
  path.pop();
  return best;
}
function oracleQ(state, depth, alpha, beta, ply, path) {
  const turn = state.turn, enemy = turn === 'w' ? 'b' : 'w';
  const kingSq = state.board.indexOf(turn + 'K');
  const maximizing = turn === 'w';
  const inChk = Chess.isAttacked(state.board, kingSq, enemy);
  if (state.halfmove >= 100 && !inChk) return 0;
  if (Chess.insufficientMaterial(state.board)) return 0;
  const key = ChessAI.repKey(state);
  for (let j = 0; j < path.length; j++) if (path[j] === key) return 0;
  if (depth <= 0) return oracleQuiesce(state, alpha, beta, ply, 0, path, false);
  const legal = [];
  for (const m of Chess.pseudoMoves(state)) {
    const nx = Chess.applyMove(state, m);
    const ks = m.piece[1] === 'K' ? m.to : kingSq;
    if (!Chess.isAttacked(nx.board, ks, enemy)) legal.push(nx);
  }
  if (!legal.length) return inChk ? (maximizing ? -(MATE - ply) : (MATE - ply)) : 0;
  // Mirror searchNode: checkmate outranks the 50-move rule (handled by the
  // terminal test above), but once a legal evasion is confirmed the 50-move
  // draw stands even in check. (The !inChk case returned 0 at entry.)
  if (state.halfmove >= 100) return 0;
  let best = maximizing ? -Infinity : Infinity;
  path.push(key);
  for (const nx of legal) {
    const s = oracleQ(nx, depth - 1, alpha, beta, ply + 1, path);
    if (maximizing) { if (s > best) best = s; if (best > alpha) alpha = best; }
    else { if (s < best) best = s; if (best < beta) beta = best; }
    if (beta <= alpha) break;
  }
  path.pop();
  return best;
}
console.log('PVS + aspiration exactness (quiescence on)');
const Q_CASES = [
  // both delta-review witnesses (d0 = pure quiescence, the exact regressions;
  // d1/d2 = alpha-beta feeding quiescence)
  ['k7/2K5/8/8/4q3/3P4/PP3PPP/RNBQ1BNR w - - 0 1', 0],
  ['k7/2K5/8/8/4q3/3P4/PP3PPP/RNBQ1BNR w - - 0 1', 1],
  ['k7/2K5/8/8/4q3/3P4/PP3PPP/RNBQ1BNR w - - 0 1', 2],
  ['k7/4Rb2/r1p4P/5P2/3PKp1p/7P/Pp4B1/1R6 w - - 5 45', 0],
  ['k7/4Rb2/r1p4P/5P2/3PKp1p/7P/Pp4B1/1R6 w - - 5 45', 1],
  ['k7/4Rb2/r1p4P/5P2/3PKp1p/7P/Pp4B1/1R6 w - - 5 45', 2],
  [PVS_FEN, 2],
  // in check AT the 50-move boundary with a legal evasion (Kxg2): checkmate
  // would outrank the rule, but a mere evasion leaves the draw standing, so
  // both oracle and production must score 0 — exercises oracleQ's fifty-move
  // branch after confirming a legal move.
  ['6k1/8/8/8/8/8/6q1/7K w - - 100 60', 2]
];
for (const [fen, d] of Q_CASES) {
  const st = Chess.parseFen(fen);
  const vO = oracleQ(st, d, -Infinity, Infinity, 0, []);
  const vP = ChessAI.search(st, d, -Infinity, Infinity, true);       // PVS, quiescence on
  check(vP === vO, 'PVS+quiescence value equals independent AB+quiescence (' + fen.slice(0, 16) + ' d' + d + ')',
    'oracle=' + vO + ' pvs=' + vP);
  // null-window scouts must bracket the true value
  check(ChessAI.search(st, d, vO - 1, vO, true) >= vO,
    'q-scout below the true value fails high (' + fen.slice(0, 12) + ' d' + d + ')', 'v=' + vO);
  check(ChessAI.search(st, d, vO, vO + 1, true) <= vO,
    'q-scout above the true value fails low (' + fen.slice(0, 12) + ' d' + d + ')', 'v=' + vO);
  // aspiration (think's root loop) must reproduce the same completed-depth score
  const t = ChessAI.think(st, { maxDepth: d < 1 ? 1 : d, quiesce: true, randomize: false });
  if (d >= 1) check(t.score === vO, 'aspiration completed-depth score equals the oracle (' + fen.slice(0, 12) + ' d' + d + ')',
    'oracle=' + vO + ' think=' + t.score);
}

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
