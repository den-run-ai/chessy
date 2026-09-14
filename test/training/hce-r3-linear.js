/*
 * Compile one FEN into the complete affine HCE R3 score:
 *
 *   cpWhite = fixedCp + sum(coefficients[i] * weights[i])
 *
 * Coefficients are already divided by the frozen taper denominator (24), so
 * every matrix column is in centipawns per integer weight unit.
 */
'use strict';

const Corpus = require('./corpus');
const H = require('./hce-r3-features');
const Baseline = require('./hce-r3-baseline');

const S = Baseline.extractShipped();
const DIAG = Object.freeze([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
const ORTHO = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);
const ALL_DIRS = Object.freeze(DIAG.concat(ORTHO));
const N_JUMPS = Object.freeze([
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1]
]);
const PST_SQUARES = Object.freeze(
  { P: 48, N: 64, B: 64, R: 64, Q: 64, K: 64 });
const TYPE_OFFSETS = Object.freeze(
  { P: 0, N: 48, B: 112, R: 176, Q: 240, K: 304 });
const PST_MG_BASE = 17;
const PST_EG_BASE = 17 + 368;

if (S.PHASE_MAX !== H.PHASE_MAX) {
  throw new Error('shipped and R3 taper denominators differ');
}

function pstSlot(stage, type, square) {
  let offset = square;
  if (type === 'P') {
    if (square < 8 || square >= 56) return -1;
    offset = square - 8;
  }
  if (!Object.prototype.hasOwnProperty.call(PST_SQUARES, type)) return -1;
  return (stage === 'eg' ? PST_EG_BASE : PST_MG_BASE) +
    TYPE_OFFSETS[type] + offset;
}

