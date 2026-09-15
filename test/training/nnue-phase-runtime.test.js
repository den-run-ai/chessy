'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Probe = require('../../tools/training/nnue-phase-runtime');
const Reference = require('./h4-v3-reference');
const ROOT = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(ROOT, 'experiments/wasm/src/eval.rs'), 'utf8');
const template = fs.readFileSync(path.join(ROOT, 'tools/training/nnue-phase-runtime.rs.in'), 'utf8');
const originalBuild = fs.readFileSync(path.join(ROOT, 'experiments/wasm/build.sh'), 'utf8');
const before = Probe.sha(source);
// Timing fixtures must support game search; raw static parity also deliberately
// retains the historical adjacent-king mop-up probes separately.
for (const fen of Probe.FENS) {
  const features = Reference.parseFen(fen).white;
  const kingSquares = [5, 11].map(channel => features.filter(index => Math.floor(index / 64) === channel));
  assert(kingSquares.every(squares => squares.length === 1));
  const [white, black] = kingSquares.map(squares => squares[0] % 64);
  assert(Math.max(Math.abs(Math.floor(white / 8) - Math.floor(black / 8)), Math.abs(white % 8 - black % 8)) > 1,
    'adjacent kings cannot be a search timing fixture');
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chessy-nnue-mechanism-'));
try {
  for (const hidden of [4, 8]) {
    const fixture = Probe.synthetic(hidden);
    assert.equal(fixture.bytes.length, hidden === 4 ? 6200 : 12392);
    assert.deepEqual(Probe.synthetic(hidden).bytes, fixture.bytes);
    // Frozen authored RNG sequence; changing its seed/config changes identity.
    assert.equal(Probe.sha(fixture.bytes), hidden === 4 ?
      '63431955cf527545aea1d8cd91ae68fa9c25c0748b3d9ed5af528d3c13a69c5c' :
      '0849a2fe7e02d83683e18e9a1f6edaf5bcfa51bd431ca92a4bbac17324149c45');
    for (const implementation of ['refresh', 'fused']) {
      const output = path.join(tmp, hidden + '-' + implementation);
      const receipt = Probe.prepare(output, hidden, implementation);
      assert.equal(receipt.syntheticOnly, true);
      assert.equal(receipt.fitEligible, false);
      assert.equal(receipt.productionIntegrationAllowed, false);
      assert.equal(receipt.strengthClaimAllowed, false);
      assert.equal(receipt.parameterCount, fixture.metadata.parameters);
      assert.equal(receipt.parameterBytes, fixture.bytes.length);
      assert.equal(receipt.schema, 'chessy.nnue-phase-synthetic-build.v2');
      assert.equal(receipt.memoryPolicy.baselineBytes, 26542080);
      assert.equal(receipt.memoryPolicy.candidateBytes, 26607616);
      assert.equal(receipt.memoryPolicy.additionalBytes, 65536);
      assert.equal(receipt.memoryPolicy.productionCapChanged, false);
      const researchBuild = fs.readFileSync(path.join(output, 'build.sh'), 'utf8');
      assert(researchBuild.includes('\nMEMORY_BYTES=26607616\n'));
      assert(!researchBuild.includes('\nMEMORY_BYTES=26542080\n'));
      assert.equal(researchBuild, Probe.researchBuild(originalBuild));
      const rust = fs.readFileSync(path.join(output, 'src/eval.rs'), 'utf8');
      assert(!rust.includes('{{'));
      assert.equal((rust.match(/pub fn evaluate\(/g) || []).length, 1);
      assert.equal((rust.match(/fn evaluate_hce\(/g) || []).length, 1);
      const generatedModel = Reference.loadModel(fs.readFileSync(path.join(output, 'synthetic.bin')),
        JSON.parse(fs.readFileSync(path.join(output, 'synthetic.json'))));
      for (const fen of Probe.PARITY_FENS) assert(rust.includes(`(b"${fen}", ${Reference.infer(generatedModel, fen, 0)}),`));
      if (implementation === 'fused') assert(rust.includes('nnue_finish(nnue_acc, position.turn, phase)'));
      else assert(rust.includes('score + nnue_refresh(position)'));
      assert.throws(() => Probe.prepare(output, hidden, implementation), /EEXIST/);
      assert.throws(() => Probe.measure(output, path.join(tmp, 'result.json')), /ENOENT/);
      const receiptPath = path.join(output, 'synthetic-receipt.json');
      fs.writeFileSync(receiptPath, JSON.stringify({...receipt, emitted: []}));
      assert.throws(() => Probe.measure(output, path.join(tmp, 'result.json')), /complete source inventory/);
      fs.writeFileSync(receiptPath, JSON.stringify({...receipt, memoryPolicy: {...receipt.memoryPolicy, candidateBytes: 26542080}}));
      assert.throws(() => Probe.measure(output, path.join(tmp, 'result.json')), /research memory policy differs/);
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      const file = path.join(output, receipt.emitted[0].path);
      fs.appendFileSync(file, '\n');
      assert.throws(() => Probe.measure(output, path.join(tmp, 'result.json')), /generated source changed/);
    }
    assert.throws(() => Probe.render(source.replace('    score\n}', '    score + 1\n}'), template, fixture.model, 'fused'), /return anchor/);
    assert.throws(() => Probe.render(source.replace('        let color = engine::piece_color(piece).unwrap();', ''), template, fixture.model, 'fused'), /anchor/);
    assert.throws(() => Probe.render(source + '\nconst NNUE_X: i32 = 0;', template, fixture.model, 'refresh'), /already contains/);
  }
  assert.throws(() => Probe.synthetic(16), /hidden/);
  assert.throws(() => Probe.researchBuild(originalBuild.replace('MEMORY_BYTES=26542080', 'MEMORY_BYTES=26542892')), /anchor/);
  assert.throws(() => Probe.researchBuild(originalBuild + '\nMEMORY_BYTES=26542080\n'), /anchor/);
  assert.throws(() => Probe.outsideRepository(path.join(ROOT, 'unsafe-output')), /outside a Git checkout/);
  const symlink = path.join(tmp, 'linked');
  fs.symlinkSync(ROOT, symlink);
  assert.throws(() => Probe.outsideRepository(path.join(symlink, 'unsafe-output')), /canonical/);
  assert.equal(Probe.sha(fs.readFileSync(path.join(ROOT, 'experiments/wasm/src/eval.rs'))), before);
  assert.equal(fs.readFileSync(path.join(ROOT, 'experiments/wasm/build.sh'), 'utf8'), originalBuild);
  assert.equal(Probe.median([5, 1, 3, 7]), 4);
  assert.throws(() => Probe.median([]), /empty/);
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
console.log('PASS: synthetic NNUE export identity, isolation, no-replace, mutation, and authored parity fixture tests');
