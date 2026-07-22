/*
 * PGN import parser/validator (roadmap #23, Phase 4) — run with:
 *   node test/pgn.test.js
 * Storage dedupe (CoachStore.importGame) is covered in the browser suite
 * test/browser/import.test.js.
 */
'use strict';
require('../assets/engine.js');
require('../assets/pgn.js');
const Chess = globalThis.Chess;
const PGN = globalThis.ChessyPGN;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

// --- A tagged game with comments, NAGs, %clk and a skipped variation ---
const pgn = [
  '[Event "Test"]',
  '[Site "?"]',
  '[White "Alice"]',
  '[Black "Bob"]',
  '[Result "1-0"]',
  '[TimeControl "180+2"]',
  '',
  '1. e4 { [%clk 0:03:00] a strong start } e5 $1 (1... c5 2. Nf3)',
  '2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O 1-0'
].join('\n');
const g = PGN.parseGame(pgn);
check(g.valid && g.error === null, 'a well-formed game validates', g.error);
check(g.tags.White === 'Alice' && g.tags.Result === '1-0' && g.tags.TimeControl === '180+2',
  'tag pairs are parsed');
check(g.moves.length === 9 && g.result === '1-0',
  'mainline plies parsed, variation skipped (9 plies)', String(g.moves.length));
check(g.moves[0].san === 'e4' && g.moves[0].uci === 'e2e4' &&
  g.moves[0].from === Chess.sqIndex('e2') && g.moves[0].to === Chess.sqIndex('e4'),
  'canonical UCI + from/to alongside display SAN');
check(g.moves[0].clkMs === 180000, 'the %clk annotation becomes the mover’s remaining ms');
check(g.moves[1].nags.indexOf('$1') !== -1, 'a NAG is attached to its move');
check(g.moves[6].san === 'Bxc6' && g.moves[8].san === 'O-O',
  'capture + castling SAN round-trip through the engine');

// --- Castling with zeros, promotion without "=", check glyphs all match ---
const alt = '[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]\n[SetUp "1"]\n\n1. a8Q+ Ke7 *';
const ag = PGN.parseGame(alt);
check(ag.valid && ag.setupFen === '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
  'SetUp/FEN starts from a custom position', ag.error);
check(ag.valid && ag.moves[0].san === 'a8=Q+' && ag.moves[0].promotion === 'Q',
  'promotion without "=" and with a check glyph is matched and normalised');

// --- An illegal move fails validation with the ply, and writes nothing ---
const bad = '[Result "*"]\n\n1. e4 e5 2. Ke2 Nf6 3. Kzz *';
const bg = PGN.parseGame(bad);
check(!bg.valid && /Kzz/.test(bg.error) && bg.ply === 5 && bg.moves.length === 0,
  'an illegal/unknown move invalidates the game (no partial moves)');

// A legal-looking but wrong move (Nf3 when the knight cannot reach) also fails.
const bad2 = '[Result "*"]\n\n1. e4 e5 2. Nf6 *';
check(!PGN.parseGame(bad2).valid, 'a move with no matching legal move is rejected');

// --- Content hash: stable, and identity-sensitive to moves/result/FEN ---
const h1 = PGN.contentHash(null, ['e2e4', 'e7e5'], '1-0');
const h1b = PGN.contentHash(null, ['e2e4', 'e7e5'], '1-0');
const h2 = PGN.contentHash(null, ['e2e4', 'e7e5'], '0-1');
const h3 = PGN.contentHash(null, ['d2d4', 'd7d5'], '1-0');
check(h1 === h1b && h1 !== h2 && h1 !== h3,
  'the content hash is stable and distinguishes moves/result');

// --- toRecord shape (archive-ready), dedupe id = externalId || hash ---
const rec = PGN.toRecord(g, { playerColor: 'w', externalId: 'lichess:abcd', importedAt: 100 });
check(rec.id === 'lichess:abcd' && rec.source === 'import' && rec.externalId === 'lichess:abcd' &&
  rec.contentHash && rec.plies === 9 && rec.playerColor === 'w' &&
  rec.sans.length === 9 && rec.moves.length === 9 && rec.moves[0].uci === 'e2e4',
  'toRecord is archive-ready with canonical moves and external id');
const rec2 = PGN.toRecord(g, { playerColor: 'b' });
check(rec2.id === rec.contentHash, 'without an external id the record id is the content hash');
check(rec.playerColor === 'w' && PGN.toRecord(g, {}).playerColor === null,
  'the player side is null when not supplied (caller resolves it)');
check(rec.clocks[0] && rec.clocks[0].ms === 180000 && rec.clocks[1] === null,
  'per-move clocks carry the parsed %clk, null where absent');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
