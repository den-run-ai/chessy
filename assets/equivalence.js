/*
 * Chessy accepted-move criterion (Train v2 E1, #76).
 *
 * Grades one attempted move against a trusted analysis result and returns
 * versioned, persistable equivalence EVIDENCE — never a bare boolean. The
 * criterion is the explicitly documented CP/mate fallback from
 * eval/EQUIVALENCE-CRITERION.md, calibrated against the frozen E3 analysis
 * baseline (eval/ANALYSIS-BASELINE.md). It is NOT WDL equivalence: the
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
   * re-baseline the E3 scorecard. cpTolerance is calibrated in
   * eval/EQUIVALENCE-CRITERION.md: above the engine's own quick-vs-full
   * re-scoring noise floor (p90 17 cp on the frozen corpus), below the
   * conventional ~50 cp inaccuracy threshold.
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
   *   criterion, provider, positionFingerprint, turn, depth, coverage,
   *   wdl (always null for the built-in provider), best, attempt,
   *   accepted (the accepted-move set among returned lines),
   *   verdict 'best' | 'equivalent' | 'not-equivalent' | 'unknown', reason.
   */
  function grade(result, state, expected, attemptUci) {
    const checked = AnalysisResult.validate(result, state, normalizeExpected(expected));
    if (!checked.ok) return failure('analysis-' + checked.reason);

    let legal;
    try {
      legal = Chess.legalMoves(state);
    } catch (err) {
      return failure('analysis-source-state');
    }
    const attemptMove = typeof attemptUci === 'string' ?
      legal.find(function (move) {
        return AnalysisResult.uciOf(move) === attemptUci;
      }) : null;
    if (!attemptMove) return failure('attempt-illegal');

    const turn = result.turn;
    const cpTolerance = CRITERION.params.cpTolerance;
    const best = result.bestLines[0];

    const accepted = result.bestLines.filter(function (line) {
      return line === best ||
        compareToBest(best, line, turn, cpTolerance).acceptable;
    }).map(function (line) {
      return Object.assign({ uci: line.uci, san: line.san }, cloneEval(line));
    });

    // The attempt's evidence line: a candidate line when returned, else the
    // validated playedLine produced FOR this exact move. `validate` already
    // proved rank truth and candidate/played agreement, so rank is the true
    // rank over all scored roots in both branches.
    const candidateIndex = result.bestLines.findIndex(function (line) {
      return line.uci === attemptUci;
    });
    const played = result.playedLine && result.playedLine.uci === attemptUci ?
      result.playedLine : null;
    const line = candidateIndex >= 0 ? result.bestLines[candidateIndex] : played;

    const attempt = {
      uci: attemptUci,
      san: line ? line.san : Chess.toSan(state, attemptMove, legal),
      covered: !!line,
      rank: candidateIndex >= 0 ? candidateIndex + 1 : (played ? played.rank : null),
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
      } else if (stableBest(result)) {
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
        engineId: result.engine.id,
        version: result.engine.version,
        configHash: result.engine.configHash
      },
      positionFingerprint: result.positionFingerprint,
      turn: turn,
      depth: result.depth,
      coverage: result.bestLines.length === legal.length ? 'all-roots' : 'candidates',
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
