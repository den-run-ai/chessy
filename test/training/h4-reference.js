#!/usr/bin/env node
'use strict';

// Independent research-only integer oracle. BigInt makes rounding and overflow
// behavior explicit, independent from NumPy and JavaScript's floating numbers.
const fs = require('node:fs');
const readline = require('node:readline');
const PIECES = 'PNBRQKpnbrqk';
const BYTES = 6180;

function parseFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6 || !['w', 'b'].includes(fields[1])) throw new Error('invalid FEN fields');
  const ranks = fields[0].split('/');
  if (ranks.length !== 8) throw new Error('invalid FEN ranks');
  const white = [], black = [];
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
      }
      if (file > 8) throw new Error('invalid FEN rank width');
    }
    if (file !== 8) throw new Error('invalid FEN rank width');
  }
  if (white.length > 32) throw new Error('32-piece bound exceeded');
  return {white, black, turn: fields[1] === 'w' ? 1 : -1};
}

function loadModel(bytes, metadata) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== BYTES) throw new Error('expected exactly 6180 bytes');
  const q2 = metadata.q2;
  if (metadata.q1 !== 1024 || !Number.isInteger(q2) || q2 < 1 || q2 > 4096 || (q2 & (q2 - 1))) {
    throw new Error('invalid quantization scales');
  }
  let offset = 0;
  const w1 = Array.from({length: 3072}, () => {const x = bytes.readInt16LE(offset); offset += 2; return BigInt(x);});
  const b1 = Array.from({length: 4}, () => {const x = bytes.readInt32LE(offset); offset += 4; return BigInt(x);});
  const w2 = Array.from({length: 8}, () => {const x = bytes.readInt16LE(offset); offset += 2; return BigInt(x);});
  const b2 = BigInt(bytes.readInt32LE(offset));
  const abs = x => x < 0n ? -x : x;
  for (let unit = 0; unit < 4; unit++) {
    const magnitudes = Array.from({length: 768}, (_, i) => abs(w1[i * 4 + unit]));
    magnitudes.sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    const bound = magnitudes.slice(0, 32).reduce((a, b) => a + b, abs(b1[unit]));
    if (bound > 2147483647n) throw new Error('theoretical int32 accumulator overflow');
  }
  const dotBound = 1024n * w2.reduce((a, b) => a + abs(b), 0n) + abs(b2);
  if (dotBound * 400n + 512n * BigInt(q2) > 9223372036854775807n) throw new Error('int64 output overflow');
  return {w1, b1, w2, b2, q2};
}

function floorDivide(numerator, denominator) {
  const quotient = numerator / denominator;
  return quotient - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n);
}

function infer(model, fen) {
  const position = parseFen(fen);
  const activate = indices => model.b1.map((bias, unit) => {
    const sum = indices.reduce((acc, index) => acc + model.w1[index * 4 + unit], bias);
    return sum < 0n ? 0n : sum > 1024n ? 1024n : sum;
  });
  const white = activate(position.white), black = activate(position.black);
  const ordered = position.turn === 1 ? white.concat(black) : black.concat(white);
  const numerator = ordered.reduce((acc, value, i) => acc + value * model.w2[i], model.b2);
  const denominator = 1024n * BigInt(model.q2);
  const stm = floorDivide(numerator * 400n + denominator / 2n, denominator);
  const cpWhite = stm * BigInt(position.turn);
  if (cpWhite > BigInt(Number.MAX_SAFE_INTEGER) || cpWhite < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('unsafe output');
  return Number(cpWhite);
}

module.exports = {parseFen, loadModel, infer, floorDivide};

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('usage: h4-reference.js MODEL.bin METADATA.json');
  const model = loadModel(fs.readFileSync(process.argv[2]), JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  input.on('line', line => {
    if (!line.trim()) return;
    const row = JSON.parse(line);
    process.stdout.write(JSON.stringify({id: row.id, cpWhite: infer(model, row.fen)}) + '\n');
  });
}
