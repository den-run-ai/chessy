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

  // Format a contract line's eval from the PLAYER's perspective (the side to
  // move). scoreCpPlayer is already player-POV; a mate reads +M when the
  // player is the one mating, −M when it is being mated, with the move count.
  function fmtLine(line, turn) {
    if (line.mate) {
      const playerMates = line.mate.forWhite === (turn === 'w');
      const moves = Math.ceil(line.mate.inPlies / 2);
      return (playerMates ? '+M' : '−M') + ' (#' + moves + ')';
    }
    const s = line.scoreCpPlayer;
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
  }

  // Render Chessy's candidate lines (SAN · eval · short PV) and the played
  // move's standing. `turn` is the side to move at the flagged position.
  function renderLines(contract) {
    const turn = contract.turn;
    const ol = $('verifyLines');
    ol.innerHTML = '';
    contract.bestLines.forEach(function (line) {
      const li = document.createElement('li');
      const head = document.createElement('span');
      head.className = 'vl-head';
      head.textContent = line.san + '  ' + fmtLine(line, turn);
      li.appendChild(head);
      if (line.pv && line.pv.length > 1) {
        const pv = document.createElement('span');
        pv.className = 'vl-pv';
        pv.textContent = line.pv.join(' ');
        li.appendChild(pv);
      }
      ol.appendChild(li);
    });
    ol.hidden = false;

    const pl = contract.playedLine;
    const played = $('verifyPlayed');
    if (pl && pl.amongCandidates) {
      played.textContent = 'Your move is Chessy candidate #' + pl.rank +
        ' (' + fmtLine(pl, turn) + ').';
      played.hidden = false;
    } else if (pl) {
      played.textContent = 'Your move is outside Chessy’s top candidates (' +
        fmtLine(pl, turn) + ') — not necessarily an error.';
      played.hidden = false;
    } else {
      played.hidden = true;
    }

    const meta = $('verifyMeta');
    meta.textContent = 'Chessy ' + contract.engine.version + ' · depth ' + contract.depth +
      ' · ' + contract.nodes + ' nodes' +
      (contract.stability ? ' · best move ' +
        (contract.stability.bestMoveStable ? 'stable' : 'unsettled') : '') +
      ' · estimate, not authoritative analysis.';
    meta.hidden = false;
  }

  function hideLines() {
    $('verifyLines').hidden = true;
    $('verifyPlayed').hidden = true;
    $('verifyMeta').hidden = true;
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

  // Only YOUR decisions can be flagged: reflection is about the player's
  // own move, not the opponent's or the computer's. states[ply].turn is
  // the side that moved HERE; 'both' (two players at one board) means
  // every decision was made at this keyboard.
  function flaggable(r) {
    if (!r || r.ply >= r.gs.history.length) return false; // end position: nothing was played
    const pc = r.game.playerColor;
    if (pc !== 'w' && pc !== 'b') return true;
    return r.states[r.ply].turn === pc;
  }

  // Abandon the reflection completely: nothing in flight may repaint the
  // shared controls (seq bumps), the probe stops burning its budget, and
  // the form/verdict UI resets.
  function cancelReflection() {
    verifySeq++;
    saveSeq++;
    flagged = null;
    verdict = null;
    ChessyAnalysis.cancel();
    $('reflectForm').hidden = true;
    $('verifyBox').hidden = true;
  }

  // Review re-rendered: keep the flag button in step with the shown
  // position, and abandon the reflection when the user steps away —
  // including back to the game list (current() is null there).
  document.addEventListener('chessy:reviewrender', function () {
    const r = CoachReview.current();
    if (!r) { if (flagged) cancelReflection(); return; }
    $('flagMoment').disabled = !flaggable(r);
    if (flagged && !sameMoment(r)) cancelReflection();
  });

  // Leaving Review for another view abandons the reflection too — an
  // in-flight probe must not keep searching (or resurface) behind Play.
  document.addEventListener('chessy:viewchange', function () {
    if (flagged && document.body.dataset.view !== 'review') cancelReflection();
  });

  $('flagMoment').addEventListener('click', function () {
    const r = CoachReview.current();
    if (!flaggable(r)) return;
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
    hideLines();
    // A stale "saved/Updated" notice must not outlive the verdict it
    // reported: edited answers are NOT persisted until saved again.
    $('cardSaved').hidden = true;
    $('saveCard').disabled = true;
    $('reflectVerify').disabled = true; // one probe at a time

    // The played move is scored and ranked against Chessy's own candidates.
    const playedMove = { from: entry.move.from, to: entry.move.to,
      promotion: entry.move.promotion || null };
    ChessyAnalysis.analyse(fenBefore, r.states[ply].positions, { playedMove: playedMove })
      .then(function (contract) {
      if (token === verifySeq) $('reflectVerify').disabled = false;
      // null = superseded by a newer request; token/moment guards cover
      // the user having flagged elsewhere or left the game meanwhile.
      if (contract === null || token !== verifySeq || !sameMoment(CoachReview.current())) return;
      // A usable contract needs at least one legal candidate line. Anything
      // less (a wedged worker recovered to null already returned above; a
      // terminal position yields none) cannot found a lesson card — report
      // it and leave Save disabled rather than mint a card around nothing.
      if (!contract.bestLines || !contract.bestLines.length) {
        verdict = null;
        hideLines();
        $('causeLabel').hidden = true;
        $('saveCard').disabled = true;
        $('verifyResult').textContent =
          'Chessy could not analyse this position — Verify again.';
        return;
      }
      const turn = contract.turn;
      const mover = turn === 'w' ? 'White' : 'Black';
      const top = contract.bestLines[0];
      const same = contract.classification === 'same';
      renderLines(contract);
      // Chessy offers candidate LINES, never an automatic mistake verdict;
      // the player owns the cause when the played move is not the top line.
      verdict = {
        gameId: flagged.gameId, ply: ply, fenBefore: fenBefore,
        playedSan: entry.san, bestSan: top.san, bestMove: top.move,
        bestScore: top.scoreCpWhite, mate: top.mate, depth: contract.depth,
        kind: same ? 'match' : 'differ', classification: contract.classification,
        engine: contract.engine,
        lines: contract.bestLines.map(function (l) {
          return { san: l.san, uci: l.uci, scoreCpPlayer: l.scoreCpPlayer, mate: l.mate, pv: l.pv };
        }),
        playedLine: contract.playedLine,
        reflection: reflection
      };
      $('causeLabel').hidden = same;
      $('verifyResult').textContent = same
        ? 'You played ' + entry.san + ' — Chessy’s top line agrees (eval ' +
          fmtLine(top, turn) + ' for ' + mover + ').'
        : 'You played ' + entry.san + ' — Chessy preferred ' + top.san + ' (eval ' +
          fmtLine(top, turn) + ' for ' + mover +
          '). A different move is not necessarily an error — your call below.';
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
      bestScore: v.bestScore, mate: v.mate || null, depth: v.depth, kind: v.kind,
      // Provenance + the structured lines behind the verdict, so a card can
      // later be re-rendered (or re-scored) with the engine that produced it.
      classification: v.classification || null, engine: v.engine || null,
      lines: v.lines || null, playedLine: v.playedLine || null,
      cause: cause, lesson: lesson, reflection: v.reflection,
      due: now,  // first review is immediate (the "learn" step)
      step: -1   // -1 = not yet on the day ladder (Train slice)
    };
    // ONE card per moment: re-saving replaces the lesson/cause/verdict on
    // the existing card (back to the immediate learning step, history
    // kept) instead of minting a duplicate — atomically in the store, so
    // even saves racing from two tabs cannot create two cards.
    CoachStore.upsertCardByMoment(fields, { createdAt: now, attempts: [] })
      .then(function (outcome) {
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
