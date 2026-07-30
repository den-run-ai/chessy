/* Structured Calculation evidence: legal canonical inputs and fail-closed
 * persisted validation (Train v2 E3, #76). */
'use strict';

require('../assets/engine.js');
const Calculation = require('../assets/calculation.js');
require('../assets/store.js');
const Chess = global.Chess;
const Store = global.CoachStore;

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  passed++;
}

function playSans(sans) {
  let state = Chess.newGameState();
  sans.forEach(function (san) {
    const legal = Chess.legalMoves(state);
    const move = legal.find(function (candidate) {
      return Chess.toSan(state, candidate, legal) === san;
    });
    if (!move) throw new Error('bad fixture SAN ' + san);
    state = Chess.playMove(state, move);
  });
  return state;
}

const start = Chess.newGameState();
const built = Calculation.build(start, {
  threatKind: 'move',
  threatMove: 'e5',
  candidateStatus: 'listed',
  candidates: 'e4, d4',
  calculationStatus: 'line',
  line: 'e4 e5 Nf3 Nc6',
  evaluation: 'equal'
});
check(built.ok, 'a legal structured reflection builds');
check(built.value.schema.id === 'chessy-calculation-reflection' &&
  built.value.schema.version === 1 &&
  built.value.provenance === 'player-self-report/pre-engine-v1',
'the contract is explicitly versioned and marked as player self-report');
check(built.value.threat.kind === 'move' &&
  built.value.threat.basis === 'null-move-hypothesis-v1' &&
  built.value.threat.hypotheticalMove.uci === 'e7e5' &&
  built.value.threat.hypotheticalMove.san === 'e5',
'a hypothetical threat records its null-move basis and canonical SAN/UCI');
check(built.value.candidates.status === 'listed' &&
  built.value.candidates.moves.map(function (x) { return x.uci; }).join(',') ===
  'e2e4,d2d4', 'candidate text becomes legal canonical move records');
check(built.value.calculation.line.map(function (x) { return x.san; }).join(' ') ===
  'e4 e5 Nf3 Nc6', 'the calculated line is replayed and canonicalised');
check(built.value.calculation.strongestReply.uci === 'e7e5',
  'the strongest reply is the opponent move from the replayed line');
check(Calculation.validate(built.value, start) === null,
  'the persisted structured reflection validates');

check(!Calculation.build(start, {
  threatKind: 'none', candidateStatus: 'listed', candidates: 'e4, e4',
  calculationStatus: 'line',
  line: 'e4 e5', evaluation: 'equal'
}).ok, 'duplicate candidates fail closed');
check(!Calculation.build(start, {
  threatKind: 'none', candidateStatus: 'listed', candidates: 'e5',
  calculationStatus: 'line',
  line: 'e5', evaluation: 'equal'
}).ok, 'an illegal candidate fails closed');
const missingReply = Calculation.build(start, {
  threatKind: 'none', candidateStatus: 'listed', candidates: 'e4',
  calculationStatus: 'line',
  line: 'e4', evaluation: 'equal'
});
check(!missingReply.ok && missingReply.field === 'line',
  'a non-terminal line requires the opponent strongest reply');
check(!Calculation.build(start, {
  threatKind: 'none', candidateStatus: 'listed', candidates: 'e4',
  calculationStatus: 'line',
  line: 'd4 d5', evaluation: 'equal'
}).ok, 'the line must begin with a recorded candidate');
check(!Calculation.build(start, {
  threatKind: 'in-check', candidateStatus: 'listed', candidates: 'e4',
  calculationStatus: 'line',
  line: 'e4 e5', evaluation: 'equal'
}).ok, 'in-check cannot be claimed outside check');

