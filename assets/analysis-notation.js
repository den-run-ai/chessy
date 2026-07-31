/*
 * Versioned Review score/annotation summaries.
 *
 * The critical-moment controller calls summarize() only after the complete
 * analysis-result trust boundary has accepted a worker/cache result. The
 * compact summary is recomputable analysisJobs state: it never mutates the
 * archived PGN or its source NAGs.
 *
 * Score semantics are deliberately fixed for a game ledger:
 *   - the displayed score is the PLAYED root line's evaluation;
 *   - the sign is always White POV (+ favours White, - favours Black);
 *   - quick-pass scores are estimates and never receive a generated NAG;
 *   - ?!/ ? / ?? require a deeply confirmed, stable critical moment.
 *
 * Positive NAGs are intentionally absent. A small centipawn loss cannot prove
 * that a move was brilliant, difficult or uniquely interesting.
 */
(function (global, factory) {
  'use strict';
  const api = factory(global && global.ChessyMomentSelector);
  if (!api) return;
  global.ChessyAnalysisNotation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function (Selector) {
  'use strict';
  if (!Selector || typeof Selector.evidence !== 'function' ||
      typeof Selector.utility !== 'function' ||
      typeof Selector.clockFlags !== 'function' || !Selector.constants ||
      !Number.isFinite(Selector.constants.mateUtility) ||
      !Number.isFinite(Selector.constants.lost) ||
      !Number.isFinite(Selector.constants.deepRegret)) return null;

  const SCHEMA = 1;
  const POLICY = 'move-annotation-v1';
  const MAX_CP_ABS = 999000;
  const MAX_UTILITY_GAP = 8000;
  const PROFILES = ['quick', 'quick-fallback', 'deep'];
  const MARKS = Object.freeze({
    dubious: 100,
    mistake: 200,
    blunder: 400
  });

  function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function validMate(mate) {
    return !!mate && typeof mate === 'object' &&
      typeof mate.forWhite === 'boolean' &&
      Number.isInteger(mate.inPlies) && mate.inPlies > 0;
  }

  function validPlayedEval(value) {
    if (!value || typeof value !== 'object') return false;
    if (validMate(value.mate)) return value.scoreCpWhite === null;
    return value.mate === null &&
      Number.isSafeInteger(value.scoreCpWhite) &&
      Math.abs(value.scoreCpWhite) <= MAX_CP_ABS;
  }

  function copyMate(mate) {
    return mate === null ? null : {
      forWhite: mate.forWhite,
      inPlies: mate.inPlies
    };
  }

  function validStability(value, depth) {
    if (value === null) return true;
    return !!value && typeof value === 'object' &&
      Array.isArray(value.depths) && value.depths.length === 2 &&
      value.depths[0] === depth - 1 && value.depths[1] === depth &&
      typeof value.bestMoveStable === 'boolean';
  }

  // Recompute every annotation input from the two canonical line evaluations.
  // The persisted utility gap below is only an integrity mirror: validate()
  // requires an exact match before any recomputable analysisJobs row can be
  // released. It is never used in preference to the canonical evaluations.
  function metrics(summary) {
    if (!summary || !validPlayedEval(summary) ||
        !validPlayedEval({
          scoreCpWhite: summary.bestScoreCpWhite,
          mate: summary.bestMate
        })) return null;
    const bestUtility = Selector.utility({
      scoreCpWhite: summary.bestScoreCpWhite,
      mate: summary.bestMate
    }, summary.turn);
    const playedUtility = Selector.utility(summary, summary.turn);
    const loss = Number.isFinite(bestUtility) && Number.isFinite(playedUtility)
      ? Math.max(0, bestUtility - playedUtility) : null;
    if (!Number.isFinite(loss) || loss > MAX_UTILITY_GAP) return null;
    return {
      bestUtility: bestUtility,
      playedUtility: playedUtility,
      loss: loss,
      stable: !!summary.stability &&
        summary.stability.bestMoveStable === true
    };
  }

  function annotation(summary) {
    const ev = metrics(summary);
    if (!summary || summary.profile !== 'deep' ||
        summary.accepted !== true || !ev || !ev.stable ||
        ev.bestUtility <= Selector.constants.lost ||
        ev.loss < MARKS.dubious) return null;
    if (ev.loss >= MARKS.blunder) return '??';
    if (ev.loss >= MARKS.mistake) return '?';
    return '?!';
  }

  /*
   * Build one compact summary from an already validated analysis result.
   * `accepted` means the same result passed the selector's deep-admission
   * policy; a merely large quick estimate is never enough for punctuation.
   */
  function summarize(result, meta) {
    meta = meta || {};
    const profile = meta.profile;
    if (!result || result.complete !== true || meta.validated !== true ||
        !Number.isInteger(meta.ply) || meta.ply < 0 ||
        !nonEmpty(meta.playedSan) ||
        (meta.turn !== 'w' && meta.turn !== 'b') ||
        result.turn !== meta.turn ||
        PROFILES.indexOf(profile) < 0 ||
        !Array.isArray(result.bestLines) || !result.bestLines[0] ||
        !validPlayedEval(result.bestLines[0]) ||
        !result.playedLine || !validPlayedEval(result.playedLine) ||
        !result.engine || !nonEmpty(result.engine.id) ||
        !nonEmpty(result.engine.version) ||
        !nonEmpty(result.engine.configHash) ||
        !nonEmpty(result.positionFingerprint) ||
        !Number.isInteger(result.depth) || result.depth <= 0) return null;

    const ev = Selector.evidence(result, {
      turn: meta.turn,
      thinkMs: meta.thinkMs,
      typicalThinkMs: meta.typicalThinkMs,
      validated: true
    });
    if (!ev || !Number.isFinite(ev.bestUtility) ||
        !Number.isFinite(ev.playedUtility) ||
        !Number.isFinite(ev.loss) ||
        ev.loss < 0 || ev.loss > MAX_UTILITY_GAP) return null;

    if (!validStability(result.stability, result.depth)) return null;
    const deep = profile === 'deep';
    const stable = !!result.stability &&
      result.stability.bestMoveStable === true;
    return {
      schema: SCHEMA,
      policy: POLICY,
      ply: meta.ply,
      playedSan: meta.playedSan,
      turn: meta.turn,
      profile: profile,
      scoreCpWhite: result.playedLine.scoreCpWhite,
      mate: copyMate(result.playedLine.mate),
      bestScoreCpWhite: result.bestLines[0].scoreCpWhite,
      bestMate: copyMate(result.bestLines[0].mate),
      lossUtility: ev.loss,
      clockAnomaly: ev.clockAnomaly === true,
      depth: result.depth,
      stability: result.stability === null ? null : {
        depths: result.stability.depths.slice(),
        bestMoveStable: result.stability.bestMoveStable
      },
      // Selector admission may be founded on a persistent exact-clock anomaly
      // even when the score loss is below the punctuation threshold. Preserve
      // that admission separately; annotation() still requires at least 100cp.
      accepted: deep && meta.accepted === true && stable &&
        ev.bestUtility > Selector.constants.lost &&
        (ev.loss >= Selector.constants.deepRegret ||
         ev.clockAnomaly === true),
      engineId: result.engine.id,
      engineVersion: result.engine.version,
      configHash: result.engine.configHash,
      positionFingerprint: result.positionFingerprint
    };
  }

  /*
   * Rebind a persisted summary to the exact replayed source and pure analysis
   * identity before it can cross the public-state boundary.
   */
  function validate(summary, expected) {
    expected = expected || {};
    const ev = metrics(summary);
    const expectedClock = ev ? Selector.clockFlags({
      thinkMs: expected.thinkMs,
      typicalThinkMs: expected.typicalThinkMs
    }, ev.loss).anomaly : false;
    if (!summary || typeof summary !== 'object' ||
        summary.schema !== SCHEMA || summary.policy !== POLICY ||
        summary.ply !== expected.ply ||
        summary.playedSan !== expected.playedSan ||
        summary.turn !== expected.turn ||
        PROFILES.indexOf(summary.profile) < 0 ||
        !validPlayedEval(summary) ||
        !validPlayedEval({
          scoreCpWhite: summary.bestScoreCpWhite,
          mate: summary.bestMate
        }) ||
        !ev ||
        !Number.isFinite(summary.lossUtility) ||
        summary.lossUtility !== ev.loss ||
        typeof summary.clockAnomaly !== 'boolean' ||
        summary.clockAnomaly !== expectedClock ||
        !Number.isInteger(summary.depth) || summary.depth <= 0 ||
        !validStability(summary.stability, summary.depth) ||
        typeof summary.accepted !== 'boolean' ||
        (summary.accepted &&
          (summary.profile !== 'deep' || !ev.stable ||
           ev.bestUtility <= Selector.constants.lost ||
           (ev.loss < Selector.constants.deepRegret &&
            summary.clockAnomaly !== true))) ||
        !expected.identity ||
        summary.engineId !== expected.identity.engineId ||
        summary.engineVersion !== expected.identity.version ||
        summary.configHash !== expected.identity.configHash ||
        summary.positionFingerprint !== expected.identity.positionFingerprint) {
      return false;
    }
    return true;
  }

  function publicEntry(summary) {
    return {
      ply: summary.ply,
      playedSan: summary.playedSan,
      scoreCpWhite: summary.scoreCpWhite,
      mate: summary.mate === null ? null : {
        forWhite: summary.mate.forWhite,
        inPlies: summary.mate.inPlies
      },
      annotation: annotation(summary),
      depth: summary.depth,
      estimate: summary.profile !== 'deep'
    };
  }

  function formatWhite(value) {
    if (!value || typeof value !== 'object') return null;
    if (validMate(value.mate)) {
      return (value.mate.forWhite ? '+M' : '−M') + value.mate.inPlies;
    }
    if (!Number.isSafeInteger(value.scoreCpWhite) ||
        Math.abs(value.scoreCpWhite) > MAX_CP_ABS) return null;
    const pawns = value.scoreCpWhite / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
  }

  return {
    summarize: summarize,
    validate: validate,
    publicEntry: publicEntry,
    annotation: annotation,
    formatWhite: formatWhite,
    constants: {
      schema: SCHEMA,
      policy: POLICY,
      profiles: PROFILES.slice(),
      thresholds: {
        dubious: MARKS.dubious,
        mistake: MARKS.mistake,
        blunder: MARKS.blunder
      }
    }
  };
});
