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
  // Later slices append to VIEWS (and add their tab + section markup).
  const VIEWS = ['play', 'review'];

  function showView(name) {
    document.body.dataset.view = name;
    for (const v of VIEWS) {
      $('view' + v[0].toUpperCase() + v.slice(1)).hidden = name !== v;
      const tab = $('tab' + v[0].toUpperCase() + v.slice(1));
      if (name === v) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (name === 'review') renderGameList();
    // Play owns the live-game banner: leaving Play during a running timed
    // game must surface the still-ticking clocks (see app.js).
    document.dispatchEvent(new CustomEvent('chessy:viewchange'));
  }

  for (const v of VIEWS) {
    $('tab' + v[0].toUpperCase() + v.slice(1))
      .addEventListener('click', function () { showView(v); });
  }

  // ---- Game list ----
  function gameLabel(g) {
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function renderGameList() {
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
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
  let review = null; // { game, gs, fens[], ply }

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
    review = { game: game, gs: gs, fens: fens, ply: 0 };
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    renderReview();
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
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  $('reviewBack').addEventListener('click', function () { renderGameList(); });
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
      if (game) {
        openReview(game);
        $('reviewBack').focus();
      } else {
        $('tabReview').focus();
      }
    }).catch(function () { $('tabReview').focus(); });
  }

  window.CoachReview = {
    showView: showView,
    openArchivedGame: openArchivedGame
  };
})();
