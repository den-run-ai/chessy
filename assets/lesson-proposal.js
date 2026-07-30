/*
 * Deterministic lesson-draft policy (Train v2 E4, #108).
 *
 * This module is deliberately pure. It consumes an exact completed-scan
 * claim, a legal structured Calculation reflection, and already-verified
 * equivalence grades. It never analyses a position and never invents a
 * fallback lesson:
 *
 *   propose(context) -> one deeply frozen draft, or null
 *   approve(draft, cause, lesson) -> frozen persisted approval, or null
 *   validate(approval, context) -> null when valid, otherwise an error string
 *
 * Automatic drafts require a complete, stable, covered, non-equivalent grade
 * for the move that was actually played. The only v1 findings are:
 *   1. objectively in check + player reported no threat;
 *   2. no candidate comparison, or every listed candidate independently
 *      graded non-equivalent under the same analysis provenance;
 *   3. player explicitly reported no opponent-reply calculation.
 *
 * Reflection fields remain player self-report. `unclear`, hypothetical
 * null-move threats, raw PV/reply differences, evaluation labels and timing
 * never support an automatic lesson in this policy version.
 */
(function (global, factory) {
  'use strict';

  var api = factory(
    global && global.Chess,
    global && global.ChessyCalculation,
    global && global.ChessyEquivalence,
    global && global.ChessyAnalysisResult,
    global && global.ChessyAnalysisCore
  );
  if (!api) return;

  global.ChessyLessonProposal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this),
function (Chess, Calculation, Equivalence, AnalysisResult, AnalysisCore) {
  'use strict';
  if (!Chess || !Calculation || !Equivalence || !AnalysisResult ||
      !AnalysisCore || typeof AnalysisCore.positionFingerprint !== 'function') {
    return null;
  }

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.keys(value).forEach(function (key) {
        deepFreeze(value[key]);
      });
      Object.freeze(value);
    }
    return value;
  }

  var POLICY = deepFreeze({
    id: 'chessy-lesson-proposal-policy',
    version: 1
  });
  var DRAFT_SCHEMA = deepFreeze({
    id: 'chessy-lesson-proposal-draft',
    version: 1
  });
  var APPROVAL_SCHEMA = deepFreeze({
    id: 'chessy-lesson-proposal-approval',
    version: 1
  });
  var SCAN_ALGORITHM = 'critical-moments-v1';
  var MAX_PROPOSALS = 2;
  var MAX_LESSON_LENGTH = 500;

  var COPY = deepFreeze({
    'threat-scan': 'Before calculating, check whether your king is in check.',
    'candidates-none': 'Before moving, name at least two legal candidates.',
    'candidates-listed': 'Before choosing, search once more for a stronger candidate.',
    calculation:
      'Before committing, calculate your move and the opponent’s best reply.'
  });
  var AUTOMATIC_CAUSES = deepFreeze([
    'threat-scan', 'candidates', 'calculation'
  ]);
  // The generated finding remains immutable, but approval reflects the
  // player's final edit using the causes already supported by Review.
  var EDITABLE_CAUSES = deepFreeze([
    'threat-scan', 'candidates', 'evaluation', 'calculation',
    'efficiency', 'impulse', 'sound-alternative'
  ]);

  function ownKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var keys = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    return keys.length === wanted.length &&
      keys.every(function (key, index) { return key === wanted[index]; });
  }

  function snapshot(value, stack) {
    if (value === null || value === undefined ||
        typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('non-finite value');
      return value;
    }
    if (typeof value !== 'object') throw new Error('non-JSON value');
    if (Object.getOwnPropertySymbols &&
        Object.getOwnPropertySymbols(value).length) {
      throw new Error('symbol property');
    }
    stack = stack || [];
    if (stack.indexOf(value) !== -1) throw new Error('cyclic value');
    stack.push(value);
    var copy = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (key) {
      var child = snapshot(value[key], stack);
      if (child === undefined) throw new Error('undefined property');
      Object.defineProperty(copy, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true
      });
    });
    stack.pop();
    return copy;
  }

  function jsonSafe(value) {
    try {
      snapshot(value);
      JSON.stringify(value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function deepEqual(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' ||
        typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) {
      return false;
    }
    var leftKeys = Object.keys(left).sort();
    var rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every(function (key, index) {
        return key === rightKeys[index] && deepEqual(left[key], right[key]);
      });
  }

  function uciOf(move) {
    return Chess.sqName(move.from) + Chess.sqName(move.to) +
      (move.promotion ? move.promotion.toLowerCase() : '');
  }

  function legalIndex(state) {
    var legal = Chess.legalMoves(state);
    var byUci = Object.create(null);
    legal.forEach(function (move) {
      byUci[uciOf(move)] = {
        move: move,
        san: Chess.toSan(state, move, legal)
      };
    });
    return { legal: legal, byUci: byUci };
  }

  // AnalysisResult.validEval needs the root turn. Keep the canonical move and
  // evaluation checks together so no caller can accidentally validate one
  // without the other.
  function validAnalysedMove(entry, index, turn) {
    return !!entry && ownKeys(entry, [
      'uci', 'san', 'scoreCpWhite', 'scoreCpPlayer', 'mate'
    ]) &&
      typeof entry.uci === 'string' &&
      !!index.byUci[entry.uci] &&
      entry.san === index.byUci[entry.uci].san &&
      AnalysisResult.validEval(entry, turn);
  }

  function validEval(value, turn) {
    return ownKeys(value, ['scoreCpWhite', 'scoreCpPlayer', 'mate']) &&
      AnalysisResult.validEval(value, turn);
  }

  function sameEvaluation(left, right) {
    return !!left && !!right &&
      left.scoreCpWhite === right.scoreCpWhite &&
      left.scoreCpPlayer === right.scoreCpPlayer &&
      deepEqual(left.mate, right.mate);
  }

  function sameAnalysedMove(left, right) {
    return !!left && !!right &&
      left.uci === right.uci && left.san === right.san &&
      sameEvaluation(left, right);
  }

  function validCriterion(value) {
    return ownKeys(value, ['id', 'version', 'basis', 'params']) &&
      deepEqual(value, Equivalence.CRITERION);
  }

  function validProvider(value) {
    return ownKeys(value, ['engineId', 'version', 'configHash']) &&
      typeof value.engineId === 'string' && !!value.engineId &&
      typeof value.version === 'string' && !!value.version &&
      typeof value.configHash === 'string' && !!value.configHash;
  }

  function validClaim(claim) {
    return ownKeys(claim, [
      'jobSchema', 'algorithm', 'sourceRev', 'analysisRev', 'scanColor',
      'identity', 'ordinal', 'ply', 'playedSan'
    ]) &&
      claim.jobSchema === 1 &&
      claim.algorithm === SCAN_ALGORITHM &&
      typeof claim.sourceRev === 'string' && !!claim.sourceRev &&
      typeof claim.analysisRev === 'string' && !!claim.analysisRev &&
      (claim.scanColor === 'w' || claim.scanColor === 'b' ||
       claim.scanColor === 'both') &&
      typeof claim.identity === 'string' && !!claim.identity &&
      Number.isInteger(claim.ordinal) &&
      claim.ordinal >= 0 && claim.ordinal < MAX_PROPOSALS &&
      Number.isInteger(claim.ply) && claim.ply >= 0 &&
      typeof claim.playedSan === 'string' && !!claim.playedSan;
  }

  function proposalId(claim, provider) {
    var fields = [
      POLICY.id + '-v' + POLICY.version,
      claim.jobSchema,
      claim.algorithm,
      claim.sourceRev,
      claim.analysisRev,
      claim.scanColor,
      claim.identity,
      claim.ordinal,
      claim.ply,
      claim.playedSan,
      provider.engineId,
      provider.version,
      provider.configHash
    ];
    return fields.map(function (field) {
      return encodeURIComponent(String(field));
    }).join(':');
  }

  function validAnalysisShape(value) {
    return ownKeys(value, [
      'criterion', 'provider', 'positionFingerprint', 'turn', 'depth',
      'complete', 'coverage', 'legalRootCount', 'candidateLineCount',
      'coveredRootCount', 'stability', 'best', 'accepted'
    ]) &&
      validCriterion(value.criterion) &&
      validProvider(value.provider) &&
      typeof value.positionFingerprint === 'string' &&
      !!value.positionFingerprint &&
      (value.turn === 'w' || value.turn === 'b') &&
      Number.isInteger(value.depth) && value.depth >= 1 &&
      value.complete === true &&
      (value.coverage === 'all-roots' || value.coverage === 'candidates') &&
      Number.isInteger(value.legalRootCount) && value.legalRootCount >= 1 &&
      Number.isInteger(value.candidateLineCount) &&
      value.candidateLineCount >= 1 &&
      Number.isInteger(value.coveredRootCount) &&
      value.coveredRootCount >= value.candidateLineCount &&
      value.coveredRootCount <= value.candidateLineCount + 1 &&
      ownKeys(value.stability, ['depths', 'bestMoveStable']) &&
      Array.isArray(value.stability.depths) &&
      value.stability.depths.length === 2 &&
      value.stability.depths[0] === value.depth - 1 &&
      value.stability.depths[1] === value.depth &&
      value.stability.bestMoveStable === true &&
      !!value.best && typeof value.best === 'object' &&
      Array.isArray(value.accepted) && value.accepted.length >= 1;
  }

  function validateAnalysis(value, state, index) {
    if (!validAnalysisShape(value) || value.turn !== state.turn ||
        value.legalRootCount !== index.legal.length ||
        value.candidateLineCount > index.legal.length ||
        value.coveredRootCount > index.legal.length ||
        (value.coverage === 'all-roots' &&
         value.candidateLineCount !== index.legal.length) ||
        (value.coverage === 'candidates' &&
         value.candidateLineCount >= index.legal.length) ||
        value.positionFingerprint !==
          AnalysisCore.positionFingerprint(state, state.positions)) {
      return false;
    }
    if (!validAnalysedMove(value.best, index, state.turn)) return false;

    var seen = Object.create(null);
    var sawBest = false;
    for (var i = 0; i < value.accepted.length; i++) {
      var accepted = value.accepted[i];
      if (!validAnalysedMove(accepted, index, state.turn) ||
          seen[accepted.uci]) return false;
      var comparison = Equivalence.comparePersisted(
        value.criterion, value.best, accepted, state.turn);
      if (!comparison.ok || !comparison.acceptable ||
          !comparison.bestNotWorse) return false;
      if (accepted.uci === value.best.uci) {
        if (!sameAnalysedMove(accepted, value.best)) return false;
        sawBest = true;
      }
      seen[accepted.uci] = true;
    }
    return sawBest && value.accepted.length <= value.coveredRootCount;
  }

  function validRank(attempt, analysis) {
    if (!attempt.covered) {
      return attempt.rank === null && attempt.rankBasis === null &&
        attempt.rankLowerBound === null && attempt.eval === null &&
        attempt.gapCp === null;
    }
    if (!Number.isInteger(attempt.rank) || attempt.rank < 1 ||
        !Number.isInteger(attempt.rankLowerBound) ||
        attempt.rankLowerBound < 1) return false;
    if (attempt.rankBasis === 'candidate-index') {
      return attempt.rank === attempt.rankLowerBound &&
        attempt.rank <= analysis.candidateLineCount;
    }
    if (attempt.rankBasis === 'provider-reported') {
      return attempt.rankLowerBound === analysis.candidateLineCount + 1 &&
        attempt.rank >= attempt.rankLowerBound;
    }
    return false;
  }

  function validAttemptShape(summary) {
    if (!ownKeys(summary, ['attempt', 'verdict', 'reason']) ||
        !summary.attempt || !ownKeys(summary.attempt, [
          'uci', 'san', 'covered', 'rank', 'rankBasis', 'rankLowerBound',
          'eval', 'gapCp'
        ]) ||
        typeof summary.attempt.uci !== 'string' ||
        typeof summary.attempt.san !== 'string' || !summary.attempt.san ||
        typeof summary.attempt.covered !== 'boolean' ||
        ['best', 'equivalent', 'not-equivalent', 'unknown']
          .indexOf(summary.verdict) < 0 ||
        typeof summary.reason !== 'string' || !summary.reason) {
      return false;
    }
    return summary.attempt.gapCp === null ||
      (Number.isSafeInteger(summary.attempt.gapCp) &&
       summary.attempt.gapCp >= 0);
  }

  function acceptedAttempt(analysis, attempt) {
    return analysis.accepted.some(function (entry) {
      return entry.uci === attempt.uci &&
        attempt.eval && sameEvaluation(entry, attempt.eval);
    });
  }

  function validateAttempt(summary, analysis, state, index) {
    if (!validAttemptShape(summary) ||
        !index.byUci[summary.attempt.uci] ||
        summary.attempt.san !== index.byUci[summary.attempt.uci].san ||
        !validRank(summary.attempt, analysis)) return false;

    var attempt = summary.attempt;
    if (!attempt.covered) {
      return summary.verdict === 'unknown' &&
        summary.reason === 'not-covered';
    }
    if (!validEval(attempt.eval, state.turn)) return false;

    if (summary.verdict === 'best') {
      return attempt.uci === analysis.best.uci &&
        summary.reason === 'engine-best' &&
        sameEvaluation(attempt.eval, analysis.best) &&
        attempt.gapCp === (attempt.eval.mate ? null : 0) &&
        acceptedAttempt(analysis, attempt);
    }
    if (attempt.uci === analysis.best.uci) return false;
    var comparison = Equivalence.comparePersisted(
      analysis.criterion, analysis.best, attempt.eval, state.turn);
    if (!comparison.ok || !comparison.bestNotWorse ||
        summary.reason !== comparison.reason ||
        attempt.gapCp !== comparison.gapCp) return false;
    if (summary.verdict === 'equivalent') {
      return comparison.acceptable && acceptedAttempt(analysis, attempt);
    }
    if (summary.verdict === 'not-equivalent') {
      return !comparison.acceptable &&
        analysis.stability.bestMoveStable === true &&
        !acceptedAttempt(analysis, attempt);
    }
    // A stable common result can only leave a legal root unknown when that
    // root was not covered, which was handled above.
    return false;
  }

  function validPlayedProbe(value, analysis, state, index) {
    if (value === null) {
      return analysis.coveredRootCount === analysis.candidateLineCount;
    }
    if (!ownKeys(value, [
      'uci', 'san', 'amongCandidates', 'rank', 'rankBasis',
      'rankLowerBound', 'eval'
    ]) ||
        !index.byUci[value.uci] ||
        value.san !== index.byUci[value.uci].san ||
        typeof value.amongCandidates !== 'boolean' ||
        !Number.isInteger(value.rank) || value.rank < 1 ||
        !Number.isInteger(value.rankLowerBound) ||
        !validEval(value.eval, state.turn)) return false;
    if (value.amongCandidates) {
      return value.rankBasis === 'candidate-index' &&
        value.rankLowerBound === value.rank &&
        value.rank <= analysis.candidateLineCount &&
        analysis.coveredRootCount === analysis.candidateLineCount;
    }
    return value.rankBasis === 'provider-reported' &&
      value.rankLowerBound === analysis.candidateLineCount + 1 &&
      value.rank >= value.rankLowerBound &&
      analysis.coveredRootCount === analysis.candidateLineCount + 1;
  }

  function analysisFromGrade(grade) {
    return {
      criterion: grade.criterion,
      provider: grade.provider,
      positionFingerprint: grade.positionFingerprint,
      turn: grade.turn,
      depth: grade.depth,
      complete: grade.complete,
      coverage: grade.coverage,
      legalRootCount: grade.legalRootCount,
      candidateLineCount: grade.candidateLineCount,
      coveredRootCount: grade.coveredRootCount,
      stability: grade.stability,
      best: grade.best,
      accepted: grade.accepted
    };
  }

  function attemptFromGrade(grade) {
    return {
      attempt: grade.attempt,
      verdict: grade.verdict,
      reason: grade.reason
    };
  }

  function normalizeGrade(grade, state, index) {
    if (!grade || !ownKeys(grade, [
      'ok', 'criterion', 'provider', 'positionFingerprint', 'turn', 'depth',
      'complete', 'coverage', 'legalRootCount', 'candidateLineCount',
      'coveredRootCount', 'playedProbe', 'stability', 'wdl', 'best',
      'accepted', 'attempt', 'verdict', 'reason'
    ]) || grade.ok !== true || grade.wdl !== null) return null;
    var analysis = analysisFromGrade(grade);
    var attempt = attemptFromGrade(grade);
    if (!validateAnalysis(analysis, state, index) ||
        !validPlayedProbe(grade.playedProbe, analysis, state, index) ||
        !validateAttempt(attempt, analysis, state, index)) return null;
    return { analysis: analysis, attempt: attempt };
  }

  function sameAnalysis(left, right) {
    return deepEqual(left, right);
  }

  function normalizeCandidateGrades(
    grades, reflection, playedAnalysis, state, index
  ) {
    if (!Array.isArray(grades) ||
        reflection.candidates.status !== 'listed') return [];
    var listed = Object.create(null);
    reflection.candidates.moves.forEach(function (move, ordinal) {
      listed[move.uci] = { ordinal: ordinal, records: [] };
    });
    grades.forEach(function (grade) {
      var normalized = normalizeGrade(grade, state, index);
      if (!normalized || !sameAnalysis(normalized.analysis, playedAnalysis) ||
          !listed[normalized.attempt.attempt.uci]) return;
      listed[normalized.attempt.attempt.uci].records.push(normalized.attempt);
    });
    return reflection.candidates.moves.map(function (move) {
      var records = listed[move.uci].records;
      return records.length === 1 ? records[0] : null;
    }).filter(Boolean);
  }

  function automaticFinding(state, reflection, candidates) {
    if (Chess.inCheck(state, state.turn) &&
        reflection.threat.kind === 'none') {
      return {
        cause: 'threat-scan',
        lesson: COPY['threat-scan']
      };
    }
    if (reflection.candidates.status === 'none') {
      return {
        cause: 'candidates',
        lesson: COPY['candidates-none']
      };
    }
    if (reflection.candidates.status === 'listed' &&
        candidates.length === reflection.candidates.moves.length &&
        reflection.candidates.moves.every(function (move) {
          return candidates.some(function (grade) {
            return grade.attempt.uci === move.uci &&
              grade.verdict === 'not-equivalent';
          });
        })) {
      return {
        cause: 'candidates',
        lesson: COPY['candidates-listed']
      };
    }
    if (reflection.calculation.status === 'none') {
      return {
        cause: 'calculation',
        lesson: COPY.calculation
      };
    }
    return null;
  }

  function expectedGenerated(reflection, cause) {
    if (!reflection || !reflection.candidates ||
        !reflection.calculation || !reflection.threat) return null;
    if (cause === 'threat-scan') return COPY['threat-scan'];
    if (cause === 'candidates') {
      if (reflection.candidates.status === 'none') {
        return COPY['candidates-none'];
      }
      if (reflection.candidates.status === 'listed') {
        return COPY['candidates-listed'];
      }
      return null;
    }
    return cause === 'calculation' ? COPY.calculation : null;
  }

  function draftShapeError(draft) {
    if (!jsonSafe(draft) || !ownKeys(draft, [
      'schema', 'policy', 'proposalId', 'scan', 'draft', 'evidence'
    ]) ||
        !deepEqual(draft.schema, DRAFT_SCHEMA) ||
        !deepEqual(draft.policy, POLICY) ||
        typeof draft.proposalId !== 'string' || !draft.proposalId ||
        !validClaim(draft.scan) ||
        !ownKeys(draft.draft, ['cause', 'lesson']) ||
        AUTOMATIC_CAUSES.indexOf(draft.draft.cause) < 0 ||
        draft.draft.lesson !==
          expectedGenerated(draft.evidence && draft.evidence.reflection,
            draft.draft.cause) ||
        !ownKeys(draft.evidence, [
          'reflection', 'analysis', 'played', 'candidates'
        ]) ||
        !validAnalysisShape(draft.evidence.analysis) ||
        !validAttemptShape(draft.evidence.played) ||
        draft.evidence.played.verdict !== 'not-equivalent' ||
        !Array.isArray(draft.evidence.candidates) ||
        !draft.evidence.candidates.every(validAttemptShape) ||
        draft.proposalId !==
          proposalId(draft.scan, draft.evidence.analysis.provider) ||
        draft.scan.playedSan !== draft.evidence.played.attempt.san) {
      return 'an invalid lesson-proposal draft';
    }
    return null;
  }

  function propose(input) {
    try {
      var trusted = snapshot(input);
      if (!trusted || !ownKeys(trusted, [
        'claim', 'state', 'reflection', 'playedGrade', 'candidateGrades'
      ]) || !validClaim(trusted.claim) ||
          !trusted.state || !Array.isArray(trusted.state.history) ||
          trusted.state.history.length !== trusted.claim.ply ||
          Calculation.validate(trusted.reflection, trusted.state) !== null) {
        return null;
      }
      var index = legalIndex(trusted.state);
      var played = normalizeGrade(trusted.playedGrade, trusted.state, index);
      if (!played || played.attempt.verdict !== 'not-equivalent' ||
          trusted.claim.playedSan !== played.attempt.attempt.san) return null;

      var candidates = normalizeCandidateGrades(
        trusted.candidateGrades, trusted.reflection, played.analysis,
        trusted.state, index);
      var generated = automaticFinding(
        trusted.state, trusted.reflection, candidates);
      if (!generated) return null;

      return deepFreeze({
        schema: { id: DRAFT_SCHEMA.id, version: DRAFT_SCHEMA.version },
        policy: { id: POLICY.id, version: POLICY.version },
        proposalId: proposalId(trusted.claim, played.analysis.provider),
        scan: trusted.claim,
        draft: generated,
        evidence: {
          reflection: trusted.reflection,
          analysis: played.analysis,
          played: played.attempt,
          candidates: candidates
        }
      });
    } catch (e) {
      return null;
    }
  }

  function validApproval(cause, lesson) {
    return EDITABLE_CAUSES.indexOf(cause) >= 0 &&
      typeof lesson === 'string' && !!lesson &&
      lesson === lesson.trim() && lesson.length <= MAX_LESSON_LENGTH;
  }

  function approve(draft, cause, lesson) {
    try {
      var trusted = snapshot(draft);
      if (draftShapeError(trusted) || !validApproval(cause, lesson)) return null;
      return deepFreeze({
        schema: {
          id: APPROVAL_SCHEMA.id,
          version: APPROVAL_SCHEMA.version
        },
        policy: trusted.policy,
        proposalId: trusted.proposalId,
        scan: trusted.scan,
        draft: trusted.draft,
        approval: { cause: cause, lesson: lesson },
        evidence: trusted.evidence
      });
    } catch (e) {
      return null;
    }
  }

  function approvalShapeError(value) {
    if (!jsonSafe(value) || !ownKeys(value, [
      'schema', 'policy', 'proposalId', 'scan', 'draft',
      'approval', 'evidence'
    ]) ||
        !deepEqual(value.schema, APPROVAL_SCHEMA) ||
        !deepEqual(value.policy, POLICY) ||
        !ownKeys(value.approval, ['cause', 'lesson']) ||
        !validApproval(value.approval.cause, value.approval.lesson)) {
      return 'an invalid lesson-proposal approval';
    }
    var draft = {
      schema: { id: DRAFT_SCHEMA.id, version: DRAFT_SCHEMA.version },
      policy: value.policy,
      proposalId: value.proposalId,
      scan: value.scan,
      draft: value.draft,
      evidence: value.evidence
    };
    return draftShapeError(draft);
  }

  function cardMatches(card, approval, state, equivalence, reflection, index) {
    if (!card || typeof card !== 'object' || Array.isArray(card) ||
        card.ply !== approval.scan.ply ||
        card.fenBefore !== Chess.toFen(state) ||
        card.playedSan !== approval.scan.playedSan ||
        card.bestSan !== approval.evidence.analysis.best.san ||
        card.kind !== 'differ' ||
        card.cause !== approval.approval.cause ||
        card.lesson !== approval.approval.lesson ||
        card.depth !== approval.evidence.analysis.depth ||
        card.complete !== true ||
        !deepEqual(card.reflection, reflection) ||
        !deepEqual(card.equivalence, equivalence)) return false;
    var best = index.byUci[approval.evidence.analysis.best.uci];
    return !!best && !!card.bestMove &&
      card.bestMove.from === best.move.from &&
      card.bestMove.to === best.move.to &&
      (card.bestMove.promotion || null) ===
        (best.move.promotion || null);
  }

  function validate(value, context) {
    try {
      var trustedValue = snapshot(value);
      var trusted = snapshot(context);
      var shapeError = approvalShapeError(trustedValue);
      if (shapeError) return shapeError;
      if (!trusted || !ownKeys(trusted, [
        'state', 'reflection', 'equivalence', 'card'
      ]) || !trusted.state || !Array.isArray(trusted.state.history) ||
          trusted.state.history.length !== trustedValue.scan.ply ||
          Calculation.validate(trusted.reflection, trusted.state) !== null ||
          !deepEqual(trustedValue.evidence.reflection, trusted.reflection)) {
        return 'lesson-proposal evidence has a different reflection or source';
      }

      var index = legalIndex(trusted.state);
      var analysis = trustedValue.evidence.analysis;
      if (!validateAnalysis(analysis, trusted.state, index) ||
          !deepEqual(trusted.equivalence, analysis)) {
        return 'lesson-proposal evidence has different analysis provenance';
      }
      var played = trustedValue.evidence.played;
      if (!validateAttempt(played, analysis, trusted.state, index) ||
          played.verdict !== 'not-equivalent' ||
          played.attempt.san !== trustedValue.scan.playedSan) {
        return 'lesson-proposal evidence has no verified played-move error';
      }

      var reflectionMoves = Object.create(null);
      trusted.reflection.candidates.moves.forEach(function (move) {
        reflectionMoves[move.uci] = true;
      });
      var seen = Object.create(null);
      for (var i = 0; i < trustedValue.evidence.candidates.length; i++) {
        var candidate = trustedValue.evidence.candidates[i];
        if (!validateAttempt(candidate, analysis, trusted.state, index) ||
            !reflectionMoves[candidate.attempt.uci] ||
            seen[candidate.attempt.uci]) {
          return 'lesson-proposal evidence has an invalid candidate grade';
        }
        seen[candidate.attempt.uci] = true;
      }

      var generated = automaticFinding(
        trusted.state, trusted.reflection,
        trustedValue.evidence.candidates);
      if (!generated || !deepEqual(generated, trustedValue.draft) ||
          trustedValue.proposalId !==
            proposalId(trustedValue.scan, analysis.provider)) {
        return 'lesson-proposal finding is not reproducible';
      }
      if (!cardMatches(
        trusted.card, trustedValue, trusted.state, trusted.equivalence,
        trusted.reflection, index)) {
        return 'lesson-proposal approval contradicts its card';
      }
      return null;
    } catch (e) {
      return 'an unusable lesson-proposal approval';
    }
  }

  return deepFreeze({
    POLICY: POLICY,
    DRAFT_SCHEMA: DRAFT_SCHEMA,
    APPROVAL_SCHEMA: APPROVAL_SCHEMA,
    SCAN_ALGORITHM: SCAN_ALGORITHM,
    MAX_PROPOSALS: MAX_PROPOSALS,
    MAX_LESSON_LENGTH: MAX_LESSON_LENGTH,
    COPY: COPY,
    AUTOMATIC_CAUSES: AUTOMATIC_CAUSES,
    EDITABLE_CAUSES: EDITABLE_CAUSES,
    propose: propose,
    approve: approve,
    validate: validate
  });
});
