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

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const moveListEl = document.getElementById('moveList');
  const modeEl = document.getElementById('mode');
  const difficultyEl = document.getElementById('difficulty');
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
    aiRequestId++;
    aiThinking = false;
    aiPending = null;
  }

  // ---- Setup board DOM (64 cells, order = board index a8..h1) ----
  function buildBoard() {
    boardEl.innerHTML = '';
    squares = [];
    for (let i = 0; i < 64; i++) {
      const cell = document.createElement('button');
      const r = Math.floor(i / 8), c = i % 8;
      cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      cell.dataset.index = i;
      cell.setAttribute('aria-label', Chess.sqName(i));
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
      boardEl.appendChild(cell);
      squares.push(cell);
    }
  }

  function humanColors() {
    switch (modeEl.value) {
      case 'ai-b': return ['w'];       // human plays White, AI plays Black
      case 'ai-w': return ['b'];
      default: return ['w', 'b'];
    }
  }

  function aiColor() {
    if (modeEl.value === 'ai-b') return 'b';
    if (modeEl.value === 'ai-w') return 'w';
    return null;
  }

  function render() {
    const status = Chess.gameStatus(state);
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
      const target = legal.find(function (m) { return m.to === i; });
      cell.classList.toggle('hint', !!target && !state.board[i]);
      cell.classList.toggle('hint-capture', !!target && !!state.board[i]);
    }
    boardEl.classList.toggle('flipped', flipped);

    const n = state.history.length;
    replayStartEl.disabled = shown === 0;
    replayBackEl.disabled = shown === 0;
    replayFwdEl.disabled = shown >= n;
    replayLiveEl.disabled = !viewing;

    renderStatus(status);
    renderMoves();
    renderCaptured();
    save();
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
    const current = moveListEl.querySelector('.current');
    if (current) current.scrollIntoView({ block: 'nearest' });
    else moveListEl.scrollTop = moveListEl.scrollHeight;
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
  function onSquareClick(i) {
    // While reviewing, a board tap returns to the live position.
    if (isViewing()) { setViewPly(null); return; }
    if (aiThinking || Chess.gameStatus(state).over) return;
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
    selected = null;
    viewPly = null;
    render();
    const status = Chess.gameStatus(state);
    if (status.over) { showGameOver(status); return; }
    maybeAiMove();
  }

  // Difficulty select values are search depths, except the named top level:
  // Master searches with quiescence (captures are resolved past the horizon,
  // eliminating exchange blunders) under a per-move time budget, iteratively
  // deepening as far as the clock allows. The fixed-depth levels carry a
  // generous budget purely as a safety net for pathological positions.
  function aiConfig() {
    if (difficultyEl.value === 'master') return { maxDepth: 30, timeMs: 2000, quiesce: true };
    return { maxDepth: Number(difficultyEl.value), timeMs: 10000, quiesce: false };
  }

  function maybeAiMove() {
    if (state.turn !== aiColor() || Chess.gameStatus(state).over) return;
    aiThinking = true;
    render();
    const cfg = aiConfig();
    const id = ++aiRequestId;
    aiPending = { depth: cfg.maxDepth, quiesce: cfg.quiesce, started: Date.now() };
    if (aiWorker) {
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
    aiThinking = false;
    viewPly = null;
    // Re-resolve against this state's legal moves (the worker's move object
    // came from a FEN round-trip; also guards against any state drift).
    const local = move && Chess.legalMoves(state).find(function (m) {
      return m.from === move.from && m.to === move.to && m.promotion === move.promotion;
    });
    if (!local) { render(); return; }
    state = Chess.playMove(state, local);
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
    const status = Chess.gameStatus(state);
    if (status.over) showGameOver(status);
  }

  function showGameOver(status) {
    const title = status.result === '1-0' ? 'White wins!' :
                  status.result === '0-1' ? 'Black wins!' : 'Draw';
    document.getElementById('gameOverTitle').textContent = title;
    document.getElementById('gameOverDetail').textContent =
      'By ' + status.reason + ' · ' + status.result;
    gameOverDialog.showModal();
  }

  // ---- Controls ----
  function startNewGame() {
    cancelAi();
    state = Chess.newGameState();
    selected = null;
    viewPly = null;
    flipped = modeEl.value === 'ai-w'; // playing Black: show Black at bottom
    render();
    maybeAiMove();
  }

  document.getElementById('newGame').addEventListener('click', startNewGame);

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
    setViewPly(0); // start reviewing from the first position
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
    if (promotionDialog.open || gameOverDialog.open) return;
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
    const level = difficultyEl.options[difficultyEl.selectedIndex].text;
    const ai = 'Chessy AI (' + level + ')';
    const names = modeEl.value === 'ai-b' ? { White: 'Human', Black: ai } :
                  modeEl.value === 'ai-w' ? { White: ai, Black: 'Human' } :
                  { White: 'Human', Black: 'Human' };
    const now = new Date();
    const tags = Object.assign({
      Date: now.getFullYear() + '.' + pad2(now.getMonth() + 1) + '.' + pad2(now.getDate())
    }, names);
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

  modeEl.addEventListener('change', function () {
    cancelAi();
    save();
    maybeAiMove();
  });
  difficultyEl.addEventListener('change', save);

  // ---- Persistence ----
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        fen: Chess.toFen(state),
        history: state.history,
        positions: state.positions,
        mode: modeEl.value,
        difficulty: difficultyEl.value,
        flipped: flipped
      }));
    } catch (e) { /* storage unavailable (private mode etc.) — play on */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      const restored = Chess.parseFen(data.fen);
      restored.history = data.history || [];
      restored.positions = data.positions || {};
      if (!restored.positions[Chess.positionKey(restored)]) {
        restored.positions[Chess.positionKey(restored)] = 1;
      }
      state = restored;
      modeEl.value = data.mode || 'ai-b';
      difficultyEl.value = data.difficulty || '2';
      flipped = !!data.flipped;
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
})();
