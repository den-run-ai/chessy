/*
 * Chessy analysis core — the provider-neutral ANALYSIS CONTRACT (roadmap
 * #23, Phase 1). Deterministic orchestration on top of two minimal ai.js
 * seams (ctx.noDelta, ChessAI.ttPackedMove); no engine internals or PV logic
 * live in ai.js, and coaching orchestration stays out of it.
 *
 *   analyse(state, opts) -> {
 *     engine: { id, version, configHash },
 *     turn, positionFingerprint, wdl: null, complete,
 *     depth, nodes, qnodes, elapsedMs,
 *     scoreCpWhite, scoreCpPlayer, mate: { forWhite, inPlies } | null,
 *     bestLines: [ line, ... ],           // TRUE final-depth MultiPV, best first
 *     playedLine: line & { rank, amongCandidates } | null,
 *     classification: 'same' | 'different-candidate'
 *                   | 'unknown-equivalence' | null,
 *     stability: { depths:[a,b], bestMoveStable } | null
 *   }
 *   line = { move:{from,to,promotion}, uci, san,
 *            scoreCpWhite, scoreCpPlayer, mate, pv:[san], pvUci:[uci] }
 *
 * WHY a separate path from play. The play search (PVS + aspiration + delta
 * pruning) returns BOUNDS and window-sensitive values that are not comparable
 * move-to-move. So EVERY legal root move is re-scored under a FULL window with
 * delta pruning OFF at one fixed depth — bestLines is therefore real MultiPV,
 * not a shortlist. The search is seeded with the game's COMPLETE repetition
 * table (and the pre-move position as a path ancestor), so deeper candidate
 * lines see threefold draws; the play POV is mirrored from the side to move.
 *
 * Chessy never auto-labels a move a mistake: classification is only same /
 * a-known-Chessy-candidate / unknown-equivalence.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessAI === 'undefined') return;

  const ENGINE_ID = 'chessy';
  const ENGINE_VERSION = '1.0.0';
  const MATE = ChessAI.MATE, MATE_NEAR = ChessAI.MATE_NEAR;
  const PROMO = { 1: 'Q', 2: 'R', 3: 'B', 4: 'N' };
  const ABORTED = {}; // sentinel: a candidate search hit the node-budget cap

  function now() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }
  function uci(m) {
    return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  }
  function same(a, b) {
    return !!a && !!b && a.from === b.from && a.to === b.to &&
      (a.promotion || null) === (b.promotion || null);
  }
  // Stable string hash (djb2): provenance/fingerprints must be identical
  // across runs and machines for the same inputs.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // The COMPLETE state identity that can change the analysis, not just the
  // board: (1) positionKey omits the HALFMOVE CLOCK, but the 50-move rule
  // makes the same board at halfmove 0 vs 99 score differently, so the clock
  // is folded in; (2) the same FEN reached with a different history can score
  // differently (a move completing a threefold is a draw), so every prior
  // occurrence count folds in too. Reps are sorted so the hash is
  // order-independent.
  function positionFingerprint(state, positions) {
    const key = Chess.positionKey(state);
    let rep = '';
    if (positions) {
      rep = Object.keys(positions).filter(function (k) { return positions[k] > 0; })
        .sort().map(function (k) { return k + '=' + positions[k]; }).join(';');
    }
    return key + '|hm' + (state.halfmove || 0) + '|' + hash(rep);
  }

  // Seed a shared analysis context: delta pruning OFF, the game's repetition
  // counts loaded so deep lines detect threefolds, and a safety node cap so a
  // pathological position can't run unbounded (its use flips `complete`).
  function analysisCtx(quiesce, positions, nodeBudget) {
    const ctx = ChessAI.makeCtx(quiesce, Infinity, nodeBudget);
    ctx.noDelta = true;
    if (positions) {
      for (const k of Object.keys(positions)) {
        if (positions[k] > 0) ctx.gameCounts.set(ChessAI.repKey(Chess.parseFen(k)), positions[k]);
      }
    }
    return ctx;
  }

  // Exact WHITE-POV score of the position after `move`, searched at total
  // depth `depth` under a full window with delta off. `beforeFen` is pushed as
  // a path ancestor so a line returning to the pre-move position is the draw
  // it is. Returns ABORTED if the shared node budget ran out.
  function scoreMove(state, beforeFen, move, depth, quiesce, ctx) {
    const next = Chess.applyMove(state, move);
    try {
      return ChessAI.search(next, depth - 1, -Infinity, Infinity, quiesce,
        { ctx: ctx, ancestors: [beforeFen] });
    } catch (e) { return ABORTED; }
  }

  // Mate distance in plies FROM the analysed position. sw scores the child
  // after the candidate move, searched with ONE seeded ancestor (ply base 1),
  // so |sw| = MATE - plyOfMate already counts the candidate ply: the distance
  // from the analysed position is exactly MATE - |sw| (no extra +1). For a
  // mate-in-one (…Qh4#, sw = -(MATE-1)) this is 1.
  function mateOf(sw) {
    if (sw > MATE_NEAR) return { forWhite: true, inPlies: MATE - sw };
    if (sw < -MATE_NEAR) return { forWhite: false, inPlies: MATE + sw };
    return null;
  }

  // Walk the TT into a LEGAL principal variation: decode each packed best move,
  // replay it, stop at a missing/illegal entry or a repeat (a cached cycle).
  // All decode/legality lives here, not in ai.js.
  function pvFromTT(state, ctx, maxLen) {
    const pv = [], pvUci = [], seen = new Set();
    let s = state;
    for (let i = 0; i < maxLen; i++) {
      const key = ChessAI.hashKey(s);
      if (seen.has(key)) break;
      seen.add(key);
      const packed = ChessAI.ttPackedMove(ctx, s);
      if (!packed) break;
      const from = (packed >> 9) & 63, to = (packed >> 3) & 63, pi = packed & 7;
      const promo = pi ? PROMO[pi] : null;
      const legal = Chess.legalMoves(s);
      const m = legal.find(function (x) {
        return x.from === from && x.to === to && (x.promotion || null) === promo;
      });
      if (!m) break;
      pv.push(Chess.toSan(s, m, legal));
      pvUci.push(uci(m));
      s = Chess.applyMove(s, m);
    }
    return { pv: pv, pvUci: pvUci };
  }

  function lineOf(state, move, sw, ctx, pvLen, maximizing) {
    const legal = Chess.legalMoves(state);
    const mv = legal.find(function (m) { return same(m, move); });
    const san = Chess.toSan(state, mv, legal);
    const cont = pvFromTT(Chess.applyMove(state, mv), ctx, Math.max(0, pvLen - 1));
    const mate = mateOf(sw);
    return {
      move: { from: mv.from, to: mv.to, promotion: mv.promotion || null },
      uci: uci(mv), san: san,
      scoreCpWhite: mate ? null : sw,
      scoreCpPlayer: mate ? null : (maximizing ? sw : -sw),
      mate: mate,
      pv: [san].concat(cont.pv), pvUci: [uci(mv)].concat(cont.pvUci),
      _sort: maximizing ? sw : -sw // player-POV magnitude for ordering
    };
  }

  function strip(line) {
    const c = {};
    for (const k in line) if (k !== '_sort') c[k] = line[k];
    return c;
  }

  function analyse(state, opts) {
    opts = opts || {};
    const quiesce = opts.quiesce !== false;
    const scanNodes = opts.nodeLimit || 150000;
    const maxDepth = opts.maxDepth || 30;
    const multiPV = Math.max(1, opts.multiPV || 3);
    const pvLen = opts.pvLen || 6;
    // Safety cap for the deep-verify (all legal roots, uncapped otherwise):
    // hitting it flips `complete` to false rather than silently dropping moves.
    const nodeBudget = opts.nodeBudget || 8000000;
    // A full game state carries its own repetition table; fall back to it (as
    // ChessAI.think does) so analyse(state) on a completed threefold is
    // terminal and deep lines see draws — the fingerprint, terminal check,
    // scan and verification all use this same resolved table.
    const positions = opts.positions || state.positions || null;
    const played = opts.playedMove || null;
    const version = opts.engineVersion || ENGINE_VERSION;
    const turn = state.turn, maximizing = turn === 'w';

    // Hash EVERY output-affecting option.
    const configHash = hash(JSON.stringify({ v: version, quiesce: quiesce,
      scanNodes: scanNodes, maxDepth: maxDepth, multiPV: multiPV, pvLen: pvLen,
      nodeBudget: nodeBudget, noDelta: true }));
    const out = {
      engine: { id: ENGINE_ID, version: version, configHash: configHash },
      turn: turn, positionFingerprint: positionFingerprint(state, positions),
      wdl: null, complete: true,
      depth: 0, nodes: 0, qnodes: 0, elapsedMs: 0,
      scoreCpWhite: null, scoreCpPlayer: null, mate: null,
      bestLines: [], playedLine: null, classification: null, stability: null
    };
    const status = Chess.gameStatus(Object.assign({}, state, { positions: positions || {} }));
    if (status.over) return out; // terminal: no move to analyse

    const t0 = now();
    // 1) Scan (repetition-aware, deterministic) to fix the analysis depth.
    const scan = ChessAI.think(state, { maxDepth: maxDepth, nodeLimit: scanNodes,
      quiesce: quiesce, positions: positions, randomize: false });
    const depth = Math.max(1, scan.depth);
    out.depth = depth; out.nodes = scan.nodes; out.qnodes = scan.qnodes;

    const beforeFen = Chess.toFen(state);
    const legal = Chess.legalMoves(state);
    // 2) Deep-verify EVERY legal root move at the completed depth (scoring all
    //    roots, not a shortlist, makes bestLines true MultiPV) and, one depth
    //    shallower, on a SEPARATE context so the stability pass never overwrites
    //    the deep transposition table before the PV is read from it. The PV for
    //    each move is captured from the deep TT immediately after its own deep
    //    search, so it always matches the score it is shown with.
    const deep = analysisCtx(quiesce, positions, nodeBudget);
    const shallow = analysisCtx(quiesce, positions, nodeBudget);
    const scored = [];
    let bestPrev = null, bestPrevScore = null;
    for (const m of legal) {
      const swD = scoreMove(state, beforeFen, m, depth, quiesce, deep);
      if (swD === ABORTED) { out.complete = false; break; }
      scored.push(lineOf(state, m, swD, deep, pvLen, maximizing)); // PV from the deep TT
      const swPrev = depth > 1 ? scoreMove(state, beforeFen, m, depth - 1, quiesce, shallow) : swD;
      if (swPrev === ABORTED) { out.complete = false; break; }
      const prevSort = maximizing ? swPrev : -swPrev;
      if (bestPrev === null || prevSort > bestPrevScore) { bestPrevScore = prevSort; bestPrev = m; }
    }
    scored.sort(function (a, b) { return b._sort - a._sort; });
    // Report the FULL work: the scan plus both deep-verify passes, not just the
    // preliminary scan (which is a fraction of the total nodes).
    out.nodes = scan.nodes + deep.nodes + shallow.nodes;
    out.qnodes = scan.qnodes + deep.qnodes + shallow.qnodes;

    out.bestLines = scored.slice(0, multiPV).map(strip);
    if (out.bestLines.length) {
      const top = out.bestLines[0];
      out.scoreCpWhite = top.scoreCpWhite;
      out.scoreCpPlayer = top.scoreCpPlayer;
      out.mate = top.mate;
    }

    // 3) Stability: is the VERIFIED best move the same one depth shallower?
    if (scored.length && bestPrev) {
      out.stability = { depths: [Math.max(1, depth - 1), depth],
        bestMoveStable: same(scored[0].move, bestPrev) };
    }

    // 4) Played-move standing + classification (never an automatic "mistake").
    if (played) {
      const playedObj = legal.find(function (m) { return same(m, played); });
      if (playedObj) {
        const rank = scored.findIndex(function (l) { return same(l.move, playedObj); });
        if (rank >= 0) {
          const pl = strip(scored[rank]);
          pl.rank = rank + 1;
          pl.amongCandidates = rank < out.bestLines.length;
          out.playedLine = pl;
        }
        if (out.bestLines.length && same(out.bestLines[0].move, playedObj)) {
          out.classification = 'same';
        } else if (out.playedLine && out.playedLine.amongCandidates) {
          out.classification = 'different-candidate';
        } else {
          out.classification = 'unknown-equivalence';
        }
      }
    }

    out.elapsedMs = now() - t0;
    return out;
  }

  global.ChessyAnalysisCore = {
    analyse: analyse,
    positionFingerprint: positionFingerprint,
    ENGINE_ID: ENGINE_ID,
    ENGINE_VERSION: ENGINE_VERSION
  };
})(typeof window !== 'undefined' ? window : globalThis);
