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

  let state = Chess.newGameState();
  let selected = null;        // selected square index
  let flipped = false;
  let aiThinking = false;
  let squares = [];           // 64 DOM cells, index = board index

  // AI runs in a Web Worker so deep searches never freeze the board;
  // falls back to a synchronous call where workers are unavailable.
  let aiRequestId = 0;        // stale replies (after new game/undo/mode change) are dropped
  let aiWorker = null;
  try {
    aiWorker = new Worker('js/ai-worker.js');
    aiWorker.onmessage = function (e) {
      if (e.data.id !== aiRequestId || !aiThinking) return;
      applyAiMove(e.data.move);
    };
  } catch (e) { aiWorker = null; }

  function cancelAi() {
    aiRequestId++;
    aiThinking = false;
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
    const lastEntry = state.history[state.history.length - 1];
    const legal = selected !== null ? Chess.legalMovesFrom(state, selected) : [];
    const kingInCheck = status.check || status.reason === 'checkmate'
      ? state.board.indexOf(state.turn + 'K') : -1;

    for (let i = 0; i < 64; i++) {
      const cell = squares[i];
      const p = state.board[i];
      cell.querySelector('.piece').textContent = p ? GLYPHS[p] : '';
      cell.classList.toggle('white-piece', !!p && p[0] === 'w');
      cell.classList.toggle('black-piece', !!p && p[0] === 'b');
      cell.classList.toggle('selected', i === selected);
      cell.classList.toggle('last-move',
        !!lastEntry && (i === lastEntry.move.from || i === lastEntry.move.to));
      cell.classList.toggle('check', i === kingInCheck);
      const target = legal.find(function (m) { return m.to === i; });
      cell.classList.toggle('hint', !!target && !state.board[i]);
      cell.classList.toggle('hint-capture', !!target && !!state.board[i]);
    }
    boardEl.classList.toggle('flipped', flipped);

    renderStatus(status);
    renderMoves();
    renderCaptured();
    save();
  }

  function renderStatus(status) {
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
    moveListEl.innerHTML = '';
    for (let i = 0; i < state.history.length; i += 2) {
      const li = document.createElement('li');
      const white = state.history[i].san;
      const black = state.history[i + 1] ? state.history[i + 1].san : '';
      li.innerHTML = '<span class="ply">' + white + '</span><span class="ply">' + black + '</span>';
      moveListEl.appendChild(li);
    }
    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  function renderCaptured() {
    const byWhite = [], byBlack = [];
    for (const entry of state.history) {
      if (!entry.move.captured) continue;
      (entry.move.captured[0] === 'b' ? byWhite : byBlack).push(GLYPHS[entry.move.captured]);
    }
    capturedByWhiteEl.textContent = byWhite.join(' ');
    capturedByBlackEl.textContent = byBlack.join(' ');
  }

  // ---- Interaction ----
  function onSquareClick(i) {
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
    render();
    const status = Chess.gameStatus(state);
    if (status.over) { showGameOver(status); return; }
    maybeAiMove();
  }

  // Difficulty select values are search depths, except the named top level:
  // Master searches like Expert but adds quiescence (captures are resolved
  // past the horizon, eliminating exchange blunders).
  function aiConfig() {
    if (difficultyEl.value === 'master') return { depth: 5, quiesce: true };
    return { depth: Number(difficultyEl.value), quiesce: false };
  }

  function maybeAiMove() {
    if (state.turn !== aiColor() || Chess.gameStatus(state).over) return;
    aiThinking = true;
    render();
    const cfg = aiConfig();
    const id = ++aiRequestId;
    if (aiWorker) {
      aiWorker.postMessage({ id: id, fen: Chess.toFen(state), depth: cfg.depth, quiesce: cfg.quiesce });
    } else {
      // Fallback: yield so the "thinking" status paints before the search.
      setTimeout(function () {
        if (id !== aiRequestId || !aiThinking) return;
        applyAiMove(ChessAI.bestMove(state, cfg.depth, cfg.quiesce));
      }, AI_DELAY_MS);
    }
  }

  function applyAiMove(move) {
    aiThinking = false;
    // Re-resolve against this state's legal moves (the worker's move object
    // came from a FEN round-trip; also guards against any state drift).
    const local = move && Chess.legalMoves(state).find(function (m) {
      return m.from === move.from && m.to === move.to && m.promotion === move.promotion;
    });
    if (!local) { render(); return; }
    state = Chess.playMove(state, local);
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
  document.getElementById('newGame').addEventListener('click', function () {
    cancelAi();
    state = Chess.newGameState();
    selected = null;
    flipped = modeEl.value === 'ai-w'; // playing Black: show Black at bottom
    render();
    maybeAiMove();
  });

  document.getElementById('undo').addEventListener('click', function () {
    if (aiThinking) return;
    // Against the AI, undo the AI reply too so it's the human's turn again.
    state = Chess.undoMove(state);
    if (aiColor() && state.turn === aiColor() && state.history.length) {
      state = Chess.undoMove(state);
    }
    selected = null;
    render();
  });

  document.getElementById('flip').addEventListener('click', function () {
    flipped = !flipped;
    render();
  });

  document.getElementById('gameOverClose').addEventListener('click', function () {
    gameOverDialog.close();
  });

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
