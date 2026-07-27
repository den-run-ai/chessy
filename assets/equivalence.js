/*
 * Chessy accepted-move criterion (Train v2 E1, #76).
 *
 * Grades one attempted move against a trusted analysis result and returns
 * versioned, persistable equivalence EVIDENCE — never a bare boolean. The
 * criterion is the explicitly documented CP/mate fallback from
 * eval/EQUIVALENCE-CRITERION.md, with its policy rationale and evaluation
 * history recorded against the frozen E3 analysis baseline. It is NOT WDL
 * equivalence: the
 * built-in provider has no win/draw/loss model, so evidence carries
 * `wdl: null` — unavailable, never synthesized (#107).
 *
 * Trust rules (roadmap #23 / #76):
 * - Analysis is untrusted until ChessyAnalysisResult.validate accepts the
 *   WHOLE result against the caller's expected identity. Incomplete, stale,
 *   or illegal analysis fails closed: no verdict, no evidence.
 * - An attempt outside the returned candidate lines is 'unknown', never an
 *   automatic failure ("not yet covered" is not "wrong").
 * - Rejection needs a stable best move. Acceptance of a within-tolerance
 *   move is safe either way, but declaring the player's move an ERROR on
 *   evidence whose best move still changed at the last depth step would be
 *   the harmful false outcome, so an unstable best downgrades rejection to
 *   'unknown'.
 * - Grading is a pure function of (result, state, expected, attempt): the
 *   same stored provenance always reproduces the same verdict. Engine
 *   updates produce NEW evidence under a new identity; they never rewrite
 *   a persisted outcome.
 */
