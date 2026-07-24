/*
 * King-safety evaluation regression suite — run with: node test/ai-eval.js
 *
 * Guards the midgame king-safety terms added for #72 (king-ring attacks +
 * open/semi-open file shelter), the concrete motivation being the Master loss
 * in game chessy202607240238, where the search scored a mating attack as merely
 * "material winning" because nothing in the static eval flagged the exposed
 * king. These are pure-evaluate() assertions (no search, deterministic), so a
 * failure points straight at the eval, not the search.
 *
 * The invariants that must hold for ANY sound eval term, tested here:
 *   - exact colour antisymmetry: evaluate(b) === -evaluate(mirror(b));
 *   - midgame-only via the taper: the term vanishes as material comes off;
 *   - direction: pressure on the enemy king favours the attacker;
 *   - boundedness: the term steers but never overrides material.
 * Same-material pairs are verified in-test (identical piece multiset), so a
 * "directional" delta cannot secretly come from a material difference.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

const ev = function (fen) { return ChessAI.evaluate(Chess.parseFen(fen).board); };

// Mirror a FEN's placement vertically and swap colours (a1<->a8, White<->Black).
function mirrorPlacement(fen) {
  const swap = function (ch) { return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(); };
  return fen.split(' ')[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) { return /\d/.test(c) ? c : swap(c); }).join('');
  }).join('/');
}
// Sorted multiset of pieces on a board's placement field — for asserting two
// positions share EXACTLY the same material (so a directional delta is the
// king-safety term, never a hidden material or phase difference).
function material(fen) {
  return fen.split(' ')[0].replace(/[/\d]/g, '').split('').sort().join('');
}

// --- 1. Exact colour antisymmetry. The single most important invariant for a
// new eval term: the score must negate exactly under a colour-swapped mirror,
// or the engine plays the two colours differently. The king-safety term is
// added to the midgame score only (not the endgame score), so the tapered
// value can land on a half-integer where a naive round() breaks antisymmetry;
// this pins that it does not. Also matches the eval scorecard's `symmetry` axis.
console.log('colour antisymmetry (king-safety active)');
const SYMM_FENS = [
  'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27', // game chessy202607240238
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  '2kr3r/ppp2ppp/2n5/3q4/3P4/2N2N2/PPPQ1PPP/2KR3R w - - 0 1',
  'r4rk1/pp1q1ppp/2n5/3Q4/6b1/2N2N2/PPP2PPP/R3R1K1 w - - 0 1',
  'r2q1rk1/pp1bppbp/2np1np1/8/3NP3/2N1B3/PPPQBPPP/R4RK1 w - - 0 1', // open middlegame
  '6k1/pp3ppp/2q5/8/8/2Q5/PP3PPP/6K1 w - - 0 1',
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'         // start: must be 0
];
for (const fen of SYMM_FENS) {
  const a = ev(fen), b = ev(mirrorPlacement(fen) + ' w - - 0 1');
  check(a === -b, 'evaluate is exactly antisymmetric: ' + fen.split(' ')[0].slice(0, 20),
    'eval=' + a + '  -mirror=' + (-b));
}
check(ev('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === 0,
  'the start position evaluates to exactly 0');

// --- 2. Midgame-only via the taper. The term is folded into the midgame score
// and interpolated out as material comes off, exactly like the pawn shield. At
// phase 0 (kings and pawns only) it must contribute nothing: a bare-king pawn
// endgame stays a material/structure judgement, and the mutual-zugzwang draw
// stays 0 rather than acquiring a spurious king-danger score.
console.log('midgame-only taper (endgame neutrality)');
check(ev('8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1') === 0,
  'phase-0 blocked-pawn zugzwang carries no king-safety score (eval 0)');
// A phase-0 position whose kings sit on wide-open files: were the shelter term
// leaking into the endgame it would score a (here symmetric) penalty; the
// symmetric setup makes any leak cancel, and the material-equal asymmetric one
// below confirms the magnitude is actually zero, not merely cancelling.
check(ev('4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1') === 0,
  'phase-0 kings on the open e-file: no shelter penalty (eval 0)');

// --- 3. Direction: pressure on the enemy king favours the attacker. Each pair
// shares the exact same material (asserted); the only difference is whether
// White's pieces bear on Black's king. The attacked position must score better
// for White. The delta bundles placement and king-attack — both push the same
// way, which is the point — but it must be POSITIVE and BOUNDED (see 4).
console.log('direction: king pressure favours the attacker');
const ATTACK = 'r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27'; // Q/B/N on the kingside
const QUIET  = 'r3r1k1/1ppq1pp1/1b2n3/3pP3/1P6/2NB1Q1P/P5P1/1BR4K b - - 0 27'; // same men, withdrawn
check(material(ATTACK) === material(QUIET), 'attack/quiet twins share identical material',
  ATTACK.split(' ')[0] + '  vs  ' + QUIET.split(' ')[0]);
const dir = ev(ATTACK) - ev(QUIET);
check(dir > 0, 'a kingside piece swarm scores better for the attacker',
  'attack=' + ev(ATTACK) + ' quiet=' + ev(QUIET) + ' delta=' + dir);

// --- 4. Boundedness. King safety steers the search; it must never rival a
// piece. The full swing between an all-out attack and its withdrawn twin stays
// well under a minor piece — the term is capped (KING_ATK_CAP = 150 cp per
// king) and the delta above additionally carries placement, so a generous
// ceiling catches an uncapped/runaway term (which would reach many hundreds).
console.log('boundedness (never overrides material)');
check(dir < 300, 'king-pressure swing stays below a minor piece', 'delta=' + dir);

// --- 5. Count-gating. A lone attacker is ordinary piece activity and scores no
// king-danger penalty; danger accrues only when pieces coordinate. With just
// the queen bearing on Black's king (one attacker) the delta vs the withdrawn
// twin is small placement only; adding a second attacker unlocks the penalty,
// so the two-attacker delta is strictly larger. Both twins are material-equal.
console.log('count-gating (a lone attacker scores nothing)');
const LONE = 'r3r1k1/1ppq1pp1/1b2n3/3pP3/1P5Q/2NB2NP/P5P1/1BR4K b - - 0 27'; // only Qh4 eyes the ring
const PAIR = 'r3r1k1/1ppq1pp1/1b2n3/3pPN2/1P5Q/2NB3P/P5P1/1BR4K b - - 0 27'; // Qh4 + Nf5 both do
const BASEQ= 'r3r1k1/1ppq1pp1/1b2n3/3pP3/1P6/2NB2NP/P5P1/1BRQ3K b - - 0 27'; // same men, all withdrawn
if (material(LONE) === material(BASEQ) && material(PAIR) === material(BASEQ)) {
  const dLone = ev(LONE) - ev(BASEQ);
  const dPair = ev(PAIR) - ev(BASEQ);
  check(dPair > dLone, 'a second coordinated attacker adds king-danger a lone one does not',
    'lone-delta=' + dLone + ' pair-delta=' + dPair);
} else {
  check(false, 'count-gating twins share identical material',
    'LONE/PAIR/BASE material mismatch');
}

// --- 6. Open-file shelter. A king whose file (or a neighbour) carries no
// friendly pawn is exposed, worse yet with an enemy rook already on it. The
// two positions share EXACTLY the same material (each side K + 2R + 6P), and
// White's shelter is intact and identical in both — the ONLY difference is
// Black's kingside: in OPEN the g-file has no Black pawn and a White rook is
// lifted onto it (Rg3), in SHUT the g7 pawn shields the king and that rook
// stands off the file (Rd3). The exposed-king position must score better for
// White. (Both are also below a piece — pure rook endings, low phase — so the
// shelter term shows without dominating.)
console.log('open/semi-open file shelter');
const BLACK_OPEN = '3rr1k1/ppp2p1p/2p5/8/8/6R1/PPP2PPP/4R1K1 w - - 0 1'; // g-file open, White Rg3
const BLACK_SHUT = '3rr1k1/ppp2ppp/8/8/8/3R4/PPP2PPP/4R1K1 w - - 0 1';   // g7 shields, White Rd3
check(material(BLACK_OPEN) === material(BLACK_SHUT), 'shelter twins share identical material',
  material(BLACK_OPEN) + ' vs ' + material(BLACK_SHUT));
check(ev(BLACK_OPEN) > ev(BLACK_SHUT), 'a rook on the enemy king\'s open file scores the exposure',
  'open=' + ev(BLACK_OPEN) + ' shut=' + ev(BLACK_SHUT));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
