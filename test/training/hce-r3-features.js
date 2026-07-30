/*
 * Frozen, runtime-independent HCE Round-3 feature contract (#137).
 *
 * This module extracts only the 212 identifiable proposed interaction terms. It does not
 * import or modify the shipped evaluator, does not contain fitted weights, and
 * is not reachable from the browser application.
 *
 * Every returned coefficient is a White-POV tapered-score numerator:
 *
 *   score contribution =
 *     sum(feature coefficient * fitted integer weight) / PHASE_MAX
 *
 * MG coefficients are multiplied by the board's fixed material phase; EG
 * coefficients by PHASE_MAX - phase. Consequently the representation remains
 * exactly linear in every fitted weight.
 */
'use strict';

const BASELINE_PARAMETER_COUNT = 753;
const NEW_PARAMETER_COUNT = 212;
const TOTAL_PARAMETER_COUNT = BASELINE_PARAMETER_COUNT + NEW_PARAMETER_COUNT;
const FIRST_FEATURE_ID = BASELINE_PARAMETER_COUNT;
const LAST_FEATURE_ID = TOTAL_PARAMETER_COUNT - 1;
const PHASE_MAX = 24;
const BASELINE_AUX_ORDER = Object.freeze([
  'mobN', 'mobB', 'mobR', 'mobQ', 'doubled', 'isolated', 'shield',
  'pMg1', 'pMg2', 'pMg3', 'pMg4', 'pMg5',
  'pEg1', 'pEg2', 'pEg3', 'pEg4', 'pEg5'
]);
const BASELINE_PST_TYPES = Object.freeze(['P', 'N', 'B', 'R', 'Q', 'K']);

const PHASE_WEIGHT = Object.freeze({ N: 1, B: 1, R: 2, Q: 4 });
const PIECES = 'PNBRQKpnbrqk';
const STAGES = Object.freeze(['mg', 'eg']);
const ATTACK_CLASSES = Object.freeze(['minor', 'rook', 'queen']);
const MOBILITY_PIECES = Object.freeze(['knight', 'bishop', 'rook', 'queen']);
const MOBILITY_LETTER = Object.freeze({
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q'
});
const CRAMP_RANKS = Object.freeze([4, 5, 6]);
const KING_BUCKETS = Object.freeze(['q', 'k']);
const REACHABLE_PAWN_SQUARES = Object.freeze(
  Array.from({ length: 48 }, function (_, index) { return index + 8; })
);

