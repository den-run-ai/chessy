/*
 * Deterministic automatic lesson proposals (Train v2 E4, #108) — run with:
 *   node test/lesson-proposal.test.js
 */
'use strict';

require('../assets/engine.js');
require('../assets/ai.js');
require('../assets/analysis-core.js');
const AnalysisResult = require('../assets/analysis-result.js');
const Calculation = require('../assets/calculation.js');
const Equivalence = require('../assets/equivalence.js');
const LessonProposal = require('../assets/lesson-proposal.js');
require('../assets/store.js');

const Chess = globalThis.Chess;
const AnalysisCore = globalThis.ChessyAnalysisCore;
const Store = globalThis.CoachStore;

let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error('FAIL: ' + label);
  passed++;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFrozen(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return false;
  }
  return Object.keys(value).every(function (key) {
    return !value[key] || typeof value[key] !== 'object' ||
      deepFrozen(value[key]);
  });
}

function uci(move) {
  return Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '');
}

function cpLine(state, move, score) {
  const legal = Chess.legalMoves(state);
  const san = Chess.toSan(state, move, legal);
  return {
    move: { from: move.from, to: move.to, promotion: move.promotion || null },
    uci: uci(move),
    san: san,
    scoreCpWhite: score,
    scoreCpPlayer: state.turn === 'w' ? score : -score,
    mate: null,
    pv: [san],
    pvUci: [uci(move)]
  };
}

function identity(state, suffix) {
  return {
    engineId: 'lesson-test',
    version: '1.0.0',
    configHash: 'cfg-' + (suffix || 'main'),
    positionFingerprint:
      AnalysisCore.positionFingerprint(state, state.positions)
  };
}

function resultFixture(state, lines, playedIndex, suffix) {
  const ident = identity(state, suffix);
  const played = clone(lines[playedIndex]);
  played.rank = playedIndex + 1;
  played.amongCandidates = true;
  return {
    identity: ident,
    result: {
      engine: {
        id: ident.engineId,
        version: ident.version,
        configHash: ident.configHash
      },
      turn: state.turn,
      positionFingerprint: ident.positionFingerprint,
      complete: true,
      depth: 4,
      nodes: 1234,
      elapsedMs: 12,
      scoreCpWhite: lines[0].scoreCpWhite,
      scoreCpPlayer: lines[0].scoreCpPlayer,
      mate: clone(lines[0].mate),
      bestLines: clone(lines),
      playedLine: played,
      classification: playedIndex === 0 ? 'same' : 'different-candidate',
      stability: { depths: [3, 4], bestMoveStable: true }
    }
  };
}

function grade(fixture, state, attemptUci) {
  return Equivalence.grade(
    fixture.result, state, { identity: fixture.identity }, attemptUci);
}

function reflection(state, options) {
  options = options || {};
  const raw = {
    threatKind: options.threatKind || 'unclear',
    threatMove: options.threatMove || '',
    candidateStatus: options.candidateStatus || 'unclear',
    candidates: (options.candidateMoves || []).map(function (move) {
      const legal = Chess.legalMoves(state);
      return Chess.toSan(state, move, legal);
    }).join(', '),
    calculationStatus: options.calculationStatus || 'unclear',
    line: options.line || '',
    evaluation: options.evaluation || 'unclear'
  };
  const built = Calculation.build(state, raw);
  if (!built.ok) throw new Error('bad reflection fixture: ' + built.message);
  return built.value;
}

function claim(state, playedGrade, options) {
  options = options || {};
  const jobSchema = 1;
  const algorithm = 'critical-moments-v1';
  const sourceRev = options.sourceRev || 'source-a';
  const analysisRev = options.analysisRev || 'analysis-a';
  const scanColor = options.scanColor || 'w';
  const gameId = options.gameId || 'lesson-game';
  return {
    jobSchema: jobSchema,
    algorithm: algorithm,
    sourceRev: sourceRev,
    analysisRev: analysisRev,
    scanColor: scanColor,
    identity: 'chessy-moment-scan:' + JSON.stringify([
      jobSchema, algorithm, gameId, sourceRev, analysisRev, scanColor
    ]),
    ordinal: options.ordinal || 0,
    ply: state.history.length,
    playedSan: playedGrade.attempt.san
  };
}

function scanHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function proposal(input) {
  return LessonProposal.propose({
    claim: input.claim,
    state: input.state,
    reflection: input.reflection,
    playedGrade: input.playedGrade,
    candidateGrades: input.candidateGrades || []
  });
}

function equivalenceFromGrade(ev) {
  return {
    criterion: clone(ev.criterion),
    provider: clone(ev.provider),
    positionFingerprint: ev.positionFingerprint,
    turn: ev.turn,
    depth: ev.depth,
    complete: ev.complete,
    coverage: ev.coverage,
    legalRootCount: ev.legalRootCount,
    candidateLineCount: ev.candidateLineCount,
    coveredRootCount: ev.coveredRootCount,
    stability: clone(ev.stability),
    best: clone(ev.best),
    accepted: clone(ev.accepted)
  };
}

function cardFor(state, approval, equivalence, reflectionValue) {
  const legal = Chess.legalMoves(state);
  const bestMove = legal.find(function (move) {
    return uci(move) === approval.evidence.analysis.best.uci;
  });
  return {
    gameId: 'lesson-game',
    ply: approval.scan.ply,
    fenBefore: Chess.toFen(state),
    playedSan: approval.scan.playedSan,
    bestSan: approval.evidence.analysis.best.san,
    bestMove: {
      from: bestMove.from,
      to: bestMove.to,
      promotion: bestMove.promotion || null
    },
    depth: approval.evidence.analysis.depth,
    complete: true,
    kind: 'differ',
    cause: approval.approval.cause,
    lesson: approval.approval.lesson,
    reflection: clone(reflectionValue),
    equivalence: clone(equivalence)
  };
}

const start = Chess.newGameState();
const legal = Chess.legalMoves(start);
const main = resultFixture(start, [
  cpLine(start, legal[0], 100),
  cpLine(start, legal[1], 80),
  cpLine(start, legal[2], 0),
  cpLine(start, legal[3], -50),
  cpLine(start, legal[4], -80)
], 3);
check(AnalysisResult.validate(main.result, start, {
  identity: main.identity, requireComplete: true
}).ok, 'the synthetic complete analysis fixture validates');

const played = grade(main, start, main.result.bestLines[3].uci);
const best = grade(main, start, main.result.bestLines[0].uci);
const equivalent = grade(main, start, main.result.bestLines[1].uci);
const badCandidateA = grade(main, start, main.result.bestLines[2].uci);
const badCandidateB = grade(main, start, main.result.bestLines[4].uci);
const unknownCandidate = grade(main, start, uci(legal[6]));
check(played.verdict === 'not-equivalent' &&
  played.complete === true && played.stability.bestMoveStable === true,
'the played fixture carries the hard-gate rejection evidence');
check(best.verdict === 'best' && equivalent.verdict === 'equivalent' &&
  badCandidateA.verdict === 'not-equivalent' &&
  badCandidateB.verdict === 'not-equivalent' &&
  unknownCandidate.verdict === 'unknown',
'candidate fixtures cover every equivalence verdict used by the policy');

// ---------------------------------------------------------------------------
// Hard zero gates
// ---------------------------------------------------------------------------
const noCandidates = reflection(start, {
  threatKind: 'unclear',
  candidateStatus: 'none',
  calculationStatus: 'none'
});
const baseClaim = claim(start, played);
const base = {
  state: start,
  claim: baseClaim,
  reflection: noCandidates,
  playedGrade: played,
  candidateGrades: []
};

check(proposal(base) !== null,
  'a complete stable non-equivalent played grade can reach diagnosis');
check(proposal(Object.assign({}, base, { claim: null })) === null,
  'manual reflection without a completed-scan claim yields zero');
const wrongAlgorithm = clone(baseClaim);
wrongAlgorithm.algorithm = 'critical-moments-v2';
check(proposal(Object.assign({}, base, { claim: wrongAlgorithm })) === null,
  'an unsupported scan algorithm yields zero');
const wrongPly = clone(baseClaim);
wrongPly.ply = 1;
check(proposal(Object.assign({}, base, { claim: wrongPly })) === null,
  'a scan claim outside the exact replay ply yields zero');
