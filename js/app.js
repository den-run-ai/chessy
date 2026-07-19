/*
 * Chessy UI — board rendering, interaction, game flow, persistence.
 */
(function () {
  'use strict';

  // Filled glyph set for both colors (colored via CSS) — the outline set
  // renders inconsistently across platforms and is hard to read when small.
  // U+FE0E forces text presentation: iOS otherwise renders the pawn (which,
  // unlike the other pieces, has an emoji form) as a full-color emoji that
  // ignores CSS color, so White's pawns show up black.
  const TXT = '︎';
  const GLYPHS = {
    wK: '♚' + TXT, wQ: '♛' + TXT, wR: '♜' + TXT, wB: '♝' + TXT, wN: '♞' + TXT, wP: '♟' + TXT,
    bK: '♚' + TXT, bQ: '♛' + TXT, bR: '♜' + TXT, bB: '♝' + TXT, bN: '♞' + TXT, bP: '♟' + TXT
  };
  const STORAGE_KEY = 'chessy-game-v1';
  const AI_DELAY_MS = 250;
  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

  const DIFF_LABELS = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 5: 'Expert', master: 'Master' };
  const MODE_LABELS = {
    pvp: 'Two players', 'ai-b': 'White vs computer', 'ai-w': 'Black vs computer'
  };
  const TC_LABELS = { '300+3': '5+3', '900+10': '15+10', '1800+20': '30+20' };

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const moveListEl = document.getElementById('moveList');
  const setupSummaryEl = document.getElementById('setupSummary');
  const newGameDialog = document.getElementById('newGameDialog');
  const clocksEl = document.getElementById('clocks');
  const clockWhiteEl = document.getElementById('clockWhite');
  const clockBlackEl = document.getElementById('clockBlack');
  const capturedByWhiteEl = document.getElementById('capturedByWhite');
  const capturedByBlackEl = document.getElementById('capturedByBlack');
  const promotionDialog = document.getElementById('promotionDialog');
  const promotionChoices = document.getElementById('promotionChoices');
  const gameOverDialog = document.getElementById('gameOverDialog');
  const replayStartEl = document.getElementById('replayStart');
  const replayBackEl = document.getElementById('replayBack');
  const replayFwdEl = document.getElementById('replayFwd');
  const replayLiveEl = document.getElementById('replayLive');

  let state = Chess.newGameState();
  let selected = null;        // selected square index
  let flipped = false;
  let aiThinking = false;
  let squares = [];           // 64 DOM cells, index = board index

  // Game settings are chosen in the New Game dialog and fixed for the game's
  // lifetime — the dialog's radio groups are just an edit buffer, so opening
  // and cancelling it never affects the running game.
  const settings = { mode: 'ai-b', difficulty: '2', timeControl: 'none' };

  function getChoice(name) {
    const el = newGameDialog.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function setChoice(name, value) {
    const el = newGameDialog.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }
  const TIME_CONTROLS = { none: true, '300+3': true, '900+10': true, '1800+20': true };

  // ---- Chess clocks (Fischer increment) ----
  // clocks.wMs/bMs hold the remaining time as of the LAST completed move;
  // the running side's display subtracts the time since turnStartedAt. Each
  // move records {thinkMs, wMs, bMs} on its history entry, so think times
  // survive undo/restore and feed the PGN %clk log.
  const clocks = { wMs: null, bMs: null };   // null = untimed game
  let turnStartedAt = null;
  let timeForfeit = null;                    // color that overstepped, or null
  let clockTicker = null;

  function tcParts() {
    if (settings.timeControl === 'none') return null;
    const p = settings.timeControl.split('+');
    return { baseMs: Number(p[0]) * 1000, incMs: Number(p[1]) * 1000 };
  }

  function resetClocks() {
    const tc = tcParts();
    clocks.wMs = tc ? tc.baseMs : null;
    clocks.bMs = tc ? tc.baseMs : null;
    timeForfeit = null;
    turnStartedAt = Date.now();
    if (clockTicker) { clearInterval(clockTicker); clockTicker = null; }
    if (tc) clockTicker = setInterval(tickClock, 200);
  }

  // Record think time and remaining clocks on the entry for the move that
  // was just played (state has already advanced, so the mover is the side
  // NOT to move now). If the flag had already fallen during the think —
  // a suspended tab or the tick gap can delay detection — the move stands
  // on the board but the game ends on time: no increment is awarded.
  function punchClock() {
    if (clocks.wMs === null) return;
    const now = Date.now();
    const mover = state.turn === 'w' ? 'b' : 'w';
    const key = mover + 'Ms';
    const elapsed = Math.max(0, now - turnStartedAt);
    turnStartedAt = now;
    if (elapsed >= clocks[key]) {
      forfeit(mover); // zeroes the clock; caller's render/status flow shows it
    } else {
      clocks[key] = clocks[key] - elapsed + tcParts().incMs;
    }
    state.history[state.history.length - 1].clock =
      { thinkMs: elapsed, wMs: clocks.wMs, bMs: clocks.bMs };
  }

  // A flag falls: the opponent wins if any legal sequence from the FULL
  // current position could let them checkmate (a helpmate suffices — the
  // flagger's own pieces may block escape squares, so they must NOT be
  // removed before testing); otherwise the game is drawn (FIDE 6.9).
  // forfeit() only sets the state; flag() also presents the game end.
  function forfeit(color) {
    const winner = color === 'w' ? 'b' : 'w';
    timeForfeit = { color: color, draw: !Chess.canMate(state.board, winner) };
    clocks[color === 'w' ? 'wMs' : 'bMs'] = 0;
    if (aiThinking) cancelAi();
  }

  function flag(color) {
    forfeit(color);
    selected = null;
    render();
    showGameOver(fullStatus());
  }

  function tickClock() {
    if (clocks.wMs === null || timeForfeit || Chess.gameStatus(state).over) return;
    const remaining = liveRemaining(state.turn);
    if (remaining <= 0) flag(state.turn);
    else renderClocks();
  }

  function liveRemaining(color) {
    const stored = color === 'w' ? clocks.wMs : clocks.bMs;
    if (stored === null) return null;
    if (timeForfeit || Chess.gameStatus(state).over || color !== state.turn) return stored;
    return stored - Math.max(0, Date.now() - turnStartedAt);
  }

  // Game status including app-level time forfeit (the rules engine itself
  // knows nothing about clocks).
  function fullStatus() {
    if (timeForfeit) {
      return {
        over: true,
        result: timeForfeit.draw ? '1/2-1/2' : (timeForfeit.color === 'w' ? '0-1' : '1-0'),
        reason: timeForfeit.draw ? 'time forfeit (no mating material)' : 'time forfeit'
      };
    }
    return Chess.gameStatus(state);
  }

  // Replay: number of plies currently shown (0 = start position), or null
  // for the live game. Purely a view — the live game state is untouched, so
  // browsing is always safe, even while the AI is thinking.
  let viewPly = null;

  function isViewing() { return viewPly !== null && viewPly < state.history.length; }

  function setViewPly(k) {
    viewPly = (k === null || k >= state.history.length) ? null : Math.max(0, k);
    selected = null;
    render();
  }

  // AI runs in a Web Worker so deep searches never freeze the board;
  // falls back to a synchronous call where workers are unavailable.
  let aiRequestId = 0;        // stale replies (after new game/undo/mode change) are dropped
  let aiPending = null;       // {depth, quiesce, started} for the in-flight search (PGN log)
  let aiWatchdog = null;      // guards against an alive-but-SILENT worker (see maybeAiMove)

  function createAiWorker() {
    if (typeof Worker === 'undefined') return null;
    try {
      const w = new Worker('js/ai-worker.js');
      w.onmessage = function (e) {
        if (e.data.id !== aiRequestId || !aiThinking) return;
        applyAiMove(e.data.move, e.data.depth);
      };
      w.onerror = function () {
        // Broken worker: fall back to the synchronous path so the app is
        // never stuck on "thinking".
        aiWorker = null;
        if (aiThinking) { aiThinking = false; maybeAiMove(); }
      };
      return w;
    } catch (e) { return null; }
  }
  let aiWorker = createAiWorker();

  function cancelAi() {
    // Actually stop an abandoned search — a terminated slow search would
    // otherwise keep burning CPU and delay the next request.
    if (aiThinking && aiWorker) {
      aiWorker.terminate();
      aiWorker = createAiWorker();
    }
    clearTimeout(aiWatchdog);
    aiRequestId++;
    aiThinking = false;
    aiPending = null;
  }

  // ---- Setup board DOM (8 rows × 8 cells, order = board index a8..h1) ----
  // ARIA grid pattern: the board is a role=grid of role=row/role=gridcell
  // with a single roving tab stop — Tab enters the board once, arrow keys
  // move within it (see the board keydown handler). Row wrappers use
  // display:contents so the squares stay direct CSS-grid items.
  let focusSquare = 52; // e2 — a natural first piece for White

  function buildBoard() {
    boardEl.innerHTML = '';
    squares = [];
    for (let r = 0; r < 8; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < 8; c++) {
        const i = r * 8 + c;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.index = i;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', Chess.sqName(i));
        cell.tabIndex = i === focusSquare ? 0 : -1;
        cell.addEventListener('click', function () { onSquareClick(i); });
        // Coordinate labels on the edge squares.
        if (c === 0) {
          const rank = document.createElement('span');
          rank.className = 'coord rank';
          rank.textContent = 8 - r;
          cell.appendChild(rank);
        }
        if (r === 7) {
          const file = document.createElement('span');
          file.className = 'coord file';
          file.textContent = 'abcdefgh'[c];
          cell.appendChild(file);
        }
        const glyph = document.createElement('span');
        glyph.className = 'piece';
        cell.appendChild(glyph);
        row.appendChild(cell);
        squares.push(cell);
      }
      boardEl.appendChild(row);
    }
  }

  function setFocusSquare(i, focus) {
    squares[focusSquare].tabIndex = -1;
    focusSquare = i;
    squares[i].tabIndex = 0;
    if (focus) squares[i].focus();
  }

  function humanColors() {
    switch (settings.mode) {
      case 'ai-b': return ['w'];       // human plays White, AI plays Black
      case 'ai-w': return ['b'];
      default: return ['w', 'b'];
    }
  }

  function aiColor() {
    if (settings.mode === 'ai-b') return 'b';
    if (settings.mode === 'ai-w') return 'w';
    return null;
  }

  function render() {
    const status = fullStatus();
    const viewing = isViewing();
    // The displayed position: a historical one while browsing, else live
    // (history[k].fen is the position BEFORE move k = after k plies).
    const vs = viewing ? Chess.parseFen(state.history[viewPly].fen) : state;
    const shown = viewing ? viewPly : state.history.length;
    const lastMove = shown > 0 ? state.history[shown - 1].move : null;
    const legal = !viewing && selected !== null ? Chess.legalMovesFrom(state, selected) : [];
    const inChk = viewing ? Chess.inCheck(vs, vs.turn)
                          : (status.check || status.reason === 'checkmate');
    const kingInCheck = inChk ? vs.board.indexOf(vs.turn + 'K') : -1;

    for (let i = 0; i < 64; i++) {
      const cell = squares[i];
      const p = vs.board[i];
      cell.querySelector('.piece').textContent = p ? GLYPHS[p] : '';
      cell.classList.toggle('white-piece', !!p && p[0] === 'w');
      cell.classList.toggle('black-piece', !!p && p[0] === 'b');
      cell.classList.toggle('selected', !viewing && i === selected);
      cell.classList.toggle('last-move',
        !!lastMove && (i === lastMove.from || i === lastMove.to));
      cell.classList.toggle('check', i === kingInCheck);
      // A capture is a property of the MOVE, not of the destination square:
      // en-passant captures land on an empty square and used to be shown
      // (and announced) as quiet moves.
      const target = legal.find(function (m) { return m.to === i; });
      cell.classList.toggle('hint', !!target && !target.captured);
      cell.classList.toggle('hint-capture', !!target && !!target.captured);

      // Announce square, piece, and interaction state to assistive tech.
      let label = Chess.sqName(i);
      label += p ? ', ' + (p[0] === 'w' ? 'white' : 'black') + ' ' + PIECE_NAMES[p[1]] : ', empty';
      if (!viewing && i === selected) label += ', selected';
      if (target) label += target.captured ? ', capture available' : ', legal move';
      if (i === kingInCheck) label += ', in check';
      if (lastMove && (i === lastMove.from || i === lastMove.to)) label += ', last move';
      cell.setAttribute('aria-label', label);
      cell.setAttribute('aria-selected', (!viewing && i === selected) ? 'true' : 'false');
    }
    boardEl.classList.toggle('flipped', flipped);

    const n = state.history.length;
    replayStartEl.disabled = shown === 0;
    replayBackEl.disabled = shown === 0;
    replayFwdEl.disabled = shown >= n;
    replayLiveEl.disabled = !viewing;

    setupSummaryEl.textContent = MODE_LABELS[settings.mode] +
      (aiColor() ? ' · ' + DIFF_LABELS[settings.difficulty] : '') +
      (TC_LABELS[settings.timeControl] ? ' · ' + TC_LABELS[settings.timeControl] : '');

    renderStatus(status);
    renderClocks();
    renderMoves();
    renderCaptured();
    save();
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // While the user is in a coach view (Review/Train/Progress), a running
  // timed game's clocks keep ticking invisibly and can flag — surface them
  // as a persistent banner that returns to Play. Untimed games need no
  // banner: nothing in Play can end without the player acting there.
  const liveNoteEl = document.getElementById('liveGameNote');

  function updateLiveNote() {
    const inPlay = !document.body.dataset.view || document.body.dataset.view === 'play';
    const running = clocks.wMs !== null && !timeForfeit && !Chess.gameStatus(state).over;
    if (inPlay || !running) { liveNoteEl.hidden = true; return; }
    liveNoteEl.hidden = false;
    liveNoteEl.textContent = '⏱ Timed game running — White ' + fmtClock(liveRemaining('w')) +
      ' · Black ' + fmtClock(liveRemaining('b')) + ' — return to Play';
  }

  liveNoteEl.addEventListener('click', function () {
    if (window.Coach) Coach.showView('play');
  });
  document.addEventListener('chessy:viewchange', updateLiveNote);

  // The ticker calls this alone (not render()) so the 5 Hz tick never
  // rebuilds the move list or rewrites localStorage.
  function renderClocks() {
    updateLiveNote();
    const timed = clocks.wMs !== null;
    clocksEl.hidden = !timed;
    if (!timed) return;
    let w, b;
    if (isViewing()) {
      // Replay shows the clocks as they stood after the viewed move.
      const snap = viewPly > 0 ? state.history[viewPly - 1].clock : null;
      const base = tcParts().baseMs;
      w = snap ? snap.wMs : base;
      b = snap ? snap.bMs : base;
    } else {
      w = liveRemaining('w');
      b = liveRemaining('b');
    }
    const running = !isViewing() && !timeForfeit && !Chess.gameStatus(state).over;
    clockWhiteEl.querySelector('b').textContent = fmtClock(w);
    clockBlackEl.querySelector('b').textContent = fmtClock(b);
    clockWhiteEl.classList.toggle('active', running && state.turn === 'w');
    clockBlackEl.classList.toggle('active', running && state.turn === 'b');
    clockWhiteEl.classList.toggle('low', w < 20000);
    clockBlackEl.classList.toggle('low', b < 20000);
  }

  function renderStatus(status) {
    if (isViewing()) {
      const label = viewPly === 0 ? 'start position'
        : (Math.floor((viewPly - 1) / 2) + 1) + ((viewPly - 1) % 2 === 0 ? '. ' : '… ') +
          state.history[viewPly - 1].san;
      statusEl.textContent = 'Reviewing ' + label + ' (' + viewPly + '/' + state.history.length + ')';
      return;
    }
    if (status.over) {
      const winner = status.result === '1-0' ? 'White wins' :
                     status.result === '0-1' ? 'Black wins' : 'Draw';
      statusEl.textContent = winner + ' — ' + status.reason + ' (' + status.result + ')';
    } else {
      const side = state.turn === 'w' ? 'White' : 'Black';
      let text = side + ' to move';
      if (aiThinking) text = 'Computer is thinking…';
      else if (status.check) text = side + ' is in check!';
      statusEl.textContent = text;
    }
  }

  function renderMoves() {
    // textContent only — history is restored from origin-shared localStorage,
    // so it must never be interpreted as HTML.
    moveListEl.innerHTML = '';
    const shown = isViewing() ? viewPly : state.history.length;
    for (let i = 0; i < state.history.length; i += 2) {
      const li = document.createElement('li');
      for (const j of [i, i + 1]) {
        const entry = state.history[j];
        if (!entry) { li.appendChild(document.createElement('span')); continue; }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ply' + (j === shown - 1 ? ' current' : '');
        btn.textContent = entry.san;
        btn.addEventListener('click', function () { setViewPly(j + 1); });
        li.appendChild(btn);
      }
      moveListEl.appendChild(li);
    }
    // Scroll only WITHIN the move list — scrollIntoView would also scroll
    // every ancestor including the page, yanking the board off-screen on
    // phones after every move.
    const current = moveListEl.querySelector('.current');
    if (current) {
      const top = current.offsetTop, bottom = top + current.offsetHeight;
      if (top < moveListEl.scrollTop) moveListEl.scrollTop = top;
      else if (bottom > moveListEl.scrollTop + moveListEl.clientHeight) {
        moveListEl.scrollTop = bottom - moveListEl.clientHeight;
      }
    } else {
      moveListEl.scrollTop = moveListEl.scrollHeight;
    }
  }

  function renderCaptured() {
    const byWhite = [], byBlack = [];
    const upto = isViewing() ? viewPly : state.history.length;
    for (let i = 0; i < upto; i++) {
      const cap = state.history[i].move.captured;
      if (!cap) continue;
      (cap[0] === 'b' ? byWhite : byBlack).push(GLYPHS[cap]);
    }
    capturedByWhiteEl.textContent = byWhite.join(' ');
    capturedByBlackEl.textContent = byBlack.join(' ');
  }

  // ---- Interaction ----
  // Arrow-key navigation within the board (WAI grid pattern): the roving tab
  // stop follows the focused square, directions match the VISUAL board (so
  // they invert when flipped), Home/End jump to the row edges. Handled keys
  // stop propagating so the document-level replay bindings don't also fire.
  boardEl.addEventListener('keydown', function (e) {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.index === undefined) return;
    const i = Number(t.dataset.index);
    let r = Math.floor(i / 8), c = i % 8;
    const dir = flipped ? -1 : 1;
    if (e.key === 'ArrowUp') r -= dir;
    else if (e.key === 'ArrowDown') r += dir;
    else if (e.key === 'ArrowLeft') c -= dir;
    else if (e.key === 'ArrowRight') c += dir;
    else if (e.key === 'Home') c = flipped ? 7 : 0;
    else if (e.key === 'End') c = flipped ? 0 : 7;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (r >= 0 && r < 8 && c >= 0 && c < 8) setFocusSquare(r * 8 + c, true);
  });

  function onSquareClick(i) {
    setFocusSquare(i); // keep the roving tab stop on the last-touched square
    // While reviewing, a board tap returns to the live position.
    if (isViewing()) { setViewPly(null); return; }
    if (aiThinking || fullStatus().over) return;
    if (!humanColors().includes(state.turn)) return;

    const p = state.board[i];
    if (selected === null) {
      if (p && p[0] === state.turn) { selected = i; render(); }
      return;
    }
    if (i === selected) { selected = null; render(); return; }
    if (p && p[0] === state.turn) { selected = i; render(); return; }

    const candidates = Chess.legalMovesFrom(state, selected).filter(function (m) { return m.to === i; });
    if (candidates.length === 0) { selected = null; render(); return; }

    if (candidates[0].promotion) {
      choosePromotion(state.turn, function (type) {
        const move = candidates.find(function (m) { return m.promotion === type; });
        commitMove(move);
      });
    } else {
      commitMove(candidates[0]);
    }
  }

  function choosePromotion(color, cb) {
    promotionChoices.innerHTML = '';
    ['Q', 'R', 'B', 'N'].forEach(function (type) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn ' + (color === 'w' ? 'white' : 'black');
      btn.textContent = GLYPHS[color + type];
      // The glyph is the filled (visually "black") codepoint for both colors
      // and colored via CSS, so a screen reader would announce the wrong
      // piece color — name the action explicitly instead.
      btn.setAttribute('aria-label', 'Promote to ' + PIECE_NAMES[type]);
      btn.addEventListener('click', function () {
        promotionDialog.close();
        cb(type);
      });
      promotionChoices.appendChild(btn);
    });
    promotionDialog.showModal();
  }

  function commitMove(move) {
    state = Chess.playMove(state, move);
    punchClock();
    selected = null;
    viewPly = null;
    render();
    const status = fullStatus();
    if (status.over) { showGameOver(status); return; }
    maybeAiMove();
  }

  // Difficulty select values are search depths, except the named top level:
  // Master searches with quiescence (captures are resolved past the horizon,
  // eliminating exchange blunders) under a per-move time budget, iteratively
  // deepening as far as the clock allows. The fixed-depth levels carry a
  // generous budget purely as a safety net for pathological positions.
  function aiConfig() {
    if (settings.difficulty === 'master') return { maxDepth: 30, timeMs: 2000, quiesce: true };
    return { maxDepth: Number(settings.difficulty), timeMs: 10000, quiesce: false };
  }

  function maybeAiMove() {
    if (state.turn !== aiColor() || fullStatus().over) return;
    aiThinking = true;
    render();
    const cfg = aiConfig();
    const id = ++aiRequestId;
    aiPending = { depth: cfg.maxDepth, quiesce: cfg.quiesce, started: Date.now() };
    if (aiWorker) {
      // Watchdog for an alive-but-silent worker: onerror only covers
      // workers that break LOUDLY — one that simply never replies would
      // leave the game on "thinking" forever. After the search budget
      // plus margin, replace it and let the synchronous fallback answer
      // (the coach's analysis worker has the same protection).
      clearTimeout(aiWatchdog);
      aiWatchdog = setTimeout(function () {
        if (id !== aiRequestId || !aiThinking) return;
        if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
        aiThinking = false;
        maybeAiMove();
      }, cfg.timeMs + 3000);
      aiWorker.postMessage({
        id: id, fen: Chess.toFen(state), maxDepth: cfg.maxDepth, timeMs: cfg.timeMs,
        quiesce: cfg.quiesce, positions: state.positions
      });
    } else {
      // Fallback: yield so the "thinking" status paints before the search.
      setTimeout(function () {
        if (id !== aiRequestId || !aiThinking) return;
        const result = ChessAI.think(state, {
          maxDepth: cfg.maxDepth, timeMs: cfg.timeMs, quiesce: cfg.quiesce,
          positions: state.positions
        });
        applyAiMove(result.move, result.depth);
      }, AI_DELAY_MS);
    }
  }

  function applyAiMove(move, reachedDepth) {
    clearTimeout(aiWatchdog);
    aiThinking = false;
    viewPly = null;
    // Re-resolve against this state's legal moves (the worker's move object
    // came from a FEN round-trip; also guards against any state drift).
    const local = move && Chess.legalMoves(state).find(function (m) {
      return m.from === move.from && m.to === move.to && m.promotion === move.promotion;
    });
    if (!local) { render(); return; }
    state = Chess.playMove(state, local);
    punchClock();
    if (aiPending) {
      // Record engine settings + think time on the move for PGN debug export.
      // Depth is the deepest COMPLETED iteration, which under a time budget
      // can be less than the configured maximum.
      state.history[state.history.length - 1].ai = {
        depth: reachedDepth || aiPending.depth,
        quiesce: aiPending.quiesce,
        ms: Date.now() - aiPending.started
      };
      aiPending = null;
    }
    render();
    const status = fullStatus();
    if (status.over) showGameOver(status);
  }

  function showGameOver(status) {
    // Finished games feed the coaching archive (Review tab). Coach dedupes
    // re-shown endings of the same game instance (gameSeq).
    if (window.Coach) Coach.archiveGame(state, settings, status, gameSeq);
    const title = status.result === '1-0' ? 'White wins!' :
                  status.result === '0-1' ? 'Black wins!' : 'Draw';
    document.getElementById('gameOverTitle').textContent = title;
    document.getElementById('gameOverDetail').textContent =
      'By ' + status.reason + ' · ' + status.result;
    gameOverDialog.showModal();
  }

  // ---- Controls ----
  // Increments on every New game/Rematch: the coaching archive dedupes
  // re-shown endings by (instance, moves) — an identical game played twice
  // is two archive entries, the same ending re-displayed is one.
  let gameSeq = 0;

  function startNewGame() {
    gameSeq++;
    cancelAi();
    state = Chess.newGameState();
    selected = null;
    viewPly = null;
    flipped = settings.mode === 'ai-w'; // playing Black: show Black at bottom
    resetClocks();
    render();
    maybeAiMove();
  }

  // "New game" opens a setup dialog (which doubles as the restart
  // confirmation): settings only apply when Start is pressed, so changing
  // them and cancelling never affects the running game.
  document.getElementById('newGame').addEventListener('click', function () {
    setChoice('mode', settings.mode);
    setChoice('difficulty', settings.difficulty);
    setChoice('timeControl', settings.timeControl);
    newGameDialog.showModal();
  });

  document.getElementById('newGameStart').addEventListener('click', function () {
    settings.mode = getChoice('mode') || settings.mode;
    settings.difficulty = getChoice('difficulty') || settings.difficulty;
    settings.timeControl = getChoice('timeControl') || settings.timeControl;
    newGameDialog.close();
    startNewGame();
  });

  document.getElementById('newGameCancel').addEventListener('click', function () {
    newGameDialog.close();
  });

  document.getElementById('undo').addEventListener('click', function () {
    // Undo while the AI is thinking cancels the search and takes back the
    // human move that triggered it (it used to silently do nothing).
    if (aiThinking) cancelAi();
    viewPly = null;
    // Against the AI, undo the AI reply too so it's the human's turn again.
    state = Chess.undoMove(state);
    if (aiColor() && state.turn === aiColor() && state.history.length) {
      state = Chess.undoMove(state);
    }
    // Clocks rewind to their recorded state after the new last move (a time
    // forfeit is undone with the move that preceded it).
    if (clocks.wMs !== null) {
      const last = state.history[state.history.length - 1];
      const base = tcParts().baseMs;
      clocks.wMs = last && last.clock ? last.clock.wMs : base;
      clocks.bMs = last && last.clock ? last.clock.bMs : base;
      timeForfeit = null;
      turnStartedAt = Date.now();
    }
    selected = null;
    render();
    // If undo landed on the AI's turn (e.g. undoing the computer's opening
    // move while playing Black), let it move again instead of deadlocking.
    maybeAiMove();
  });

  document.getElementById('flip').addEventListener('click', function () {
    flipped = !flipped;
    render();
  });

  document.getElementById('gameOverClose').addEventListener('click', function () {
    gameOverDialog.close();
  });

  document.getElementById('gameOverReview').addEventListener('click', function () {
    gameOverDialog.close();
    // Hand off to the coaching review of the just-archived game (Review
    // tab): that is where reflection, verification and lesson cards live.
    // Fall back to the on-board replay if the coach is unavailable.
    if (window.Coach && Coach.openLatestArchived && Coach.openLatestArchived()) return;
    setViewPly(0); // start reviewing from the first position
    // Move focus to the forward control so arrow keys drive the replay
    // (the dialog would otherwise hand focus back to the last board square).
    replayFwdEl.focus();
  });

  document.getElementById('gameOverRematch').addEventListener('click', function () {
    gameOverDialog.close();
    startNewGame();
  });

  // ---- Replay navigation ----
  function stepView(delta) {
    const n = state.history.length;
    const cur = isViewing() ? viewPly : n;
    setViewPly(Math.min(n, Math.max(0, cur + delta)));
  }

  replayStartEl.addEventListener('click', function () { setViewPly(0); });
  replayBackEl.addEventListener('click', function () { stepView(-1); });
  replayFwdEl.addEventListener('click', function () { stepView(1); });
  replayLiveEl.addEventListener('click', function () { setViewPly(null); });

  document.addEventListener('keydown', function (e) {
    if (promotionDialog.open || gameOverDialog.open || newGameDialog.open) return;
    // Replay keys drive the LIVE game board — not the coach views.
    if (document.body.dataset.view && document.body.dataset.view !== 'play') return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!state.history.length) return;
    if (e.key === 'ArrowLeft') { stepView(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { stepView(1); e.preventDefault(); }
    else if (e.key === 'Home') { setViewPly(0); e.preventDefault(); }
    else if (e.key === 'End') { setViewPly(null); e.preventDefault(); }
  });

  // ---- PGN export (standard format; optional per-move debug log) ----
  function pad2(n) { return String(n).padStart(2, '0'); }

  function downloadPgn(withLog) {
    const ai = 'Chessy AI (' + DIFF_LABELS[settings.difficulty] + ')';
    const names = settings.mode === 'ai-b' ? { White: 'Human', Black: ai } :
                  settings.mode === 'ai-w' ? { White: ai, Black: 'Human' } :
                  { White: 'Human', Black: 'Human' };
    const now = new Date();
    const tags = Object.assign({
      Date: now.getFullYear() + '.' + pad2(now.getMonth() + 1) + '.' + pad2(now.getDate()),
      TimeControl: settings.timeControl === 'none' ? '-' : settings.timeControl
    }, names);
    // The engine's PGN result only knows board-level endings; a time
    // forfeit lives in the app, so pass the real result (and termination).
    const st = fullStatus();
    if (st.over) tags.Result = st.result;
    if (timeForfeit) tags.Termination = 'time forfeit';
    const pgn = Chess.toPgn(state, tags, withLog);

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
    a.download = 'chessy-' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
                 '-' + pad2(now.getHours()) + pad2(now.getMinutes()) +
                 (withLog ? '-debug' : '') + '.pgn';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  document.getElementById('exportPgn').addEventListener('click', function () { downloadPgn(false); });
  document.getElementById('exportPgnLog').addEventListener('click', function () { downloadPgn(true); });

  // The 5 Hz clock tick deliberately never writes localStorage (see
  // renderClocks), so the last full save can be many seconds stale. Persist
  // the LIVE remaining time at the moments the page may go away — otherwise
  // a reload refunds everything since the last render, and reloading
  // becomes a way to win time back on a running clock.
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') save();
  });

  // ---- Persistence ----
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        fen: Chess.toFen(state),
        history: state.history,
        positions: state.positions,
        mode: settings.mode,
        difficulty: settings.difficulty,
        timeControl: settings.timeControl,
        clocks: clocks.wMs !== null
          ? { wMs: liveRemaining('w'), bMs: liveRemaining('b') } : null,
        timeForfeit: timeForfeit,
        flipped: flipped,
        // Persisted so the coach's archive dedupe survives reloads: a
        // reload → undo → replayed ending is the SAME game instance.
        gameSeq: gameSeq
      }));
    } catch (e) { /* storage unavailable (private mode etc.) — play on */ }
  }

  // Restore a saved game by REPLAYING it through the engine rather than
  // trusting the stored blob: every recorded move must be legal from the
  // start position and the final FEN must match, or the save is rejected.
  // This validates the whole schema in one stroke, rebuilds the repetition
  // table and SANs from scratch, and migrates any stale derived data.
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (typeof data.fen !== 'string' || !Array.isArray(data.history)) return false;
      let s = Chess.newGameState();
      for (const entry of data.history) {
        if (!entry || typeof entry !== 'object' || !entry.move) return false;
        const legal = Chess.legalMoves(s);
        const m = legal.find(function (x) {
          return x.from === entry.move.from && x.to === entry.move.to &&
                 (x.promotion || null) === (entry.move.promotion || null);
        });
        if (!m) return false;
        s = Chess.playMove(s, m);
        if (entry.ai && typeof entry.ai === 'object') {
          s.history[s.history.length - 1].ai = {
            depth: Number(entry.ai.depth) || 0,
            quiesce: !!entry.ai.quiesce,
            ms: Number(entry.ai.ms) || 0
          };
        }
        if (entry.clock && typeof entry.clock === 'object') {
          s.history[s.history.length - 1].clock = {
            thinkMs: Number(entry.clock.thinkMs) || 0,
            wMs: Number(entry.clock.wMs) || 0,
            bMs: Number(entry.clock.bMs) || 0
          };
        }
      }
      if (Chess.toFen(s) !== data.fen) return false;
      state = s;
      settings.mode = MODE_LABELS[data.mode] ? data.mode : 'ai-b';
      settings.difficulty = DIFF_LABELS[data.difficulty] ? String(data.difficulty) : '2';
      settings.timeControl = TIME_CONTROLS[data.timeControl] ? data.timeControl : 'none';
      const tc = tcParts();
      if (tc) {
        clocks.wMs = data.clocks && isFinite(data.clocks.wMs)
          ? Math.max(0, Number(data.clocks.wMs)) : tc.baseMs;
        clocks.bMs = data.clocks && isFinite(data.clocks.bMs)
          ? Math.max(0, Number(data.clocks.bMs)) : tc.baseMs;
        timeForfeit = data.timeForfeit &&
          (data.timeForfeit.color === 'w' || data.timeForfeit.color === 'b')
          ? { color: data.timeForfeit.color, draw: !!data.timeForfeit.draw } : null;
        turnStartedAt = Date.now(); // time away from the app is not charged
        clockTicker = setInterval(tickClock, 200);
      } else {
        clocks.wMs = null;
        clocks.bMs = null;
      }
      flipped = !!data.flipped;
      gameSeq = Number(data.gameSeq) || 0;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- Boot ----
  buildBoard();
  load();
  render();
  maybeAiMove();

  // A game restored in a FINISHED state may have missed its archive write:
  // the tab can die between the synchronous localStorage save and the
  // asynchronous IndexedDB commit, and nothing on the next boot calls
  // showGameOver() again. Re-offer the restored game to the coach — its
  // persisted dedupe makes this a no-op when the archive already has it
  // (and re-points the "Review game" handoff at the right record).
  // On window load, NOT a zero timeout: coach.js is a later script tag and
  // the parser may yield to timers while it is still being fetched.
  window.addEventListener('load', function () {
    if (!window.Coach) return;
    // The coach's Delete All tombstones the live game via this provider —
    // otherwise the reconcile below would archive the deleted game right
    // back on the next reload.
    Coach.registerLiveGame(function () {
      const st = fullStatus();
      if (!st.over || !state.history.length) return null;
      return {
        sans: state.history.map(function (h) { return h.san; }),
        result: st.result,
        gameSeq: gameSeq
      };
    });
    const status = fullStatus();
    if (status.over && state.history.length) {
      Coach.archiveGame(state, settings, status, gameSeq);
    }
  });
})();
