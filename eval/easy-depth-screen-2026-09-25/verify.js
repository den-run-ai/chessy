#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { analyze } = require('./analyze.js');

// Post-screen enforcement of PLAN.md's existing input contract. Source hashes
// were checked against afde059/cf38d6f in registration.bundle, not inferred
// from whichever two receipts the caller supplies. The original estimator,
// selection rule and analyze.js remain unchanged.
const COMMON = Object.freeze({
  schema: 'chessy.level-screen.exploratory.v1.run',
  level: 'easy', anchor: 1500, openings: 'even', concurrency: 3,
  host: Object.freeze({
    node: 'v24.19.0', cpu: 'INTEL(R) XEON(R) PLATINUM 8573C', cpus: 9,
    os: 'Linux', release: '6.18.44', arch: 'x64'
  }),
  stockfishSha256: '6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9',
  wasmSha256: '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f',
  loaderSha256: 'ce338ed49aef859aebb930e5895681b77dfa588d710f8b7131b4220ef903cf01',
  rulesSha256: '897bf4047c301b125bebff1d587c9407b9a8a5b5501ea38254ceff028c9ca8fa',
  bridgeSha256: '91c6eebb6693dab7fb342f4f7b6deec7e8688fa0535164fb42f414f519ae9d43',
  openingsSha256: '31128460a2c5406b7c92ab9c8c0455b322ca6437960f64a29cf6f7a6b8055a27',
  openingProtocolSha256: 'd9613facd3c310699481dea1d5a58e6f10d3c2be4de12911c8dcb3928da65c63',
  runnerSha256: 'b24a35f6b37cb51a05b60c34b40492c780fee0462eab6f43eda247429d85cd0d'
});
const PRESETS = Object.freeze({
  control: '561f6b80ea9f7008f2b42949191eaca7343cb66b138a5c45a4e275d2ed4c797f',
  candidate: '084f631e9fb0be0db3358f656570e178112ee19358a3f9d97a78f55c9ae0c776'
});

function validateIdentities(report) {
  for (const role of ['control', 'candidate']) {
    const receipt = report[role].receipt;
    assert.equal(receipt.identityComplete, true, role + ' needs a complete identity');
    assert.deepEqual(receipt.identity, { ...COMMON, presetsSha256: PRESETS[role] },
      role + ' does not match the preregistered inputs');
  }
  return report;
}

function verify(controlFile, candidateFile) {
  // analyze() returns its replay-verified receipt identities without printing.
  // Validate that same returned report before any result can leave this API;
  // do not reopen paths and accidentally validate a different set of bytes.
  return validateIdentities(analyze(controlFile, candidateFile));
}

if (require.main === module) {
  assert.equal(process.argv.length, 4, 'usage: verify.js <control> <candidate>');
  console.log(JSON.stringify(verify(process.argv[2], process.argv[3]), null, 2));
}

module.exports = { verify, validateIdentities };