const KNIGHT_JUMPS = Object.freeze([
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1]
]);
const DIAGONALS = Object.freeze([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
const ORTHOGONALS = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);

function squareName(square) {
  if (!Number.isInteger(square) || square < 0 || square >= 64) {
    throw new Error('square must be a Chessy index in [0, 63]');
  }
  return String.fromCharCode(97 + (square & 7)) + String(8 - (square >> 3));
}

function addFeature(features, family, name, metadata) {
  const id = FIRST_FEATURE_ID + features.length;
  features.push(Object.freeze(Object.assign({
    id,
    offset: id - FIRST_FEATURE_ID,
    family,
    name,
    defaultWeight: 0,
    regularizationCenter: 0,
    scoreDenominator: PHASE_MAX,
    orientation: 'white-pov'
  }, metadata)));
}

function buildFeatures() {
  const features = [];

  for (const pieceClass of ATTACK_CLASSES) {
    for (const stage of STAGES) {
      addFeature(
        features,
        'pawn-attacks-enemy-piece',
        'pawn_attack_enemy_' + pieceClass + '.' + stage,
        { pieceClass, stage }
      );
    }
  }

  for (const piece of MOBILITY_PIECES) {
    for (const stage of STAGES) {
      addFeature(
        features,
        'safe-mobility',
        'safe_mobility.' + piece + '.' + stage,
        { piece, stage, role: 'supporting-evidence' }
      );
    }
  }

  for (const relativeRank of CRAMP_RANKS) {
    for (const stage of STAGES) {
      addFeature(
        features,
        'advanced-pawn-cramp',
        'advanced_pawn_cramp.r' + relativeRank + '.' + stage,
        { relativeRank, stage }
      );
    }
  }

  for (const kingBucket of KING_BUCKETS) {
    for (const stage of STAGES) {
      for (const square of REACHABLE_PAWN_SQUARES) {
        addFeature(
          features,
          'king-bucketed-pawn-pst',
          'king_bucket_pawn_pst.' + kingBucket + '.' + stage + '.' +
            squareName(square),
          { kingBucket, stage, square, relativeSquare: squareName(square) }
        );
      }
    }
  }

  if (features.length !== NEW_PARAMETER_COUNT ||
      features[0].id !== FIRST_FEATURE_ID ||
      features[features.length - 1].id !== LAST_FEATURE_ID) {
    throw new Error('internal HCE R3 feature layout drift');
  }
  return Object.freeze(features);
}

const FEATURES = buildFeatures();
const FEATURE_BY_NAME = new Map(FEATURES.map(function (feature) {
  return [feature.name, feature];
}));
const FEATURE_BY_ID = new Map(FEATURES.map(function (feature) {
  return [feature.id, feature];
}));

/*
 * Freeze the complete 965-column matrix order. The first 753 names reproduce
 * Round 2 exactly: 17 auxiliary terms, then the 368 identifiable MG PST
 * entries, then the corresponding 368 EG entries. New R3 names follow in
 * their numeric feature-ID order.
 */
function buildParameterNames() {
  const names = BASELINE_AUX_ORDER.map(function (name) {
    return 'baseline.aux.' + name;
  });
  for (const stage of ['mg', 'eg']) {
    for (const type of BASELINE_PST_TYPES) {
      const first = type === 'P' ? 8 : 0;
      const last = type === 'P' ? 55 : 63;
      for (let square = first; square <= last; square++) {
        names.push('baseline.pst.' + stage + '.' + type + '.' +
          squareName(square));
      }
    }
  }
  for (const feature of FEATURES) names.push('r3.' + feature.name);
  if (names.length !== TOTAL_PARAMETER_COUNT) {
    throw new Error('internal complete HCE parameter layout drift');
  }
  return Object.freeze(names);
}

const PARAMETER_NAMES = buildParameterNames();

function normalizePiece(piece) {
  if (piece == null || piece === '.' || piece === '') return null;
  if (typeof piece !== 'string') throw new Error('board pieces must be strings or null');
  if (piece.length === 1 && PIECES.includes(piece)) return piece;
  if (/^[wb][PNBRQK]$/.test(piece)) {
    return piece[0] === 'w' ? piece[1] : piece[1].toLowerCase();
  }
  throw new Error('invalid board piece: ' + piece);
}

function parseFenBoard(fen) {
  if (typeof fen !== 'string') throw new Error('FEN must be a string');
  const boardField = fen.trim().split(/\s+/)[0];
  const ranks = boardField.split('/');
  if (ranks.length !== 8) throw new Error('FEN board must contain eight ranks');
  const board = [];
  for (const encoded of ranks) {
    const rank = [];
    for (const ch of encoded) {
      if (/^[1-8]$/.test(ch)) {
        for (let count = 0; count < Number(ch); count++) rank.push(null);
      } else if (PIECES.includes(ch)) {
        rank.push(ch);
      } else {
        throw new Error('invalid FEN board character: ' + ch);
      }
    }
    if (rank.length !== 8) throw new Error('FEN rank must contain eight squares');
    board.push(...rank);
  }
  return board;
}

function normalizeBoard(input) {
  let source;
  if (typeof input === 'string') {
    source = parseFenBoard(input);
  } else if (Array.isArray(input) && input.length === 64) {
    source = input;
  } else if (Array.isArray(input) && input.length === 8 &&
      input.every(Array.isArray)) {
    source = input.flat();
  } else {
    throw new Error('expected a FEN, flat 64-square board, or 8x8 board');
  }
  if (source.length !== 64) throw new Error('board must contain 64 squares');
  const board = source.map(normalizePiece);
  let whiteKings = 0, blackKings = 0;
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (piece === 'K') whiteKings++;
    if (piece === 'k') blackKings++;
    if ((piece === 'P' || piece === 'p') &&
        ((square >> 3) === 0 || (square >> 3) === 7)) {
      throw new Error('pawns on first/eighth ranks are outside the frozen schema');
    }
  }
  if (whiteKings !== 1 || blackKings !== 1) {
    throw new Error('board must contain exactly one king of each color');
  }
  return board;
}

function isWhite(piece) {
  return piece != null && piece === piece.toUpperCase();
}

function colorOf(piece) {
  return isWhite(piece) ? 'w' : 'b';
}

function enemyColor(color) {
  return color === 'w' ? 'b' : 'w';
}

function signFor(color) {
  return color === 'w' ? 1 : -1;
}

function materialPhase(board) {
  let phase = 0;
  for (const piece of board) {
    if (piece) phase += PHASE_WEIGHT[piece.toUpperCase()] || 0;
  }
  return Math.min(PHASE_MAX, phase);
}

