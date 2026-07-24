/*
 * Chessy reflection — the manual improvement loop from roadmap #23,
 * Historic Review v2:
 *
 *   flag ONE of your positions → answer the reflection questions →
 *   the deterministic analysis contract (a few candidate lines, not a
 *   verdict) → write the cause/lesson → one card.
 *
 * Design rules:
 * - The engine's opinion is never shown before the player has answered
 *   the reflection questions (the form gates the analysis), and the answers
 *   are SNAPSHOTTED at submit — rewriting them after seeing the lines
 *   cannot reach the card.
 * - The player owns the diagnosis: a move that differs from Chessy's top
 *   line is NEVER auto-declared an error — "My move was also sound" is a
 *   first-class cause, and every candidate line is shown (not only #1).
 * - ONE card per moment (game + ply): re-saving replaces the lesson on
 *   the existing card, never mints a duplicate to be drilled twice.
 * - Analysis runs OFF the main thread through ChessyAnalysisService: a
 *   dedicated worker, one interactive job, a validated IndexedDB cache. A
 *   partial (node-budget-capped) result is shown as visibly partial, never
 *   dressed up as a full picture.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof CoachReview === 'undefined' ||
      typeof ChessyAnalysisService === 'undefined' ||
      typeof ChessyAnalysisCore === 'undefined' ||
      typeof ChessyAnalysisResult === 'undefined' ||
      typeof Chess === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };

  const MATE_ISH = 900000; // |white-cp| above this reads as mate on a card
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

  // Interactive Review budget: deterministic (fixed nodes, no root shuffle),
  // deep enough to rank a few candidates, small enough to stay responsive. The
  // service derives its watchdog from exactly these numbers.
  const CFG = { maxDepth: 10, multiPV: 3, nodeLimit: 80000, nodeBudget: 1200000, pvLen: 6 };
  const PV_TAIL = 3; // continuation plies shown after each candidate move
  const ANALYSIS_OWNER = 'reflection';

  // The scan and manual reflection MUST share this revision token: their deep
  // profiles are identical, so accepting a suggested moment should reuse the
  // already validated result instead of recomputing it. The shared revision
  // includes SetUp/FEN as well as SANs; the fallback keeps this module usable
  // in an intentionally partial/older release.
  function gameRevOf(game) {
    if (typeof ChessyMomentScan !== 'undefined' &&
        ChessyMomentScan.analysisRevision) {
      return ChessyMomentScan.analysisRevision(game);
    }
    const s = (game.sans || []).join(',');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // Reflection ownership is an exact opened source, not merely gameId + ply.
  // A revised ending keeps the same game id, and may keep the same displayed
  // ply, while changing the decision/result underneath an in-flight Verify or
  // Save. Keep the replay inputs (plus player ownership) as an immutable local
  // snapshot so same-id replacement cannot inherit the old flow.
  function sourceSnapshotOf(game) {
    return {
      id: game.id,
      setupFen: game.setupFen || null,
      playerColor: game.playerColor || null,
      sans: Array.isArray(game.sans) ? game.sans.slice() : []
    };
  }

  function sameSource(game, source) {
    if (!game || !source || game.id !== source.id ||
        (game.setupFen || null) !== source.setupFen ||
        (game.playerColor || null) !== source.playerColor ||
        !Array.isArray(game.sans) || game.sans.length !== source.sans.length) {
      return false;
    }
    return game.sans.every(function (san, i) { return san === source.sans[i]; });
  }

  // A candidate line's eval from the moving side's POV. A mate line reads as
  // +M/−M for the player to move; a centipawn line flips White-POV to that
  // side. `turn` is the side to move at the flagged position.
  // A well-formed mate payload: a definite side and a finite, positive,
  // whole-ply distance. A truthy-but-malformed mate ({} or inPlies:NaN) is NOT
  // a mate — it must not render as "+Mundefined"/"−MNaN" or score a card.
  function validMate(m) {
    return !!m && typeof m.forWhite === 'boolean' &&
      typeof m.inPlies === 'number' && isFinite(m.inPlies) &&
      m.inPlies > 0 && Math.floor(m.inPlies) === m.inPlies;
  }

  function fmtLineEval(line, turn) {
    if (validMate(line.mate)) {
      const goodForMover = line.mate.forWhite === (turn === 'w');
      return (goodForMover ? '+M' : '−M') + line.mate.inPlies;
    }
    const cp = line.scoreCpWhite;
    if (typeof cp !== 'number' || !isFinite(cp)) return '?'; // malformed payload
    const s = turn === 'b' ? -cp : cp;
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
  }

  // The white-POV centipawn number a card stores for its best move. A mate is
  // collapsed to a sentinel beyond MATE_ISH (sign = who is mating) so the
  // card's own score formatter renders it as ±M.
  function cardScore(line) {
    // Same well-formed-mate predicate as display/validation: a malformed mate
    // object must fall back to the finite centipawn score, never persist NaN.
    if (validMate(line.mate)) return (line.mate.forWhite ? 1 : -1) * (MATE_ISH + line.mate.inPlies);
    return line.scoreCpWhite;
  }

  // The flagged moment (game id + ply) and the verdict for it. Plain integer
  // ownership tokens guard the two async steps: an analysis or card write that
  // settles after the user moved on must not repaint or re-enable the shared
  // controls.
  let flagged = null;  // { gameId, ply, gameRev, review, source }
  let verdict = null;
  let verifySeq = 0;
  let saveSeq = 0;
  // The moment ("gameId:ply") whose last analysis was rejected as unusable, so
  // the next Verify for it bypasses the (evicted) cache and re-runs the worker.
  let retryFresh = null;

  function sameMoment(r) {
    return !!r && !!flagged && r === flagged.review &&
      r.game.id === flagged.gameId && r.ply === flagged.ply &&
      gameRevOf(r.game) === flagged.gameRev &&
      sameSource(r.game, flagged.source);
  }

  // Only YOUR decisions can be flagged: reflection is about the player's own
  // move, not the opponent's or the computer's.
  function flaggable(r) {
    if (!r || r.ply >= r.gs.history.length) return false; // end position: nothing was played
    // A terminal source has no decision to revisit even if a malformed
    // imported record somehow carries a later SAN.
    try { if (Chess.gameStatus(r.states[r.ply]).over) return false; }
    catch (e) { return false; }
    const pc = r.game.playerColor;
    if (pc !== 'w' && pc !== 'b') return true;
    return r.states[r.ply].turn === pc;
  }

  // Abandon the reflection completely: nothing in flight may repaint the shared
  // controls (seq bumps), the analysis stops burning its budget, and the
  // form/verdict UI resets.
  function cancelReflection() {
    verifySeq++;
    saveSeq++;
    flagged = null;
    verdict = null;
    ChessyAnalysisService.cancel(ANALYSIS_OWNER);
    $('reflectForm').hidden = true;
    $('verifyBox').hidden = true;
    document.dispatchEvent(new CustomEvent('chessy:reflectionchange', {
      detail: { active: false }
    }));
  }

  // Review re-rendered: keep the flag button in step with the shown position,
  // and abandon the reflection when the user steps away — including back to the
  // game list (current() is null there).
  document.addEventListener('chessy:reviewrender', function () {
    const r = CoachReview.current();
    if (!r) { if (flagged) cancelReflection(); return; }
    $('flagMoment').disabled = !flaggable(r);
    if (flagged && !sameMoment(r)) cancelReflection();
  });

  // Leaving Review for another view abandons the reflection too — an in-flight
  // analysis must not keep searching (or resurface) behind Play.
  document.addEventListener('chessy:viewchange', function () {
    if (flagged && document.body.dataset.view !== 'review') cancelReflection();
  });

  function beginCurrent() {
    const r = CoachReview.current();
    if (!flaggable(r)) return false;
    // Reflection owns the foreground analysis lane. Pause the batch first;
    // owner-scoped cancellation ensures its late continuation cannot cancel a
    // reflection request that the player submits next.
    if (typeof ChessyMomentScan !== 'undefined' && ChessyMomentScan.pause) {
      ChessyMomentScan.pause();
    }
    // Re-flagging the same ply does not trigger reviewrender/cancelReflection,
    // so explicitly stop that moment's older verification worker too.
    ChessyAnalysisService.cancel(ANALYSIS_OWNER);
    verifySeq++; // an in-flight analysis for another moment is now stale
    saveSeq++;   // so is any card write still owning the shared UI
    flagged = {
      gameId: r.game.id,
      ply: r.ply,
      gameRev: gameRevOf(r.game),
      review: r,
      source: sourceSnapshotOf(r.game)
    };
    verdict = null;
    // Fresh moment, fresh answers: reflection AND card fields reset, so a stale
    // cause/lesson from the previous moment can never carry over.
    $('reflectThreat').value = '';
    $('reflectCandidates').value = '';
    $('reflectEval').value = '';
    $('cardCause').value = '';
    $('cardLesson').value = '';
    $('reflectForm').hidden = false;
    $('reflectVerify').disabled = false;
    $('verifyBox').hidden = true;
    $('cardSaved').hidden = true;
    document.dispatchEvent(new CustomEvent('chessy:reflectionchange', {
      detail: { active: true }
    }));
    $('reflectThreat').focus();
    return true;
  }

  $('flagMoment').addEventListener('click', beginCurrent);

  // One rendered candidate line: an explicit rank, SAN, the player-POV eval, a
  // short PV, and a "your move" tag when it is the move actually played. The
  // rank is shown explicitly (the list is unnumbered) so a played line appended
  // from OUTSIDE the top MultiPV reads as e.g. "#14", not the next list index.
  function addLine(ol, line, turn, rank, isPlayed, exactRank) {
    const li = document.createElement('li');
    if (isPlayed) li.className = 'played';
    // A provisional (partial-analysis) ranking shows a bullet, never a precise
    // "#n" that unsearched moves could still displace.
    const marker = exactRank ? '#' + rank + '  ' : '• ';
    li.appendChild(document.createTextNode(marker + line.san + ' '));
    const ev = document.createElement('span');
    ev.className = 'eval';
    ev.textContent = fmtLineEval(line, turn);
    li.appendChild(ev);
    // A garbled cached line may carry a missing/non-array pv: treat it as an
    // empty continuation rather than throwing while rendering.
    const pvTail = Array.isArray(line.pv) ? line.pv.slice(1, 1 + PV_TAIL).join(' ') : '';
    if (pvTail) {
      const pv = document.createElement('span');
      pv.className = 'pv';
      pv.textContent = ' · ' + pvTail;
      li.appendChild(pv);
    }
    if (isPlayed) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = ' — your move';
      li.appendChild(tag);
    }
    ol.appendChild(li);
  }

  // Render the candidate lines (best-first). When the played move ranked BELOW
  // the shown MultiPV it is appended with its true rank, so the player always
  // sees where their choice stood — without any line being called an error.
  function renderLines(res, turn, playedUci, exactRanks) {
    const ol = $('verifyLines');
    ol.textContent = '';
    let playedShown = false;
    res.bestLines.forEach(function (line, i) {
      const isPlayed = line.uci === playedUci;
      if (isPlayed) playedShown = true;
      addLine(ol, line, turn, i + 1, isPlayed, exactRanks);
    });
    const pl = res.playedLine;
    if (pl && !playedShown) addLine(ol, pl, turn, pl.rank, true, exactRanks);
  }

  // Clear any lines/provenance and show a retryable failure message: no verdict,
  // Save disabled, cause hidden. Used for a null result (no worker / wedged) and
  // for an unusable one (illegal move, no eval, garbled provenance).
  function failVerify(message) {
    verdict = null;
    $('verifyLines').textContent = '';
    $('verifyMeta').textContent = '';
    $('verifyMeta').classList.remove('partial');
    $('causeLabel').hidden = true;
    $('saveCard').disabled = true;
    $('verifyResult').textContent = message;
  }

  $('reflectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    // Whitespace is not reflection: native `required` accepts spaces, so trim
    // first and re-run validation — a spaces-only answer is rejected with the
    // browser's own "fill in this field" prompt.
    $('reflectThreat').value = $('reflectThreat').value.trim();
    $('reflectCandidates').value = $('reflectCandidates').value.trim();
    if (!$('reflectForm').reportValidity()) return;
    const r = CoachReview.current();
    if (!sameMoment(r)) return;
    // Snapshot the reflection NOW: these are the answers that passed the
    // reflect-first gate. The fields stay editable while the engine runs, so
    // the card must never reread the DOM at save time.
    const reflection = {
      threat: $('reflectThreat').value,
      candidates: $('reflectCandidates').value,
      evaluation: $('reflectEval').value
    };
    const token = ++verifySeq;
    saveSeq++; // this verdict owns the card controls now
    const ply = r.ply;
    const fenBefore = r.fens[ply];
    const sourceState = r.states[ply];
    const entry = r.gs.history[ply];
    const gameRev = flagged.gameRev;
    $('verifyBox').hidden = false;
    $('verifyResult').textContent = 'Analysing…';
    $('verifyLines').textContent = '';
    $('verifyMeta').textContent = '';
    $('verifyMeta').classList.remove('partial');
    // A stale "saved/Updated" notice must not outlive the verdict it reported:
    // edited answers are NOT persisted until saved again.
    $('cardSaved').hidden = true;
    $('saveCard').disabled = true;
    $('reflectVerify').disabled = true; // one analysis at a time

    // If the previous analysis for THIS moment was rejected as unusable, bypass
    // the cache on this run (consume the flag). `fresh` lives on the request,
    // not in opts, so it never perturbs the analysis identity / cache key.
    const momentKey = flagged.gameId + ':' + gameRev + ':' + ply;
    const wantFresh = retryFresh === momentKey;
    retryFresh = null;
    const analysisSource = flagged.source;
    const analysisReq = {
      gameId: flagged.gameId, ply: ply, gameRev: gameRev,
      fen: fenBefore, positions: sourceState.positions, fresh: wantFresh,
      opts: { playedMove: entry.move, maxDepth: CFG.maxDepth, multiPV: CFG.multiPV,
        nodeLimit: CFG.nodeLimit, nodeBudget: CFG.nodeBudget, pvLen: CFG.pvLen }
    };
    ChessyAnalysisService.analyse(analysisReq, ANALYSIS_OWNER).then(function (res) {
      // The currently rendered Review object can remain the old in-memory
      // replay while archiveGame() atomically revises that id underneath it.
      // Re-read the durable source before accepting a late result; Save has its
      // own atomic guard below for the later read/write boundary.
      if (token !== verifySeq) return { abandoned: true };
      if (!sameMoment(CoachReview.current())) {
        cancelReflection();
        return { abandoned: true };
      }
      if (!CoachStore.getGame) return { res: res, sourceCurrent: false };
      return Promise.resolve(CoachStore.getGame(analysisSource.id)).then(
        function (game) {
          return { res: res, sourceCurrent: sameSource(game, analysisSource) };
        },
        function () { return { res: res, sourceCurrent: false }; });
    }).then(function (out) {
      if (!out || out.abandoned) return;
      if (token === verifySeq) $('reflectVerify').disabled = false;
      // A newer request superseded this one, or the user left the moment: drop
      // it silently (the owning request/moment repaints the shared controls).
      if (token !== verifySeq) return;
      if (!sameMoment(CoachReview.current())) {
        cancelReflection();
        return;
      }
      // The archive was revised/deleted while the old Review object stayed
      // open. Close the stale flow before it can paint a verdict.
      if (!out.sourceCurrent) {
        cancelReflection();
        return;
      }
      const res = out.res;
      // null for the CURRENT request means no worker / a wedged-then-retried
      // worker / an unrecoverable failure — NOT a supersede (that bumps the
      // token). Replace the "Analysing…" placeholder with a retryable failure
      // rather than leaving it hung forever.
      if (res === null) {
        failVerify('Chessy could not complete the analysis — Verify again.');
        return;
      }
      // Reflection is a second trust boundary after transport. Validate against
      // the FULL replay state (history + repetition counts), the exact request
      // identity, and the move that was actually played. A partial analysis may
      // legitimately omit playedLine when its node budget ran out before that
      // move was reached; if it does include one, it must still be the played
      // move. Complete results always require it.
      let checked = { ok: false };
      try {
        const identityOpts = Object.assign({}, analysisReq.opts, {
          positions: analysisReq.positions
        });
        const expected = {
          identity: ChessyAnalysisCore.identity(sourceState, identityOpts),
          requireComplete: false,
          requirePlayed: res.complete === true,
          minDepth: 1
        };
        if (res.complete === true || res.playedLine != null) {
          expected.playedMove = entry.move;
        }
        checked = ChessyAnalysisResult.validate(res, sourceState, expected);
      } catch (e) {
        checked = { ok: false };
      }
      if (!checked.ok) {
        // This unusable result may have come from the IndexedDB cache; evict it
        // AND mark the moment so the next Verify bypasses the cache and
        // dispatches a fresh worker run instead of serving the same bad entry.
        // A valid re-run then overwrites the cache.
        ChessyAnalysisService.invalidate(analysisReq);
        retryFresh = momentKey;
        failVerify('Chessy could not analyse this position — Verify again.');
        return;
      }
      const pos = sourceState;
      const legal = Chess.legalMoves(pos);
      const top = res.bestLines[0];
      const bm = checked.topMove;
      const playedUci = Chess.sqName(entry.move.from) + Chess.sqName(entry.move.to) +
        (entry.move.promotion ? entry.move.promotion.toLowerCase() : '');
      // A partial result with no playedLine has no head-to-head standing. Even
      // if a corrupt payload claims classification:"same", it cannot be called
      // a match without a validated played move.
      const match = !!checked.playedMove && res.classification === 'same';
      const mover = pos.turn === 'w' ? 'White' : 'Black';
      const topEval = fmtLineEval(top, pos.turn);

      const partial = res.complete === false;
      renderLines(res, pos.turn, playedUci, !partial);
      // Provenance as REAL text (not CSS-generated), so assistive tech exposes
      // the partial qualification too — a budget-capped result must never read
      // as a settled, exhaustive verdict.
      $('verifyMeta').textContent = 'Chessy v' + res.engine.version + ' · depth ' +
        res.depth + ' · ' + res.nodes.toLocaleString() + ' nodes · ' + res.elapsedMs + ' ms' +
        (partial ? ' · partial — node budget reached, these lines are incomplete' : '');
      $('verifyMeta').classList.toggle('partial', partial);

      // Played-move standing, ALWAYS reporting where the move ranked (even when
      // it fell outside the shown lines) — never as an error.
      let sentence;
      if (match) {
        // For a partial scan, "top line" only means it leads the searched
        // prefix — qualify it just like the provisional ranks below.
        sentence = partial
          ? 'You played ' + entry.san + ' — it leads Chessy’s search so far (analysis' +
            ' incomplete, ' + topEval + ' for ' + mover + ').'
          : 'You played ' + entry.san + ' — it’s Chessy’s top line (' +
            topEval + ' for ' + mover + ').';
      } else if (partial && !res.playedLine) {
        // The node budget was exhausted before the played move was scored: there
        // is NO head-to-head, so don't claim Chessy "preferred" anything over it.
        sentence = 'You played ' + entry.san + ' — ' + top.san + ' leads Chessy’s search' +
          ' so far (analysis incomplete, ' + topEval + ' for ' + mover + '); your move' +
          ' was not reached. Your call below.';
      } else {
        const pl = res.playedLine;
        // Cite an EXACT rank only for a complete analysis: a partial scan ranks
        // the played move within the searched prefix, not all legal moves.
        const standing = !pl ? ''
          : partial ? ' — your move was evaluated (ranking provisional while the analysis is incomplete)'
          : pl.amongCandidates ? ' — your move is a Chessy candidate too (line ' + pl.rank + ')'
          : ' — your move ranks #' + pl.rank + ' of Chessy’s ' + legal.length + ' legal moves here';
        sentence = 'You played ' + entry.san + ' — Chessy preferred ' + top.san + ' (' +
          topEval + ' for ' + mover + ')' + standing +
          '. A different move is not necessarily an error — your call below.';
      }

      // A budget-capped verdict is NOT trustworthy enough to found a card: Train
      // would otherwise drill an incomplete-scan best move as canonical. Show
      // the partial lines, but leave Save disabled and found no card.
      if (partial) {
        verdict = null;
        $('causeLabel').hidden = true;
        $('saveCard').disabled = true;
        $('verifyResult').textContent = sentence +
          ' Chessy estimate, not authoritative analysis. This analysis was cut short at' +
          ' its node budget, so no lesson card is founded on it.';
        return;
      }
      $('verifyResult').textContent = sentence + ' Chessy estimate, not authoritative analysis.';
      $('causeLabel').hidden = match;

      verdict = {
        gameId: flagged.gameId, ply: ply, fenBefore: fenBefore,
        gameRev: gameRev, review: flagged.review, source: analysisSource,
        playedSan: entry.san, bestSan: top.san,
        bestMove: { from: bm.from, to: bm.to, promotion: bm.promotion || null },
        bestScore: cardScore(top), depth: res.depth, complete: true,
        kind: match ? 'match' : 'differ',
        reflection: reflection
      };
      $('saveCard').disabled = false;
    });
  });

  $('saveCard').addEventListener('click', function () {
    const v = verdict;
    if (!v || $('saveCard').disabled) return;
    if (!flagged || v.gameId !== flagged.gameId || v.ply !== flagged.ply ||
        v.gameRev !== flagged.gameRev || v.review !== flagged.review ||
        v.source !== flagged.source || !sameMoment(CoachReview.current())) return;
    // Every card needs a one-sentence lesson; a differing move also needs the
    // player's cause call ("my move was also sound" included).
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
    // Disable BEFORE the async write — a double-click (or a slow IndexedDB)
    // must not create duplicate cards for the same moment.
    $('saveCard').disabled = true;
    const now = Date.now();
    const fields = {
      gameId: v.gameId, ply: v.ply, fenBefore: v.fenBefore,
      playedSan: v.playedSan, bestSan: v.bestSan, bestMove: v.bestMove,
      bestScore: v.bestScore, depth: v.depth, complete: v.complete !== false, kind: v.kind,
      cause: cause, lesson: lesson, reflection: v.reflection,
      due: now,  // first review is immediate (the "learn" step)
      step: -1   // -1 = not yet on the day ladder (Train slice)
    };
    // ONE card per moment: re-saving replaces the lesson/cause/verdict on the
    // existing card (back to the immediate learning step, history kept) instead
    // of minting a duplicate — atomically in the store, so even saves racing
    // from two tabs cannot create two cards.
    CoachStore.upsertCardByMoment(fields, { createdAt: now, attempts: [] }, v.source)
      .then(function (outcome) {
      if (token !== saveSeq || verdict !== v) return;
      if (outcome === 'stale') {
        cancelReflection();
        return;
      }
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

  const reflectionApi = {
    CAUSE_LABELS: CAUSE_LABELS,
    beginCurrent: beginCurrent
  };
  // Keep the established CoachReflection name for Train/Progress, and expose
  // a Chessy-prefixed seam for the scan suggestion handoff.
  window.CoachReflection = reflectionApi;
  window.ChessyReflection = reflectionApi;
})();
