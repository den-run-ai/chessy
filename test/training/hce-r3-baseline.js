#!/usr/bin/env node
/*
 * Extract the frozen Round-2 center and R3 regularization scales directly
 * from the shipped r71 Rust evaluator source. Development/training only.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./hce-r3-features');

const ROOT = path.join(__dirname, '..', '..');
const EVAL_RS_PATH = path.join(ROOT, 'experiments', 'wasm', 'src', 'eval.rs');
const PIECE_TYPES = Object.freeze(['P', 'N', 'B', 'R', 'Q', 'K']);
const INTEGER_RANGES = Object.freeze({
  i16: Object.freeze([-32768, 32767]),
  i32: Object.freeze([-2147483648, 2147483647])
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declaration(source, name, expectedType) {
  if (typeof source !== 'string') {
    throw new Error('Rust evaluator source must be a string');
  }
  const pattern = new RegExp(
    '^[ \\t]*const\\s+' + escapeRegExp(name) +
      '\\s*:\\s*([^=\\n]+?)\\s*=\\s*([\\s\\S]*?);[ \\t]*$',
    'gm'
  );
  const matches = Array.from(source.matchAll(pattern));
  if (matches.length !== 1) {
    throw new Error(
      'Rust evaluator must declare ' + name + ' exactly once; found ' +
        matches.length
    );
  }
  const observedType = matches[0][1].replace(/\s+/g, '');
  const requiredType = expectedType.replace(/\s+/g, '');
  if (observedType !== requiredType) {
    throw new Error(
      'Rust evaluator ' + name + ' type must be exactly ' + expectedType +
        '; found ' + matches[0][1].trim()
    );
  }
  return matches[0][2].trim();
}

function parseIntegerLiteral(text, rustType, label) {
  if (!Object.prototype.hasOwnProperty.call(INTEGER_RANGES, rustType) ||
      typeof text !== 'string' ||
      !/^-?[0-9](?:_?[0-9])*$/.test(text)) {
    throw new Error(label + ' must be one signed decimal ' + rustType);
  }
  const value = Number(text.replace(/_/g, ''));
  const range = INTEGER_RANGES[rustType];
  if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
    throw new Error(label + ' is outside the ' + rustType + ' range');
  }
  return value;
}

function parseArrayLiteral(text, rustType, label) {
  let offset = 0;

  function skipWhitespace() {
    while (offset < text.length && /\s/.test(text[offset])) offset++;
  }

  function parseValue(location) {
    skipWhitespace();
    if (text[offset] === '[') {
      offset++;
      const values = [];
      skipWhitespace();
      if (text[offset] === ']') {
        offset++;
        return values;
      }
      while (true) {
        values.push(parseValue(location + '[' + values.length + ']'));
        skipWhitespace();
        if (text[offset] === ']') {
          offset++;
          return values;
        }
        if (text[offset] !== ',') {
          throw new Error(location + ': expected a comma or closing bracket');
        }
        offset++;
        skipWhitespace();
        if (text[offset] === ']') {
          offset++;
          return values;
        }
      }
    }

    const rest = text.slice(offset);
    const match = rest.match(/^-?[0-9](?:_?[0-9])*/);
    if (!match) {
      throw new Error(location + ': expected a signed decimal integer');
    }
    offset += match[0].length;
    return parseIntegerLiteral(match[0], rustType, location);
  }

  const value = parseValue(label);
  skipWhitespace();
  if (offset !== text.length) {
    throw new Error(label + ': unexpected Rust token at byte ' + offset);
  }
  return value;
}

function requireShape(value, dimensions, label, depth) {
  const level = depth || 0;
  if (level === dimensions.length) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(label + ': array leaf is not an integer');
    }
    return;
  }
  if (!Array.isArray(value) || value.length !== dimensions[level]) {
    throw new Error(
      label + ': expected dimension ' + dimensions[level] +
        ' at depth ' + level
    );
  }
  value.forEach(function (entry) {
    requireShape(entry, dimensions, label, level + 1);
  });
}

function parseArrayDeclaration(source, name, rustType, dimensions) {
  let expectedType = rustType;
  for (let index = dimensions.length - 1; index >= 0; index--) {
    expectedType = '[' + expectedType + '; ' + dimensions[index] + ']';
  }
  const value = parseArrayLiteral(
    declaration(source, name, expectedType),
    rustType,
    name
  );
  requireShape(value, dimensions, name);
  return value;
}

function pieceMap(values, label) {
  if (!Array.isArray(values) || values.length !== PIECE_TYPES.length) {
    throw new Error(label + ': expected one entry per frozen piece type');
  }
  return Object.freeze(Object.fromEntries(PIECE_TYPES.map(function (type, index) {
    return [type, values[index]];
  })));
}

