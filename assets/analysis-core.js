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
 * Fixed-node requests (quick screening and legacy callers): the ordinary
 * iterative WASM search first fixes one completed analysis depth. Every legal
 * root is then re-scored at that depth under an exact full window, making the
 * returned shortlist true MultiPV rather than PVS bounds. A fresh WASM phase
 * repeats the roots one ply shallower for stability. Deep PVs are copied
 * before that reset, so a shallow TT can never overwrite them.
 *
 * Timed deep requests (`scanTimeMs` > 0): a single-PV PVS scan reaches far
 * deeper than an all-root full-window verification can in a bounded budget,
 * so the scan depth is only a CAP. One exact phase verifies every legal root
 * at depth 1, 2, ... (iterative exact verification). Each iteration shares the
 * phase's TT and orders roots by the previous iteration; exact-depth TT hits
 * make every root score identical to a cold verification at that depth. The
 * result is the deepest FULLY verified iteration, reported at its own depth;
 * the previous iteration supplies stability, and a deeper scan that prefers a
 * move the verified iteration ranks strictly lower marks the best move
 * unstable. Only when not even depth 1 completes is the result partial.
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

  // WASM reports a full fixed transposition table as ABI status 2. The loader
  // tags that one error so bounded iterative verification can stop cleanly.
  const TT_SATURATED = 'tt-saturated';
  // Identity tag of the timed deep algorithm; see configHashOf.
  const ITERATIVE_VERIFY = 'iterative-exact-v1';
  const MIN_TIMED_VERIFY_DEPTH = 3;

  // Quick screening remains cheap. Only the two selected moments, manual
  // verification and Train's live check use DEEP. Its scan gets twice Master's
  // maximum thinking time and caps one shared-TT iterative verification of all
  // roots. Bigger budgets are not a certified Elo claim.
  const PROFILES = Object.freeze({
    quick: Object.freeze({
      maxDepth: 5, nodeLimit: 5000, nodeBudget: 150000, multiPV: 1, pvLen: 3
    }),
    quickFallback: Object.freeze({
      maxDepth: 5, nodeLimit: 12000, nodeBudget: 300000, multiPV: 1, pvLen: 3
    }),
    deep: Object.freeze({
      maxDepth: 111, nodeLimit: 0, scanTimeMs: 16000,
      nodeBudget: 16000000, multiPV: 3, pvLen: 6
    })
  });

  function scanConfig(opts) {
    opts = opts || {};
    const timeMs = opts.scanTimeMs == null ? 0 : opts.scanTimeMs;
    if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 60000) {
      throw new RangeError('scanTimeMs must be an integer from 0 to 60000');
    }
    // Preserve the historical zero/default behavior for untimed callers;
    // unlimited nodes are permitted only with an explicit positive deadline.
    const nodeLimit = opts.nodeLimit === 0 && timeMs > 0
      ? 0 : (opts.nodeLimit || 150000);
    if (!Number.isInteger(nodeLimit) || nodeLimit < 0 || nodeLimit > 0xffffffff) {
      throw new RangeError('analysis scan nodeLimit must be an unsigned integer');
    }
    return { nodeLimit: nodeLimit, timeMs: timeMs };
  }

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
    const scan = scanConfig(opts);
    const config = {
      v: opts.engineVersion || ENGINE_VERSION,
      provider: PROVIDER_ID,
      quiesce: opts.quiesce !== false,
      scanNodes: scan.nodeLimit,
      maxDepth: opts.maxDepth || 30,
      multiPV: Math.max(1, opts.multiPV || 3),
      pvLen: opts.pvLen || 6,
      nodeBudget: opts.nodeBudget || 8000000,
      played: playedKey(opts.playedMove),
      noDelta: true
    };
    // Keep fixed-node cache identities stable; a timed scan is a new contract
    // whose verification algorithm is part of its identity.
    if (scan.timeMs) {
      config.scanTimeMs = scan.timeMs;
      config.verify = ITERATIVE_VERIFY;
    }
    return hash(JSON.stringify(config));
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

  // Rank one iteration for the side to move. Ties fall back to canonical
  // legal-move order, exactly like the fixed-node path, so search order can
  // never make a tied move look "best", "stable" or the same as the played one.
  // Interpret a 'root-verification' progress event for display. Timed deep
  // requests count root searches over depths 1..cap (total = roots × cap);
  // fixed-node requests count each root once (cap 1). Returns null when the
  // counts do not fit that schedule. Pure, and never carries a score.
  function progressView(completedRoots, totalRoots, rootCount) {
    if (!Number.isInteger(rootCount) || rootCount < 1 ||
        !Number.isInteger(totalRoots) || totalRoots < rootCount ||
        totalRoots % rootCount !== 0 ||
        !Number.isInteger(completedRoots) || completedRoots < 0 ||
        completedRoots > totalRoots) return null;
    const cap = totalRoots / rootCount;
    if (completedRoots === totalRoots) {
      return { depth: cap, cap: cap, verified: rootCount, roots: rootCount, done: true };
    }
    return {
      depth: Math.floor(completedRoots / rootCount) + 1,
      cap: cap,
      verified: completedRoots % rootCount,
      roots: rootCount,
      done: false
    };
  }

  function rankForMover(lines, legal) {
    function canonical(line) {
      return legal.findIndex(function (move) { return same(move, line.move); });
    }
    return lines.slice().sort(function (a, b) {
      return b._sort - a._sort || canonical(a) - canonical(b);
    });
  }

  // Timed deep analysis: verify every legal root under a full window at depth
  // 1, 2, ... up to the scan's completed depth, all inside ONE budgeted phase.
  // The shared TT turns each iteration into move ordering for the next, while
  // exact-depth TT hits keep every root score equal to a cold verification at
  // that depth. The deepest iteration whose every root completed is the
  // result; an iteration interrupted by the node budget or a full TT is
  // discarded whole rather than mixed with shallower scores.
  function verifyIteratively(ctx, wasmEngine) {
    function priority(move) {
      return same(move, ctx.scan.move) ? 0 : (same(move, ctx.played) ? 1 : 2);
    }
    // The first iteration visits the scan winner and the played move first.
    let order = ctx.legal.slice().sort(function (a, b) { return priority(a) - priority(b); });
    // Progress counts root searches over the whole planned schedule, so it is
    // monotonic with a fixed total even though every iteration revisits roots.
    const planned = ctx.legal.length * ctx.cap;
    let searched = 0;
    ctx.progress('root-verification', 0, planned);
    wasmEngine.beginAnalysis(ctx.fen, {
      nodeLimit: ctx.nodeBudget,
      quiesce: ctx.quiesce,
      positions: ctx.positions
    });
    let counters = zeroCounters();
    let last = null;
    let prev = null;
    const costs = [];
    let spentBefore = 0;
    for (let depth = 1; depth <= ctx.cap; depth++) {
      // Do not start an iteration that cannot finish: all of its work would
      // be discarded. Alpha-beta costs alternate between odd and even depths,
      // so predict the next iteration from the average growth over the last
      // two (one odd and one even ply): cost × sqrt(cost / cost two plies
      // earlier). Node counts keep the decision deterministic.
      if (costs.length >= 3) {
        const a = costs[costs.length - 3];
        const c = costs[costs.length - 1];
        if (a > 0 && c * Math.sqrt(c / a) > ctx.nodeBudget - counters.nodes) break;
      }
      const lines = [];
      let stopped = false;
      for (let i = 0; i < order.length; i++) {
        let result;
        try {
          result = wasmEngine.searchRoot(order[i], depth, ctx.pvLen);
        } catch (error) {
          if (!error || error.code !== TT_SATURATED) throw error;
          if (error.result) counters = error.result;
          stopped = true;
          break;
        }
        counters = result;
        if (!result.complete) {
          stopped = true;
          break;
        }
        lines.push(lineOf(ctx.state, order[i], result, ctx.pvLen, ctx.maximizing));
        searched++;
        ctx.progress('root-verification', searched, planned);
      }
      if (stopped) break;
      costs.push(counters.nodes - spentBefore);
      spentBefore = counters.nodes;
      prev = last;
      last = { depth: depth, lines: rankForMover(lines, ctx.legal) };
      order = last.lines.map(function (line) {
        return ctx.legal.find(function (move) { return same(move, line.move); });
      });
    }

    let stability = null;
    if (last && prev) {
      // A deeper completed scan that prefers a move this iteration ranks
      // strictly below its best is contrary deeper evidence: unstable.
      const best = last.lines[0];
      const scanLine = ctx.scan.move && last.depth < ctx.scan.depth
        ? last.lines.find(function (line) { return same(line.move, ctx.scan.move); })
        : null;
      const scanAgrees = !scanLine || scanLine._sort === best._sort;
      stability = {
        depths: [prev.depth, last.depth],
        bestMoveStable: same(best.move, prev.lines[0].move) && scanAgrees
      };
    }
    return { last: last, stability: stability, counters: counters };
  }

  function analyse(state, opts, wasmEngine) {
    opts = opts || {};
    const quiesce = opts.quiesce !== false;
    const scanOptions = scanConfig(opts);
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

    // 1) Repetition-aware scan: choose the deepest completed draft. Quick
    // and legacy requests are fixed-node; deep requests have a time ceiling.
    progress('initial-scan', 0, 1);
    const scan = wasmEngine.search(fen, {
      maxDepth: maxDepth,
      nodeLimit: scanOptions.nodeLimit,
      timeMs: scanOptions.timeMs,
      quiesce: quiesce,
      positions: positions
    });
    const depth = Math.max(1, scan.depth);
    out.depth = depth;
    progress('initial-scan', 1, 1);

    let scored;
    let verifyCounters;
    if (scanOptions.timeMs) {
      const verified = verifyIteratively({
        state: state, fen: fen, legal: legal, scan: scan,
        // A scan that stops early (a short mate, or a suspended tab) still
        // gets the cheap depth-3 verification Review needs for stability.
        cap: Math.max(Math.min(depth, maxDepth), Math.min(MIN_TIMED_VERIFY_DEPTH, maxDepth)),
        nodeBudget: nodeBudget,
        quiesce: quiesce, positions: positions, pvLen: pvLen,
        played: played, maximizing: maximizing, progress: progress
      }, wasmEngine);
      verifyCounters = verified.counters;
      if (verified.last) {
        scored = verified.last.lines;
        out.depth = verified.last.depth;
        out.stability = verified.stability;
      } else {
        // Not even depth 1 was verified. The completed scan still supplies
        // one exact legal best root, but NOT a verified MultiPV, continuation,
        // played-move score or stability: keep only that, explicitly partial.
        out.complete = false;
        scored = scan.depth > 0 && scan.move
          ? [lineOf(state, scan.move, { score: scan.score, pv: [scan.move] }, 1, maximizing)]
          : [];
      }
    } else {
      // 2) Exact deep phase. One beginAnalysis call gives every legal root a
      // shared TT/heuristics and one cumulative safety budget. Each returned
      // PV is copied into ordinary JS objects before the shallow phase resets.
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

      // 3) Separate shallower phase. Only roots with a valid deep result need
      // a stability score. Progress advances after both depths for that root.
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

      // Preserve the old partial-result boundary: if the shallow search
      // aborts, its current root has a valid deep line but did not advance
      // progress.
      scored = deepLines;
      if (shallowAborted) {
        scored = deepLines.slice(0, Math.min(deepLines.length, shallowCompleted + 1));
      }
      scored.sort(function (a, b) { return b._sort - a._sort; });
      if (stabilityDepth && scored.length && bestPrev) {
        out.stability = {
          depths: [stabilityDepth, depth],
          bestMoveStable: same(scored[0].move, bestPrev)
        };
      }
      verifyCounters = {
        nodes: deepCounters.nodes + shallowCounters.nodes,
        qnodes: deepCounters.qnodes + shallowCounters.qnodes
      };
    }

    out.nodes = scan.nodes + verifyCounters.nodes;
    out.qnodes = scan.qnodes + verifyCounters.qnodes;
    out.bestLines = scored.slice(0, multiPV).map(strip);
    if (out.bestLines.length) {
      const top = out.bestLines[0];
      out.scoreCpWhite = top.scoreCpWhite;
      out.scoreCpPlayer = top.scoreCpPlayer;
      out.mate = top.mate;
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
    PROFILES: PROFILES,
    scanConfig: scanConfig,
    progressView: progressView,
    TT_SATURATED: TT_SATURATED,
    MATE_NEAR: MATE_NEAR
  };
})(typeof window !== 'undefined' ? window : globalThis);
