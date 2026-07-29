/*
 * Chessy Train — due lesson cards replayed on the board, on the FIXED
 * 1/3/7/14/30/90-day spaced ladder (roadmap #23). Good climbs a rung,
 * Hard repeats it, Again drops off the ladder for a ten-minute retry.
 *
 * Deliberately minimal:
 * - No background timers: the due queue is (re)built when the Train view
 *   is entered or the Refresh button is pressed — an "Again" card simply
 *   shows up on the next refresh once its ten minutes pass.
 * - Honest wording: a card stores Chessy's saved move plus (E2, #76) the
 *   versioned accepted-move evidence from its verify. An answer in that
 *   accepted set is reported as verified-equivalent. Absence from an
 *   accepted-only snapshot cannot prove rejection (a damaged backup could
 *   omit an entry), so every other move stays "differs — not judged", and
 *   Chessy offers a live engine check (cached like every analysis) rather
 *   than ever auto-declaring an unknown move wrong.
 * - The player still grades themselves: verdicts only suggest a grade.
 * - Grades are ATOMIC store-level read-modify-writes (CoachStore.gradeCard)
 *   PINNED to the presented card revision, so neither a double-fire nor a
 *   concurrent grade from another window can record two attempts or climb
 *   two rungs. Each attempt records the attempted move, verdict evidence
 *   (criterion/provider provenance, gap), the suggested and chosen grades,
 *   and the presented due/step, without disturbing legacy {at, grade,
 *   correct} consumers.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof CoachReview === 'undefined' ||
      typeof ChessyMiniBoard === 'undefined' || typeof Chess === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const CAUSE_LABELS = (window.CoachReflection && CoachReflection.CAUSE_LABELS) || {};

  const DAY = 86400000;
  const LADDER_DAYS = [1, 3, 7, 14, 30, 90]; // fixed spaced-review ladder
  const AGAIN_DELAY = 10 * 60 * 1000;        // "Again" retries later today

  // Live attempt checks share the reflection/scan deep profile so the same
  // (position, attempt) hits the same validated analysis-cache identity; the
  // fallback keeps Train usable in an intentionally partial release.
  const CHECK_PROFILE = (typeof ChessyMomentScan !== 'undefined' && ChessyMomentScan.profiles)
    ? ChessyMomentScan.profiles.deep
    : { maxDepth: 10, nodeLimit: 80000, nodeBudget: 1200000, multiPV: 3, pvLen: 6 };
  const CHECK_OWNER = 'train';
  let checkSeq = 0;
  // A result can satisfy the service's cache identity yet fail the stricter
  // equivalence contract (legal/SAN/evaluation coherence). Remember that
  // exact attempt so its retry bypasses the just-evicted bad row even if the
  // IndexedDB delete is still settling.
  let retryFresh = null;

  // Same revision token as reflection/scan, so a Train check of an unrevised
  // game reuses their cached analyses instead of recomputing.
  function gameRevOf(game) {
    if (typeof ChessyMomentScan !== 'undefined' && ChessyMomentScan.analysisRevision) {
      return ChessyMomentScan.analysisRevision(game);
    }
    const s = (game.sans || []).join(',');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function uciOf(move) {
    return Chess.sqName(move.from) + Chess.sqName(move.to) +
      (move.promotion ? move.promotion.toLowerCase() : '');
  }

  // Replay the archived game to `ply`, carrying the repetition table the
  // analysis identity folds in. null when the game no longer reaches the
  // card's position (revised source) or cannot be replayed at all.
  function replayToPly(game, ply) {
    try {
      let s = game.setupFen ? Chess.parseFen(game.setupFen) : Chess.newGameState();
      if (!s.positions) {
        s.positions = {};
        s.positions[Chess.positionKey(s)] = 1;
      }
      // A bare parsed FEN has no move history; the analysis trust boundary
      // (fullState) requires the array even when it is legitimately empty.
      if (!Array.isArray(s.history)) s.history = [];
      const sans = Array.isArray(game.sans) ? game.sans : [];
      if (!Number.isInteger(ply) || ply < 0 || ply > sans.length) return null;
      for (let i = 0; i < ply; i++) {
        const legal = Chess.legalMoves(s);
        const m = legal.find(function (x) { return Chess.toSan(s, x, legal) === sans[i]; });
        if (!m) return null;
        s = Chess.playMove(s, m);
      }
      return { state: s, fen: Chess.toFen(s) };
    } catch (e) { return null; }
  }

  const trainBoard = ChessyMiniBoard.make($('trainBoard'), onTrainSquare);
  let train = null; // { queue, card, state, selected, answered, grading, lastCorrect }

  // Async settles may land after the user left Train: repainting a hidden
  // view is harmless, but moving FOCUS into it would strand keyboard and
  // screen-reader users outside the active view.
  function inTrainView() { return document.body.dataset.view === 'train'; }

  function showSkippedCards(count) {
    const notice = $('trainSkipped');
    notice.hidden = !count;
    notice.textContent = count
      ? 'Skipped ' + count + ' malformed due card' + (count === 1 ? '.' : 's.')
      : '';
  }

  // The mini board mirrors the Play board's check semantics — a card can
  // open (or an answer land) with a king in check, and hiding that would
  // drop a crucial constraint of the exercise.
  function checkSquare(state) {
    return Chess.inCheck(state, state.turn) ? state.board.indexOf(state.turn + 'K') : -1;
  }

  function loadTrain() {
    showSkippedCards(0);
    cancelAttemptCheck();
    // Evidence fingerprints include repetition history, so validate each
    // enriched card against its archived source game before Train may consume
    // the accepted set. One games read avoids an IndexedDB transaction per
    // due card and lets each damaged row be quarantined independently.
    return Promise.all([
      CoachStore.dueCards(Date.now()),
      CoachStore.listGames()
    ]).then(function (stored) {
      const storedCards = stored[0];
      const gamesById = Object.create(null);
      stored[1].forEach(function (game) {
        if (game && typeof game.id === 'string') gamesById[game.id] = game;
      });
      // Quarantine each row independently and only in memory. filter()
      // preserves the due-time order returned by the IndexedDB index.
      const cards = [];
      let skipped = 0;
      for (const card of storedCards) {
        const error = typeof CoachStore.validateCardRecord === 'function'
          ? CoachStore.validateCardRecord(
            card, null, card && gamesById[card.gameId])
          : 'validation unavailable';
        if (error) skipped++;
        else cards.push(card);
      }
      showSkippedCards(skipped);
      train = { queue: cards, card: null, state: null, selected: null,
                answered: false, grading: false, attempt: null, check: null };
      nextTrainCard();
    }).catch(function () {
      // Clear the training state on failure: the card box is hidden below,
      // so any stale `train.card` left over would make a post-load focus
      // guard (`train && train.card`) strand focus in now-hidden content.
      train = { queue: [], card: null, state: null, selected: null,
                answered: false, grading: false, attempt: null, check: null };
      showSkippedCards(0);
      $('trainEmpty').hidden = false;
      $('trainEmpty').textContent = 'Archive unavailable in this browser.';
      // No card is available: a stale "1 due" (or larger) count left in the
      // header would contradict the hidden card box.
      $('trainCount').textContent = '';
      $('trainCardBox').hidden = true;
      // A transient failure (e.g. a briefly blocked upgrade) must leave a
      // visible retry control — not force the user to discover that
      // switching views retries the load.
      $('trainRefresh').hidden = false;
      // Move focus to Refresh — the one actionable control now — whenever
      // the failure happened while Train is active: a stale-reload hid the
      // card box holding the focused grade button, and leaving focus on
      // hidden content (or dropped to the body, browser-dependent) would
      // strand keyboard and screen-reader users.
      if (inTrainView()) $('trainRefresh').focus();
    });
  }

  function nextTrainCard() {
    const t = train;
    cancelAttemptCheck(); // a pending check may not outlive its card
    t.card = t.queue.shift() || null;
    t.selected = null;
    t.answered = false;
    t.attempt = null;
    t.check = null;
    $('trainCount').textContent = t.card ? (t.queue.length + 1) + ' due' : '';
    $('trainEmpty').hidden = !!t.card;
    $('trainRefresh').hidden = !!t.card;
    $('trainCardBox').hidden = !t.card;
    $('trainReveal').hidden = true;
    if (!t.card) {
      $('trainEmpty').textContent =
        'No cards due right now. Flag moments in Review to create lesson cards; ' +
        '"Again" cards come back after ten minutes — press Refresh to check.';
      return;
    }
    t.state = Chess.parseFen(t.card.fenBefore);
    trainBoard.render(t.state, { check: checkSquare(t.state) });
    $('trainPrompt').textContent =
      (t.state.turn === 'w' ? 'White' : 'Black') +
      ' to move — find the move Chessy saved for this moment. (You played ' +
      t.card.playedSan + ' in the game.)';
  }

  function onTrainSquare(i) {
    const t = train;
    if (!t || !t.card || t.answered) return;
    const p = t.state.board[i];
    if (t.selected === null || (p && p[0] === t.state.turn)) {
      if (p && p[0] === t.state.turn) {
        t.selected = i;
        trainBoard.render(t.state, { selected: i, check: checkSquare(t.state),
          targets: Chess.legalMovesFrom(t.state, i) });
      }
      return;
    }
    const candidates = Chess.legalMovesFrom(t.state, t.selected)
      .filter(function (m) { return m.to === i; });
    if (candidates.length === 0) {
      t.selected = null;
      trainBoard.render(t.state, { check: checkSquare(t.state) });
      return;
    }
    if (candidates[0].promotion) {
      // The player must choose the piece — auto-queening would make a card
      // whose best move underpromotes impossible to answer correctly.
      const owner = t;
      const cardId = t.card.id;
      choosePromotion(t.state.turn, function (type) {
        // The dialog choice is asynchronous: never apply it to a card that
        // is no longer the one on the board.
        if (train !== owner || !owner.card || owner.card.id !== cardId) return;
        answerTrain(candidates.find(function (m) { return m.promotion === type; }));
      });
      return;
    }
    answerTrain(candidates[0]);
  }

  // Promotion picker for training answers, sharing the Play view's dialog
  // element (each caller rebuilds the buttons, so there is no conflict).
  function choosePromotion(color, cb) {
    const dlg = $('promotionDialog');
    const box = $('promotionChoices');
    box.innerHTML = '';
    ['Q', 'R', 'B', 'N'].forEach(function (type) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn ' + (color === 'w' ? 'white' : 'black');
      btn.textContent = ChessyMiniBoard.GLYPHS[color + type];
      btn.setAttribute('aria-label', 'Promote to ' + ChessyMiniBoard.PIECE_NAMES[type]);
      btn.addEventListener('click', function () {
        dlg.close();
        cb(type);
      });
      box.appendChild(btn);
    });
    dlg.showModal();
  }

  function suggestionText(a) {
    if (!a || !a.recommendedGrade) return '';
    const label = a.recommendedGrade === 'good' ? 'Good'
      : a.recommendedGrade === 'hard' ? 'Hard' : 'Again';
    return ' Suggested grade: ' + label + ' — your call.';
  }

  function answerTrain(attempt) {
    const t = train;
    if (!t || !t.card) return;
    const best = t.card.bestMove;
    const correct = !!best && attempt.from === best.from && attempt.to === best.to &&
      (attempt.promotion || null) === (best.promotion || null);
    t.answered = true;
    t.lastCorrect = correct;
    const attemptSan = Chess.toSan(t.state, attempt);
    const attemptUci = uciOf(attempt);
    const after = Chess.applyMove(t.state, attempt);
    trainBoard.render(after, { lastMove: attempt, check: checkSquare(after) });
    $('trainReveal').hidden = false;

    // E2 (#76): judge the answer against the card's persisted equivalence
    // evidence where the evidence can speak, and stay explicitly unknown
    // where it cannot. `correct` keeps its historic exact-match meaning for
    // attempts and Progress's narrow first-try signal.
    const eq = t.card.equivalence || null;
    const a = {
      uci: attemptUci, san: attemptSan,
      verdict: null, reason: null, gapCp: null, source: null,
      criterion: null, provider: null,
      recommendedGrade: null
    };
    function attachCardProvenance() {
      a.criterion = { id: eq.criterion.id, version: eq.criterion.version };
      a.provider = { engineId: eq.provider.engineId, version: eq.provider.version,
        configHash: eq.provider.configHash };
    }
    if (correct) {
      a.recommendedGrade = 'good';
      if (eq) {
        attachCardProvenance();
        a.verdict = 'best';
        a.reason = 'saved-best';
        a.source = 'card-evidence';
        a.gapCp = eq.best.mate ? null : 0;
      }
    } else if (eq) {
      const acc = eq.accepted.find(function (x) { return x.uci === attemptUci; });
      if (acc) {
        attachCardProvenance();
        a.verdict = 'equivalent';
        a.reason = 'accepted-set';
        a.source = 'card-evidence';
        a.gapCp = (!acc.mate && !eq.best.mate &&
          Number.isFinite(acc.scoreCpPlayer) && Number.isFinite(eq.best.scoreCpPlayer))
          ? eq.best.scoreCpPlayer - acc.scoreCpPlayer : null;
        a.recommendedGrade = 'good';
      } else {
        // The persisted contract contains the accepted lines, not a complete
        // partition of accepted + rejected lines. Even with all-roots coverage,
        // absence alone cannot prove rejection after restore/damage; check the
        // attempted move live before attaching a negative verdict.
        a.verdict = 'unknown';
        a.reason = 'not-covered';
      }
    }
    t.attempt = a;

    // Honest wording tiers: exact match; verified-equivalent from saved
    // evidence; provably outside the saved accepted set; otherwise the
    // historic "differs — grade yourself" line (never declared wrong).
    let text;
    if (correct) {
      text = '✓ ' + attemptSan + ' — matches Chessy’s saved move.';
    } else if (a.verdict === 'equivalent') {
      text = '✓ ' + attemptSan + ' — not the saved move (' + t.card.bestSan +
        '), but this card’s saved evidence accepts it as equivalent' +
        (Number.isFinite(a.gapCp) && a.gapCp > 0 ? ' (about ' + a.gapCp + ' cp behind)' : '') +
        '.';
    } else {
      text = '≠ ' + attemptSan + ' differs from Chessy’s saved move ' + t.card.bestSan +
        ' (in the game you played ' + t.card.playedSan + '). Your move may still be' +
        ' sound — grade yourself honestly.';
    }
    $('trainOutcome').textContent = text + suggestionText(a);
    $('trainLesson').textContent =
      (t.card.lesson ? 'Lesson: ' + t.card.lesson + ' · ' : '') +
      'Cause: ' + (CAUSE_LABELS[t.card.cause] || t.card.cause);
    // An answer the saved evidence could not judge (no evidence at all, or
    // outside its covered set) gets the live check; judged answers do not.
    if (!correct && a.verdict !== 'equivalent' && a.verdict !== 'not-equivalent') {
      startAttemptCheck(t, attempt, attemptUci, attemptSan);
    }
  }

  // ---- Live attempt check (E2): analyse and cache an unseen attempt ------
  // The saved evidence covers the returned candidate lines (plus the played
  // move); an answer outside that set is UNKNOWN, never wrong. Where the
  // analysis transport is available, check the attempt with the shared deep
  // profile — cached like every analysis, bounded by the cache policy — and
  // report the criterion's verdict as a suggestion. Grading never waits for
  // it: the player's self-grade stays sovereign, and grading cancels a
  // pending check.
  function checkStale(t, token) {
    return train !== t || !t.card || !t.answered ||
      !t.check || t.check.token !== token;
  }

  function setCheckNote(text) {
    const el = $('trainCheck');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
  }

  function cancelAttemptCheck() {
    checkSeq++;
    if (train) train.check = null;
    setCheckNote('');
    if (typeof ChessyAnalysisService !== 'undefined') {
      try { ChessyAnalysisService.cancel(CHECK_OWNER); } catch (e) { /* inert */ }
    }
  }

  function startAttemptCheck(t, attemptMove, attemptUci, attemptSan) {
    if (typeof ChessyAnalysisService === 'undefined' ||
        typeof ChessyAnalysisCore === 'undefined' ||
        typeof ChessyEquivalence === 'undefined' ||
        typeof CoachStore.getGame !== 'function') {
      return; // no checking transport in this (partial) release — stay unknown
    }
    const card = t.card;
    const token = ++checkSeq;
    t.check = { token: token };
    setCheckNote('Checking ' + attemptSan + ' with Chessy…');
    let unsub = function () {};
    Promise.resolve(CoachStore.getGame(card.gameId)).then(function (game) {
      if (checkStale(t, token)) return;
      const replay = game ? replayToPly(game, card.ply) : null;
      if (!replay || replay.fen !== card.fenBefore) {
        // The archived source no longer reaches this exact position (revised
        // or deleted game). The exercise stays trainable; the check is
        // honestly unavailable rather than run on a reconstructed history.
        t.check = null;
        setCheckNote('Chessy can’t check this move — the source game is no longer available.');
        return;
      }
      const req = {
        gameId: card.gameId, ply: card.ply, gameRev: gameRevOf(game),
        fen: card.fenBefore, positions: replay.state.positions,
        opts: { playedMove: { from: attemptMove.from, to: attemptMove.to,
            promotion: attemptMove.promotion || null },
          maxDepth: CHECK_PROFILE.maxDepth, multiPV: CHECK_PROFILE.multiPV,
          nodeLimit: CHECK_PROFILE.nodeLimit, nodeBudget: CHECK_PROFILE.nodeBudget,
          pvLen: CHECK_PROFILE.pvLen }
      };
      const retryKey =
        [req.gameId, req.ply, req.gameRev, attemptUci].join('|');
      if (retryFresh === retryKey) {
        req.fresh = true;
        retryFresh = null;
      }
      unsub = ChessyAnalysisService.subscribe(CHECK_OWNER, function (p) {
        if (checkStale(t, token)) return;
        if (p && Number.isInteger(p.completedRoots) && Number.isInteger(p.totalRoots) &&
            p.totalRoots > 0) {
          setCheckNote('Checking ' + attemptSan + ' with Chessy… ' +
            p.completedRoots + ' of ' + p.totalRoots + ' moves checked.');
        }
      });
      let pending;
      try { pending = ChessyAnalysisService.analyse(req, CHECK_OWNER); }
      catch (e) { pending = Promise.resolve(null); }
      return Promise.resolve(pending).then(function (res) {
        unsub();
        if (checkStale(t, token)) return;
        t.check = null;
        if (!res) {
          setCheckNote('Chessy could not check this move.');
          return;
        }
        finishAttemptCheck(
          t, res, replay.state, req, attemptMove, attemptUci, attemptSan, retryKey);
      });
    }).catch(function () {
      unsub();
      if (checkStale(t, token)) return;
      t.check = null;
      setCheckNote('Chessy could not check this move.');
    });
  }

  function finishAttemptCheck(
    t, res, state, req, attemptMove, attemptUci, attemptSan, retryKey
  ) {
    let ev = null;
    try {
      const expected = {
        identity: ChessyAnalysisCore.identity(state,
          Object.assign({}, req.opts, { positions: req.positions })),
        playedMove: { from: attemptMove.from, to: attemptMove.to,
          promotion: attemptMove.promotion || null }
      };
      ev = ChessyEquivalence.grade(res, state, expected, attemptUci);
    } catch (e) { ev = null; }
    if (!ev || !ev.ok) {
      // A malformed matching-key cache row would otherwise be served forever:
      // evict it and force this exact attempt's next check past the cache while
      // the asynchronous delete settles. Analysis remains recomputable.
      try { ChessyAnalysisService.invalidate(req); } catch (e) { /* best effort */ }
      retryFresh = retryKey;
      // A partial/rejected analysis founds no verdict: "not yet covered" is
      // not "wrong", so the attempt simply stays unknown.
      setCheckNote('Chessy could not fully check this move — not judged.');
      return;
    }
    const a = t.attempt;
    a.verdict = ev.verdict;
    a.reason = ev.reason;
    a.gapCp = Number.isFinite(ev.attempt.gapCp) ? ev.attempt.gapCp : null;
    a.source = 'live-analysis';
    a.criterion = { id: ev.criterion.id, version: ev.criterion.version };
    a.provider = { engineId: ev.provider.engineId, version: ev.provider.version,
      configHash: ev.provider.configHash };
    a.recommendedGrade = ev.verdict === 'best' || ev.verdict === 'equivalent' ? 'good'
      : ev.verdict === 'not-equivalent' ? 'again' : null;
    const MATE_WHY = {
      'walks-into-mate': 'it walks into a forced mate',
      'missed-forced-mate': 'it misses a forced mate',
      'faster-mate-against': 'it speeds up the mate against you'
    };
    let text;
    if (ev.verdict === 'best') {
      text = '✓ Chessy checked ' + attemptSan + ': it ranks best in this position — at' +
        ' least as good as the saved move.';
    } else if (ev.verdict === 'equivalent') {
      text = '✓ Chessy checked ' + attemptSan + ': acceptable — within tolerance of the' +
        ' best line' + (Number.isFinite(a.gapCp) && a.gapCp > 0
          ? ' (about ' + a.gapCp + ' cp behind)' : '') + '.';
    } else if (ev.verdict === 'not-equivalent') {
      text = '✗ Chessy checked ' + attemptSan + ': ' +
        (MATE_WHY[ev.reason] || ('it falls short of ' + ev.best.san +
          (Number.isFinite(a.gapCp) ? ' by about ' + a.gapCp + ' cp' : ''))) + '.';
    } else {
      text = 'Chessy checked ' + attemptSan + ' but could not settle it — not judged.';
    }
    setCheckNote(text + suggestionText(a));
  }

  // Fixed ladder scheduling. Good climbs, Hard repeats the current rung,
  // Again drops off the ladder and retries later today.
  function schedule(card, grade, now) {
    if (grade === 'again') {
      card.step = -1;
      card.due = now + AGAIN_DELAY;
    } else if (grade === 'hard') {
      card.step = Math.max(card.step, 0);
      card.due = now + LADDER_DAYS[Math.min(card.step, LADDER_DAYS.length - 1)] * DAY;
    } else {
      card.step = Math.min(card.step + 1, LADDER_DAYS.length - 1);
      card.due = now + LADDER_DAYS[card.step] * DAY;
    }
  }

  // Visibly disable the grade buttons while a write is in flight:
  // enabled-looking controls whose clicks are silently discarded would
  // let the user believe a LATER choice was accepted when the first one
  // is what got stored.
  function setGradeControls(disabled) {
    $('gradeAgain').disabled = disabled;
    $('gradeHard').disabled = disabled;
    $('gradeGood').disabled = disabled;
  }

  function grade(g) {
    const t = train;
    if (!t || !t.card || !t.answered || t.grading) return;
    // ONE grade per reveal: `grading` blocks a second grade click while
    // the write is in flight, and `answered` stays TRUE so the board
    // cannot accept a second answer meanwhile — resetting it here would
    // re-enable both until the async write settled.
    t.grading = true;
    setGradeControls(true);
    const now = Date.now();
    const correct = !!t.lastCorrect;
    // Pin the write to the revision the player actually graded: a
    // concurrent grade of the same due card (another window) makes this
    // one resolve 'stale' instead of double-recording.
    const expect = { due: t.card.due, attempts: (t.card.attempts || []).length };
    // Snapshot the attempt verdict BEFORE cancelling: grading never waits
    // for a pending live check — whatever evidence had landed by the moment
    // of grading is what the attempt records.
    const attemptInfo = t.attempt || null;
    cancelAttemptCheck();
    CoachStore.gradeCard(t.card.id, expect, function (fresh) {
      // E2 (#76): extend — never replace — the legacy {at, grade, correct}
      // shape. priorStep/presentedDue pin the scheduling context the player
      // actually saw; verdict fields are null when no evidence spoke.
      const entry = { at: now, grade: g, correct: correct };
      if (attemptInfo) {
        entry.attemptedUci = attemptInfo.uci;
        entry.attemptedSan = attemptInfo.san;
        entry.verdict = attemptInfo.verdict;
        entry.verdictReason = attemptInfo.reason;
        entry.equivalent =
          attemptInfo.verdict === 'best' || attemptInfo.verdict === 'equivalent' ? true
            : attemptInfo.verdict === 'not-equivalent' ? false : null;
        entry.gapCp = Number.isFinite(attemptInfo.gapCp) ? attemptInfo.gapCp : null;
        entry.evidenceSource = attemptInfo.source;
        entry.criterion = attemptInfo.criterion;
        entry.provider = attemptInfo.provider;
        entry.recommendedGrade = attemptInfo.recommendedGrade;
        entry.presentedDue = expect.due;
        entry.priorStep = Number.isInteger(fresh.step) ? fresh.step : null;
      }
      fresh.attempts = (fresh.attempts || []).concat([entry]);
      schedule(fresh, g, now);
      return fresh;
    }).then(function (result) {
      t.grading = false;
      setGradeControls(false);
      if (train !== t) return;
      if (result === 'stale') {
        // The presented revision was consumed — but not necessarily by a
        // concurrent GRADE: a lesson re-save from another window also
        // revises the card and leaves it due NOW. Rebuild the queue so
        // such a card is re-presented instead of silently skipped.
        loadTrain().then(function () {
          // focusAfterAdvance handles BOTH outcomes — next card's board,
          // or the visible Refresh when the concurrent grade emptied the
          // queue — so it must run whenever Train is active, not only
          // when a card remains. (A failed reload already focused Refresh
          // in loadTrain's catch; refocusing it is a harmless no-op.)
          if (inTrainView()) focusAfterAdvance();
        });
        return;
      }
      nextTrainCard(); // Refresh may have rebuilt the queue
      // Grading hid the reveal box — and the focused grade button with
      // it. Move focus into what replaced it (next card's board, or
      // Refresh when the queue ran dry) — but only while Train is the
      // ACTIVE view: a slow write settling after the user switched away
      // must not strand focus inside the hidden view.
      if (inTrainView()) focusAfterAdvance();
    }, function () {
      // The grade was NOT saved (quota, storage failure): keep the card
      // on screen (still answered), re-enable the controls, and say so —
      // silently advancing would drop the attempt and reschedule nothing.
      t.grading = false;
      setGradeControls(false);
      if (train !== t) return;
      $('trainOutcome').textContent =
        '⚠ Could not save that grade (storage unavailable) — try again.';
    });
  }

  // Keyboard/screen-reader focus must never strand on a control the
  // transition just hid (WCAG: the grade buttons after grading, the
  // Refresh button once it finds a card).
  function focusAfterAdvance() {
    const t = train;
    if (t && t.card) {
      const sq = $('trainBoard').querySelector('[tabindex="0"]');
      if (sq) { sq.focus(); return; }
    }
    $('trainRefresh').focus(); // empty queue: Refresh is visible again
  }

  $('gradeAgain').addEventListener('click', function () { grade('again'); });
  $('gradeHard').addEventListener('click', function () { grade('hard'); });
  $('gradeGood').addEventListener('click', function () { grade('good'); });
  $('trainRefresh').addEventListener('click', function () {
    loadTrain().then(function () {
      // Finding a due card hides the (focused) Refresh button itself, so
      // focus moves to the board; an empty result keeps Refresh focused.
      // Gated on Train still being active — a slow load settling after
      // the user switched views must not pull focus into the hidden view.
      if (inTrainView()) focusAfterAdvance();
    });
  });

  // A Train-owned deep check must not keep burning its full budget or repaint
  // the hidden status line after the user moves to another view. Token
  // invalidation also makes pending source reads and late worker messages
  // stale before owner-scoped service cancellation terminates the worker.
  document.addEventListener('chessy:viewchange', function () {
    if (!inTrainView()) cancelAttemptCheck();
  });

  CoachReview.registerView('train', loadTrain);
})();
