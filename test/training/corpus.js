/*
 * Shared, runtime-independent corpus contract for HCE R3 (#137) and NNUE
 * G0-G2 (#105).  Nothing in this module is imported by the shipped app.
 *
 * The source format is the Lichess evaluated-position JSONL schema:
 *   {"fen":"<4-field FEN>","evals":[{"depth":..,"knodes":..,
 *     "pvs":[{"cp":..,"moves":"..."}]}]}
 *
 * Lichess cloud-evaluation centipawns are White-POV.  We retain that POV,
 * choose the deepest available evaluation (then most knodes), and use only its
 * first PV.  The selected CC0 positions are subsequently re-labelled by one
 * pinned external Stockfish build before either fit is allowed to certify.
 */
'use strict';

const crypto = require('crypto');

const SCHEMA = 'chessy.teacher-position.v1';
const TRANSFORMS = Object.freeze([
  'identity', 'file-mirror', 'color-rank', 'color-rank-file-mirror'
]);
const PHASE_MAX = 24;
const PHASE_VALUE = Object.freeze({ n: 1, b: 1, r: 2, q: 4 });
const PIECES = 'PNBRQKpnbrqk';
const NNUE_PIECES = Object.freeze(['P', 'N', 'B', 'R', 'Q', 'K']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeCastling(value) {
  if (value === '-') return '-';
  if (!/^[KQkq]+$/.test(value)) throw new Error('invalid castling field: ' + value);
  const seen = new Set(value);
  return 'KQkq'.split('').filter(ch => seen.has(ch)).join('') || '-';
}

function expandBoard(boardField) {
  const ranks = boardField.split('/');
  if (ranks.length !== 8) throw new Error('FEN board must contain eight ranks');
  return ranks.map(function (rank) {
    const out = [];
    for (const ch of rank) {
      if (/^[1-8]$/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) out.push(null);
      } else if (PIECES.includes(ch)) {
        out.push(ch);
      } else {
        throw new Error('invalid FEN board character: ' + ch);
      }
    }
    if (out.length !== 8) throw new Error('FEN rank does not contain eight squares');
    return out;
  });
}

function compressRank(rank) {
  let text = '', empty = 0;
  for (const piece of rank) {
    if (piece == null) {
      empty++;
    } else {
      if (empty) text += String(empty);
      empty = 0;
      text += piece;
    }
  }
  if (empty) text += String(empty);
  return text;
}

function parseFen4(fen) {
  if (typeof fen !== 'string') throw new Error('FEN must be a string');
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 4 && fields.length !== 6) {
    throw new Error('FEN must contain four or six fields');
  }
  const board = expandBoard(fields[0]);
  const turn = fields[1];
  if (turn !== 'w' && turn !== 'b') throw new Error('invalid side to move: ' + turn);
  const castling = normalizeCastling(fields[2]);
  let ep = fields[3];
  if (ep !== '-' && !/^[a-h][36]$/.test(ep)) {
    throw new Error('invalid en-passant field: ' + ep);
  }
  let whiteKings = 0, blackKings = 0;
  let whiteKingSquare = -1, blackKingSquare = -1;
  for (let rankIndex = 0; rankIndex < board.length; rankIndex++) {
    const rank = board[rankIndex];
    for (let fileIndex = 0; fileIndex < rank.length; fileIndex++) {
      const piece = rank[fileIndex];
      if (piece === 'K') whiteKings++;
      if (piece === 'k') blackKings++;
      if (piece === 'K') whiteKingSquare = rankIndex * 8 + fileIndex;
      if (piece === 'k') blackKingSquare = rankIndex * 8 + fileIndex;
      if ((piece === 'P' || piece === 'p') &&
          (rankIndex === 0 || rankIndex === 7)) {
        throw new Error('FEN cannot contain a pawn on rank 1 or rank 8');
      }
    }
  }
  if (whiteKings !== 1 || blackKings !== 1) {
    throw new Error('FEN must contain exactly one king of each color');
  }
  if (Math.abs((whiteKingSquare >> 3) - (blackKingSquare >> 3)) <= 1 &&
      Math.abs((whiteKingSquare & 7) - (blackKingSquare & 7)) <= 1) {
    throw new Error('FEN kings cannot occupy adjacent squares');
  }
  // FEN producers sometimes retain a nominal double-push square even when no
  // opposing pawn can capture. Collapse that non-state to "-" so equivalent
  // static positions cannot cross corpus roles. Full king-safety legality is
  // checked later by the independent rules oracle.
  if (ep !== '-') {
    const file = ep.charCodeAt(0) - 97;
    const sourceRank = turn === 'w' ? 3 : 4; // FEN row: White pawn on rank 5, Black on rank 4.
    const capturer = turn === 'w' ? 'P' : 'p';
    const captured = turn === 'w' ? 'p' : 'P';
    const capturedRank = sourceRank;
    const adjacent = (file > 0 && board[sourceRank][file - 1] === capturer) ||
      (file < 7 && board[sourceRank][file + 1] === capturer);
    if (!adjacent || board[capturedRank][file] !== captured) ep = '-';
  }
  return {
    board,
    turn,
    castling,
    ep,
    fen4: board.map(compressRank).join('/') + ' ' + turn + ' ' + castling + ' ' + ep
  };
}

