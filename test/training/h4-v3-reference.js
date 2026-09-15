#!/usr/bin/env node
'use strict';

// Research-only scalar oracle. Decode and calculate independently of the
// trainer; all model arithmetic and signed rounding use exact BigInt values.
const fs = require('node:fs');
const readline = require('node:readline');
const PIECES = 'PNBRQKpnbrqk';
const PHASE_WEIGHTS = [0, 1, 1, 2, 4, 0, 0, 1, 1, 2, 4, 0];
const Q1 = 16384n, Q2 = 4096n, CP_SCALE = 400n, MAX_PHASE = 24n;
const INT32_MAX = 2147483647n, INT64_MAX = 9223372036854775807n;
const SCORE_LIMIT = 10000;
const abs = value => value < 0n ? -value : value;

function parseFen(fen) {
  if (typeof fen !== 'string') throw new Error('FEN must be a string');
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6 || !['w', 'b'].includes(fields[1])) throw new Error('invalid FEN fields');
  if (!/^(?:-|K?Q?k?q?)$/.test(fields[2]) || fields[2] === '') throw new Error('invalid castling field');
  if (!/^(?:-|[a-h][36])$/.test(fields[3])) throw new Error('invalid en-passant field');
  if (!/^\d+$/.test(fields[4]) || !Number.isSafeInteger(Number(fields[4])) ||
      !/^[1-9]\d*$/.test(fields[5]) || !Number.isSafeInteger(Number(fields[5]))) {
    throw new Error('invalid FEN counters');
  }
  const ranks = fields[0].split('/');
  if (ranks.length !== 8) throw new Error('invalid FEN ranks');
  const white = [], black = [];
  let phaseUnits = 0;
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const cell of ranks[rank]) {
      if (/^[1-8]$/.test(cell)) file += Number(cell);
      else {
        const channel = PIECES.indexOf(cell);
        if (channel < 0 || file >= 8) throw new Error('invalid FEN placement');
        const square = rank * 8 + file++;
        white.push(channel * 64 + square);
        black.push(((channel + 6) % 12) * 64 + (square ^ 56));
        phaseUnits += PHASE_WEIGHTS[channel];
      }
      if (file > 8) throw new Error('invalid FEN rank width');
    }
    if (file !== 8) throw new Error('invalid FEN rank width');
  }
  if (white.length > 32) throw new Error('32-piece bound exceeded');
  return {white, black, turn: fields[1] === 'w' ? 1 : -1, phaseUnits: Math.min(24, phaseUnits)};
}

function expectedMetadata(hidden) {
  return {
    schema: 'chessy-h4-v3-quantized-v1', researchOnly: true,
    inputs: 768, hidden, parameters: 773 * hidden + 2,
    parameterBytes: 1548 * hidden + 8,
    q1: Number(Q1), q2: Number(Q2), cpScale: Number(CP_SCALE), maximumPieces: 32,
    layout: `W1[768,${hidden}]:i16,b1[${hidden}]:i32,W2[2,${2 * hidden}]:i16,b2[2]:i32;little-endian`,
    featureOrder: 'PNBRQKpnbrqk; a8=0; black: color-swap,square^56',
    outputOrder: `MG,EG;side-to-move[${hidden}],other[${hidden}]`,
    weightRounding: 'nearest-ties-to-even',
    scoreRounding: 'floor((taperedNumerator*400+denominator/2)/denominator);white-sign-after-stm-round',
    activation: 'clamp(sum(W1)+b1,0,16384)',
    mode: 'phase-residual-shipped-hce', fixedBaseline: 'shipped-hce',
    maximumAbsScoreCp: SCORE_LIMIT,
    phaseRule: 'min(24,N+B+2R+4Q);both-colors',
  };
}