const badReflection = clone(noCandidates);
badReflection.schema.version = 2;
check(proposal(Object.assign({}, base, { reflection: badReflection })) === null,
  'an invalid Calculation schema yields zero');

const failedGrade = { ok: false, reason: 'analysis-partial', verdict: null };
check(proposal(Object.assign({}, base, { playedGrade: failedGrade })) === null,
  'a failed equivalence grade yields zero');
const partialGrade = clone(played);
partialGrade.complete = false;
check(proposal(Object.assign({}, base, { playedGrade: partialGrade })) === null,
  'an incomplete grade yields zero');
const unstableGrade = clone(played);
unstableGrade.stability.bestMoveStable = false;
check(proposal(Object.assign({}, base, { playedGrade: unstableGrade })) === null,
  'an unstable rejection yields zero');
const wrongFingerprint = clone(played);
wrongFingerprint.positionFingerprint = 'different-position';
check(proposal(Object.assign({}, base, { playedGrade: wrongFingerprint })) === null,
  'a grade from another repetition fingerprint yields zero');
const wrongSan = clone(played);
wrongSan.attempt.san = best.attempt.san;
const wrongSanClaim = claim(start, played);
wrongSanClaim.playedSan = wrongSan.attempt.san;
check(proposal(Object.assign({}, base, {
  claim: wrongSanClaim, playedGrade: wrongSan
})) === null, 'a non-canonical played SAN yields zero');
check(proposal(Object.assign({}, base, {
  claim: claim(start, best), playedGrade: best
})) === null, 'an engine-best move yields no positive proposal');
check(proposal(Object.assign({}, base, {
  claim: claim(start, equivalent), playedGrade: equivalent
})) === null, 'an equivalent move yields no positive proposal');
check(proposal(Object.assign({}, base, {
  claim: claim(start, unknownCandidate), playedGrade: unknownCandidate
})) === null, 'an unresolved played move yields zero');

// ---------------------------------------------------------------------------
// Cause priority and the exact all-candidates rule
// ---------------------------------------------------------------------------
const checkState = Chess.parseFen('4r1k1/8/8/8/8/8/4K3/8 w - - 0 1');
checkState.history = [];
checkState.positions = {};
checkState.positions[Chess.positionKey(checkState)] = 1;
const checkLegal = Chess.legalMoves(checkState);
const checkedFixture = resultFixture(checkState, [
  cpLine(checkState, checkLegal[0], 100),
  cpLine(checkState, checkLegal[1], -100)
], 1, 'check');
const checkedPlayed = grade(
  checkedFixture, checkState, checkedFixture.result.bestLines[1].uci);
const allMissing = reflection(checkState, {
  threatKind: 'none',
  candidateStatus: 'none',
  calculationStatus: 'none'
});
const threatDraft = proposal({
  state: checkState,
  claim: claim(checkState, checkedPlayed, { gameId: 'checked-game' }),
  reflection: allMissing,
  playedGrade: checkedPlayed
});
check(threatDraft.draft.cause === 'threat-scan' &&
  threatDraft.draft.lesson === LessonProposal.COPY['threat-scan'],
'objective check plus explicit no-threat report wins cause priority');

const candidateNoneDraft = proposal(base);
check(candidateNoneDraft.draft.cause === 'candidates' &&
  candidateNoneDraft.draft.lesson ===
    LessonProposal.COPY['candidates-none'],
'explicitly no candidate comparison produces the fixed candidates lesson');

const listed = reflection(start, {
  threatKind: 'unclear',
  candidateStatus: 'listed',
  candidateMoves: [legal[2], legal[4]],
  calculationStatus: 'unclear'
});
const listedBase = {
  state: start,
  claim: baseClaim,
  reflection: listed,
  playedGrade: played
};
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: []
})) === null, 'missing candidate grades suppress candidate inference');
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: [badCandidateA]
})) === null, 'one missing listed-root grade suppresses candidate inference');
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: [best, badCandidateB]
})) === null, 'a best listed candidate suppresses candidate inference');
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: [equivalent, badCandidateB]
})) === null, 'an equivalent listed candidate suppresses candidate inference');