function validateSourceState(fen) {
  const parsed = parseFen4(fen);
  const board = parsed.board;
  const castlingPieces = {
    K: board[7][4] === 'K' && board[7][7] === 'R',
    Q: board[7][4] === 'K' && board[7][0] === 'R',
    k: board[0][4] === 'k' && board[0][7] === 'r',
    q: board[0][4] === 'k' && board[0][0] === 'r'
  };
  if (parsed.castling !== '-' &&
      parsed.castling.split('').some(right => !castlingPieces[right])) {
    throw new Error('FEN castling right lacks its king or rook');
  }
  return parsed;
}

function mirrorEpFile(ep) {
  if (ep === '-') return '-';
  return String.fromCharCode('h'.charCodeAt(0) - (ep.charCodeAt(0) - 'a'.charCodeAt(0))) +
    ep[1];
}

function mirrorEpRank(ep) {
  if (ep === '-') return '-';
  return ep[0] + String(9 - Number(ep[1]));
}

function swapPieceColor(piece) {
  if (piece == null) return null;
  return piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
}

function transformFen4(fen, transform) {
  if (!TRANSFORMS.includes(transform)) throw new Error('unknown transform: ' + transform);
  const parsed = parseFen4(fen);
  const fileMirror = transform === 'file-mirror' ||
    transform === 'color-rank-file-mirror';
  const colorRank = transform === 'color-rank' ||
    transform === 'color-rank-file-mirror';
  let board = parsed.board.map(rank => rank.slice());
  let turn = parsed.turn, castling = parsed.castling, ep = parsed.ep;

  if (fileMirror) {
    board = board.map(rank => rank.slice().reverse());
    const map = { K: 'Q', Q: 'K', k: 'q', q: 'k' };
    castling = castling === '-' ? '-' :
      normalizeCastling(castling.split('').map(ch => map[ch]).join(''));
    ep = mirrorEpFile(ep);
  }
  if (colorRank) {
    board = board.slice().reverse().map(rank => rank.map(swapPieceColor));
    turn = turn === 'w' ? 'b' : 'w';
    const map = { K: 'k', Q: 'q', k: 'K', q: 'Q' };
    castling = castling === '-' ? '-' :
      normalizeCastling(castling.split('').map(ch => map[ch]).join(''));
    ep = mirrorEpRank(ep);
  }
  return board.map(compressRank).join('/') + ' ' + turn + ' ' + castling + ' ' + ep;
}

function symmetryFens(fen) {
  return TRANSFORMS.map(transform => transformFen4(fen, transform));
}

