/*
 * Canonical identities shared by the match runner and shard aggregator.
 * Changing the frozen opening list requires a new manifest version and hash;
 * changing protocol semantics requires a new protocol ID.
 */
'use strict';

const OPENINGS_MANIFEST_VERSION = 'chessy-openings-v1';
const OPENINGS_MANIFEST_SHA256 =
  'ac8a1c3e5776c6cf3989af3b219085eb5c6c56124757d326a76611dd7e5d25de';
const OPENINGS_MANIFEST_COUNT = 100;

// Canonical RNG seed for one (opening, seed-slot) pair. This mapping is part of
// the protocol evidence: both colours use the same derived seed, and the
// aggregator re-derives it so artifacts produced by an older/stale mapping
// cannot be accepted under the current protocol identity.
function deriveGameSeed(opening, seed) {
  return (opening * 977 + seed * 7919 + 1) | 0;
}

const PROTOCOLS = Object.freeze({
  formalFixedNode: Object.freeze({
    id: 'chessy-fixed-node-strict-strength-10000x4x100x180-v1',
    budgetMode: 'nodes',
    budgetValue: 10000,
    maxPlies: 180,
    openings: OPENINGS_MANIFEST_COUNT,
    seeds: 4,
    acceptanceClass: 'strict-strength',
    lowerBoundThreshold: 0.50,
    formal: true
  }),
  wasmEfficiencyFixedNode: Object.freeze({
    id: 'chessy-wasm-fixed-node-efficiency-10000x4x100x180-v1',
    budgetMode: 'nodes',
    budgetValue: 10000,
    maxPlies: 180,
    openings: OPENINGS_MANIFEST_COUNT,
    seeds: 4,
    acceptanceClass: 'efficiency-noninferiority',
    lowerBoundThreshold: 0.49,
    engineKind: 'wasm',
    formal: true
  }),
  nodeDiagnostic: Object.freeze({
    id: 'chessy-fixed-node-diagnostic-v1',
    budgetMode: 'nodes',
    acceptanceClass: 'diagnostic-noninferiority',
    lowerBoundThreshold: 0.49,
    formal: false
  }),
  timeDiagnostic: Object.freeze({
    id: 'chessy-equal-time-diagnostic-v1',
    budgetMode: 'time',
    acceptanceClass: 'diagnostic-noninferiority',
    lowerBoundThreshold: 0.49,
    formal: false
  })
});
const PROTOCOL_BY_ID = Object.freeze(Object.fromEntries(
  Object.values(PROTOCOLS).map(function (protocol) {
    return [protocol.id, protocol];
  })
));

module.exports = Object.freeze({
  OPENINGS_MANIFEST_VERSION,
  OPENINGS_MANIFEST_SHA256,
  OPENINGS_MANIFEST_COUNT,
  deriveGameSeed,
  PROTOCOLS,
  PROTOCOL_BY_ID
});
