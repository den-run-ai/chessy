/*
 * Chessy analysis core — the provider-neutral ANALYSIS CONTRACT (roadmap
 * #23, Phase 1). Deterministic orchestration on top of the small ai.js hooks
 * (ChessAI.search with ctx.noDelta, ChessAI.principalVariation); no engine
 * internals live here, and coaching orchestration stays out of ai.js.
 *
 *   analyse(state, opts) -> {
 *     engine: { id, version, configHash },
 *     turn, positionFingerprint, wdl: null,
 *     depth, nodes, qnodes, elapsedMs,
 *     scoreCpWhite, scoreCpPlayer, mate: { forWhite, inPlies } | null,
 *     bestLines: [ line, ... ],           // best first, for the side to move
 *     playedLine: line & { rank, amongCandidates } | null,
 *     classification: 'same' | 'different-candidate'
 *                   | 'unknown-equivalence' | null,
 *     stability: { nodeBudgets:[a,b], bestMoveStable } | null
 *   }
 *   line = { move:{from,to,promotion}, uci, san,
 *            scoreCpWhite, scoreCpPlayer, mate, pv:[san], pvUci:[uci] }
 *
 * WHY a separate path from play. The fast play search (PVS + root aspiration
 * + quiescence delta pruning) returns BOUNDS and window-sensitive values that
 * are not comparable move-to-move. For a trustworthy candidate comparison the
 * core re-scores each candidate root under a FULL window with delta pruning
 * DISABLED (ctx.noDelta) at one fixed depth, so every scoreCpWhite is an exact
 * value on the same footing. Player-POV is mirrored from the side to move.
 *
 * Chessy never auto-labels a different move a mistake: classification is only
 * same / a-known-Chessy-candidate / unknown-equivalence. Native MultiPV+WDL
 * from an optional Stockfish pack is what would later justify equivalence.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' || typeof ChessAI === 'undefined') return;

  const ENGINE_ID = 'chessy';
  const ENGINE_VERSION = '1.0.0';
  const MATE = ChessAI.MATE, MATE_NEAR = ChessAI.MATE_NEAR;

  function now() { return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; }
  function mkey(m) { return m.from + ',' + m.to + ',' + (m.promotion || ''); }
  function uci(m) {
    return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  }
  function same(a, b) {
    return !!a && !!b && a.from === b.from && a.to === b.to &&
      (a.promotion || null) === (b.promotion || null);
  }
  // Stable string hash (djb2) — the config hash is provenance, so identical
  // settings always produce the same value across runs and machines.
  function hash(obj) {
    const s = JSON.stringify(obj);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // The same FEN reached with a different repetition history can score
  // differently (a move completing a threefold is a draw), so the cache
  // fingerprint folds in the current position's prior occurrence count.
  function positionFingerprint(state, positions) {
    const key = Chess.positionKey(state);
    return key + '|r' + (positions ? (positions[key] || 0) : 0);
  }

  // Exact WHITE-POV score of the resulting position after `move`, at `depth`,
  // full window, delta pruning off (via the shared ctx). A root move that
  // completes a threefold against the game history is the draw it is.
  function scoreMove(state, move, depth, quiesce, positions, ctx) {
    const next = Chess.applyMove(state, move);
    if (positions && (positions[Chess.positionKey(next)] || 0) >= 2) return { sw: 0, next: next };
    const sw = ChessAI.search(next, depth - 1, -Infinity, Infinity, quiesce, { ctx: ctx });
    return { sw: sw, next: next };
  }

  function mateOf(sw) {
    if (sw > MATE_NEAR) return { forWhite: true, inPlies: MATE - sw };
    if (sw < -MATE_NEAR) return { forWhite: false, inPlies: MATE + sw };
    return null;
  }

  // Assemble one contract line for a candidate move scored at scoreWhite.
  function lineOf(state, move, sw, ctx, pvLen, quiesce, maximizing) {
    const legal = Chess.legalMoves(state);
    const mv = legal.find(function (m) { return same(m, move); });
    const san = Chess.toSan(state, mv, legal);
    const next = Chess.applyMove(state, mv);
    // The line is this move followed by the TT continuation from `next`.
    const cont = ChessAI.principalVariation(next, ctx, Math.max(0, pvLen - 1));
    const pv = [], pvUci = [];
    let s = state, first = mv;
    const chain = [first].concat(cont);
    for (const step of chain) {
      const lg = Chess.legalMoves(s);
      const hit = lg.find(function (m) { return same(m, step); });
      if (!hit) break;
      pv.push(Chess.toSan(s, hit, lg));
      pvUci.push(uci(hit));
      s = Chess.applyMove(s, hit);
    }
    // sw scores the position AFTER this move, so the mate is one ply further
    // from the analysed position than from `next` — count from `state`.
    const mate = mateOf(sw);
    if (mate) mate.inPlies += 1;
    return {
      move: { from: mv.from, to: mv.to, promotion: mv.promotion || null },
      uci: uci(mv), san: san,
      scoreCpWhite: mate ? null : sw,
      scoreCpPlayer: mate ? null : (maximizing ? sw : -sw),
      mate: mate,
      pv: pv, pvUci: pvUci,
      _sort: maximizing ? sw : -sw // player-POV magnitude for ordering
    };
  }

  function analyse(state, opts) {
    opts = opts || {};
    const quiesce = opts.quiesce !== false;
    const scanNodes = opts.nodeLimit || 150000;
    const maxDepth = opts.maxDepth || 30;
    const multiPV = Math.max(1, opts.multiPV || 3);
    const pvLen = opts.pvLen || 6;
    const positions = opts.positions || null;
    const played = opts.playedMove || null;
    const version = opts.engineVersion || ENGINE_VERSION;
    const turn = state.turn, maximizing = turn === 'w';

    const configHash = hash({ v: version, quiesce: quiesce, scanNodes: scanNodes,
      maxDepth: maxDepth, multiPV: multiPV, pvLen: pvLen, noDelta: true });
    const out = {
      engine: { id: ENGINE_ID, version: version, configHash: configHash },
      turn: turn, positionFingerprint: positionFingerprint(state, positions), wdl: null,
      depth: 0, nodes: 0, qnodes: 0, elapsedMs: 0,
      scoreCpWhite: null, scoreCpPlayer: null, mate: null,
      bestLines: [], playedLine: null, classification: null, stability: null
    };
    const status = Chess.gameStatus(Object.assign({}, state, { positions: positions || {} }));
    if (status.over) return out; // terminal: no move to analyse

    const t0 = now();
    // 1) Scan to fix the analysis depth and the primary node counters.
    const scan = ChessAI.think(state, { maxDepth: maxDepth, nodeLimit: scanNodes,
      quiesce: quiesce, positions: positions, randomize: false });
    const depth = Math.max(1, scan.depth);
    out.depth = depth; out.nodes = scan.nodes; out.qnodes = scan.qnodes;

    const legal = Chess.legalMoves(state);
    // 2) Preselect candidates: a cheap shallow full-window (delta-off) rank,
    //    plus the scan's best move and the played move, so the exact
    //    deep-verify below never misses the move actually chosen or played.
    const shDepth = Math.min(2, depth);
    const shCtx = ChessAI.makeCtx(quiesce, Infinity); // no node cap: shallow, deterministic
    shCtx.noDelta = true;
    const ranked = legal.map(function (m) {
      return { m: m, sw: scoreMove(state, m, shDepth, quiesce, positions, shCtx).sw };
    });
    ranked.sort(function (a, b) { return (maximizing ? b.sw - a.sw : a.sw - b.sw); });
    const pick = {};
    ranked.slice(0, multiPV).forEach(function (r) { pick[mkey(r.m)] = true; });
    if (scan.move) pick[mkey(scan.move)] = true;
    let playedObj = null;
    if (played) {
      playedObj = legal.find(function (m) { return same(m, played); });
      if (playedObj) pick[mkey(playedObj)] = true;
    }

    // 3) Deep-verify the chosen set at `depth`, exact and comparable.
    const ctx = ChessAI.makeCtx(quiesce, Infinity, opts.verifyNodeLimit || 2000000);
    ctx.noDelta = true;
    const scored = [];
    for (const m of legal) {
      if (!pick[mkey(m)]) continue;
      let sw;
      try { sw = scoreMove(state, m, depth, quiesce, positions, ctx).sw; }
      catch (e) { continue; } // node-budget abort: omit (deterministic by order)
      scored.push(lineOf(state, m, sw, ctx, pvLen, quiesce, maximizing));
    }
    scored.sort(function (a, b) { return b._sort - a._sort; });

    out.bestLines = scored.slice(0, multiPV).map(strip);
    if (out.bestLines.length) {
      const top = out.bestLines[0];
      out.scoreCpWhite = top.scoreCpWhite;
      out.scoreCpPlayer = top.scoreCpPlayer;
      out.mate = top.mate;
    }

    if (playedObj) {
      const rank = scored.findIndex(function (l) { return same(l.move, playedObj); });
      if (rank >= 0) {
        const pl = strip(scored[rank]);
        pl.rank = rank + 1;
        pl.amongCandidates = rank < out.bestLines.length;
        out.playedLine = pl;
      }
      // Classification — never an automatic "mistake" verdict.
      if (out.bestLines.length && same(out.bestLines[0].move, playedObj)) {
        out.classification = 'same';
      } else if (out.playedLine && out.playedLine.amongCandidates) {
        out.classification = 'different-candidate';
      } else {
        out.classification = 'unknown-equivalence';
      }
    }

    // 4) Stability: does the best move hold as the fixed-node budget grows?
    const bigNodes = opts.stabilityNodeLimit || scanNodes * 2;
    const scan2 = ChessAI.think(state, { maxDepth: maxDepth, nodeLimit: bigNodes,
      quiesce: quiesce, positions: positions, randomize: false });
    out.stability = { nodeBudgets: [scanNodes, bigNodes],
      bestMoveStable: same(scan.move, scan2.move) };

    out.elapsedMs = now() - t0;
    return out;
  }

  // Drop the private _sort field from a line before it leaves the module.
  function strip(line) {
    const c = {};
    for (const k in line) if (k !== '_sort') c[k] = line[k];
    return c;
  }

  global.ChessyAnalysisCore = {
    analyse: analyse,
    positionFingerprint: positionFingerprint,
    ENGINE_ID: ENGINE_ID,
    ENGINE_VERSION: ENGINE_VERSION
  };
})(typeof window !== 'undefined' ? window : globalThis);
