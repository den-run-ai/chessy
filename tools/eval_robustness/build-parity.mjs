/** Compare every compiled static score to the registered native evaluator arrays. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const [buildDir, study, output] = process.argv.slice(2);
if (!buildDir || !study || !output || process.argv.length !== 5) {
  throw new Error('usage: node build-parity.mjs BUILD_DIR RESTORED_REFIT_STUDY OUTPUT.json');
}
const identity = bytes => ({
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const readChecked = (filename, expected) => {
  const bytes = fs.readFileSync(filename);
  assert.deepEqual(identity(bytes), expected, filename);
  return bytes;
};
const report = JSON.parse(fs.readFileSync(path.join(buildDir, 'build.json')));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'eval/eval-production-v1/REFIT-RESULTS.json'))).files;
const sample = name => readChecked(path.join(study, name), inventory[name]);
const fens = sample('packed/validation.fens.txt').toString('utf8').trimEnd().split('\n');
const hce = sample('hce.validation.i32');
const learned = sample('refit-no-pawn.validation.i32');
assert.equal(fens.length * 4, hce.length);
assert.equal(learned.length, hce.length);
assert.ok(Number.isInteger(report.numerator) && report.numerator >= 0 && report.numerator <= 16);
assert.equal(report.denominator, 16);
const loaderPath = path.join(root, 'assets/wasm-engine.js');
const engine = require(loaderPath).loadSync(readChecked(path.join(buildDir, 'candidate.wasm'), report.candidate));
let negativeFraction = 0, positiveFraction = 0;
for (const [i, fen] of fens.entries()) {
  const base = hce.readInt32LE(4 * i);
  const product = (learned.readInt32LE(4 * i) - base) * report.numerator;
  const rem = product % report.denominator;
  if (rem < 0) negativeFraction++;
  if (rem > 0) positiveFraction++;
  const expected = base + Math.trunc(product / report.denominator);
  assert.equal(engine.evaluate(fen), expected, 'score differs at validation row ' + i);
}
assert.equal(engine.memoryBytes(), 26607616);
const result = { ...report, loader: identity(fs.readFileSync(loaderPath)),
  memoryBytes: engine.memoryBytes(), validationFens: inventory['packed/validation.fens.txt'],
  hceScores: inventory['hce.validation.i32'], learnedScores: inventory['refit-no-pawn.validation.i32'],
  positions: fens.length, negativeFraction, positiveFraction, mismatches: 0 };
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({ positions: fens.length, negativeFraction, positiveFraction, mismatches: 0 }));
