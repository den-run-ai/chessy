/*
 * CLI/budget smoke tests for test/ai-match.js. Invalid budgets are exercised
 * with --check-openings so failures happen before either engine is loaded; the
 * final one-ply pairs traverse the real equal-time path against both current
 * and exact legacy main.
 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const MATCH = path.join(__dirname, 'ai-match.js');
const MATCH_SOURCE = fs.readFileSync(MATCH, 'utf8');
const FORMAL_WORKFLOW =
  path.join(__dirname, '..', '.github', 'workflows', 'ai-match.yml');
const TIME_WORKFLOW =
  path.join(__dirname, '..', '.github', 'workflows',
    'ai-match-time-diagnostic.yml');
const LEGACY_MAIN = '1e7cbaec589d3a83ab748046f9580d306d940db0';
let passed = 0, failed = 0;

function run(args) {
  const r = cp.spawnSync(process.execPath, [MATCH].concat(args), {
    encoding: 'utf8', cwd: path.join(__dirname, '..')
  });
  return {
    status: r.status,
    output: (r.stdout || '') + (r.stderr || '')
  };
}
function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

console.log('match budget CLI validation');
for (const c of [
  [['--check-openings'], 0, 'default fixed-node budget remains valid'],
  [['--check-openings', '--formal'], 0,
    'the exact formal fixed-node configuration is accepted'],
  [['--check-openings', '--nodes', '1234'], 0, 'explicit fixed-node budget is valid'],
  [['--check-openings', '--time', '5000'], 0, 'equal-time budget is valid'],
  [['--check-openings', '--nodes', '100', '--time', '5'], 2,
    'node and time budgets are mutually exclusive'],
  [['--check-openings', '--time', '0'], 2, 'zero time is rejected'],
  [['--check-openings', '--time', '1.5'], 2, 'fractional time is rejected'],
  [['--check-openings', '--time', 'nope'], 2, 'non-numeric time is rejected'],
  [['--check-openings', '--time'], 2, 'missing time value is rejected'],
  [['--check-openings', '--time', '9007199254740992'], 2,
    'unsafe-integer time is rejected'],
  [['--check-openings', '--time', '5', '--time', '6'], 2,
    'duplicate time flags are rejected'],
  [['--check-openings', '--nodes', '5', '--nodes', '6'], 2,
    'duplicate node flags are rejected'],
  [['--check-openings', '--formal', '--nodes', '1'], 2,
    'formal mode rejects a custom node budget'],
  [['--check-openings', '--formal', '--plies', '1'], 2,
    'formal mode rejects a custom ply cap'],
  [['--check-openings', '--formal', '--time', '5000'], 2,
    'formal mode rejects an equal-time budget'],
  [['--check-openings', '--formal', '--formal'], 2,
    'duplicate formal flags are rejected']
]) {
  const r = run(c[0]);
  check(r.status === c[1], c[2], 'exit ' + r.status + ': ' + r.output.trim());
}

console.log('fixed-node protocol identity');
const nodeDiagnostic = run([
  '--base', 'HEAD', '--nodes', '1', '--seeds', '1', '--pairs', '1',
  '--plies', '1', '--openbase', '0', '--opencount', '1'
]);
check(nodeDiagnostic.status === 0 &&
    nodeDiagnostic.output.includes(
      'protocol-id: chessy-fixed-node-diagnostic-v1') &&
    nodeDiagnostic.output.includes(
      'acceptance-class: diagnostic-noninferiority') &&
    nodeDiagnostic.output.includes('lower-bound-threshold: 0.49') &&
    nodeDiagnostic.output.includes('budget-value: 1'),
  'a custom fixed-node run emits the non-formal diagnostic protocol',
  'exit ' + nodeDiagnostic.status + ': ' + nodeDiagnostic.output.trim());

const formalSelf = run([
  '--formal', '--base', 'HEAD', '--seeds', '1', '--pairs', '1',
  '--openbase', '0', '--opencount', '1'
]);
check(formalSelf.status === 2 &&
    formalSelf.output.includes(
      'formal fixed-node gate requires distinct candidate and base commits') &&
    !formalSelf.output.includes('protocol-id:'),
  'formal self-vs-self fails before producing an artifact',
  'exit ' + formalSelf.status + ': ' + formalSelf.output.trim());
check(MATCH_SOURCE.includes(
      'FORMAL SHARD: no verdict — strict-strength verdict is reserved ') &&
    !MATCH_SOURCE.includes("'PASS — strict strength gate met'") &&
    !MATCH_SOURCE.includes(
      "'FAIL — strict strength gate not met (lower bound at or below 50%)'"),
  'formal shard output reserves the strict-strength verdict for aggregation');

console.log('equal-time match smoke');
const smoke = run([
  '--base', 'HEAD', '--time', '5', '--seeds', '1', '--pairs', '1',
  '--plies', '1', '--openbase', '0', '--opencount', '1'
]);
check(smoke.status === 0 &&
    smoke.output.includes('protocol-id: chessy-equal-time-diagnostic-v1') &&
    smoke.output.includes(
      'acceptance-class: diagnostic-noninferiority') &&
    smoke.output.includes('lower-bound-threshold: 0.49') &&
    smoke.output.includes('budget-mode: time') &&
    smoke.output.includes('budget-value: 5') &&
    smoke.output.includes('max-plies: 1') &&
    smoke.output.includes('openings-manifest-version: chessy-openings-v1') &&
    /^openings-manifest-sha256: [0-9a-f]{64}$/m.test(smoke.output) &&
    /^node-runtime: v[0-9]+\.[0-9]+\.[0-9]+$/m.test(smoke.output) &&
    !smoke.output.includes('nodes-per-move:') &&
    !smoke.output.includes('time-ms-per-move:') &&
    !smoke.output.includes('workflow-run:') &&
    smoke.output.includes('candidate vs HEAD: 2 games, 5 ms/move'),
  'one-ply pair uses the equal-time budget and canonical local metadata',
  'exit ' + smoke.status + ': ' + smoke.output.trim());

const legacy = run([
  '--base', LEGACY_MAIN, '--time', '5', '--seeds', '1', '--pairs', '1',
  '--plies', '1', '--openbase', '0', '--opencount', '1'
]);
check(legacy.status === 0 &&
    legacy.output.includes('base-sha: ' + LEGACY_MAIN) &&
    legacy.output.includes('candidate vs ' + LEGACY_MAIN +
      ': 2 games, 5 ms/move'),
  'deterministic deadline probe accepts exact legacy main without stopReason',
  'exit ' + legacy.status + ': ' + legacy.output.trim());

console.log('workflow protocol separation');
const formalWorkflow = fs.readFileSync(FORMAL_WORKFLOW, 'utf8');
const timeWorkflow = fs.readFileSync(TIME_WORKFLOW, 'utf8');
check(formalWorkflow.startsWith(
      'name: AI fixed-node strict-strength gate\n') &&
    formalWorkflow.includes(
      'test/ai-match.js --formal --base "$BASE" --nodes 10000') &&
    formalWorkflow.includes('--plies 180 --seeds 1') &&
    !formalWorkflow.includes('inputs.nodes') &&
    !formalWorkflow.includes('time_ms'),
  'formal workflow hardcodes the complete strict-strength fixed-node contract');
check(timeWorkflow.startsWith('name: AI equal-time diagnostic (DRAFT)\n') &&
    !timeWorkflow.includes('--formal') &&
    timeWorkflow.includes(
      'node test/ai-match-agg.js --seeds 1 "${files[@]}"') &&
    timeWorkflow.includes('if [ "$status" -eq 1 ]') &&
    timeWorkflow.includes('elif [ "$status" -ne 0 ]'),
  'equal-time has a distinct informational check context while schema errors fail');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
