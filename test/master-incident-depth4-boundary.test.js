/*
 * Deterministic depth-4 decision-boundary regression for the exact Master
 * screenshot incident. The 58,000-node boundary is above the 57,371 nodes
 * needed to finish depth 4 in the worst canonical/mirrored/root-order case on
 * this candidate, while staying close enough to catch search-cost drift.
 *
 * This is deliberately NOT a portable mapping to a five-second production
 * search: wall-clock throughput varies by runtime, device, load and JIT state.
 */
'use strict';
require('../assets/engine.js');
require('../assets/ai.js');
const incident = require('./fixtures/master-incident-20260724.json');

const NODE_BOUNDARY = 58000;
const SEEDS = [0, 1, 0xC0FFEE];
let passed = 0, failed = 0;

function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}
function uci(move) {
  return move ? Chess.sqName(move.from) + Chess.sqName(move.to) +
    (move.promotion ? move.promotion.toLowerCase() : '') : '-';
}
function mirrorFen(fen) {
  const p = fen.split(' ');
  const swap = function (ch) {
    return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  };
  p[0] = p[0].split('/').reverse().map(function (rank) {
    return rank.split('').map(function (c) {
      return /\d/.test(c) ? c : swap(c);
    }).join('');
  }).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  if (p[2] !== '-') p[2] = p[2].split('').map(swap).sort().join('');
  if (p[3] !== '-') p[3] = p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}
function mirrorMove(move) {
  return move[0] + (9 - Number(move[1])) +
    move[2] + (9 - Number(move[3])) + move.slice(4);
}

check(incident.id === 'dd608f7d-4a6d-416a-a773-0c7515e14898' &&
    incident.difficulty === 'master',
  'tail gate is pinned to the exact Master screenshot game');

const critical = new Map(incident.critical.map(function (c) {
  return [c.ply, c];
}));
console.log('incident moves 19 and 24 at the 58k depth-4 decision boundary');
for (const ply of [37, 47]) {
  const marker = critical.get(ply);
  const report = incident.oracle.positions.find(function (p) {
    return p.ply === ply;
  });
  check(!!marker && !!report,
    'fixture carries critical position and oracle label at ply ' + ply);
  if (!marker || !report) continue;

  for (const flip of [false, true]) {
    const fen = flip ? mirrorFen(marker.fen) : marker.fen;
    const allowed = report.admitted.map(function (m) {
      return flip ? mirrorMove(m.uci) : m.uci;
    });
    const avoided = flip ? mirrorMove(report.playedUci) : report.playedUci;
    const rootOrders = new Set();

    for (const seed of SEEDS) {
      const r = ChessAI.think(Chess.parseFen(fen), {
        maxDepth: 30, nodeLimit: NODE_BOUNDARY, quiesce: true, seed: seed
      });
      const move = uci(r.move);
      const label = 'ply ' + ply + (flip ? ' mirror' : '') + ' seed ' + seed;
      rootOrders.add(r.rootOrderUci.join(' '));
      check(r.nodes === NODE_BOUNDARY && r.stopReason === 'node-limit' &&
          r.depth >= 4 && r.attemptedDepth === r.depth + 1,
        label + ' completes the guarded draft within the decision boundary',
        JSON.stringify({
          nodes: r.nodes, depth: r.depth,
          attemptedDepth: r.attemptedDepth, stopReason: r.stopReason
        }));
      check(allowed.includes(move) && move !== avoided,
        label + ' returns an oracle-admitted defence',
        'got ' + move + '; allowed ' + allowed.join(', '));
    }
    check(rootOrders.size === SEEDS.length,
      'ply ' + ply + (flip ? ' mirror' : '') +
        ' exercises three distinct initial root orders',
      'distinct orders ' + rootOrders.size);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
