/*
 * Chessy coaching-analysis contract. Search is supplied by the Rust/WASM ABI;
 * this provider-neutral layer owns provenance, exact-root orchestration,
 * canonical SAN/PV formatting, ranking, classification and progress.
 *
 *   analyse(state, opts, wasmEngine) -> {
 *     engine: { id, version, configHash },
 *     turn, positionFingerprint, wdl: null, complete,
 *     depth, nodes, qnodes, elapsedMs,
 *     scoreCpWhite, scoreCpPlayer, mate: { forWhite, inPlies } | null,
 *     bestLines: [ line, ... ], playedLine, classification, stability
 *   }
 *
 * The ordinary iterative WASM search first fixes one completed analysis depth.
 * Every legal root is then re-scored at that depth under an exact full window,
 * making the returned shortlist true MultiPV rather than PVS bounds. A fresh
 * WASM phase repeats the roots one ply shallower for stability. Deep PVs are
 * copied before that reset, so a shallow TT can never overwrite them.
 *
 * `identity`, `configHashOf` and `positionFingerprint` are deliberately pure:
 * the main thread can compute cache identity without loading or running WASM.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined') return;

  const ENGINE_ID = 'chessy-wasm';
  // 2.0.0 changes the coaching provider from the JavaScript search/context to
  // Rust/WASM ABI v2. Scores, depth reached, root ordering and PVs may change,
  // so all earlier cached analyses must be kept under a different identity.
  const ENGINE_VERSION = '2.0.0';
  const PROVIDER_ID = 'rust-wasm-abi-v2';
  const MATE = 1000000;
  const MATE_NEAR = MATE - 1000;
  let injectedEngine = null;

  function now() {
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  }

  function uci(move) {
    return Chess.sqName(move.from) + Chess.sqName(move.to) +
      (move.promotion ? move.promotion.toLowerCase() : '');
  }

  function same(a, b) {
    return !!a && !!b && a.from === b.from && a.to === b.to &&
      (a.promotion || null) === (b.promotion || null);
  }

  // Stable string hash (djb2): provenance/fingerprints must be identical
  // across runs and machines for the same inputs.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  // The same board can analyse differently at another halfmove clock or with
  // another repetition prefix, so both are part of its persistent identity.
  function positionFingerprint(state, positions) {
    const key = Chess.positionKey(state);
    let rep = '';
    if (positions) {
      rep = Object.keys(positions).filter(function (k) { return positions[k] > 0; })
        .sort().map(function (k) { return k + '=' + positions[k]; }).join(';');
    }
    return key + '|hm' + (state.halfmove || 0) + '|' + hash(rep);
  }

  function playedKey(move) {
    return move
      ? move.from + '-' + move.to + '=' + (move.promotion || '')
      : null;
  }

  // Fold every output-affecting option into the cache identity. Runtime-only
  // observation/injection (`onProgress`, the WASM instance) is excluded.
  function configHashOf(opts) {
    opts = opts || {};
    return hash(JSON.stringify({
      v: opts.engineVersion || ENGINE_VERSION,
      provider: PROVIDER_ID,
      quiesce: opts.quiesce !== false,
      scanNodes: opts.nodeLimit || 150000,
      maxDepth: opts.maxDepth || 30,
      multiPV: Math.max(1, opts.multiPV || 3),
      pvLen: opts.pvLen || 6,
      nodeBudget: opts.nodeBudget || 8000000,
      played: playedKey(opts.playedMove),
      noDelta: true
    }));
  }

  function identity(state, opts) {
    opts = opts || {};
    const positions = opts.positions || state.positions || null;
    return {
      engineId: ENGINE_ID,
      version: opts.engineVersion || ENGINE_VERSION,
      configHash: configHashOf(opts),
      positionFingerprint: positionFingerprint(state, positions)
    };
  }

  function mateOf(score) {
    if (score > MATE_NEAR) {
      return { forWhite: true, inPlies: MATE - score };
    }
    if (score < -MATE_NEAR) {
      return { forWhite: false, inPlies: MATE + score };
    }
    return null;
  }

  // Resolve the untrusted packed-move PV copied from WASM through Chess's
  // canonical legal-move and SAN implementation. A corrupt/incompatible ABI
  // is a worker error, never a plausible-looking cached coaching line.
  function canonicalPv(state, moves, maxLen) {
    if (!Array.isArray(moves) || !moves.length) {
      throw new Error('WASM analysis returned an empty PV');
    }
    const pv = [];
    const pvUci = [];
    const seen = new Set();
    let cursor = state;
    const limit = Math.min(maxLen, moves.length);
    for (let i = 0; i < limit; i++) {
      const key = Chess.positionKey(cursor);
      if (seen.has(key)) break;
      seen.add(key);
      const candidate = moves[i];
      const legal = Chess.legalMoves(cursor);
      const move = legal.find(function (m) { return same(m, candidate); });
      if (!move) throw new Error('WASM analysis PV contains an illegal move');
      pv.push(Chess.toSan(cursor, move, legal));
      pvUci.push(uci(move));
      cursor = Chess.applyMove(cursor, move);
    }
    return { pv: pv, pvUci: pvUci };
  }

  function lineOf(state, move, rootResult, pvLen, maximizing) {
    const legal = Chess.legalMoves(state);
    const resolved = legal.find(function (m) { return same(m, move); });
    if (!resolved) throw new Error('WASM analysis returned an unknown root');
    const continuation = canonicalPv(state, rootResult.pv, pvLen);
    if (!continuation.pvUci.length ||
        continuation.pvUci[0] !== uci(resolved)) {
      throw new Error('WASM analysis PV does not match its root');
    }
    const mate = mateOf(rootResult.score);
    return {
      move: {
        from: resolved.from,
        to: resolved.to,
        promotion: resolved.promotion || null
      },
      uci: uci(resolved),
      san: continuation.pv[0],
      scoreCpWhite: mate ? null : rootResult.score,
      scoreCpPlayer: mate ? null :
        (maximizing ? rootResult.score : -rootResult.score),
      mate: mate,
      pv: continuation.pv,
      pvUci: continuation.pvUci,
      _sort: maximizing ? rootResult.score : -rootResult.score
    };
  }

  function strip(line) {
    const copy = {};
    for (const key in line) {
      if (key !== '_sort') copy[key] = line[key];
    }
    return copy;
  }

  function zeroCounters() {
    return { nodes: 0, qnodes: 0 };
  }

  function analyse(state, opts, wasmEngine) {
    opts = opts || {};
    const quiesce = opts.quiesce !== false;
    const scanNodes = opts.nodeLimit || 150000;
    const maxDepth = opts.maxDepth || 30;
    const multiPV = Math.max(1, opts.multiPV || 3);
    const pvLen = opts.pvLen || 6;
    const nodeBudget = opts.nodeBudget || 8000000;
    const positions = opts.positions || state.positions || null;
    const played = opts.playedMove || null;
    const version = opts.engineVersion || ENGINE_VERSION;
    const turn = state.turn;
    const maximizing = turn === 'w';

    const configHash = configHashOf(opts);
    const out = {
      engine: { id: ENGINE_ID, version: version, configHash: configHash },
      turn: turn,
      positionFingerprint: positionFingerprint(state, positions),
      wdl: null,
      complete: true,
      depth: 0,
      nodes: 0,
      qnodes: 0,
      elapsedMs: 0,
      scoreCpWhite: null,
      scoreCpPlayer: null,
      mate: null,
      bestLines: [],
      playedLine: null,
      classification: null,
      stability: null
    };
    const status = Chess.gameStatus(
      Object.assign({}, state, { positions: positions || {} })
    );
    if (status.over) return out;

    wasmEngine = wasmEngine || injectedEngine;
    if (!wasmEngine ||
        typeof wasmEngine.search !== 'function' ||
        typeof wasmEngine.beginAnalysis !== 'function' ||
        typeof wasmEngine.searchRoot !== 'function') {
      throw new Error('Rust/WASM analysis engine is required');
    }

    const t0 = now();
    const fen = Chess.toFen(state);
    const legal = Chess.legalMoves(state);
    let progressElapsed = 0;
    function progress(phase, completedRoots, totalRoots) {
      if (typeof opts.onProgress !== 'function') return;
      const rawElapsed = now() - t0;
      progressElapsed = Math.max(progressElapsed,
        Number.isFinite(rawElapsed) ? Math.max(0, rawElapsed) : 0);
      try {
        opts.onProgress({
          phase: phase,
          completedRoots: completedRoots,
          totalRoots: totalRoots,
          elapsedMs: progressElapsed
        });
      } catch (error) {
        // Progress is observation-only.
      }
    }

    // 1) Repetition-aware deterministic scan: choose the deepest fully
    // completed iterative draft under the scan budget.
    progress('initial-scan', 0, 1);
    const scan = wasmEngine.search(fen, {
      maxDepth: maxDepth,
      nodeLimit: scanNodes,
      timeMs: 0,
      quiesce: quiesce,
      positions: positions
    });
    const depth = Math.max(1, scan.depth);
    out.depth = depth;
    progress('initial-scan', 1, 1);

    // 2) Exact deep phase. One beginAnalysis call gives every legal root a
    // shared TT/heuristics and one cumulative safety budget. Each returned PV
    // is copied into ordinary JS objects before the shallow phase resets WASM.
    progress('root-verification', 0, legal.length);
    wasmEngine.beginAnalysis(fen, {
      nodeLimit: nodeBudget,
      quiesce: quiesce,
      positions: positions
    });
    let deepCounters = zeroCounters();
    const deepLines = [];
    const stabilityDepth = depth > 1 ? depth - 1 : 0;
    for (let i = 0; i < legal.length; i++) {
      const result = wasmEngine.searchRoot(legal[i], depth, pvLen);
      deepCounters = result;
      if (!result.complete) {
        out.complete = false;
        break;
      }
      deepLines.push(lineOf(state, legal[i], result, pvLen, maximizing));
      if (!stabilityDepth) {
        progress('root-verification', deepLines.length, legal.length);
      }
    }

    // 3) Separate shallower phase. Only roots with a valid deep result need a
    // stability score. Progress advances after both depths for that root.
    let shallowCounters = zeroCounters();
    let bestPrev = null;
    let bestPrevScore = null;
    let shallowCompleted = 0;
    let shallowAborted = false;
    if (stabilityDepth && deepLines.length) {
      wasmEngine.beginAnalysis(fen, {
        nodeLimit: nodeBudget,
        quiesce: quiesce,
        positions: positions
      });
      for (let i = 0; i < deepLines.length; i++) {
        const result = wasmEngine.searchRoot(legal[i], stabilityDepth, 1);
        shallowCounters = result;
        if (!result.complete) {
          out.complete = false;
          shallowAborted = true;
          break;
        }
        const playerScore = maximizing ? result.score : -result.score;
        if (bestPrev === null || playerScore > bestPrevScore) {
          bestPrev = legal[i];
          bestPrevScore = playerScore;
        }
        shallowCompleted++;
        progress('root-verification', shallowCompleted, legal.length);
      }
    }

    // Preserve the old partial-result boundary: if the shallow search aborts,
    // its current root has a valid deep line but did not advance progress.
    let scored = deepLines;
    if (shallowAborted) {
      scored = deepLines.slice(0, Math.min(deepLines.length, shallowCompleted + 1));
    }
    scored.sort(function (a, b) { return b._sort - a._sort; });

    out.nodes = scan.nodes + deepCounters.nodes + shallowCounters.nodes;
    out.qnodes = scan.qnodes + deepCounters.qnodes + shallowCounters.qnodes;
    out.bestLines = scored.slice(0, multiPV).map(strip);
    if (out.bestLines.length) {
      const top = out.bestLines[0];
      out.scoreCpWhite = top.scoreCpWhite;
      out.scoreCpPlayer = top.scoreCpPlayer;
      out.mate = top.mate;
    }

    if (stabilityDepth && scored.length && bestPrev) {
      out.stability = {
        depths: [stabilityDepth, depth],
        bestMoveStable: same(scored[0].move, bestPrev)
      };
    }

    if (played) {
      const playedObj = legal.find(function (move) { return same(move, played); });
      if (playedObj) {
        const rank = scored.findIndex(function (line) {
          return same(line.move, playedObj);
        });
        if (rank >= 0) {
          const playedLine = strip(scored[rank]);
          playedLine.rank = rank + 1;
          playedLine.amongCandidates = rank < out.bestLines.length;
          out.playedLine = playedLine;
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
    // Node scorecards run synchronously and share one local WASM instance.
    // Browser production passes its worker-owned instance directly to analyse.
    setEngineForTests: function (engine) { injectedEngine = engine || null; },
    positionFingerprint: positionFingerprint,
    configHashOf: configHashOf,
    identity: identity,
    ENGINE_ID: ENGINE_ID,
    ENGINE_VERSION: ENGINE_VERSION,
    PROVIDER_ID: PROVIDER_ID,
    MATE_NEAR: MATE_NEAR
  };
})(typeof window !== 'undefined' ? window : globalThis);
