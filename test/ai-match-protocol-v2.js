/*
 * Prospective manifest identity; match execution is not implemented here.
 * This module is deliberately separate from ai-match-protocol.js so accepted
 * v1 artifacts retain their original identities and verification code.
 */
'use strict';

const OPENINGS_MANIFEST_VERSION = 'chessy-openings-v2-400-cc0';
const OPENINGS_MANIFEST_SHA256 =
  'bda65b3253951863f2b01187b2a44becb8d36d29a7917780f6d920a92f4d7dab';
const OPENINGS_MANIFEST_COUNT = 400;

module.exports = Object.freeze({
  OPENINGS_MANIFEST_VERSION,
  OPENINGS_MANIFEST_SHA256,
  OPENINGS_MANIFEST_COUNT
});
