/*
 * Chessy structured Calculation evidence (Train v2 E3, #76).
 *
 * This module turns the player's pre-engine reflection into a small,
 * versioned chess record:
 *
 *   threat → candidate moves → calculated line → strongest reply → evaluation
 *
 * Move text is only an input convenience. Persisted moves are canonical
 * { uci, san } pairs that are replayed through the rules engine. The module
 * contains no analysis and reveals no engine preference, so using it before
 * Gate 0 does not leak a verdict.
 *
 * Consumption rules for downstream lesson generation (#108):
 * - every field is player self-report, never engine-verified chess evidence;
 * - `unclear` permits no negative inference, while `none` records only the
 *   player's reported absence;
 * - candidate omissions are not errors unless every listed root is graded and
 *   none is accepted/equivalent/unresolved;
 * - a claimed strongest reply needs its own reply-position equivalence check
 *   before a mismatch can support a lesson; and
 * - an evaluation mismatch needs a versioned CP/mate bucket policy for the
 *   specific candidate, not the engine's overall root score.
 */
(function (global, factory) {
  'use strict';

  const api = factory(global && global.Chess);
  if (!api) return;

  global.ChessyCalculation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function (Chess) {
  'use strict';
  if (!Chess) return null;

  const SCHEMA = Object.freeze({
    id: 'chessy-calculation-reflection',
    version: 1
  });
  const PROVENANCE = 'player-self-report/pre-engine-v1';
  const NULL_MOVE_BASIS = 'null-move-hypothesis-v1';
  const EVALUATIONS = Object.freeze([
    'winning', 'better', 'equal', 'worse', 'lost', 'unclear'
  ]);
  const THREAT_KINDS = Object.freeze([
    'none', 'move', 'in-check', 'unclear'
  ]);
  const CANDIDATE_STATUSES = Object.freeze([
    'listed', 'none', 'unclear'
  ]);
  const CALCULATION_STATUSES = Object.freeze([
    'line', 'none', 'unclear'
  ]);
  const MAX_CANDIDATES = 5;
  const MAX_LINE_PLIES = 8;

  function ownKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    return keys.length === wanted.length &&
      keys.every(function (key, i) { return key === wanted[i]; });
  }

  function uciOf(move) {
    return Chess.sqName(move.from) + Chess.sqName(move.to) +
      (move.promotion ? move.promotion.toLowerCase() : '');
  }

  function moveEntry(state, move, legal) {
    return {
      uci: uciOf(move),
      san: Chess.toSan(state, move, legal)
    };
  }

  function normalizeSan(value) {
    return String(value || '')
      .trim()
      .replace(/^0-0-0/, 'O-O-O')
      .replace(/^0-0/, 'O-O')
      .replace(/[!?]+$/g, '')
      .replace(/[+#]+$/g, '');
  }

  function findMove(state, token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const legal = Chess.legalMoves(state);
    const lower = raw.toLowerCase();
    let move = null;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(lower)) {
      move = legal.find(function (candidate) {
        return uciOf(candidate) === lower;
      }) || null;
    } else {
      const wanted = normalizeSan(raw);
      move = legal.find(function (candidate) {
        return normalizeSan(Chess.toSan(state, candidate, legal)) === wanted;
      }) || null;
    }
    return move ? { move: move, entry: moveEntry(state, move, legal) } : null;
  }

  // "What happens if I ignore it?" is represented by a documented null-move
  // hypothetical: toggle the side to move and clear en passant. Castling and
  // placement remain unchanged. Null move is unavailable while the player is
  // already in check; that fact has its own structured threat kind.
  function ignoredState(state) {
    if (Chess.inCheck(state, state.turn)) return null;
    const fields = Chess.toFen(state).split(/\s+/);
    if (fields.length !== 6) return null;
    fields[1] = state.turn === 'w' ? 'b' : 'w';
    fields[3] = '-';
    fields[4] = String((Number(fields[4]) || 0) + 1);
    try { return Chess.parseFen(fields.join(' ')); }
    catch (e) { return null; }
  }

  function splitCandidates(raw) {
    return String(raw || '').split(/[,\n;]/).map(function (part) {
      return part.trim();
    }).filter(Boolean);
  }

  function splitLine(raw) {
    return String(raw || '').trim().split(/\s+/).filter(Boolean);
  }

  function fail(field, message) {
    return { ok: false, field: field, message: message, value: null };
  }

  function buildThreat(state, kind, rawMove) {
    if (THREAT_KINDS.indexOf(kind) < 0) {
      return fail('threatKind', 'Choose what kind of threat you saw.');
    }
    const inCheck = Chess.inCheck(state, state.turn);
    if (kind === 'in-check') {
      return inCheck
        ? { ok: true, value: {
          kind: kind, basis: null, hypotheticalMove: null
        } }
        : fail('threatKind', 'This position is not currently check.');
    }
    if (kind === 'move') {
      if (inCheck) {
        return fail('threatKind',
          'You are already in check; record that instead of a hypothetical next move.');
      }
      const ignored = ignoredState(state);
      const found = ignored && findMove(ignored, rawMove);
      return found
        ? { ok: true, value: {
          kind: kind,
          basis: NULL_MOVE_BASIS,
          hypotheticalMove: found.entry
        } }
        : fail('threatMove',
          'Enter a legal opponent move in SAN or UCI for the “ignore it” position.');
    }
    return { ok: true, value: {
      kind: kind, basis: null, hypotheticalMove: null
    } };
  }

  function build(state, raw) {
    try {
      if (!state || !raw || typeof raw !== 'object') {
        return fail(null, 'The reflection could not be read.');
      }
      // The exact archived replay context is part of the evidence: a line may
      // end by repetition, and #108 must not reinterpret it from FEN alone.
      if (!Array.isArray(state.history) || !state.positions ||
          typeof state.positions !== 'object') {
        return fail(null, 'The reflection has no complete replay context.');
      }
      if (Chess.gameStatus(state).over) {
        return fail(null, 'The reflection position is already game over.');
      }
      const threat = buildThreat(
        state, String(raw.threatKind || ''), String(raw.threatMove || '').trim());
      if (!threat.ok) return threat;

      const candidateStatus = String(raw.candidateStatus || '');
      if (CANDIDATE_STATUSES.indexOf(candidateStatus) < 0) {
        return fail('candidateStatus', 'Choose how you generated candidate moves.');
      }
      const candidateTokens = candidateStatus === 'listed'
        ? splitCandidates(raw.candidates) : [];
      if (candidateStatus === 'listed' && !candidateTokens.length) {
        return fail('candidates', 'Enter at least one legal candidate move.');
      }
      if (candidateTokens.length > MAX_CANDIDATES) {
        return fail('candidates', 'Enter at most ' + MAX_CANDIDATES + ' candidate moves.');
      }
      const candidates = [];
      const seenCandidates = Object.create(null);
      for (let i = 0; i < candidateTokens.length; i++) {
        const found = findMove(state, candidateTokens[i]);
        if (!found) {
          return fail('candidates',
            'Candidate “' + candidateTokens[i] + '” is not legal in this position.');
        }
        if (seenCandidates[found.entry.uci]) {
          return fail('candidates', 'List each candidate move only once.');
        }
        seenCandidates[found.entry.uci] = true;
        candidates.push(found.entry);
      }

      const calculationStatus = String(raw.calculationStatus || '');
      if (CALCULATION_STATUSES.indexOf(calculationStatus) < 0) {
        return fail('calculationStatus', 'Choose whether you calculated a line.');
      }
      const lineTokens = calculationStatus === 'line' ? splitLine(raw.line) : [];
      if (calculationStatus === 'line' && !lineTokens.length) {
        return fail('line', 'Enter the line you calculated, starting with your candidate.');
      }
      if (lineTokens.length > MAX_LINE_PLIES) {
        return fail('line', 'Keep the calculated line to ' + MAX_LINE_PLIES + ' plies.');
      }
      const line = [];
      let cursor = state;
      for (let j = 0; j < lineTokens.length; j++) {
        if (Chess.gameStatus(cursor).over) {
          return fail('line', 'The calculated line continues after the game is over.');
        }
        const lineMove = findMove(cursor, lineTokens[j]);
        if (!lineMove) {
          return fail('line',
            'Line move “' + lineTokens[j] + '” is not legal at ply ' + (j + 1) + '.');
        }
        line.push(lineMove.entry);
        cursor = Chess.playMove(cursor, lineMove.move);
      }
      if (calculationStatus === 'line') {
        if (candidateStatus === 'listed' && !seenCandidates[line[0].uci]) {
          return fail('line', 'The calculated line must start with one of your candidates.');
        }
        if (line.length < 2 && !Chess.gameStatus(cursor).over) {
          return fail('line', 'Add the opponent’s strongest reply to your line.');
        }
      }

      const evaluation = String(raw.evaluation || '');
      if (EVALUATIONS.indexOf(evaluation) < 0) {
        return fail('evaluation',
          'Choose your final evaluation of the position or chosen line.');
      }

      return {
        ok: true,
        field: null,
        message: null,
        value: {
          schema: { id: SCHEMA.id, version: SCHEMA.version },
          provenance: PROVENANCE,
          threat: threat.value,
          candidates: {
            status: candidateStatus,
            moves: candidates
          },
          calculation: {
            status: calculationStatus,
            strongestReply: line.length > 1 ? line[1] : null,
            line: line,
            // Always from the root side-to-move's point of view.
            evaluation: evaluation
          }
        }
      };
    } catch (e) {
      return fail(null, 'The reflection could not be validated against this position.');
    }
  }

  function sameEntry(left, right) {
    return !!left && !!right &&
      left.uci === right.uci && left.san === right.san;
  }

  function validateEntry(entry, state) {
    if (!ownKeys(entry, ['uci', 'san']) ||
        typeof entry.uci !== 'string' ||
        !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(entry.uci) ||
        typeof entry.san !== 'string' || !entry.san) {
      return false;
    }
    const found = findMove(state, entry.uci);
    return !!found && sameEntry(found.entry, entry);
  }

  // Returns null when valid, otherwise a concise trust-boundary error.
  function validate(value, state) {
    try {
      if (!state || !Array.isArray(state.history) || !state.positions ||
          typeof state.positions !== 'object') {
        return 'a structured reflection without complete replay context';
      }
      if (Chess.gameStatus(state).over) {
        return 'a structured reflection for a terminal position';
      }
      if (!ownKeys(value, [
        'schema', 'provenance', 'threat', 'candidates', 'calculation'
      ])) return 'an invalid structured-reflection shape';
      if (!ownKeys(value.schema, ['id', 'version']) ||
          value.schema.id !== SCHEMA.id ||
          value.schema.version !== SCHEMA.version) {
        return 'an unsupported structured-reflection schema';
      }
      if (value.provenance !== PROVENANCE) {
        return 'an invalid structured-reflection provenance';
      }
      if (!ownKeys(value.threat, ['kind', 'basis', 'hypotheticalMove']) ||
          THREAT_KINDS.indexOf(value.threat.kind) < 0) {
        return 'an invalid structured threat';
      }
      if (value.threat.kind === 'move') {
        const ignored = ignoredState(state);
        if (value.threat.basis !== NULL_MOVE_BASIS ||
            !ignored ||
            !validateEntry(value.threat.hypotheticalMove, ignored)) {
          return 'an illegal structured threat move';
        }
      } else {
        if (value.threat.basis !== null ||
            value.threat.hypotheticalMove !== null) {
          return 'a threat kind with an unexpected hypothetical move';
        }
        if (value.threat.kind === 'in-check' &&
            !Chess.inCheck(state, state.turn)) {
          return 'an in-check threat outside check';
        }
      }

      if (!ownKeys(value.candidates, ['status', 'moves']) ||
          CANDIDATE_STATUSES.indexOf(value.candidates.status) < 0 ||
          !Array.isArray(value.candidates.moves) ||
          value.candidates.moves.length > MAX_CANDIDATES ||
          (value.candidates.status === 'listed') !==
            (value.candidates.moves.length > 0)) {
        return 'an invalid candidate set';
      }
      const seen = Object.create(null);
      for (let i = 0; i < value.candidates.moves.length; i++) {
        if (!validateEntry(value.candidates.moves[i], state) ||
            seen[value.candidates.moves[i].uci]) {
          return 'an illegal or duplicate candidate';
        }
        seen[value.candidates.moves[i].uci] = true;
      }

      if (!ownKeys(value.calculation, [
        'status', 'strongestReply', 'line', 'evaluation'
      ]) ||
          CALCULATION_STATUSES.indexOf(value.calculation.status) < 0 ||
          !Array.isArray(value.calculation.line) ||
          value.calculation.line.length > MAX_LINE_PLIES ||
          (value.calculation.status === 'line') !==
            (value.calculation.line.length > 0)) {
        return 'an invalid calculated line';
      }
      let cursor = state;
      for (let j = 0; j < value.calculation.line.length; j++) {
        if (Chess.gameStatus(cursor).over ||
            !validateEntry(value.calculation.line[j], cursor)) {
          return 'an illegal calculated line';
        }
        const found = findMove(cursor, value.calculation.line[j].uci);
        cursor = Chess.playMove(cursor, found.move);
      }
      if (value.calculation.status === 'line') {
        if (value.candidates.status === 'listed' &&
            !seen[value.calculation.line[0].uci]) {
          return 'a calculated line outside the candidate set';
        }
        if (value.calculation.line.length < 2 && !Chess.gameStatus(cursor).over) {
          return 'a calculated line without the strongest reply';
        }
      }
      const expectedReply = value.calculation.line.length > 1
        ? value.calculation.line[1] : null;
      if ((value.calculation.strongestReply !== null &&
           !ownKeys(value.calculation.strongestReply, ['uci', 'san'])) ||
          (expectedReply === null && value.calculation.strongestReply !== null) ||
          (expectedReply !== null &&
           !sameEntry(expectedReply, value.calculation.strongestReply))) {
        return 'a strongest reply that contradicts the line';
      }
      if (EVALUATIONS.indexOf(value.calculation.evaluation) < 0) {
        return 'an invalid final evaluation';
      }
      return null;
    } catch (e) {
      return 'an unusable structured reflection';
    }
  }

  return Object.freeze({
    SCHEMA: SCHEMA,
    PROVENANCE: PROVENANCE,
    NULL_MOVE_BASIS: NULL_MOVE_BASIS,
    EVALUATIONS: EVALUATIONS,
    THREAT_KINDS: THREAT_KINDS,
    CANDIDATE_STATUSES: CANDIDATE_STATUSES,
    CALCULATION_STATUSES: CALCULATION_STATUSES,
    MAX_CANDIDATES: MAX_CANDIDATES,
    MAX_LINE_PLIES: MAX_LINE_PLIES,
    build: build,
    validate: validate
  });
});
