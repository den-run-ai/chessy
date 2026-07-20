/*
 * Chessy Train — due lesson cards replayed on the board, on the FIXED
 * 1/3/7/14/30/90-day spaced ladder (roadmap #23). Good climbs a rung,
 * Hard repeats it, Again drops off the ladder for a ten-minute retry.
 *
 * Deliberately minimal:
 * - No background timers: the due queue is (re)built when the Train view
 *   is entered or the Refresh button is pressed — an "Again" card simply
 *   shows up on the next refresh once its ten minutes pass.
 * - Honest wording: a card stores Chessy's ONE saved move; a different
 *   answer "differs", it is not declared wrong — the player grades
 *   themselves.
 * - Grades are ATOMIC store-level read-modify-writes (CoachStore.gradeCard),
 *   so a double-fire can never record two attempts or climb two rungs.
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

  const trainBoard = ChessyMiniBoard.make($('trainBoard'), onTrainSquare);
  let train = null; // { queue, card, state, selected, answered, grading, lastCorrect }

  function loadTrain() {
    return CoachStore.dueCards(Date.now()).then(function (cards) {
      train = { queue: cards, card: null, state: null, selected: null,
                answered: false, grading: false };
      nextTrainCard();
    }).catch(function () {
      $('trainEmpty').hidden = false;
      $('trainEmpty').textContent = 'Archive unavailable in this browser.';
      $('trainCardBox').hidden = true;
    });
  }

  function nextTrainCard() {
    const t = train;
    t.card = t.queue.shift() || null;
    t.selected = null;
    t.answered = false;
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
    trainBoard.render(t.state, {});
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
        trainBoard.render(t.state, { selected: i, targets: Chess.legalMovesFrom(t.state, i) });
      }
      return;
    }
    const candidates = Chess.legalMovesFrom(t.state, t.selected)
      .filter(function (m) { return m.to === i; });
    if (candidates.length === 0) {
      t.selected = null;
      trainBoard.render(t.state, {});
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

  function answerTrain(attempt) {
    const t = train;
    if (!t || !t.card) return;
    const best = t.card.bestMove;
    const correct = !!best && attempt.from === best.from && attempt.to === best.to &&
      (attempt.promotion || null) === (best.promotion || null);
    t.answered = true;
    t.lastCorrect = correct;
    const attemptSan = Chess.toSan(t.state, attempt);
    trainBoard.render(Chess.applyMove(t.state, attempt), { lastMove: attempt });
    $('trainReveal').hidden = false;
    // Honest wording: the card stores ONE bounded engine line — a
    // different answer may be equally sound, so it "differs", it is not
    // declared wrong. The player grades themselves accordingly.
    $('trainOutcome').textContent = correct
      ? '✓ ' + attemptSan + ' — matches Chessy’s saved move.'
      : '≠ ' + attemptSan + ' differs from Chessy’s saved move ' + t.card.bestSan +
        ' (in the game you played ' + t.card.playedSan + '). Your move may still be' +
        ' sound — grade yourself honestly.';
    $('trainLesson').textContent =
      (t.card.lesson ? 'Lesson: ' + t.card.lesson + ' · ' : '') +
      'Cause: ' + (CAUSE_LABELS[t.card.cause] || t.card.cause);
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

  function grade(g) {
    const t = train;
    if (!t || !t.card || !t.answered || t.grading) return;
    // ONE grade per reveal: `grading` blocks a second grade click while
    // the write is in flight, and `answered` stays TRUE so the board
    // cannot accept a second answer meanwhile — resetting it here would
    // re-enable both until the async write settled.
    t.grading = true;
    const now = Date.now();
    const correct = !!t.lastCorrect;
    CoachStore.gradeCard(t.card.id, function (fresh) {
      fresh.attempts = (fresh.attempts || []).concat([{ at: now, grade: g, correct: correct }]);
      schedule(fresh, g, now);
      return fresh;
    }).then(function () {
      t.grading = false;
      if (train === t) nextTrainCard(); // Refresh may have rebuilt the queue
    }, function () {
      // The grade was NOT saved (quota, storage failure): keep the card
      // on screen (still answered) and say so — silently advancing would
      // drop the attempt and reschedule nothing.
      t.grading = false;
      if (train !== t) return;
      $('trainOutcome').textContent =
        '⚠ Could not save that grade (storage unavailable) — try again.';
    });
  }

  $('gradeAgain').addEventListener('click', function () { grade('again'); });
  $('gradeHard').addEventListener('click', function () { grade('hard'); });
  $('gradeGood').addEventListener('click', function () { grade('good'); });
  $('trainRefresh').addEventListener('click', function () { loadTrain(); });

  CoachReview.registerView('train', loadTrain);
})();