const listedUnknown = reflection(start, {
  threatKind: 'unclear',
  candidateStatus: 'listed',
  candidateMoves: [legal[2], legal[6]],
  calculationStatus: 'unclear'
});
check(proposal({
  state: start,
  claim: baseClaim,
  reflection: listedUnknown,
  playedGrade: played,
  candidateGrades: [badCandidateA, unknownCandidate]
}) === null, 'an uncovered listed candidate suppresses candidate inference');

const foreignCandidate = clone(badCandidateB);
foreignCandidate.provider.configHash = 'another-analysis';
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: [badCandidateA, foreignCandidate]
})) === null, 'a candidate grade with different provenance is treated as missing');
check(proposal(Object.assign({}, listedBase, {
  candidateGrades: [badCandidateA, badCandidateA, badCandidateB]
})) === null, 'duplicate evidence cannot satisfy an exact listed root');

const candidateListedDraft = proposal(Object.assign({}, listedBase, {
  candidateGrades: [badCandidateB, badCandidateA]
}));
check(candidateListedDraft.draft.cause === 'candidates' &&
  candidateListedDraft.draft.lesson ===
    LessonProposal.COPY['candidates-listed'] &&
  candidateListedDraft.evidence.candidates.map(function (item) {
    return item.attempt.uci;
  }).join(',') === [uci(legal[2]), uci(legal[4])].join(','),
'every exact listed root rejected under one provenance produces one ordered draft');

const calculationMissing = reflection(start, {
  threatKind: 'unclear',
  candidateStatus: 'listed',
  candidateMoves: [legal[2], legal[4]],
  calculationStatus: 'none'
});
const calculationDraft = proposal({
  state: start,
  claim: baseClaim,
  reflection: calculationMissing,
  playedGrade: played,
  candidateGrades: [equivalent, badCandidateB]
});
check(calculationDraft.draft.cause === 'calculation' &&
  calculationDraft.draft.lesson === LessonProposal.COPY.calculation,
'a suppressed candidate finding falls through to explicit no-calculation evidence');

const nullMoveThreat = reflection(start, {
  threatKind: 'move',
  threatMove: 'e5',
  candidateStatus: 'unclear',
  calculationStatus: 'unclear'
});
check(proposal(Object.assign({}, base, {
  reflection: nullMoveThreat
})) === null, 'a null-move threat hypothesis never proves a threat lesson');
const evaluationOnly = reflection(start, {
  threatKind: 'unclear',
  candidateStatus: 'unclear',
  calculationStatus: 'line',
  line: 'e4 e5',
  evaluation: 'lost'
});
check(proposal(Object.assign({}, base, {
  reflection: evaluationOnly
})) === null, 'evaluation and raw calculated-line differences have no v1 fallback');

// ---------------------------------------------------------------------------
// Determinism, approval and persisted validation
// ---------------------------------------------------------------------------
const candidateListedAgain = proposal(Object.assign({}, listedBase, {
  candidateGrades: [badCandidateA, badCandidateB]
}));
check(JSON.stringify(candidateListedDraft) ===
  JSON.stringify(candidateListedAgain),
'candidate grade input order cannot change the deterministic draft');
check(deepFrozen(candidateListedDraft) &&
  JSON.stringify(candidateListedDraft) ===
    JSON.stringify(JSON.parse(JSON.stringify(candidateListedDraft))),
'drafts are deeply frozen and JSON-safe');
check(candidateListedDraft.proposalId.indexOf('critical-moments-v1') >= 0 &&
  candidateListedDraft.proposalId.indexOf('lesson-test') >= 0 &&
  candidateListedDraft.proposalId.indexOf('cfg-main') >= 0,
'the deterministic proposal id includes scan and provider identity');

const editedLesson = 'After calculating, compare the resulting position again.';
check(LessonProposal.MAX_LESSON_LENGTH === 500,
  'the policy module owns the fixed editable lesson length boundary');
const approval = LessonProposal.approve(
  candidateListedDraft, 'evaluation', editedLesson);