function relativePawnRank(square, color) {
  const boardRank = square >> 3;
  return color === 'w' ? 8 - boardRank : boardRank + 1;
}

function pawnTargets(square, color) {
  const rank = square >> 3;
  const file = square & 7;
  const nextRank = rank + (color === 'w' ? -1 : 1);
  if (nextRank < 0 || nextRank >= 8) return [];
  const targets = [];
  if (file > 0) targets.push(nextRank * 8 + file - 1);
  if (file < 7) targets.push(nextRank * 8 + file + 1);
  return targets;
}

function pawnAttackMaps(board) {
  const attacked = {
    w: new Uint8Array(64),
    b: new Uint8Array(64)
  };
  const advancedRank = {
    w: new Uint8Array(64),
    b: new Uint8Array(64)
  };
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (piece !== 'P' && piece !== 'p') continue;
    const color = colorOf(piece);
    const relativeRank = relativePawnRank(square, color);
    for (const target of pawnTargets(square, color)) {
      attacked[color][target] = 1;
      if (CRAMP_RANKS.includes(relativeRank)) {
        advancedRank[color][target] = Math.max(
          advancedRank[color][target],
          relativeRank
        );
      }
    }
  }
  return { attacked, advancedRank };
}

function sameColor(piece, color) {
  return piece != null && colorOf(piece) === color;
}

function slidingDestinations(board, square, color, directions) {
  const destinations = [];
  const rank = square >> 3;
  const file = square & 7;
  for (const direction of directions) {
    let nextRank = rank + direction[0];
    let nextFile = file + direction[1];
    while (nextRank >= 0 && nextRank < 8 && nextFile >= 0 && nextFile < 8) {
      const target = nextRank * 8 + nextFile;
      const occupant = board[target];
      if (occupant) {
        if (!sameColor(occupant, color)) destinations.push(target);
        break;
      }
      destinations.push(target);
      nextRank += direction[0];
      nextFile += direction[1];
    }
  }
  return destinations;
}

function pseudoDestinations(board, square, piece) {
  const type = piece.toUpperCase();
  const color = colorOf(piece);
  if (type === 'N') {
    const rank = square >> 3;
    const file = square & 7;
    const destinations = [];
    for (const jump of KNIGHT_JUMPS) {
      const nextRank = rank + jump[0];
      const nextFile = file + jump[1];
      if (nextRank < 0 || nextRank >= 8 || nextFile < 0 || nextFile >= 8) continue;
      const target = nextRank * 8 + nextFile;
      if (!sameColor(board[target], color)) destinations.push(target);
    }
    return destinations;
  }
  if (type === 'B') return slidingDestinations(board, square, color, DIAGONALS);
  if (type === 'R') return slidingDestinations(board, square, color, ORTHOGONALS);
  if (type === 'Q') {
    return slidingDestinations(
      board,
      square,
      color,
      DIAGONALS.concat(ORTHOGONALS)
    );
  }
  return [];
}

function attackedPieceClass(piece) {
  const type = piece && piece.toUpperCase();
  if (type === 'N' || type === 'B') return 'minor';
  if (type === 'R') return 'rook';
  if (type === 'Q') return 'queen';
  return null;
}

function kingBucket(file) {
  if (file <= 2) return 'q';
  if (file >= 5) return 'k';
  return 'center';
}

function feature(name) {
  const found = FEATURE_BY_NAME.get(name);
  if (!found) throw new Error('unknown HCE R3 feature: ' + name);
  return found;
}

function addByName(dense, name, value) {
  if (!value) return;
  const descriptor = feature(name);
  dense[descriptor.offset] += value;
}

function addTapered(dense, prefix, count, mgScale, egScale) {
  if (!count) return;
  addByName(dense, prefix + '.mg', count * mgScale);
  addByName(dense, prefix + '.eg', count * egScale);
}

function sparseFromDense(dense) {
  const sparse = [];
  for (let offset = 0; offset < dense.length; offset++) {
    if (!dense[offset]) continue;
    const descriptor = FEATURES[offset];
    sparse.push(Object.freeze({
      id: descriptor.id,
      name: descriptor.name,
      value: dense[offset]
    }));
  }
  return Object.freeze(sparse);
}

