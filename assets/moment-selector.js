/*
 * Chessy critical-moment selector (coaching Phase 5).
 *
 * This module is deliberately PURE. The scan controller owns workers,
 * persistence, cancellation and result validation; this file only converts
 * already-validated analysis contracts into deterministic quick candidates,
 * shortlists at most two separated moments, and admits a deeply verified
 * proposal.
 *
 * Public UI proposals contain ONLY { ply, playedSan }. The engine's score,
 * preferred move and inferred reason remain private until the player completes
 * the existing reflection-first flow.
 */
(function (global) {
  'use strict';

  var ALGORITHM = 'critical-v1';
  var CP_LIMIT = 2000;
  var MATE_UTILITY = 4000;

  var QUICK_REGRET = 80;
  var DEEP_REGRET = 100;

  var DEFENSIVE_BEST = -100;
  var DEFENSIVE_PLAYED = -250;
  var CONVERSION_BEST = 300;
  var CONVERSION_PLAYED = 150;
  var LOST = -300;
  var RECOVERED = -200;

  var CLUSTER_PLIES = 6;
  var EARLY_RATIO = 0.60;
  var MAX_MOMENTS = 2;

  var WEIGHTS = {
    lossCap: 1000,
    defensive: 300,
    conversion: 250,
    collapse: 200,
    quiet: 75,
    impulse: 75,
    overthinkBase: 150,
    overthink: 100
  };

  function finite(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function validMate(mate) {
    return !!mate && typeof mate.forWhite === 'boolean' &&
      finite(mate.inPlies) && mate.inPlies > 0 &&
      Math.floor(mate.inPlies) === mate.inPlies;
  }

  /*
   * A bounded mover-POV utility. Mate distance deliberately does not perturb
   * the sentinel: two lines that both force mate for the same side do not
   * become a fake "critical moment" merely because one mate is longer.
   */
  function utility(line, turn) {
    if (!line || (turn !== 'w' && turn !== 'b')) return null;
    if (validMate(line.mate)) {
      return line.mate.forWhite === (turn === 'w') ? MATE_UTILITY : -MATE_UTILITY;
    }
    if (finite(line.scoreCpPlayer)) {
      return clamp(line.scoreCpPlayer, -CP_LIMIT, CP_LIMIT);
    }
    // Provider-neutral fallback. Chessy's contract supplies scoreCpPlayer, but
    // a future provider may supply only the canonical white-POV score.
    if (finite(line.scoreCpWhite)) {
      return clamp(turn === 'w' ? line.scoreCpWhite : -line.scoreCpWhite,
        -CP_LIMIT, CP_LIMIT);
    }
    return null;
  }

  function regret(best, played) {
    return finite(best) && finite(played) ? Math.max(0, best - played) : null;
  }

  function quietLine(line) {
    return !!line && typeof line.san === 'string' && line.san.length > 0 &&
      !/[x+#=]/.test(line.san);
  }

  /*
   * Clock evidence uses exact recorded thinkMs, never an inferred wall-clock
   * duration. `typicalThinkMs` is a deterministic per-player baseline computed
   * by the controller before scanning.
   *
   * Inclusive boundaries are intentional and tested:
   *   impulse   <= min(3 s, one third of typical), with quick regret
   *   overthink >= max(30 s, three times typical)
   */
  function clockFlags(meta, loss) {
    meta = meta || {};
    var think = meta.thinkMs;
    var typical = meta.typicalThinkMs;
    if (!finite(think) || think < 0 || !finite(typical) || typical <= 0) {
      return { impulse: false, overthink: false, anomaly: false };
    }
    var impulse = finite(loss) && loss >= QUICK_REGRET &&
      think <= Math.min(3000, typical / 3);
    var overthink = think >= Math.max(30000, typical * 3);
    return { impulse: impulse, overthink: overthink,
      anomaly: impulse || overthink };
  }

  /*
   * Extract score/category evidence without applying the quick-nomination
   * threshold. Both quickCandidate() and acceptDeep() use this one path, so
   * deep confirmation cannot silently reinterpret mate/CP or clock boundaries.
   */
  function evidence(result, meta) {
    meta = meta || {};
    if (!result || result.complete !== true || meta.validated !== true) return null;
    var turn = meta.turn || result.turn;
    if (turn !== 'w' && turn !== 'b') return null;
    var top = Array.isArray(result.bestLines) ? result.bestLines[0] : null;
    var played = result.playedLine;
    var bestUtility = utility(top, turn);
    var playedUtility = utility(played, turn);
    var loss = regret(bestUtility, playedUtility);
    if (loss === null) return null;

    var clock = clockFlags(meta, loss);
    return {
      bestUtility: bestUtility,
      playedUtility: playedUtility,
      loss: loss,
      defensive: bestUtility >= DEFENSIVE_BEST &&
        playedUtility <= DEFENSIVE_PLAYED,
      conversion: bestUtility >= CONVERSION_BEST &&
        playedUtility < CONVERSION_PLAYED,
      collapse: bestUtility > LOST && playedUtility <= LOST,
      quiet: quietLine(top) && quietLine(played),
      impulse: clock.impulse,
      overthink: clock.overthink,
      clockAnomaly: clock.anomaly,
      alreadyLost: bestUtility <= LOST
    };
  }

  function teachingScore(ev) {
    var score = Math.min(ev.loss, WEIGHTS.lossCap);
    if (ev.overthink) score = Math.max(score, WEIGHTS.overthinkBase);
    if (ev.defensive) score += WEIGHTS.defensive;
    if (ev.conversion) score += WEIGHTS.conversion;
    if (ev.collapse) score += WEIGHTS.collapse;
    if (ev.quiet) score += WEIGHTS.quiet;
    if (ev.impulse) score += WEIGHTS.impulse;
    if (ev.overthink) score += WEIGHTS.overthink;
    return score;
  }

  /*
   * Build one internal Pass-1 candidate from a result which the controller has
   * already legality/provenance-validated. A complete result alone is not
   * enough: `meta.validated` is an explicit defence at the module boundary.
   */
  function quickCandidate(result, meta) {
    meta = meta || {};
    if (!Number.isInteger(meta.ply) || meta.ply < 0 ||
        typeof meta.playedSan !== 'string' || !meta.playedSan) return null;
    var ev = evidence(result, meta);
    if (!ev || (ev.loss < QUICK_REGRET && !ev.overthink)) return null;
    return {
      algorithm: ALGORITHM,
      ply: meta.ply,
      playedSan: meta.playedSan,
      turn: meta.turn || result.turn,
      bestUtility: ev.bestUtility,
      playedUtility: ev.playedUtility,
      loss: ev.loss,
      defensive: ev.defensive,
      conversion: ev.conversion,
      collapse: ev.collapse,
      quiet: ev.quiet,
      impulse: ev.impulse,
      overthink: ev.overthink,
      clockAnomaly: ev.clockAnomaly,
      alreadyLost: ev.alreadyLost,
      score: teachingScore(ev)
    };
  }

  function candidateShape(c) {
    return !!c && c.algorithm === ALGORITHM &&
      Number.isInteger(c.ply) && c.ply >= 0 &&
      typeof c.playedSan === 'string' && c.playedSan.length > 0 &&
      (c.turn === 'w' || c.turn === 'b') &&
      finite(c.bestUtility) && finite(c.playedUtility) &&
      finite(c.loss) && finite(c.score);
  }

  /*
   * Remove downstream "final collapse" symptoms. Once a candidate crosses
   * from a playable position into LOST, later candidates are suppressed while
   * even best play remains <= RECOVERED. A genuine recovery opens a new
   * episode. Candidates whose own before-position was already LOST are never
   * useful as the causal moment.
   */
  function suppressCollapseTail(sorted) {
    var out = [];
    var collapsed = { w: false, b: false };
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      if (collapsed[c.turn]) {
        if (c.bestUtility > RECOVERED) collapsed[c.turn] = false;
        else continue;
      }
      if (c.alreadyLost || c.bestUtility <= LOST) {
        collapsed[c.turn] = true;
        continue;
      }
      out.push(c);
      if (c.collapse) collapsed[c.turn] = true;
    }
    return out;
  }

  /*
   * Consecutive candidates less than six plies from the cluster's first
   * candidate describe one local episode. Keep its earliest meaningful member:
   * the first whose score is at least 60% of the cluster maximum.
   */
  function clusterRepresentatives(sorted) {
    var reps = [];
    for (var i = 0; i < sorted.length;) {
      var start = sorted[i].ply;
      var end = i + 1;
      while (end < sorted.length && sorted[end].ply - start < CLUSTER_PLIES) end++;
      var max = -Infinity;
      for (var j = i; j < end; j++) max = Math.max(max, sorted[j].score);
      var threshold = max * EARLY_RATIO;
      var chosen = sorted[i];
      for (var k = i; k < end; k++) {
        if (sorted[k].score >= threshold) { chosen = sorted[k]; break; }
      }
      reps.push(chosen);
      i = end;
    }
    return reps;
  }

  /*
   * Pass-1 shortlist: deterministic, non-mutating, max two regardless of a
   * larger caller limit. Ranking uses teaching score; ties prefer the earlier
   * decision. Return order is chronological for stable UI/persistence.
   */
  function shortlist(candidates, limit) {
    var cap = Number.isInteger(limit) ? limit : MAX_MOMENTS;
    cap = Math.max(0, Math.min(MAX_MOMENTS, cap));
    var sorted = (Array.isArray(candidates) ? candidates : [])
      .filter(candidateShape).slice()
      .sort(function (a, b) { return a.ply - b.ply || b.score - a.score; });
    var causal = suppressCollapseTail(sorted);
    // White and Black are distinct learners in local PvP. Their alternating
    // decisions must neither merge into one six-ply episode nor clear each
    // other's lost-position suppression.
    var reps = clusterRepresentatives(causal.filter(function (c) {
      return c.turn === 'w';
    })).concat(clusterRepresentatives(causal.filter(function (c) {
      return c.turn === 'b';
    })));
    reps.sort(function (a, b) { return b.score - a.score || a.ply - b.ply; });
    return reps.slice(0, cap).sort(function (a, b) { return a.ply - b.ply; });
  }

  /*
   * Pass-2 admission. The controller must again pass explicit validation;
   * completeness alone can never found a proposal. The engine's best move must
   * also be stable at the deep pass. Finally, evidence must persist:
   *   - quick regret >=80 and deep regret >=100, or
   *   - the same exact think-time anomaly at both passes.
   *
   * The return value is intentionally spoiler-free.
   */
  function acceptDeep(quick, deepResult, meta) {
    meta = meta || {};
    if (!candidateShape(quick) || quick.alreadyLost || quick.bestUtility <= LOST ||
        meta.validated !== true || deepResult == null ||
        deepResult.complete !== true ||
        !deepResult.stability || deepResult.stability.bestMoveStable !== true ||
        quick.turn !== meta.turn ||
        meta.ply !== quick.ply || meta.playedSan !== quick.playedSan) return null;

    var deep = evidence(deepResult, meta);
    if (!deep) return null;
    var persistentRegret = quick.loss >= QUICK_REGRET &&
      deep.loss >= DEEP_REGRET;
    var persistentClock = quick.clockAnomaly && deep.clockAnomaly;
    if (!persistentRegret && !persistentClock) return null;
    return { ply: quick.ply, playedSan: quick.playedSan };
  }

  var api = {
    quickCandidate: quickCandidate,
    shortlist: shortlist,
    acceptDeep: acceptDeep,
    utility: utility,
    regret: regret,
    clockFlags: clockFlags,
    evidence: evidence,
    constants: {
      algorithm: ALGORITHM,
      cpLimit: CP_LIMIT,
      mateUtility: MATE_UTILITY,
      quickRegret: QUICK_REGRET,
      deepRegret: DEEP_REGRET,
      defensiveBest: DEFENSIVE_BEST,
      defensivePlayed: DEFENSIVE_PLAYED,
      conversionBest: CONVERSION_BEST,
      conversionPlayed: CONVERSION_PLAYED,
      lost: LOST,
      recovered: RECOVERED,
      clusterPlies: CLUSTER_PLIES,
      earlyRatio: EARLY_RATIO,
      maxMoments: MAX_MOMENTS,
      // Export a snapshot, not the live internal table: callers may inspect
      // the algorithm profile but cannot mutate future selection.
      weights: {
        lossCap: WEIGHTS.lossCap,
        defensive: WEIGHTS.defensive,
        conversion: WEIGHTS.conversion,
        collapse: WEIGHTS.collapse,
        quiet: WEIGHTS.quiet,
        impulse: WEIGHTS.impulse,
        overthinkBase: WEIGHTS.overthinkBase,
        overthink: WEIGHTS.overthink
      }
    }
  };

  global.ChessyMomentSelector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