function parseRustEvaluator(source) {
  const pstMg = parseArrayDeclaration(source, 'PST_MG', 'i16', [6, 64]);
  const pstEg = parseArrayDeclaration(source, 'PST_EG', 'i16', [6, 64]);
  return Object.freeze({
    VALUES_MG: pieceMap(
      parseArrayDeclaration(source, 'VALUES_MG', 'i32', [6]),
      'VALUES_MG'
    ),
    VALUES_EG: pieceMap(
      parseArrayDeclaration(source, 'VALUES_EG', 'i32', [6]),
      'VALUES_EG'
    ),
    PST: pieceMap(pstMg, 'PST_MG'),
    PST_MG: pieceMap(pstMg, 'PST_MG'),
    PST_EG: pieceMap(pstEg, 'PST_EG'),
    PHASE: pieceMap(
      parseArrayDeclaration(source, 'PHASE', 'i32', [6]),
      'PHASE'
    ),
    PHASE_MAX: parseIntegerLiteral(
      declaration(source, 'PHASE_MAX', 'i32'),
      'i32',
      'PHASE_MAX'
    ),
    MOBILITY: pieceMap(
      parseArrayDeclaration(source, 'MOBILITY', 'i32', [6]),
      'MOBILITY'
    ),
    DOUBLED: parseIntegerLiteral(
      declaration(source, 'DOUBLED', 'i32'),
      'i32',
      'DOUBLED'
    ),
    ISOLATED: parseIntegerLiteral(
      declaration(source, 'ISOLATED', 'i32'),
      'i32',
      'ISOLATED'
    ),
    SHIELD: parseIntegerLiteral(
      declaration(source, 'SHIELD', 'i32'),
      'i32',
      'SHIELD'
    ),
    PASSED_MG: Object.freeze(
      parseArrayDeclaration(source, 'PASSED_MG', 'i32', [7])
    ),
    PASSED_EG: Object.freeze(
      parseArrayDeclaration(source, 'PASSED_EG', 'i32', [7])
    )
  });
}

function extractShipped(filename) {
  const source = fs.readFileSync(filename || EVAL_RS_PATH, 'utf8');
  return parseRustEvaluator(source);
}

function baselineCenter(shipped) {
  const S = shipped || extractShipped();
  const center = [
    S.MOBILITY.N, S.MOBILITY.B, S.MOBILITY.R, S.MOBILITY.Q,
    S.DOUBLED, S.ISOLATED, S.SHIELD,
    ...S.PASSED_MG.slice(1, 6),
    ...S.PASSED_EG.slice(1, 6)
  ];
  for (const tables of [S.PST, S.PST_EG]) {
    for (const type of H.BASELINE_PST_TYPES) {
      const first = type === 'P' ? 8 : 0;
      const last = type === 'P' ? 55 : 63;
      for (let square = first; square <= last; square++) {
        center.push(tables[type][square]);
      }
    }
  }
  while (center.length < H.TOTAL_PARAMETER_COUNT) center.push(0);
  if (center.length !== H.TOTAL_PARAMETER_COUNT ||
      center.slice(H.BASELINE_PARAMETER_COUNT).some(value => value !== 0)) {
    throw new Error('baseline-center layout drift');
  }
  return center;
}

function regularizationScales() {
  const scales = [
    3, 3, 2, 2, 8, 8, 6,
    30, 30, 30, 30, 30,
    40, 40, 40, 40, 40
  ];
  while (scales.length < H.BASELINE_PARAMETER_COUNT) scales.push(20);
  for (const feature of H.FEATURES) {
    if (feature.family === 'safe-mobility') scales.push(3);
    else if (feature.family === 'advanced-pawn-cramp') scales.push(8);
    else scales.push(20);
  }
  if (scales.length !== H.TOTAL_PARAMETER_COUNT ||
      scales.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new Error('regularization-scale layout drift');
  }
  return scales;
}

function valueDigest(values) {
  if (!Array.isArray(values) ||
      values.some(value => !Number.isSafeInteger(value))) {
    throw new Error('digest values must be safe integers');
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
}

function writeJsonExclusive(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value) + '\n', { flag: 'wx' });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-dir') {
    throw new Error('usage: hce-r3-baseline.js --output-dir <empty-directory>');
  }
  const output = path.resolve(args[1]);
  fs.mkdirSync(output, { recursive: false });
  const center = baselineCenter();
  const scales = regularizationScales();
  writeJsonExclusive(path.join(output, 'center.json'), center);
  writeJsonExclusive(path.join(output, 'scales.json'), scales);
  writeJsonExclusive(path.join(output, 'manifest.json'), {
    schema: 'chessy.hce-r3-baseline.v1',
    source: path.relative(ROOT, EVAL_RS_PATH),
    parameterOrderSha256:
      'f2835e40169d76ec501dea3308f9c96038d390d47649a9ed29af509819dd2251',
    centerValueSha256: valueDigest(center),
    scalesValueSha256: valueDigest(scales)
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('hce-r3-baseline: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EVAL_RS_PATH,
  parseRustEvaluator,
  extractShipped,
  baselineCenter,
  regularizationScales,
  valueDigest
};
