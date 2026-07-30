#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./hce-r3-features');
const Baseline = require('./hce-r3-baseline');

const MANIFEST_PATH = path.join(
  __dirname, '..', '..', 'eval', 'training', 'hce-r3-features-v1.json'
);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const fit = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'eval', 'training', 'hce-r3-fit-v1.json'
), 'utf8'));

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function expectThrow(label, pattern, callback) {
  try {
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    check(pattern.test(String(error && error.message || error)), label,
      String(error && error.message || error));
  }
}

function digestNames() {
  const text = H.FEATURES.map(function (feature) {
    return feature.id + ':' + feature.name;
  }).join('\n') + '\n';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function digestParameterOrder() {
  const text = H.PARAMETER_NAMES.map(function (name, index) {
    return index + ':' + name;
  }).join('\n') + '\n';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function colorRankSwapFen(fen) {
  const board = H.parseFenBoard(fen);
  const transformed = new Array(64);
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    const target = square ^ 56;
    transformed[target] = !piece ? null :
      (piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase());
  }
  return boardToFen(transformed);
}

function fileMirrorFen(fen) {
  const board = H.parseFenBoard(fen);
  const transformed = new Array(64);
  for (let square = 0; square < 64; square++) {
    transformed[(square & 56) | (7 - (square & 7))] = board[square];
  }
  return boardToFen(transformed);
}

function boardToFen(board) {
  const ranks = [];
  for (let rank = 0; rank < 8; rank++) {
    let encoded = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (!piece) {
        empty++;
      } else {
        if (empty) encoded += String(empty);
        empty = 0;
        encoded += piece;
      }
    }
    if (empty) encoded += String(empty);
    ranks.push(encoded);
  }
  return ranks.join('/') + ' w - -';
}

function mirrorSquareName(name) {
  const file = name.charCodeAt(0) - 97;
  return String.fromCharCode(104 - file) + name[1];
}

function fileMirrorFeatureName(name) {
  if (!name.startsWith('king_bucket_pawn_pst.')) return name;
  const fields = name.split('.');
  fields[1] = fields[1] === 'q' ? 'k' : 'q';
  fields[3] = mirrorSquareName(fields[3]);
  return fields.join('.');
}

function allDenseEqual(left, right, transform) {
  for (const feature of H.FEATURES) {
    const other = H.feature(transform ? transform(feature.name) : feature.name);
    if (left[feature.offset] !== right[other.offset]) return false;
  }
  return true;
}

// ---- Frozen layout and manifest parity -----------------------------------
check(H.BASELINE_PARAMETER_COUNT === 753 &&
    H.NEW_PARAMETER_COUNT === 212 &&
    H.TOTAL_PARAMETER_COUNT === 965 &&
    H.FIRST_FEATURE_ID === 753 &&
    H.LAST_FEATURE_ID === 964,
  'parameter counts freeze the reusable 753 + new 212 = total 965 layout');

check(fit.solver.dependency.numpy === '2.3.5' &&
    fit.solver.dependency.scipy === '1.17.0',
  'convex solver freezes exact NumPy and SciPy patch versions');

check(H.FEATURES.length === 212 &&
    H.FEATURES.every(function (feature, offset) {
      return feature.id === 753 + offset && feature.offset === offset;
    }),
  'feature IDs are contiguous and stable from 753 through 964');

check(new Set(H.FEATURES.map(f => f.name)).size === 212 &&
    H.FEATURES.every(function (feature) {
      return feature.defaultWeight === 0 &&
        feature.regularizationCenter === 0 &&
        feature.scoreDenominator === 24 &&
        feature.orientation === 'white-pov';
    }),
  'all feature names are unique and all new weights default/regularize to zero');

const familyCounts = H.FEATURES.reduce(function (counts, feature) {
  counts[feature.family] = (counts[feature.family] || 0) + 1;
  return counts;
}, {});
check(familyCounts['pawn-attacks-enemy-piece'] === 6 &&
    familyCounts['safe-mobility'] === 8 &&
    familyCounts['advanced-pawn-cramp'] === 6 &&
    familyCounts['king-bucketed-pawn-pst'] === 192,
  'family counts are exactly 6 + 8 + 6 + 192');

const pstFeatures = H.FEATURES.filter(function (feature) {
  return feature.family === 'king-bucketed-pawn-pst';
});
check(H.REACHABLE_PAWN_SQUARES.length === 48 &&
    H.REACHABLE_PAWN_SQUARES[0] === 8 &&
    H.REACHABLE_PAWN_SQUARES[47] === 55 &&
    pstFeatures.every(function (feature) {
      return feature.square >= 8 && feature.square <= 55;
    }),
  'pawn PST contains only the 48 identifiable relative squares on ranks 2..7');

check(manifest.parameterCounts.baseline === H.BASELINE_PARAMETER_COUNT &&
    manifest.parameterCounts.new === H.NEW_PARAMETER_COUNT &&
    manifest.parameterCounts.total === H.TOTAL_PARAMETER_COUNT &&
    manifest.parameterCounts.lastNewParameterId === H.LAST_FEATURE_ID &&
    manifest.families.map(family => family.count).join(',') === '6,8,6,192',
  'machine-readable manifest agrees with the executable contract');

check(digestNames() === manifest.expandedFeatureNameDigest,
  'expanded feature ID/name digest is frozen',
  digestNames());

check(H.PARAMETER_NAMES.length === 965 &&
    H.PARAMETER_NAMES[0] === 'baseline.aux.mobN' &&
    H.PARAMETER_NAMES[752] === 'baseline.pst.eg.K.h1' &&
    H.PARAMETER_NAMES[753] === 'r3.pawn_attack_enemy_minor.mg' &&
    digestParameterOrder() === manifest.parameterOrder.sha256,
  'complete 965-column matrix order and digest are frozen',
  digestParameterOrder());

