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
const accounting = require('./wasm-node-accounting-contract');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'wasm-efficiency-match.js');
const WORKFLOW = path.join(
  ROOT, '.github', 'workflows', 'wasm-efficiency.yml');
const DEEP_WORKFLOW = path.join(
  ROOT, '.github', 'workflows', 'wasm-deep-search.yml');
const CANDIDATE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HARNESS = 'c'.repeat(40);
const RUST_SRC = path.join(ROOT, 'experiments', 'wasm', 'src');
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

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first === -1 || first !== source.lastIndexOf(before)) {
    throw new Error('test mutation expected one occurrence of ' +
      JSON.stringify(before));
  }
  return source.slice(0, first) + after +
    source.slice(first + before.length);
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
console.log('trusted node-accounting source contract');
const trustedAccounting = accounting.readSources(RUST_SRC);
accounting.validateSources(trustedAccounting, trustedAccounting);
check(true, 'accepts the unchanged trusted accounting pipeline');
{
  const compatible = {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    ctx.researches = 0;\n',
      '    ctx.researches = 0;\n' +
      '    ctx.experiment_probe_nodes = 0;\n')
  };
  compatible.search = replaceOnce(
    compatible.search,
    '    context().rep_ply = REP_INFINITY;\n\n' +
      '    let turn = position.turn;\n' +
      '    let maximizing = turn == Color::White;',
    '    context().rep_ply = REP_INFINITY;\n' +
      '    let probe_start = context().nodes;\n' +
      '    let _probe_delta = context().nodes - probe_start;\n\n' +
      '    let turn = position.turn;\n' +
      '    let maximizing = turn == Color::White;');
  compatible.search +=
    '\nconst ACCOUNTING_NOTE: &str = r#"{ context().nodes = 0; }"#;\n' +
    '#[cfg(test)]\n' +
    'mod candidate_accounting_tests {\n' +
    '    #[test]\n' +
    '    fn reset_is_test_only() { unsafe { super::reset_context(true, 1, 0); } }\n' +
    '}\n';
  accounting.validateSources(trustedAccounting, compatible);
  check(true,
    'permits experiment metrics and recursive work that retain trusted entry accounting');
}
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    context().nodes = next_node;',
      '    context().nodes = next_node / 10;')
  });
}, /changed trusted WASM node accounting: check_budget function/,
'rejects a candidate that undercounts the trusted node increment');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    if !check_budget() {\n' +
        '        return ABORT_SCORE;\n' +
        '    }\n' +
        '    context().rep_ply = REP_INFINITY;',
      '    context().rep_ply = REP_INFINITY;')
  });
}, /changed trusted WASM node accounting: search_node accounting prologue/,
'rejects removal of the recursive node-entry charge');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    ctx.nodes = 0;',
      '    ctx.nodes = 500;')
  });
}, /changed trusted WASM node accounting: reset_context accounting prefix/,
'rejects a candidate-controlled counter reset');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: replaceOnce(
      trustedAccounting.lib,
      '        nodes: search_result.nodes,',
      '        nodes: search_result.nodes / 10,'),
    search: trustedAccounting.search
  });
}, /changed trusted WASM node accounting: search function/,
'rejects clamping the ABI-reported node count');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: replaceOnce(
      trustedAccounting.lib,
      'search::run(&mut position, max_depth, node_limit, time_ms, quiesce != 0)',
      'search::run(&mut position, max_depth, 0, time_ms, quiesce != 0)'),
    search: trustedAccounting.search
  });
}, /changed trusted WASM node accounting: search function/,
'rejects bypassing the requested node limit at the ABI boundary');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    context().rep_ply = REP_INFINITY;\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;',
      '    context().rep_ply = REP_INFINITY;\n' +
        '    context().nodes = 0;\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;')
  });
}, /changed trusted WASM node accounting: node counter declarations, writes, and result fields/,
'rejects an added write through the candidate accounting context');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    context().rep_ply = REP_INFINITY;\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;',
      '    context().rep_ply = REP_INFINITY;\n' +
        '    core::ptr::write(core::ptr::addr_of_mut!(context().nodes), 0);\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;')
  });
}, /changed trusted WASM node accounting: raw accounting escape surface/,
'rejects a new raw-pointer counter mutation escape');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: trustedAccounting.search +
      '\nmacro_rules! rewrite_counter { ($field:ident) => {} }\n' +
      'rewrite_counter!(nodes);\n'
  });
}, /changed trusted WASM node accounting: raw accounting escape surface/,
'rejects macro-generated or unclassified counter access');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: replaceOnce(
      trustedAccounting.search,
      '    context().rep_ply = REP_INFINITY;\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;',
      '    context().rep_ply = REP_INFINITY;\n' +
        '    reset_context(true, 0, 0);\n\n' +
        '    let turn = position.turn;\n' +
        '    let maximizing = turn == Color::White;')
  });
}, /changed trusted WASM node accounting: reset_context production call count/,
'rejects a mid-search whole-context reset');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: trustedAccounting.search +
      '\nunsafe fn check_budget() -> bool { true }\n'
  });
}, /expected exactly one Rust function check_budget, found 2/,
'rejects a duplicate accounting primitive');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: replaceOnce(
      trustedAccounting.lib,
      '#[no_mangle]\n' +
        'pub unsafe extern "C" fn search(',
      'pub unsafe extern "C" fn search(') +
      '\n#[export_name = "search"]\n' +
      'pub unsafe extern "C" fn forged_search() -> i32 { 0 }\n',
    search: trustedAccounting.search
  });
}, /changed trusted WASM node accounting: search function/,
'rejects replacing the trusted exported ABI entry point');
throws(function () {
  accounting.validateSources(trustedAccounting, {
    lib: trustedAccounting.lib,
    search: trustedAccounting.search + '\nmod unmetered_search;\n'
  });
}, /changed trusted WASM node accounting: production module declarations/,
'rejects a new production source module outside the reviewed accounting tree');

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
      'node "$HARNESS_DIR/test/wasm-node-accounting-contract.js"') &&
    workflow.includes(
      '"$HARNESS_DIR/experiments/wasm/src"') &&
    workflow.includes(
      '"$CANDIDATE_DIR/experiments/wasm/src"') &&
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
      'cp "$GITHUB_WORKSPACE/trusted/experiments/wasm/build.sh" \\\n' +
      '            "$BASE_DIR/experiments/wasm/build.sh"') &&
    workflow.includes(
      'cp "$TRUSTED_DIR/experiments/wasm/build.sh"') &&
    workflow.includes(
      'node "$GITHUB_WORKSPACE/trusted/test/wasm-efficiency-match.js"') &&
    workflow.includes(
      'node "$GITHUB_WORKSPACE/trusted/test/ai-match-agg.js"') &&
    workflow.includes('--provenance "$PROVENANCE"') &&
    !workflow.includes('node test/ai-match-agg.js'),
  'trusted v2 jobs isolate candidate compilation and bind the frozen reference, shards, provenance and aggregation');