const noComparison = Calculation.build(start, {
  threatKind: 'unclear',
  candidateStatus: 'none',
  calculationStatus: 'none',
  evaluation: 'unclear'
});
check(noComparison.ok && noComparison.value.candidates.moves.length === 0 &&
  noComparison.value.calculation.line.length === 0,
'no conscious candidate comparison can be recorded without invented moves or a line');
check(Calculation.validate(noComparison.value, start) === null,
  'explicit missing Calculation evidence remains valid structured evidence');

const partialMemory = Calculation.build(start, {
  threatKind: 'unclear',
  candidateStatus: 'unclear',
  calculationStatus: 'line',
  line: 'e4 e5',
  evaluation: 'unclear'
});
check(partialMemory.ok &&
  partialMemory.value.candidates.moves.length === 0 &&
  partialMemory.value.calculation.line[0].uci === 'e2e4',
  'a remembered line remains valid when the wider candidate set is unclear');
check(Calculation.validate(partialMemory.value, start) === null,
  'partial-memory structured evidence validates without inventing candidates');

const repeated = playSans(['Nf3', 'Nf6', 'Ng1', 'Ng8']);
const pastThreefold = Calculation.build(repeated, {
  threatKind: 'none',
  candidateStatus: 'listed',
  candidates: 'Nf3',
  calculationStatus: 'line',
  line: 'Nf3 Nf6 Ng1 Ng8 e4',
  evaluation: 'equal'
});
check(!pastThreefold.ok && /game is over/.test(pastThreefold.message),
  'full replay context rejects a line continuing past threefold repetition');

const terminalRepetition = playSans([
  'Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'
]);
check(Chess.gameStatus(terminalRepetition).over &&
  !Calculation.build(terminalRepetition, {
    threatKind: 'none',
    candidateStatus: 'none',
    calculationStatus: 'none',
    evaluation: 'equal'
  }).ok,
  'a reflection cannot be created at an exact-history terminal root');
check(/terminal/.test(Calculation.validate(noComparison.value, terminalRepetition)),
  'persisted no-line evidence cannot hide a terminal repetition root');

const beforeMate = playSans(['f3', 'e5', 'g4']);
const mate = Calculation.build(beforeMate, {
  threatKind: 'none',
  candidateStatus: 'listed',
  candidates: 'Qh4#',
  calculationStatus: 'line',
  line: 'Qh4#',
  evaluation: 'winning'
});
check(mate.ok && mate.value.calculation.strongestReply === null,
  'a terminal first move legitimately has no strongest reply');
check(Calculation.validate(mate.value, beforeMate) === null,
  'the terminal one-ply calculation validates');

const sourceGame = {
  id: 'e3-source',
  sans: ['f3', 'e5', 'g4', 'Qh4#'],
  setupFen: null
};
const sourceCard = {
  gameId: sourceGame.id,
  ply: 3,
  fenBefore: Chess.toFen(beforeMate),
  playedSan: 'Qh4#',
  bestSan: 'Qh4#',
  bestMove: { from: 3, to: 39, promotion: null },
  kind: 'match',
  cause: 'match',
  lesson: 'Look for forcing mates first',
  reflection: mate.value,
  due: Date.now(),
  step: -1,
  attempts: []
};
check(Store.validateCardRecord(sourceCard, null, sourceGame) === null,
  'a structured card binds to its exact archived source move and state');
const wrongPlayedSan = JSON.parse(JSON.stringify(sourceCard));
wrongPlayedSan.playedSan = 'Qh4+';
check(/different played move/.test(
  Store.validateCardRecord(wrongPlayedSan, null, sourceGame)),
  'a structured card cannot claim a played move different from its source');
const illegalSourceGame = {
  id: 'e3-illegal-source',
  sans: ['a1a8'],
  setupFen: null
};
const illegalSourceCard = {
  gameId: illegalSourceGame.id,
  ply: 0,
  fenBefore: Chess.toFen(start),
  playedSan: 'a1a8',
  bestSan: 'e4',
  bestMove: { from: 52, to: 36, promotion: null },
  kind: 'match',
  cause: 'match',
  lesson: 'source legality witness',
  reflection: noComparison.value,
  due: Date.now(),
  step: -1,
  attempts: []
};
check(/illegal structured-reflection source move/.test(
  Store.validateCardRecord(illegalSourceCard, null, illegalSourceGame)),
  'matching source text is still rejected unless it is canonical legal SAN');