function canonicalFen4(fen) {
  return symmetryFens(fen).slice().sort()[0];
}

function canonicalModelBoard(fen) {
  return symmetryFens(fen).map(variant => variant.split(' ')[0]).sort()[0];
}

function clusterKey(fen) {
  // Both proposed evaluators omit at least castling/en-passant state, and the
  // HCE feature vector also omits side to move. Group on the strongest shared
  // model-equivalence key so identical model inputs can never cross roles.
  return sha256(canonicalModelBoard(fen));
}

function materialPhase(fen) {
  const parsed = parseFen4(fen);
  let phase = 0;
  for (const rank of parsed.board) {
    for (const piece of rank) {
      if (piece) phase += PHASE_VALUE[piece.toLowerCase()] || 0;
    }
  }
  return Math.min(PHASE_MAX, phase);
}

function phaseBucket(fen) {
  const phase = materialPhase(fen);
  if (phase >= 18) return 'opening';
  if (phase >= 7) return 'middlegame';
  return 'endgame';
}

function evalBucket(cp) {
  if (!Number.isFinite(cp)) throw new Error('centipawn score must be finite');
  const value = Math.abs(cp);
  if (value <= 50) return '0000-0050';
  if (value <= 150) return '0051-0150';
  if (value <= 400) return '0151-0400';
  if (value <= 1000) return '0401-1000';
  if (value <= 2000) return '1001-2000';
  return 'excluded';
}

/*
 * One shared training role and independent HCE/NNUE validation and test roles.
 * Weights are 210:45:45:45:45, giving 2.1M + four 450k slices when the
 * preregistered sample contains 3.9M positions.
 */
function roleForCluster(key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('cluster key must be SHA-256 hex');
  const cell = parseInt(key.slice(0, 12), 16) % 390;
  if (cell < 210) return 'shared-train';
  if (cell < 255) return 'hce-validation';
  if (cell < 300) return 'hce-test';
  if (cell < 345) return 'nnue-validation';
  return 'nnue-test';
}

function positionFamilyKey(fen) {
  const representations = symmetryFens(fen).map(function (variant) {
    const parsed = parseFen4(variant);
    const pawns = [], kings = [];
    const material = { P: 0, N: 0, B: 0, R: 0, Q: 0, p: 0, n: 0, b: 0, r: 0, q: 0 };
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = parsed.board[rank][file];
        if (!piece) continue;
        const square = rank * 8 + file;
        if (piece === 'P' || piece === 'p') pawns.push(piece + square);
        else if (piece === 'K' || piece === 'k') kings.push(piece + square);
        else material[piece]++;
      }
    }
    return JSON.stringify({
      pawns: pawns.sort(),
      kings: kings.sort(),
      material: Object.keys(material).sort().map(piece => [piece, material[piece]])
    });
  });
  return sha256(representations.sort()[0]);
}

function chooseLichessEval(record) {
  if (!record || typeof record !== 'object') throw new Error('record must be an object');
  if (!Array.isArray(record.evals) || !record.evals.length) return null;
  const candidates = record.evals.filter(function (entry) {
    return entry && Number.isFinite(entry.depth) && Array.isArray(entry.pvs) &&
      entry.pvs.length && entry.pvs[0] && Number.isFinite(entry.pvs[0].cp);
  });
  if (!candidates.length) return null; // Mate-only records do not enter CP fitting.
  candidates.sort(function (a, b) {
    return b.depth - a.depth || (Number(b.knodes) || 0) - (Number(a.knodes) || 0);
  });
  const selected = candidates[0];
  return {
    cpWhite: Math.round(selected.pvs[0].cp),
    depth: selected.depth,
    knodes: Number.isFinite(selected.knodes) ? selected.knodes : null,
    pvUci: typeof selected.pvs[0].line === 'string' ?
      selected.pvs[0].line.trim().split(/\s+/).filter(Boolean) :
      (typeof selected.pvs[0].moves === 'string' ?
        selected.pvs[0].moves.trim().split(/\s+/).filter(Boolean) : [])
  };
}