const deepWorkflow = fs.readFileSync(DEEP_WORKFLOW, 'utf8');
check(deepWorkflow.includes(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') &&
    deepWorkflow.includes(
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020') &&
    deepWorkflow.includes(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02') &&
    deepWorkflow.includes(
      'TRUSTED_DEEP_HARNESS_SHA: cafc585555c6dd9216ea07bdd3b4ea3e8d78d877') &&
    deepWorkflow.includes(
      'TRUSTED_BUILD_DRIVER_SHA256: 68852d6684eb69c2dc6fd59947f6e88450aa298fb13be96d48f09e6c79612489') &&
    deepWorkflow.includes(
      'Candidate is not descended from the trusted deep harness') &&
    deepWorkflow.includes(
      'echo "$TRUSTED_BUILD_DRIVER_SHA256  $TRUSTED_DRIVER" |') &&
    deepWorkflow.includes(
      'cp "$TRUSTED_DRIVER" "$BASE_DIR/experiments/wasm/build.sh"') &&
    deepWorkflow.includes(
      'cp "$TRUSTED_DRIVER" \\\n' +
      '            experiments/wasm/build.sh') &&
    deepWorkflow.includes(
      'node "$TRUSTED_DIR/experiments/wasm/deep-bench.test.js"') &&
    deepWorkflow.includes(
      'node "$TRUSTED_DIR/experiments/wasm/deep-bench.js"') &&
    deepWorkflow.includes(
      'node "$TRUSTED_DIR/test/wasm-node-accounting-contract.js"') &&
    deepWorkflow.includes(
      '"$BASE_DIR/experiments/wasm/src"') &&
    deepWorkflow.includes(
      '"$GITHUB_WORKSPACE/experiments/wasm/src"') &&
    !deepWorkflow.includes(
      'node experiments/wasm/deep-bench.test.js') &&
    !deepWorkflow.includes(
      'node experiments/wasm/deep-bench.js') &&
    !deepWorkflow.includes(
      'cp experiments/wasm/build.sh \\\n' +
      '            "$BASE_DIR/experiments/wasm/build.sh"') &&
    !deepWorkflow.includes(
      'cp "$BASE_DIR/experiments/wasm/build.sh" \\\n' +
      '            experiments/wasm/build.sh') &&
    !/uses: actions\/[^@\n]+@v[0-9]/.test(deepWorkflow),
  'deep-search evidence uses pinned trusted code and immutable action revisions');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
