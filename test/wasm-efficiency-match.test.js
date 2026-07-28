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
const HARNESS = 'c'.repeat(40);
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

function throws(callback, pattern, label) {
  try {
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    check(pattern.test(error.message), label, error.message);
  }
}

console.log('frozen WASM efficiency protocol');
const protocol = MatchProtocol.PROTOCOLS.wasmEfficiencyFixedNode;
check(protocol === match.PROTOCOL &&
    protocol.id ===
      'chessy-wasm-fixed-node-efficiency-10000x4x100x180-v2' &&
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
  '--harness-sha', HARNESS,
  '--seedbase', '3',
  '--openbase', '80'
]);
check(parsed.seedbase === 3 && parsed.openbase === 80 &&
    parsed.candidateSha === CANDIDATE && parsed.baseSha === BASE &&
    parsed.harnessSha === HARNESS &&
    path.isAbsolute(parsed.candidateWasm) &&
    path.isAbsolute(parsed.referenceWasm),
  'accepts one canonical 20-opening/one-seed shard');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--harness-sha', HARNESS,
  '--nodes', '9999'
], /unknown option --nodes/,
'budget cannot be changed from the frozen protocol');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--harness-sha', HARNESS,
  '--seedbase', '4'
], /must be one of 0, 1, 2, 3/,
'seed coordinate is restricted to the frozen four slots');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', BASE,
  '--harness-sha', HARNESS,
  '--openbase', '10'
], /must be one of 0, 20, 40, 60, 80/,
'opening coordinate is restricted to the five complete shards');
rejects([
  '--candidate-wasm', 'candidate.wasm',
  '--reference-wasm', 'reference.wasm',
  '--candidate-sha', CANDIDATE,
  '--base-sha', CANDIDATE,
  '--harness-sha', HARNESS
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

console.log('per-search fixed-node enforcement');
const boundedResult = {
  move: null,
  score: 0,
  depth: 5,
  attemptedDepth: 6,
  nodes: protocol.budgetValue,
  qnodes: 1000,
  cutoffs: 0,
  researches: 0,
  stopReason: 'node-limit'
};
match.assertFixedNodeResult(
  boundedResult, 'candidate WASM', protocol.budgetValue,
  Chess.START_FEN, 0);
check(true, 'accepts an exact fixed-node result');
match.assertFixedNodeResult(Object.assign({}, boundedResult, {
  nodes: 321,
  qnodes: 100,
  score: 999999,
  stopReason: 'mate',
  attemptedDepth: null
}), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
check(true, 'accepts a legitimate early mate');
match.assertFixedNodeResult(Object.assign({}, boundedResult, {
  nodes: 9999,
  qnodes: 1000,
  depth: 30,
  attemptedDepth: null,
  stopReason: 'max-depth'
}), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
check(true, 'accepts a complete depth-30 search below the node budget');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    nodes: protocol.budgetValue + 1
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 3);
}, /candidate WASM.*game ply 4.*10000-node budget.*10001/,
'rejects a measured search that exceeds the node budget');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    nodes: 9999
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
}, /reported node-limit after 9999 nodes/,
'rejects a premature node-limit stop');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    stopReason: 'time-limit'
  }), 'reference WASM', protocol.budgetValue, Chess.START_FEN, 1);
}, /reference WASM.*game ply 2.*time-limit/,
'rejects a time stop in a fixed-node search');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    nodes: 9999,
    qnodes: 10000,
    depth: 30,
    attemptedDepth: null,
    stopReason: 'max-depth'
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
}, /invalid qnodes 10000 for 9999 nodes/,
'rejects inconsistent node counters');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    nodes: 9999,
    qnodes: 1000,
    depth: 29,
    attemptedDepth: null,
    stopReason: 'max-depth'
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
}, /inconsistent max-depth completion/,
'rejects an incoherent max-depth stop');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    nodes: 321,
    qnodes: 100,
    score: 0,
    stopReason: 'mate',
    attemptedDepth: null
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
}, /inconsistent mate completion/,
'rejects a self-reported mate without a mate score');
throws(function () {
  match.assertFixedNodeResult(Object.assign({}, boundedResult, {
    attemptedDepth: 8
  }), 'candidate WASM', protocol.budgetValue, Chess.START_FEN, 0);
}, /inconsistent node-limit depth/,
'rejects an incoherent attempted depth at the node limit');

function scriptedEngine(badCall, mutation) {
  let calls = 0;
  return {
    search: function (fen, options) {
      calls++;
      if (options.nodeLimit !== protocol.budgetValue ||
          options.timeMs !== 0) {
        throw new Error('test engine received the wrong budget');
      }
      const state = Chess.parseFen(fen);
      const move = Chess.legalMoves(state)[0];
      const result = Object.assign({}, boundedResult, { move: move });
      if (calls === badCall) Object.assign(result, mutation);
      return result;
    }
  };
}

