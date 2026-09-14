/*
 * Frozen v2 execution profiles. Neither profile alone authorizes a merge:
 * source/build reproduction, correctness and product-device gates are separate.
 * This module is deliberately separate from ai-match-protocol.js so accepted
 * v1 artifacts retain their original identities and verification code.
 */
'use strict';

const OPENINGS_MANIFEST_VERSION = 'chessy-openings-v2-400-cc0';
const OPENINGS_MANIFEST_SHA256 =
  'bda65b3253951863f2b01187b2a44becb8d36d29a7917780f6d920a92f4d7dab';
const OPENINGS_MANIFEST_COUNT = 400;
const PROFILES = Object.freeze({
  'evaluator-easy': Object.freeze({
    id: 'chessy-evaluator-easy-10000x400x180-v2',
    nodes: 10000, lowerBoundThreshold: 0.50,
    acceptanceClass: 'evaluator-strict-strength'
  }),
  'selective-hard': Object.freeze({
    id: 'chessy-selective-hard-230000x400x180-v2',
    nodes: 230000, lowerBoundThreshold: 0.49,
    acceptanceClass: 'selective-search-conditional-noninferiority'
  })
});
const CONTRACT = Object.freeze({
  schema: 'chessy-match-v2-registration-1',
  estimator: 'opening-pair-student-t-lcb95-v1',
  maxPlies: 180, maxDepth: 30, quiesce: true,
  shards: 20, openingsPerShard: 20, games: 800,
  abi: 2, budgetMode: 'nodes',
  selection: 'all-400-manifest-openings-in-order-both-colors-no-seeds',
  adjudication: 'rules-terminal-before-ply-cap-otherwise-draw',
  admission: 'diagnostic-only-separate-production-gates-required'
});

module.exports = Object.freeze({
  OPENINGS_MANIFEST_VERSION,
  OPENINGS_MANIFEST_SHA256,
  OPENINGS_MANIFEST_COUNT, PROFILES, CONTRACT
});
