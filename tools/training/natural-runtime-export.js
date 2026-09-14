#!/usr/bin/env node
'use strict';

// Research-only inverse of the frozen 753+6 affine surface. Fitted numbers are
// never stored here. The CLI requires an externally authenticated passing test
// report and writes only to a separate private checkout.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Baseline = require('../../test/training/hce-r3-baseline');

const ROOT = path.resolve(__dirname, '../..');
const TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PAWN_ANCHOR = '            let rank = square / 8;\n            let has_left_pawn';
const PAWN_CODE = `            // Count each geometric pawn-to-enemy-piece edge, including pinned
            // pawns and two pawns attacking the same target. No king/pawn targets.
            let attack_rank = rank as i32 + if color == Color::White { -1 } else { 1 };
            if attack_rank >= 0 && attack_rank < 8 {
                for file_delta in [-1_i32, 1] {
                    let attack_file = file as i32 + file_delta;
                    if attack_file >= 0 && attack_file < 8 {
                        let target = board[(attack_rank * 8 + attack_file) as usize];
                        if engine::piece_color(target) == Some(engine::opposite(color)) {
                            let attack_class = match engine::piece_type(target) {
                                Some(PieceType::Knight | PieceType::Bishop) => Some(0),
                                Some(PieceType::Rook) => Some(1),
                                Some(PieceType::Queen) => Some(2),
                                _ => None,
                            };
                            if let Some(class) = attack_class {
                                midgame += sign * PAWN_ATTACK_MG[class];
                                endgame += sign * PAWN_ATTACK_EG[class];
                            }
                        }
                    }
                }
            }
`;

function declarationPattern(name) {
  return new RegExp('^const ' + name + ': ([^=]+)= [\\s\\S]*?;\\n', 'gm');
}

function replaceDeclaration(source, name, expression) {
  const pattern = declarationPattern(name);
  const matches = Array.from(source.matchAll(pattern));
  if (matches.length !== 1) throw new Error(name + ': expected exactly one Rust declaration');
  return source.replace(pattern, 'const ' + name + ': ' + matches[0][1] + '= ' + expression + ';\n');
}

function array(values) {
  if (!Array.isArray(values[0])) return '[' + values.join(', ') + ']';
  return '[\n' + values.map(row => '    [\n' + Array.from({length: 8}, (_, rank) =>
    '        ' + row.slice(rank * 8, rank * 8 + 8).join(', ') + ',').join('\n') + '\n    ],').join('\n') + '\n]';
}

function validateWeights(weights, center) {
  if (!Array.isArray(weights) || weights.length !== 965 || weights.some(x => !Number.isSafeInteger(x))) {
    throw new Error('expected exactly 965 integer weights');
  }
  weights.forEach((weight, index) => {
    let lower, upper;
    if (index < 17) [lower, upper] = [Math.ceil(0.75 * center[index]), Math.floor(1.25 * center[index])];
    else if (index < 753) [lower, upper] = [center[index] - 10, center[index] + 10];
    else if (index < 759) [lower, upper] = [0, 20];
    else [lower, upper] = [0, 0];
    if (weight < lower || weight > upper) throw new Error('weight ' + index + ' violates frozen integer bounds');
  });
}

function exportRust(source, weights) {
  if (source.includes('PAWN_ATTACK_')) throw new Error('source already contains pawn-attack integration');
  const baseline = Baseline.parseRustEvaluator(source);
  const center = Baseline.baselineCenter(baseline);
  validateWeights(weights, center);
  let output = source;
  const mobility = TYPES.map(type => baseline.MOBILITY[type]);
  weights.slice(0, 4).forEach((value, index) => { mobility[index + 1] = value; });
  output = replaceDeclaration(output, 'MOBILITY', array(mobility));
  for (const [name, index] of [['DOUBLED', 4], ['ISOLATED', 5], ['SHIELD', 6]]) {
    output = replaceDeclaration(output, name, String(weights[index]));
  }
  for (const [name, base] of [['PASSED_MG', 7], ['PASSED_EG', 12]]) {
    const values = [...baseline[name]];
    values.splice(1, 5, ...weights.slice(base, base + 5));
    output = replaceDeclaration(output, name, array(values));
  }
  let index = 17;
  for (const name of ['PST_MG', 'PST_EG']) {
    const tables = TYPES.map(type => [...baseline[name][type]]);
    TYPES.forEach((type, piece) => {
      for (let square = type === 'P' ? 8 : 0; square <= (type === 'P' ? 55 : 63); square++) {
        tables[piece][square] = weights[index++];
      }
    });
    output = replaceDeclaration(output, name, array(tables));
  }
  assert.equal(index, 753);
  const extracted = Baseline.parseRustEvaluator(output);
  assert.deepEqual(Baseline.baselineCenter(extracted).slice(0, 753), weights.slice(0, 753));
  for (const name of ['VALUES_MG', 'VALUES_EG', 'PHASE', 'PHASE_MAX']) assert.deepEqual(extracted[name], baseline[name]);
  for (const stage of ['MG', 'EG']) {
    for (const square of [0, 1, 2, 3, 4, 5, 6, 7, 56, 57, 58, 59, 60, 61, 62, 63]) {
      assert.equal(extracted['PST_' + stage].P[square], baseline['PST_' + stage].P[square]);
    }
    for (const rank of [0, 6]) assert.equal(extracted['PASSED_' + stage][rank], baseline['PASSED_' + stage][rank]);
  }
  for (const type of ['P', 'K']) assert.equal(extracted.MOBILITY[type], baseline.MOBILITY[type]);

  if (output.split(PAWN_ANCHOR).length !== 2) throw new Error('pawn loop anchor missing or ambiguous');
  output = output.replace(PAWN_ANCHOR, '            let rank = square / 8;\n' + PAWN_CODE + '            let has_left_pawn');
  const constants = '\n// Research direct pawn attacks: minor (N/B), rook, queen; White POV.\n' +
    'const PAWN_ATTACK_MG: [i32; 3] = ' + array([weights[753], weights[755], weights[757]]) + ';\n' +
    'const PAWN_ATTACK_EG: [i32; 3] = ' + array([weights[754], weights[756], weights[758]]) + ';\n';
  output = output.replace('const PHASE_MAX:', constants + '\nconst PHASE_MAX:');
  return output;
}

