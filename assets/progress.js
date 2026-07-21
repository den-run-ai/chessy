/*
 * Chessy Progress — a READ-ONLY descriptive snapshot of the training
 * data (roadmap #23): games, cards, due cards, recent reviews, and
 * per-cause tallies. Deliberately NO headline "accuracy" number, no
 * weakness ranking, no confidence claims — the one narrow signal shown
 * ("matched Chessy's saved move on first try") is labelled as exactly
 * that, because Train explicitly allows a different sound move.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof CoachReview === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const CAUSE_LABELS = (window.CoachReflection && CoachReflection.CAUSE_LABELS) || {};
  const DAY = 86400000;

  function stat(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderProgress() {
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (r) {
      const games = r[0], cards = r[1];
      const now = Date.now();
      const dl = $('progressStats');
      dl.innerHTML = '';
      stat(dl, 'Games archived', games.length);
      stat(dl, 'Lesson cards', cards.length);
      stat(dl, 'Cards due now', cards.filter(function (c) { return c.due <= now; }).length);
      // "First try" means each card's FIRST attempt — counting every
      // attempt would report per-attempt correctness (a miss followed by
      // a correct retry is not a first-try success).
      const recent = [];
      const firstTries = [];
      for (const c of cards) {
        const attempts = c.attempts || [];
        for (const a of attempts) if (now - a.at <= 30 * DAY) recent.push(a);
        if (attempts.length && now - attempts[0].at <= 30 * DAY) firstTries.push(attempts[0]);
      }
      stat(dl, 'Reviews (30 days)', recent.length);
      stat(dl, 'Matched Chessy’s saved move on first try (30 days)',
        firstTries.length
          ? firstTries.filter(function (a) { return a.correct; }).length + '/' + firstTries.length
          : '—');
      const causes = $('causeStats');
      causes.innerHTML = '';
      const byCause = {};
      for (const c of cards) byCause[c.cause] = (byCause[c.cause] || 0) + 1;
      const keys = Object.keys(byCause);
      if (keys.length === 0) stat(causes, 'No lesson cards yet', '—');
      for (const k of keys) stat(causes, CAUSE_LABELS[k] || k, byCause[k]);
    }).catch(function () {
      const dl = $('progressStats');
      dl.innerHTML = '';
      stat(dl, 'Archive unavailable in this browser', '—');
      // Clear the cause tallies too: a prior successful snapshot left
      // beneath the failure message would present stale counts as current.
      $('causeStats').innerHTML = '';
    });
  }

  CoachReview.registerView('progress', renderProgress);
})();
