#!/usr/bin/env node
/* Narrow stdin bridge to the canonical Label/E4 validators. No files emitted. */
'use strict';

const fs = require('fs');
const path = require('path');
const Label = require('./label-stockfish');
const Corpus = require('./corpus');

function validate(request) {
  if (!request || request.schema !== 'chessy.nnue-selection-admission.v1' ||
      typeof request.manifestPath !== 'string' ||
      !path.isAbsolute(request.manifestPath) ||
      typeof request.certificationPath !== 'string' ||
      !path.isAbsolute(request.certificationPath) ||
      typeof request.manifestText !== 'string' ||
      typeof request.certificationText !== 'string' ||
      typeof request.sampleOnly !== 'boolean') {
    throw new Error('invalid canonical selection admission request');
  }
  const contracts = Label.loadFrozenContracts();
  const manifest = JSON.parse(request.manifestText);
  if (!Array.isArray(manifest.shards) || !manifest.shards.length ||
      !manifest.shards[0] || typeof manifest.shards[0].path !== 'string') {
    throw new Error('selection manifest has no shard inventory');
  }
  const result = Label.validateSelectionManifest(
    manifest, request.manifestPath,
    path.resolve(path.dirname(request.manifestPath), manifest.shards[0].path),
    contracts,
    {
      sampleOnly: request.sampleOnly,
      certificationSnapshot: {
        path: request.certificationPath, text: request.certificationText
      }
    }
  );
  return {
    schema: 'chessy.nnue-selection-admission.v1',
    manifestSha256: Corpus.sha256(request.manifestText),
    certificationSha256: result.certification.sha256,
    selectionContractSha256: manifest.adapter.selectionContractSha256,
    teacherSha256: contracts.teacherSha256,
    heldoutSha256: contracts.heldoutSha256,
    corpusSha256: contracts.corpusSha256,
    certificationClusters: [...result.certification.clusters].sort(),
    certificationFamilies: [...result.certification.positionFamilies].sort(),
    sampleOnly: result.sampleOnly
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('this bridge accepts stdin only');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(validate(request)) + '\n');
  } catch (error) {
    process.stderr.write('canonical selection admission: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { validate };