(function (global, factory) {
  'use strict';

  const api = factory(global && global.Chess, global && global.ChessyAnalysisResult);
  if (!api) return;

  global.ChessyEquivalence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function (Chess, AnalysisResult) {
  'use strict';
  if (!Chess || !AnalysisResult) return null;

  function deepFreeze(value) {
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
      Object.freeze(value);
    }
    return value;
  }

  /*
   * The versioned criterion. Any change to these values changes what
   * "equivalent" means for every future grade, so it MUST bump `version`
   * (test/equivalence.test.js pins the exact object) and consciously
   * re-baseline the E3 scorecard. The policy rationale and the disclosed
   * corpus-inspection history for cpTolerance live in
   * eval/EQUIVALENCE-CRITERION.md.
   */
  const CRITERION = deepFreeze({
    id: 'chessy-equivalence',
    version: 1,
    basis: 'cp-mate-fallback',
    params: { cpTolerance: 30 }
  });

  function failure(reason) {
    return deepFreeze({ ok: false, reason: reason, verdict: null });
  }

  /*
   * Canonicalise the grading inputs before validation. Reading an untrusted
   * worker/cache result (or a mutable source state/expectation) again after
   * validate() would reopen the boundary: accessor- or Proxy-backed fields
   * could change or throw on the second read. This snapshot reads each
   * enumerable field once into inert arrays/plain objects; validate() and
   * every later grading read consume only that one coherent value.
   * defineProperty avoids the legacy __proto__ setter when copying hostile
   * keys. Cycles and throwing traps are rejected by grade()'s fail-closed
   * catch.
   */
  function snapshot(value, stack) {
    if (value === null || typeof value !== 'object') return value;
    stack = stack || [];
    if (stack.indexOf(value) !== -1) throw new Error('cyclic analysis result');
    stack.push(value);
    const copy = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (key) {
      Object.defineProperty(copy, key, {
        value: snapshot(value[key], stack),
        enumerable: true,
        configurable: true,
        writable: true
      });
    });
    stack.pop();
    return copy;
  }

  function mateFor(value, turn) {
    return !!value.mate && value.mate.forWhite === (turn === 'w');
  }

  function mateAgainst(value, turn) {
    return !!value.mate && value.mate.forWhite !== (turn === 'w');
  }

  function cloneEval(line) {
    return {
      scoreCpWhite: line.scoreCpWhite,
      scoreCpPlayer: line.scoreCpPlayer,
      mate: line.mate ?
        { forWhite: line.mate.forWhite, inPlies: line.mate.inPlies } : null
    };
  }

  /*
   * The CP/mate case matrix. Representations never mix in one subtraction:
   * a mate FOR the mover outranks every centipawn line, a mate AGAINST is
   * worse than every centipawn line, and only cp-vs-cp produces a gap.
   * - Any forced mate is a win when the best line also forces mate; mate
   *   distance is speed, not correctness.
   * - When every line loses to a forced mate, equal resistance (the same
   *   mate distance as the best line) is acceptable; hastening the mate
   *   is not.
   */
  function compareToBest(best, attempt, turn, cpTolerance) {
    if (mateFor(attempt, turn)) {
      return {
        acceptable: true,
        gapCp: null,
        why: mateFor(best, turn) ? 'forced-mate-either-way' : 'attempt-not-worse'
      };
    }
    if (mateAgainst(attempt, turn)) {
      if (mateAgainst(best, turn)) {
        return attempt.mate.inPlies >= best.mate.inPlies ?
          { acceptable: true, gapCp: null, why: 'equal-resistance' } :
          { acceptable: false, gapCp: null, why: 'faster-mate-against' };
      }
      return { acceptable: false, gapCp: null, why: 'walks-into-mate' };
    }
    if (mateFor(best, turn)) {
      return { acceptable: false, gapCp: null, why: 'missed-forced-mate' };
    }
    if (mateAgainst(best, turn)) {
      return { acceptable: true, gapCp: null, why: 'attempt-not-worse' };
    }
    const gapCp = best.scoreCpPlayer - attempt.scoreCpPlayer;
    return {
      acceptable: gapCp <= cpTolerance,
      gapCp: gapCp,
      why: gapCp <= cpTolerance ? 'within-tolerance' : 'cp-gap'
    };
  }

  // Rejection evidence must be steady: the best move unchanged across the
  // result's own final depth step. `validate` checks the flag's shape only,
  // so its truth is consulted here, where it decides fail-open vs fail-closed.
  function stableBest(result) {
    return !!result.stability && result.stability.bestMoveStable === true;
  }

  function normalizeExpected(expected) {
    // Evidence may only come from a COMPLETE result: a partial line list has
    // no trustworthy best line to measure a gap against. Callers cannot
    // waive this the way scan orchestration can.
    const copy = Object.assign({}, expected);
    copy.requireComplete = true;
    return copy;
  }

  /*
   * Grade `attemptUci` against a trusted analysis of `state`.
   *
   * Returns { ok: false, reason } when no evidence may exist at all
   * (rejected analysis, illegal attempt), otherwise frozen evidence:
   *   criterion, provider, positionFingerprint, turn, depth, complete,
   *   coverage + legal/candidate/covered-root counts, playedProbe, stability,
   *   wdl (always null for the built-in provider), best, attempt,
   *   accepted (the accepted-move set among returned lines),
   *   verdict 'best' | 'equivalent' | 'not-equivalent' | 'unknown', reason.
   */
  function grade(result, state, expected, attemptUci) {
    let trustedResult, trustedState, trustedExpected, checked;
    try {
      const input = snapshot({
        result: result,
        state: state,
        expected: expected
      });
      trustedResult = input.result;
      trustedState = input.state;
      trustedExpected = input.expected;
      checked = AnalysisResult.validate(
        trustedResult, trustedState, normalizeExpected(trustedExpected)
      );
    } catch (err) {
      return failure('analysis-validation-error');
    }
    if (!checked.ok) return failure('analysis-' + checked.reason);

    let legal;
    try {
      legal = Chess.legalMoves(trustedState);
    } catch (err) {
      return failure('analysis-source-state');
    }
    const attemptMove = typeof attemptUci === 'string' ?
      legal.find(function (move) {
        return AnalysisResult.uciOf(move) === attemptUci;
      }) : null;
    if (!attemptMove) return failure('attempt-illegal');

    const turn = trustedResult.turn;
    const cpTolerance = CRITERION.params.cpTolerance;
    const best = trustedResult.bestLines[0];

    // The attempt's evidence line: a candidate line when returned, else the
    // validated playedLine produced FOR this exact move. Candidate rank is
    // proven by array position. An outside rank remains provider-reported:
    // validate() proves legal range and a necessary shortlist lower/order
    // bound, not the exact position among roots that were not returned.
    const candidateIndex = trustedResult.bestLines.findIndex(function (line) {
      return line.uci === attemptUci;
    });
    const resultPlayed = trustedResult.playedLine || null;
    const played = resultPlayed && resultPlayed.uci === attemptUci ?
      resultPlayed : null;
    const line = candidateIndex >= 0 ?
      trustedResult.bestLines[candidateIndex] : played;

    // The accepted set covers every returned candidate plus an independently
    // probed playedLine when it sits outside MultiPV. Leaving an accepted
    // outside attempt out of this persisted set would make the verdict and
    // its own evidence disagree.
    const returned = trustedResult.bestLines.slice();
    const playedCandidateIndex = resultPlayed ?
      trustedResult.bestLines.findIndex(function (item) {
        return item.uci === resultPlayed.uci;
      }) : -1;
    if (resultPlayed && playedCandidateIndex < 0) returned.push(resultPlayed);
    const accepted = returned.filter(function (item) {
      return item === best ||
        compareToBest(best, item, turn, cpTolerance).acceptable;
    }).map(function (item) {
      return Object.assign({ uci: item.uci, san: item.san }, cloneEval(item));
    });
    const playedProbe = resultPlayed ? {
      uci: resultPlayed.uci,
      san: resultPlayed.san,
      amongCandidates: playedCandidateIndex >= 0,
      rank: playedCandidateIndex >= 0 ?
        playedCandidateIndex + 1 : resultPlayed.rank,
      rankBasis: playedCandidateIndex >= 0 ?
        'candidate-index' : 'provider-reported',
      rankLowerBound: playedCandidateIndex >= 0 ?
        playedCandidateIndex + 1 : trustedResult.bestLines.length + 1,
      eval: cloneEval(resultPlayed)
    } : null;

    const attempt = {
      uci: attemptUci,
      san: line ? line.san : Chess.toSan(trustedState, attemptMove, legal),
      covered: !!line,
      rank: candidateIndex >= 0 ? candidateIndex + 1 : (played ? played.rank : null),
      rankBasis: candidateIndex >= 0 ? 'candidate-index' :
        (played ? 'provider-reported' : null),
      rankLowerBound: candidateIndex >= 0 ? candidateIndex + 1 :
        (played ? trustedResult.bestLines.length + 1 : null),
      eval: line ? cloneEval(line) : null,
      gapCp: null
    };

    let verdict, reason;
    if (!line) {
      // Outside the returned lines and no played-line evidence: unknown,
      // never a failure — the caller must analyse the attempt itself
      // (playedMove) before this move can be judged at all.
      verdict = 'unknown';
      reason = 'not-covered';
    } else if (attemptUci === best.uci) {
      verdict = 'best';
      reason = 'engine-best';
      attempt.gapCp = line.mate ? null : 0;
    } else {
      const cmp = compareToBest(best, line, turn, cpTolerance);
      attempt.gapCp = cmp.gapCp;
      if (cmp.acceptable) {
        verdict = 'equivalent';
        reason = cmp.why;
      } else if (stableBest(trustedResult)) {
        verdict = 'not-equivalent';
        reason = cmp.why;
      } else {
        verdict = 'unknown';
        reason = 'unstable-best';
      }
    }

    return deepFreeze({
      ok: true,
      criterion: {
        id: CRITERION.id,
        version: CRITERION.version,
        basis: CRITERION.basis,
        params: { cpTolerance: cpTolerance }
      },
      provider: {
        engineId: trustedResult.engine.id,
        version: trustedResult.engine.version,
        configHash: trustedResult.engine.configHash
      },
      positionFingerprint: trustedResult.positionFingerprint,
      turn: turn,
      depth: trustedResult.depth,
      complete: trustedResult.complete,
      coverage: trustedResult.bestLines.length === legal.length ?
        'all-roots' : 'candidates',
      legalRootCount: legal.length,
      candidateLineCount: trustedResult.bestLines.length,
      coveredRootCount: trustedResult.bestLines.length +
        (resultPlayed && playedCandidateIndex < 0 ? 1 : 0),
      playedProbe: playedProbe,
      stability: trustedResult.stability ? {
        depths: trustedResult.stability.depths.slice(),
        bestMoveStable: trustedResult.stability.bestMoveStable
      } : null,
      wdl: null,
      best: Object.assign({ uci: best.uci, san: best.san }, cloneEval(best)),
      accepted: accepted,
      attempt: attempt,
      verdict: verdict,
      reason: reason
    });
  }

  return {
    CRITERION: CRITERION,
    grade: grade
  };
});