function teacherProbability(cpWhite, k) {
  const scale = k == null ? 0.68 : k;
  if (!Number.isFinite(cpWhite) || !(Number.isFinite(scale) && scale > 0)) {
    throw new Error('teacherProbability requires finite cp and positive k');
  }
  const x = Math.max(-40, Math.min(40, scale * cpWhite / 400));
  return 1 / (1 + Math.exp(-x));
}

function adaptLichessRecord(record, source) {
  if (!record || typeof record.fen !== 'string') throw new Error('record.fen is required');
  const fen = validateSourceState(record.fen).fen4;
  const selected = chooseLichessEval(record);
  if (!selected || Math.abs(selected.cpWhite) > 2000) return null;
  const cluster = clusterKey(fen);
  const positionFamily = positionFamilyKey(fen);
  const sourceSha256 = source && source.sha256;
  if (!/^[0-9a-f]{64}$/.test(sourceSha256 || '')) {
    throw new Error('source.sha256 must pin the input snapshot');
  }
  return {
    schema: SCHEMA,
    id: sha256(sourceSha256 + '\n' + fen),
    fen,
    canonicalFen: canonicalFen4(fen),
    cluster,
    role: roleForCluster(positionFamily),
    positionFamily,
    strata: {
      phase: phaseBucket(fen),
      eval: evalBucket(selected.cpWhite)
    },
    explorationLabel: {
      cpWhite: selected.cpWhite,
      depth: selected.depth,
      knodes: selected.knodes,
      pvUci: selected.pvUci,
      teacher: 'lichess-mixed-stockfish'
    },
    source: {
      dataset: 'lichess-evaluated-positions',
      snapshotSha256: sourceSha256,
      license: 'CC0-1.0'
    }
  };
}

/*
 * 12 piece-square planes, 64 squares each.  Channels 0..5 are the
 * perspective's pieces (P,N,B,R,Q,K), channels 6..11 are the opponent's.
 * White uses Chessy's native square order (a8=0). Black vertically flips ranks
 * with square XOR 56 and swaps own/opponent; files are deliberately not
 * mirrored. Exactly one bit is set per piece.
 */
function encodeNnue768(fen, perspective) {
  if (perspective !== 'w' && perspective !== 'b') {
    throw new Error('perspective must be w or b');
  }
  const parsed = parseFen4(fen);
  const indices = [];
  for (let fenRank = 0; fenRank < 8; fenRank++) {
    for (let file = 0; file < 8; file++) {
      const piece = parsed.board[fenRank][file];
      if (!piece) continue;
      const whitePiece = piece === piece.toUpperCase();
      const own = perspective === 'w' ? whitePiece : !whitePiece;
      const type = NNUE_PIECES.indexOf(piece.toUpperCase());
      const nativeSquare = fenRank * 8 + file;
      const oriented = perspective === 'w' ? nativeSquare : (nativeSquare ^ 56);
      indices.push((own ? type : 6 + type) * 64 + oriented);
    }
  }
  indices.sort((a, b) => a - b);
  return indices;
}

function selectionCell(id, modulus) {
  if (!Number.isSafeInteger(modulus) || modulus <= 0) {
    throw new Error('modulus must be a positive integer');
  }
  return parseInt(sha256('e4-v1-sample\n' + id).slice(0, 12), 16) % modulus;
}

module.exports = {
  SCHEMA,
  TRANSFORMS,
  sha256,
  parseFen4,
  validateSourceState,
  transformFen4,
  symmetryFens,
  canonicalFen4,
  canonicalModelBoard,
  clusterKey,
  materialPhase,
  phaseBucket,
  evalBucket,
  roleForCluster,
  positionFamilyKey,
  chooseLichessEval,
  teacherProbability,
  adaptLichessRecord,
  encodeNnue768,
  selectionCell
};
