/*
 * Chessy engine — complete chess rules in dependency-free vanilla JS.
 *
 * Board representation: array of 64 squares, index 0 = a8 ... 63 = h1
 * (rank 8 first so index maps naturally to top-to-bottom rendering).
 * Pieces are two-char strings: color 'w'/'b' + type P N B R Q K. Empty = null.
 */
(function (global) {
  'use strict';

  const FILES = 'abcdefgh';

  function sqName(i) { return FILES[i % 8] + (8 - Math.floor(i / 8)); }
  function sqIndex(name) { return FILES.indexOf(name[0]) + (8 - Number(name[1])) * 8; }
  function rowOf(i) { return Math.floor(i / 8); }
  function colOf(i) { return i % 8; }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function newGameState(fen) {
    const state = parseFen(fen || START_FEN);
    state.history = [];        // list of { move, san, fen } for undo / move list
    state.positions = {};      // repetition table: positionKey -> count
    state.positions[positionKey(state)] = 1;
    return state;
  }

  function parseFen(fen) {
    const parts = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let i = 0;
    for (const ch of parts[0]) {
      if (ch === '/') continue;
      if (/\d/.test(ch)) { i += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      board[i++] = color + ch.toUpperCase();
    }
    return {
      board: board,
      turn: parts[1] || 'w',
      castling: {
        wK: (parts[2] || '').includes('K'),
        wQ: (parts[2] || '').includes('Q'),
        bK: (parts[2] || '').includes('k'),
        bQ: (parts[2] || '').includes('q')
      },
      ep: parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : null,
      halfmove: Number(parts[4] || 0),
      fullmove: Number(parts[5] || 1)
    };
  }

  function toFen(state) {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = state.board[r * 8 + c];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += p[0] === 'w' ? p[1] : p[1].toLowerCase();
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    let cast = '';
    if (state.castling.wK) cast += 'K';
    if (state.castling.wQ) cast += 'Q';
    if (state.castling.bK) cast += 'k';
    if (state.castling.bQ) cast += 'q';
    return [
      out,
      state.turn,
      cast || '-',
      state.ep !== null ? sqName(state.ep) : '-',
      state.halfmove,
      state.fullmove
    ].join(' ');
  }

  // Position identity for threefold repetition: placement + turn + castling + ep.
  // Per FIDE 9.2.3 the en-passant square only distinguishes positions when an
  // en-passant capture is actually (legally) possible — otherwise a position
  // reached after a harmless double push must equal its later recurrences.
  function positionKey(state) {
    const parts = toFen(state).split(' ');
    if (parts[3] !== '-' && !legalMoves(state).some(function (m) { return m.ep; })) {
      parts[3] = '-';
    }
    return parts.slice(0, 4).join(' ');
  }

  const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function findKing(board, color) {
    const target = color + 'K';
    for (let i = 0; i < 64; i++) if (board[i] === target) return i;
    return -1;
  }

  // Is square `i` attacked by side `by`?
  function isAttacked(board, i, by) {
    const r = rowOf(i), c = colOf(i);

    // Pawn attacks: a `by` pawn sits one rank "behind" the square it attacks.
    const pr = by === 'w' ? r + 1 : r - 1;
    for (const dc of [-1, 1]) {
      if (onBoard(pr, c + dc) && board[pr * 8 + c + dc] === by + 'P') return true;
    }
    for (const [dr, dc] of KNIGHT_STEPS) {
      if (onBoard(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === by + 'N') return true;
    }
    for (const [dr, dc] of KING_STEPS) {
      if (onBoard(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === by + 'K') return true;
    }
    for (const [dr, dc] of BISHOP_DIRS) {
      let nr = r + dr, nc = c + dc;
      while (onBoard(nr, nc)) {
        const p = board[nr * 8 + nc];
        if (p) { if (p[0] === by && (p[1] === 'B' || p[1] === 'Q')) return true; break; }
        nr += dr; nc += dc;
      }
    }
    for (const [dr, dc] of ROOK_DIRS) {
      let nr = r + dr, nc = c + dc;
      while (onBoard(nr, nc)) {
        const p = board[nr * 8 + nc];
        if (p) { if (p[0] === by && (p[1] === 'R' || p[1] === 'Q')) return true; break; }
        nr += dr; nc += dc;
      }
    }
    return false;
  }

  function inCheck(state, color) {
    const king = findKing(state.board, color || state.turn);
    return king >= 0 && isAttacked(state.board, king, (color || state.turn) === 'w' ? 'b' : 'w');
  }

  // Pseudo-legal moves for the side to move. Move: {from, to, piece, captured,
  // promotion, ep (en-passant capture), castle ('K'|'Q'), double (pawn 2-step)}.
  function pseudoMoves(state) {
    const { board, turn } = state;
    const moves = [];
    const enemy = turn === 'w' ? 'b' : 'w';

    function push(from, to, extra) {
      moves.push(Object.assign({
        from: from, to: to, piece: board[from], captured: board[to] || null,
        promotion: null, ep: false, castle: null, double: false
      }, extra || {}));
    }

    for (let from = 0; from < 64; from++) {
      const p = board[from];
      if (!p || p[0] !== turn) continue;
      const r = rowOf(from), c = colOf(from), type = p[1];

      if (type === 'P') {
        const dir = turn === 'w' ? -1 : 1;
        const startRow = turn === 'w' ? 6 : 1;
        const promoRow = turn === 'w' ? 0 : 7;
        // forward
        if (onBoard(r + dir, c) && !board[(r + dir) * 8 + c]) {
          const to = (r + dir) * 8 + c;
          if (r + dir === promoRow) {
            for (const promo of ['Q', 'R', 'B', 'N']) push(from, to, { promotion: promo });
          } else {
            push(from, to);
            if (r === startRow && !board[(r + 2 * dir) * 8 + c]) {
              push(from, (r + 2 * dir) * 8 + c, { double: true });
            }
          }
        }
        // captures
        for (const dc of [-1, 1]) {
          if (!onBoard(r + dir, c + dc)) continue;
          const to = (r + dir) * 8 + c + dc;
          if (board[to] && board[to][0] === enemy) {
            if (r + dir === promoRow) {
              for (const promo of ['Q', 'R', 'B', 'N']) push(from, to, { promotion: promo });
            } else {
              push(from, to);
            }
          } else if (to === state.ep) {
            push(from, to, { ep: true, captured: enemy + 'P' });
          }
        }
      } else if (type === 'N' || type === 'K') {
        const steps = type === 'N' ? KNIGHT_STEPS : KING_STEPS;
        for (const [dr, dc] of steps) {
          if (!onBoard(r + dr, c + dc)) continue;
          const to = (r + dr) * 8 + c + dc;
          if (!board[to] || board[to][0] === enemy) push(from, to);
        }
        if (type === 'K') {
          // Castling: rights intact, path empty, king not in / through / into check.
          const home = turn === 'w' ? 56 : 0;
          if (from === home + 4 && !isAttacked(board, from, enemy)) {
            if (state.castling[turn + 'K'] &&
                !board[home + 5] && !board[home + 6] &&
                board[home + 7] === turn + 'R' &&
                !isAttacked(board, home + 5, enemy) && !isAttacked(board, home + 6, enemy)) {
              push(from, home + 6, { castle: 'K' });
            }
            if (state.castling[turn + 'Q'] &&
                !board[home + 3] && !board[home + 2] && !board[home + 1] &&
                board[home] === turn + 'R' &&
                !isAttacked(board, home + 3, enemy) && !isAttacked(board, home + 2, enemy)) {
              push(from, home + 2, { castle: 'Q' });
            }
          }
        }
      } else {
        const dirs = type === 'B' ? BISHOP_DIRS : type === 'R' ? ROOK_DIRS : KING_STEPS;
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc;
          while (onBoard(nr, nc)) {
            const to = nr * 8 + nc;
            if (!board[to]) { push(from, to); }
            else { if (board[to][0] === enemy) push(from, to); break; }
            nr += dr; nc += dc;
          }
        }
      }
    }
    return moves;
  }

  // Apply a move to a bare position (no history bookkeeping). Returns new state.
  function applyMove(state, move) {
    const board = state.board.slice();
    const castling = Object.assign({}, state.castling);
    const turn = state.turn;
    const enemy = turn === 'w' ? 'b' : 'w';

    board[move.to] = move.promotion ? turn + move.promotion : board[move.from];
    board[move.from] = null;

    if (move.ep) {
      const capRow = turn === 'w' ? rowOf(move.to) + 1 : rowOf(move.to) - 1;
      board[capRow * 8 + colOf(move.to)] = null;
    }
    if (move.castle) {
      const home = turn === 'w' ? 56 : 0;
      if (move.castle === 'K') { board[home + 5] = board[home + 7]; board[home + 7] = null; }
      else { board[home + 3] = board[home]; board[home] = null; }
    }

    if (move.piece[1] === 'K') { castling[turn + 'K'] = false; castling[turn + 'Q'] = false; }
    // Rook moved or was captured on its home square.
    for (const [sq, key] of [[56, 'wQ'], [63, 'wK'], [0, 'bQ'], [7, 'bK']]) {
      if (move.from === sq || move.to === sq) castling[key] = false;
    }

    return {
      board: board,
      turn: enemy,
      castling: castling,
      ep: move.double ? (move.from + move.to) / 2 : null,
      halfmove: (move.piece[1] === 'P' || move.captured) ? 0 : state.halfmove + 1,
      fullmove: turn === 'b' ? state.fullmove + 1 : state.fullmove
    };
  }

  function legalMoves(state) {
    const moves = [];
    for (const m of pseudoMoves(state)) {
      const next = applyMove(state, m);
      if (!inCheck(next, state.turn)) moves.push(m);
    }
    return moves;
  }

  function legalMovesFrom(state, from) {
    return legalMoves(state).filter(function (m) { return m.from === from; });
  }

  // Standard Algebraic Notation, with disambiguation and check/mate suffix.
  function toSan(state, move, legal) {
    if (move.castle) {
      var san = move.castle === 'K' ? 'O-O' : 'O-O-O';
    } else {
      const type = move.piece[1];
      san = '';
      if (type === 'P') {
        if (move.captured) san += FILES[colOf(move.from)];
      } else {
        san += type;
        const rivals = (legal || legalMoves(state)).filter(function (m) {
          return m.piece === move.piece && m.to === move.to && m.from !== move.from;
        });
        if (rivals.length) {
          const sameFile = rivals.some(function (m) { return colOf(m.from) === colOf(move.from); });
          const sameRow = rivals.some(function (m) { return rowOf(m.from) === rowOf(move.from); });
          if (!sameFile) san += FILES[colOf(move.from)];
          else if (!sameRow) san += String(8 - rowOf(move.from));
          else san += sqName(move.from);
        }
      }
      if (move.captured) san += 'x';
      san += sqName(move.to);
      if (move.promotion) san += '=' + move.promotion;
    }
    const next = applyMove(state, move);
    if (inCheck(next, next.turn)) {
      san += legalMoves(next).length === 0 ? '#' : '+';
    }
    return san;
  }

  // Could `color` possibly deliver checkmate by ANY series of legal moves?
  // The opponent may cooperate — a helpmate suffices. This is the FIDE 6.9
  // flag-fall test: when `color`'s opponent oversteps the clock, `color`
  // wins unless canMate() is false, in which case the game is drawn.
  // Material-only analysis (piece positions are ignored, so an unreachable
  // mate in a blocked fortress still counts as "possible" — conservative in
  // the right direction: a win on time is only downgraded to a draw when NO
  // arrangement of the material can produce mate):
  //   - a pawn, rook or queen can always mate (pawns promote);
  //   - a lone knight mates only with an opponent blocker that can seal the
  //     escape square (their pawn/knight/bishop/rook — a queen can always
  //     capture the checker or vacate, so it never enables the helpmate);
  //   - two knights or knight+bishop can helpmate a bare king;
  //   - bishops mate only if bishops (either side's) cover both square
  //     colors, or a pawn/knight exists to block with;
  //   - a bare king never mates.
  function canMate(board, color) {
    let ownMinors = 0, ownKnight = false, ownBishop = false;
    let pawnOrKnight = false, oppBlocker = false;
    let bishopShades = 0;
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p || p[1] === 'K') continue;
      const own = p[0] === color, type = p[1];
      if (own && (type === 'P' || type === 'R' || type === 'Q')) return true;
      if (type === 'P' || type === 'N') pawnOrKnight = true;
      if (type === 'B') bishopShades |= 1 << ((rowOf(i) + colOf(i)) % 2);
      if (own) {
        ownMinors++;
        if (type === 'N') ownKnight = true;
        if (type === 'B') ownBishop = true;
      } else if (type !== 'Q') {
        oppBlocker = true;
      }
    }
    if (ownKnight) return ownMinors >= 2 || oppBlocker;
    if (ownBishop) return bishopShades === 3 || pawnOrKnight;
    return false;
  }

  function insufficientMaterial(board) {
    const minors = [];
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p || p[1] === 'K') continue;
      if (p[1] === 'B' || p[1] === 'N') {
        minors.push({ type: p[1], shade: (rowOf(i) + colOf(i)) % 2 });
        continue;
      }
      return false; // pawn, rook or queen on the board
    }
    if (minors.length <= 1) return true; // K vs K, K+minor vs K
    // Any number of bishops (either side, incl. promoted ones) all confined to
    // one square color can never deliver mate. Knights can (helpmates), so any
    // knight in a multi-minor position keeps the game alive.
    return minors.every(function (m) { return m.type === 'B' && m.shade === minors[0].shade; });
  }

  // Game status for a full game state (with repetition table).
  function gameStatus(state) {
    const moves = legalMoves(state);
    const check = inCheck(state, state.turn);
    if (moves.length === 0) {
      return check
        ? { over: true, result: state.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' }
        : { over: true, result: '1/2-1/2', reason: 'stalemate' };
    }
    if (state.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    if (insufficientMaterial(state.board)) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    if ((state.positions || {})[positionKey(state)] >= 3) {
      return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    }
    return { over: false, check: check };
  }

  // Play a move on a full game state (records history + repetition).
  function playMove(state, move) {
    const legal = legalMoves(state);
    const san = toSan(state, move, legal);
    const next = applyMove(state, move);
    next.history = state.history.concat([{ move: move, san: san, fen: toFen(state) }]);
    next.positions = Object.assign({}, state.positions);
    const key = positionKey(next);
    next.positions[key] = (next.positions[key] || 0) + 1;
    return next;
  }

  // Export the game as PGN (standard Portable Game Notation). `tags` override
  // the seven-tag roster; `withLog` embeds a debug comment per move (engine
  // settings and think time for AI moves, plus the FEN before the move).
  function toPgn(state, tags, withLog) {
    const status = gameStatus(state);
    const roster = {
      Event: 'Chessy game',
      Site: 'Chessy offline PWA',
      Date: '????.??.??',
      Round: '-',
      White: 'White',
      Black: 'Black',
      Result: status.over ? status.result : '*'
    };
    Object.assign(roster, tags || {});
    let head = '';
    for (const k of Object.keys(roster)) head += '[' + k + ' "' + roster[k] + '"]\n';

    const parts = [];
    state.history.forEach(function (entry, i) {
      if (i % 2 === 0) parts.push((i / 2 + 1) + '.');
      parts.push(entry.san);
      if (withLog) {
        let note = 'before: ' + entry.fen;
        if (entry.ai) {
          note = 'engine depth ' + entry.ai.depth + (entry.ai.quiesce ? '+quiescence' : '') +
                 ', ' + entry.ai.ms + ' ms; ' + note;
        }
        // Standard %clk command: the mover's remaining time after the move.
        if (entry.clock) {
          const ms = i % 2 === 0 ? entry.clock.wMs : entry.clock.bMs;
          const sec = Math.max(0, Math.round(ms / 1000));
          note = '[%clk ' + Math.floor(sec / 3600) + ':' +
                 String(Math.floor(sec / 60) % 60).padStart(2, '0') + ':' +
                 String(sec % 60).padStart(2, '0') + '] ' + note;
        }
        parts.push('{' + note + '}');
      }
    });
    if (status.over) parts.push('{' + status.reason + '}');
    parts.push(roster.Result);

    // Wrap the movetext at ~80 characters per PGN convention.
    let text = '', line = '';
    for (const p of parts) {
      if (line && line.length + 1 + p.length > 80) { text += line + '\n'; line = p; }
      else line += (line ? ' ' : '') + p;
    }
    return head + '\n' + text + line + '\n';
  }

  // Replay SAN moves from the standard start position into a full game
  // state (history + repetition table). Throws on the first move that is
  // illegal or does not match any legal move. The SANs are expected in
  // this engine's own notation (toSan output) — the coaching archive
  // stores exactly that.
  function replaySans(sans) {
    let s = newGameState();
    for (let i = 0; i < sans.length; i++) {
      const legal = legalMoves(s);
      const m = legal.find(function (mv) { return toSan(s, mv, legal) === sans[i]; });
      if (!m) throw new Error('illegal or unknown SAN "' + sans[i] + '" at ply ' + (i + 1));
      s = playMove(s, m);
    }
    return s;
  }

  function undoMove(state) {
    if (!state.history.length) return state;
    const prevEntry = state.history[state.history.length - 1];
    const prev = parseFen(prevEntry.fen);
    prev.history = state.history.slice(0, -1);
    const key = positionKey(state);
    prev.positions = Object.assign({}, state.positions);
    if (prev.positions[key] > 1) prev.positions[key] -= 1; else delete prev.positions[key];
    return prev;
  }

  global.Chess = {
    START_FEN: START_FEN,
    newGameState: newGameState,
    parseFen: parseFen,
    toFen: toFen,
    positionKey: positionKey,
    sqName: sqName,
    sqIndex: sqIndex,
    legalMoves: legalMoves,
    legalMovesFrom: legalMovesFrom,
    pseudoMoves: pseudoMoves,
    isAttacked: isAttacked,
    applyMove: applyMove,
    playMove: playMove,
    undoMove: undoMove,
    toSan: toSan,
    toPgn: toPgn,
    replaySans: replaySans,
    inCheck: inCheck,
    insufficientMaterial: insufficientMaterial,
    canMate: canMate,
    gameStatus: gameStatus
  };
})(typeof window !== 'undefined' ? window : globalThis);
