/*
 * Chessy coach — the game archive and Review browser, the foundation of
 * the coaching roadmap (#23): finished games are archived to IndexedDB
 * (js/store.js) and can be re-opened and browsed position by position.
 * Reflection, engine verification, lesson cards and spaced review build
 * on this in follow-up slices.
 *
 * Concurrency model: one active tab (see js/store.js). The only durable
 * dedupe is the database's unique signature index — a re-shown ending of
 * the same game instance archives once because the second insert fails
 * with ConstraintError and adopts the existing record.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  const TXT = '︎';
  const GLYPHS = {
    wK: '♚' + TXT, wQ: '♛' + TXT, wR: '♜' + TXT,
    wB: '♝' + TXT, wN: '♞' + TXT, wP: '♟' + TXT,
    bK: '♚' + TXT, bQ: '♛' + TXT, bR: '♜' + TXT,
    bB: '♝' + TXT, bN: '♞' + TXT, bP: '♟' + TXT
  };
  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  // Later slices append to VIEWS (and add their tab + section markup);
  // everything below iterates the array, so they change nothing here.
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

  // ---- Mini board (Review; Train reuses it in a later slice) ----
  // The Play board's full accessibility model, not a lesser copy: an ARIA
  // grid of role=row/role=gridcell buttons with a single roving tab stop
  // and arrow-key navigation, so the board is keyboard-inspectable and
  // announces its state. Without an onClick handler the board is
  // inspection-only (clicks and Enter no-op).
  function makeBoard(el, onClick) {
    el.innerHTML = '';
    el.setAttribute('role', 'grid');
    el.classList.toggle('inspect', !onClick);
    const squares = [];
    let focusIdx = 52; // e2 — same roving-tab-stop model as the Play board
    function setFocus(i, focus) {
      squares[focusIdx].tabIndex = -1;
      focusIdx = i;
      squares[i].tabIndex = 0;
      if (focus) squares[i].focus();
    }
    for (let r = 0; r < 8; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < 8; c++) {
        const i = r * 8 + c;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.setAttribute('role', 'gridcell');
        cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        // Roving tab stop: one Tab stop for the whole board, arrows move
        // within it (Enter/Space activate the button natively).
        cell.tabIndex = i === focusIdx ? 0 : -1;
        cell.addEventListener('click', function () {
          setFocus(i, false);
          if (onClick) onClick(i);
        });
        const glyph = document.createElement('span');
        glyph.className = 'piece';
        cell.appendChild(glyph);
        row.appendChild(cell);
        squares.push(cell);
      }
      el.appendChild(row);
    }
    el.addEventListener('keydown', function (e) {
      const idx = squares.indexOf(e.target);
      if (idx < 0) return;
      let r = Math.floor(idx / 8), c = idx % 8;
      if (e.key === 'ArrowUp') r--;
      else if (e.key === 'ArrowDown') r++;
      else if (e.key === 'ArrowLeft') c--;
      else if (e.key === 'ArrowRight') c++;
      else if (e.key === 'Home') c = 0;
      else if (e.key === 'End') c = 7;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (r >= 0 && r < 8 && c >= 0 && c < 8) setFocus(r * 8 + c, true);
    });
    return {
      render: function (state, opts) {
        opts = opts || {};
        for (let i = 0; i < 64; i++) {
          const cell = squares[i], p = state.board[i];
          const isLast = !!opts.lastMove && (i === opts.lastMove.from || i === opts.lastMove.to);
          cell.querySelector('.piece').textContent = p ? GLYPHS[p] : '';
          cell.classList.toggle('white-piece', !!p && p[0] === 'w');
          cell.classList.toggle('black-piece', !!p && p[0] === 'b');
          cell.classList.toggle('selected', i === opts.selected);
          cell.classList.toggle('last-move', isLast);
          const target = opts.targets && opts.targets.find(function (m) { return m.to === i; });
          cell.classList.toggle('hint', !!target && !target.captured);
          cell.classList.toggle('hint-capture', !!target && !!target.captured);
          // Announce square, piece, and interaction state, mirroring Play.
          let label = Chess.sqName(i) +
            (p ? ', ' + (p[0] === 'w' ? 'white' : 'black') + ' ' + PIECE_NAMES[p[1]] : ', empty');
          if (i === opts.selected) label += ', selected';
          if (target) label += target.captured ? ', capture available' : ', legal move';
          if (isLast) label += ', last move';
          cell.setAttribute('aria-label', label);
          cell.setAttribute('aria-selected', i === opts.selected ? 'true' : 'false');
        }
      }
    };
  }

  // ---- Archive hook (called by app.js when a game ends) ----
  // Dedupe is keyed on the game INSTANCE (app.js's gameSeq, persisted with
  // the saved game) plus the moves and result: a re-shown ending —
  // including a reload → undo → replay of the same finish — archives once,
  // while an identical game legitimately replayed via New game/Rematch
  // archives again. The unique DB index enforces this; the second insert's
  // ConstraintError adopts the record the first one stored.
  function gameSig(sans, result, gameSeq) {
    return (gameSeq || 0) + '|' + sans.join(' ') + '|' + result;
  }

  // The CURRENT archive attempt (promise of the stored id, or null): the
  // game-over "Review game" handoff awaits it, so clicking the button
  // while the write is still in flight opens the game that just finished.
  let lastArchivePromise = null;

  function archiveGame(state, settings, status, gameSeq) {
    if (!state.history.length || !status.over) return Promise.resolve(null);
    const sans = state.history.map(function (h) { return h.san; });
    const sig = gameSig(sans, status.result, gameSeq);
    lastArchivePromise = CoachStore.addGame({
      source: 'play',
      tags: {},
      sig: sig,
      gameSeq: gameSeq || 0,
      sans: sans,
      // The side the human played — later slices focus feedback on it.
      playerColor: settings.mode === 'ai-b' ? 'w' : settings.mode === 'ai-w' ? 'b' : 'both',
      // Per-move clock evidence ({thinkMs, wMs, bMs} or null): retained so
      // efficiency/impulse diagnoses have data behind them.
      clocks: state.history.map(function (h) { return h.clock || null; }),
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: sans.length,
      createdAt: Date.now()
    }).then(function (id) {
      return id;
    }, function (err) {
      // Unique-sig violation: this exact ending is already archived (a
      // re-shown ending, or another tab got there first) — adopt its
      // record so "Review game" opens the right one.
      if (err && err.name === 'ConstraintError') {
        return CoachStore.getGameBySig(sig)
          .then(function (g) { return g ? g.id : null; })
          .catch(function () { return null; });
      }
      return null; // failed write (storage unavailable): nothing to open
    });
    return lastArchivePromise;
  }

  // Game-over "Review game" hands off here: AWAIT the current archive
  // attempt, then open that game in the coaching review. Returns false when
  // no attempt exists (the caller falls back to the on-board replay); a
  // failed write lands on the game list instead of a wrong game.
  function openLatestArchived() {
    if (!lastArchivePromise) return false;
    // The handoff is asynchronous and the game-over dialog has already
    // closed, so focus must be MOVED into the view that opens — otherwise
    // keyboard/screen-reader users are left on the stale Play board.
    lastArchivePromise.then(function (id) {
      if (id === null) { showView('review'); $('tabReview').focus(); return null; }
      return CoachStore.getGame(id).then(function (game) {
        showView('review');
        if (game) {
          openReview(game);
          $('reviewBack').focus();
        } else {
          $('tabReview').focus();
        }
      });
    }).catch(function () { showView('review'); $('tabReview').focus(); });
    return true;
  }

  // ---- Review: game list ----
  function gameLabel(g) {
    if (g.source === 'import') {
      const w = (g.tags && g.tags.White) || 'White';
      const b = (g.tags && g.tags.Black) || 'Black';
      return w + ' vs ' + b;
    }
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function renderGameList() {
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
    return CoachStore.listGames().then(function (games) {
      const list = $('gameList');
      list.innerHTML = '';
      $('reviewEmpty').hidden = games.length > 0;
      $('reviewEmpty').textContent = 'No games archived yet — finish a game in Play, or import a PGN.';
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

  // ---- Review: position browser ----
  const reviewBoard = makeBoard($('reviewBoard'), null);
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

  // ---- Import PGN ----
  // ONE batch at a time: Import disables while a batch is writing and the
  // batch runs to completion (a paste is at most a few hundred games —
  // seconds of work), so closing the dialog mid-batch neither cancels nor
  // duplicates it; the list simply refreshes when the batch lands.
  let importBusy = false;

  function newGameChoice(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  $('importPgnBtn').addEventListener('click', function () {
    $('importText').value = '';
    $('importError').textContent = '';
    $('importDialog').showModal();
  });
  $('importCancel').addEventListener('click', function () {
    $('importDialog').close();
  });

  $('importStart').addEventListener('click', function () {
    if (importBusy) return;
    importBusy = true;
    $('importStart').disabled = true;
    const playerColor = (newGameChoice('importColor') || 'both');
    const games = Chess.parsePgn($('importText').value);
    let ok = 0, failed = 0, firstError = null;
    let chain = Promise.resolve();
    for (const g of games) {
      if (g.sans.length === 0) continue;
      chain = chain.then(function () {
        if (g.unsupported) throw new Error('games from a set-up position are not supported');
        const gs = Chess.replaySans(g.sans); // throws on illegal moves
        const status = Chess.gameStatus(gs);
        return CoachStore.addGame({
          source: 'import',
          tags: g.tags,
          sans: gs.history.map(function (h) { return h.san; }), // canonical SANs
          // Which side the trainee played — later slices focus feedback
          // on those moves. Applies to the whole pasted batch.
          playerColor: playerColor,
          clocks: null, // PGN %clk import is a follow-up
          result: status.over ? status.result : g.result,
          reason: status.over ? status.reason : '',
          mode: null, difficulty: null, timeControl: (g.tags && g.tags.TimeControl) || null,
          plies: gs.history.length,
          createdAt: Date.now()
        }).then(function () { ok++; });
      }).catch(function (e) {
        failed++;
        if (!firstError) firstError = e.message || String(e);
      });
    }
    chain.then(function () {
      importBusy = false;
      $('importStart').disabled = false;
      if (ok === 0 && failed === 0) {
        $('importError').textContent = 'No games found in that text.';
        return;
      }
      if (failed > 0 && ok === 0) {
        $('importError').textContent = 'Import failed: ' + firstError;
        return;
      }
      if (failed > 0) {
        $('importError').textContent = ok + ' imported, ' + failed + ' skipped (' + firstError + ').';
        renderGameList();
        return;
      }
      $('importDialog').close();
      renderGameList();
    });
  });

  $('reviewBack').addEventListener('click', function () { renderGameList(); });
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  window.Coach = {
    archiveGame: archiveGame,
    openLatestArchived: openLatestArchived,
    showView: showView
  };
})();