function chessyBoard(fen) {
  const parsed = Corpus.validateSourceState(fen);
  return parsed.board.flat().map(function (piece) {
    if (!piece) return null;
    return (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase();
  });
}

function mobility(board, square, type, color) {
  const row = square >> 3;
  const file = square & 7;
  let count = 0;
  if (type === 'N') {
    for (const [dr, df] of N_JUMPS) {
      const nextRow = row + dr, nextFile = file + df;
      if (nextRow < 0 || nextRow > 7 || nextFile < 0 || nextFile > 7) continue;
      const occupant = board[nextRow * 8 + nextFile];
      if (!occupant || occupant[0] !== color) count++;
    }
    return count;
  }
  const directions = type === 'B' ? DIAG : type === 'R' ? ORTHO : ALL_DIRS;
  for (const [dr, df] of directions) {
    let nextRow = row + dr, nextFile = file + df;
    while (nextRow >= 0 && nextRow < 8 && nextFile >= 0 && nextFile < 8) {
      const occupant = board[nextRow * 8 + nextFile];
      if (occupant) {
        if (occupant[0] !== color) count++;
        break;
      }
      count++;
      nextRow += dr;
      nextFile += df;
    }
  }
  return count;
}

function mopUp(loser, winner) {
  const loserRow = loser >> 3, loserFile = loser & 7;
  const winnerRow = winner >> 3, winnerFile = winner & 7;
  const centerDistance = Math.max(3 - loserFile, loserFile - 4) +
    Math.max(3 - loserRow, loserRow - 4);
  const kingDistance = Math.abs(loserRow - winnerRow) +
    Math.abs(loserFile - winnerFile);
  return 8 * centerDistance + 2 * (14 - kingDistance);
}

function compile(fen) {
  const board = chessyBoard(fen);
  const dense = new Float64Array(H.TOTAL_PARAMETER_COUNT);
  let phase = 0, baseMg = 0, baseEg = 0;
  let fN = 0, fB = 0, fR = 0, fQ = 0;
  let fD = 0, fI = 0, fS = 0;
  const passed = [0, 0, 0, 0, 0];
  const pst = [];
  const pawnFiles = {
    w: [0, 0, 0, 0, 0, 0, 0, 0],
    b: [0, 0, 0, 0, 0, 0, 0, 0]
  };
  const pawnSquares = { w: [], b: [] };
  const kings = { w: -1, b: -1 };
  const force = { w: 0, b: 0 };
  const pieces = { w: 0, b: 0 };

  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (!piece) continue;
    const color = piece[0], type = piece[1];
    const sign = color === 'w' ? 1 : -1;
    const relativeSquare = color === 'w' ? square : (square ^ 56);
    phase += S.PHASE[type];
    baseMg += sign * S.VALUES_MG[type];
    baseEg += sign * S.VALUES_EG[type];
    pst.push({ type, relativeSquare, sign });
    if (type !== 'K') force[color]++;
    if (type === 'P') {
      pawnFiles[color][square & 7]++;
      pawnSquares[color].push(square);
    } else if (type === 'K') {
      kings[color] = square;
    } else {
      pieces[color]++;
      const edges = sign * mobility(board, square, type, color);
      if (type === 'N') fN += edges;
      else if (type === 'B') fB += edges;
      else if (type === 'R') fR += edges;
      else fQ += edges;
    }
  }

  for (const color of ['w', 'b']) {
    const sign = color === 'w' ? 1 : -1;
    const files = pawnFiles[color];
    const enemies = pawnSquares[color === 'w' ? 'b' : 'w'];
    for (let file = 0; file < 8; file++) {
      if (files[file] > 1) fD += -sign * (files[file] - 1);
    }
    for (const square of pawnSquares[color]) {
      const file = square & 7, row = square >> 3;
      if (!(file > 0 && files[file - 1]) &&
          !(file < 7 && files[file + 1])) fI += -sign;
      let isPassed = true;
      for (const enemy of enemies) {
        const enemyFile = enemy & 7, enemyRow = enemy >> 3;
        if (Math.abs(enemyFile - file) <= 1 &&
            (color === 'w' ? enemyRow < row : enemyRow > row)) {
          isPassed = false;
          break;
        }
      }
      if (isPassed) {
        const relativeRank = Math.min(Math.max(
          color === 'w' ? 6 - row : row - 1, 0), 6);
        if (relativeRank === 6) {
          throw new Error('promotion-rank pawn is outside the HCE contract');
        }
        if (relativeRank >= 1) passed[relativeRank - 1] += sign;
      }
    }
    const king = kings[color];
    const shieldRow = (king >> 3) + (color === 'w' ? -1 : 1);
    const kingFile = king & 7;
    if (shieldRow >= 0 && shieldRow < 8) {
      for (let delta = -1; delta <= 1; delta++) {
        const file = kingFile + delta;
        if (file >= 0 && file < 8 &&
            board[shieldRow * 8 + file] === color + 'P') fS += sign;
      }
    }
  }

  phase = Math.min(phase, H.PHASE_MAX);
  const mg = phase / H.PHASE_MAX;
  const eg = (H.PHASE_MAX - phase) / H.PHASE_MAX;
  dense[0] = fN;
  dense[1] = fB;
  dense[2] = fR;
  dense[3] = fQ;
  dense[4] = fD;
  dense[5] = fI;
  dense[6] = fS * mg;
  for (let index = 0; index < 5; index++) {
    dense[7 + index] = passed[index] * mg;
    dense[12 + index] = passed[index] * eg;
  }
  for (const entry of pst) {
    const mgSlot = pstSlot('mg', entry.type, entry.relativeSquare);
    const egSlot = pstSlot('eg', entry.type, entry.relativeSquare);
    if (mgSlot >= 0) dense[mgSlot] += entry.sign * mg;
    if (egSlot >= 0) dense[egSlot] += entry.sign * eg;
  }

  const newFeatures = H.extract(fen);
  for (let offset = 0; offset < newFeatures.length; offset++) {
    dense[H.BASELINE_PARAMETER_COUNT + offset] =
      newFeatures[offset] / H.PHASE_MAX;
  }

  let mop = 0;
  if (pieces.w > 0 && force.b === 0) mop = mopUp(kings.b, kings.w);
  else if (pieces.b > 0 && force.w === 0) mop = -mopUp(kings.w, kings.b);
  const fixedTaperCp = baseMg * mg + baseEg * eg;
  const sparse = [];
  for (let index = 0; index < dense.length; index++) {
    if (dense[index] !== 0) sparse.push([index, dense[index]]);
  }
  return {
    schema: 'chessy.hce-r3-linear-position.v1',
    fen: Corpus.parseFen4(fen).fen4,
    phase,
    scoreDenominator: H.PHASE_MAX,
    fixedTaperCp,
    mopUpCp: mop,
    fixedCp: fixedTaperCp + mop,
    dense,
    sparse
  };
}

function smoothScore(compiled, weights) {
  if (!compiled || !(compiled.dense instanceof Float64Array) ||
      !Array.isArray(weights) && !(weights instanceof Float64Array) ||
      weights.length !== H.TOTAL_PARAMETER_COUNT) {
    throw new Error('smoothScore requires one compiled position and 965 weights');
  }
  let score = compiled.fixedCp;
  for (let index = 0; index < weights.length; index++) {
    score += compiled.dense[index] * weights[index];
  }
  return score;
}

function runtimeRoundedScore(compiled, weights) {
  let taper = compiled.fixedTaperCp;
  for (let index = 0; index < weights.length; index++) {
    taper += compiled.dense[index] * weights[index];
  }
  return Math.round(taper) + compiled.mopUpCp;
}

module.exports = {
  PST_MG_BASE,
  PST_EG_BASE,
  pstSlot,
  chessyBoard,
  mobility,
  mopUp,
  compile,
  smoothScore,
  runtimeRoundedScore
};