function extractWithMeta(input) {
  const board = normalizeBoard(input);
  const phase = materialPhase(board);
  const mgScale = phase;
  const egScale = PHASE_MAX - phase;
  const dense = new Int32Array(NEW_PARAMETER_COUNT);
  const maps = pawnAttackMaps(board);

  const directCounts = { minor: 0, rook: 0, queen: 0 };
  for (let square = 0; square < 64; square++) {
    const pawn = board[square];
    if (pawn !== 'P' && pawn !== 'p') continue;
    const color = colorOf(pawn);
    for (const target of pawnTargets(square, color)) {
      const occupant = board[target];
      if (!occupant || colorOf(occupant) === color) continue;
      const pieceClass = attackedPieceClass(occupant);
      if (pieceClass) directCounts[pieceClass] += signFor(color);
    }
  }
  for (const pieceClass of ATTACK_CLASSES) {
    addTapered(
      dense,
      'pawn_attack_enemy_' + pieceClass,
      directCounts[pieceClass],
      mgScale,
      egScale
    );
  }

  const safeCounts = { knight: 0, bishop: 0, rook: 0, queen: 0 };
  const crampCounts = { 4: 0, 5: 0, 6: 0 };
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (!piece || !'NBRQ'.includes(piece.toUpperCase())) continue;
    const color = colorOf(piece);
    const enemy = enemyColor(color);
    const pieceName = MOBILITY_PIECES.find(function (name) {
      return MOBILITY_LETTER[name] === piece.toUpperCase();
    });
    const destinations = pseudoDestinations(board, square, piece);
    for (const target of destinations) {
      if (!maps.attacked[enemy][target]) safeCounts[pieceName] += signFor(color);
      const crampRank = maps.advancedRank[enemy][target];
      if (crampRank) {
        // A denied mobility edge is a benefit for the attacking pawn's side.
        crampCounts[crampRank] += signFor(enemy);
      }
    }
  }
  for (const pieceName of MOBILITY_PIECES) {
    addTapered(
      dense,
      'safe_mobility.' + pieceName,
      safeCounts[pieceName],
      mgScale,
      egScale
    );
  }
  for (const relativeRank of CRAMP_RANKS) {
    addTapered(
      dense,
      'advanced_pawn_cramp.r' + relativeRank,
      crampCounts[relativeRank],
      mgScale,
      egScale
    );
  }

  const kings = { w: -1, b: -1 };
  for (let square = 0; square < 64; square++) {
    if (board[square] === 'K') kings.w = square;
    if (board[square] === 'k') kings.b = square;
  }
  for (const color of ['w', 'b']) {
    const bucket = kingBucket(kings[color] & 7);
    if (bucket === 'center') continue; // Identifiability reference bucket.
    for (let square = 0; square < 64; square++) {
      const expectedPawn = color === 'w' ? 'P' : 'p';
      if (board[square] !== expectedPawn) continue;
      const relativeSquare = color === 'w' ? square : (square ^ 56);
      if (relativeSquare < 8 || relativeSquare > 55) {
        throw new Error('pawn reached an omitted first/eighth-rank PST slot');
      }
      const prefix = 'king_bucket_pawn_pst.' + bucket;
      addByName(
        dense,
        prefix + '.mg.' + squareName(relativeSquare),
        signFor(color) * mgScale
      );
      addByName(
        dense,
        prefix + '.eg.' + squareName(relativeSquare),
        signFor(color) * egScale
      );
    }
  }

  return Object.freeze({
    phase,
    mgScale,
    egScale,
    scoreDenominator: PHASE_MAX,
    dense,
    sparse: sparseFromDense(dense)
  });
}

function extract(input) {
  return extractWithMeta(input).dense;
}

function valueByName(result, name) {
  const dense = result && result.dense instanceof Int32Array ?
    result.dense : result;
  if (!(dense instanceof Int32Array) || dense.length !== NEW_PARAMETER_COUNT) {
    throw new Error('valueByName expects an extracted dense vector or result');
  }
  return dense[feature(name).offset];
}

module.exports = {
  BASELINE_PARAMETER_COUNT,
  NEW_PARAMETER_COUNT,
  TOTAL_PARAMETER_COUNT,
  FIRST_FEATURE_ID,
  LAST_FEATURE_ID,
  PHASE_MAX,
  BASELINE_AUX_ORDER,
  BASELINE_PST_TYPES,
  STAGES,
  ATTACK_CLASSES,
  MOBILITY_PIECES,
  CRAMP_RANKS,
  KING_BUCKETS,
  REACHABLE_PAWN_SQUARES,
  FEATURES,
  PARAMETER_NAMES,
  squareName,
  parseFenBoard,
  normalizeBoard,
  materialPhase,
  relativePawnRank,
  pawnTargets,
  pseudoDestinations,
  feature,
  extract,
  extractWithMeta,
  sparseFromDense,
  valueByName
};