function loadModel(bytes, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata must be an object');
  const hidden = metadata.hidden;
  if (![4, 8].includes(hidden)) throw new Error('hidden width must be 4 or 8');
  const expected = expectedMetadata(hidden);
  if (Object.keys(metadata).length !== Object.keys(expected).length) throw new Error('unexpected metadata keys');
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key) || metadata[key] !== value) {
      throw new Error(`invalid metadata ${key}`);
    }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== expected.parameterBytes) {
    throw new Error(`expected exactly ${expected.parameterBytes} bytes`);
  }
  let offset = 0;
  const i16 = () => {const x = bytes.readInt16LE(offset); offset += 2; return BigInt(x);};
  const i32 = () => {const x = bytes.readInt32LE(offset); offset += 4; return BigInt(x);};
  const w1 = Array.from({length: 768 * hidden}, i16);
  const b1 = Array.from({length: hidden}, i32);
  const w2 = Array.from({length: 2}, () => Array.from({length: 2 * hidden}, i16));
  const b2 = Array.from({length: 2}, i32);
  if (offset !== bytes.length) throw new Error('unconsumed parameter bytes');
  if (w1.some(x => abs(x) > 31130n) || b1.some(x => abs(x) > 31130n) ||
      w2.some(head => head.some(x => abs(x) > 16384n)) || b2.some(x => abs(x) > 134217728n)) {
    throw new Error('registered projection bounds exceeded');
  }
  const accumulatorBounds = [];
  for (let unit = 0; unit < hidden; unit++) {
    const magnitudes = Array.from({length: 768}, (_, i) => abs(w1[i * hidden + unit]));
    magnitudes.sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    const bound = magnitudes.slice(0, 32).reduce((sum, value) => sum + value, abs(b1[unit]));
    if (bound > INT32_MAX) throw new Error('theoretical int32 accumulator overflow');
    accumulatorBounds.push(bound);
  }
  const numeratorBounds = w2.map((head, i) =>
    Q1 * head.reduce((sum, value) => sum + abs(value), 0n) + abs(b2[i]));
  const numeratorBound = MAX_PHASE * (numeratorBounds[0] > numeratorBounds[1] ? numeratorBounds[0] : numeratorBounds[1]);
  const denominator = MAX_PHASE * Q1 * Q2;
  if (numeratorBound * CP_SCALE + denominator / 2n > INT64_MAX) throw new Error('theoretical int64 output overflow');
  return {hidden, mode: metadata.mode, w1, b1, w2, b2, accumulatorBounds, numeratorBounds, numeratorBound};
}

function floorDivide(numerator, denominator) {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const quotient = numerator / denominator;
  return quotient - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n);
}

function infer(model, fen, baselineCp) {
  if (!Number.isSafeInteger(baselineCp) || Math.abs(baselineCp) > SCORE_LIMIT) {
    throw new Error('phase residual mode requires integer baselineCp within +/-10000');
  }
  const position = parseFen(fen);
  const activate = indices => model.b1.map((bias, unit) => {
    const sum = indices.reduce((acc, index) => acc + model.w1[index * model.hidden + unit], bias);
    if (abs(sum) > model.accumulatorBounds[unit]) throw new Error('declared accumulator bound exceeded');
    return sum < 0n ? 0n : sum > Q1 ? Q1 : sum;
  });
  const white = activate(position.white), black = activate(position.black);
  const ordered = position.turn === 1 ? white.concat(black) : black.concat(white);
  const numerators = model.w2.map((head, headIndex) => {
    const numerator = ordered.reduce((sum, value, i) => sum + value * head[i], model.b2[headIndex]);
    if (abs(numerator) > model.numeratorBounds[headIndex]) throw new Error('declared output numerator bound exceeded');
    return numerator;
  });
  const phase = BigInt(position.phaseUnits);
  const taperedNumerator = phase * numerators[0] + (MAX_PHASE - phase) * numerators[1];
  if (abs(taperedNumerator) > model.numeratorBound) throw new Error('declared tapered numerator bound exceeded');
  const denominator = MAX_PHASE * Q1 * Q2;
  const stm = floorDivide(taperedNumerator * CP_SCALE + denominator / 2n, denominator);
  const cpWhite = stm * BigInt(position.turn) + BigInt(baselineCp);
  // maximumAbsScoreCp is an eligibility guard applied by the screen, not an
  // inference clamp. Preserve out-of-range predictions for complete parity
  // reporting; BigInt overflow bounds were checked above.
  if (abs(cpWhite) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe integer output');
  return Number(cpWhite);
}

module.exports = {parseFen, loadModel, infer, floorDivide, expectedMetadata};

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('usage: h4-v3-reference.js MODEL.bin METADATA.json');
  const model = loadModel(fs.readFileSync(process.argv[2]), JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  input.on('line', line => {
    if (!line.trim()) return;
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id) {
      throw new Error('input row requires a nonempty string id');
    }
    process.stdout.write(JSON.stringify({id: row.id, cpWhite: infer(model, row.fen, row.baselineCp)}) + '\n');
  });
}
