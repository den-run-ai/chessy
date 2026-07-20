/*
 * Chessy coach — the improvement loop from the coaching roadmap (#23):
 *
 *   archive (IndexedDB, js/store.js) → PGN import → position browser →
 *   HIDDEN self-reflection → engine verification → manual lesson card
 *   (spaced review of the cards lands in the next slice).
 *
 * Design rules carried over from the roadmap:
 * - The engine's opinion is never shown before the player has answered the
 *   reflection questions (the form gates the verify step).
 * - The player owns the diagnosis: cause and lesson text are theirs; the
 *   engine contributes only moves and scores.
 *
 * Concurrency model: one active tab (see js/store.js). The only durable
 * dedupe is the database's unique signature index — a re-shown ending of
 * the same game instance archives once because the second insert fails
 * with ConstraintError and adopts the existing record. In-page async
 * races (a scan outliving its game, a stale verification or save) are
 * handled with plain integer ownership tokens.
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
  const CAUSE_LABELS = {
    'threat-scan': 'Missed a threat',
    candidates: 'Good move not among candidates',
    evaluation: 'Judged it wrong',
    calculation: 'Line went wrong on the reply',
    efficiency: 'Right idea, too much time',
    impulse: 'Moved too fast',
    pattern: 'Good move (pattern)'
  };
  const DAY = 86400000;
  const LADDER_DAYS = [1, 3, 7, 14, 30, 90]; // fixed spaced-review ladder
  const AGAIN_DELAY = 10 * 60 * 1000;        // "Again" retries later today
  const MATE_ISH = 900000; // |score| above this reads as mate
  // Score for a position that IS checkmate: the engine scores a mate found
  // at ply p as 1000000 - p, so the delivered mate must sit at the ceiling —
  // a smaller constant makes the mating move itself look like a huge loss.
  const MATE_SCORE = 1000000;

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  const VIEWS = ['play', 'review', 'train', 'progress'];

  function showView(name) {
    document.body.dataset.view = name;
    for (const v of VIEWS) {
      $('view' + v[0].toUpperCase() + v.slice(1)).hidden = name !== v;
      const tab = $('tab' + v[0].toUpperCase() + v.slice(1));
      if (name === v) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (name === 'review') renderGameList();
    if (name === 'train') loadTrain();
    if (name === 'progress') renderProgress();
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

  // ---- Analysis (own worker; FIFO queue + watchdog, sync fallback) ----
  // The analysis engine is the playing engine (Master settings) run in its
  // OWN worker, so a live game's search is never disturbed. The worker
  // handles ONE request at a time, so every analyse() call joins a queue —
  // a reflection submitted while a game scan is mid-flight simply waits
  // its turn instead of orphaning the scan's pending reply. A watchdog
  // terminates an alive-but-silent worker and answers synchronously, then
  // the queue keeps draining — verification can never hang the flow.
  let anWorker = null, anActive = null, anId = 0;
  const anQueue = [];
  const ANALYSIS = { maxDepth: 30, timeMs: 1200, quiesce: true }; // per-moment verification
  const SCAN = { maxDepth: 30, timeMs: 300, quiesce: true };      // whole-game quick scan

  // `positions` is the game's repetition table up to this position — the
  // engine needs it to score a root move that creates a third occurrence
  // as the draw it is (otherwise the coach could recommend a "win" that
  // the opponent escapes by repetition, or miss an available draw).
  function analyse(fen, cfg, positions) {
    return new Promise(function (resolve) {
      anQueue.push({ fen: fen, cfg: cfg || ANALYSIS, positions: positions || null, resolve: resolve });
      pumpAnalysis();
    });
  }

  function ensureWorker() {
    if (anWorker || typeof Worker === 'undefined') return anWorker;
    try { anWorker = new Worker('js/ai-worker.js'); } catch (e) { return null; }
    anWorker.onmessage = function (e) {
      if (anActive && e.data.id === anActive.id) settleActive(e.data);
    };
    anWorker.onerror = function () {
      if (anWorker) { anWorker.terminate(); anWorker = null; }
      if (anActive) anActive.fallback();
    };
    return anWorker;
  }

  function settleActive(result) {
    const job = anActive;
    anActive = null;
    clearTimeout(job.watchdog);
    job.resolve(result);
    pumpAnalysis();
  }

  function pumpAnalysis() {
    if (anActive || anQueue.length === 0) return;
    const job = anQueue.shift();
    anActive = job;
    job.fallback = function () {
      if (anActive !== job) return;
      settleActive(ChessAI.think(Chess.parseFen(job.fen),
        Object.assign({}, job.cfg, { positions: job.positions || undefined })));
    };
    if (!ensureWorker()) { setTimeout(job.fallback, 0); return; }
    job.id = ++anId;
    job.watchdog = setTimeout(function () {
      if (anWorker) { anWorker.terminate(); anWorker = null; }
      job.fallback();
    }, job.cfg.timeMs + 4000);
    anWorker.postMessage({
      id: job.id, fen: job.fen, positions: job.positions || undefined,
      maxDepth: job.cfg.maxDepth, timeMs: job.cfg.timeMs, quiesce: job.cfg.quiesce
    });
  }

  function fmtScore(s) {
    if (s > MATE_ISH) return '+M';
    if (s < -MATE_ISH) return '−M';
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
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

  // ---- Review: position browser + reflection + verification ----
  const reviewBoard = makeBoard($('reviewBoard'), null);
  let review = null; // { game, gs, fens[], states[], ply, flagged, verdict }

  function openReview(game) {
    let gs;
    try { gs = Chess.replaySans(game.sans); }
    catch (e) {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'This archived game no longer replays: ' + e.message;
      return;
    }
    scanToken++; // abandon any scan still running for the previous game
    const fens = gs.history.map(function (h) { return h.fen; });
    fens.push(Chess.toFen(gs));
    // Full game states per ply (WITH repetition tables): terminal checks on
    // "the position after move k" must see draws by threefold repetition,
    // which a bare FEN cannot represent.
    let s = Chess.newGameState();
    const states = [s];
    for (const h of gs.history) {
      s = Chess.playMove(s, h.move);
      states.push(s);
    }
    review = { game: game, gs: gs, fens: fens, states: states, ply: 0, flagged: null, verdict: null };
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    renderScan(review);
    renderReview();
  }

  function renderReview() {
    const r = review;
    const state = Chess.parseFen(r.fens[r.ply]);
    const last = r.ply > 0 ? r.gs.history[r.ply - 1].move : null;
    reviewBoard.render(state, { lastMove: last });
    const side = state.turn === 'w' ? 'White' : 'Black';
    const played = r.ply < r.gs.history.length ? r.gs.history[r.ply] : null;
    // An imported game can CONTINUE past a position the engine scores as
    // over (an unclaimed threefold/fifty-move draw is automatic for
    // Chessy's rules): the engine has no move to suggest there, so a card
    // built from such a moment would be unanswerable — not flaggable.
    const engineOver = !!played && terminalScore(r.states[r.ply]) !== null;
    $('reviewStatus').textContent = 'Position ' + r.ply + '/' + r.gs.history.length +
      ' · ' + side + ' to move' + (played ? ' · played here: ' + played.san : ' · end of game') +
      (engineOver ? ' · already drawn by rule here — moment not flaggable' : '');
    $('revStart').disabled = r.ply === 0;
    $('revPrev').disabled = r.ply === 0;
    $('revNext').disabled = r.ply >= r.gs.history.length;
    $('revEnd').disabled = r.ply >= r.gs.history.length;
    $('flagMoment').disabled = !played || engineOver;
    // Stepping away from a flagged moment abandons the (unsaved) reflection.
    if (r.flagged !== r.ply) {
      r.flagged = null;
      r.verdict = null;
      $('reflectForm').hidden = true;
      $('verifyBox').hidden = true;
    }
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  // ---- Retroactive scan: analyse every decision, surface key moments ----
  // The engine picks WHICH moments matter (the roadmap's "quick scan"),
  // but stays quiet about WHY: the moment list shows the played move and
  // nothing else — cost, severity and the better move are revealed only
  // after the reflection form, so the reflect-first rule holds even for
  // scanned games. The token abandons a scan whose game was left.
  let scanToken = 0;

  // `state` must be a FULL game state (repetition table included) so that
  // draws by threefold repetition read as terminal too.
  function terminalScore(state) {
    const st = Chess.gameStatus(state);
    if (!st.over) return null;
    return st.result === '1-0' ? MATE_SCORE : st.result === '0-1' ? -MATE_SCORE : 0;
  }

  function runScan(r) {
    const token = ++scanToken;
    const n = r.gs.history.length;
    const evals = new Array(n + 1);
    const bestSans = new Array(n + 1);
    $('scanGame').disabled = true;
    $('momentList').innerHTML = '';
    $('scanStatus').hidden = false;
    let chain = Promise.resolve();
    for (let k = 0; k <= n; k++) {
      (function (k) {
        chain = chain.then(function () {
          if (token !== scanToken) return;
          $('scanStatus').textContent = 'Scanning position ' + (k + 1) + '/' + (n + 1) + '…';
          const term = terminalScore(r.states[k]);
          if (term !== null) {
            evals[k] = term;
            bestSans[k] = null;
            return;
          }
          return analyse(r.fens[k], SCAN, r.states[k].positions).then(function (res) {
            if (token !== scanToken) return;
            evals[k] = res.score;
            const st = Chess.parseFen(r.fens[k]);
            const legal = Chess.legalMoves(st);
            const bm = res.move && legal.find(function (m) {
              return m.from === res.move.from && m.to === res.move.to &&
                     (m.promotion || null) === (res.move.promotion || null);
            });
            bestSans[k] = bm ? Chess.toSan(st, bm, legal) : null;
          });
        });
      })(k);
    }
    chain.then(function () {
      if (token !== scanToken) return;
      // Coach the TRAINEE only: an opponent's blunders are not the player's
      // lesson material, and in an easy-AI game they would otherwise crowd
      // out every slot.
      const pc = r.game.playerColor || 'both';
      const moments = [];
      for (let k = 0; k < n; k++) {
        const mover = k % 2 === 0 ? 'w' : 'b'; // games replay from the standard start
        if (pc !== 'both' && mover !== pc) continue;
        // Moves played FROM an engine-terminal position (imported games
        // continuing past an unclaimed draw) are not flaggable — don't
        // surface them as moments either.
        if (terminalScore(r.states[k]) !== null) continue;
        const loss = Math.max(0, Math.round((evals[k] - evals[k + 1]) * (mover === 'w' ? 1 : -1)));
        if (loss >= 50) moments.push({ ply: k, loss: loss });
      }
      moments.sort(function (a, b) { return b.loss - a.loss; });
      const top = moments.slice(0, 2).sort(function (a, b) { return a.ply - b.ply; });
      r.game.scan = {
        at: Date.now(),
        settings: { maxDepth: SCAN.maxDepth, timeMs: SCAN.timeMs },
        playerColor: pc,
        evals: evals,
        bestSans: bestSans,
        moments: top
      };
      CoachStore.updateGame(r.game).catch(function () {
        // The scan still works this session, but it will be gone after a
        // reload — say so instead of silently presenting it as saved.
        if (token !== scanToken) return;
        $('scanStatus').textContent +=
          ' (Could not save the scan — it lasts this session only.)';
      });
      renderScan(r);
    });
  }

  function moveLabel(r, ply) {
    return (Math.floor(ply / 2) + 1) + (ply % 2 === 0 ? '. ' : '… ') + r.gs.history[ply].san;
  }

  function renderScan(r) {
    const scan = r.game.scan;
    const list = $('momentList');
    list.innerHTML = '';
    $('scanGame').disabled = false;
    $('scanGame').textContent = scan ? 'Re-scan game' : 'Scan for key moments';
    $('scanStatus').hidden = !scan;
    if (!scan) return;
    const whose = scan.playerColor === 'w' ? 'your White moves'
      : scan.playerColor === 'b' ? 'your Black moves' : 'this game';
    $('scanStatus').textContent = scan.moments.length
      ? scan.moments.length + ' key moment' + (scan.moments.length > 1 ? 's' : '') +
        ' in ' + whose + ' (Chessy estimate). Open one and reflect — details appear after you answer.'
      : 'Scanned ' + whose + ' — no significant swings found (Chessy estimate).';
    // Deliberately NO cost or severity here: revealing the magnitude before
    // the reflection would leak the engine's judgement (roadmap #23's
    // engine-hidden sequence). The moment's existence is the only hint.
    for (const m of scan.moments) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'moment-item';
      const side = m.ply % 2 === 0 ? 'White' : 'Black';
      btn.textContent = moveLabel(r, m.ply) + ' (' + side + ') — review this decision';
      btn.addEventListener('click', function () { stepReview(m.ply); });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  $('scanGame').addEventListener('click', function () {
    if (review) runScan(review);
  });

  $('flagMoment').addEventListener('click', function () {
    verifyToken++; // a new flag invalidates any in-flight verification
    saveToken++;   // and any lesson write that still owns the shared UI
    review.flagged = review.ply;
    // Fresh moment, fresh answers: reflection AND card fields reset, so a
    // stale cause/lesson from the previous moment can never carry over.
    $('reflectThreat').value = '';
    $('reflectCandidates').value = '';
    $('reflectEval').value = '';
    $('cardCause').value = '';
    $('cardLesson').value = '';
    $('reflectForm').hidden = false;
    $('reflectVerify').disabled = false; // a fresh moment can be verified
    $('verifyBox').hidden = true;
    $('cardSaved').hidden = true;
    $('reflectThreat').focus();
  });

  // Verifications are tokenized: results landing after the user has moved
  // to another moment (or another game) are discarded — a stale verdict
  // must never re-enable Save and attach the wrong position to a card.
  let verifyToken = 0;
  // Lesson writes get the same treatment: a fresh verification can enable
  // Save for verdict B while verdict A's IndexedDB request is still
  // pending; A must never repaint or re-enable B's shared controls.
  let saveToken = 0;

  $('reflectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    // Whitespace is not reflection: native `required` accepts spaces, so
    // trim first and re-run validation — a spaces-only answer is rejected
    // with the browser's own "fill in this field" prompt.
    $('reflectThreat').value = $('reflectThreat').value.trim();
    $('reflectCandidates').value = $('reflectCandidates').value.trim();
    if (!$('reflectForm').reportValidity()) return;
    const r = review;
    if (r.flagged === null) return;
    // A new verdict is taking ownership of the card controls immediately;
    // an older save must not re-enable them while these probes are running.
    saveToken++;
    const token = ++verifyToken;
    const ply = r.flagged;
    const fenBefore = r.fens[ply];
    const entry = r.gs.history[ply];
    const mover = Chess.parseFen(fenBefore).turn;
    // Snapshot the reflection NOW: these are the answers that passed the
    // reflect-first gate. The fields stay editable while the engine runs,
    // so the card must not reread the DOM at save time — a post-verdict
    // rewrite would replace the honest pre-engine reading.
    const reflection = {
      threat: $('reflectThreat').value,
      candidates: $('reflectCandidates').value,
      evaluation: $('reflectEval').value
    };
    $('verifyBox').hidden = false;
    $('verifyResult').textContent = 'Analysing…';
    $('saveCard').disabled = true;
    // In-flight guard: repeated submits would ENQUEUE duplicate probe
    // pairs — the token discards their stale results, but the FIFO worker
    // still has to burn through them, multiplying the "Analysing…" wait.
    $('reflectVerify').disabled = true;

    analyse(fenBefore, null, r.states[ply].positions).then(function (best) {
      // Already stale (the user flagged another moment or left the game)?
      // Bail BEFORE enqueueing the second probe: each probe costs up to
      // 1.2 s plus watchdog allowance on the shared FIFO, and abandoned
      // pairs would delay the verification the user is actually watching.
      if (token !== verifyToken || review !== r || r.flagged !== ply) return;
      // The played move's value = the value of the position it leads to.
      // If that position is terminal (mate, stalemate, dead, 50-move, or a
      // COMPLETED threefold — hence the full prefix state, not a bare FEN)
      // the engine has nothing to search.
      const afterFen = r.fens[ply + 1];
      const term = terminalScore(r.states[ply + 1]);
      const playedScoreP = term !== null
        ? Promise.resolve({ score: term })
        : analyse(afterFen, null, r.states[ply + 1].positions);
      return playedScoreP.then(function (after) {
        if (token !== verifyToken || review !== r || r.flagged !== ply) return; // stale
        // Resolve the engine's move object back to a SAN on this board.
        const legal = Chess.legalMoves(Chess.parseFen(fenBefore));
        const bm = best.move && legal.find(function (m) {
          return m.from === best.move.from && m.to === best.move.to &&
                 (m.promotion || null) === (best.move.promotion || null);
        });
        const bestSan = bm ? Chess.toSan(Chess.parseFen(fenBefore), bm, legal) : '?';
        const same = bm && entry.move.from === bm.from && entry.move.to === bm.to &&
          (entry.move.promotion || null) === (bm.promotion || null);
        // Playing the engine's own move costs nothing by definition — the
        // two probes can still differ (depth parity, terminal shortcuts).
        const lossCp = same ? 0 : Math.max(0,
          Math.round((best.score - after.score) * (mover === 'w' ? 1 : -1)));
        // A moment where the played move held up is a positive PATTERN, not
        // an error — it gets no cause diagnosis, just a lesson to keep.
        const kind = (same || lossCp < 50) ? 'pattern' : 'error';
        review.verdict = {
          ply: ply, fenBefore: fenBefore, playedSan: entry.san,
          bestSan: bestSan,
          bestMove: bm ? { from: bm.from, to: bm.to, promotion: bm.promotion || null } : null,
          bestScore: best.score, playedScore: after.score, lossCp: lossCp,
          kind: kind,
          depth: best.depth,
          reflection: reflection
        };
        $('causeLabel').hidden = kind === 'pattern';
        // No blunder/mistake/inaccuracy grading: the two probes are
        // TIME-bounded and can stop at different depths, so the cost is a
        // rough estimate — naming severity tiers would claim a precision
        // the numbers don't have. (kind above uses the 50 cp threshold
        // only to decide whether to ask for a cause at all.)
        $('verifyResult').textContent = (same
          ? 'You played ' + entry.san + ' — Chessy’s line agrees (eval ' +
            fmtScore(best.score) + ', depth ' + best.depth + ').'
          : 'You played ' + entry.san + ' (position eval ' + fmtScore(after.score) +
            (after.depth ? ', depth ' + after.depth : '') +
            ') — Chessy prefers ' + bestSan + ' (eval ' + fmtScore(best.score) +
            ', depth ' + best.depth + '). Cost ≈ ' + (lossCp / 100).toFixed(1) +
            ' pawns — rough: the probes may reach different depths.') +
          ' Chessy estimate, not authoritative analysis.';
        $('saveCard').disabled = false;
      });
    }).then(function () {
      // Only the request that still OWNS the token re-enables the shared
      // control: a STALE request settling while a newer one is mid-flight
      // would otherwise reopen the duplicate-submission window this guard
      // exists for. (Flagging a new moment re-enables it directly.)
      if (token === verifyToken) $('reflectVerify').disabled = false;
    });
  });

  $('saveCard').addEventListener('click', function () {
    const r = review;
    const v = r && r.verdict;
    if (!v || $('saveCard').disabled) return;
    // Validation: every card needs a one-sentence lesson; error cards also
    // need the player's cause diagnosis (pattern cards have no cause).
    const lesson = $('cardLesson').value.trim();
    const cause = v.kind === 'pattern' ? 'pattern' : $('cardCause').value;
    if (!lesson || !cause) {
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = v.kind === 'pattern'
        ? 'Write a one-sentence lesson first.'
        : 'Pick a cause and write a one-sentence lesson first.';
      return;
    }
    const token = ++saveToken;
    // Disable BEFORE the async write — a double-click (or a slow
    // IndexedDB) must not create duplicate cards for the same moment.
    $('saveCard').disabled = true;
    const now = Date.now();
    const fields = {
      gameId: r.game.id,
      ply: v.ply,
      fenBefore: v.fenBefore,
      playedSan: v.playedSan,
      bestSan: v.bestSan,
      bestMove: v.bestMove,
      bestScore: v.bestScore,
      playedScore: v.playedScore,
      lossCp: v.lossCp,
      kind: v.kind,
      cause: cause,
      lesson: lesson,
      // The snapshot taken when verification was submitted — never the
      // fields' current contents (editable since the verdict appeared).
      reflection: v.reflection,
      due: now,        // first review is immediate (the "learn" step)
      step: -1         // -1 = not yet on the day ladder
    };
    // ONE card per moment (gameId + ply): re-saving a moment REPLACES its
    // lesson, cause and verdict on the existing card (and puts it back on
    // the immediate learning step), keeping its history — it never mints a
    // duplicate the player would then be drilled on twice.
    CoachStore.listCards().then(function (cards) {
      const existing = cards.find(function (c) {
        return c.gameId === r.game.id && c.ply === v.ply;
      });
      if (existing) {
        return CoachStore.updateCard(Object.assign({}, existing, fields))
          .then(function () { return 'updated'; });
      }
      return CoachStore.addCard(Object.assign({ createdAt: now, attempts: [] }, fields))
        .then(function () { return 'saved'; });
    }).then(function (outcome) {
      if (token !== saveToken || review !== r || r.verdict !== v || r.flagged !== v.ply) return;
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = outcome === 'updated'
        ? 'Updated this moment’s existing card — it is due in Train again now.'
        : 'Lesson card saved — it is due in Train now, then on the 1/3/7/14/30/90-day ladder.';
    }).catch(function () {
      if (token !== saveToken || review !== r || r.verdict !== v || r.flagged !== v.ply) return;
      $('saveCard').disabled = false; // failed write: let the user retry
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = 'Could not save the card — storage unavailable.';
    });
  });

  // ---- Import PGN ----
  // ONE batch at a time: Import disables while a batch is writing and the
  // batch runs to completion (a paste is at most a few hundred games —
  // seconds of work), so closing the dialog mid-batch neither cancels nor
  // duplicates it; the list simply refreshes when the batch lands.
  let importBusy = false;
  // Each dialog OPEN starts a new session. A batch's completion may only
  // touch the dialog it was started from — the user can close the dialog
  // mid-batch and reopen it with a fresh paste, and the old batch landing
  // must not close (and thereby discard) that new session.
  let importSession = 0;

  function newGameChoice(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  $('importPgnBtn').addEventListener('click', function () {
    importSession++;
    $('importText').value = '';
    $('importError').textContent = importBusy
      ? 'A previous import is still finishing — Import unlocks when it lands.'
      : '';
    $('importStart').disabled = importBusy;
    $('importDialog').showModal();
  });
  $('importCancel').addEventListener('click', function () {
    $('importDialog').close();
  });

  $('importStart').addEventListener('click', function () {
    if (importBusy) return;
    importBusy = true;
    const session = importSession;
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
        // Chessy's own rules auto-draw threefold/fifty (a casual-play
        // simplification), but imported games were played under standard
        // CLAIM-based rules — a player may legally play on, resign, or
        // lose on time in a "claimable" position. Only forced outcomes
        // may override the recorded result; an auto-draw reason is kept
        // only when it agrees with what the PGN declares.
        const status = Chess.gameStatus(gs);
        const forced = status.over &&
          (status.reason === 'checkmate' || status.reason === 'stalemate' ||
           status.reason === 'insufficient material');
        const agrees = status.over && g.result === status.result;
        return CoachStore.addGame({
          source: 'import',
          tags: g.tags,
          sans: gs.history.map(function (h) { return h.san; }), // canonical SANs
          // Which side the trainee played — later slices focus feedback
          // on those moves. Applies to the whole pasted batch.
          playerColor: playerColor,
          clocks: null, // PGN %clk import is a follow-up
          result: forced ? status.result : agrees ? status.result : g.result,
          reason: (forced || agrees) ? status.reason : '',
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
      // The archive changed regardless of which dialog session survives.
      if (ok > 0) renderGameList();
      // Completion UI belongs to THIS batch's dialog session only.
      if (session !== importSession) return;
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
        return;
      }
      $('importDialog').close();
    });
  });

  $('reviewBack').addEventListener('click', function () {
    scanToken++; // abandon a running scan when leaving the game
    renderGameList();
  });
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  // ---- Train ----
  const trainBoard = makeBoard($('trainBoard'), onTrainSquare);
  let train = null; // { queue, card, state, selected, answered }

  function loadTrain() {
    return CoachStore.dueCards(Date.now()).then(function (cards) {
      train = { queue: cards, card: null, state: null, selected: null, answered: false };
      nextTrainCard();
    }).catch(function () {
      $('trainEmpty').hidden = false;
      $('trainEmpty').textContent = 'Archive unavailable in this browser.';
      $('trainCardBox').hidden = true;
    });
  }

  // A card graded "Again" comes due ten minutes later while the user may
  // still be sitting in Train — the due query only runs when the view is
  // entered, so without a timer the promised same-day retry never appears.
  // When the queue drains, name the next near-term due time and requeue
  // automatically when it arrives (only if no card is being answered).
  let trainTimer = null;

  function scheduleTrainRequeue() {
    clearTimeout(trainTimer);
    $('trainEmpty').textContent = 'No cards due. Flag moments in Review to create lesson cards.';
    CoachStore.listCards().then(function (cards) {
      const now = Date.now();
      let next = Infinity;
      let overdue = false;
      for (const c of cards) {
        if (c.due <= now) overdue = true;
        else next = Math.min(next, c.due);
      }
      // A card can come due WHILE the rest of the queue is worked (a long
      // session after an "Again"): by the time the queue drains it is
      // already overdue, so reload now instead of arming a timer for it.
      if (overdue) { loadTrain(); return; }
      if (next - now > 3600000) return; // nothing near-term (ladder rungs are days away)
      $('trainEmpty').textContent = 'No cards due right now — the next retry unlocks at ' +
        new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
      trainTimer = setTimeout(function () {
        if (document.body.dataset.view === 'train' && (!train || !train.card)) loadTrain();
      }, next - now + 250);
    }).catch(function () { /* archive unavailable — keep the default note */ });
  }

  function nextTrainCard() {
    const t = train;
    t.card = t.queue.shift() || null;
    t.selected = null;
    t.answered = false;
    $('trainCount').textContent = t.card
      ? (t.queue.length + 1) + ' due'
      : '';
    $('trainEmpty').hidden = !!t.card;
    $('trainCardBox').hidden = !t.card;
    $('trainReveal').hidden = true;
    if (!t.card) { scheduleTrainRequeue(); return; }
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
      btn.textContent = GLYPHS[color + type];
      btn.setAttribute('aria-label', 'Promote to ' + PIECE_NAMES[type]);
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
    const attemptSan = Chess.toSan(t.state, attempt);
    trainBoard.render(Chess.applyMove(t.state, attempt), { lastMove: attempt });
    $('trainReveal').hidden = false;
    // Honest wording: a single-line 300/1200 ms engine saved ONE move — a
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
    t.lastCorrect = correct;
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
    if (!t || !t.card || !t.answered) return;
    // Consume the answer BEFORE the async write: a double-click must not
    // record two attempts or climb the ladder twice for one reveal.
    t.answered = false;
    const now = Date.now();
    // Write an updated COPY: if the write fails, the on-screen card is
    // untouched and a retry cannot double-append the attempt.
    const updated = Object.assign({}, t.card, {
      attempts: (t.card.attempts || []).concat([{ at: now, grade: g, correct: !!t.lastCorrect }])
    });
    schedule(updated, g, now);
    CoachStore.updateCard(updated).then(function () {
      nextTrainCard();
    }, function () {
      // The grade was NOT saved (quota, storage failure): keep the card
      // on screen and say so — silently advancing would drop the attempt
      // and reschedule nothing.
      t.answered = true;
      $('trainOutcome').textContent =
        '⚠ Could not save that grade (storage unavailable) — try again.';
    });
  }

  $('gradeAgain').addEventListener('click', function () { grade('again'); });
  $('gradeHard').addEventListener('click', function () { grade('hard'); });
  $('gradeGood').addEventListener('click', function () { grade('good'); });

  // ---- Progress ----
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
      // `correct` records an exact match with the single saved engine move;
      // Train explicitly allows the player to self-grade a different sound
      // move, so do not mislabel this narrower signal as chess correctness.
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
      $('dataNote').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Data controls ----
  $('exportData').addEventListener('click', function () {
    CoachStore.exportAll().then(function (data) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const d = new Date();
      a.download = 'chessy-coach-' + d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      $('dataNote').textContent = 'Exported ' + data.games.length + ' games and ' + data.cards.length + ' cards.';
    }).catch(function (e) {
      $('dataNote').textContent = 'Export failed: ' + (e && e.message ? e.message : e) + '.';
    });
  });

  $('importData').addEventListener('click', function () { $('importFile').click(); });
  // ONE restore at a time: while a large backup is still appending, a
  // second selection of the same file would append everything twice.
  let restoreBusy = false;

  $('importFile').addEventListener('change', function () {
    const file = $('importFile').files[0];
    if (!file) return;
    if (restoreBusy || deleteBusy) { $('importFile').value = ''; return; }
    restoreBusy = true;
    $('importData').disabled = true;
    // Restore appends through many transactions: a Delete All clearing the
    // stores mid-restore would be silently repopulated by the remaining
    // appends — the two operations are mutually exclusive.
    $('deleteData').disabled = true;
    function settleRestore() {
      restoreBusy = false;
      $('importData').disabled = false;
      $('deleteData').disabled = false;
    }
    const reader = new FileReader();
    reader.onerror = function () {
      $('importFile').value = '';
      $('dataNote').textContent = 'Could not read the backup file.';
      settleRestore();
    };
    reader.onload = function () {
      $('importFile').value = '';
      let data = null;
      try { data = JSON.parse(reader.result); } catch (e) { /* handled below */ }
      CoachStore.importAll(data)
        .then(function (n) {
          $('dataNote').textContent = 'Imported ' + n.games + ' games and ' + n.cards + ' cards.';
          renderProgress();
        })
        .catch(function (e) {
          $('dataNote').textContent = 'Import failed: ' + (e.message || e);
        })
        .then(settleRestore);
    };
    reader.readAsText(file);
  });

  let deleteBusy = false;
  $('deleteData').addEventListener('click', function () {
    // Belt to the disabled-button suspenders: never clear while a restore
    // is still appending (its remaining writes would repopulate the
    // stores after "deleted" was reported).
    if (restoreBusy || deleteBusy) {
      $('dataNote').textContent = 'A backup restore is still running — wait for it to finish first.';
      return;
    }
    if (!window.confirm('Delete ALL archived games, lesson cards and review history?')) return;
    deleteBusy = true;
    $('deleteData').disabled = true;
    // Abandon in-flight coach work first, so a scan or verification that
    // settles after the clear cannot repaint (or re-save) deleted state.
    // (One active tab is assumed — see js/store.js.)
    scanToken++;
    verifyToken++;
    saveToken++;
    review = null;
    train = null;
    clearTimeout(trainTimer);
    CoachStore.deleteAll().then(function () {
      $('dataNote').textContent = 'All training data deleted.';
      return renderProgress();
    }, function (e) {
      $('dataNote').textContent = 'Delete failed: ' + (e && e.message ? e.message : e) +
        '. Training data was not deleted.';
    }).then(function () {
      deleteBusy = false;
      $('deleteData').disabled = false;
    });
  });

  window.Coach = {
    archiveGame: archiveGame,
    openLatestArchived: openLatestArchived,
    showView: showView
  };
})();
