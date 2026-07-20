/*
 * Chessy mini board — the small board used by the coaching views
 * (Review now; Train later). It reproduces the Play board's FULL
 * accessibility model, not a lesser copy: an ARIA grid of role=row/
 * role=gridcell buttons with a single roving tab stop and arrow-key
 * navigation, so the board is keyboard-inspectable and announces its
 * state. Without an onClick handler the board is inspection-only
 * (clicks and Enter no-op).
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined') return;

  const TXT = '︎';
  const GLYPHS = {
    wK: '♚' + TXT, wQ: '♛' + TXT, wR: '♜' + TXT,
    wB: '♝' + TXT, wN: '♞' + TXT, wP: '♟' + TXT,
    bK: '♚' + TXT, bQ: '♛' + TXT, bR: '♜' + TXT,
    bB: '♝' + TXT, bN: '♞' + TXT, bP: '♟' + TXT
  };
  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

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

  global.ChessyMiniBoard = { make: makeBoard, GLYPHS: GLYPHS, PIECE_NAMES: PIECE_NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
