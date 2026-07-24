/*
 * Chessy analysis-result trust boundary.
 *
 * Cached/worker/provider analysis is untrusted until it passes this module.
 * Validation is deliberately independent of the DOM and of analysis-core.js:
 * callers supply the expected identity, while Chess supplies the canonical
 * legal-move and SAN implementation.
 */
(function (global, factory) {
  'use strict';

  const api = factory(global && global.Chess);
  if (!api) return;

  global.ChessyAnalysisResult = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function (Chess) {
  'use strict';
  if (!Chess) return null;

  const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const PROMOTIONS = ['Q', 'R', 'B', 'N'];

  function failure(reason) {
    return {
      ok: false,
      reason: reason,
      topMove: null,
      playedMove: null
    };
  }

  function success(extra) {
    return Object.assign({
      ok: true,
      reason: null,
      topMove: null,
      playedMove: null
    }, extra || {});
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function validTurn(turn) {
    return turn === 'w' || turn === 'b';
  }

  function validMate(mate) {
    return !!mate && typeof mate === 'object' &&
      typeof mate.forWhite === 'boolean' &&
      Number.isInteger(mate.inPlies) && mate.inPlies > 0;
  }

  /*
   * An evaluation has exactly one representation:
   *   - a finite White/player centipawn pair with mate === null, or
   *   - a valid mate object with both centipawn fields explicitly null.
   * The player score is checked against the analysed side to move.
   */
  function validEval(value, turn) {
    if (!value || typeof value !== 'object' || !validTurn(turn)) return false;
    if (validMate(value.mate)) {
      return value.scoreCpWhite === null && value.scoreCpPlayer === null;
    }
    if (value.mate !== null) return false;
    if (!Number.isFinite(value.scoreCpWhite) ||
        !Number.isFinite(value.scoreCpPlayer)) return false;
    return value.scoreCpPlayer ===
      (turn === 'w' ? value.scoreCpWhite : -value.scoreCpWhite);
  }

  function sameMove(a, b) {
    return !!a && !!b &&
      a.from === b.from && a.to === b.to &&
      (a.promotion || null) === (b.promotion || null);
  }

  function validMoveShape(move) {
    const promotion = move && move.promotion != null ? move.promotion : null;
    return !!move && typeof move === 'object' &&
      Number.isInteger(move.from) && move.from >= 0 && move.from < 64 &&
      Number.isInteger(move.to) && move.to >= 0 && move.to < 64 &&
      (promotion === null || PROMOTIONS.indexOf(promotion) !== -1);
  }

  function uciOf(move) {
    if (!validMoveShape(move)) return null;
    return Chess.sqName(move.from) + Chess.sqName(move.to) +
      (move.promotion ? move.promotion.toLowerCase() : '');
  }

  function moveFromUci(state, uci, legal) {
    if (typeof uci !== 'string' || !UCI_RE.test(uci)) return null;
    const from = Chess.sqIndex(uci.slice(0, 2));
    const to = Chess.sqIndex(uci.slice(2, 4));
    const promotion = uci.length === 5 ? uci[4].toUpperCase() : null;
    const candidates = legal || Chess.legalMoves(state);
    return candidates.find(function (move) {
      return move.from === from && move.to === to &&
        (move.promotion || null) === promotion;
    }) || null;
  }

  function fullState(state) {
    return !!state && typeof state === 'object' &&
      Array.isArray(state.board) && state.board.length === 64 &&
      validTurn(state.turn) &&
      Array.isArray(state.history) &&
      !!state.positions && typeof state.positions === 'object' &&
      !Array.isArray(state.positions);
  }

  /*
   * Resolve a contract line against a full Chess state. Every UCI/SAN pair is
   * canonical and legal, the root fields agree with pv[0], and a PV cannot
   * continue after checkmate/draw. Full-state replay preserves repetition.
   */
  function resolveLine(state, line) {
    if (!fullState(state)) return failure('source-state');
    if (!line || typeof line !== 'object') return failure('line-shape');
    if (!validMoveShape(line.move)) return failure('line-move');
    if (!Array.isArray(line.pv) || !Array.isArray(line.pvUci) ||
        line.pv.length === 0 || line.pv.length !== line.pvUci.length) {
      return failure('line-pv-shape');
    }
    if (!nonEmptyString(line.uci) || !nonEmptyString(line.san) ||
        line.pvUci[0] !== line.uci || line.pv[0] !== line.san) {
      return failure('line-root');
    }

    let cursor = state;
    let rootMove = null;
    try {
      for (let i = 0; i < line.pvUci.length; i++) {
        if (Chess.gameStatus(cursor).over) {
          return failure(i === 0 ? 'source-terminal' : 'line-past-terminal');
        }
        const legal = Chess.legalMoves(cursor);
        const move = moveFromUci(cursor, line.pvUci[i], legal);
        if (!move || uciOf(move) !== line.pvUci[i]) {
          return failure('line-uci');
        }
        if (Chess.toSan(cursor, move, legal) !== line.pv[i]) {
          return failure('line-san');
        }
        if (i === 0) {
          rootMove = move;
          if (!sameMove(move, line.move) ||
              line.uci !== uciOf(move) ||
              line.san !== Chess.toSan(cursor, move, legal)) {
            return failure('line-root');
          }
        }
        cursor = Chess.playMove(cursor, move);
      }
    } catch (err) {
      return failure('line-resolution');
    }

    return success({ move: rootMove, finalState: cursor });
  }

  function sameMate(a, b) {
    if (a === null || b === null) return a === b;
    return validMate(a) && validMate(b) &&
      a.forWhite === b.forWhite && a.inPlies === b.inPlies;
  }

  function sameEval(a, b) {
    return sameMate(a.mate, b.mate) &&
      a.scoreCpWhite === b.scoreCpWhite &&
      a.scoreCpPlayer === b.scoreCpPlayer;
  }

  // Contract lines are best-first for the side to move. Preserve mate-distance
  // ordering without inventing a centipawn conversion: faster mates for the
  // mover are better; when being mated, delaying it is better.
  function orderValue(value, turn) {
    if (validMate(value.mate)) {
      return value.mate.forWhite === (turn === 'w')
        ? 1000000000 - value.mate.inPlies
        : -1000000000 + value.mate.inPlies;
    }
    return value.scoreCpPlayer;
  }

  function identityFrom(expected) {
    if (!expected || typeof expected !== 'object') return null;
    const identity = expected.identity &&
      typeof expected.identity === 'object' ? expected.identity : expected;
    return {
      engineId: identity.engineId,
      version: identity.version !== undefined ?
        identity.version : identity.engineVersion,
      configHash: identity.configHash,
      positionFingerprint: identity.positionFingerprint
    };
  }

  function validIdentity(identity) {
    return !!identity &&
      nonEmptyString(identity.engineId) &&
      nonEmptyString(identity.version) &&
      nonEmptyString(identity.configHash) &&
      nonEmptyString(identity.positionFingerprint);
  }

  function validateUnchecked(result, state, expected) {
    if (!fullState(state)) return failure('source-state');

    let status;
    try {
      status = Chess.gameStatus(state);
    } catch (err) {
      return failure('source-state');
    }
    if (status.over) return failure('source-terminal');

    const identity = identityFrom(expected);
    if (!validIdentity(identity)) return failure('expected-identity');

    const expectedTurn = expected && expected.turn !== undefined ?
      expected.turn :
      (expected && expected.identity && expected.identity.turn !== undefined ?
        expected.identity.turn : state.turn);
    if (!validTurn(expectedTurn) || state.turn !== expectedTurn) {
      return failure('expected-turn');
    }

    if (!result || typeof result !== 'object') return failure('result-shape');
    if (!result.engine || typeof result.engine !== 'object' ||
        result.engine.id !== identity.engineId ||
        result.engine.version !== identity.version ||
        result.engine.configHash !== identity.configHash ||
        result.positionFingerprint !== identity.positionFingerprint) {
      return failure('provenance');
    }
    if (result.turn !== expectedTurn) return failure('turn');

    const requireComplete = !expected || expected.requireComplete !== false;
    if (requireComplete) {
      if (result.complete !== true) return failure('incomplete');
    } else if (typeof result.complete !== 'boolean') {
      return failure('complete-shape');
    }

    if (!Number.isInteger(result.depth) || result.depth <= 0) {
      return failure('depth');
    }
    if (!Number.isInteger(result.nodes) || result.nodes < 0) {
      return failure('nodes');
    }
    if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) {
      return failure('elapsed');
    }
    const minDepth = expected && expected.minDepth !== undefined ?
      expected.minDepth : 0;
    if (!Number.isInteger(minDepth) || minDepth < 0) {
      return failure('expected-min-depth');
    }
    if (result.depth < minDepth) return failure('min-depth');

    if (result.stability == null) {
      if (expected && expected.requireStability === true) {
        return failure('stability-required');
      }
    } else if (!result.stability || typeof result.stability !== 'object' ||
        !Array.isArray(result.stability.depths) ||
        result.stability.depths.length !== 2 ||
        !Number.isInteger(result.stability.depths[0]) ||
        !Number.isInteger(result.stability.depths[1]) ||
        result.stability.depths[0] !== result.depth - 1 ||
        result.stability.depths[1] !== result.depth ||
        typeof result.stability.bestMoveStable !== 'boolean') {
      return failure('stability');
    }

    if (!Array.isArray(result.bestLines) || result.bestLines.length === 0) {
      return failure('best-lines');
    }
    if (!validEval(result, expectedTurn)) return failure('top-eval');

    const resolved = [];
    for (let i = 0; i < result.bestLines.length; i++) {
      const line = result.bestLines[i];
      if (!validEval(line, expectedTurn)) {
        return failure('best-line-eval');
      }
      const checked = resolveLine(state, line);
      if (!checked.ok) return failure('best-line-' + checked.reason);
      if (resolved.some(function (move) {
        return sameMove(move, checked.move);
      })) {
        return failure('best-line-duplicate');
      }
      if (i > 0 &&
          orderValue(result.bestLines[i - 1], expectedTurn) <
            orderValue(line, expectedTurn)) {
        return failure('best-lines-order');
      }
      resolved.push(checked.move);
    }
    if (!sameEval(result, result.bestLines[0])) {
      return failure('top-line-eval');
    }

    let playedMove = null;
    if (result.playedLine !== null && result.playedLine !== undefined) {
      if (!Number.isInteger(result.playedLine.rank) ||
          result.playedLine.rank <= 0 ||
          result.playedLine.rank > Chess.legalMoves(state).length) {
        return failure('played-rank');
      }
      if (typeof result.playedLine.amongCandidates !== 'boolean') {
        return failure('played-candidates');
      }
      if (!validEval(result.playedLine, expectedTurn)) {
        return failure('played-eval');
      }
      const checked = resolveLine(state, result.playedLine);
      if (!checked.ok) return failure('played-' + checked.reason);
      playedMove = checked.move;

      const candidateIndex = resolved.findIndex(function (move) {
        return sameMove(move, playedMove);
      });
      if ((candidateIndex >= 0 &&
           result.playedLine.rank !== candidateIndex + 1) ||
          (candidateIndex < 0 &&
           result.playedLine.rank <= resolved.length)) {
        return failure('played-rank');
      }
      if (result.playedLine.amongCandidates !== (candidateIndex >= 0)) {
        return failure('played-candidates');
      }
      const classification = candidateIndex === 0 ? 'same' :
        candidateIndex > 0 ? 'different-candidate' : 'unknown-equivalence';
      if (result.classification !== classification) {
        return failure('classification');
      }
      if (candidateIndex >= 0) {
        const candidate = result.bestLines[candidateIndex];
        if (!sameEval(result.playedLine, candidate) ||
            result.playedLine.uci !== candidate.uci ||
            result.playedLine.san !== candidate.san ||
            JSON.stringify(result.playedLine.pv) !==
              JSON.stringify(candidate.pv) ||
            JSON.stringify(result.playedLine.pvUci) !==
              JSON.stringify(candidate.pvUci)) {
          return failure('played-candidate-line');
        }
      }
    } else if (expected && expected.requirePlayed === true) {
      return failure('played-required');
    }

    if (expected && expected.playedMove !== undefined &&
        expected.playedMove !== null) {
      if (!validMoveShape(expected.playedMove)) {
        return failure('expected-played-move');
      }
      if (!playedMove || !sameMove(playedMove, expected.playedMove)) {
        return failure('played-move');
      }
    }

    return success({
      topMove: resolved[0],
      playedMove: playedMove,
      bestMoves: resolved
    });
  }

  // Treat even hostile accessors/proxies as a rejected boundary value instead
  // of allowing a malformed cache record to unwind scan orchestration.
  function validate(result, state, expected) {
    try {
      return validateUnchecked(result, state, expected);
    } catch (err) {
      return failure('validation-error');
    }
  }

  return {
    validate: validate,
    validMate: validMate,
    validEval: validEval,
    resolveLine: resolveLine,
    sameMove: sameMove,
    uciOf: uciOf
  };
});
