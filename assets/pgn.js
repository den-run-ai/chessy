/*
 * Chessy PGN import (roadmap #23, Phase 4) — a single-game PGN parser and
 * validator. Pure and side-effect free: it parses tags, mainline moves,
 * comments, NAGs, %clk clock annotations and SetUp/FEN, validates every move
 * through the rules engine, and produces an archive-ready record with
 * canonical moves (UCI + from/to/promotion) ALONGSIDE display SAN. The store
 * commits it once or not at all (CoachStore.importGame), deduped by external
 * id or a content hash — so a repeated import yields ONE game.
 *
 * Variations are skipped (mainline only). Nothing here writes or prompts:
 * when the player's side cannot be inferred it is left null for the caller
 * (the import dialog) to resolve.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined') return;

  const RESULTS = { '1-0': 1, '0-1': 1, '1/2-1/2': 1, '*': 1 };

  // --- Tag pairs: [Key "Value"], with \" and \\ escapes in the value. ---
  function parseTags(text) {
    const tags = {};
    const re = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g;
    let m;
    while ((m = re.exec(text))) {
      tags[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
    }
    return tags;
  }

  // [%clk H:MM:SS(.f)] / MM:SS / SS -> milliseconds, or null.
  function parseClk(comment) {
    const m = /\[%clk\s+([\d:.]+)\]/.exec(comment);
    if (!m) return null;
    const parts = m[1].split(':').map(Number);
    if (parts.some(function (x) { return isNaN(x); })) return null;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return Math.round(sec * 1000);
  }

  // Strip check/mate/annotation glyphs and normalise castling/promotion so an
  // external SAN can be matched against the engine's own toSan output.
  function canon(san) {
    return san.replace(/e\.p\.$/, '')
      .replace(/[+#!?]/g, '')
      .replace(/=/g, '')
      .replace(/0/g, 'O');
  }

  // Tokenise the movetext after the tag section: returns raw move entries
  // { san, nags, comment, clkMs } in mainline order, plus the result token.
  function parseMovetext(text) {
    const moves = [];
    let result = null, pre = '';
    let i = 0;
    const n = text.length;
    function attachComment(c) {
      if (moves.length) {
        const last = moves[moves.length - 1];
        last.comment = last.comment ? last.comment + ' ' + c : c;
        const clk = parseClk(c);
        if (clk != null) last.clkMs = clk;
      } else { pre += (pre ? ' ' : '') + c; }
    }
    while (i < n) {
      const ch = text[i];
      if (ch === '{') {
        let j = text.indexOf('}', i + 1);
        if (j < 0) j = n;
        attachComment(text.slice(i + 1, j).trim());
        i = j + 1; continue;
      }
      if (ch === ';') { // rest-of-line comment
        let j = text.indexOf('\n', i);
        if (j < 0) j = n;
        attachComment(text.slice(i + 1, j).trim());
        i = j + 1; continue;
      }
      if (ch === '(') { // skip a (balanced, possibly nested) variation
        let depth = 1; i++;
        while (i < n && depth > 0) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
          i++;
        }
        continue;
      }
      if (ch === '$') {
        let j = i + 1;
        while (j < n && /\d/.test(text[j])) j++;
        if (moves.length) moves[moves.length - 1].nags.push(text.slice(i, j));
        i = j; continue;
      }
      if (/\s/.test(ch)) { i++; continue; }
      let j = i;
      while (j < n && !/[\s{();$]/.test(text[j])) j++;
      let tok = text.slice(i, j);
      i = j;
      if (RESULTS[tok]) { result = tok; continue; }
      // Strip a leading move number ("12." / "12...") — the remainder, if
      // any, is a SAN on the same token (spaceless PGN).
      tok = tok.replace(/^\d+\.(\.\.)?/, '');
      if (!tok) continue;
      moves.push({ san: tok, nags: [], comment: null, clkMs: null });
    }
    return { moves: moves, result: result, pre: pre };
  }

  // Two 32-bit hashes concatenated → a compact, low-collision content id.
  function contentHash(setupFen, uciList, result) {
    const s = (setupFen || 'start') + '|' + uciList.join(' ') + '|' + (result || '*');
    let a = 5381, b = 52711;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = ((a << 5) + a + c) | 0;
      b = ((b << 5) + b + (c ^ 0x5f)) | 0;
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
  }

  function uciOf(m) {
    return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
  }

  // Parse and VALIDATE the first game in `text`. Returns
  //   { valid, error, tags, setupFen, result, reason, moves:[{san,uci,from,
  //     to,promotion,nags,comment,clkMs}], plies }
  // A single illegal/unknown move makes valid:false with error and the ply.
  function parseGame(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { valid: false, error: 'empty PGN', moves: [] };
    }
    const tags = parseTags(text);
    // Movetext is everything after the leading block of tag-pair lines. Do
    // NOT scan for the last ']' — a %clk/eval comment can contain one.
    const body = text.replace(/^\s*(?:\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*)+/, '');
    const setup = tags.SetUp === '1' && tags.FEN ? tags.FEN : (tags.FEN || null);
    let state;
    try {
      state = setup ? Chess.parseFen(setup) : Chess.newGameState();
    } catch (e) {
      return { valid: false, error: 'invalid SetUp/FEN tag', tags: tags, moves: [] };
    }
    // parseFen produces a bare position; give it the game shape playMove needs.
    if (!state.history) state.history = [];
    if (!state.positions) { state.positions = {}; state.positions[Chess.positionKey(state)] = 1; }

    const parsed = parseMovetext(body);
    const moves = [];
    let s = state;
    for (let k = 0; k < parsed.moves.length; k++) {
      const raw = parsed.moves[k];
      const legal = Chess.legalMoves(s);
      const want = canon(raw.san);
      const hit = legal.find(function (m) { return canon(Chess.toSan(s, m, legal)) === want; });
      if (!hit) {
        return { valid: false, error: 'illegal or unknown move "' + raw.san + '"',
          ply: k + 1, tags: tags, setupFen: setup, moves: [] };
      }
      moves.push({
        san: Chess.toSan(s, hit, legal), uci: uciOf(hit),
        from: hit.from, to: hit.to, promotion: hit.promotion || null,
        nags: raw.nags, comment: raw.comment, clkMs: raw.clkMs
      });
      s = Chess.playMove(s, hit);
    }
    // A terminal final position labels the reason; otherwise it is an
    // imported (possibly unfinished) game.
    const status = Chess.gameStatus(s);
    const result = parsed.result || tags.Result || '*';
    return {
      valid: true, error: null, tags: tags, setupFen: setup,
      result: result, reason: status.over ? status.reason : 'imported',
      moves: moves, plies: moves.length
    };
  }

  // Build an archive-ready record from a validated game. opts:
  //   playerColor ('w'|'b'|null), externalId, timeControl, importedAt, playedAt.
  function toRecord(game, opts) {
    opts = opts || {};
    const uciList = game.moves.map(function (m) { return m.uci; });
    const hash = contentHash(game.setupFen, uciList, game.result);
    const externalId = opts.externalId || null;
    return {
      id: externalId || hash,
      source: 'import',
      externalId: externalId,
      contentHash: hash,
      tags: game.tags || {},
      setupFen: game.setupFen || null,
      sans: game.moves.map(function (m) { return m.san; }),
      moves: game.moves.map(function (m) {
        return { san: m.san, uci: m.uci, from: m.from, to: m.to, promotion: m.promotion };
      }),
      playerColor: opts.playerColor != null ? opts.playerColor : null,
      clocks: game.moves.map(function (m) { return m.clkMs != null ? { ms: m.clkMs } : null; }),
      result: game.result,
      reason: game.reason,
      mode: 'import',
      difficulty: null,
      timeControl: opts.timeControl || (game.tags && game.tags.TimeControl) || 'unknown',
      plies: game.plies,
      importedAt: opts.importedAt != null ? opts.importedAt : null,
      playedAt: opts.playedAt != null ? opts.playedAt
        : (game.tags && game.tags.UTCDate) || (game.tags && game.tags.Date) || null,
      createdAt: opts.createdAt != null ? opts.createdAt
        : (opts.importedAt != null ? opts.importedAt : 0)
    };
  }

  global.ChessyPGN = {
    parseGame: parseGame,
    parseTags: parseTags,
    parseClk: parseClk,
    contentHash: contentHash,
    toRecord: toRecord
  };
})(typeof window !== 'undefined' ? window : globalThis);
