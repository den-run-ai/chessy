/*
 * Chessy Review — READ-ONLY browsing of the game archive (roadmap #23):
 * Play/Review tabs, the archived-game list, and a position-by-position
 * browser on the accessible mini board. Reflection, verification and
 * lesson cards build on this in the next slice.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined' ||
      typeof ChessyMiniBoard === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  // Later slices register their own view (tab + section markup) via
  // CoachReview.registerView, so this file never grows with them.
  const VIEWS = [
    { name: 'play', onShow: null },
    { name: 'review', onShow: function () { renderGameList(); } }
  ];

  function showView(name) {
    document.body.dataset.view = name;
    for (const v of VIEWS) {
      $('view' + v.name[0].toUpperCase() + v.name.slice(1)).hidden = name !== v.name;
      const tab = $('tab' + v.name[0].toUpperCase() + v.name.slice(1));
      if (name === v.name) {
        tab.setAttribute('aria-current', 'page');
        if (v.onShow) v.onShow();
      } else {
        tab.removeAttribute('aria-current');
      }
    }
    // Play owns the live-game banner: leaving Play during a running timed
    // game must surface the still-ticking clocks (see app.js).
    document.dispatchEvent(new CustomEvent('chessy:viewchange'));
  }

  function bindTab(v) {
    $('tab' + v.name[0].toUpperCase() + v.name.slice(1))
      .addEventListener('click', function () { showView(v.name); });
  }
  VIEWS.forEach(bindTab);

  function registerView(name, onShow) {
    const v = { name: name, onShow: onShow || null };
    VIEWS.push(v);
    bindTab(v);
  }

  // ---- Game list ----
  function gameLabel(g) {
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function renderGameList() {
    review = null; // leaving a game abandons its (unsaved) reflection state
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
    // Announce the abandonment: the reflection flow cancels any in-flight
    // probe when it observes current() === null.
    document.dispatchEvent(new CustomEvent('chessy:reviewrender'));
    return CoachStore.listGames().then(function (games) {
      const list = $('gameList');
      list.innerHTML = '';
      $('reviewEmpty').hidden = games.length > 0;
      $('reviewEmpty').textContent = 'No games archived yet — finish a game in Play.';
      for (const g of games) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'game-item';
        const when = new Date(g.createdAt);
        btn.textContent = gameLabel(g) + ' · ' + g.result +
          (g.reason ? ' (' + g.reason + ')' : '') + ' · ' +
          Math.ceil(g.plies / 2) + ' moves · ' + when.toLocaleDateString();
        btn.addEventListener('click', function () { openReview(g); });
        li.appendChild(btn);
        list.appendChild(li);
      }
    }).catch(function () {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Position browser ----
  const reviewBoard = ChessyMiniBoard.make($('reviewBoard'), null);
  let review = null; // { game, gs, fens[], states[], ply }

  function openReview(game) {
    let gs;
    try { gs = Chess.replaySans(game.sans); }
    catch (e) {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'This archived game no longer replays: ' + e.message;
      return;
    }
    const fens = gs.history.map(function (h) { return h.fen; });
    fens.push(Chess.toFen(gs));
    // Full game states per ply (WITH repetition tables): engine analysis
    // of "the position before move k" needs the repetition counts a bare
    // FEN cannot carry (assets/reflection.js).
    let s = Chess.newGameState();
    const states = [s];
    for (const h of gs.history) {
      s = Chess.playMove(s, h.move);
      states.push(s);
    }
    review = { game: game, gs: gs, fens: fens, states: states, ply: 0 };
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    renderReview();
    // Opening hides the list (often holding focus on the clicked item):
    // move focus to the start of the region that replaced it — keyboard
    // and screen-reader users must never be left on a hidden element.
    $('reviewBack').focus();
  }

  function renderReview() {
    const r = review;
    const state = Chess.parseFen(r.fens[r.ply]);
    const last = r.ply > 0 ? r.gs.history[r.ply - 1].move : null;
    reviewBoard.render(state, { lastMove: last });
    const side = state.turn === 'w' ? 'White' : 'Black';
    const played = r.ply < r.gs.history.length ? r.gs.history[r.ply] : null;
    $('reviewStatus').textContent = 'Position ' + r.ply + '/' + r.gs.history.length +
      ' · ' + side + ' to move' + (played ? ' · played here: ' + played.san : ' · end of game');
    $('revStart').disabled = r.ply === 0;
    $('revPrev').disabled = r.ply === 0;
    $('revNext').disabled = r.ply >= r.gs.history.length;
    $('revEnd').disabled = r.ply >= r.gs.history.length;
    // The reflection flow (assets/reflection.js) tracks the shown position.
    document.dispatchEvent(new CustomEvent('chessy:reviewrender'));
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  // Back hides the flow (and the focused Back button itself): once the
  // list is rebuilt, move focus onto it. Only this path moves focus —
  // showView('review') from a tab click must leave focus on the tab.
  $('reviewBack').addEventListener('click', function () {
    renderGameList().then(function () {
      const firstItem = $('gameList').querySelector('button');
      (firstItem || $('tabReview')).focus();
    });
  });
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  // ---- Game-over handoff (app.js) ----
  // Opens the archived record BY ITS UUID — the same key the archive
  // writes, so there is no "latest game" bookkeeping to go stale. Focus
  // must be MOVED into the view that opens (the game-over dialog has
  // already closed): keyboard/screen-reader users would otherwise be left
  // on the stale Play board. Returns to the game list when the record is
  // missing (e.g. its archive write failed).
  function openArchivedGame(gameId) {
    showView('review');
    return CoachStore.getGame(gameId).then(function (game) {
      if (game) openReview(game); // openReview moves focus into the flow
      else $('tabReview').focus();
    }).catch(function () { $('tabReview').focus(); });
  }

  window.CoachReview = {
    showView: showView,
    registerView: registerView,
    openArchivedGame: openArchivedGame,
    // The currently open game and shown ply (null on the game list) — the
    // reflection flow reads this instead of duplicating browser state.
    current: function () { return review; }
  };
})();
