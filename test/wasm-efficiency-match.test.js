/*
 * Contract tests for the formal Rust/WASM efficiency match runner.
 * Run with: node test/wasm-efficiency-match.test.js
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
require('../assets/engine.js');
const Chess = globalThis.Chess;
const MatchProtocol = require('./ai-match-protocol');
const match = require('./wasm-efficiency-match');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'wasm-efficiency-match.js');
const WORKFLOW = path.join(
  ROOT, '.github', 'workflows', 'wasm-efficiency.yml');
const CANDIDATE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function rejects(argv, pattern, label) {
  try {
    match.parseArgs(argv);
    check(false, label, 'did not reject');
  } catch (error) {
    check(pattern.test(error.message) && error.exitCode === 2,
      label, error.message);
  }
}

console.log('frozen WASM efficiency protocol');
const protocol = MatchProtocol.PROTOCOLS.wasmEfficiencyFixedNode;
check(protocol === match.PROTOCOL &&
    protocol.id ===
      'chessy-wasm-fixed-node-efficiency-10000x4x100x180-v1' &&
    protocol.budgetMode === 'nodes' &&
    protocol.budgetValue === 10000 &&
    protocol.maxPlies === 180 &&
    protocol.openings === 100 &&
    protocol.seeds === 4 &&
    protocol.acceptanceClass === 'efficiency-noninferiority' &&
    protocol.lowerBoundThreshold === 0.49 &&
    protocol.engineKind === 'wasm' &&
    protocol.formal === true,
  'protocol predeclares 10000x4x100x180 and a strict >49% lower bound');

console.log('formal shard CLI');
const parsed = match.parseArgs([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--seedbase', '3',
  '--openbase', '80'
]);
check(parsed.seedbase === 3 && parsed.openbase === 80 &&
    parsed.candidateSha === CANDIDATE && parsed.baseSha === BASE &&
    path.isAbsolute(parsed.candidateWasm) &&
    path.isAbsolute(parsed.referenceWasm),
  'accepts one canonical 20-opening/one-seed shard');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--nodes', '9999'
], /unknown option --nodes/,
'budget cannot be changed from the frozen protocol');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--seedbase', '4'
], /must be one of 0, 1, 2, 3/,
'seed coordinate is restricted to the frozen four slots');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--openbase', '10'
], /must be one of 0, 20, 40, 60, 80/,
'opening coordinate is restricted to the five complete shards');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', CANDIDATE
], /distinct candidate and base commits/,
'formal self-comparison is rejected');

console.log('opening and move contracts');
check(match.OPENINGS.length === 100 &&
    match.validateOpenings().length === 0,
  'shared frozen opening manifest has 100 legal distinct positions');
{
  const state = Chess.newGameState();
  const legal = Chess.legalMoves(state);
  const first = legal[0];
  const resolved = match.resolveMove(state, { move: {
    from: first.from, to: first.to, promotion: first.promotion
  } });
  check(resolved && resolved.from === first.from &&
    resolved.to === first.to && resolved.promotion === first.promotion,
  'WASM move shape resolves through the JavaScript arbiter');
  check(match.resolveMove(state, { move: {
    from: first.from, to: first.from, promotion: first.promotion
  } }) == null,
  'an illegal WASM move is not accepted');
}
const openingCheck = cp.spawnSync(
  process.execPath, [SCRIPT, '--check-openings'],
  { cwd: ROOT, encoding: 'utf8' });
check(openingCheck.status === 0 &&
    openingCheck.stdout.includes('100 openings checked, 0 bad'),
  'manifest-only CLI exits before requiring module paths',
  'exit ' + openingCheck.status + ': ' +
    (openingCheck.stdout || '') + (openingCheck.stderr || ''));

console.log('marker-only Actions trigger');
const workflow = fs.readFileSync(WORKFLOW, 'utf8');
check(workflow.includes("paths:\n      - '.github/wasm-efficiency-run'") &&
    workflow.includes('pull_request:') &&
    !workflow.includes('\n  push:') &&
    !workflow.includes('workflow_dispatch:'),
  'only a pull request carrying the marker can launch the 800-game run');
check(workflow.includes(
    'ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'build checks out the exact PR head rather than the synthetic merge commit');
check(workflow.includes(
      'BASE_SHA: 808a2ef3e140718facd384acfebdd8781f1db162') &&
    workflow.includes('seedbase: [0, 1, 2, 3]') &&
    workflow.includes('openbase: [0, 20, 40, 60, 80]') &&
    workflow.includes('node test/ai-match-agg.js "${files[@]}"'),
  'workflow freezes base SHA, 20-shard geometry, and complete aggregation');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