function authenticatedJson(filename, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('expected external SHA-256 for ' + filename);
  const bytes = fs.readFileSync(filename);
  if (sha256(bytes) !== expected) throw new Error('SHA-256 mismatch for ' + filename);
  return JSON.parse(bytes);
}

function cli(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!/^--[a-z0-9-]+$/.test(name) || args[name] || !argv[index + 1]) throw new Error('invalid or duplicate argument: ' + name);
    args[name] = argv[index + 1];
  }
  const required = ['baseline', 'baseline-sha256', 'selection', 'selection-sha256', 'test-report', 'test-report-sha256', 'output', 'receipt'];
  if (Object.keys(args).length !== required.length || required.some(name => !args['--' + name])) {
    throw new Error('required flags: ' + required.map(name => '--' + name).join(' '));
  }
  const selection = authenticatedJson(args['--selection'], args['--selection-sha256']);
  const report = authenticatedJson(args['--test-report'], args['--test-report-sha256']);
  if (selection.schema !== 'chessy.natural-pilot-frozen-selection.v1' ||
      report.schema !== 'chessy.natural-pilot-fit-report.v1' || report.status !== 'test-completed-research-only' ||
      report.researchOnly !== true || report.testOpened !== true || report.scaleRecommended !== true ||
      report.shippingCandidateEmitted !== false || report.eloOrTimeClaimAllowed !== false ||
      !Array.isArray(report.stopReasons) || report.stopReasons.length !== 0 ||
      report.frozenSelectionSha256 !== args['--selection-sha256']) {
    throw new Error('a passing, research-only frozen-selection test report is required');
  }
  assert.deepEqual(report.selected, selection.report.selected);
  if (!['constrained753', 'constrained753-plus-pawn-attacks'].includes(report.selected.surface)) throw new Error('unsupported selected surface');
  const source = fs.readFileSync(args['--baseline'], 'utf8');
  const sourceSha = sha256(source);
  if (sourceSha !== args['--baseline-sha256'] || !Object.entries(selection.inputSha256).some(([filename, hash]) =>
    filename.endsWith('/experiments/wasm/src/eval.rs') && hash === sourceSha)) throw new Error('baseline does not match frozen fit');
  const weights = selection.researchWeights;
  if (sha256(JSON.stringify(weights)) !== report.selected.weightsSha256) throw new Error('selected weights hash mismatch');
  if (report.selected.surface === 'constrained753' && weights.slice(753).some(x => x !== 0)) throw new Error('753 surface has expanded weights');
  const output = exportRust(source, weights);
  const outputPath = path.resolve(args['--output']);
  const parent = fs.realpathSync(path.dirname(outputPath));
  if (parent === ROOT || parent.startsWith(ROOT + path.sep)) throw new Error('fitted source must be outside the research checkout');
  if (fs.lstatSync(outputPath).isSymbolicLink()) throw new Error('output must not be a symbolic link');
  if (fs.existsSync(args['--receipt'])) throw new Error('receipt already exists');
  const receipt = {
    schema: 'chessy.natural-runtime-export.v1', researchOnly: true,
    selectionSha256: args['--selection-sha256'], testReportSha256: args['--test-report-sha256'],
    weightsSha256: report.selected.weightsSha256, baselineRustSha256: sourceSha,
    outputRustSha256: sha256(output), output: outputPath,
    exporterSha256: sha256(fs.readFileSync(__filename)),
    mappedParameters: 759, fixedExpandedParameters: 206,
    integration: 'one count per geometric pawn-to-enemy-minor/rook/queen edge; tapered before fixed mop-up',
    productionIntegrationAllowed: false, eloOrTimeClaimAllowed: false
  };
  const fd = fs.openSync(outputPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const target = fs.fstatSync(fd);
    const original = fs.statSync(args['--baseline']);
    if (!target.isFile() || target.nlink !== 1 || (target.dev === original.dev && target.ino === original.ino)) {
      throw new Error('output must be a distinct regular file, without hard links');
    }
    if (fs.readFileSync(fd, 'utf8') !== source) throw new Error('output must contain the pristine baseline evaluator');
    const named = fs.lstatSync(outputPath);
    if (named.isSymbolicLink() || named.dev !== target.dev || named.ino !== target.ino) throw new Error('output identity changed');
    const bytes = Buffer.from(output);
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, written);
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(args['--receipt'], JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}

module.exports = {exportRust, validateWeights, sha256, cli};
if (require.main === module) {
  try { cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
