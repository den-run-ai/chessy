/*
 * Canonical shard-schema and aggregation tests.
 * Run with: node test/ai-match-agg.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const MatchProtocol = require('./ai-match-protocol');

const AGG = path.join(__dirname, 'ai-match-agg.js');
const OPENINGS = 100;
const WORKFLOW = 'https://github.com/den-run-ai/chessy/actions/runs/123';
const CANDIDATE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HARNESS = 'e'.repeat(40);
const CANDIDATE_WASM = 'c'.repeat(64);
const BASE_WASM = 'd'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aggtest-'));
let passed = 0, failed = 0;

function check(ok, label, detail) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}
function records(seed, openings) {
  const out = [];
  for (let op = 0; op < (openings || OPENINGS); op++) {
    const white = 1, black = op % 2 ? 0.5 : 0;
    out.push({
      op, name: 'op' + op, seed,
      gseed: MatchProtocol.deriveGameSeed(op, seed),
      white, black, pair: (white + black) / 2
    });
  }
  return out;
}
function shardFile(name, seed, over) {
  over = over || {};
  const mode = over.mode || 'nodes';
  const protocol = over.protocol || (mode === 'time'
    ? MatchProtocol.PROTOCOLS.timeDiagnostic.id
    : over.wasm
      ? MatchProtocol.PROTOCOLS.wasmEfficiencyFixedNode.id
    : over.formal
      ? MatchProtocol.PROTOCOLS.formalFixedNode.id
      : mode === 'nodes'
        ? MatchProtocol.PROTOCOLS.nodeDiagnostic.id
        : 'unknown-protocol');
  const protocolConfig = MatchProtocol.PROTOCOL_BY_ID[protocol] ||
    MatchProtocol.PROTOCOLS.nodeDiagnostic;
  let recs = over.records || records(seed);
  if (over.dropOp != null) {
    recs = recs.slice();
    recs.splice(over.dropOp, 1);
  }
  const fields = [
    ['protocol-id', protocol],
    ['acceptance-class',
      over.acceptanceClass || protocolConfig.acceptanceClass],
    ['lower-bound-threshold',
      over.lowerBoundThreshold || String(protocolConfig.lowerBoundThreshold)],
    ['candidate-sha', over.candidate || CANDIDATE],
    ['base-sha', over.base || BASE],
    ['budget-mode', mode],
    ['budget-value', over.budget || (mode === 'time' ? '5000' : '10000')],
    ['max-plies', over.maxPlies || '180'],
    ['openings-manifest-version',
      over.manifestVersion || MatchProtocol.OPENINGS_MANIFEST_VERSION],
    ['openings-manifest-sha256',
      over.manifestSha || MatchProtocol.OPENINGS_MANIFEST_SHA256],
    ['node-runtime', over.runtime || 'v22.0.0']
  ];
  if (protocolConfig.engineKind === 'wasm') {
    fields.push(['harness-sha', over.harness || HARNESS]);
    fields.push([
      'candidate-wasm-sha256', over.candidateWasm || CANDIDATE_WASM
    ]);
    fields.push(['base-wasm-sha256', over.baseWasm || BASE_WASM]);
  }
  if (!over.local) fields.push(['workflow-run', over.workflow || WORKFLOW]);
  fields.push(['records', JSON.stringify(recs)]);
  fields.push(['openings-total', over.total || String(OPENINGS)]);
  let lines = fields.filter(function (entry) {
    return entry[0] !== over.omit;
  }).map(function (entry) {
    return entry[0] + ': ' + entry[1];
  });
  if (over.duplicate) {
    const hit = fields.find(function (entry) {
      return entry[0] === over.duplicate;
    });
    lines.push(over.duplicate + ': ' + (hit ? hit[1] : 'duplicate'));
  }
  if (over.extra) lines.push(over.extra);
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
function provenanceFile(name, over) {
  over = over || {};
  const fields = [
    ['protocol-id', over.protocol ||
      MatchProtocol.PROTOCOLS.wasmEfficiencyFixedNode.id],
    ['harness-sha', over.harness || HARNESS],
    ['candidate-sha', over.candidate || CANDIDATE],
    ['base-sha', over.base || BASE],
    ['candidate-wasm-sha256',
      over.candidateWasm || CANDIDATE_WASM],
    ['base-wasm-sha256', over.baseWasm || BASE_WASM],
    ['workflow-run', over.workflow || WORKFLOW]
  ];
  const p = path.join(dir, name);
  const lines = fields.filter(function (entry) {
    return entry[0] !== over.omit;
  }).map(function (entry) {
    return entry[0] + '=' + entry[1];
  });
  if (over.duplicate) {
    const hit = fields.find(function (entry) {
      return entry[0] === over.duplicate;
    });
    lines.push(over.duplicate + '=' + (hit ? hit[1] : 'duplicate'));
  }
  if (over.extra) lines.push(over.extra);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
function run(fileArgs, extra) {
  const r = cp.spawnSync(process.execPath,
    [AGG].concat(extra || [], fileArgs), { encoding: 'utf8' });
  return { status: r.status, output: (r.stdout || '') + (r.stderr || '') };
}
function expect(files, status, label, extra) {
  const r = run(files, extra);
  check(r.status === status, label,
    'exit ' + r.status + ': ' + r.output.trim());
}
function expectMessage(files, status, message, label, extra) {
  const r = run(files, extra);
  check(r.status === status && r.output.includes(message), label,
    'exit ' + r.status + ': ' + r.output.trim());
}

const full = [
  shardFile('s0.txt', 0, { formal: true }),
  shardFile('s1.txt', 1, { formal: true }),
  shardFile('s2.txt', 2, { formal: true }),
  shardFile('s3.txt', 3, { formal: true })
];
const diagnosticFull = [
  shardFile('diag0.txt', 0), shardFile('diag1.txt', 1),
  shardFile('diag2.txt', 2), shardFile('diag3.txt', 3)
];
const wasmFull = [
  shardFile('wasm-s0.txt', 0, { wasm: true }),
  shardFile('wasm-s1.txt', 1, { wasm: true }),
  shardFile('wasm-s2.txt', 2, { wasm: true }),
  shardFile('wasm-s3.txt', 3, { wasm: true })
];
const wasmProvenance = provenanceFile('wasm-PROVENANCE');

console.log('accepts canonical complete manifests');
expect(full, 0, 'canonical 100x4 workflow manifest passes');
expect(wasmFull, 0,
  'canonical 100x4 WASM efficiency manifest passes at >49%',
  ['--provenance', wasmProvenance]);
expectMessage(wasmFull, 2, 'requires --provenance',
  'formal WASM evidence cannot pass without trusted provenance');
expectMessage(wasmFull, 3, 'trusted provenance candidate-sha',
  'trusted provenance rejects a different candidate SHA',
  ['--provenance', provenanceFile('wrong-candidate-PROVENANCE', {
    candidate: 'f'.repeat(40)
  })]);
expectMessage(wasmFull, 3, 'trusted provenance candidate-wasm-sha256',
  'trusted provenance rejects a different candidate module',
  ['--provenance', provenanceFile('wrong-module-PROVENANCE', {
    candidateWasm: 'f'.repeat(64)
  })]);
expectMessage(wasmFull, 3, 'trusted provenance harness-sha',
  'trusted provenance rejects a different harness SHA',
  ['--provenance', provenanceFile('wrong-harness-PROVENANCE', {
    harness: 'f'.repeat(40)
  })]);
expectMessage(wasmFull, 3, 'trusted provenance base-sha',
  'trusted provenance rejects a different frozen base SHA',
  ['--provenance', provenanceFile('wrong-base-PROVENANCE', {
    base: 'f'.repeat(40)
  })]);
expectMessage(wasmFull, 3, 'trusted provenance base-wasm-sha256',
  'trusted provenance rejects a different reference module',
  ['--provenance', provenanceFile('wrong-reference-PROVENANCE', {
    baseWasm: 'f'.repeat(64)
  })]);
expectMessage(wasmFull, 3, 'trusted provenance workflow-run',
  'trusted provenance rejects a different workflow run',
  ['--provenance', provenanceFile('wrong-workflow-PROVENANCE', {
    workflow: 'https://github.com/den-run-ai/chessy/actions/runs/456'
  })]);
expectMessage(wasmFull, 2, 'missing trusted provenance field base-sha',
  'trusted provenance rejects a missing field',
  ['--provenance', provenanceFile('missing-field-PROVENANCE', {
    omit: 'base-sha'
  })]);
expectMessage(wasmFull, 2, 'duplicate trusted provenance field candidate-sha',
  'trusted provenance rejects a duplicate field',
  ['--provenance', provenanceFile('duplicate-field-PROVENANCE', {
    duplicate: 'candidate-sha'
  })]);
expectMessage(wasmFull, 2, 'malformed or unknown trusted provenance line',
  'trusted provenance rejects an unknown field',
  ['--provenance', provenanceFile('unknown-field-PROVENANCE', {
    extra: 'surprise=value'
  })]);
expect([
  shardFile('local0.txt', 0, { formal: true, local: true }),
  shardFile('local1.txt', 1, { formal: true, local: true }),
  shardFile('local2.txt', 2, { formal: true, local: true }),
  shardFile('local3.txt', 3, { formal: true, local: true })
], 0, 'workflow-run may be absent from every local shard');
expect([shardFile('timed.txt', 0, { mode: 'time', local: true })], 0,
  'canonical 100x1 equal-time diagnostic aggregates', ['--seeds', '1']);

console.log('binds the formal fixed-node contract');
expectMessage([
  shardFile('formal-budget-1.txt', 0, { formal: true, budget: '1' })
], 2, 'formal protocol requires exactly',
'a one-node artifact cannot claim or pass the formal protocol');
expectMessage([full[0]], 2, '4 seeds',
  '--seeds 1 cannot aggregate as the formal protocol', ['--seeds', '1']);
expectMessage([
  shardFile('formal-plies-1.txt', 0, { formal: true, maxPlies: '1' })
], 2, 'formal protocol requires exactly',
'a one-ply artifact cannot claim or pass the formal protocol');
expectMessage([
  shardFile('formal-self.txt', 0, { formal: true, base: CANDIDATE })
], 2, 'distinct candidate and base SHAs',
'self-vs-self cannot claim or pass the formal protocol');
const diagnosticBudgetOne = run([
  shardFile('diagnostic-budget-1.txt', 0, {
    budget: '1', local: true
  })
], ['--seeds', '1']);
check(diagnosticBudgetOne.status === 0 &&
    diagnosticBudgetOne.output.includes(
      'chessy-fixed-node-diagnostic-v1 (non-formal fixed-node diagnostic)'),
  'custom node budgets remain explicitly non-formal',
  'exit ' + diagnosticBudgetOne.status + ': ' +
    diagnosticBudgetOne.output.trim());
function identityRecords(seed) {
  return records(seed).map(function (r) {
    return Object.assign({}, r, { white: 0.5, black: 0.5, pair: 0.5 });
  });
}
const strictIdentity = run([
  shardFile('strict-identity-0.txt', 0, {
    formal: true, records: identityRecords(0)
  }),
  shardFile('strict-identity-1.txt', 1, {
    formal: true, records: identityRecords(1)
  }),
  shardFile('strict-identity-2.txt', 2, {
    formal: true, records: identityRecords(2)
  }),
  shardFile('strict-identity-3.txt', 3, {
    formal: true, records: identityRecords(3)
  })
]);
check(strictIdentity.status === 1 &&
    strictIdentity.output.includes('acceptance: strict-strength') &&
    strictIdentity.output.includes('lower bound at or below 50%'),
  'formal pure-strength protocol rejects an identity result at exactly 50%',
  'exit ' + strictIdentity.status + ': ' + strictIdentity.output.trim());
const wasmIdentity = run([
  shardFile('wasm-identity-0.txt', 0, {
    wasm: true, records: identityRecords(0)
  }),
  shardFile('wasm-identity-1.txt', 1, {
    wasm: true, records: identityRecords(1)
  }),
  shardFile('wasm-identity-2.txt', 2, {
    wasm: true, records: identityRecords(2)
  }),
  shardFile('wasm-identity-3.txt', 3, {
    wasm: true, records: identityRecords(3)
  })
], ['--provenance', wasmProvenance]);
check(wasmIdentity.status === 0 &&
    wasmIdentity.output.includes(
      'formal efficiency non-inferiority fixed-node gate') &&
    wasmIdentity.output.includes(
      'PASS — efficiency non-inferiority gate met'),
  'formal efficiency protocol accepts identity at 50% without claiming strength',
  'exit ' + wasmIdentity.status + ': ' + wasmIdentity.output.trim());
const diagnosticIdentity = run([
  shardFile('diagnostic-identity.txt', 0, {
    local: true, records: identityRecords(0)
  })
], ['--seeds', '1']);
check(diagnosticIdentity.status === 0 &&
    diagnosticIdentity.output.includes('acceptance: diagnostic-noninferiority'),
  'non-formal diagnostics retain the >49% non-inferiority classification',
  'exit ' + diagnosticIdentity.status + ': ' +
    diagnosticIdentity.output.trim());

console.log('rejects incomplete or overlapping manifests');
expect(full.slice(0, 3), 5, 'missing seed shard -> exit 5');
expect([
  shardFile('drop.txt', 0, { formal: true, dropOp: 10 }),
  full[1], full[2], full[3]
], 5, 'missing opening/seed cell -> exit 5');
expect(full.concat(full[0]), 4, 'duplicated shard -> exit 4');

console.log('rejects cross-shard metadata disagreement');
expect([full[0], full[1], full[2],
  shardFile('base-mismatch.txt', 3, {
    formal: true, base: 'c'.repeat(40)
  })],
3, 'different base SHA -> exit 3');
expect([diagnosticFull[0], diagnosticFull[1], diagnosticFull[2],
  shardFile('budget-mismatch.txt', 3, { budget: '12000' })],
3, 'different budget value -> exit 3');
expect([full[0], full[1], full[2],
  shardFile('mode-mismatch.txt', 3, { mode: 'time' })],
3, 'different protocol/budget mode -> exit 3');
expect([diagnosticFull[0], diagnosticFull[1], diagnosticFull[2],
  shardFile('plies-mismatch.txt', 3, { maxPlies: '160' })],
3, 'different max plies -> exit 3');
expect([full[0], full[1], full[2],
  shardFile('runtime-mismatch.txt', 3, {
    formal: true, runtime: 'v23.0.0'
  })],
3, 'different Node runtime -> exit 3');
expect([full[0], full[1], full[2],
  shardFile('local-partial.txt', 3, { formal: true, local: true })],
3, 'workflow-run must be all-or-none -> exit 3');
expect([full[0], full[1], full[2],
  shardFile('workflow-mismatch.txt', 3, {
    formal: true,
    workflow: 'https://github.com/den-run-ai/chessy/actions/runs/456'
  })],
3, 'different workflow run -> exit 3');
expect([wasmFull[0], wasmFull[1], wasmFull[2],
  shardFile('wasm-digest-mismatch.txt', 3, {
    wasm: true, candidateWasm: 'e'.repeat(64)
  })],
3, 'different candidate WASM digest -> exit 3');

console.log('rejects malformed or non-canonical metadata');
expect([shardFile('bad-sha.txt', 0, { candidate: 'ABC' })], 2,
  'non-canonical SHA -> exit 2', ['--seeds', '1']);
expect([shardFile('unknown-mode.txt', 0, { mode: 'seconds' })], 2,
  'unknown budget mode -> exit 2', ['--seeds', '1']);
expect([shardFile('wrong-protocol.txt', 0, {
  protocol: MatchProtocol.PROTOCOLS.timeDiagnostic.id
})], 2, 'protocol/mode mismatch -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-manifest.txt', 0, { manifestVersion: 'future-v9' })], 2,
  'unknown opening manifest -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-runtime.txt', 0, { runtime: 'node-22' })], 2,
  'non-canonical Node runtime -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-acceptance.txt', 0, {
  acceptanceClass: 'strict-strength'
})], 2, 'acceptance class must match protocol -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-threshold.txt', 0, {
  lowerBoundThreshold: '0.48'
})], 2, 'acceptance threshold must match protocol -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-plies.txt', 0, { maxPlies: '1.5' })], 2,
  'non-integer max plies -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-budget.txt', 0, { budget: '1.5' })], 2,
  'non-integer budget -> exit 2', ['--seeds', '1']);
expect([shardFile('bad-workflow.txt', 0, { workflow: 'rerun-123' })], 2,
  'non-canonical workflow run -> exit 2', ['--seeds', '1']);
expect([shardFile('missing-sha.txt', 0, { omit: 'candidate-sha' })], 2,
  'missing required field -> exit 2', ['--seeds', '1']);
expect([shardFile('missing-acceptance.txt', 0, {
  omit: 'acceptance-class'
})], 2, 'missing acceptance class -> exit 2', ['--seeds', '1']);
expect([shardFile('duplicate-sha.txt', 0, { duplicate: 'candidate-sha' })], 2,
  'duplicate required field -> exit 2', ['--seeds', '1']);
expect([shardFile('duplicate-records.txt', 0, { duplicate: 'records' })], 2,
  'duplicate records field -> exit 2', ['--seeds', '1']);
expect([shardFile('duplicate-workflow.txt', 0, {
  duplicate: 'workflow-run'
})], 2, 'duplicate optional workflow field -> exit 2', ['--seeds', '1']);
expect([shardFile('unknown-field.txt', 0, { extra: 'mystery-field: x' })], 2,
  'unknown metadata field -> exit 2', ['--seeds', '1']);
expect([shardFile('wrong-total.txt', 0, { total: '99' })], 2,
  'opening total disagrees with canonical manifest -> exit 2',
  ['--seeds', '1']);
expect([shardFile('wasm-missing-digest.txt', 0, {
  wasm: true, omit: 'candidate-wasm-sha256'
})], 2, 'WASM protocol requires exact module digests', ['--seeds', '1']);
expect([shardFile('wasm-bad-digest.txt', 0, {
  wasm: true, candidateWasm: 'ABC'
})], 2, 'WASM digest must be canonical SHA-256', ['--seeds', '1']);
expect([shardFile('js-with-wasm-digest.txt', 0, {
  extra: 'candidate-wasm-sha256: ' + CANDIDATE_WASM
})], 2, 'non-WASM protocol rejects WASM-only provenance', ['--seeds', '1']);

console.log('rejects malformed records');
function mutatedRecords(over) {
  const recs = over.losses ? records(0).map(function (r) {
    return Object.assign({}, r, { white: 0, black: 0, pair: 0 });
  }) : records(0);
  if (Object.prototype.hasOwnProperty.call(over, 'record')) {
    recs[0] = over.record;
  }
  return shardFile(over.name, 0, {
    local: true, records: recs
  });
}
expectMessage([mutatedRecords({
  name: 'null-record.txt',
  record: null
})], 2, 'record 0 is not a non-null object',
'null record is rejected cleanly -> exit 2', ['--seeds', '1']);
expect([mutatedRecords({
  name: 'bad-op.txt',
  record: {
    op: 100, seed: 0, gseed: MatchProtocol.deriveGameSeed(100, 0),
    white: 1, black: 0, pair: 0.5
  }
})], 2, 'out-of-range opening -> exit 2', ['--seeds', '1']);
expect([mutatedRecords({
  name: 'bad-pair.txt',
  record: {
    op: 0, seed: 0, gseed: MatchProtocol.deriveGameSeed(0, 0),
    white: 1, black: 1, pair: 2
  }
})], 2, 'out-of-range pair -> exit 2', ['--seeds', '1']);
expect([mutatedRecords({
  name: 'inconsistent.txt',
  record: {
    op: 0, seed: 0, gseed: MatchProtocol.deriveGameSeed(0, 0),
    white: 0, black: 0, pair: 1
  }
})], 2, 'inconsistent game/pair scores -> exit 2',
['--seeds', '1']);
expect([mutatedRecords({
  name: 'bad-game.txt',
  record: {
    op: 0, seed: 0, gseed: MatchProtocol.deriveGameSeed(0, 0),
    white: 0.3, black: 0.7, pair: 0.5
  }
})], 2, 'non-discrete game score -> exit 2',
['--seeds', '1']);
const staleSeed = records(0)[0];
expectMessage([mutatedRecords({
  name: 'stale-gseed.txt',
  record: Object.assign({}, staleSeed, { gseed: staleSeed.gseed + 1 })
})], 2, 'does not match canonical opening/seed mapping',
'stale derived game seed -> exit 2', ['--seeds', '1']);
expect([mutatedRecords({
  name: 'valid-fail.txt', losses: true
})], 1, 'valid losing 100x1 manifest fails NI', ['--seeds', '1']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
