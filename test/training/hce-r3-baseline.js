#!/usr/bin/env node
/*
 * Extract the frozen Round-2 center and R3 regularization scales directly
 * from the shipped r69 JavaScript evaluator. Development/training only.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./hce-r3-features');

const ROOT = path.join(__dirname, '..', '..');
const AI_PATH = path.join(ROOT, 'assets', 'ai.js');

function extractShipped(filename) {
  const source = fs.readFileSync(filename || AI_PATH, 'utf8');
  const declarations = [
    /const VALUES_MG = \{[^}]*\};/,
    /const VALUES_EG = \{[^}]*\};/,
    /const PST = \{[\s\S]*?\n  \};/,
    /const PST_EG = \{[\s\S]*?\n  \};/,
    /const PHASE = \{[^}]*\};/,
    /const PHASE_MAX = \d+;/,
    /const MOBILITY = \{[^}]*\};/,
    /const DOUBLED = \d+, ISOLATED = \d+, SHIELD = \d+;/,
    /const PASSED_MG = \[[^\]]*\];/,
    /const PASSED_EG = \[[^\]]*\];/
  ].map(function (pattern) {
    const match = source.match(pattern);
    if (!match) {
      throw new Error('could not extract r69 evaluator declaration ' + pattern);
    }
    return match[0];
  }).join('\n');
  return new Function(declarations +
    '\nreturn {VALUES_MG,VALUES_EG,PST,PST_EG,PHASE,PHASE_MAX,' +
    'MOBILITY,DOUBLED,ISOLATED,SHIELD,' +
    'PASSED_MG,PASSED_EG};')();
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
    source: path.relative(ROOT, AI_PATH),
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
  AI_PATH,
  extractShipped,
  baselineCenter,
  regularizationScales,
  valueDigest
};