check(approval && approval.draft.cause === 'candidates' &&
  approval.approval.cause === 'evaluation' &&
  approval.approval.lesson === editedLesson &&
  deepFrozen(approval),
'approval preserves the generated draft and records the player’s explicit edit');
check(LessonProposal.approve(
  candidateListedDraft, 'match', editedLesson) === null,
'a positive match cause cannot approve verified error evidence');
check(LessonProposal.approve(
  candidateListedDraft, 'evaluation', '  padded  ') === null,
'approval rejects an untrimmed lesson');
const decoratedDraft = clone(candidateListedDraft);
decoratedDraft.untrusted = true;
check(LessonProposal.approve(
  decoratedDraft, 'evaluation', editedLesson) === null,
'approval rejects undeclared draft fields');

const persisted = clone(approval);
const persistedReflection = clone(listed);
const persistedEquivalence = equivalenceFromGrade(played);
const card = cardFor(
  start, persisted, persistedEquivalence, persistedReflection);
const validationContext = {
  state: start,
  reflection: persistedReflection,
  equivalence: persistedEquivalence,
  card: card
};
check(LessonProposal.validate(persisted, validationContext) === null,
  'a JSON-round-tripped approval validates against its exact card evidence');

const sourceGame = {
  id: 'lesson-game',
  setupFen: null,
  playerColor: 'w',
  sans: [played.attempt.san],
  clocks: [null],
  timeControl: 'none'
};
const sourceAnalysisRev = scanHash(JSON.stringify({
  setupFen: null, sans: sourceGame.sans
}));
const sourceRev = scanHash(JSON.stringify({
  analysis: sourceAnalysisRev,
  scanColor: 'w',
  playerColor: 'w',
  timeControl: 'none',
  clocks: sourceGame.clocks
}));
const sourceClaim = claim(start, played, {
  sourceRev: sourceRev,
  analysisRev: sourceAnalysisRev,
  gameId: sourceGame.id
});
const sourceDraft = proposal(Object.assign({}, listedBase, {
  claim: sourceClaim,
  candidateGrades: [badCandidateA, badCandidateB]
}));
const sourceApproval = LessonProposal.approve(
  sourceDraft, 'evaluation', editedLesson);
const sourceCard = cardFor(
  start, sourceApproval, persistedEquivalence, persistedReflection);
sourceCard.lessonProposal = clone(sourceApproval);
sourceCard.due = 0;
sourceCard.step = -1;
sourceCard.attempts = [];
const sourceCardError =
  Store.validateCardRecord(sourceCard, null, sourceGame);
check(sourceCardError === null,
  'the card trust boundary reproduces an approval from its archived scan source' +
  (sourceCardError ? ': ' + sourceCardError : ''));
const changedClockSource = clone(sourceGame);
changedClockSource.clocks = [{ thinkMs: 1 }];
check(typeof Store.validateCardRecord(
  sourceCard, null, changedClockSource) === 'string',
'the card trust boundary rejects a proposal after its exact clock source changes');
const forgedSourceCard = clone(sourceCard);
forgedSourceCard.lessonProposal.scan.sourceRev = 'forged-source';
check(typeof Store.validateCardRecord(
  forgedSourceCard, null, sourceGame) === 'string',
'the card trust boundary rejects a forged scan-source claim');
const importedSource = clone(sourceGame);
importedSource.playerColor = null;
const wrongSideRev = scanHash(JSON.stringify({
  analysis: sourceAnalysisRev,
  scanColor: 'b',
  playerColor: null,
  timeControl: 'none',
  clocks: importedSource.clocks
}));
const wrongSideClaim = claim(start, played, {
  sourceRev: wrongSideRev,
  analysisRev: sourceAnalysisRev,
  scanColor: 'b',
  gameId: importedSource.id
});
const wrongSideDraft = proposal(Object.assign({}, listedBase, {
  claim: wrongSideClaim,
  candidateGrades: [badCandidateA, badCandidateB]
}));
const wrongSideApproval = LessonProposal.approve(
  wrongSideDraft, 'evaluation', editedLesson);
const wrongSideCard = cardFor(
  start, wrongSideApproval, persistedEquivalence, persistedReflection);
