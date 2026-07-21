/*
 * Node-budget calibration for the self-play match — run with:
 *   node test/ai-lmr-calib.js [--budgets 5000,10000,20000,40000,80000]
 *                             [--openings 8] [--plies 40] [--target 40]
 *
 * Score-blind: it plays the candidate against ITSELF over a spread of frozen
 * openings and records, per node budget, the completed-depth distribution of
 * the returned moves plus the wall time per move. LMR only affects the returned
 * move when the last completed iteration reached depth >= 5 (reductions fire at
 * searchNode depth >= 4, and a completed depth-d iteration's top node is at
 * d-1). So the calibration metric is the fraction of moves at completed
 * depth >= 5; it recommends the SMALLEST budget clearing --target% and prints a
 * projected 200-game shard time so the 5-hour workflow cap can be respected
 * (shard by opening range if a budget's projection exceeds it).
 *
 * No game result is reported — this run is explicitly non-evidentiary.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const Chess = globalThis.Chess;
const ChessAI = globalThis.ChessAI;

const args = process.argv.slice(2);
function opt(name, dflt) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; }
const BUDGETS = opt('budgets', '5000,10000,20000,40000,80000').split(',').map(Number);
const N_OPEN = Number(opt('openings', 8));
const MAX_PLIES = Number(opt('plies', 40));
// % of returned moves that must come from a depth >= 5 (LMR-capable) search.
// A strict majority is not reachable under the 5-hour shard cap for this
// engine (the node cost of depth 5-6 is high); ~40% is a defensible "material"
// bar — LMR then shapes a large minority of moves while a 200-game shard still
// fits the timeout. Override with --target for a stricter/looser calibration.
const TARGET = Number(opt('target', 40));

// A spread of eight structurally different openings from the frozen list.
const SAMPLE = [
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6',        // Ruy Lopez (open)
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', // Najdorf (semi-open)
  'e4 e6 d4 d5 Nc3 Bb4',                  // French Winawer (closed centre)
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6',          // KID (closed)
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6',          // Semi-Slav
  'd4 Nf6 c4 e6 g3 d5 Bg2',              // Catalan
  'c4 c5 Nc3 Nc6 g3 g6',                 // English symmetrical (flank)
  'd4 f5 g3 Nf6 Bg2 g6'                  // Dutch Leningrad
].slice(0, N_OPEN);

function openingState(sans) {
  const strip = function (s) { return s.replace(/[+#]$/, ''); };
  let state = Chess.newGameState();
  for (const san of sans.split(' ')) {
    const legal = Chess.legalMoves(state);
    const m = legal.find(function (x) { return strip(Chess.toSan(state, x, legal)) === strip(san); });
    state = Chess.playMove(state, m);
  }
  return state;
}

console.log('candidate self-play calibration — ' + SAMPLE.length + ' openings x ' + MAX_PLIES +
  ' plies, quiescence on, deterministic\n');
console.log('budget    moves   d>=5%   median   avg ms/move   ~200-game shard');
let recommended = null;
for (const NODES of BUDGETS) {
  const hist = {};
  let moves = 0, ge5 = 0, totMs = 0, plyTotal = 0;
  for (const sans of SAMPLE) {
    let state = openingState(sans);
    let plies = 0;
    while (plies < MAX_PLIES && !Chess.gameStatus(state).over) {
      const t0 = Date.now();
      const r = ChessAI.think(Chess.parseFen(Chess.toFen(state)),
        { maxDepth: 30, nodeLimit: NODES, quiesce: true, randomize: false, positions: state.positions });
      totMs += Date.now() - t0;
      const dp = r.depth || 0;
      hist[dp] = (hist[dp] || 0) + 1; moves++; if (dp >= 5) ge5++;
      const legal = Chess.legalMoves(state);
      const local = legal.find(function (m) { return r.move && m.from === r.move.from && m.to === r.move.to && m.promotion === r.move.promotion; });
      if (!local) break;
      state = Chess.playMove(state, local); plies++;
    }
    plyTotal += plies;
  }
  const ge5pct = 100 * ge5 / moves;
  const depths = Object.keys(hist).map(Number).sort(function (a, b) { return a - b; });
  let cum = 0, median = 0; for (const dd of depths) { cum += hist[dd]; if (cum >= moves / 2) { median = dd; break; } }
  const msPerMove = totMs / moves;
  const avgPlies = plyTotal / SAMPLE.length;
  // A 200-game shard = 100 openings x 1 seed x 2 colors; both engines think
  // every ply, so ~ games * avgPlies * msPerMove.
  const shardMs = 200 * avgPlies * msPerMove;
  const shardHrs = shardMs / 3.6e6;
  console.log(
    String(NODES).padStart(6) + '   ' +
    String(moves).padStart(5) + '   ' +
    (ge5pct.toFixed(1) + '%').padStart(6) + '   ' +
    String(median).padStart(6) + '   ' +
    msPerMove.toFixed(1).padStart(11) + '   ' +
    (shardHrs < 1 ? (shardHrs * 60).toFixed(0) + ' min' : shardHrs.toFixed(1) + ' h').padStart(9) +
    (ge5pct >= TARGET ? '   <= target' : ''));
  if (recommended === null && ge5pct >= TARGET) recommended = { NODES: NODES, ge5pct: ge5pct, shardHrs: shardHrs };
}
console.log('\ntarget: >= ' + TARGET + '% of returned moves from a depth >= 5 (LMR-capable) search');
if (recommended) {
  console.log('RECOMMENDED budget: ' + recommended.NODES + ' nodes/move (' +
    recommended.ge5pct.toFixed(1) + '% depth>=5, ~' +
    (recommended.shardHrs < 1 ? (recommended.shardHrs * 60).toFixed(0) + ' min' : recommended.shardHrs.toFixed(1) + ' h') +
    ' per 200-game shard)');
  if (recommended.shardHrs > 5) {
    console.log('NOTE: a 200-game shard exceeds the 5-hour cap — split by opening range ' +
      '(--openbase/--opencount), e.g. 4 opening-slices x 4 seed-shards.');
  }
} else {
  console.log('RECOMMENDED budget: none of the swept budgets reached ' + TARGET + '% — raise the sweep.');
}
