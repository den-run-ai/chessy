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
  // Standard NAG codes for the symbolic suffix glyphs, so `e4!` / `e5?!`
  // keep their annotation meaning instead of being stripped away.
  const GLYPH_NAG = { '!': '$1', '?': '$2', '!!': '$3', '??': '$4', '!?': '$5', '?!': '$6' };

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

  // [%clk H:MM:SS(.f)] / MM:SS(.f) / SS(.f) -> milliseconds, or null. The shape
  // is validated STRICTLY (subordinate fields 00-59, no empty/excess parts) so
  // a corrupt annotation (1::2, 0:99:00, four fields) becomes null rather than a
  // fabricated remaining time.
  function parseClk(comment) {
    const m = /\[%clk\s+([^\]]+)\]/.exec(comment);
    if (!m) return null;
    const hms = /^(?:(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)|(\d+):([0-5]\d(?:\.\d+)?)|(\d+(?:\.\d+)?))$/
      .exec(m[1].trim());
    if (!hms) return null;
    let sec;
    if (hms[1] !== undefined) sec = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    else if (hms[4] !== undefined) sec = Number(hms[4]) * 60 + Number(hms[5]);
    else sec = Number(hms[6]);
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

  // Parse a SAN's structural fields for a RELAXED match used only when the
  // exact canonical spelling does not match. Handles the valid PGN spellings
  // the engine's own toSan never emits: redundant disambiguation (Rab1 where
  // Rb1 suffices), long-algebraic (e2e4 / Ng1-f3), short pawn captures (ed5)
  // and lowercase promotion (a8=q). Returns null for castling and anything
  // that is not a normal move (so those fall through to a plain reject).
  function sanFields(san) {
    const t = san.replace(/e\.p\.?$/i, '').replace(/[+#!?]/g, '').replace(/=/g, '');
    // An optional single hyphen is allowed ONLY in the origin→destination
    // position (long-algebraic "Ng1-f3" / "e2-e4"); arbitrary hyphens
    // ("N--f3", "Nf-3") are NOT stripped and stay rejected.
    const m = /^([KQRBN])?([a-h])?([1-8])?-?(x)?([a-h][1-8])([QRBNqrbn])?$/.exec(t);
    if (!m) return null;
    return { piece: m[1] || 'P', file: m[2] || null, rank: m[3] || null,
      capture: !!m[4], dest: m[5], promo: m[6] ? m[6].toUpperCase() : null };
  }

  // Find the UNIQUE legal move matching a relaxed SAN spelling. Never guesses:
  // zero OR MORE-THAN-ONE match returns null, so a genuinely ambiguous
  // (under-disambiguated) or unknown move stays rejected. Only members of
  // `legal` are ever considered, so this can never accept an illegal move — it
  // only widens the set of legal SAN SPELLINGS chessy tolerates on import.
  function looseFind(legal, want) {
    const f = sanFields(want);
    if (!f) return null;
    const hits = legal.filter(function (m) {
      if (m.castle) return false;
      if (m.piece[1] !== f.piece) return false;
      if ((m.promotion || null) !== f.promo) return false;
      if (Chess.sqName(m.to) !== f.dest) return false;
      // An explicit capture marker (x) must correspond to an ACTUAL capture, so
      // "Nxf3" onto an empty f3 is rejected rather than stored as "Nf3". A
      // short-form omission (no x, e.g. "ed5") is still tolerated for real
      // captures — a pawn changing file already implies the capture.
      if (f.capture && !m.captured) return false;
      const from = Chess.sqName(m.from);
      if (f.file && from[0] !== f.file) return false;
      if (f.rank && from[1] !== f.rank) return false;
      return true;
    });
    return hits.length === 1 ? hits[0] : null;
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
          const c = text[i];
          // Brace AND semicolon comments inside the variation can contain (
          // or ): skip each whole so those never miscount the variation depth.
          if (c === '{') { const j = text.indexOf('}', i + 1); i = j < 0 ? n : j + 1; continue; }
          if (c === ';') { const j = text.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
          if (c === '(') depth++;
          else if (c === ')') depth--;
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
      while (j < n && !/[\s{}();$]/.test(text[j])) j++;
      // FORWARD-PROGRESS INVARIANT: a stray ) or } (e.g. leaked from a
      // mis-nested comment) is a special char the branches above don't
      // consume, so the token scan makes no progress — skip it by one to
      // guarantee the loop always advances and can never freeze.
      if (j === i) { i++; continue; }
      let tok = text.slice(i, j);
      i = j;
      // Stop at the FIRST game's result: a multi-game PGN must not
      // concatenate later games' moves onto this one.
      if (RESULTS[tok]) { result = tok; break; }
      // Strip a leading move number ("12." / "12...") — the remainder, if
      // any, is a SAN on the same token (spaceless PGN).
      tok = tok.replace(/^\d+\.(\.\.)?/, '');
      if (!tok) continue;
      // A lone "e.p."/"e.p", optionally carrying a trailing !/? glyph
      // ("exd6 e.p.!"), is an en-passant annotation on the previous move, not
      // a move — some producers write the suffix spaced. Any glyph's NAG is
      // attached to that move so the annotation is not lost.
      const epm = /^e\.p\.?([!?]+)?$/i.exec(tok);
      if (epm) {
        if (epm[1] && GLYPH_NAG[epm[1]] && moves.length) moves[moves.length - 1].nags.push(GLYPH_NAG[epm[1]]);
        continue;
      }
      // A result glued to the final move with no separating space ("Qxe5#1-0",
      // "e4*"): split the result off, keep the move, and stop after it (same
      // first-game boundary as a standalone result token). ALL four PGN result
      // markers are handled, matching the standalone-token set.
      let glued = false;
      const rm = tok.match(/^(.+?)(1-0|0-1|1\/2-1\/2|\*)$/);
      if (rm && !/^\d+$/.test(rm[1])) { tok = rm[1]; result = rm[2]; glued = true; }
      // A trailing !/? suffix glyph is a move annotation, not part of the SAN;
      // canon() strips it to match the legal move, so capture it as the
      // equivalent NAG here so the annotation is not silently lost.
      const glyph = (tok.match(/[!?]+$/) || [])[0];
      const nags = glyph && GLYPH_NAG[glyph] ? [GLYPH_NAG[glyph]] : [];
      moves.push({ san: tok, nags: nags, comment: null, clkMs: null });
      if (glued) break;
    }
    return { moves: moves, result: result, pre: pre };
  }

  // The seven-tag-roster identity that distinguishes two DIFFERENT games that
  // happen to share the same moves+result (a common opening line played twice
  // by different people). Folded into the content id so they do not collapse.
  const IDENTITY_TAGS = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'UTCDate', 'UTCTime'];

  // Two 32-bit hashes concatenated → a compact, low-collision content id over
  // the initial position, canonical moves, result AND identity tags.
  function contentHash(setupFen, uciList, result, tags) {
    let s = (setupFen || 'start') + '|' + uciList.join(' ') + '|' + (result || '*');
    if (tags) for (const k of IDENTITY_TAGS) if (tags[k]) s += '|' + k + '=' + tags[k];
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

  // Strict structural FEN validation (parseFen is lenient): the FULL six-field
  // shape — 8 ranks each summing to 8 squares of valid pieces, exactly one king
  // per side, a legal side to move, castling and en-passant fields, and numeric
  // halfmove/fullmove counters (else parseFen yields NaN counters that would
  // disable the fifty-move rule).
  function validFen(fen) {
    const parts = String(fen).trim().split(/\s+/);
    if (parts.length !== 6) return false;
    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    let wk = 0, bk = 0;
    for (const row of rows) {
      let count = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) count += Number(ch);
        else if (/[prnbqkPRNBQK]/.test(ch)) { count += 1; if (ch === 'K') wk++; if (ch === 'k') bk++; }
        else return false;
      }
      if (count !== 8) return false;
    }
    if (wk !== 1 || bk !== 1) return false;
    if (parts[1] !== 'w' && parts[1] !== 'b') return false;
    if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === '') return false;
    if (!/^(-|[a-h][36])$/.test(parts[3])) return false;
    if (!/^\d+$/.test(parts[4])) return false;      // halfmove clock
    if (!/^[1-9]\d*$/.test(parts[5])) return false; // fullmove number (>= 1)
    return true;
  }

  // Played timestamp (ms) from UTCDate/Date (+ optional UTCTime), or null. The
  // calendar fields are round-tripped: Date.parse silently rolls impossible
  // dates over (2024.02.31 → Mar 2), so a parsed value whose UTC components do
  // not match the declared date is rejected rather than recorded as a
  // different day.
  function tagDate(tags) {
    if (!tags) return null;
    const d = tags.UTCDate || tags.Date;
    if (!d || !/^\d{4}\.\d{2}\.\d{2}$/.test(d)) return null;
    const t = tags.UTCTime && /^\d{2}:\d{2}:\d{2}$/.test(tags.UTCTime) ? tags.UTCTime : '00:00:00';
    const ms = Date.parse(d.replace(/\./g, '-') + 'T' + t + 'Z');
    if (isNaN(ms)) return null;
    const back = new Date(ms), ymd = d.split('.').map(Number);
    if (back.getUTCFullYear() !== ymd[0] || back.getUTCMonth() + 1 !== ymd[1] ||
        back.getUTCDate() !== ymd[2]) return null;
    return ms;
  }

  // Parse and VALIDATE the first game in `text`. Returns
  //   { valid, error, tags, setupFen, result, reason, moves:[{san,uci,from,
  //     to,promotion,nags,comment,clkMs}], plies }
  // A single illegal/unknown move makes valid:false with error and the ply.
  function parseGame(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { valid: false, error: 'empty PGN', moves: [] };
    }
    // Tags come from THIS game's leading tag block ONLY — never a scan of the
    // whole input, or a later game's [White]/[Result]/… in a multi-game PGN
    // would overwrite the first game's tags even though move parsing stops at
    // its result. Movetext is everything after that block (a %clk/eval comment
    // can contain a ']', so the block is matched structurally, not by lastIndexOf).
    const headerMatch = text.match(/^\s*(?:\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*)+/);
    const header = headerMatch ? headerMatch[0] : '';
    const tags = parseTags(header);
    const body = text.slice(header.length);
    const setup = tags.SetUp === '1' && tags.FEN ? tags.FEN : (tags.FEN || null);
    if (setup && !validFen(setup)) {
      return { valid: false, error: 'invalid SetUp/FEN tag', tags: tags, moves: [] };
    }
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
      // A game cannot continue past its ending: reject any move played from an
      // already-terminal position (checkmate/stalemate, fifty-move, threefold,
      // or an insufficient-material SetUp/FEN).
      if (Chess.gameStatus(s).over) {
        return { valid: false, error: 'move "' + raw.san + '" played after the game ended',
          ply: k + 1, tags: tags, setupFen: setup, moves: [] };
      }
      const legal = Chess.legalMoves(s);
      const want = canon(raw.san);
      // Exact canonical match first; fall back to a relaxed unique match so
      // valid-but-alternately-spelled SAN (redundant disambiguation,
      // long-algebraic, short pawn captures, lowercase promotion) still
      // imports. Both draw ONLY from `legal`, so neither accepts an illegal move.
      const hit = legal.find(function (m) { return canon(Chess.toSan(s, m, legal)) === want; })
        || looseFind(legal, raw.san);
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
    const status = Chess.gameStatus(s);
    let result;
    if (status.over) {
      // At a TERMINAL position the rules determine the result. EVERY declared
      // decisive result — the movetext token AND the Result tag, independently —
      // must agree with it; either contradicting (e.g. Fool's Mate …Qh4#
      // labelled 1-0) is a corrupt game, rejected rather than stored mislabelled.
      const declarations = [parsed.result, tags.Result].filter(function (r) {
        return RESULTS[r] && r !== '*';
      });
      for (const d of declarations) {
        if (d !== status.result) {
          return { valid: false, tags: tags, setupFen: setup, moves: [],
            error: 'declared result ' + d + ' contradicts the terminal position (' +
              status.result + ')' };
        }
      }
      result = status.result;
    } else {
      // Non-terminal: the movetext token and the Result tag describe the same
      // outcome. Two DECISIVE declarations that disagree are a corrupt result
      // (reject); otherwise prefer whichever is decisive (a bare * defers to a
      // decisive tag), and only a valid PGN result is ever stored.
      const md = RESULTS[parsed.result] && parsed.result !== '*' ? parsed.result : null;
      const td = RESULTS[tags.Result] && tags.Result !== '*' ? tags.Result : null;
      if (md && td && md !== td) {
        return { valid: false, tags: tags, setupFen: setup, moves: [],
          error: 'movetext result ' + md + ' conflicts with the Result tag ' + td };
      }
      result = md || td || '*';
    }
    return {
      valid: true, error: null, tags: tags, setupFen: setup,
      result: result, reason: status.over ? status.reason : 'imported',
      preComment: parsed.pre || null,
      moves: moves, plies: moves.length
    };
  }

  // Build an archive-ready record from a validated game. opts:
  //   playerColor ('w'|'b'|null), externalId, timeControl, importedAt, playedAt.
  function toRecord(game, opts) {
    opts = opts || {};
    const uciList = game.moves.map(function (m) { return m.uci; });
    const hash = contentHash(game.setupFen, uciList, game.result, game.tags);
    const externalId = opts.externalId || null;
    const importedAt = opts.importedAt != null ? opts.importedAt : null;
    const playedAt = opts.playedAt != null ? opts.playedAt : tagDate(game.tags);
    return {
      id: externalId || hash,
      source: 'import',
      externalId: externalId,
      contentHash: hash,
      tags: game.tags || {},
      setupFen: game.setupFen || null,
      // A comment before the first move (game annotation) is preserved too.
      preComment: game.preComment || undefined,
      sans: game.moves.map(function (m) { return m.san; }),
      // Canonical moves alongside display SAN, with annotations preserved.
      moves: game.moves.map(function (m) {
        return { san: m.san, uci: m.uci, from: m.from, to: m.to, promotion: m.promotion,
          nags: m.nags && m.nags.length ? m.nags : undefined,
          comment: m.comment || undefined };
      }),
      playerColor: opts.playerColor != null ? opts.playerColor : null,
      clocks: game.moves.map(function (m) { return m.clkMs != null ? { ms: m.clkMs } : null; }),
      result: game.result,
      reason: game.reason,
      mode: 'import',
      difficulty: null,
      timeControl: opts.timeControl || (game.tags && game.tags.TimeControl) || 'unknown',
      plies: game.plies,
      // Meaningful epoch-ms timestamps: when the game was played (from tags)
      // and when it was imported; createdAt (list order) prefers import time,
      // then the played date, and finally NOW — never 0, so an imported game
      // can never sort to the epoch. The import boundary should still pass an
      // explicit importedAt; this is the last-resort floor.
      playedAt: playedAt,
      importedAt: importedAt,
      createdAt: opts.createdAt != null ? opts.createdAt
        : (importedAt != null ? importedAt : (playedAt != null ? playedAt : Date.now()))
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
