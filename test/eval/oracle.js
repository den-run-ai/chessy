/*
 * Independent legal-move oracle for the eval harness (E2 "differential
 * legality"). Uses chess.js — a SEPARATE rules implementation (BSD-2-Clause) —
 * as the tracker's sanctioned DEV-ONLY differential oracle, so a regression in
 * Chessy's own shared move-gen primitives cannot pass the legalRoot axis by
 * agreeing with itself.
 *
 * chess.js is optional: if it is not installed the oracle is unavailable and
 * the caller falls back to the self-consistency check (CI installs it so the
 * gate runs the strict version). Never a runtime dependency of the app.
 */
'use strict';

let ChessJS = null, loaded = false;
function load() {
  if (loaded) return ChessJS;
  loaded = true;
  try {
    const m = require('chess.js');
    ChessJS = m.Chess || m.default || m;
    if (typeof ChessJS !== 'function') ChessJS = null;
  } catch (e) { ChessJS = null; }
  return ChessJS;
}

function available() { return !!load(); }

// Sorted canonical UCI legal-move set for a FEN, per chess.js. Returns null if
// chess.js is unavailable or rejects the FEN (so the caller can degrade rather
// than fail spuriously on a position chess.js parses differently).
function legalUci(fen) {
  const C = load();
  if (!C) return null;
  try {
    const c = new C(fen);
    return c.moves({ verbose: true })
      .map(m => m.from + m.to + (m.promotion ? m.promotion.toLowerCase() : ''))
      .sort();
  } catch (e) { return null; }
}

module.exports = { available, legalUci };