{
  const candidate = scriptedEngine(2, {
    nodes: protocol.budgetValue + 1
  });
  const reference = scriptedEngine(Infinity, {});
  throws(function () {
    match.playGame(
      [candidate, candidate], match.OPENINGS[0][1], candidate,
      { moves: 0, depthGe5: 0, depths: {} });
  }, /candidate WASM.*game ply 2.*10001/,
  'checks the candidate again after its first valid measured search');
  // Keep a distinct candidate identity so the engine under test is labelled
  // reference even though it plays both colours in this focused contract test.
  const candidateIdentity = scriptedEngine(Infinity, {});
  const lateBadReference = scriptedEngine(2, {
    stopReason: 'time-limit'
  });
  throws(function () {
    match.playGame(
      [lateBadReference, lateBadReference], match.OPENINGS[0][1],
      candidateIdentity, { moves: 0, depthGe5: 0, depths: {} });
  }, /reference WASM.*game ply 2.*time-limit/,
  'checks the reference again after its first valid measured search');
  // Avoid an otherwise-unused local while documenting the positive engine.
  check(reference !== candidate,
    'scripted candidate/reference identities remain distinct');
}

console.log('maintainer-labeled Actions trigger');
const workflow = fs.readFileSync(WORKFLOW, 'utf8');
check(workflow.includes('pull_request_target:') &&
    workflow.includes('types: [labeled]') &&
    workflow.includes(
      "if: github.event.label.name == 'run-wasm-efficiency-v2'") &&
    workflow.includes(
      "if: always() && github.event.label.name == 'run-wasm-efficiency-v2'") &&
    workflow.includes(
      "'Complete 800-game efficiency verdict' || 'WASM gate not requested'") &&
    workflow.includes(
      'group: wasm-efficiency-pr-${{ github.event.pull_request.number }}-${{ github.event.label.name }}') &&
    workflow.includes(
      'This exact candidate SHA already has a formal v2 workflow run') &&
    workflow.includes('actions: read') &&
    !workflow.includes('.github/wasm-efficiency-run') &&
    !workflow.includes('\n  pull_request:') &&
    !workflow.includes('\n  push:') &&
    !workflow.includes('workflow_dispatch:'),
  'only one trusted-base maintainer-labeled run per exact candidate launches');
check(workflow.includes(
      'ref: ${{ github.event.pull_request.base.sha }}') &&
    workflow.includes('path: trusted') &&
    workflow.includes(
      'ref: ${{ github.event.pull_request.head.sha }}') &&
    workflow.includes(
      'repository: ${{ github.event.pull_request.head.repo.full_name }}') &&
    (workflow.match(/persist-credentials: false/g) || []).length >= 4,
  'build separates the trusted base harness from the exact uncredentialed candidate');
check(workflow.includes(
      'ENGINE_BASE_SHA: 808a2ef3e140718facd384acfebdd8781f1db162') &&
    workflow.includes(
      'REFERENCE_WASM_SHA256: dab3d6025d507b2c93218616f3871cb7c13d7542e848ea741a750485b5cef6db') &&
    workflow.includes(
      'PROTOCOL_ID: chessy-wasm-fixed-node-efficiency-10000x4x100x180-v2') &&
    workflow.includes(
      'The trusted efficiency gate only accepts same-repository pull requests targeting main') &&
    workflow.includes('EXPECTED_WORKFLOW_SHA: ${{ github.workflow_sha }}') &&
    workflow.includes(
      'Executing workflow revision does not match the trusted harness') &&
    workflow.includes(
      'Formal candidate changes untrusted build or harness path') &&
    workflow.includes('seedbase: [0, 1, 2, 3]') &&
    workflow.includes('openbase: [0, 20, 40, 60, 80]') &&
    (workflow.match(
      /ref: \$\{\{ needs\.bind\.outputs\.harness_sha \}\}/g) || [])
      .length === 4 &&
    workflow.includes(
      'name: wasm-efficiency-reference-${{ github.run_id }}-${{ github.run_attempt }}') &&
    workflow.includes(
      'name: wasm-efficiency-candidate-${{ github.run_id }}-${{ github.run_attempt }}') &&
    workflow.includes(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') &&
    workflow.includes(
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020') &&
    workflow.includes(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02') &&
    workflow.includes(
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093') &&
    !/uses: actions\/[^@\n]+@v[0-9]/.test(workflow) &&
    workflow.includes(
      'cp "$TRUSTED_DIR/experiments/wasm/build.sh"') &&
    workflow.includes(
      'node "$GITHUB_WORKSPACE/trusted/test/wasm-efficiency-match.js"') &&
    workflow.includes(
      'node "$GITHUB_WORKSPACE/trusted/test/ai-match-agg.js"') &&
    workflow.includes('--provenance "$PROVENANCE"') &&
    !workflow.includes('node test/ai-match-agg.js'),
  'trusted v2 jobs isolate candidate compilation and bind the frozen reference, shards, provenance and aggregation');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
