/*
 * Chessy reflection — the manual improvement loop from roadmap #23:
 *
 *   flag ONE of your positions → answer the reflection questions →
 *   ONE bounded engine probe → write the cause/lesson → one card.
 *
 * Design rules:
 * - The engine's opinion is never shown before the player has answered
 *   the reflection questions (the form gates the probe), and the answers
 *   are SNAPSHOTTED at submit — rewriting them after seeing the verdict
 *   cannot reach the card.
 * - The player owns the diagnosis: a move that differs from Chessy's
 *   single bounded line is not declared an error — "My move was also
 *   sound" is a first-class cause.
 * - ONE card per moment (game + ply): re-saving replaces the lesson on
 *   the existing card, never mints a duplicate to be drilled twice.
 * - There is no automatic scan, no second probe, no severity grading —
 *   one request, one result (see js/analysis.js).
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof CoachReview === 'undefined' ||
      typeof ChessyAnalysis === 'undefined' || typeof Chess === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };

  const MATE_ISH = 900000; // |score| above this reads as mate
  const CAUSE_LABELS = {
    'threat-scan': 'Missed a threat',
    candidates: 'Good move not among candidates',
    evaluation: 'Judged it wrong',
    calculation: 'Line went wrong on the reply',
    efficiency: 'Right idea, too much time',
    impulse: 'Moved too fast',
    'sound-alternative': 'My move was also sound',
    match: 'Good move (matched Chessy)'
  };

  function fmtScore(s) {
    if (s > MATE_ISH) return '+M';
    if (s < -MATE_ISH) return '−M';
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
  }

  // The flagged moment (game id + ply) and the verdict for it. Plain
  // integer ownership tokens guard the two async steps: a probe or card
  // write that settles after the user moved on must not repaint or
  // re-enable the shared controls.
  let flagged = null;  // { gameId, ply }
  let verdict = null;
  let verifySeq = 0;
  let saveSeq = 0;

  function sameMoment(r) {
    return !!r && !!flagged && r.game.id === flagged.gameId && r.ply === flagged.ply;
  }

  // Review re-rendered: keep the flag button in step with the shown
  // position, and abandon the reflection when the user steps away.
  document.addEventListener('chessy:reviewrender', function () {
    const r = CoachReview.current();
    if (!r) return;
    $('flagMoment').disabled = r.ply >= r.gs.history.length; // end position: nothing was played
    if (!sameMoment(r)) {
      flagged = null;
      verdict = null;
      $('reflectForm').hidden = true;
      $('verifyBox').hidden = true;
    }
  });

  $('flagMoment').addEventListener('click', function () {
    const r = CoachReview.current();
    if (!r || r.ply >= r.gs.history.length) return;
    verifySeq++; // an in-flight probe for another moment is now stale
    saveSeq++;   // so is any card write still owning the shared UI
    flagged = { gameId: r.game.id, ply: r.ply };
    verdict = null;
    // Fresh moment, fresh answers: reflection AND card fields reset, so a
    // stale cause/lesson from the previous moment can never carry over.
    $('reflectThreat').value = '';
    $('reflectCandidates').value = '';
    $('reflectEval').value = '';
    $('cardCause').value = '';
    $('cardLesson').value = '';
    $('reflectForm').hidden = false;
    $('reflectVerify').disabled = false;
    $('verifyBox').hidden = true;
    $('cardSaved').hidden = true;
    $('reflectThreat').focus();
  });

  $('reflectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    // Whitespace is not reflection: native `required` accepts spaces, so
    // trim first and re-run validation — a spaces-only answer is rejected
    // with the browser's own "fill in this field" prompt.
    $('reflectThreat').value = $('reflectThreat').value.trim();
    $('reflectCandidates').value = $('reflectCandidates').value.trim();
    if (!$('reflectForm').reportValidity()) return;
    const r = CoachReview.current();
    if (!sameMoment(r)) return;
    // Snapshot the reflection NOW: these are the answers that passed the
    // reflect-first gate. The fields stay editable while the engine runs,
    // so the card must never reread the DOM at save time.
    const reflection = {
      threat: $('reflectThreat').value,
      candidates: $('reflectCandidates').value,
      evaluation: $('reflectEval').value
    };
    const token = ++verifySeq;
    saveSeq++; // this verdict owns the card controls now
    const ply = r.ply;
    const fenBefore = r.fens[ply];
    const entry = r.gs.history[ply];
    $('verifyBox').hidden = false;
    $('verifyResult').textContent = 'Analysing…';
    $('saveCard').disabled = true;
    $('reflectVerify').disabled = true; // one probe at a time

    ChessyAnalysis.analyse(fenBefore, r.states[ply].positions).then(function (res) {
      if (token === verifySeq) $('reflectVerify').disabled = false;
      // null = superseded by a newer request; token/moment guards cover
      // the user having flagged elsewhere or left the game meanwhile.
      if (res === null || token !== verifySeq || !sameMoment(CoachReview.current())) return;
      // Resolve the engine's move object back to a SAN on this board.
      const legal = Chess.legalMoves(Chess.parseFen(fenBefore));
      const bm = res.move && legal.find(function (m) {
        return m.from === res.move.from && m.to === res.move.to &&
               (m.promotion || null) === (res.move.promotion || null);
      });
      const bestSan = bm ? Chess.toSan(Chess.parseFen(fenBefore), bm, legal) : '?';
      const same = bm && entry.move.from === bm.from && entry.move.to === bm.to &&
        (entry.move.promotion || null) === (bm.promotion || null);
      verdict = {
        gameId: flagged.gameId, ply: ply, fenBefore: fenBefore,
        playedSan: entry.san, bestSan: bestSan,
        bestMove: bm ? { from: bm.from, to: bm.to, promotion: bm.promotion || null } : null,
        bestScore: res.score, depth: res.depth,
        kind: same ? 'match' : 'differ',
        reflection: reflection
      };
      // ONE probe, no severity grading: a single time-bounded line cannot
      // say how bad a different move was — only what Chessy preferred.
      // The player makes the call via the cause picker.
      $('causeLabel').hidden = same;
      $('verifyResult').textContent = (same
        ? 'You played ' + entry.san + ' — Chessy’s line agrees (eval ' +
          fmtScore(res.score) + ', depth ' + res.depth + ').'
        : 'You played ' + entry.san + ' — Chessy preferred ' + bestSan + ' (eval ' +
          fmtScore(res.score) + ', depth ' + res.depth + '). A different move is not' +
          ' necessarily an error — your call below.') +
        ' Chessy estimate, not authoritative analysis.';
      $('saveCard').disabled = false;
    });
  });

  $('saveCard').addEventListener('click', function () {
    const v = verdict;
    if (!v || $('saveCard').disabled) return;
    if (!flagged || v.gameId !== flagged.gameId || v.ply !== flagged.ply) return;
    // Every card needs a one-sentence lesson; a differing move also needs
    // the player's cause call ("my move was also sound" included).
    const lesson = $('cardLesson').value.trim();
    const cause = v.kind === 'match' ? 'match' : $('cardCause').value;
    if (!lesson || !cause) {
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = v.kind === 'match'
        ? 'Write a one-sentence lesson first.'
        : 'Pick a cause (your call) and write a one-sentence lesson first.';
      return;
    }
    const token = ++saveSeq;
    // Disable BEFORE the async write — a double-click (or a slow
    // IndexedDB) must not create duplicate cards for the same moment.
    $('saveCard').disabled = true;
    const now = Date.now();
    const fields = {
      gameId: v.gameId, ply: v.ply, fenBefore: v.fenBefore,
      playedSan: v.playedSan, bestSan: v.bestSan, bestMove: v.bestMove,
      bestScore: v.bestScore, depth: v.depth, kind: v.kind,
      cause: cause, lesson: lesson, reflection: v.reflection,
      due: now,  // first review is immediate (the "learn" step)
      step: -1   // -1 = not yet on the day ladder (Train slice)
    };
    // ONE card per moment: re-saving replaces the lesson/cause/verdict on
    // the existing card (back to the immediate learning step, history
    // kept) instead of minting a duplicate.
    CoachStore.listCards().then(function (cards) {
      const existing = cards.find(function (c) {
        return c.gameId === v.gameId && c.ply === v.ply;
      });
      if (existing) {
        return CoachStore.updateCard(Object.assign({}, existing, fields))
          .then(function () { return 'updated'; });
      }
      return CoachStore.addCard(Object.assign({ createdAt: now, attempts: [] }, fields))
        .then(function () { return 'saved'; });
    }).then(function (outcome) {
      if (token !== saveSeq || verdict !== v) return;
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = outcome === 'updated'
        ? 'Updated this moment’s existing card.'
        : 'Lesson card saved — spaced review (Train) lands in the next slice.';
    }).catch(function () {
      if (token !== saveSeq || verdict !== v) return;
      $('saveCard').disabled = false; // failed write: let the user retry
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = 'Could not save the card — storage unavailable.';
    });
  });

  window.CoachReflection = { CAUSE_LABELS: CAUSE_LABELS };
})();
