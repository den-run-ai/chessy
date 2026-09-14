/*
 * Loader for the literal, CC0, 400-opening v2 manifest. The exact file bytes
 * are part of the protocol identity; structural and chess-rule validation is
 * covered by ai-match-openings-v2.test.js. Execution is still pending #156.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const MatchProtocol = require('./ai-match-protocol-v2');

const MANIFEST_PATH = path.join(__dirname, '..', 'eval', 'match-v2',
  'openings.json');
const bytes = fs.readFileSync(MANIFEST_PATH);
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
if (digest !== MatchProtocol.OPENINGS_MANIFEST_SHA256) {
  throw new Error('v2 opening manifest changed without a new protocol hash ' +
    '(got ' + digest + ')');
}

let manifest;
try {
  manifest = JSON.parse(bytes.toString('utf8'));
} catch (error) {
  throw new Error('cannot parse v2 opening manifest: ' + error.message);
}
if (!manifest || manifest.schema !== 'chessy-opening-manifest-v2' ||
    manifest.version !== MatchProtocol.OPENINGS_MANIFEST_VERSION ||
    !Array.isArray(manifest.openings) ||
    manifest.openings.length !== MatchProtocol.OPENINGS_MANIFEST_COUNT) {
  throw new Error('v2 opening manifest has the wrong schema, version or count');
}

const ids = new Set();
for (let index = 0; index < manifest.openings.length; index++) {
  const opening = manifest.openings[index];
  if (!opening || opening.index !== index ||
      !/^[A-E]\d\d$/.test(opening.id) || opening.eco !== opening.id ||
      typeof opening.name !== 'string' || !opening.name ||
      typeof opening.pgn !== 'string' || !opening.pgn ||
      typeof opening.fen !== 'string' || !opening.fen ||
      ids.has(opening.id)) {
    throw new Error('invalid v2 opening record at index ' + index);
  }
  ids.add(opening.id);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
  return Object.freeze(value);
}

module.exports = Object.freeze({
  path: MANIFEST_PATH,
  sha256: digest,
  manifest: deepFreeze(manifest),
  openings: manifest.openings
});