const terminalFen =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 8 5';
const terminalFenOnly = Chess.parseFen(terminalFen);
terminalFenOnly.history = [];
terminalFenOnly.positions = {};
terminalFenOnly.positions[Chess.positionKey(terminalFenOnly)] = 1;
const terminalFenReflection = Calculation.build(terminalFenOnly, {
  threatKind: 'none',
  candidateStatus: 'none',
  calculationStatus: 'none',
  evaluation: 'equal'
});
const terminalSource = {
  id: 'e3-terminal-source',
  sans: ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8', 'e4'],
  setupFen: null
};
const terminalCard = {
  gameId: terminalSource.id,
  ply: 8,
  fenBefore: terminalFen,
  playedSan: 'e4',
  bestSan: 'e4',
  bestMove: { from: 52, to: 36, promotion: null },
  kind: 'match',
  cause: 'match',
  lesson: 'terminal history witness',
  reflection: terminalFenReflection.value,
  due: Date.now(),
  step: -1,
  attempts: []
};
check(terminalFenReflection.ok &&
  /different source position/.test(
    Store.validateCardRecord(terminalCard, null, terminalSource)),
  'source replay rejects a forged move and reflection after exact-history game over');

const checkState = Chess.parseFen('4r1k1/8/8/8/8/8/4K3/8 w - - 0 1');
checkState.history = [];
checkState.positions = {};
checkState.positions[Chess.positionKey(checkState)] = 1;
const checkLegal = Chess.legalMoves(checkState);
const escape = checkLegal[0];
const escapeSan = Chess.toSan(checkState, escape, checkLegal);
const afterEscape = Chess.playMove(checkState, escape);
const replyLegal = Chess.legalMoves(afterEscape);
const replySan = Chess.toSan(afterEscape, replyLegal[0], replyLegal);
const checked = Calculation.build(checkState, {
  threatKind: 'in-check',
  candidateStatus: 'listed',
  candidates: escapeSan,
  calculationStatus: 'line',
  line: escapeSan + ' ' + replySan,
  evaluation: 'worse'
});
check(checked.ok && checked.value.threat.kind === 'in-check',
  'a real check is represented without a fabricated threat move');

const changedReply = JSON.parse(JSON.stringify(built.value));
changedReply.calculation.strongestReply = changedReply.calculation.line[2];
check(/strongest reply/.test(Calculation.validate(changedReply, start)),
  'a strongest reply contradicting the line is rejected');
const decoratedReply = JSON.parse(JSON.stringify(built.value));
decoratedReply.calculation.strongestReply.untrusted = true;
check(/strongest reply/.test(Calculation.validate(decoratedReply, start)),
  'a strongest reply with undeclared fields is rejected');
const changedCandidate = JSON.parse(JSON.stringify(built.value));
changedCandidate.candidates.moves[0].san = 'd4';
check(/candidate/.test(Calculation.validate(changedCandidate, start)),
  'non-canonical candidate evidence is rejected');
const changedLine = JSON.parse(JSON.stringify(built.value));
changedLine.calculation.line[1].uci = 'a2a3';
changedLine.calculation.line[1].san = 'a3';
changedLine.calculation.strongestReply = changedLine.calculation.line[1];
check(/calculated line/.test(Calculation.validate(changedLine, start)),
  'a tampered line is rejected at its actual replay ply');
const future = JSON.parse(JSON.stringify(built.value));
future.schema.version = 2;
check(/unsupported/.test(Calculation.validate(future, start)),
  'a future structured-reflection schema is not silently reinterpreted');

console.log('calculation: ' + passed + ' assertions passed');