wrongSideCard.lessonProposal = clone(wrongSideApproval);
wrongSideCard.due = 0;
wrongSideCard.step = -1;
wrongSideCard.attempts = [];
check(typeof Store.validateCardRecord(
  wrongSideCard, null, importedSource) === 'string',
'an imported-side claim cannot transplant a proposal onto the other side’s ply');

function rejects(mutator, label) {
  const changedApproval = clone(persisted);
  const changedContext = clone(validationContext);
  mutator(changedApproval, changedContext);
  check(typeof LessonProposal.validate(changedApproval, changedContext) === 'string',
    label);
}

rejects(function (value) {
  value.schema.version = 2;
}, 'validator rejects a future approval schema');
rejects(function (value) {
  value.policy.version = 2;
}, 'validator rejects a changed policy');
rejects(function (value) {
  value.proposalId += '-forged';
}, 'validator rejects a forged proposal id');
rejects(function (value) {
  value.scan.sourceRev = 'other-source';
}, 'validator binds the proposal id to the scan claim');
rejects(function (value) {
  value.draft.lesson = 'Generic fallback.';
}, 'validator rejects changed generated copy');
rejects(function (value) {
  value.evidence.played.verdict = 'equivalent';
}, 'validator requires the persisted played rejection');
rejects(function (value) {
  value.evidence.played.attempt.san = value.evidence.analysis.best.san;
}, 'validator rechecks canonical played SAN');
rejects(function (value) {
  value.evidence.played.attempt.eval.scoreCpWhite += 10;
  value.evidence.played.attempt.eval.scoreCpPlayer += 10;
}, 'validator reproduces the played non-equivalent comparison');
rejects(function (value) {
  value.evidence.analysis.criterion.params.cpTolerance += 1;
}, 'validator pins the criterion version and parameters');
rejects(function (value) {
  value.evidence.analysis.provider.configHash = 'other-provider';
}, 'validator binds provider provenance');
rejects(function (value) {
  value.evidence.analysis.positionFingerprint = 'other-position';
}, 'validator binds repetition-aware position fingerprint');
rejects(function (value) {
  value.evidence.analysis.stability.bestMoveStable = false;
}, 'validator requires stable-best evidence');
rejects(function (value) {
  value.evidence.analysis.best.san = 'forged';
}, 'validator rechecks canonical best SAN');
rejects(function (value) {
  value.evidence.analysis.accepted.shift();
}, 'validator rejects an accepted set omitting the best');
rejects(function (value) {
  value.evidence.candidates.pop();
}, 'validator reproduces the exact all-candidates finding');
rejects(function (value, context) {
  context.reflection.calculation.evaluation = 'winning';
  context.card.reflection = clone(context.reflection);
}, 'validator binds the approval to the full structured reflection snapshot');
rejects(function (value, context) {
  context.equivalence.provider.configHash = 'other-provider';
  context.card.equivalence = clone(context.equivalence);
}, 'validator cross-checks card equivalence provider provenance');
rejects(function (value, context) {
  context.equivalence.positionFingerprint = 'other-position';
  context.card.equivalence = clone(context.equivalence);
}, 'validator cross-checks card equivalence position fingerprint');
rejects(function (value, context) {
  context.equivalence.stability.bestMoveStable = false;
  context.card.equivalence = clone(context.equivalence);
}, 'validator cross-checks card equivalence stability');
rejects(function (value, context) {
  context.equivalence.best.san = 'forged';
  context.card.equivalence = clone(context.equivalence);
}, 'validator cross-checks card equivalence best move');
rejects(function (value, context) {
  context.equivalence.accepted.pop();
  context.card.equivalence = clone(context.equivalence);
}, 'validator cross-checks the card accepted set');
rejects(function (value, context) {
  context.card.cause = 'calculation';
}, 'validator cross-checks the player-approved card cause');
rejects(function (value, context) {
  context.card.lesson = 'Different lesson.';
}, 'validator cross-checks the player-approved card lesson');
rejects(function (value, context) {
  context.card.bestMove.from = legal[5].from;
  context.card.bestMove.to = legal[5].to;
}, 'validator rechecks the card’s canonical best move');

console.log('lesson-proposal: ' + passed + ' assertions passed');