const baselineCenter = Baseline.baselineCenter();
const regularizationScales = Baseline.regularizationScales();
check(Baseline.valueDigest(baselineCenter) ===
      'da684745c074a1b750b91fbe3f3f148c64ee3398d4378362c1755f06e6e74a01' &&
    Baseline.valueDigest(regularizationScales) ===
      '831736b11974f53849afcde65731d29633d2aee1b7d4d203d81520a7518c8eb4' &&
    baselineCenter.slice(753).every(value => value === 0),
  'r69 Round-2 center, zero-new centers, and regularization scales are frozen');

check(manifest.families.find(family => family.id === 'safe-mobility').role ===
    'supporting-evidence' &&
    H.FEATURES.filter(feature => feature.family === 'safe-mobility')
      .every(feature => feature.role === 'supporting-evidence'),
  'safe mobility is explicitly supporting evidence only');

// ---- Board-only and input validity ---------------------------------------
const stateA =
  '4k3/8/3r4/4P3/8/2N5/7P/2K5 w KQ e6 17 42';
const stateB =
  '4k3/8/3r4/4P3/8/2N5/7P/2K5 b - - 0 1';
check(allDenseEqual(H.extract(stateA), H.extract(stateB)),
  'side, castling, en-passant and clocks cannot change board-only features');

const chessyBoard = H.parseFenBoard(stateA).map(function (piece) {
  if (!piece) return null;
  return (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase();
});
check(allDenseEqual(H.extract(stateA), H.extract(chessyBoard)),
  'FEN pieces and Chessy wP/bP board pieces extract identically');

expectThrow('missing king is rejected', /one king of each color/, function () {
  H.extract('8/8/8/8/8/8/8/4K3 w - -');
});
expectThrow('unreachable pawn PST rank is rejected', /first\/eighth ranks/, function () {
  H.extract('P3k3/8/8/8/8/8/8/4K3 w - -');
});

// ---- Taper, direct e4 interaction, safe mobility, and cramp --------------
const start = H.extractWithMeta(
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
);
check(start.phase === 24 && start.mgScale === 24 && start.egScale === 0 &&
    start.dense.every(value => value === 0),
  'symmetric initial board has full MG phase and a zero signed feature vector');

// Critical child after ...e5-e4: the black pawn on e4 attacks the white Nf3.
const e4Attack = H.extractWithMeta(
  'r4rk1/ppp2ppp/2n5/2b2b2/4p3/1P1P1N2/q1PBBPPP/1R1Q1RK1 w - -'
);
check(H.valueByName(e4Attack, 'pawn_attack_enemy_minor.mg') ===
      -e4Attack.mgScale &&
    H.valueByName(e4Attack, 'pawn_attack_enemy_minor.eg') ===
      -e4Attack.egScale,
  'e4-like pawn attack on Nf3 activates the signed tapered minor terms',
  JSON.stringify(e4Attack.sparse));

// A black e4 pawn removes d3/f3 from a white Ne1's four pseudo destinations.
const e4Restriction = H.extractWithMeta(
  '4k3/8/8/8/4p3/8/8/4N1K1 w - -'
);
check(e4Restriction.phase === 1 &&
    H.valueByName(e4Restriction, 'safe_mobility.knight.mg') === 2 &&
    H.valueByName(e4Restriction, 'safe_mobility.knight.eg') === 46 &&
    H.valueByName(e4Restriction, 'advanced_pawn_cramp.r5.mg') === -2 &&
    H.valueByName(e4Restriction, 'advanced_pawn_cramp.r5.eg') === -46,
  'e4-like restriction activates safe-mobility support and black r5 cramp',
  JSON.stringify(e4Restriction.sparse));

const noRestriction = H.extractWithMeta(
  '4k3/8/8/8/8/8/8/4N1K1 w - -'
);
check(H.valueByName(noRestriction, 'safe_mobility.knight.mg') === 4 &&
    H.valueByName(noRestriction, 'safe_mobility.knight.eg') === 92,
  'removing e4 restores all four Ne1 pseudo-mobility edges');

// King on h2 selects the K bucket; queens create a nontrivial 8/16 taper.
const bucketedPst = H.extractWithMeta(
  '3q2k1/8/8/8/8/8/P6K/3Q4 w - -'
);
check(bucketedPst.phase === 8 &&
    H.valueByName(bucketedPst, 'king_bucket_pawn_pst.k.mg.a2') === 8 &&
    H.valueByName(bucketedPst, 'king_bucket_pawn_pst.k.eg.a2') === 16,
  'own kingside king activates both tapered pawn-PST delta stages');

const centerPst = H.extractWithMeta(
  '3q2k1/8/8/8/8/8/P7/3QK3 w - -'
);
check(centerPst.sparse.every(function (entry) {
  return !entry.name.startsWith('king_bucket_pawn_pst.');
}), 'center king bucket is the omitted identifiability reference');

// ---- Symmetry witnesses --------------------------------------------------
const asymmetric =
  '2b3k1/5pp1/3r4/2P1p3/4P3/1N3Q2/P5P1/1K6 w - -';
const original = H.extract(asymmetric);
const colorSwapped = H.extract(colorRankSwapFen(asymmetric));
check(original.every(function (value, offset) {
  return colorSwapped[offset] === -value;
}), 'color swap plus rank reflection negates every White-POV coefficient');

const fileMirrored = H.extract(fileMirrorFen(asymmetric));
check(allDenseEqual(original, fileMirrored, fileMirrorFeatureName),
  'file reflection preserves scalar families and maps Q/K pawn-PST slots');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
